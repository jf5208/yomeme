const crypto = require("node:crypto");
const { TRIAL_CREDITS } = require("../config");

const CODE_LIST_PAGE_SIZE = 100;

function businessError(code, message) {
  return Object.assign(new Error(message), { code });
}

function timestamp(now) {
  const value = now === undefined ? new Date() : new Date(now);
  if (Number.isNaN(value.getTime())) {
    throw new TypeError("now must be a valid date");
  }
  return value;
}

function withoutId(document) {
  const { _id, ...data } = document;
  return data;
}

async function getDocument(transaction, collectionName, id) {
  const result = await transaction.collection(collectionName).doc(id).get();
  return result.data || null;
}

async function setDocument(transaction, collectionName, document) {
  await transaction.collection(collectionName).doc(document._id).set({
    data: withoutId(document),
  });
}

function hashCode(plaintextCode) {
  return crypto.createHash("sha256").update(plaintextCode).digest("hex");
}

function eventId(eventType, referenceId) {
  return crypto
    .createHash("sha256")
    .update(`${eventType}:${referenceId}`)
    .digest("hex")
    .slice(0, 32);
}

async function addCreditEvent(transaction, event) {
  await setDocument(transaction, "credit_events", {
    _id: eventId(event.eventType, event.referenceId),
    ...event,
  });
}

function parseAdminOpenids(value = process.env.ADMIN_OPENIDS) {
  const openids = typeof value === "string"
    ? value.split(",").map((openid) => openid.trim()).filter(Boolean)
    : [];
  if (openids.length === 0) {
    throw businessError("admin_not_configured", "管理员身份尚未配置。");
  }
  return new Set(openids);
}

function requireAdmin(adminOpenid) {
  const adminOpenids = parseAdminOpenids();
  if (!adminOpenids.has(adminOpenid)) {
    throw businessError("forbidden", "无权执行管理员操作。");
  }
}

function requireOpenid(openid) {
  if (typeof openid !== "string" || openid.length === 0) {
    throw businessError("invalid_identity", "无法识别当前微信用户。");
  }
}

function validateCreateInput(count, credits) {
  if (!Number.isInteger(count) || count < 1 || count > 50) {
    throw businessError("invalid_input", "每次只能创建 1 到 50 个兑换码。");
  }
  if (!Number.isInteger(credits) || credits < 100 || credits > 10000 || credits % 100 !== 0) {
    throw businessError("invalid_input", "积分必须是 100 到 10000 之间的 100 整数倍。");
  }
}

function codeSummary(document) {
  return {
    codeId: document._id,
    codeHint: document.codeHint,
    credits: document.credits,
    status: document.status,
    redeemedAt: document.redeemedAt || null,
  };
}

async function createCodes({
  db,
  adminOpenid,
  count,
  credits,
  now,
  randomBytes = crypto.randomBytes,
}) {
  requireAdmin(adminOpenid);
  validateCreateInput(count, credits);
  const createdAt = timestamp(now);
  const generated = [];
  const generatedIds = new Set();

  for (let index = 0; index < count; index += 1) {
    const code = randomBytes(12).toString("base64url");
    const codeId = hashCode(code);
    if (generatedIds.has(codeId)) {
      throw businessError("code_collision", "兑换码生成冲突，请重试。");
    }
    generatedIds.add(codeId);
    generated.push({
      code,
      codeId,
      codeHint: `${code.slice(0, 4)}...${code.slice(-4)}`,
    });
  }

  await db.runTransaction(async (transaction) => {
    for (const item of generated) {
      const existing = await getDocument(transaction, "redemption_codes", item.codeId);
      if (existing) {
        throw businessError("code_collision", "兑换码生成冲突，请重试。");
      }
      await setDocument(transaction, "redemption_codes", {
        _id: item.codeId,
        codeHash: item.codeId,
        codeHint: item.codeHint,
        credits,
        status: "unused",
        redeemedBy: null,
        redeemedAt: null,
        createdBy: adminOpenid,
        createdAt,
        disabledAt: null,
      });
    }
  });

  return generated.map((item) => ({
    ...item,
    credits,
    status: "unused",
    createdAt,
  }));
}

