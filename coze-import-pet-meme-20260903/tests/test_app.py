import json
import sqlite3
from io import BytesIO

import pytest

from pet_meme.app import create_app
from pet_meme.generator import GeneratedImage, ImageGenerationError


class StubGenerator:
    def __init__(self, image_bytes=b"generated", mime_type="image/png", model_name="stub-model"):
        self.calls = []
        self.image_bytes = image_bytes
        self.mime_type = mime_type
        self.model_name = model_name

    def generate(self, template_path, pet_paths, adjustment, aspect_ratio="1:1", remove_watermark=False):
        self.calls.append(
            {
                "template_path": template_path,
                "pet_paths": list(pet_paths),
                "adjustment": adjustment,
                "aspect_ratio": aspect_ratio,
                "remove_watermark": remove_watermark,
            }
        )
        return GeneratedImage(image_bytes=self.image_bytes, mime_type=self.mime_type)


class FailingGenerator:
    model_name = "failing-model"

    def __init__(self, message):
        self.message = message

    def generate(self, template_path, pet_paths, adjustment, aspect_ratio="1:1", remove_watermark=False):
        raise ImageGenerationError(self.message)


class UnexpectedFailingGenerator:
    model_name = "unexpected-failing-model"

    def __init__(self, message):
        self.message = message

    def generate(self, template_path, pet_paths, adjustment, aspect_ratio="1:1", remove_watermark=False):
        raise RuntimeError(self.message)


def make_upload(name):
    return (BytesIO(b"\x89PNG\r\n\x1a\nsample"), name)


def make_generator_factory(generator, calls=None):
    def factory(api_key):
        if calls is not None:
            calls.append(api_key)
        return generator

    return factory


def make_byok_data(provider="gemini", api_key="test-key", **overrides):
    data = {
        "access_method": "own_api",
        "provider": provider,
        "api_key": api_key,
        "template": make_upload("template.png"),
        "pets": [make_upload("pet.png")],
    }
    data.update(overrides)
    return data


def read_events(database_path):
    with sqlite3.connect(database_path) as connection:
        return connection.execute(
            """
            SELECT access_method, provider, model, invite_code_id, status, has_adjustment, aspect_ratio
            FROM generation_events ORDER BY created_at
            """
        ).fetchall()


def assert_secret_not_persisted(state_dir, secret_key, caplog):
    jsonl_path = state_dir / "generations.jsonl"
    jsonl_text = jsonl_path.read_text(encoding="utf-8") if jsonl_path.exists() else ""
    with sqlite3.connect(state_dir / "pet-meme.sqlite3") as connection:
        sqlite_text = "\n".join(
            str(row)
            for row in connection.execute(
                "SELECT request_id, access_method, provider, model, invite_code_id, status FROM generation_events"
            ).fetchall()
        )

    assert secret_key not in jsonl_text
    assert secret_key not in sqlite_text
    assert secret_key not in caplog.text


@pytest.mark.parametrize(
    ("method", "path", "json_payload"),
    [
        ("post", "/api/admin/invites", {"provider": "seedream", "uses": 10}),
        ("get", "/api/admin/invites", None),
        ("post", "/api/admin/invites/1/toggle", {"enabled": False}),
    ],
)
def test_admin_routes_disabled_without_server_password(monkeypatch, tmp_path, method, path, json_payload):
    monkeypatch.delenv("ADMIN_PASSWORD", raising=False)
    app = create_app(state_dir=tmp_path, generator=StubGenerator())
    client = app.test_client()

    response = getattr(client, method)(path, json=json_payload)

    assert response.status_code == 503
    assert response.get_json()["error"] == "管理功能尚未启用。"


@pytest.mark.parametrize("headers", [{}, {"X-Admin-Password": "wrong-password"}])
def test_admin_routes_reject_missing_or_wrong_password(monkeypatch, tmp_path, headers):
    monkeypatch.setenv("ADMIN_PASSWORD", "owner-password")
    app = create_app(state_dir=tmp_path, generator=StubGenerator())

    response = app.test_client().post(
        "/api/admin/invites",
        json={"provider": "seedream", "uses": 10},
        headers=headers,
    )

    assert response.status_code == 401
    assert response.get_json()["error"] == "管理密码不正确。"


