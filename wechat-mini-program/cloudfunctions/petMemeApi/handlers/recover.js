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

async function findStaleJobs({ db, openid, now }) {
  const conditions = {
    status: "reserved",
    reservationExpiresAt: db.command.lte(currentTime(now)),
  };
  if (openid) conditions._openid = openid;

  const jobs = [];
  let offset = 0;
  while (true) {
    const result = await db
      .collection("generation_jobs")
      .where(conditions)
      .orderBy("reservationExpiresAt", "asc")
      .orderBy("_id", "asc")
      .skip(offset)
      .limit(PAGE_SIZE)
      .get();
    const page = result.data || [];
    jobs.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += page.length;
  }
  return jobs;
}

async function refundJobs({ db, jobs, now }) {
  let recovered = 0;
  for (const job of jobs) {
    const result = await refundGeneration({
      db,
      openid: job._openid,
      jobId: job.jobId,
      errorCode: "reservation_expired",
      now,
    });
    if (result.status === "failed") recovered += 1;
  }
  return { recovered };
}

async function recoverCallerStaleJobs({ db, openid, now }) {
  const jobs = await findStaleJobs({ db, openid, now });
  return refundJobs({ db, jobs, now });
}

async function recoverStaleJobs({ db, openid, now }) {
  if (!parseAdminOpenids().has(openid)) {
    throw businessError("forbidden", "无权执行管理员操作。");
  }
  const jobs = await findStaleJobs({ db, now });
  return refundJobs({ db, jobs, now });
}

module.exports = {
  recoverCallerStaleJobs,
  recoverStaleJobs,
};
