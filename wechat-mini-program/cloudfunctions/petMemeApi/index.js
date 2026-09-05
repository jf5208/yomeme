const { createDatabase } = require("./config");
const { bootstrap } = require("./handlers/bootstrap");
const { prepareGeneration, generate } = require("./handlers/generate");
const { getResult, prepareShare } = require("./handlers/result");
const { redeem } = require("./handlers/redeem");
const {
  adminCreateCodes,
  adminListCodes,
  adminDisableCode,
} = require("./handlers/admin");
const { recoverStaleJobs } = require("./handlers/recover");

const BUSINESS_MESSAGES = {
  admin_not_configured: "管理员身份尚未配置。",
  adjustment_in_progress: "这个结果正在调整中。",
  adjustment_limit_reached: "这个结果已经调整过一次了。",
  code_collision: "兑换码生成冲突，请重试。",
  code_disabled: "这个兑换码已停用。",
  code_not_found: "兑换码不存在。",
  code_redeemed: "这个兑换码已经使用过了。",
  forbidden: "无权执行这个操作。",
  generation_failed: "生成失败，本次未扣积分。",
  insufficient_credits: "积分不足，请先兑换积分。",
  invalid_code: "兑换码无效。",
  invalid_identity: "无法识别当前微信用户。",
  invalid_environment: "无法识别当前云环境。",
  invalid_input: "提交内容有误，请检查后重试。",
  invalid_job_status: "生成任务状态无效。",
  invalid_source_job: "原生成任务尚未成功。",
  job_conflict: "生成任务编号已被使用。",
  job_not_found: "生成任务不存在。",
  preparation_expired: "生成任务已过期，请重新开始。",
  preparation_required: "请重新开始生成任务。",
  recovery_stalled: "过期任务恢复暂未完成，请稍后重试。",
  result_not_ready: "生成结果尚未完成。",
  result_unavailable: "生成结果暂时无法读取。",
  user_not_found: "用户不存在。",
};

const ACTIONS = Object.freeze({
  bootstrap: ({ db, openid, now }) => bootstrap({ db, openid, now }),
  prepareGeneration: ({ db, openid, environmentId, now, randomUUID }) => prepareGeneration({
    db,
    openid,
    environmentId,
    now,
    randomUUID,
  }),
  generate: ({ db, cloud, openid, environmentId, event, now, generateImage }) => generate({
    db,
    cloud,
    openid,
    environmentId,
    event,
    now,
    generateImage,
  }),
  getResult: ({ db, cloud, openid, event }) => getResult({
    db,
    cloud,
    openid,
    jobId: event.jobId,
    token: event.token,
  }),
  prepareShare: ({ db, openid, event, now, randomBytes }) => prepareShare({
    db,
    openid,
    jobId: event.jobId,
    now,
    randomBytes,
  }),
  redeem: ({ db, openid, event, now }) => redeem({
    db,
    openid,
    code: event.code,
    now,
  }),
  adminCreateCodes: ({ db, openid, event, now, randomBytes }) => adminCreateCodes({
    db,
    openid,
    count: event.count,
    credits: event.credits,
    now,
    randomBytes,
  }),
  adminListCodes: ({ db, openid }) => adminListCodes({ db, openid }),
  adminDisableCode: ({ db, openid, event, now }) => adminDisableCode({
    db,
    openid,
    codeId: event.codeId,
    now,
  }),
  recoverStaleJobs: ({ db, openid, now }) => recoverStaleJobs({ db, openid, now }),
});

function sanitizedEvent(event) {
  const {
    openid,
    OPENID,
    _openid,
    environmentId,
    environment,
    ENV,
    ...safeEvent
  } = event || {};
  return safeEvent;
}

function wxContext(deps) {
  if (typeof deps.getWXContext === "function") return deps.getWXContext();
  if (deps.cloud && typeof deps.cloud.getWXContext === "function") {
    return deps.cloud.getWXContext();
  }
  return {};
}

async function dispatch(event = {}, deps = {}) {
  const action = typeof event.action === "string" ? event.action : "";
  if (!Object.hasOwn(ACTIONS, action)) {
    return { ok: false, code: "unknown_action", message: "暂不支持这个操作。" };
  }

  try {
    const context = wxContext(deps);
    const openid = context.OPENID;
    const environmentId = context.ENV || context.environmentId;
    const handler = deps.handlers && deps.handlers[action]
      ? deps.handlers[action]
      : ACTIONS[action];
    const data = await handler({
      ...deps,
      openid,
      environmentId,
      event: sanitizedEvent(event),
    });
    return { ok: true, data };
  } catch (error) {
    if (error && Object.hasOwn(BUSINESS_MESSAGES, error.code)) {
      return {
        ok: false,
        code: error.code,
        message: BUSINESS_MESSAGES[error.code],
      };
    }
    const logger = deps.logger || console;
    logger.error("petMemeApi error", {
      requestId: deps.requestId || "unknown",
      action,
      code: "internal_error",
    });
    return {
      ok: false,
      code: "internal_error",
      message: "服务暂时不可用，请稍后重试。",
    };
  }
}

async function main(event, context = {}) {
  const cloud = require("wx-server-sdk");
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
  const db = createDatabase(cloud);
  return dispatch(event, {
    cloud,
    db,
    getWXContext: () => cloud.getWXContext(),
    requestId: context.requestId || context.request_id || "unknown",
    now: new Date(),
  });
}

module.exports = { ACTIONS, dispatch, main };
