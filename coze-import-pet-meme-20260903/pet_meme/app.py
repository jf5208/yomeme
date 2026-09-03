import hmac
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable
from uuid import uuid4

from flask import Flask, jsonify, request, send_from_directory
from werkzeug.utils import secure_filename

from .generator import (
    GeminiImageGenerator,
    ImageGenerationError,
    SeedreamImageGenerator,
    create_image_generator,
)
from .invites import InviteCodeError, InviteStore


ALLOWED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
SUPPORTED_PROVIDERS = {"gemini", "seedream"}


def create_app(
    state_dir: Path | None = None,
    generator=None,
    generators=None,
    generator_factories: dict[str, Callable[[str], object]] | None = None,
) -> Flask:
    app = Flask(__name__, static_folder="../static", static_url_path="")
    if state_dir is not None:
        state_root = state_dir
    else:
        env_state = os.environ.get("STATE_DIR", "").strip()
        if env_state:
            state_root = Path(env_state)
        else:
            root = Path(__file__).resolve().parents[1]
            state_root = root / ".state"
    upload_dir = state_root / "uploads"
    output_dir = state_root / "outputs"
    upload_dir.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)
    invite_store = InviteStore(state_root / "pet-meme.sqlite3")
    app.extensions["invite_store"] = invite_store
    if generators is not None:
        image_generators = generators
    elif generator is not None:
        image_generators = {"gemini": generator}
    else:
        image_generators = {
            "gemini": GeminiImageGenerator(os.environ.get("GEMINI_API_KEY", "")),
            "seedream": SeedreamImageGenerator(
                os.environ.get("ARK_API_KEY", ""),
                model_name=os.environ.get("SEEDREAM_MODEL", "") or None,
            ),
        }
    if generator_factories is None:
        seedream_model = os.environ.get("SEEDREAM_MODEL", "") or None
        generator_factories = {
            "gemini": lambda api_key: create_image_generator("gemini", api_key),
            "seedream": lambda api_key: create_image_generator(
                "seedream",
                api_key,
                seedream_model=seedream_model,
            ),
        }

    @app.get("/")
    def index():
        return app.send_static_file("index.html")

    @app.get("/api/health")
    def health():
        gemini_configured = bool(os.environ.get("GEMINI_API_KEY", "").strip())
        seedream_configured = bool(os.environ.get("ARK_API_KEY", "").strip())
        return jsonify(
            ok=True,
            configured=gemini_configured,
            providers={"gemini": gemini_configured, "seedream": seedream_configured},
        )

    @app.post("/api/invite/verify")
    def verify_invite():
        payload = request.get_json(silent=True) or {}
        try:
            status = invite_store.verify(payload.get("code", ""))
        except InviteCodeError as error:
            return jsonify(ok=False, error=error.message), 400
        return jsonify(ok=True, provider=status.provider, remaining_uses=status.remaining_uses)

    def require_admin():
        admin_password = os.environ.get("ADMIN_PASSWORD", "")
        if not admin_password:
            return jsonify(ok=False, error="管理功能尚未启用。"), 503
        submitted_password = request.headers.get("X-Admin-Password", "")
        if not hmac.compare_digest(submitted_password, admin_password):
            return jsonify(ok=False, error="管理密码不正确。"), 401
        return None

    @app.post("/api/admin/invites")
    def create_admin_invite():
        auth_error = require_admin()
        if auth_error is not None:
            return auth_error

        payload = request.get_json(silent=True) or {}
        try:
            invite = invite_store.create_invite(
                provider=payload.get("provider", "seedream"),
                uses=payload.get("uses", 10),
            )
        except InviteCodeError as error:
            return jsonify(ok=False, error=error.message), 400
        return jsonify(_created_invite_payload(invite))

    @app.post("/api/admin/invites/batch")
    def create_batch_admin_invites():
        auth_error = require_admin()
        if auth_error is not None:
            return auth_error

        payload = request.get_json(silent=True) or {}
        provider = payload.get("provider", "seedream")
        uses = payload.get("uses", 10)
        count = min(max(int(payload.get("count", 1)), 1), 100)

        codes = []
        for _ in range(count):
            try:
                invite = invite_store.create_invite(provider=provider, uses=uses)
                codes.append(invite.plaintext_code)
            except InviteCodeError as error:
                return jsonify(ok=False, error=error.message), 400

        return jsonify({"ok": True, "codes": codes, "count": len(codes)})

    @app.get("/api/admin/invites")
    def list_admin_invites():
        auth_error = require_admin()
        if auth_error is not None:
            return auth_error

        return jsonify({"invites": [_invite_status_payload(invite) for invite in invite_store.list_invites()]})

    @app.post("/api/admin/invites/<int:invite_id>/toggle")
    def toggle_admin_invite(invite_id: int):
        auth_error = require_admin()
        if auth_error is not None:
            return auth_error

        payload = request.get_json(silent=True) or {}
        enabled = payload.get("enabled")
        if not isinstance(enabled, bool):
            return jsonify(ok=False, error="enabled 必须是布尔值。"), 400
        try:
            invite = invite_store.set_enabled(invite_id, enabled)
        except InviteCodeError as error:
            return jsonify(ok=False, error=error.message), 400
        return jsonify(_invite_status_payload(invite))

    @app.post("/api/generate")
    def generate():
        template = request.files.get("template")
        pets = request.files.getlist("pets")
        adjustment = request.form.get("adjustment", "")
        remove_watermark = request.form.get("remove_watermark") == "1"
        if remove_watermark and request.form.get("rights_confirmed") != "1":
            return jsonify(ok=False, error="请先确认你有权使用并处理这张图片。"), 400
        template_width = request.form.get("template_width", "").strip()
        template_height = request.form.get("template_height", "").strip()
        if template_width or template_height:
            if not template_width or not template_height:
                return jsonify(ok=False, error="Meme 模板必须是正方形图片，请重新上传。"), 400
            # 允许接近 1:1 的比例（误差 15% 以内），适配截图等不精准的情况
            try:
                w, h = int(template_width), int(template_height)
                ratio = max(w, h) / min(w, h)
                if ratio > 1.15:
                    return jsonify(ok=False, error="Meme 模板必须是接近正方形的图片（长宽比不超过 1.15），请重新上传。"), 400
            except (ValueError, ZeroDivisionError):
                return jsonify(ok=False, error="Meme 模板尺寸无效，请重新上传。"), 400
        access_method = request.form.get("access_method", "invite")
        aspect_ratio = _closest_aspect_ratio(
            request.form.get("template_width", ""),
            request.form.get("template_height", ""),
        )

        validation_error = _validate_uploads(template, pets)
        if validation_error:
            return jsonify(ok=False, error=validation_error), 400

        if access_method == "own_api":
            provider = request.form.get("provider", "gemini")
            api_key = request.form.get("api_key", "")
            if provider not in SUPPORTED_PROVIDERS or provider not in generator_factories:
                return jsonify(ok=False, error="请选择可用的生成模型。"), 400
            if not api_key.strip():
                return jsonify(ok=False, error="请填写 API Key。"), 400
            try:
                image_generator = generator_factories[provider](api_key)
            except Exception:
                return jsonify(ok=False, error="生成失败，请稍后再试。"), 502
            invite_status = None
        elif access_method == "invite":
            try:
                invite_status = invite_store.verify(request.form.get("invite_code", ""))
            except InviteCodeError as error:
                return jsonify(ok=False, error=error.message), 400
            provider = invite_status.provider
            if provider not in image_generators:
                return jsonify(ok=False, error="这个邀请码对应的模型暂不可用。"), 400
            image_generator = image_generators[provider]
        else:
            return jsonify(ok=False, error="请选择可用的生成模型。"), 400

        request_id = uuid4().hex
        request_upload_dir = upload_dir / request_id
        request_upload_dir.mkdir(parents=True, exist_ok=True)
        template_path = _save_upload(template, request_upload_dir, "template")
        pet_paths = [_save_upload(pet, request_upload_dir, f"pet-{index}") for index, pet in enumerate(pets, 1)]
        record = {
            "request_id": request_id,
            "access_method": access_method,
            "provider": provider,
            "model": getattr(image_generator, "model_name", image_generator.__class__.__name__),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "has_adjustment": bool(adjustment.strip()),
            "aspect_ratio": aspect_ratio,
        }

        if access_method == "invite":
            try:
                invite_store.reserve(
                    request.form.get("invite_code", ""),
                    request_id,
                    record["model"],
                    record["has_adjustment"],
                    aspect_ratio,
                )
            except InviteCodeError as error:
                return jsonify(ok=False, error=error.message), 400

        try:
            generated = image_generator.generate(
                template_path,
                pet_paths,
                adjustment,
                aspect_ratio,
                remove_watermark,
            )
        except ImageGenerationError as error:
            error_message = str(error)
            if access_method == "invite":
                error_message = _redact_owner_secrets(error_message)
                _safe_refund(invite_store, request_id)
            else:
                error_message = _redact_secret(error_message, request.form.get("api_key", ""))
                _safe_record_own_api(
                    invite_store,
                    request_id,
                    provider,
                    record["model"],
                    "failed",
                    record["has_adjustment"],
                    aspect_ratio,
                )
            _safe_append_generation_record(state_root, {**record, "status": "failed"})
            return jsonify(ok=False, error=error_message), 502
        except Exception:
            if access_method == "invite":
                _safe_refund(invite_store, request_id)
            else:
                _safe_record_own_api(
                    invite_store,
                    request_id,
                    provider,
                    record["model"],
                    "failed",
                    record["has_adjustment"],
                    aspect_ratio,
                )
            _safe_append_generation_record(state_root, {**record, "status": "failed"})
            return jsonify(ok=False, error="生成失败，请稍后再试。"), 502

        output_suffix = ".jpg" if generated.mime_type == "image/jpeg" else ".png"
        output_name = f"{request_id}{output_suffix}"
        try:
            (output_dir / output_name).write_bytes(generated.image_bytes)
            if access_method == "invite":
                invite_status = invite_store.complete(request_id)
            else:
                invite_store.record_own_api(
                    request_id,
                    provider,
                    record["model"],
                    "succeeded",
                    record["has_adjustment"],
                    aspect_ratio,
                )
            _safe_append_generation_record(state_root, {**record, "status": "succeeded", "output": output_name})
        except Exception:
            if access_method == "invite":
                _safe_refund(invite_store, request_id)
            else:
                _safe_record_own_api(
                    invite_store,
                    request_id,
                    provider,
                    record["model"],
                    "failed",
                    record["has_adjustment"],
                    aspect_ratio,
                )
            _safe_append_generation_record(state_root, {**record, "status": "failed"})
            return jsonify(ok=False, error="生成结果保存失败，请稍后再试。"), 500
        result_url = f"/api/result/{output_name}"
        payload = {
            "ok": True,
            "provider": provider,
            "aspect_ratio": aspect_ratio,
            "image_url": result_url,
            "download_url": f"{result_url}?download=1",
        }
        if invite_status is not None:
            payload["remaining_uses"] = invite_status.remaining_uses
        return jsonify(payload)

    @app.get("/api/result/<path:filename>")
    def result(filename):
        return send_from_directory(
            output_dir,
            filename,
            as_attachment=request.args.get("download") == "1",
            download_name=f"pet-meme{Path(filename).suffix}",
        )

    return app


