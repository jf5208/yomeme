const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "miniprogram");
const PAGE_PATH = path.join(ROOT, "pages", "admin", "index.js");

function loadPage(wx) {
  let definition;
  global.wx = wx;
  global.Page = (value) => { definition = value; };
  delete require.cache[require.resolve(PAGE_PATH)];
  require(PAGE_PATH);
  return {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(update) { Object.assign(this.data, update); },
  };
}

test.afterEach(() => {
  delete global.wx;
  delete global.Page;
  delete require.cache[require.resolve(PAGE_PATH)];
});

test("管理员页支持批量发码、一次复制、状态查看和停用", () => {
  const wxml = fs.readFileSync(path.join(ROOT, "pages/admin/index.wxml"), "utf8");
  assert.match(wxml, /1 到 50/);
  assert.match(wxml, /1000/);
  assert.match(wxml, /新生成的充值码只在这里显示一次/);
  assert.match(wxml, /已兑换/);
  assert.match(wxml, /停用/);
  assert.doesNotMatch(wxml, /管理员密码|测试员密码|password/);
});

test("非管理员打开隐藏页面时不展示发码表单", async () => {
  const page = loadPage({
    cloud: {
      async callFunction() {
        return { result: { ok: false, code: "forbidden", message: "无权执行这个操作。" } };
      },
    },
    showToast() {},
  });

  await page.onLoad();

  assert.equal(page.data.authorized, false);
  assert.deepEqual(page.data.codes, []);
});

test("管理员生成后可复制明文码并停用未使用码", async () => {
  const calls = [];
  let copied;
  const codeId = "a".repeat(64);
  const page = loadPage({
    cloud: {
      async callFunction({ data }) {
        calls.push(data);
        if (data.action === "adminListCodes") {
          return { result: { ok: true, data: [] } };
        }
        if (data.action === "adminCreateCodes") {
          return {
            result: {
              ok: true,
              data: [{ code: "new-code", codeId, codeHint: "new-...code", credits: 1000, status: "unused" }],
            },
          };
        }
        return {
          result: {
            ok: true,
            data: { codeId, codeHint: "new-...code", credits: 1000, status: "disabled" },
          },
        };
      },
    },
    setClipboardData({ data, success }) { copied = data; success(); },
    showToast() {},
  });

  await page.onLoad();
  await page.createCodes();
  assert.equal(page.data.newCodes[0].code, "new-code");
  page.copyCode({ currentTarget: { dataset: { code: "new-code" } } });
  await page.disableCode({ currentTarget: { dataset: { id: codeId } } });

  assert.equal(copied, "new-code");
  assert.equal(page.data.newCodes.length, 0);
  assert.equal(page.data.codes[0].status, "disabled");
  assert.deepEqual(calls.map(({ action }) => action), [
    "adminListCodes",
    "adminCreateCodes",
    "adminDisableCode",
  ]);
});

test("管理员验证遇到服务错误时保持关闭表单", async () => {
  const page = loadPage({
    cloud: {
      async callFunction() {
        throw new Error("network unavailable");
      },
    },
    showToast() {},
  });

  await page.onLoad();

  assert.equal(page.data.authorized, false);
});
