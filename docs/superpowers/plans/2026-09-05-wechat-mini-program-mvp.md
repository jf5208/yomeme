# 宠物 Meme 微信小程序 MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改动现有网页和扣子部署的前提下，新增一个原生微信小程序 MVP，提供三次免费体验、Seedream 生图、失败退款、兑换码充值、保存分享和管理员发码。

**Architecture:** 在 `wechat-mini-program` 独立目录中实现原生微信小程序，并通过一个事件型 CloudBase 云函数 `petMemeApi` 访问用户、积分、兑换码、生成任务和云存储。客户端只负责选择图片、1:1 校验、展示与微信原生保存分享；所有身份、积分、管理员权限和 Seedream 调用都由云函数处理。

**Tech Stack:** 微信原生小程序、微信云开发 `wx.cloud`、Node.js 18.15、`wx-server-sdk@3.0.1`、Node 内置测试框架、Seedream 图片生成 API。

**Spec:** `docs/superpowers/specs/2026-09-05-wechat-mini-program-mvp-design.md`

## Global Constraints

- 第一版不接微信支付，不创建支付订单，不显示购买按钮。
- 新微信用户只获得一次 300 积分；每次成功生成或调整再生成消耗 100 积分。
- 生成前预占积分，生成失败自动退款；重复请求不能重复扣费。
- 用户只看到积分，不出现 Seedream、Gemini、API Key 或模型选择。
- 模板必须是严格 1:1，只支持一张单动物模板和 1 到 3 张同一只宠物照片。
- 上传前展示两张原创推荐构图参考图，不提供第三方模板库。
- 现有网页、扣子部署、Python 代码和本地运行数据均不迁移、不覆盖。
- `ARK_API_KEY` 只存在于云函数环境变量，客户端、日志、数据库和仓库都不能包含密钥。
- 所有数据库集合设置为“仅管理端可读写”，小程序必须通过云函数访问。
- 当前工作目录不是 Git 仓库，因此每个任务以自动测试和文件检查作为检查点，不执行提交命令。

## File Structure

