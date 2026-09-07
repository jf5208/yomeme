const test = require("node:test");
const assert = require("node:assert/strict");

const { buildPrompt } = require("../cloudfunctions/petMemeApi/services/prompt");

test("提示词只替换单只动物并保持正方形和模板细节", () => {
  const prompt = buildPrompt(2, "额头白色花纹更明显");

  assert.match(prompt, /Image 1 is the original single-animal Meme template/);
  assert.match(prompt, /Images 2 through 3 are the sole identity references/);
  assert.match(prompt, /Replace only the single animal subject/);
  assert.match(prompt, /preserve all original visible text exactly/);
  assert.match(prompt, /composition, camera angle, pose, expression, action/);
  assert.match(prompt, /background, lighting direction, shadows/);
  assert.match(prompt, /transparency, blur, compression artifacts/);
  assert.match(prompt, /low-resolution web-image texture/);
  assert.match(prompt, /output a square 1:1 image/);
  assert.match(prompt, /额头白色花纹更明显/);
  assert.doesNotMatch(prompt, /remove visible platform watermarks/i);
});

test("空调整意见不追加再次生成段落", () => {
  const prompt = buildPrompt(1, "   ");

  assert.match(prompt, /Image 2 is the sole identity reference/);
  assert.doesNotMatch(prompt, /User adjustment for this regeneration/);
});

test("提示词保留真实宠物身份和模板动作而不增加其他主体", () => {
  const prompt = buildPrompt(3, "");

  assert.match(prompt, /fur color, fur pattern, face markings, eye color, ear shape, and nose features/);
  assert.match(prompt, /BODY SHAPE, SIZE, POSTURE, POSE, and overall silhouette/);
  assert.match(prompt, /do not add extra animals, people, decorations, captions, logos, stickers, or story elements/);
});