def test_admin_can_create_list_and_disable_invite(monkeypatch, tmp_path):
    monkeypatch.setenv("ADMIN_PASSWORD", "owner-password")
    app = create_app(state_dir=tmp_path, generator=StubGenerator())
    client = app.test_client()
    headers = {"X-Admin-Password": "owner-password"}

    create_response = client.post(
        "/api/admin/invites",
        json={"provider": "seedream", "uses": 10},
        headers=headers,
    )

    created = create_response.get_json()
    assert create_response.status_code == 200
    assert set(created) == {"id", "plaintext_code", "code_hint", "provider", "remaining_uses", "enabled"}
    assert created["provider"] == "seedream"
    assert created["remaining_uses"] == 10
    assert created["enabled"] is True
    assert created["plaintext_code"].startswith(created["code_hint"][:4])

    list_response = client.get("/api/admin/invites", headers=headers)

    assert list_response.status_code == 200
    assert list_response.get_json() == {
        "invites": [
            {
                "id": created["id"],
                "code_hint": created["code_hint"],
                "provider": "seedream",
                "remaining_uses": 10,
                "reserved_uses": 0,
                "successful_uses": 0,
                "enabled": True,
            }
        ]
    }

    toggle_response = client.post(
        f"/api/admin/invites/{created['id']}/toggle",
        json={"enabled": False},
        headers=headers,
    )

    assert toggle_response.status_code == 200
    assert toggle_response.get_json() == {
        "id": created["id"],
        "code_hint": created["code_hint"],
        "provider": "seedream",
        "remaining_uses": 10,
        "reserved_uses": 0,
        "successful_uses": 0,
        "enabled": False,
    }
    assert app.extensions["invite_store"].list_invites()[0].enabled is False


def test_admin_create_defaults_provider_to_seedream(monkeypatch, tmp_path):
    monkeypatch.setenv("ADMIN_PASSWORD", "owner-password")
    app = create_app(state_dir=tmp_path, generator=StubGenerator())

    response = app.test_client().post(
        "/api/admin/invites",
        json={"uses": 3},
        headers={"X-Admin-Password": "owner-password"},
    )

    assert response.status_code == 200
    assert response.get_json()["provider"] == "seedream"


def test_admin_toggle_rejects_non_boolean_enabled(monkeypatch, tmp_path):
    monkeypatch.setenv("ADMIN_PASSWORD", "owner-password")
    app = create_app(state_dir=tmp_path, generator=StubGenerator())
    client = app.test_client()
    headers = {"X-Admin-Password": "owner-password"}
    created = client.post("/api/admin/invites", json={"uses": 2}, headers=headers).get_json()

    response = client.post(
        f"/api/admin/invites/{created['id']}/toggle",
        json={"enabled": "false"},
        headers=headers,
    )

    assert response.status_code == 400
    assert response.get_json()["error"] == "enabled 必须是布尔值。"
    assert app.extensions["invite_store"].list_invites()[0].enabled is True


def test_admin_list_and_toggle_never_expose_plaintext_code(monkeypatch, tmp_path):
    monkeypatch.setenv("ADMIN_PASSWORD", "owner-password")
    app = create_app(state_dir=tmp_path, generator=StubGenerator())
    client = app.test_client()
    headers = {"X-Admin-Password": "owner-password"}
    create_response = client.post("/api/admin/invites", json={"uses": 2}, headers=headers)
    created = create_response.get_json()

    assert create_response.status_code == 200

    list_payload = client.get("/api/admin/invites", headers=headers).get_json()
    toggle_payload = client.post(
        f"/api/admin/invites/{created['id']}/toggle",
        json={"enabled": True},
        headers=headers,
    ).get_json()

    assert created["plaintext_code"]
    assert "plaintext_code" not in list_payload["invites"][0]
    assert "plaintext_code" not in toggle_payload
    assert created["plaintext_code"] not in json.dumps(list_payload)
    assert created["plaintext_code"] not in json.dumps(toggle_payload)


def test_index_uses_invite_assigned_model(tmp_path):
    app = create_app(state_dir=tmp_path, generator=StubGenerator())

    html = app.test_client().get("/").get_data(as_text=True)

    assert 'name="access_method" value="invite"' in html
    assert 'name="provider"' not in html
    assert 'name="template_width"' in html
    assert 'name="template_height"' in html
    assert 'id="template-ratio"' in html