- Create `wechat-mini-program/project.config.json`: 微信开发者工具项目配置，使用 `touristappid` 作为本机预览标识。
- Create `wechat-mini-program/miniprogram/app.js`: 初始化 `wx.cloud` 并保存用户积分状态。
- Create `wechat-mini-program/miniprogram/app.json`: 注册创作、结果、积分、说明和管理员页面。
- Create `wechat-mini-program/miniprogram/app.wxss`: 暖白、珊瑚粉与奶油黄的全局样式变量。
- Create `wechat-mini-program/miniprogram/services/api.js`: 唯一的云函数调用封装。
- Create `wechat-mini-program/miniprogram/services/uploads.js`: 云存储上传路径与进度封装。
- Create `wechat-mini-program/miniprogram/utils/image.js`: 图片数量、类型和 1:1 校验纯函数。
- Create `wechat-mini-program/miniprogram/pages/create/*`: 推荐构图、模板与宠物照片上传、权利确认和生成入口。
- Create `wechat-mini-program/miniprogram/pages/result/*`: 结果预览、保存、分享和一次调整再生成。
- Create `wechat-mini-program/miniprogram/pages/credits/*`: 积分余额、兑换码和兑换记录。
- Create `wechat-mini-program/miniprogram/pages/guide/*`: 手机可读的成功率说明。
- Create `wechat-mini-program/miniprogram/pages/admin/*`: 仅管理员可用的发码与停用入口。
- Create `wechat-mini-program/miniprogram/assets/reference/*`: 两张原创构图示意图及来源说明。
- Create `wechat-mini-program/cloudfunctions/petMemeApi/index.js`: 按 `action` 分发云函数请求并从 `getWXContext()` 取得 OpenID。
- Create `wechat-mini-program/cloudfunctions/petMemeApi/config.js`: 固定积分、模型、超时和管理员配置读取。
- Create `wechat-mini-program/cloudfunctions/petMemeApi/domain/credits.js`: 用户初始化、预占、完成、退款和积分流水。
- Create `wechat-mini-program/cloudfunctions/petMemeApi/domain/codes.js`: 兑换码生成、哈希、兑换与停用。
- Create `wechat-mini-program/cloudfunctions/petMemeApi/domain/validation.js`: 服务端输入和文件数量校验。
- Create `wechat-mini-program/cloudfunctions/petMemeApi/services/prompt.js`: 复用现有主体替换约束。
- Create `wechat-mini-program/cloudfunctions/petMemeApi/services/seedream.js`: Seedream 请求、响应解析和错误归一化。
- Create `wechat-mini-program/cloudfunctions/petMemeApi/handlers/bootstrap.js`: 用户初始化与体验积分。
- Create `wechat-mini-program/cloudfunctions/petMemeApi/handlers/generate.js`: 生成编号、首次生成与调整再生成。
- Create `wechat-mini-program/cloudfunctions/petMemeApi/handlers/result.js`: 结果查询与安全分享口令。
- Create `wechat-mini-program/cloudfunctions/petMemeApi/handlers/redeem.js`: 兑换码充值。
- Create `wechat-mini-program/cloudfunctions/petMemeApi/handlers/admin.js`: 管理员发码、列表与停用。
- Create `wechat-mini-program/cloudfunctions/petMemeApi/handlers/recover.js`: 过期预占积分退款。
- Create `wechat-mini-program/cloudfunctions/petMemeApi/package.json`: 固定 `wx-server-sdk@3.0.1`。
- Create `wechat-mini-program/cloudfunctions/petMemeMaintenance/index.js`: 定时清理过期上传原图和生成结果。
- Create `wechat-mini-program/cloudfunctions/petMemeMaintenance/package.json`: 维护函数依赖。
- Create `wechat-mini-program/tests/image-validation.test.js`: 图片类型、比例和数量测试。
- Create `wechat-mini-program/tests/create-page.test.js`: 创作页内容和模型隐藏测试。
- Create `wechat-mini-program/tests/credits.test.js`: 体验积分、预占、完成与退款测试。
- Create `wechat-mini-program/tests/codes.test.js`: 兑换码与管理员权限测试。
- Create `wechat-mini-program/tests/prompt.test.js`: 主体替换提示词测试。
- Create `wechat-mini-program/tests/seedream.test.js`: Seedream 请求和响应测试。
- Create `wechat-mini-program/tests/api-dispatch.test.js`: 云函数身份与动作分发测试。
- Create `wechat-mini-program/tests/generation-flow.test.js`: 生成生命周期和幂等测试。
- Create `wechat-mini-program/tests/user-pages.test.js`: 结果、积分和说明页测试。
- Create `wechat-mini-program/tests/admin-page.test.js`: 管理员页面测试。
- Create `wechat-mini-program/tests/maintenance.test.js`: 上传原图与结果清理测试。
- Create `wechat-mini-program/docs/cloudbase-setup.md`: 面向非技术用户的开发者工具与云环境配置步骤。
- Create `wechat-mini-program/README.md`: 本地验证、目录说明、部署和真机验收。
- Modify `pet-meme-mvp/.gitignore`: 排除小程序本地配置、依赖、密钥和测试产物。

---

### Task 1: 小程序骨架与上传校验

**Files:**
- Create: `wechat-mini-program/project.config.json`
- Create: `wechat-mini-program/miniprogram/app.js`
- Create: `wechat-mini-program/miniprogram/app.json`
- Create: `wechat-mini-program/miniprogram/app.wxss`
- Create: `wechat-mini-program/miniprogram/services/api.js`
- Create: `wechat-mini-program/miniprogram/utils/image.js`
- Create: `wechat-mini-program/package.json`
- Test: `wechat-mini-program/tests/image-validation.test.js`

**Interfaces:**
- Produces: `isSupportedImage(path: string) -> boolean`.
- Produces: `isSquareImage(width: number, height: number) -> boolean`.
- Produces: `validatePetCount(count: number) -> { ok: boolean, message: string }`.
- Produces: `callApi(action: string, payload?: object) -> Promise<object>`.

- [ ] **Step 1: 写图片规则失败测试**

```js
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
```

- [ ] **Step 2: 运行测试并确认因为工具文件不存在而失败**

Run: `cd wechat-mini-program && node --test tests/image-validation.test.js`

Expected: FAIL with `Cannot find module '../miniprogram/utils/image'`.

- [ ] **Step 3: 实现最小图片校验模块**

```js
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
```

- [ ] **Step 4: 建立可被微信开发者工具打开的最小项目**

`project.config.json` 使用 `miniprogramRoot: "miniprogram/"`、`cloudfunctionRoot: "cloudfunctions/"`、`appid: "touristappid"`。`app.json` 注册 `pages/create/index` 为首页，并注册 result、credits、guide、admin 四页。`app.js` 仅执行：

```js
App({
  onLaunch() {
    if (wx.cloud) wx.cloud.init({ traceUser: true });
  },
  globalData: { credits: 0, userReady: false },
});
```

`services/api.js` 固定调用事件型云函数：

