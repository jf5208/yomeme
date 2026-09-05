const crypto = require("node:crypto");
const sharp = require("sharp");
const {
  reserveGeneration,
  completeGeneration,
  refundGeneration,
} = require("../domain/credits");
const { validateGenerationInput } = require("../domain/validation");
const { generateImage: requestSeedream } = require("../services/seedream");
const { PREPARATION_TTL_MS } = require("../config");

const JOB_ID_PATTERN = /^[A-Za-z0-9-]{16,64}$/;
const IMAGE_EXTENSION_PATTERN = "(?:png|jpe?g|webp)";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 4096;
const MAX_IMAGE_PIXELS = 16_000_000;
const MIN_IMAGE_DIMENSION = 8;
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

function requireEnvironmentId(environmentId) {
  if (typeof environmentId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(environmentId)) {
    throw businessError("invalid_environment", "无法识别当前云环境。");
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

function extractCloudAuthority(fileId) {
  if (typeof fileId !== "string") return null;
  const match = /^cloud:\/\/([^/?#]+)\/(.+)$/.exec(fileId.trim());
  return match && !/[?#]/.test(match[2]) ? match[1] : null;
}

function authorityMatchesEnvironment(authority, environmentId) {
  return authority === environmentId || authority.startsWith(`${environmentId}.`);
}

function validateFileEnvironment(fileIds, environmentId) {
  if (fileIds.some((fileId) => !authorityMatchesEnvironment(
    extractCloudAuthority(fileId) || "",
    environmentId,
  ))) {
    throw businessError("invalid_input", "图片文件不属于当前云环境。");
  }
}

function validateUploadLayout({ jobId, templateFileId, petFileIds, environmentId }) {
  validateFileEnvironment([templateFileId, ...petFileIds], environmentId);
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

function validateTrackedUpload({ jobId, fileId, environmentId }) {
  validateFileEnvironment([fileId], environmentId);
  const escapedJobId = jobId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `^uploads/${escapedJobId}/(?:template|pet-[1-3])\\.${IMAGE_EXTENSION_PATTERN}$`,
    "i",
  );
  if (!pattern.test(extractCloudPath(fileId) || "")) {
    throw businessError("invalid_input", "上传文件路径无效。");
  }
}

function invalidImage() {
  return businessError("invalid_image", "图片文件无效。");
}

function validateDimensions(width, height) {
  if (
    !Number.isInteger(width)
    || !Number.isInteger(height)
    || width < MIN_IMAGE_DIMENSION
    || height < MIN_IMAGE_DIMENSION
    || width > MAX_IMAGE_DIMENSION
    || height > MAX_IMAGE_DIMENSION
    || width * height > MAX_IMAGE_PIXELS
  ) throw invalidImage();
  return { width, height };
}

async function inspectImage(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    throw invalidImage();
  }
  try {
    const decoderOptions = {
      failOn: "error",
      limitInputPixels: MAX_IMAGE_PIXELS,
      sequentialRead: true,
    };
    const metadata = await sharp(bytes, decoderOptions).metadata();
    const mimeTypes = {
      png: "image/png",
      jpeg: "image/jpeg",
      webp: "image/webp",
    };
    const mimeType = mimeTypes[metadata.format];
    if (!mimeType || (metadata.pages && metadata.pages !== 1)) throw invalidImage();
    const dimensions = validateDimensions(metadata.width, metadata.height);
    await sharp(bytes, decoderOptions).raw().toBuffer();
    return { mimeType, ...dimensions };
  } catch (_error) {
    throw invalidImage();
  }
}

async function validateDownloadedImage(download) {
  const bytes = download && download.fileContent;
  const inspected = await inspectImage(bytes);
  return { bytes, ...inspected };
}

async function validateGeneratedImage(image) {
  const bytes = image && image.bytes;
  try {
    const inspected = await inspectImage(bytes);
    if (inspected.width !== inspected.height) throw invalidImage();
    return { bytes, ...inspected };
  } catch (_error) {
    throw businessError("provider_failed", "图片生成失败。");
  }
}

function extensionForMimeType(mimeType) {
  const extensions = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
  };
  return extensions[mimeType];
}

async function getJob(db, jobId) {
  const result = await db.collection("generation_jobs").doc(jobId).get();
  return result.data || null;
}

async function requirePreparation({ db, openid, environmentId, jobId, now }) {
  const result = await db.collection("generation_preparations").doc(jobId).get();
  const preparation = result.data || null;
  if (!preparation) {
    throw businessError("preparation_required", "请重新开始生成任务。");
  }
  if (preparation._openid !== openid) {
    throw businessError("forbidden", "无权使用这个生成任务。");
  }
  if (preparation.environmentId !== environmentId) {
    throw businessError("forbidden", "生成任务不属于当前云环境。");
  }
  const current = now === undefined ? new Date() : new Date(now);
  const expiresAt = new Date(preparation.expiresAt);
  if (Number.isNaN(current.getTime()) || Number.isNaN(expiresAt.getTime())) {
    throw businessError("preparation_expired", "生成任务已过期，请重新开始。");
  }
  if (expiresAt.getTime() <= current.getTime()) {
    throw businessError("preparation_expired", "生成任务已过期，请重新开始。");
  }
  return preparation;
}

async function resolveGenerationInput({ db, openid, environmentId, event }) {
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
    validateUploadLayout({ ...resolved, environmentId });
    return resolved;
  }

  requireJobId(event.sourceJobId);
  const adjustment = validateAdjustment(event);
  const source = await getJob(db, event.sourceJobId);
  if (!source) throw businessError("job_not_found", "原生成任务不存在。");
  if (source._openid !== openid) {
    throw businessError("forbidden", "无权使用这个生成任务。");
  }
  if (source.status !== "succeeded" || source.isRegeneration) {
    throw businessError("invalid_source_job", "原生成任务尚未成功。");
  }
  validateFileEnvironment([source.templateFileId, ...source.petFileIds], environmentId);
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

function missingStorageFile(value) {
  const text = String(value || "").toLowerCase();
  return text.includes("storage_file_nonexist") || text.includes("storage file not exists");
}

function missingStorageOutcome(outcome) {
  return Boolean(outcome) && (
    outcome.status === -503003
    || missingStorageFile(outcome.errCode)
    || missingStorageFile(outcome.code)
    || missingStorageFile(outcome.errMsg)
  );
}

async function deleteUploadedResult(cloud, fileId) {
  try {
    const result = await cloud.deleteFile({ fileList: [fileId] });
    const outcome = result && Array.isArray(result.fileList) ? result.fileList[0] : null;
    return Boolean(outcome) && (
      outcome.status === 0
      || missingStorageOutcome(outcome)
    );
  } catch (error) {
    return missingStorageFile(error && error.code) || missingStorageFile(error && error.message);
  }
}

async function trackPendingResult(db, jobId, pendingResultFileId) {
  await db.collection("generation_jobs").doc(jobId).update({
    data: { pendingResultFileId },
  });
}

async function prepareGeneration({
  db,
  openid,
  environmentId,
  randomUUID = crypto.randomUUID,
  now,
}) {
  requireOpenid(openid);
  requireEnvironmentId(environmentId);
  const jobId = randomUUID();
  requireJobId(jobId);
  const createdAt = now === undefined ? new Date() : new Date(now);
  if (Number.isNaN(createdAt.getTime())) throw new TypeError("now must be a valid date");
  await db.collection("generation_preparations").doc(jobId).set({
    data: {
      jobId,
      _openid: openid,
      environmentId,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + PREPARATION_TTL_MS),
      uploadedFileIds: [],
    },
  });
  return { jobId };
}

async function registerUpload({ db, openid, environmentId, jobId, fileId, now }) {
  requireOpenid(openid);
  requireEnvironmentId(environmentId);
  requireJobId(jobId);
  validateTrackedUpload({ jobId, fileId, environmentId });

  await db.runTransaction(async (transaction) => {
    const preparation = await requirePreparation({
      db: transaction,
      openid,
      environmentId,
      jobId,
      now,
    });
    const uploadedFileIds = Array.isArray(preparation.uploadedFileIds)
      ? [...preparation.uploadedFileIds]
      : [];
    if (!uploadedFileIds.includes(fileId)) uploadedFileIds.push(fileId);
    if (uploadedFileIds.length > 4) {
      throw businessError("invalid_input", "上传图片数量无效。");
    }
    await transaction.collection("generation_preparations").doc(jobId).update({
      data: { uploadedFileIds },
    });
  });
  return { registered: true };
}

async function generate({
  db,
  cloud,
  openid,
  environmentId,
  event,
  now,
  generateImage = requestSeedream,
}) {
  requireOpenid(openid);
  requireEnvironmentId(environmentId);
  requireJobId(event && event.jobId);
  const existingJob = await getJob(db, event.jobId);
  if (existingJob) {
    if (existingJob._openid !== openid) {
      throw businessError("job_conflict", "生成任务编号已被使用。");
    }
    return sanitizedStatus(existingJob);
  }
  await requirePreparation({ db, openid, environmentId, jobId: event.jobId, now });
  const resolved = await resolveGenerationInput({ db, openid, environmentId, event });
  const reservation = await reserveGeneration({
    db,
    openid,
    ...resolved,
    now,
  });
  if (!reservation.acquired) return sanitizedStatus(reservation.job);

  let uploadedResultFileId = null;
  try {
    await db.collection("generation_preparations").doc(resolved.jobId).remove();
    const fileIds = [resolved.templateFileId, ...resolved.petFileIds];
    const downloads = [];
    for (const fileID of fileIds) {
      downloads.push(await validateDownloadedImage(await cloud.downloadFile({ fileID })));
    }
    if (downloads[0].width !== downloads[0].height) throw invalidImage();
    const providerResult = await generateImage({
      images: downloads,
      adjustment: resolved.adjustment,
    });
    const generated = await validateGeneratedImage(providerResult);
    const extension = extensionForMimeType(generated.mimeType);
    const cloudPath = `results/${openid}/${resolved.jobId}.${extension}`;
    const uploaded = await cloud.uploadFile({ cloudPath, fileContent: generated.bytes });
    if (!uploaded || typeof uploaded.fileID !== "string" || !extractCloudPath(uploaded.fileID)) {
      throw businessError("upload_failed", "生成结果保存失败。");
    }
    uploadedResultFileId = uploaded.fileID;
    await trackPendingResult(db, resolved.jobId, uploadedResultFileId);
    const completed = await completeGeneration({
      db,
      openid,
      jobId: resolved.jobId,
      resultFileId: uploaded.fileID,
      now,
    });
    return sanitizedStatus(completed);
  } catch (error) {
    let refunded;
    try {
      refunded = await refundGeneration({
        db,
        openid,
        jobId: resolved.jobId,
        errorCode: safeFailureCode(error),
        now,
      });
    } catch (_refundError) {
      throw businessError("generation_failed", "生成失败，请稍后查看任务状态。");
    }
    if (refunded.status === "succeeded") return sanitizedStatus(refunded);

    if (uploadedResultFileId && typeof cloud.deleteFile === "function") {
      const deleted = await deleteUploadedResult(cloud, uploadedResultFileId);
      try {
        await trackPendingResult(db, resolved.jobId, deleted ? null : uploadedResultFileId);
      } catch (_trackingError) {
        // Storage lifecycle rules remain the final fallback if both tracking and cleanup fail.
      }
    }
    throw businessError("generation_failed", "生成失败，本次未扣积分。");
  }
}

module.exports = {
  prepareGeneration,
  registerUpload,
  generate,
  extractCloudPath,
  validateDownloadedImage,
  MAX_IMAGE_BYTES,
};
