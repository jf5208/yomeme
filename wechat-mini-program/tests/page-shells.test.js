const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const appConfig = require("../miniprogram/app.json");

const PAGE_EXTENSIONS = ["js", "json", "wxml", "wxss"];

test("app.json 中每个页面路由都有完整页面文件", () => {
  for (const page of appConfig.pages) {
    for (const extension of PAGE_EXTENSIONS) {
      const relativePath = `${page}.${extension}`;
      const pagePath = path.join(__dirname, "..", "miniprogram", relativePath);
      assert.equal(fs.existsSync(pagePath), true, `缺少页面文件: ${relativePath}`);
    }
  }
});