```js
async function callApi(action, payload = {}) {
  const response = await wx.cloud.callFunction({
    name: "petMemeApi",
    data: { action, ...payload },
  });
  const result = response.result || {};
  if (!result.ok) throw new Error(result.message || "操作失败，请稍后再试。");
  return result;
}

module.exports = { callApi };
```

- [ ] **Step 5: 运行校验测试和 JSON 语法检查**

Run: `cd wechat-mini-program && npm test`

Expected: all tests PASS.

Run: `cd wechat-mini-program && node -e "JSON.parse(require('fs').readFileSync('project.config.json')); JSON.parse(require('fs').readFileSync('miniprogram/app.json'))"`

Expected: exit code 0.

---

### Task 2: 原创推荐构图与创作页

**Files:**
- Create: `wechat-mini-program/miniprogram/assets/reference/front-head.jpg`
- Create: `wechat-mini-program/miniprogram/assets/reference/half-body.jpg`
- Create: `wechat-mini-program/miniprogram/assets/reference/SOURCES.md`
- Create: `wechat-mini-program/miniprogram/pages/create/index.js`
- Create: `wechat-mini-program/miniprogram/pages/create/index.json`
- Create: `wechat-mini-program/miniprogram/pages/create/index.wxml`
- Create: `wechat-mini-program/miniprogram/pages/create/index.wxss`
- Create: `wechat-mini-program/tests/create-page.test.js`

**Interfaces:**
- Consumes: `isSupportedImage`, `isSquareImage`, `validatePetCount`, `callApi` from Task 1.
- Produces: page methods `chooseTemplate()`, `choosePets()`, `removePet(event)`, `toggleRights(event)`, `submitGeneration()`.
- Produces: navigation payload `{ jobId: string }` for the result page.

- [ ] **Step 1: 写创作页结构测试**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

test("创作页包含两张参考图、1:1 提示和权利确认", () => {
  const wxml = fs.readFileSync("miniprogram/pages/create/index.wxml", "utf8");
  assert.match(wxml, /选这种模板，生成效果更稳定/);
  assert.match(wxml, /front-head\.jpg/);
  assert.match(wxml, /half-body\.jpg/);
  assert.match(wxml, /仅支持 1:1 正方形模板/);
  assert.match(wxml, /本人创作、本人拍摄或已获授权/);
  assert.doesNotMatch(wxml, /Seedream|Gemini|API Key|选择模型/);
});
```

- [ ] **Step 2: 运行测试并确认创作页尚不存在**

Run: `cd wechat-mini-program && node --test tests/create-page.test.js`

Expected: FAIL with `ENOENT` for `pages/create/index.wxml`.

- [ ] **Step 3: 生成并保存两张原创构图示意图**

使用图像生成工具创建同一套原创视觉，不引用任何现成 Meme、平台水印、角色或文字：

```text
Create two separate square reference images for a Chinese pet meme mini program. Image one: one original fluffy domestic cat, front-facing close-up head, clear expressive eyes, simple warm-white background. Image two: one original small dog, front three-quarter half-body pose, playful expression, simple pale coral background. Light cute, clean, not childish, natural phone-photo texture, no text, no logo, no watermark, no recognizable IP character, no recreation of an existing meme.
```

把两张最终采用的正方形 JPG 分别保存为 `front-head.jpg` 与 `half-body.jpg`。`SOURCES.md` 记录生成日期、生成工具和上面的完整提示词。

- [ ] **Step 4: 实现创作页选择与即时拒绝**

`chooseTemplate()` 使用 `wx.chooseMedia({ count: 1, mediaType: ["image"] })`，随后调用 `wx.getImageInfo`。不为 1:1 时清空模板并调用：

```js
wx.showToast({ title: "请先裁成 1:1，本次不扣积分", icon: "none", duration: 2600 });
```

`choosePets()` 限制最多三张；卡片中提供删除按钮。生成按钮的 `disabled` 条件必须同时覆盖：无模板、无宠物照片、未勾选权利确认、正在提交。提交时先调用 `prepareGeneration` 取得服务端生成的 `jobId`，再以该编号上传图片，客户端不自行拼接任务编号。

- [ ] **Step 5: 完成轻可爱布局**

创作页使用暖白页面背景、珊瑚色主按钮、奶油黄积分入口。参考构图为并排两张小图，不添加失败示例、轮播、下载或点击套用。所有圆角不超过 8px，上传区保持稳定高度，避免选择图片后页面跳动。

- [ ] **Step 6: 运行创作页与全量测试**

Run: `cd wechat-mini-program && npm test`

Expected: all tests PASS.

---

### Task 3: 微信身份与积分生命周期

**Files:**
- Create: `wechat-mini-program/cloudfunctions/petMemeApi/config.js`
- Create: `wechat-mini-program/cloudfunctions/petMemeApi/domain/credits.js`
- Create: `wechat-mini-program/cloudfunctions/petMemeApi/domain/validation.js`
- Create: `wechat-mini-program/cloudfunctions/petMemeApi/handlers/bootstrap.js`
- Create: `wechat-mini-program/tests/credits.test.js`

**Interfaces:**
- Produces: `TRIAL_CREDITS = 300`, `GENERATION_COST = 100`, `RESERVATION_TTL_MS = 10 * 60 * 1000`.
- Produces: `createDatabase(cloud) -> Database`, configured with `{ throwOnNotFound: false }`.
- Produces: `ensureUser({ db, openid, now }) -> Promise<UserBalance>`.
- Produces: `reserveGeneration({ db, openid, jobId, templateFileId, petFileIds, adjustment, sourceJobId, now }) -> Promise<{ job: Job, acquired: boolean }>`.
- Produces: `completeGeneration({ db, openid, jobId, resultFileId, now }) -> Promise<Job>`.
- Produces: `refundGeneration({ db, openid, jobId, errorCode, now }) -> Promise<Job>`.
- Produces: `validateGenerationInput(event) -> { fileIds: string[], adjustment: string }`.

- [ ] **Step 1: 写体验积分、扣费、退款和幂等测试**

```js
test("新用户只领取一次 300 积分", async () => {
  const first = await ensureUser({ db, openid: "u1", now });
  const second = await ensureUser({ db, openid: "u1", now });
  assert.equal(first.credits, 300);
  assert.equal(second.credits, 300);
  assert.equal(db.creditEvents.filter((row) => row.eventType === "trial").length, 1);
});

