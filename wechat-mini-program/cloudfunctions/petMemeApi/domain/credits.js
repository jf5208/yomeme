const crypto = require("node:crypto");
const {
  TRIAL_CREDITS,
  GENERATION_COST,
  RESERVATION_TTL_MS,
} = require("../config");

const ALLOWED_TRANSITIONS = {
  reserved: new Set(["succeeded", "failed"]),
  succeeded: new Set(),
  failed: new Set(),
};

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

async function createUser(transaction, openid, createdAt) {
  const user = {
    _id: openid,
    _openid: openid,
    credits: TRIAL_CREDITS,
    trialGranted: true,
    createdAt,
    updatedAt: createdAt,
  };
  await setDocument(transaction, "users", user);
  await addCreditEvent(transaction, {
    _openid: openid,
    eventType: "trial",
    creditDelta: TRIAL_CREDITS,
    balanceAfter: TRIAL_CREDITS,
    referenceId: openid,
    jobId: null,
    createdAt,
  });
  return user;
}

function requireOpenid(openid) {
  if (typeof openid !== "string" || openid.length === 0) {
    throw businessError("invalid_identity", "无法识别当前微信用户。");
  }
}

function requireOwnedJob(job, openid) {
  if (!job) throw businessError("job_not_found", "生成任务不存在。");
  if (job._openid !== openid) throw businessError("forbidden", "无权访问这个生成任务。");
}

async function ensureUser({ db, openid, now }) {
  requireOpenid(openid);
  const createdAt = timestamp(now);

  return db.runTransaction(async (transaction) => {
    const existing = await getDocument(transaction, "users", openid);
    if (existing) return existing;
    return createUser(transaction, openid, createdAt);
  });
}

async function reserveGeneration({
  db,
  openid,
  jobId,
  templateFileId,
  petFileIds,
  adjustment,
  sourceJobId,
  now,
}) {
  requireOpenid(openid);
  const createdAt = timestamp(now);

  return db.runTransaction(async (transaction) => {
    const existingJob = await getDocument(transaction, "generation_jobs", jobId);
    if (existingJob) {
      if (existingJob._openid !== openid) {
        throw businessError("job_conflict", "生成任务编号已被使用。");
      }
      return existingJob;
    }

    let user = await getDocument(transaction, "users", openid);
    if (!user) user = await createUser(transaction, openid, createdAt);
    if (user.credits < GENERATION_COST) {
      throw businessError("insufficient_credits", "积分不足，请先兑换积分。");
    }

    const balanceAfter = user.credits - GENERATION_COST;
    const job = {
      _id: jobId,
      jobId,
      _openid: openid,
      status: "reserved",
      creditCost: GENERATION_COST,
      templateFileId,
      petFileIds: [...petFileIds],
      resultFileId: null,
      adjustment: adjustment || "",
      sourceJobId: sourceJobId || null,
      isRegeneration: Boolean(sourceJobId),
      errorCode: null,
      createdAt,
      completedAt: null,
      reservationExpiresAt: new Date(createdAt.getTime() + RESERVATION_TTL_MS),
    };

    await transaction.collection("users").doc(openid).update({
      data: { credits: balanceAfter, updatedAt: createdAt },
    });
    await setDocument(transaction, "generation_jobs", job);
    await addCreditEvent(transaction, {
      _openid: openid,
      eventType: "generation_reserve",
      creditDelta: -GENERATION_COST,
      balanceAfter,
      referenceId: jobId,
      jobId,
      createdAt,
    });

    return job;
  });
}

async function completeGeneration({ db, openid, jobId, resultFileId, now }) {
  requireOpenid(openid);
  const completedAt = timestamp(now);

  return db.runTransaction(async (transaction) => {
    const job = await getDocument(transaction, "generation_jobs", jobId);
    requireOwnedJob(job, openid);
    if (!ALLOWED_TRANSITIONS[job.status]) {
      throw businessError("invalid_job_status", "生成任务状态无效。");
    }
    if (!ALLOWED_TRANSITIONS[job.status].has("succeeded")) return job;

    const user = await getDocument(transaction, "users", openid);
    if (!user) throw businessError("user_not_found", "用户不存在。");
    const update = {
      status: "succeeded",
      resultFileId,
      errorCode: null,
      completedAt,
    };
    await transaction.collection("generation_jobs").doc(jobId).update({ data: update });
    await addCreditEvent(transaction, {
      _openid: openid,
      eventType: "generation_success",
      creditDelta: 0,
      balanceAfter: user.credits,
      referenceId: jobId,
      jobId,
      createdAt: completedAt,
    });
    return { ...job, ...update };
  });
}

async function refundGeneration({ db, openid, jobId, errorCode, now }) {
  requireOpenid(openid);
  const completedAt = timestamp(now);

  return db.runTransaction(async (transaction) => {
    const job = await getDocument(transaction, "generation_jobs", jobId);
    requireOwnedJob(job, openid);
    if (!ALLOWED_TRANSITIONS[job.status]) {
      throw businessError("invalid_job_status", "生成任务状态无效。");
    }
    if (!ALLOWED_TRANSITIONS[job.status].has("failed")) return job;

    const user = await getDocument(transaction, "users", openid);
    if (!user) throw businessError("user_not_found", "用户不存在。");
    const balanceAfter = user.credits + job.creditCost;
    const update = {
      status: "failed",
      resultFileId: null,
      errorCode,
      completedAt,
    };
    await transaction.collection("users").doc(openid).update({
      data: { credits: balanceAfter, updatedAt: completedAt },
    });
    await transaction.collection("generation_jobs").doc(jobId).update({ data: update });
    await addCreditEvent(transaction, {
      _openid: openid,
      eventType: "generation_refund",
      creditDelta: job.creditCost,
      balanceAfter,
      referenceId: jobId,
      jobId,
      createdAt: completedAt,
    });
    return { ...job, ...update };
  });
}

module.exports = {
  ALLOWED_TRANSITIONS,
  ensureUser,
  reserveGeneration,
  completeGeneration,
  refundGeneration,
};
