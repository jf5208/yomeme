const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "miniprogram");
const BANNED_COPY = /Seedream|Gemini|API Key|微信支付|购买套餐|选择模型/;

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function loadPage(relativePath, wx, app = { globalData: {} }) {
  const pagePath = path.join(ROOT, relativePath);
  let definition;
  global.wx = wx;
  global.getApp = () => app;
  global.Page = (value) => { definition = value; };
  delete require.cache[require.resolve(pagePath)];
  require(pagePath);
  return {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(update) {
      Object.assign(this.data, update);
    },
  };
}

test.afterEach(() => {
  delete global.wx;
  delete global.getApp;
  delete global.Page;
});

test("结果、积分和说明页文案完整且不暴露模型或支付", () => {
  const result = read("pages/result/index.wxml");
  const credits = read("pages/credits/index.wxml");
  const guide = read("pages/guide/index.wxml");
  const all = `${result}\n${credits}\n${guide}`;

  assert.match(result, /再次生成将消耗 100 积分/);
  assert.match(credits, /兑换充值码/);
  assert.match(guide, /生成失败，本次未扣积分/);
  assert.match(guide, /单只动物大头/);
  assert.match(guide, /同一只宠物/);
  assert.match(guide, /素材授权/);
  assert.doesNotMatch(all, BANNED_COPY);
});

test("上传服务使用固定目录并汇总每张图片进度", async () => {
  const uploadsPath = path.join(ROOT, "services", "uploads.js");
  const tasks = [];
  global.wx = {
    cloud: {
      uploadFile({ cloudPath, filePath, success }) {
        const task = {
          cloudPath,
          filePath,
          success,
          onProgressUpdate(callback) { this.progress = callback; },
        };
        tasks.push(task);
        return task;
      },
    },
  };
  delete require.cache[require.resolve(uploadsPath)];
  const { uploadGenerationFiles } = require(uploadsPath);
  const progress = [];
  const pending = uploadGenerationFiles({
    jobId: "job-123456789012",
    templatePath: "/tmp/template.JPEG",
    petPaths: ["/tmp/pet-one.png", "/tmp/pet-two.webp"],
    onProgress: (value) => progress.push(value),
  });

  assert.deepEqual(tasks.map(({ cloudPath }) => cloudPath), [
    "uploads/job-123456789012/template.jpg",
    "uploads/job-123456789012/pet-1.png",
    "uploads/job-123456789012/pet-2.webp",
  ]);
  tasks[0].progress({ progress: 60 });
  tasks[1].progress({ progress: 30 });
  tasks[2].progress({ progress: 0 });
  tasks.forEach((task) => task.success({ fileID: `cloud://${task.cloudPath}` }));

  const result = await pending;
  assert.deepEqual(result, {
    templateFileId: "cloud://uploads/job-123456789012/template.jpg",
    petFileIds: [
      "cloud://uploads/job-123456789012/pet-1.png",
      "cloud://uploads/job-123456789012/pet-2.webp",
    ],
  });
  assert.equal(progress.at(-1), 100);
});

test("结果页所有者加载成功图后准备分享口令", async () => {
  const calls = [];
  const page = loadPage("pages/result/index.js", {
    cloud: {
      async callFunction({ data }) {
        calls.push(data);
        if (data.action === "getResult") {
          return {
            result: {
              ok: true,
              data: {
                jobId: data.jobId,
                status: "succeeded",
                imageUrl: "https://temp.example/result.png",
                generatedAt: "2026-09-05T08:20:00.000Z",
                readOnly: false,
                canAdjust: true,
              },
            },
          };
        }
        return { result: { ok: true, data: { token: "share-token" } } };
      },
    },
    showToast() {},
  });

  await page.onLoad({ jobId: "job-123456789012" });

  assert.equal(page.data.status, "succeeded");
  assert.equal(page.data.shareToken, "share-token");
  assert.equal(page.data.readOnly, false);
  assert.equal(page.data.canAdjust, true);
  assert.deepEqual(calls.map(({ action }) => action), ["getResult", "prepareShare"]);
  assert.equal(
    page.onShareAppMessage().path,
    "/pages/result/index?jobId=job-123456789012&shareToken=share-token",
  );
});

test("分享访问者保持只读且不会申请新的分享口令", async () => {
  const calls = [];
  const page = loadPage("pages/result/index.js", {
    cloud: {
      async callFunction({ data }) {
        calls.push(data);
        return {
          result: {
            ok: true,
            data: {
              jobId: data.jobId,
              status: "succeeded",
              imageUrl: "https://temp.example/result.png",
              generatedAt: "2026-09-05T08:20:00.000Z",
              readOnly: true,
            },
          },
        };
      },
    },
    showToast() {},
  });

  await page.onLoad({ jobId: "job-123456789012", shareToken: "incoming-token" });

  assert.equal(page.data.readOnly, true);
  assert.equal(page.data.shareToken, "");
  assert.deepEqual(calls, [{
    action: "getResult",
    jobId: "job-123456789012",
    token: "incoming-token",
  }]);
});

test("结果页调整会创建新任务并沿用原素材", async () => {
  const calls = [];
  let navigation;
  const page = loadPage("pages/result/index.js", {
    cloud: {
      async callFunction({ data }) {
        calls.push(data);
        if (data.action === "prepareGeneration") {
          return { result: { ok: true, data: { jobId: "adjust-job-123456" } } };
        }
        return { result: { ok: true, data: { status: "succeeded" } } };
      },
    },
    navigateTo({ url }) { navigation = url; },
    showToast() {},
  });
  page.data.jobId = "source-job-123456";
  page.data.status = "succeeded";
  page.data.readOnly = false;
  page.data.canAdjust = true;
  page.data.adjustment = "耳朵更像我家猫";

  await page.submitAdjustment();

  assert.deepEqual(calls, [
    { action: "prepareGeneration" },
    {
      action: "generate",
      jobId: "adjust-job-123456",
      sourceJobId: "source-job-123456",
      adjustment: "耳朵更像我家猫",
      rightsConfirmed: true,
    },
  ]);
  assert.equal(navigation, "/pages/result/index?jobId=adjust-job-123456");
});

test("积分页兑换成功后立即显示新余额并清空输入", async () => {
  const app = { globalData: { credits: 300 } };
  const page = loadPage("pages/credits/index.js", {
    cloud: {
      async callFunction({ data }) {
        assert.deepEqual(data, { action: "redeem", code: "ABCD-1234" });
        return { result: { ok: true, data: { credits: 1300 } } };
      },
    },
    showToast() {},
  }, app);
  page.data.credits = 300;
  page.data.code = "  ABCD-1234  ";

  await page.redeem();

  assert.equal(page.data.credits, 1300);
  assert.equal(page.data.code, "");
  assert.equal(app.globalData.credits, 1300);
  assert.equal(page.data.redeemedCredits, 1000);
});