test("同一个 jobId 只预占一次 100 积分", async () => {
  await ensureUser({ db, openid: "u1", now });
  const first = await reserveGeneration(inputFor("job-1"));
  const second = await reserveGeneration(inputFor("job-1"));
  assert.equal(first.job.status, "reserved");
  assert.equal(first.acquired, true);
  assert.equal(second.job.status, "reserved");
  assert.equal(second.acquired, false);
  assert.equal(db.users.u1.credits, 200);
});

test("生成失败只退款一次", async () => {
  await ensureUser({ db, openid: "u1", now });
  await reserveGeneration(inputFor("job-1"));
  await refundGeneration({ db, openid: "u1", jobId: "job-1", errorCode: "provider_failed", now });
  await refundGeneration({ db, openid: "u1", jobId: "job-1", errorCode: "provider_failed", now });
  assert.equal(db.users.u1.credits, 300);
});
```

- [ ] **Step 2: 运行测试并确认积分模块不存在**

Run: `cd wechat-mini-program && node --test tests/credits.test.js`

Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: 实现事务内的积分与任务状态更新**

用户文档固定使用 `_id = openid`，生成任务固定使用 `_id = jobId`。所有余额变化与 `credit_events` 写入必须放在同一 `db.runTransaction()` 中。外部 Seedream 请求绝不能放进数据库事务。

状态转换仅允许：

```js
const ALLOWED_TRANSITIONS = {
  reserved: new Set(["succeeded", "failed"]),
  succeeded: new Set(),
  failed: new Set(),
};
```

重复 `reserve` 返回 `{ job: 已有任务, acquired: false }`；首次预占返回 `{ job: 新任务, acquired: true }`。重复 `complete` 或 `refund` 返回已完成任务，不再次改余额。余额小于 100 时抛出业务错误 `insufficient_credits`。

- [ ] **Step 4: 实现服务端输入校验**

`validateGenerationInput()` 必须验证：`jobId` 为 16 到 64 位字母数字与连字符；`templateFileId` 为非空云文件 ID；`petFileIds` 为 1 到 3 个非空云文件 ID；`templateWidth === templateHeight`；`rightsConfirmed === true`；调整意见最多 300 字。

- [ ] **Step 5: 运行积分测试**

Run: `cd wechat-mini-program && npm test`

Expected: all tests PASS.

---

### Task 4: 兑换码与管理员权限

**Files:**
- Create: `wechat-mini-program/cloudfunctions/petMemeApi/domain/codes.js`
- Create: `wechat-mini-program/cloudfunctions/petMemeApi/handlers/redeem.js`
- Create: `wechat-mini-program/cloudfunctions/petMemeApi/handlers/admin.js`
- Create: `wechat-mini-program/tests/codes.test.js`

**Interfaces:**
- Produces: `createCodes({ db, adminOpenid, count, credits, now, randomBytes }) -> Promise<CreatedCode[]>`.
- Produces: `redeemCode({ db, openid, plaintextCode, now }) -> Promise<UserBalance>`.
- Produces: `listCodes({ db, adminOpenid }) -> Promise<CodeSummary[]>`.
- Produces: `disableCode({ db, adminOpenid, codeId, now }) -> Promise<CodeSummary>`.
- Consumes: `ADMIN_OPENIDS` from cloud function environment, comma-separated.

- [ ] **Step 1: 写一次兑换、重复兑换和非管理员拒绝测试**

```js
test("1000 积分兑换码只能兑换一次", async () => {
  const [created] = await createCodes({ db, adminOpenid: "owner", count: 1, credits: 1000, now, randomBytes });
  const balance = await redeemCode({ db, openid: "u1", plaintextCode: created.code, now });
  assert.equal(balance.credits, 1300);
  await assert.rejects(
    () => redeemCode({ db, openid: "u2", plaintextCode: created.code, now }),
    (error) => error.code === "code_redeemed",
  );
});

