const test = require("node:test");
const assert = require("node:assert/strict");

const { dispatch, ACTIONS } = require("../cloudfunctions/petMemeApi/index");

function dependencies(overrides = {}) {
  const calls = [];
  return {
    calls,
    getWXContext: () => ({ OPENID: "real-user" }),
    handlers: {
      bootstrap: async (input) => {
        calls.push(input);
        return { credits: 300 };
      },
      prepareGeneration: async () => ({ jobId: "job-from-server-1234" }),
      generate: async () => ({ jobId: "job-from-server-1234", status: "succeeded" }),
      getResult: async () => ({ jobId: "job-from-server-1234", status: "succeeded" }),
      prepareShare: async () => ({ token: "plain-token" }),
      redeem: async () => ({ credits: 1300 }),
      adminCreateCodes: async () => [],
      adminListCodes: async () => [],
      adminDisableCode: async () => ({ status: "disabled" }),
      recoverStaleJobs: async () => ({ recovered: 0 }),
    },
    logger: { error(...args) { calls.push(args); } },
    requestId: "request-safe-1",
    ...overrides,
  };
}

test("dispatch 只使用微信上下文 OPENID", async () => {
  const deps = dependencies();
  deps.getWXContext = () => ({ OPENID: "real-user", ENV: "env-current" });

  const result = await dispatch(
    {
      action: "bootstrap",
      openid: "attacker",
      environmentId: "env-attacker",
      ENV: "env-attacker",
      code: "SECRET-CODE",
    },
    deps,
  );

  assert.deepEqual(result, { ok: true, data: { credits: 300 } });
  assert.equal(deps.calls[0].openid, "real-user");
  assert.equal(deps.calls[0].environmentId, "env-current");
  assert.equal(deps.calls[0].event.openid, undefined);
  assert.equal(deps.calls[0].event.environmentId, undefined);
  assert.equal(deps.calls[0].event.ENV, undefined);
});

test("action 是固定白名单且未知 action 被拒绝", async () => {
  assert.deepEqual(Object.keys(ACTIONS).sort(), [
    "adminCreateCodes",
    "adminDisableCode",
    "adminListCodes",
    "bootstrap",
    "generate",
    "getResult",
    "prepareGeneration",
    "prepareShare",
    "recoverStaleJobs",
    "redeem",
  ]);

  const result = await dispatch({ action: "dropDatabase" }, dependencies());

  assert.deepEqual(result, {
    ok: false,
    code: "unknown_action",
    message: "暂不支持这个操作。",
  });
});

test("已知业务错误返回白名单中文提示", async () => {
  const error = Object.assign(new Error("数据库原始信息"), { code: "insufficient_credits" });
  const deps = dependencies({
    handlers: {
      ...dependencies().handlers,
      generate: async () => { throw error; },
    },
  });

  const result = await dispatch({ action: "generate", jobId: "job-123456789012" }, deps);

  assert.deepEqual(result, {
    ok: false,
    code: "insufficient_credits",
    message: "积分不足，请先兑换积分。",
  });
});

test("未知错误只记录安全字段且响应不泄露事件或密钥", async () => {
  const logCalls = [];
  const deps = dependencies({
    handlers: {
      ...dependencies().handlers,
      redeem: async () => { throw new Error("ARK_API_KEY=secret-value code=PLAINTEXT"); },
    },
    logger: { error(...args) { logCalls.push(args); } },
  });
  const event = {
    action: "redeem",
    code: "PLAINTEXT",
    templateFileId: "cloud://env/uploads/private.jpg",
  };

  const result = await dispatch(event, deps);

  assert.deepEqual(result, {
    ok: false,
    code: "internal_error",
    message: "服务暂时不可用，请稍后重试。",
  });
  assert.deepEqual(logCalls, [["petMemeApi error", {
    requestId: "request-safe-1",
    action: "redeem",
    code: "internal_error",
  }]]);
  assert.equal(JSON.stringify({ result, logCalls }).includes("PLAINTEXT"), false);
  assert.equal(JSON.stringify({ result, logCalls }).includes("secret-value"), false);
  assert.equal(JSON.stringify({ result, logCalls }).includes("private.jpg"), false);
});

test("微信身份上下文异常也由统一脱敏边界处理", async () => {
  const logCalls = [];
  const deps = dependencies({
    getWXContext() {
      throw new Error("OPENID lookup leaked secret");
    },
    logger: { error(...args) { logCalls.push(args); } },
  });

  const result = await dispatch({ action: "bootstrap" }, deps);

  assert.deepEqual(result, {
    ok: false,
    code: "internal_error",
    message: "服务暂时不可用，请稍后重试。",
  });
  assert.deepEqual(logCalls, [["petMemeApi error", {
    requestId: "request-safe-1",
    action: "bootstrap",
    code: "internal_error",
  }]]);
  assert.equal(JSON.stringify({ result, logCalls }).includes("secret"), false);
});
