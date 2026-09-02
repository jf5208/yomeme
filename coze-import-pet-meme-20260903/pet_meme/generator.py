import base64
from dataclasses import dataclass
from pathlib import Path

import requests

from .prompts import build_generation_prompt


class ImageGenerationError(Exception):
    """Raised when image generation cannot complete."""


@dataclass(frozen=True)
class GeneratedImage:
    image_bytes: bytes
    mime_type: str


class GeminiImageGenerator:
    model_name = "gemini-3.1-flash-image"

    def __init__(self, api_key: str, session=None):
        self.api_key = api_key.strip()
        self.session = session or requests.Session()

    def generate(
        self,
        template_path: Path,
        pet_paths: list[Path],
        adjustment: str,
        aspect_ratio: str = "1:1",
        remove_watermark: bool = False,
    ) -> GeneratedImage:
        if not self.api_key:
            raise ImageGenerationError("缺少 GEMINI_API_KEY，请先在本机环境变量或 .env 中填写。")

        prompt = build_generation_prompt(len(pet_paths), adjustment, remove_watermark)
        inputs = [{"type": "text", "text": prompt}]
        for path in [template_path, *pet_paths]:
            inputs.append(
                {
                    "type": "image",
                    "data": base64.b64encode(path.read_bytes()).decode("ascii"),
                    "mime_type": _guess_mime_type(path),
                }
            )

        response = self.session.post(
            "https://generativelanguage.googleapis.com/v1beta/interactions",
            headers={"x-goog-api-key": self.api_key},
            json={
                "model": self.model_name,
                "input": inputs,
                "response_format": {
                    "type": "image",
                    "mime_type": "image/jpeg",
                    "aspect_ratio": aspect_ratio,
                },
            },
            timeout=180,
        )

        if response.status_code >= 400:
            raise ImageGenerationError(f"图片生成失败：{_extract_api_error(response)}")

        payload = response.json()
        for step in reversed(payload.get("steps", [])):
            for item in reversed(step.get("content", [])):
                if item.get("type") == "image" and item.get("data"):
                    return GeneratedImage(
                        image_bytes=base64.b64decode(item["data"]),
                        mime_type=item.get("mime_type", "image/png"),
                    )

        raise ImageGenerationError("图片生成接口没有返回可用图片。")


class SeedreamImageGenerator:
    model_name = "doubao-seedream-4-5-251128"

    def __init__(self, api_key: str, session=None, model_name: str | None = None):
        self.api_key = api_key.strip()
        self.session = session or requests.Session()
        if model_name:
            self.model_name = model_name.strip()

    def generate(
        self,
        template_path: Path,
        pet_paths: list[Path],
        adjustment: str,
        aspect_ratio: str = "1:1",
        remove_watermark: bool = False,
    ) -> GeneratedImage:
        if not self.api_key:
            raise ImageGenerationError("缺少 ARK_API_KEY，请先在本机 .env 中填写。")

        response = self.session.post(
            "https://ark.cn-beijing.volces.com/api/v3/images/generations",
            headers={"Authorization": f"Bearer {self.api_key}"},
            json={
                "model": self.model_name,
                "prompt": build_generation_prompt(len(pet_paths), adjustment, remove_watermark),
                "image": [_as_data_url(path) for path in [template_path, *pet_paths]],
                "response_format": "b64_json",
                "size": _seedream_size(aspect_ratio),
                "sequential_image_generation": "disabled",
                "stream": False,
                "watermark": False,
            },
            timeout=180,
        )

        if response.status_code >= 400:
            raise ImageGenerationError(f"Seedream 图片生成失败：{_extract_api_error(response)}")

        payload = response.json()
        for item in payload.get("data", []):
            encoded = item.get("b64_json")
            if encoded:
                image_bytes = base64.b64decode(encoded)
                return GeneratedImage(image_bytes=image_bytes, mime_type=_detect_mime_type(image_bytes))

        raise ImageGenerationError("Seedream 接口没有返回可用图片。")


def create_image_generator(provider: str, api_key: str, seedream_model: str | None = None, session=None):
    if provider == "gemini":
        return GeminiImageGenerator(api_key, session=session)
    if provider == "seedream":
        return SeedreamImageGenerator(api_key, session=session, model_name=seedream_model)
    raise ValueError("Unknown image provider.")


def _guess_mime_type(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if suffix == ".webp":
        return "image/webp"
    return "image/png"


def _as_data_url(path: Path) -> str:
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{_guess_mime_type(path)};base64,{encoded}"


def _detect_mime_type(image_bytes: bytes) -> str:
    if image_bytes.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    return "image/png"


def _seedream_size(aspect_ratio: str) -> str:
    sizes = {
        "1:1": "2048x2048",
        "2:3": "1664x2496",
        "3:2": "2496x1664",
        "3:4": "1728x2304",
        "4:3": "2304x1728",
        "4:5": "1792x2240",
        "5:4": "2240x1792",
        "9:16": "1440x2560",
        "16:9": "2560x1440",
        "21:9": "3024x1296",
    }
    return sizes.get(aspect_ratio, sizes["1:1"])


def _extract_api_error(response) -> str:
    try:
        payload = response.json()
    except ValueError:
        return response.text
    error = payload.get("error")
    if isinstance(error, dict) and error.get("message"):
        return str(error["message"])
    return response.text
