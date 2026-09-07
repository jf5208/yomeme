const crypto = require("node:crypto");
const { SHARE_GRANT_TTL_MS, RESULT_RETENTION_MS } = require("../config");

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

async function validShareGrant(db, jobId, token, now) {
  if (typeof token !== "string" || token.length === 0) return false;
  const tokenHash = hashToken(token);
  const result = await db.collection("share_grants").doc(tokenHash).get();
  const grant = result.data || null;
  const current = now === undefined ? new Date() : new Date(now);
  const expiresAt = grant && new Date(grant.expiresAt);
  return Boolean(
    grant
    && grant.jobId === jobId
    && !Number.isNaN(current.getTime())
    && !Number.isNaN(expiresAt.getTime())
    && expiresAt.getTime() > current.getTime()
  );
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

async function getResult({ db, cloud, openid, jobId, token, now }) {
  const job = await getJob(db, null, jobId);
  requireJob(job);
  const isOwner = job._openid === openid;
  if (!isOwner && !(await validShareGrant(db, jobId, token, now))) {
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
      && job.originalsCleaned !== true
      && !job.cleanupClaimed
      && typeof job.templateFileId === "string"
      && Array.isArray(job.petFileIds)
      && job.petFileIds.length > 0
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
    const resultExpiresAt = new Date(new Date(job.createdAt).getTime() + RESULT_RETENTION_MS);
    if (Number.isNaN(resultExpiresAt.getTime()) || resultExpiresAt <= sharedAt) {
      throw businessError("result_unavailable", "生成结果已过保存期。");
    }
    await transaction.collection("share_grants").doc(tokenHash).set({
      data: {
        tokenHash,
        jobId,
        _openid: openid,
        createdAt: sharedAt,
        expiresAt: new Date(Math.min(
          sharedAt.getTime() + SHARE_GRANT_TTL_MS,
          resultExpiresAt.getTime(),
        )),
      },
    });
  });

  return { jobId, token };
}

module.exports = { getResult, prepareShare };