def test_index_has_invite_access_and_app_js_avoids_browser_storage(tmp_path):
    app = create_app(state_dir=tmp_path, generator=StubGenerator())
    client = app.test_client()

    html = client.get("/").get_data(as_text=True)
    app_js = client.get("/app.js").get_data(as_text=True)

    for expected in [
        'id="invite-fields"',
        'id="invite-code"',
        'id="verify-invite"',
        'id="invite-status"',
        'name="access_method" value="invite"',
    ]:
        assert expected in html
    assert 'id="access-own-api"' not in html
    assert 'id="api-key"' not in html
    assert "Seedream" not in app_js
    assert "Gemini" not in app_js
    assert "localStorage" not in app_js
    assert "sessionStorage" not in app_js
    assert "document.cookie" not in app_js
    assert "location.search" not in app_js


def test_hidden_credential_panels_are_not_overridden_by_grid_display(tmp_path):
    app = create_app(state_dir=tmp_path, generator=StubGenerator())

    styles = app.test_client().get("/styles.css").get_data(as_text=True)

    credential_rule_position = styles.index(".credential-fields")
    hidden_rule_position = styles.find("[hidden]")
    assert hidden_rule_position > credential_rule_position
    assert "display: none !important" in styles[hidden_rule_position : hidden_rule_position + 120]


def test_admin_page_has_creation_and_usage_controls(tmp_path):
    app = create_app(state_dir=tmp_path, generator=StubGenerator())

    response = app.test_client().get("/admin.html")
    html = response.get_data(as_text=True)

    assert response.status_code == 200
    for expected in [
        'id="admin-password"',
        'id="invite-provider"',
        'id="invite-uses"',
        'id="create-invite"',
        'id="created-code"',
        'id="copy-created-code"',
        'id="invite-list"',
        'id="admin-status"',
    ]:
        assert expected in html


def test_generate_rejects_missing_template(tmp_path):
    app = create_app(state_dir=tmp_path, generator=StubGenerator())
    client = app.test_client()

    response = client.post(
        "/api/generate",
        data={"pets": [make_upload("pet.png")]},
        content_type="multipart/form-data",
    )

    assert response.status_code == 400
    assert response.get_json()["error"] == "请上传 1 张单动物 Meme 模板图。"


def test_watermark_cleanup_requires_rights_confirmation(tmp_path):
    generator = StubGenerator()
    app = create_app(state_dir=tmp_path, generator=generator)
    invite = app.extensions["invite_store"].create_invite(provider="gemini", uses=10)

    response = app.test_client().post(
        "/api/generate",
        data={
            "access_method": "invite",
            "invite_code": invite.plaintext_code,
            "remove_watermark": "1",
            "template": make_upload("template.png"),
            "pets": [make_upload("pet.png")],
        },
        content_type="multipart/form-data",
    )

    assert response.status_code == 400
    assert response.get_json()["error"] == "请先确认你有权使用并处理这张图片。"
    assert generator.calls == []


def test_generate_rejects_more_than_three_pet_photos(tmp_path):
    app = create_app(state_dir=tmp_path, generator=StubGenerator())
    client = app.test_client()

    response = client.post(
        "/api/generate",
        data={
            "template": make_upload("template.png"),
            "pets": [
                make_upload("pet1.png"),
                make_upload("pet2.png"),
                make_upload("pet3.png"),
                make_upload("pet4.png"),
            ],
        },
        content_type="multipart/form-data",
    )

    assert response.status_code == 400
    assert response.get_json()["error"] == "请上传 1 到 3 张自家宠物照片。"


def test_generate_saves_result_and_returns_download_url(tmp_path):
    generator = StubGenerator()
    app = create_app(
        state_dir=tmp_path,
        generator_factories={"gemini": make_generator_factory(generator)},
    )
    client = app.test_client()

    response = client.post(
        "/api/generate",
        data=make_byok_data(adjustment="眼神更像原图"),
        content_type="multipart/form-data",
    )

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["ok"] is True
    assert payload["image_url"].startswith("/api/result/")
    assert payload["download_url"].startswith("/api/result/")
    assert (tmp_path / "outputs").exists()
    assert generator.calls[0]["adjustment"] == "眼神更像原图"


def test_generate_uses_meme_template_dimensions_for_output_ratio(tmp_path):
    generator = StubGenerator()
    app = create_app(
        state_dir=tmp_path,
        generator_factories={"gemini": make_generator_factory(generator)},
    )

    response = app.test_client().post(
        "/api/generate",
        data=make_byok_data(
            template=make_upload("square-template.png"),
            pets=[make_upload("vertical-pet.png")],
            template_width="1080",
            template_height="1080",
        ),
        content_type="multipart/form-data",
    )

    assert response.status_code == 200
    assert response.get_json()["aspect_ratio"] == "1:1"
    assert generator.calls[0]["aspect_ratio"] == "1:1"


