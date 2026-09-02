import base64
from pathlib import Path

from pet_meme.generator import (
    GeminiImageGenerator,
    ImageGenerationError,
    SeedreamImageGenerator,
    create_image_generator,
)


class FakeResponse:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = "fake error"

    def json(self):
        return self._payload


class FakeSession:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def post(self, url, headers=None, json=None, timeout=None, **kwargs):
        self.calls.append(
            {
                "url": url,
                "headers": headers,
                "json": json,
                "timeout": timeout,
                **kwargs,
            }
        )
        return self.response


def write_png(path: Path):
    path.write_bytes(b"\x89PNG\r\n\x1a\nsample")


def test_create_image_generator_builds_supported_provider_instances():
    gemini = create_image_generator("gemini", " gemini-key ")
    seedream = create_image_generator("seedream", "ark-key", seedream_model="custom-seedream")

    assert isinstance(gemini, GeminiImageGenerator)
    assert gemini.api_key == "gemini-key"
    assert isinstance(seedream, SeedreamImageGenerator)
    assert seedream.api_key == "ark-key"
    assert seedream.model_name == "custom-seedream"


def test_generator_sends_template_and_pet_images_to_gemini(tmp_path):
    output_jpeg = base64.b64encode(b"\xff\xd8\xffgenerated").decode("ascii")
    session = FakeSession(
        FakeResponse(
            payload={
                "data": [{"b64_json": output_jpeg}],
                "steps": [
                    {
                        "type": "model_output",
                        "content": [
                            {"type": "image", "data": output_jpeg, "mime_type": "image/jpeg"}
                        ],
                    }
                ]
            }
        )
    )
    generator = GeminiImageGenerator(api_key="test-key", session=session)
    template = tmp_path / "template.png"
    pet = tmp_path / "pet.png"
    write_png(template)
    write_png(pet)

    result = generator.generate(
        template_path=template,
        pet_paths=[pet],
        adjustment="更像原图的低清截图",
        aspect_ratio="1:1",
    )

    call = session.calls[0]
    assert call["url"] == "https://generativelanguage.googleapis.com/v1beta/interactions"
    assert call["headers"]["x-goog-api-key"] == "test-key"
    assert call["json"]["model"] == "gemini-3.1-flash-image"
    assert "更像原图的低清截图" in call["json"]["input"][0]["text"]
    assert [item["type"] for item in call["json"]["input"]] == ["text", "image", "image"]
    assert call["json"]["input"][1]["mime_type"] == "image/png"
    assert base64.b64decode(call["json"]["input"][1]["data"]).startswith(b"\x89PNG")
    assert call["json"]["response_format"] == {
        "type": "image",
        "mime_type": "image/jpeg",
        "aspect_ratio": "1:1",
    }
    assert result.image_bytes == b"\xff\xd8\xffgenerated"
    assert result.mime_type == "image/jpeg"


def test_generator_raises_clear_error_when_api_key_missing(tmp_path):
    generator = GeminiImageGenerator(api_key="", session=FakeSession(FakeResponse()))

    try:
        generator.generate(tmp_path / "template.png", [tmp_path / "pet.png"], "")
    except ImageGenerationError as error:
        assert str(error) == "缺少 GEMINI_API_KEY，请先在本机环境变量或 .env 中填写。"
    else:
        raise AssertionError("Expected ImageGenerationError")


def test_seedream_generator_sends_template_and_pet_images(tmp_path):
    output_png = base64.b64encode(b"\x89PNGgenerated").decode("ascii")
    session = FakeSession(FakeResponse(payload={"data": [{"b64_json": output_png}]}))
    generator = SeedreamImageGenerator(api_key="ark-key", session=session)
    template = tmp_path / "template.png"
    pet = tmp_path / "pet.png"
    write_png(template)
    write_png(pet)

    result = generator.generate(template, [pet], "毛色更像参考图", aspect_ratio="1:1")

    call = session.calls[0]
    assert call["url"] == "https://ark.cn-beijing.volces.com/api/v3/images/generations"
    assert call["headers"]["Authorization"] == "Bearer ark-key"
    assert call["json"]["model"] == "doubao-seedream-4-5-251128"
    assert call["json"]["image"][0].startswith("data:image/png;base64,")
    assert len(call["json"]["image"]) == 2
    assert "毛色更像参考图" in call["json"]["prompt"]
    assert call["json"]["response_format"] == "b64_json"
    assert call["json"]["sequential_image_generation"] == "disabled"
    assert call["json"]["size"] == "2048x2048"
    assert result.image_bytes == b"\x89PNGgenerated"
    assert result.mime_type == "image/png"


def test_seedream_generator_raises_clear_error_when_api_key_missing(tmp_path):
    generator = SeedreamImageGenerator(api_key="", session=FakeSession(FakeResponse()))

    try:
        generator.generate(tmp_path / "template.png", [tmp_path / "pet.png"], "")
    except ImageGenerationError as error:
        assert str(error) == "缺少 ARK_API_KEY，请先在本机 .env 中填写。"
    else:
        raise AssertionError("Expected ImageGenerationError")
