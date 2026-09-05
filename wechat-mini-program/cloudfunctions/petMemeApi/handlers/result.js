const crypto = require("node:crypto");

function businessError(code, message) {
  return Object.assign(new Error(message), { code });
}

async function getJob(db, transaction, jobId) {
  const source = transaction || db;
  const result = await source.collection("generation_jobs").doc(jobId).get();
  return result.data || null;
}

function requireJob(job) {
  if (!job) throw businessError("job_not_found", "生成任务不存在。");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function validShareGrant(db, jobId, token) {
  if (typeof token !== "string" || token.length === 0) return false;
  const tokenHash = hashToken(token);
  const result = await db.collection("share_grants").doc(tokenHash).get();
  const grant = result.data || null;
  return Boolean(grant && grant.jobId === jobId);
}

function isoString(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function temporaryUrl(cloud, fileId) {
  const result = await cloud.getTempFileURL({ fileList: [fileId] });
  const file = result && Array.isArray(result.fileList) ? result.fileList[0] : null;
  if (!file || file.status !== 0 || typeof file.tempFileURL !== "string") {
    throw businessError("result_unavailable", "生成结果暂时无法读取。");
  }
  return file.tempFileURL;
}

async function getResult({ db, cloud, openid, jobId, token }) {
  const job = await getJob(db, null, jobId);
  requireJob(job);
  const isOwner = job._openid === openid;
  if (!isOwner && !(await validShareGrant(db, jobId, token))) {
    throw businessError("forbidden", "无权访问这个生成结果。");
  }
  if (!isOwner && job.status !== "succeeded") {
    throw businessError("result_not_ready", "生成结果尚未完成。");
  }

  const imageUrl = job.status === "succeeded" && job.resultFileId
    ? await temporaryUrl(cloud, job.resultFileId)
    : null;
  const response = {
    jobId: job.jobId,
    status: job.status,
    imageUrl,
    generatedAt: isoString(job.completedAt),
    readOnly: !isOwner,
  };
  if (isOwner) {
    response.canAdjust = job.status === "succeeded"
      && !job.isRegeneration
      && !job.adjustmentReservedJobId
      && !job.adjustmentSucceededJobId;
  }
  return response;
}

async function prepareShare({
  db,
  openid,
  jobId,
  randomBytes = crypto.randomBytes,
  now,
}) {
  const token = randomBytes(18).toString("base64url");
  const tokenHash = hashToken(token);
  const sharedAt = now === undefined ? new Date() : new Date(now);

  await db.runTransaction(async (transaction) => {
    const job = await getJob(db, transaction, jobId);
    requireJob(job);
    if (job._openid !== openid) {
      throw businessError("forbidden", "无权分享这个生成结果。");
    }
    if (job.status !== "succeeded" || !job.resultFileId) {
      throw businessError("result_not_ready", "生成结果尚未完成。");
    }
    await transaction.collection("share_grants").doc(tokenHash).set({
      data: {
        tokenHash,
        jobId,
        _openid: openid,
        createdAt: sharedAt,
      },
    });
  });

  return { jobId, token };
}

module.exports = { getResult, prepareShare };