def test_generate_rejects_non_square_meme_template(tmp_path):
    generator = StubGenerator()
    app = create_app(
        state_dir=tmp_path,
        generator_factories={"gemini": make_generator_factory(generator)},
    )

    response = app.test_client().post(
        "/api/generate",
        data=make_byok_data(
            template=make_upload("vertical-template.png"),
            pets=[make_upload("square-pet.png")],
            template_width="1080",
            template_height="1920",
        ),
        content_type="multipart/form-data",
    )

    assert response.status_code == 400
    assert response.get_json()["error"] == "Meme 模板必须是正方形图片，请重新上传。"
    assert generator.calls == []


def test_result_endpoint_returns_saved_png(tmp_path):
    app = create_app(state_dir=tmp_path, generator=StubGenerator())
    output_dir = tmp_path / "outputs"
    (output_dir / "abc.png").write_bytes(b"generated")
    client = app.test_client()

    response = client.get("/api/result/abc.png")

    assert response.status_code == 200
    assert response.data == b"generated"
    assert response.mimetype == "image/png"


def test_generate_preserves_jpeg_result_type(tmp_path):
    generator = StubGenerator(image_bytes=b"\xff\xd8\xffgenerated", mime_type="image/jpeg")
    app = create_app(
        state_dir=tmp_path,
        generator_factories={"gemini": make_generator_factory(generator)},
    )

    response = app.test_client().post(
        "/api/generate",
        data=make_byok_data(),
        content_type="multipart/form-data",
    )

    payload = response.get_json()
    assert payload["image_url"].endswith(".jpg")
    image_response = app.test_client().get(payload["image_url"])
    assert image_response.data == b"\xff\xd8\xffgenerated"
    assert image_response.mimetype == "image/jpeg"


def test_health_reports_gemini_configuration(monkeypatch, tmp_path):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setenv("ARK_API_KEY", "ark-key")
    app = create_app(state_dir=tmp_path, generator=StubGenerator())

    response = app.test_client().get("/api/health")

    assert response.get_json() == {
        "ok": True,
        "configured": True,
        "providers": {"gemini": True, "seedream": True},
    }


def test_generate_routes_to_selected_provider_and_records_success(tmp_path):
    gemini = StubGenerator(model_name="gemini-test")
    seedream = StubGenerator(model_name="seedream-test")
    app = create_app(
        state_dir=tmp_path,
        generator_factories={
            "gemini": make_generator_factory(gemini),
            "seedream": make_generator_factory(seedream),
        },
    )

    response = app.test_client().post(
        "/api/generate",
        data=make_byok_data(provider="seedream", api_key="ark-key"),
        content_type="multipart/form-data",
    )

    assert response.status_code == 200
    assert response.get_json()["provider"] == "seedream"
    assert not gemini.calls
    assert len(seedream.calls) == 1
    records = [json.loads(line) for line in (tmp_path / "generations.jsonl").read_text().splitlines()]
    assert records[0]["provider"] == "seedream"
    assert records[0]["model"] == "seedream-test"
    assert records[0]["status"] == "succeeded"


def test_generate_rejects_unknown_provider(tmp_path):
    app = create_app(
        state_dir=tmp_path,
        generator_factories={"gemini": make_generator_factory(StubGenerator())},
    )

    response = app.test_client().post(
        "/api/generate",
        data=make_byok_data(provider="unknown"),
        content_type="multipart/form-data",
    )

    assert response.status_code == 400
    assert response.get_json()["error"] == "请选择可用的生成模型。"


def test_byok_blank_api_key_returns_400_before_factory_or_history_writes(tmp_path):
    factory_calls = []
    app = create_app(
        state_dir=tmp_path,
        generator_factories={"gemini": make_generator_factory(StubGenerator(), factory_calls)},
    )

    response = app.test_client().post(
        "/api/generate",
        data=make_byok_data(api_key="   "),
        content_type="multipart/form-data",
    )

    assert response.status_code == 400
    assert response.get_json()["error"] == "请填写 API Key。"
    assert factory_calls == []
    assert not (tmp_path / "generations.jsonl").exists()
    assert read_events(tmp_path / "pet-meme.sqlite3") == []


