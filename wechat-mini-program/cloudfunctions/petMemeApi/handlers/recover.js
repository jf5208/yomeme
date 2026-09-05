const { refundGeneration } = require("../domain/credits");
const { parseAdminOpenids } = require("../domain/codes");

const PAGE_SIZE = 100;

function businessError(code, message) {
  return Object.assign(new Error(message), { code });
}

function currentTime(now) {
  const value = now === undefined ? new Date() : new Date(now);
  if (Number.isNaN(value.getTime())) throw new TypeError("now must be a valid date");
  return value;
}

async function findStalePage({ db, openid, now }) {
  const conditions = {
    status: "reserved",
    reservationExpiresAt: db.command.lte(currentTime(now)),
  };
  if (openid) conditions._openid = openid;

  const result = await db
    .collection("generation_jobs")
    .where(conditions)
    .orderBy("reservationExpiresAt", "asc")
    .orderBy("_id", "asc")
    .limit(PAGE_SIZE)
    .get();
  return result.data || [];
}

async function recoverMatchingJobs({ db, openid, now }) {
  let recovered = 0;
  let previousBatchKey = null;
  while (true) {
    const jobs = await findStalePage({ db, openid, now });
    if (jobs.length === 0) return { recovered };
    const batchKey = jobs.map((job) => job.jobId).join("\n");
    if (batchKey === previousBatchKey) {
      throw businessError("recovery_stalled", "过期任务恢复未取得进展。");
    }
    previousBatchKey = batchKey;

    for (const job of jobs) {
      const result = await refundGeneration({
        db,
        openid: job._openid,
        jobId: job.jobId,
        errorCode: "reservation_expired",
        now,
      });
      if (result.refunded) recovered += 1;
    }
  }
}

async function recoverCallerStaleJobs({ db, openid, now }) {
  return recoverMatchingJobs({ db, openid, now });
}

async function recoverStaleJobs({ db, openid, now }) {
  if (!parseAdminOpenids().has(openid)) {
    throw businessError("forbidden", "无权执行管理员操作。");
  }
  return recoverMatchingJobs({ db, now });
}

module.exports = {
  recoverCallerStaleJobs,
  recoverStaleJobs,
};