def _created_invite_payload(invite) -> dict:
    return {
        "id": invite.id,
        "plaintext_code": invite.plaintext_code,
        "code_hint": invite.code_hint,
        "provider": invite.provider,
        "remaining_uses": invite.remaining_uses,
        "enabled": invite.enabled,
    }


def _invite_status_payload(invite) -> dict:
    return {
        "id": invite.id,
        "code_hint": invite.code_hint,
        "provider": invite.provider,
        "remaining_uses": invite.remaining_uses,
        "reserved_uses": invite.reserved_uses,
        "successful_uses": invite.successful_uses,
        "enabled": invite.enabled,
    }


def _validate_uploads(template, pets) -> str | None:
    if template is None or not template.filename:
        return "请上传 1 张单动物 Meme 模板图。"
    if len(pets) < 1 or len(pets) > 3:
        return "请上传 1 到 3 张自家宠物照片。"
    uploads = [template, *pets]
    for upload in uploads:
        if not _is_supported_image(upload.filename):
            return "目前只支持 PNG、JPG、JPEG、WEBP 图片。"
    return None


def _is_supported_image(filename: str) -> bool:
    return Path(filename).suffix.lower() in ALLOWED_EXTENSIONS


def _save_upload(upload, directory: Path, prefix: str) -> Path:
    suffix = Path(upload.filename).suffix.lower()
    filename = secure_filename(f"{prefix}{suffix}")
    path = directory / filename
    upload.save(path)
    return path


