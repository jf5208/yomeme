const SUPPORTED_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp"]);

function isSupportedImage(path) {
  const extension = String(path).split(".").pop().toLowerCase();
  return SUPPORTED_EXTENSIONS.has(extension);
}

function isSquareImage(width, height) {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && width === height;
}

function validatePetCount(count) {
  if (count < 1) return { ok: false, message: "请上传 1 到 3 张自家宠物照片。" };
  if (count > 3) return { ok: false, message: "宠物照片最多上传 3 张。" };
  return { ok: true, message: "" };
}

module.exports = { isSupportedImage, isSquareImage, validatePetCount };