def test_invite_verify_returns_provider_and_remaining_uses(tmp_path):
    app = create_app(state_dir=tmp_path, generators={"seedream": StubGenerator()})
    invite = app.extensions["invite_store"].create_invite(provider="seedream", uses=2)

    response = app.test_client().post("/api/invite/verify", json={"code": invite.plaintext_code})

    assert response.status_code == 200
    assert response.get_json() == {"ok": True, "provider": "seedream", "remaining_uses": 2}


def test_invite_generation_uses_code_provider_and_spends_one_use(tmp_path):
    gemini = StubGenerator(model_name="gemini-owner")
    seedream = StubGenerator(model_name="seedream-owner")
    app = create_app(state_dir=tmp_path, generators={"gemini": gemini, "seedream": seedream})
    invite = app.extensions["invite_store"].create_invite(provider="seedream", uses=2)

    response = app.test_client().post(
        "/api/generate",
        data={
            "access_method": "invite",
            "invite_code": invite.plaintext_code,
            "template": make_upload("template.png"),
            "pets": [make_upload("pet.png")],
        },
        content_type="multipart/form-data",
    )

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["provider"] == "seedream"
    assert payload["remaining_uses"] == 1
    assert not gemini.calls
    assert len(seedream.calls) == 1
    assert app.extensions["invite_store"].list_invites()[0].remaining_uses == 1


def test_invite_generation_ignores_submitted_provider_override(tmp_path):
    gemini = StubGenerator(model_name="gemini-owner")
    seedream = StubGenerator(model_name="seedream-owner")
    app = create_app(state_dir=tmp_path, generators={"gemini": gemini, "seedream": seedream})
    invite = app.extensions["invite_store"].create_invite(provider="seedream", uses=1)

    response = app.test_client().post(
        "/api/generate",
        data={
            "access_method": "invite",
            "invite_code": invite.plaintext_code,
            "provider": "gemini",
            "template": make_upload("template.png"),
            "pets": [make_upload("pet.png")],
        },
        content_type="multipart/form-data",
    )

    assert response.status_code == 200
    assert response.get_json()["provider"] == "seedream"
    assert not gemini.calls
    assert len(seedream.calls) == 1


def test_invite_generation_reports_unavailable_assigned_provider(tmp_path):
    app = create_app(state_dir=tmp_path, generators={"gemini": StubGenerator()})
    invite = app.extensions["invite_store"].create_invite(provider="seedream", uses=1)

    response = app.test_client().post(
        "/api/generate",
        data={
            "access_method": "invite",
            "invite_code": invite.plaintext_code,
            "template": make_upload("template.png"),
            "pets": [make_upload("pet.png")],
        },
        content_type="multipart/form-data",
    )

    assert response.status_code == 400
    assert response.get_json()["error"] == "这个邀请码对应的模型暂不可用。"
    assert app.extensions["invite_store"].verify(invite.plaintext_code).remaining_uses == 1


def test_byok_builds_request_scoped_generator_and_does_not_spend_invite_quota(tmp_path):
    captured_keys = []
    generator = StubGenerator(model_name="byok-model")
    app = create_app(
        state_dir=tmp_path,
        generator_factories={"gemini": make_generator_factory(generator, captured_keys)},
    )
    invite = app.extensions["invite_store"].create_invite(provider="gemini", uses=10)

    response = app.test_client().post(
        "/api/generate",
        data=make_byok_data(api_key="request-only-key"),
        content_type="multipart/form-data",
    )

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["provider"] == "gemini"
    assert "remaining_uses" not in payload
    assert captured_keys == ["request-only-key"]
    assert app.extensions["invite_store"].verify(invite.plaintext_code).remaining_uses == 10
    assert read_events(tmp_path / "pet-meme.sqlite3") == [
        ("own_api", "gemini", "byok-model", None, "succeeded", 0, "1:1")
    ]


def test_upload_validation_does_not_reserve_invite_quota(tmp_path):
    app = create_app(state_dir=tmp_path, generators={"gemini": StubGenerator()})
    invite = app.extensions["invite_store"].create_invite(provider="gemini", uses=10)

    response = app.test_client().post(
        "/api/generate",
        data={"access_method": "invite", "invite_code": invite.plaintext_code, "pets": [make_upload("pet.png")]},
        content_type="multipart/form-data",
    )

    assert response.status_code == 400
    assert app.extensions["invite_store"].verify(invite.plaintext_code).remaining_uses == 10
    assert read_events(tmp_path / "pet-meme.sqlite3") == []


