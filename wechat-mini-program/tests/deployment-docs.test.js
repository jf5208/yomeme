const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("上线说明覆盖 CloudBase 必需配置且不遗漏临时集合", () => {
  const docs = read("wechat-mini-program/docs/cloudbase-setup.md");
  const required = [
    "users",
    "generation_jobs",
    "generation_preparations",
    "credit_events",
    "redemption_codes",
    "share_grants",
    "Node.js 20.19",
    "300 秒",
    "ARK_API_KEY",
    "SEEDREAM_MODEL",
    "ADMIN_OPENIDS",
    "resource.openid == auth.openid",
    "每天",
    "300 秒",
    '"petMemeMaintenance"',
    '"invoke": false',
    "生命周期",
    "上线必做",
    "uploads/",
  ];

  for (const value of required) assert.match(docs, new RegExp(value));
});

test("仓库忽略本地开发配置、依赖、密钥和临时上传", () => {
  const gitignore = read(".gitignore");
  const required = [
    "wechat-mini-program/project.private.config.json",
    "wechat-mini-program/**/node_modules/",
    "wechat-mini-program/.env*",
    "wechat-mini-program/miniprogram/uploads/",
    "wechat-mini-program/miniprogram/temp/",
  ];

  for (const value of required) assert.ok(gitignore.includes(value), `missing ${value}`);
});
