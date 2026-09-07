const test = require("node:test");
const assert = require("node:assert/strict");
const { isSupportedImage, isSquareImage, validatePetCount } = require("../miniprogram/utils/image");

test("只接受 png jpg jpeg webp", () => {
  assert.equal(isSupportedImage("cat.JPG"), true);
  assert.equal(isSupportedImage("cat.webp"), true);
  assert.equal(isSupportedImage("cat.gif"), false);
});

test("模板必须严格 1:1", () => {
  assert.equal(isSquareImage(1080, 1080), true);
  assert.equal(isSquareImage(1080, 1079), false);
  assert.equal(isSquareImage(1080, 1920), false);
});

test("宠物照片必须为 1 到 3 张", () => {
  assert.deepEqual(validatePetCount(0), { ok: false, message: "请上传 1 到 3 张自家宠物照片。" });
  assert.deepEqual(validatePetCount(3), { ok: true, message: "" });
  assert.deepEqual(validatePetCount(4), { ok: false, message: "宠物照片最多上传 3 张。" });
});