def test_provider_failure_refunds_invite_quota(tmp_path):
    app = create_app(state_dir=tmp_path, generators={"gemini": FailingGenerator("provider down")})
    invite = app.extensions["invite_store"].create_invite(provider="gemini", uses=10)

    response = app.test_client().post(
        "/api/generate",
        data={
            "access_method": "invite",
            "invite_code": invite.plaintext_code,
            "template": make_upload("template.png"),
            "pets": [make_upload("pet.png")],
        },
        content_type="multipart/form-data",
    )

    assert response.status_code == 502
    assert response.get_json()["error"] == "provider down"
    assert app.extensions["invite_store"].verify(invite.plaintext_code).remaining_uses == 10
    assert read_events(tmp_path / "pet-meme.sqlite3") == [
        ("invite", "gemini", "failing-model", 1, "failed", 0, "1:1")
    ]


def test_invite_provider_error_hides_owner_api_key(monkeypatch, tmp_path):
    monkeypatch.setenv("GEMINI_API_KEY", "owner-secret-key")
    app = create_app(state_dir=tmp_path, generators={"gemini": FailingGenerator("bad key owner-secret-key")})
    invite = app.extensions["invite_store"].create_invite(provider="gemini", uses=10)

    response = app.test_client().post(
        "/api/generate",
        data={
            "access_method": "invite",
            "invite_code": invite.plaintext_code,
            "template": make_upload("template.png"),
            "pets": [make_upload("pet.png")],
        },
        content_type="multipart/form-data",
    )

    assert response.status_code == 502
    assert "owner-secret-key" not in response.get_data(as_text=True)
    assert response.get_json()["error"] == "bad key 【已隐藏】"
    assert app.extensions["invite_store"].verify(invite.plaintext_code).remaining_uses == 10


def test_output_write_failure_refunds_invite_quota(monkeypatch, tmp_path):
    app = create_app(state_dir=tmp_path, generators={"gemini": StubGenerator()})
    invite = app.extensions["invite_store"].create_invite(provider="gemini", uses=10)

    def fail_write_bytes(self, data):
        raise OSError("disk full")

    monkeypatch.setattr(type(tmp_path), "write_bytes", fail_write_bytes)

    response = app.test_client().post(
        "/api/generate",
        data={
            "access_method": "invite",
            "invite_code": invite.plaintext_code,
            "template": make_upload("template.png"),
            "pets": [make_upload("pet.png")],
        },
        content_type="multipart/form-data",
    )

    assert response.status_code == 500
    assert response.get_json()["error"] == "生成结果保存失败，请稍后再试。"
    assert app.extensions["invite_store"].verify(invite.plaintext_code).remaining_uses == 10
    assert read_events(tmp_path / "pet-meme.sqlite3") == [
        ("invite", "gemini", "stub-model", 1, "failed", 0, "1:1")
    ]


def test_success_jsonl_failure_still_returns_result_after_invite_complete(monkeypatch, tmp_path):
    app = create_app(state_dir=tmp_path, generators={"gemini": StubGenerator()})
    invite = app.extensions["invite_store"].create_invite(provider="gemini", uses=10)

    def fail_append(state_root, record):
        raise OSError("log unavailable")

    monkeypatch.setattr("pet_meme.app._append_generation_record", fail_append)

    response = app.test_client().post(
        "/api/generate",
        data={
            "access_method": "invite",
            "invite_code": invite.plaintext_code,
            "template": make_upload("template.png"),
            "pets": [make_upload("pet.png")],
        },
        content_type="multipart/form-data",
    )

    assert response.status_code == 200
    assert response.get_json()["ok"] is True
    assert response.get_json()["remaining_uses"] == 7
    status = app.extensions["invite_store"].list_invites()[0]
    assert (status.remaining_uses, status.reserved_uses, status.successful_uses) == (7, 0, 1)
    assert read_events(tmp_path / "pet-meme.sqlite3") == [
        ("invite", "gemini", "stub-model", 1, "succeeded", 0, "1:1")
    ]