def _append_generation_record(state_root: Path, record: dict) -> None:
    with (state_root / "generations.jsonl").open("a", encoding="utf-8") as log_file:
        log_file.write(json.dumps(record, ensure_ascii=False) + "\n")


def _safe_append_generation_record(state_root: Path, record: dict) -> None:
    try:
        _append_generation_record(state_root, record)
    except Exception:
        return


def _safe_refund(invite_store: InviteStore, request_id: str) -> None:
    try:
        invite_store.refund(request_id)
    except Exception:
        return


def _safe_record_own_api(
    invite_store: InviteStore,
    request_id: str,
    provider: str,
    model: str,
    status: str,
    has_adjustment: bool,
    aspect_ratio: str,
) -> None:
    try:
        invite_store.record_own_api(request_id, provider, model, status, has_adjustment, aspect_ratio)
    except Exception:
        return


def _redact_secret(message: str, secret: str) -> str:
    secret = secret.strip()
    if not secret:
        return message
    return message.replace(secret, "【已隐藏】")


def _redact_owner_secrets(message: str) -> str:
    for key_name in ("GEMINI_API_KEY", "ARK_API_KEY"):
        message = _redact_secret(message, os.environ.get(key_name, ""))
    return message


def _closest_aspect_ratio(width_value: str, height_value: str) -> str:
    try:
        width = int(width_value)
        height = int(height_value)
    except (TypeError, ValueError):
        return "1:1"
    if width <= 0 or height <= 0:
        return "1:1"

    ratios = {
        "1:1": 1,
        "2:3": 2 / 3,
        "3:2": 3 / 2,
        "3:4": 3 / 4,
        "4:3": 4 / 3,
        "4:5": 4 / 5,
        "5:4": 5 / 4,
        "9:16": 9 / 16,
        "16:9": 16 / 9,
        "21:9": 21 / 9,
    }
    template_ratio = width / height
    return min(ratios, key=lambda name: abs(ratios[name] - template_ratio))
