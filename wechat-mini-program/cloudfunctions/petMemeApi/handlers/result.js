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

function tokenMatches(token, expectedHash) {
  if (typeof token !== "string" || typeof expectedHash !== "string") return false;
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
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
  if (!isOwner && !tokenMatches(token, job.shareTokenHash)) {
    throw businessError("forbidden", "无权访问这个生成结果。");
  }
  if (!isOwner && job.status !== "succeeded") {
    throw businessError("result_not_ready", "生成结果尚未完成。");
  }

  const imageUrl = job.status === "succeeded" && job.resultFileId
    ? await temporaryUrl(cloud, job.resultFileId)
    : null;
  return {
    jobId: job.jobId,
    status: job.status,
    imageUrl,
    generatedAt: job.completedAt || null,
    readOnly: !isOwner,
  };
}

async function prepareShare({
  db,
  openid,
  jobId,
  randomBytes = crypto.randomBytes,
  now,
}) {
  const token = randomBytes(18).toString("base64url");
  const shareTokenHash = hashToken(token);
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
    await transaction.collection("generation_jobs").doc(jobId).update({
      data: { shareTokenHash, sharedAt },
    });
  });

  return { jobId, token };
}

module.exports = { getResult, prepareShare };
