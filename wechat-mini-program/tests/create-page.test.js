const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "miniprogram");
const PAGE_PATH = path.join(ROOT, "pages", "create", "index.js");

function readJpegSize(filePath) {
  const bytes = fs.readFileSync(filePath);
  assert.equal(bytes.readUInt16BE(0), 0xffd8, `${filePath} 不是 JPEG`);

  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = bytes[offset + 1];
    if (marker >= 0xc0 && marker <= 0xc3) {
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    }

    offset += 2 + bytes.readUInt16BE(offset + 2);
  }

  throw new Error(`${filePath} 缺少 JPEG 尺寸信息`);
}

function loadPage(wx) {
  let definition;
  global.wx = wx;
  global.Page = (pageDefinition) => {
    definition = pageDefinition;
  };
  delete require.cache[require.resolve(PAGE_PATH)];
  require(PAGE_PATH);

  const page = {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(update) {
      Object.assign(this.data, update);
    },
  };
  return page;
}

function chooseMediaResult(tempFiles) {
  return ({ success }) => success({ tempFiles });
}

test.afterEach(() => {
  delete global.Page;
  delete global.wx;
  delete require.cache[require.resolve(PAGE_PATH)];
});

test("创作页包含两张参考图、1:1 提示和权利确认", () => {
  const wxml = fs.readFileSync(path.join(ROOT, "pages/create/index.wxml"), "utf8");
  assert.match(wxml, /选这种模板，生成效果更稳定/);
  assert.match(wxml, /front-head\.jpg/);
  assert.match(wxml, /half-body\.jpg/);
  assert.match(wxml, /仅支持 1:1 正方形模板/);
  assert.match(wxml, /本人创作、本人拍摄或已获授权/);
  assert.match(wxml, /disabled="{{!template \|\| pets\.length === 0 \|\| !rightsConfirmed \|\| submitting}}"/);
  assert.doesNotMatch(wxml, /Seedream|Gemini|API Key|选择模型/);
  assert.doesNotMatch(wxml, /swiper|下载|点击套用|失败示例/);
});

test("创作页圆角不超过 8px", () => {
  const wxss = fs.readFileSync(path.join(ROOT, "pages/create/index.wxss"), "utf8");
  const radii = [...wxss.matchAll(/border-radius:\s*([^;]+);/g)].map((match) => match[1].trim());

  assert.ok(radii.length > 0);
  assert.equal(radii.every((radius) => /^([0-8](?:\.\d+)?)px$/.test(radius)), true);
});

test("两张原创参考图都是正方形 JPEG", () => {
  for (const filename of ["front-head.jpg", "half-body.jpg"]) {
    const imagePath = path.join(ROOT, "assets", "reference", filename);
    const size = readJpegSize(imagePath);
    assert.equal(size.width, size.height, `${filename} 必须严格为正方形`);
    assert.ok(size.width >= 512, `${filename} 分辨率过低`);
  }
});

test("选择非正方形模板时立即清空并提示不扣积分", async () => {
  const toasts = [];
  const page = loadPage({
    chooseMedia: chooseMediaResult([{ tempFilePath: "/tmp/template.jpg" }]),
    getImageInfo({ success }) {
      success({ width: 1080, height: 1079 });
    },
    showToast(options) {
      toasts.push(options);
    },
  });
  page.data.template = { path: "/tmp/old.jpg", width: 800, height: 800 };

  await page.chooseTemplate();

  assert.equal(page.data.template, null);
  assert.deepEqual(toasts, [
    { title: "请先裁成 1:1，本次不扣积分", icon: "none", duration: 2600 },
  ]);
});

test("宠物照片最多保留三张并可按索引删除", async () => {
  let requestedCount;
  const page = loadPage({
    chooseMedia(options) {
      requestedCount = options.count;
      options.success({
        tempFiles: [
          { tempFilePath: "/tmp/pet-2.jpg" },
          { tempFilePath: "/tmp/pet-3.png" },
          { tempFilePath: "/tmp/pet-4.webp" },
        ],
      });
    },
    showToast() {},
  });
  page.data.pets = [{ path: "/tmp/pet-1.jpg" }];

  await page.choosePets();

  assert.equal(requestedCount, 2);
  assert.deepEqual(page.data.pets.map(({ path: petPath }) => petPath), [
    "/tmp/pet-1.jpg",
    "/tmp/pet-2.jpg",
    "/tmp/pet-3.png",
  ]);

  page.removePet({ currentTarget: { dataset: { index: 1 } } });
  assert.deepEqual(page.data.pets.map(({ path: petPath }) => petPath), [
    "/tmp/pet-1.jpg",
    "/tmp/pet-3.png",
  ]);
});

test("权利确认由复选框的 confirmed 值控制", () => {
  const page = loadPage({});

  page.toggleRights({ detail: { value: ["confirmed"] } });
  assert.equal(page.data.rightsConfirmed, true);

  page.toggleRights({ detail: { value: [] } });
  assert.equal(page.data.rightsConfirmed, false);
});

test("提交先获取服务端任务编号，再按编号上传并进入结果页", async () => {
  const events = [];
  const page = loadPage({
    cloud: {
      callFunction({ data }) {
        events.push({ type: "api", action: data.action, payload: data });
        if (data.action === "prepareGeneration") {
          return Promise.resolve({ result: { ok: true, data: { jobId: "server-job-123456" } } });
        }
        return Promise.resolve({ result: { ok: true, data: { status: "queued" } } });
      },
      uploadFile({ cloudPath, filePath, success }) {
        events.push({ type: "upload", cloudPath, filePath });
        success({ fileID: `cloud://${cloudPath}` });
      },
    },
    navigateTo({ url }) {
      events.push({ type: "navigate", url });
    },
    showToast() {},
  });
  page.data.template = { path: "/tmp/template.JPG", width: 1080, height: 1080 };
  page.data.pets = [{ path: "/tmp/pet-one.jpg" }, { path: "/tmp/pet-two.webp" }];
  page.data.rightsConfirmed = true;

  await page.submitGeneration();

  assert.deepEqual(events.map(({ type, action }) => action || type), [
    "prepareGeneration",
    "upload",
    "upload",
    "upload",
    "generate",
    "navigate",
  ]);
  assert.deepEqual(events.filter(({ type }) => type === "upload").map(({ cloudPath }) => cloudPath), [
    "uploads/server-job-123456/template.jpg",
    "uploads/server-job-123456/pet-1.jpg",
    "uploads/server-job-123456/pet-2.webp",
  ]);

  const generate = events.find(({ action }) => action === "generate");
  assert.deepEqual(generate.payload, {
    action: "generate",
    jobId: "server-job-123456",
    templateFileId: "cloud://uploads/server-job-123456/template.jpg",
    petFileIds: [
      "cloud://uploads/server-job-123456/pet-1.jpg",
      "cloud://uploads/server-job-123456/pet-2.webp",
    ],
    templateWidth: 1080,
    templateHeight: 1080,
    rightsConfirmed: true,
  });
  assert.equal(events.at(-1).url, "/pages/result/index?jobId=server-job-123456");
  assert.equal(page.data.submitting, false);
});