async function redeemCode({ db, openid, plaintextCode, now }) {
  requireOpenid(openid);
  const code = typeof plaintextCode === "string" ? plaintextCode.trim() : "";
  if (!code) throw businessError("invalid_code", "兑换码无效。");
  const codeId = hashCode(code);
  const redeemedAt = timestamp(now);

  return db.runTransaction(async (transaction) => {
    const redemptionCode = await getDocument(transaction, "redemption_codes", codeId);
    if (!redemptionCode) throw businessError("invalid_code", "兑换码无效。");
    if (redemptionCode.status === "redeemed") {
      throw businessError("code_redeemed", "这个兑换码已经使用过了。");
    }
    if (redemptionCode.status === "disabled") {
      throw businessError("code_disabled", "这个兑换码已停用。");
    }
    if (redemptionCode.status !== "unused") {
      throw businessError("invalid_code", "兑换码无效。");
    }

    const existingUser = await getDocument(transaction, "users", openid);
    const startingCredits = existingUser ? existingUser.credits : TRIAL_CREDITS;
    const balanceAfter = startingCredits + redemptionCode.credits;

    if (existingUser) {
      await transaction.collection("users").doc(openid).update({
        data: { credits: balanceAfter, updatedAt: redeemedAt },
      });
    } else {
      await setDocument(transaction, "users", {
        _id: openid,
        _openid: openid,
        credits: balanceAfter,
        trialGranted: true,
        createdAt: redeemedAt,
        updatedAt: redeemedAt,
      });
      await addCreditEvent(transaction, {
        _openid: openid,
        eventType: "trial",
        creditDelta: TRIAL_CREDITS,
        balanceAfter: TRIAL_CREDITS,
        referenceId: openid,
        jobId: null,
        createdAt: redeemedAt,
      });
    }

    await transaction.collection("redemption_codes").doc(codeId).update({
      data: {
        status: "redeemed",
        redeemedBy: openid,
        redeemedAt,
      },
    });
    await addCreditEvent(transaction, {
      _openid: openid,
      eventType: "redeem",
      creditDelta: redemptionCode.credits,
      balanceAfter,
      referenceId: codeId,
      codeId,
      jobId: null,
      createdAt: redeemedAt,
    });

    return { credits: balanceAfter };
  });
}

async function listCodes({ db, adminOpenid }) {
  requireAdmin(adminOpenid);
  const documents = [];
  let offset = 0;

  while (true) {
    const result = await db
      .collection("redemption_codes")
      .orderBy("createdAt", "desc")
      .orderBy("_id", "asc")
      .skip(offset)
      .limit(CODE_LIST_PAGE_SIZE)
      .get();
    const page = result.data || [];
    documents.push(...page);
    if (page.length < CODE_LIST_PAGE_SIZE) break;
    offset += page.length;
  }

  return documents.map(codeSummary);
}

async function disableCode({ db, adminOpenid, codeId, now }) {
  requireAdmin(adminOpenid);
  if (typeof codeId !== "string" || !/^[a-f0-9]{64}$/.test(codeId)) {
    throw businessError("code_not_found", "兑换码不存在。");
  }
  const disabledAt = timestamp(now);

  return db.runTransaction(async (transaction) => {
    const redemptionCode = await getDocument(transaction, "redemption_codes", codeId);
    if (!redemptionCode) throw businessError("code_not_found", "兑换码不存在。");
    if (redemptionCode.status === "redeemed") {
      throw businessError("code_redeemed", "已兑换的兑换码不能停用。");
    }
    if (redemptionCode.status === "disabled") return codeSummary(redemptionCode);
    if (redemptionCode.status !== "unused") {
      throw businessError("invalid_code", "兑换码状态无效。");
    }

    const update = { status: "disabled", disabledAt };
    await transaction.collection("redemption_codes").doc(codeId).update({ data: update });
    return codeSummary({ ...redemptionCode, ...update });
  });
}

module.exports = {
  hashCode,
  parseAdminOpenids,
  createCodes,
  redeemCode,
  listCodes,
  disableCode,
};