def test_complete_failure_returns_clear_error_without_second_refund(monkeypatch, tmp_path):
    app = create_app(state_dir=tmp_path, generators={"gemini": StubGenerator()})
    store = app.extensions["invite_store"]
    invite = store.create_invite(provider="gemini", uses=10)
    original_complete = store.complete

    def fail_once(request_id):
        original_complete(request_id)
        raise OSError("complete response lost")

    monkeypatch.setattr(store, "complete", fail_once)

    response = app.test_client().post(
        "/api/generate",
        data={
            "access_method": "invite",
            "invite_code": invite.plaintext_code,
            "template": make_upload("template.png"),
            "pets": [make_upload("pet.png")],
        },
        content_type="multipart/form-data",
    )

    assert response.status_code == 500
    assert response.get_json()["error"] == "生成结果保存失败，请稍后再试。"
    status = store.list_invites()[0]
    assert (status.remaining_uses, status.reserved_uses, status.successful_uses) == (7, 0, 1)


def test_invite_unexpected_provider_exception_refunds_quota_and_records_failed_event(tmp_path):
    app = create_app(state_dir=tmp_path, generators={"gemini": UnexpectedFailingGenerator("timeout")})
    invite = app.extensions["invite_store"].create_invite(provider="gemini", uses=10)

    response = app.test_client().post(
        "/api/generate",
        data={
            "access_method": "invite",
            "invite_code": invite.plaintext_code,
            "template": make_upload("template.png"),
            "pets": [make_upload("pet.png")],
        },
        content_type="multipart/form-data",
    )

    assert response.status_code == 502
    assert response.get_json()["error"] == "生成失败，请稍后再试。"
    assert app.extensions["invite_store"].verify(invite.plaintext_code).remaining_uses == 10
    assert read_events(tmp_path / "pet-meme.sqlite3") == [
        ("invite", "gemini", "unexpected-failing-model", 1, "failed", 0, "1:1")
    ]


def test_byok_provider_error_redacts_key_from_response_jsonl_sqlite_and_logs(caplog, tmp_path):
    secret_key = "sk-secret-value"
    app = create_app(
        state_dir=tmp_path,
        generator_factories={"gemini": make_generator_factory(FailingGenerator(f"bad key {secret_key}"))},
    )

    response = app.test_client().post(
        "/api/generate",
        data=make_byok_data(api_key=secret_key),
        content_type="multipart/form-data",
    )

    response_text = response.get_data(as_text=True)

    assert response.status_code == 502
    assert secret_key not in response_text
    assert response.get_json()["error"] == "bad key 【已隐藏】"
    assert_secret_not_persisted(tmp_path, secret_key, caplog)
    assert read_events(tmp_path / "pet-meme.sqlite3") == [
        ("own_api", "gemini", "failing-model", None, "failed", 0, "1:1")
    ]


def test_byok_factory_exception_redacts_key_from_response_jsonl_sqlite_and_logs(caplog, tmp_path):
    secret_key = "factory-secret-value"

    def failing_factory(api_key):
        raise RuntimeError(f"factory failed for {api_key}")

    app = create_app(state_dir=tmp_path, generator_factories={"gemini": failing_factory})

    response = app.test_client().post(
        "/api/generate",
        data=make_byok_data(api_key=secret_key),
        content_type="multipart/form-data",
    )

    assert response.status_code == 502
    assert secret_key not in response.get_data(as_text=True)
    assert response.get_json()["error"] == "生成失败，请稍后再试。"
    assert_secret_not_persisted(tmp_path, secret_key, caplog)
    assert read_events(tmp_path / "pet-meme.sqlite3") == []


def test_byok_unexpected_provider_exception_redacts_key_from_response_jsonl_sqlite_and_logs(caplog, tmp_path):
    secret_key = "runtime-secret-value"
    app = create_app(
        state_dir=tmp_path,
        generator_factories={
            "gemini": make_generator_factory(UnexpectedFailingGenerator(f"runtime failed for {secret_key}"))
        },
    )

    response = app.test_client().post(
        "/api/generate",
        data=make_byok_data(api_key=secret_key),
        content_type="multipart/form-data",
    )

    assert response.status_code == 502
    assert secret_key not in response.get_data(as_text=True)
    assert response.get_json()["error"] == "生成失败，请稍后再试。"
    assert_secret_not_persisted(tmp_path, secret_key, caplog)
    assert read_events(tmp_path / "pet-meme.sqlite3") == [
        ("own_api", "gemini", "unexpected-failing-model", None, "failed", 0, "1:1")
    ]