test("非管理员不能创建兑换码", async () => {
  await assert.rejects(
    () => createCodes({ db, adminOpenid: "u1", count: 1, credits: 1000, now, randomBytes }),
    (error) => error.code === "forbidden",
  );
});
```

- [ ] **Step 2: 运行测试并确认兑换码模块不存在**

Run: `cd wechat-mini-program && node --test tests/codes.test.js`

Expected: FAIL with `Cannot find module`.

- [ ] **Step 3: 实现兑换码哈希与一次性兑换事务**

兑换码使用 `crypto.randomBytes(12).toString("base64url")` 生成，数据库只保存 `sha256` 哈希和前后四位提示。兑换事务读取固定哈希文档，确认 `status === "unused"` 后同时更新兑换码、用户余额与积分流水。重复云函数调用不能重复充值。

- [ ] **Step 4: 实现管理员身份校验**

`ADMIN_OPENIDS` 解析为非空集合。创建数量限制 1 到 50，积分限制为 100 的正整数倍且不超过 10000。新兑换码明文只在创建响应中出现一次；列表接口只返回提示、积分、状态和兑换时间。

- [ ] **Step 5: 运行兑换码和全量测试**

Run: `cd wechat-mini-program && npm test`

Expected: all tests PASS.

---

### Task 5: Seedream 客户端与主体替换提示词

**Files:**
- Create: `wechat-mini-program/cloudfunctions/petMemeApi/services/prompt.js`
- Create: `wechat-mini-program/cloudfunctions/petMemeApi/services/seedream.js`
- Create: `wechat-mini-program/tests/prompt.test.js`
- Create: `wechat-mini-program/tests/seedream.test.js`

**Interfaces:**
- Produces: `buildPrompt(petCount: number, adjustment: string) -> string`.
- Produces: `generateImage({ apiKey, model, images, adjustment, fetchImpl }) -> Promise<{ bytes: Buffer, mimeType: string }>`.
- Consumes: `images = [{ bytes: Buffer, mimeType: string }]`, with template first and 1 to 3 pet photos following.

- [ ] **Step 1: 写提示词保留约束测试**

```js
test("提示词要求只替换动物并保持正方形", () => {
  const prompt = buildPrompt(2, "额头白色花纹更明显");
  assert.match(prompt, /Replace only the single animal subject/);
  assert.match(prompt, /preserve all original visible text exactly/);
  assert.match(prompt, /output a square 1:1 image/);
  assert.match(prompt, /额头白色花纹更明显/);
  assert.doesNotMatch(prompt, /remove visible platform watermarks/);
});
```

- [ ] **Step 2: 写 Seedream 请求与错误归一化测试**

Mock `fetchImpl`，断言请求发送到 `https://ark.cn-beijing.volces.com/api/v3/images/generations`，固定 `size: "2048x2048"`、`response_format: "b64_json"`、`watermark: false`，并从第一条 `b64_json` 返回 Buffer。400 响应必须转成不包含 API Key 的 `provider_rejected` 业务错误。

- [ ] **Step 3: 运行测试并确认模块不存在**

Run: `cd wechat-mini-program && node --test tests/prompt.test.js tests/seedream.test.js`

Expected: FAIL with `Cannot find module`.

- [ ] **Step 4: 移植现有稳定提示词并固定 1:1 输出**

