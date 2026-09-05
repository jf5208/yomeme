const crypto = require("node:crypto");
const {
  reserveGeneration,
  completeGeneration,
  refundGeneration,
} = require("../domain/credits");
const { validateGenerationInput } = require("../domain/validation");
const { generateImage: requestSeedream } = require("../services/seedream");

const JOB_ID_PATTERN = /^[A-Za-z0-9-]{16,64}$/;
const IMAGE_EXTENSION_PATTERN = "(?:png|jpe?g|webp)";
const SAFE_FAILURE_CODES = new Set([
  "content_rejected",
  "invalid_image",
  "provider_failed",
  "provider_insufficient_balance",
  "provider_model_inactive",
  "provider_not_configured",
  "provider_rejected",
  "provider_timeout",
  "upload_failed",
]);

function businessError(code, message) {
  return Object.assign(new Error(message), { code });
}

function requireOpenid(openid) {
  if (typeof openid !== "string" || openid.length === 0) {
    throw businessError("invalid_identity", "无法识别当前微信用户。");
  }
}

function requireJobId(jobId) {
  if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) {
    throw businessError("invalid_input", "生成任务编号无效。");
  }
}

function validateAdjustment(event) {
  if (!event || event.rightsConfirmed !== true) {
    throw businessError("invalid_input", "请先确认素材权利。");
  }
  const adjustment = event.adjustment === undefined ? "" : event.adjustment;
  if (typeof adjustment !== "string" || Array.from(adjustment).length > 300) {
    throw businessError("invalid_input", "调整意见最多 300 字。");
  }
  return adjustment.trim();
}

function extractCloudPath(fileId) {
  if (typeof fileId !== "string") return null;
  const match = /^cloud:\/\/[^/?#]+\/(.+)$/.exec(fileId.trim());
  if (!match || /[?#]/.test(match[1])) return null;
  try {
    const path = decodeURIComponent(match[1]);
    if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) {
      return null;
    }
    return path;
  } catch (_error) {
    return null;
  }
}

function validateUploadLayout({ jobId, templateFileId, petFileIds }) {
  const escapedJobId = jobId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const templatePattern = new RegExp(
    `^uploads/${escapedJobId}/template\\.${IMAGE_EXTENSION_PATTERN}$`,
    "i",
  );
  if (!templatePattern.test(extractCloudPath(templateFileId) || "")) {
    throw businessError("invalid_input", "模板文件路径无效。");
  }

  for (let index = 0; index < petFileIds.length; index += 1) {
    const petPattern = new RegExp(
      `^uploads/${escapedJobId}/pet-${index + 1}\\.${IMAGE_EXTENSION_PATTERN}$`,
      "i",
    );
    if (!petPattern.test(extractCloudPath(petFileIds[index]) || "")) {
      throw businessError("invalid_input", "宠物照片文件路径无效。");
    }
  }
}

function detectMimeType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) return "image/webp";
  return null;
}

function validateDownloadedImage(download) {
  const bytes = download && download.fileContent;
  const mimeType = Buffer.isBuffer(bytes) ? detectMimeType(bytes) : null;
  if (!mimeType) throw businessError("invalid_image", "图片文件无效。");
  return { bytes, mimeType };
}

function validateGeneratedImage(image) {
  const bytes = image && image.bytes;
  const detectedMimeType = Buffer.isBuffer(bytes) ? detectMimeType(bytes) : null;
  if (!detectedMimeType || detectedMimeType !== image.mimeType) {
    throw businessError("provider_failed", "图片生成失败。");
  }
  return bytes;
}

async function getJob(db, jobId) {
  const result = await db.collection("generation_jobs").doc(jobId).get();
  return result.data || null;
}

async function resolveGenerationInput({ db, openid, event }) {
  requireJobId(event && event.jobId);
  if (!event.sourceJobId) {
    const validated = validateGenerationInput(event);
    const petFileIds = validated.fileIds.slice(1);
    const resolved = {
      jobId: event.jobId,
      templateFileId: validated.fileIds[0],
      petFileIds,
      adjustment: validated.adjustment,
      sourceJobId: null,
    };
    validateUploadLayout(resolved);
    return resolved;
  }

  requireJobId(event.sourceJobId);
  const adjustment = validateAdjustment(event);
  const source = await getJob(db, event.sourceJobId);
  if (!source) throw businessError("job_not_found", "原生成任务不存在。");
  if (source._openid !== openid) {
    throw businessError("forbidden", "无权使用这个生成任务。");
  }
  if (source.status !== "succeeded") {
    throw businessError("invalid_source_job", "原生成任务尚未成功。");
  }
  return {
    jobId: event.jobId,
    templateFileId: source.templateFileId,
    petFileIds: [...source.petFileIds],
    adjustment,
    sourceJobId: source.jobId,
  };
}

function sanitizedStatus(job) {
  return { jobId: job.jobId, status: job.status };
}

function safeFailureCode(error) {
  return error && SAFE_FAILURE_CODES.has(error.code) ? error.code : "generation_failed";
}

async function prepareGeneration({ openid, randomUUID = crypto.randomUUID }) {
  requireOpenid(openid);
  const jobId = randomUUID();
  requireJobId(jobId);
  return { jobId };
}

async function generate({
  db,
  cloud,
  openid,
  event,
  now,
  generateImage = requestSeedream,
}) {
  requireOpenid(openid);
  const resolved = await resolveGenerationInput({ db, openid, event });
  const reservation = await reserveGeneration({
    db,
    openid,
    ...resolved,
    now,
  });
  if (!reservation.acquired) return sanitizedStatus(reservation.job);

  try {
    const fileIds = [resolved.templateFileId, ...resolved.petFileIds];
    const downloads = [];
    for (const fileID of fileIds) {
      downloads.push(validateDownloadedImage(await cloud.downloadFile({ fileID })));
    }
    const generated = await generateImage({
      images: downloads,
      adjustment: resolved.adjustment,
    });
    const fileContent = validateGeneratedImage(generated);
    const cloudPath = `results/${openid}/${resolved.jobId}.png`;
    const uploaded = await cloud.uploadFile({ cloudPath, fileContent });
    if (!uploaded || typeof uploaded.fileID !== "string" || !extractCloudPath(uploaded.fileID)) {
      throw businessError("upload_failed", "生成结果保存失败。");
    }
    const completed = await completeGeneration({
      db,
      openid,
      jobId: resolved.jobId,
      resultFileId: uploaded.fileID,
      now,
    });
    return sanitizedStatus(completed);
  } catch (error) {
    await refundGeneration({
      db,
      openid,
      jobId: resolved.jobId,
      errorCode: safeFailureCode(error),
      now,
    });
    throw businessError("generation_failed", "生成失败，本次未扣积分。");
  }
}

module.exports = {
  prepareGeneration,
  generate,
  extractCloudPath,
  validateDownloadedImage,
};