从 `pet_meme/prompts.py` 移植“保留文字、构图、动作、表情、背景、模糊和网图质感，只替换单个动物主体”的英文约束。移除自动去水印要求，并新增 `output a square 1:1 image`。调整意见为空时不追加调整段落。

- [ ] **Step 5: 实现 Seedream 请求解析**

默认模型读取 `SEEDREAM_MODEL`，缺省值为 `doubao-seedream-4-5-251128`。API Key 读取 `ARK_API_KEY`。请求超时 180 秒；对超时、内容审核、余额不足、模型未开通和未知错误映射为简短中文提示，日志只写业务错误码和云函数 RequestId。

- [ ] **Step 6: 运行模型模块测试**

Run: `cd wechat-mini-program && npm test`

Expected: all tests PASS.

---

### Task 6: 云函数分发与生成任务闭环

**Files:**
- Create: `wechat-mini-program/cloudfunctions/petMemeApi/index.js`
- Create: `wechat-mini-program/cloudfunctions/petMemeApi/handlers/generate.js`
- Create: `wechat-mini-program/cloudfunctions/petMemeApi/handlers/result.js`
- Create: `wechat-mini-program/cloudfunctions/petMemeApi/handlers/recover.js`
- Create: `wechat-mini-program/cloudfunctions/petMemeApi/package.json`
- Create: `wechat-mini-program/tests/api-dispatch.test.js`
- Create: `wechat-mini-program/tests/generation-flow.test.js`

**Interfaces:**
- Consumes all domain and service interfaces from Tasks 3 to 5.
- Produces cloud actions: `bootstrap`, `prepareGeneration`, `generate`, `getResult`, `prepareShare`, `redeem`, `adminCreateCodes`, `adminListCodes`, `adminDisableCode`, `recoverStaleJobs`.
- Produces response envelope `{ ok: true, data }` or `{ ok: false, code, message }`.

- [ ] **Step 1: 写身份不可伪造和 action 白名单测试**

```js
test("使用 getWXContext 的 OPENID 而不是 event.openid", async () => {
  const result = await dispatch({ action: "bootstrap", openid: "attacker" }, depsWithOpenid("real-user"));
  assert.equal(result.ok, true);
  assert.equal(deps.lastBootstrapOpenid, "real-user");
});

test("未知 action 被拒绝", async () => {
  const result = await dispatch({ action: "dropDatabase" }, depsWithOpenid("u1"));
  assert.deepEqual(result, { ok: false, code: "unknown_action", message: "暂不支持这个操作。" });
});
```

- [ ] **Step 2: 写生成成功、失败退款和重复请求测试**

成功路径断言余额从 300 变为 200、任务为 `succeeded`、结果文件被保存。失败路径断言余额回到 300、任务为 `failed`。相同 `jobId` 再次调用时不重复请求 Seedream，也不重复扣积分。

- [ ] **Step 3: 运行测试并确认云函数入口尚不存在**

Run: `cd wechat-mini-program && node --test tests/api-dispatch.test.js tests/generation-flow.test.js`

Expected: FAIL with `Cannot find module`.

- [ ] **Step 4: 实现生成顺序**

`prepareGeneration` 使用 `crypto.randomUUID()` 产生 `jobId` 并返回给当前用户，不预占积分。`generate` 严格按以下顺序执行：服务端校验、积分预占；若 `acquired === false`，直接返回已有任务，不执行任何外部工作；只有 `acquired === true` 才继续下载模板与宠物照片、调用 Seedream、上传 `results/{openid}/{jobId}.png`、完成任务。任何下载、模型或上传异常都调用 `refundGeneration()`，然后返回“生成失败，本次未扣积分”。

- [ ] **Step 5: 实现超时恢复**

`recoverStaleJobs` 只允许管理员调用。扫描十分钟前仍为 `reserved` 的任务，逐个调用幂等退款。`bootstrap` 只检查当前用户的过期任务并退款，不扫描全库。

- [ ] **Step 6: 实现只读分享口令**

结果默认只允许任务所属 OpenID 查询。`prepareShare` 仅允许任务所属用户调用，使用 `crypto.randomBytes(18)` 生成分享口令，数据库只保存口令哈希；明文返回给结果页用于分享路径。`getResult` 对所属用户不要求口令，对其他用户必须同时提供正确的 `jobId` 和分享口令，并且只返回结果图片临时地址、生成时间和只读标记，绝不返回模板或宠物照片文件 ID。

- [ ] **Step 7: 实现响应脱敏**

`index.js` 捕获业务错误后只返回白名单中文提示。未知异常记录 `requestId`、action 和错误码，不记录 `event` 全量内容、文件内容、兑换码明文或环境变量。

- [ ] **Step 8: 运行云函数与全量测试**

Run: `cd wechat-mini-program && npm test`

Expected: all tests PASS.

---

### Task 7: 云存储上传、结果页、积分页与说明页

**Files:**
- Create: `wechat-mini-program/miniprogram/services/uploads.js`
- Create: `wechat-mini-program/miniprogram/pages/result/index.js`
- Create: `wechat-mini-program/miniprogram/pages/result/index.json`
- Create: `wechat-mini-program/miniprogram/pages/result/index.wxml`
- Create: `wechat-mini-program/miniprogram/pages/result/index.wxss`
- Create: `wechat-mini-program/miniprogram/pages/credits/index.js`
- Create: `wechat-mini-program/miniprogram/pages/credits/index.json`
- Create: `wechat-mini-program/miniprogram/pages/credits/index.wxml`
- Create: `wechat-mini-program/miniprogram/pages/credits/index.wxss`
- Create: `wechat-mini-program/miniprogram/pages/guide/index.js`
- Create: `wechat-mini-program/miniprogram/pages/guide/index.json`
- Create: `wechat-mini-program/miniprogram/pages/guide/index.wxml`
- Create: `wechat-mini-program/miniprogram/pages/guide/index.wxss`
- Create: `wechat-mini-program/tests/user-pages.test.js`

**Interfaces:**
- Produces: `uploadGenerationFiles({ jobId, templatePath, petPaths }) -> Promise<{ templateFileId, petFileIds }>`.
- Consumes cloud actions `prepareGeneration`, `generate`, `getResult`, `prepareShare`, `redeem`, `bootstrap`.
- Result page consumes query `jobId` and optional `shareToken` and exposes `saveImage()`, `submitAdjustment()`, `onShareAppMessage()`.

- [ ] **Step 1: 写页面文案与模型隐藏测试**

读取 result、credits、guide 三页 WXML，断言包含“再次生成将消耗 100 积分”“兑换充值码”“生成失败，本次未扣积分”和“单只动物大头”；断言所有用户页面不包含 `Seedream`、`Gemini`、`API Key`、`微信支付` 或“购买套餐”。

- [ ] **Step 2: 运行测试并确认页面不存在**

Run: `cd wechat-mini-program && node --test tests/user-pages.test.js`

Expected: FAIL with `ENOENT`.

- [ ] **Step 3: 实现有进度的云存储上传**

创作页先调用 `prepareGeneration` 取得服务端 `jobId`。模板路径使用 `uploads/{jobId}/template.{ext}`，宠物图使用 `uploads/{jobId}/pet-{index}.{ext}`。每个 `wx.cloud.uploadFile()` 的上传任务监听 `onProgressUpdate`，创作页显示总体上传百分比。上传任何一张失败时不调用 `generate`。

- [ ] **Step 4: 实现结果保存与分享**

结果页通过 `getResult` 取得由云函数签发的短期地址，保存时先 `wx.downloadFile`，再调用 `wx.saveImageToPhotosAlbum`。首次拒绝相册权限时显示引导，但不自动打开设置。所属用户加载结果后调用一次 `prepareShare` 并将明文口令只保存在页面内存；分享按钮在口令准备好后才可用。`onShareAppMessage()` 返回结果页路径 `pages/result/index?jobId=...&shareToken=...`，并使用生成图临时地址作为分享卡片封面。分享访问者只获得只读结果，不显示调整输入框，也不能看到原始模板或宠物文件 ID。

- [ ] **Step 5: 实现一次调整再生成**

结果页只在首次结果成功后显示调整输入框，最多 300 字。按钮旁明确标注消耗 100 积分。新请求生成新的 `jobId`，并携带 `sourceJobId`，后端读取原任务的模板与宠物文件 ID；生成成功后替换当前结果，失败保留旧结果。

- [ ] **Step 6: 实现积分兑换与说明页**

积分页输入兑换码后调用 `redeem`，成功立即刷新余额和兑换记录。页面不出现价格与购买按钮。说明页压缩现有 `docs/user-guide.md` 内容，保留模板、宠物照片、调整意见、积分退款和素材授权五部分。

- [ ] **Step 7: 运行用户页面和全量测试**

Run: `cd wechat-mini-program && npm test`

Expected: all tests PASS.

---

### Task 8: 管理员页面、部署说明与最终验收

**Files:**
- Create: `wechat-mini-program/miniprogram/pages/admin/index.js`
- Create: `wechat-mini-program/miniprogram/pages/admin/index.json`
- Create: `wechat-mini-program/miniprogram/pages/admin/index.wxml`
- Create: `wechat-mini-program/miniprogram/pages/admin/index.wxss`
- Create: `wechat-mini-program/cloudfunctions/petMemeMaintenance/index.js`
- Create: `wechat-mini-program/cloudfunctions/petMemeMaintenance/package.json`
- Create: `wechat-mini-program/docs/cloudbase-setup.md`
- Create: `wechat-mini-program/README.md`
- Create: `wechat-mini-program/tests/admin-page.test.js`
- Create: `wechat-mini-program/tests/maintenance.test.js`
- Modify: `pet-meme-mvp/.gitignore`

**Interfaces:**
- Consumes cloud actions `adminCreateCodes`, `adminListCodes`, `adminDisableCode`.
- Produces page methods `createCodes()`, `copyCode(event)`, `disableCode(event)`.

- [ ] **Step 1: 写管理员页面安全文案测试**

断言管理员页面支持 1 到 50 个批量发码、默认 1000 积分、新码一次复制、已兑换状态和停用；断言页面不要求或保存管理员密码。云函数测试必须覆盖非管理员 OpenID 收到 `forbidden`。

- [ ] **Step 2: 运行测试并确认管理员页面不存在**

Run: `cd wechat-mini-program && node --test tests/admin-page.test.js`

Expected: FAIL with `ENOENT`.

- [ ] **Step 3: 实现隐藏管理员入口**

普通导航和使用说明中不显示管理员入口。管理员通过直接打开 `pages/admin/index` 访问；页面加载时先调用 `adminListCodes`，收到 `forbidden` 后显示“此页面仅限管理员使用”且不展示表单。

- [ ] **Step 4: 更新仓库忽略规则**

追加以下规则，不删除现有规则：

```gitignore
wechat-mini-program/project.private.config.json
wechat-mini-program/**/node_modules/
wechat-mini-program/**/*.log
wechat-mini-program/.env*
wechat-mini-program/miniprogram/uploads/
wechat-mini-program/miniprogram/temp/
```

- [ ] **Step 5: 写非技术部署说明**

`cloudbase-setup.md` 按界面操作顺序说明：微信开发者工具导入项目、替换真实 AppID、开通云开发环境、创建四个集合、全部设置“仅管理端可读写”、部署 `petMemeApi`、将超时设置为 300 秒、配置 `ARK_API_KEY`、`SEEDREAM_MODEL` 和 `ADMIN_OPENIDS`、上传云函数、预览与真机调试。明确不要把密钥粘进小程序代码或截图。

- [ ] **Step 6: 实现每日隐私清理函数**

`petMemeMaintenance` 使用服务端 SDK 查询已完成任务：删除创建超过 7 天的模板与宠物原图并清空对应文件 ID；删除创建超过 30 天的生成结果并把任务标记为 `expired`。删除必须幂等，单次最多处理 100 个任务。`maintenance.test.js` 覆盖 6 天不删除、8 天只删原图、31 天删除全部文件、重复运行不报错。部署说明要求为该函数配置每天凌晨执行一次的定时触发器。

- [ ] **Step 7: 完成静态安全检查**

Run: `cd wechat-mini-program && rg -n "ARK_API_KEY=|ark-[A-Za-z0-9_-]{12,}|ADMIN_OPENIDS=" miniprogram tests README.md docs || true`

Expected: no secrets or example secret values in client-visible files.

Run: `cd wechat-mini-program && rg -n "Seedream|Gemini|API Key|微信支付|购买套餐" miniprogram/pages miniprogram/components 2>/dev/null || true`

Expected: no output from user-facing pages. The hidden admin page may mention neither provider nor payment.

- [ ] **Step 8: 运行完整自动测试**

Run: `cd wechat-mini-program && npm test`

Expected: all Node tests PASS.

Run: `cd .. && python3 -m pytest tests -q && python3 -m compileall -q pet_meme`

Expected: existing web app tests remain PASS and Python compilation exits 0.

- [ ] **Step 9: 使用微信开发者工具进行人工验收**

依次验证：新用户 300 积分；两张推荐图；非正方形即时拒绝；1 到 3 张宠物图；权利确认；成功生成扣 100；失败退款；重复点击只扣一次；再次生成提示并扣 100；保存相册；分享卡片；1000 积分兑换码只兑换一次；非管理员无法打开发码功能；iPhone 常见窄屏无文字或按钮重叠。
