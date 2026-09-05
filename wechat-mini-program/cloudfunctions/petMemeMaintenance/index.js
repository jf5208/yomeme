const crypto = require("node:crypto");

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_JOBS = 100;
const MAX_EPHEMERAL_RECORDS = 100;
const MAX_RESERVATIONS = 100;

function timestamp(now) {
  const value = now === undefined ? new Date() : new Date(now);
  if (Number.isNaN(value.getTime())) throw new TypeError("now must be a valid date");
  return value;
}

async function findJobs(db, conditions, limit, direction = "asc") {
  if (limit <= 0) return [];
  const result = await db
    .collection("generation_jobs")
    .where(conditions)
    .orderBy("createdAt", direction)
    .limit(limit)
    .get();
  return result.data || [];
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

async function deleteFiles(cloud, fileIds) {
  const fileList = [...new Set(fileIds.filter((fileId) => typeof fileId === "string" && fileId))];
  let deletionError = null;
  for (const fileID of fileList) {
    try {
      const result = await cloud.deleteFile({ fileList: [fileID] });
      const outcome = result && Array.isArray(result.fileList) ? result.fileList[0] : null;
      if (!outcome || (outcome.status !== 0 && !missingStorageOutcome(outcome))) {
        throw new Error("storage deletion incomplete");
      }
    } catch (error) {
      if (!missingStorageFile(error && error.code) && !missingStorageFile(error && error.message)) {
        deletionError = deletionError || error;
      }
    }
  }
  if (deletionError) throw deletionError;
}

function isAtOrBefore(value, cutoff) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) && time <= cutoff.getTime();
}

async function claimCleanup({ db, jobId, kind, cutoff, now }) {
  return db.runTransaction(async (transaction) => {
    const result = await transaction.collection("generation_jobs").doc(jobId).get();
    const job = result.data || null;
    if (!job || job.adjustmentReservedJobId || !isAtOrBefore(job.createdAt, cutoff)) {
      return null;
    }
    const eligible = kind === "result"
      ? job.status === "succeeded"
      : !job.originalsCleaned && ["succeeded", "failed"].includes(job.status);
    if (!eligible) return null;
    await transaction.collection("generation_jobs").doc(jobId).update({
      data: { cleanupClaimed: true, cleanupClaimedAt: now },
    });
    return { ...job, cleanupClaimed: true, cleanupClaimedAt: now };
  });
}

function creditEventId(eventType, referenceId) {
  return crypto
    .createHash("sha256")
    .update(`${eventType}:${referenceId}`)
    .digest("hex")
    .slice(0, 32);
}

async function recoverReservation({ db, jobId, now }) {
  return db.runTransaction(async (transaction) => {
    const result = await transaction.collection("generation_jobs").doc(jobId).get();
    const job = result.data || null;
    if (!job || job.status !== "reserved" || !isAtOrBefore(job.reservationExpiresAt, now)) {
      return false;
    }
    const userResult = await transaction.collection("users").doc(job._openid).get();
    const user = userResult.data || null;
    if (!user) throw new Error("reservation user missing");
    const balanceAfter = user.credits + job.creditCost;
    if (job.sourceJobId) {
      const sourceResult = await transaction.collection("generation_jobs").doc(job.sourceJobId).get();
      const source = sourceResult.data || null;
      if (source && source.adjustmentReservedJobId === job.jobId) {
        await transaction.collection("generation_jobs").doc(job.sourceJobId).update({
          data: { adjustmentReservedJobId: null },
        });
      }
    }
    await transaction.collection("users").doc(job._openid).update({
      data: { credits: balanceAfter, updatedAt: now },
    });
    await transaction.collection("generation_jobs").doc(jobId).update({
      data: {
        status: "failed",
        resultFileId: null,
        errorCode: "reservation_expired",
        completedAt: now,
      },
    });
    await transaction.collection("credit_events").doc(
      creditEventId("generation_refund", job.jobId),
    ).set({
      data: {
        _openid: job._openid,
        eventType: "generation_refund",
        creditDelta: job.creditCost,
        balanceAfter,
        referenceId: job.jobId,
        jobId: job.jobId,
        createdAt: now,
      },
    });
    return true;
  });
}

async function recoverExpiredReservations({ db, now }) {
  const result = await db
    .collection("generation_jobs")
    .where({
      status: "reserved",
      reservationExpiresAt: db.command.lte(now),
    })
    .orderBy("reservationExpiresAt", "asc")
    .limit(MAX_RESERVATIONS)
    .get();
  let recovered = 0;
  let errors = 0;
  for (const job of result.data || []) {
    try {
      if (await recoverReservation({ db, jobId: job._id, now })) recovered += 1;
    } catch (_error) {
      errors += 1;
    }
  }
  return { recovered, errors };
}

async function expireResults({ db, cloud, cutoff, limit, now }) {
  const jobs = await findJobs(db, {
    status: "succeeded",
    createdAt: db.command.lte(cutoff),
  }, limit);
  let processed = 0;
  let errors = 0;
  for (const candidate of jobs) {
    try {
      const job = await claimCleanup({
        db,
        jobId: candidate._id,
        kind: "result",
        cutoff,
        now,
      });
      if (!job) continue;
      await deleteFiles(cloud, [
        job.templateFileId,
        ...(job.petFileIds || []),
        job.resultFileId,
        job.pendingResultFileId,
      ]);
      await db.collection("generation_jobs").doc(job._id).update({
        data: {
          status: "expired",
          templateFileId: null,
          petFileIds: [],
          resultFileId: null,
          pendingResultFileId: null,
          originalsCleaned: true,
          originalsCleanedAt: now,
          resultExpiredAt: now,
          cleanupClaimed: false,
        },
      });
      processed += 1;
    } catch (_error) {
      errors += 1;
    }
  }
  return { processed, errors, found: jobs.length };
}

async function cleanOriginals({ db, cloud, cutoff, limit, now }) {
  const jobs = await findJobs(db, {
    originalsCleaned: false,
    status: db.command.in(["succeeded", "failed"]),
    createdAt: db.command.lte(cutoff),
  }, limit, "desc");
  let processed = 0;
  let errors = 0;
  for (const candidate of jobs) {
    try {
      const job = await claimCleanup({
        db,
        jobId: candidate._id,
        kind: "originals",
        cutoff,
        now,
      });
      if (!job) continue;
      await deleteFiles(cloud, [
        job.templateFileId,
        ...(job.petFileIds || []),
        job.pendingResultFileId,
      ]);
      await db.collection("generation_jobs").doc(job._id).update({
        data: {
          templateFileId: null,
          petFileIds: [],
          pendingResultFileId: null,
          originalsCleaned: true,
          originalsCleanedAt: now,
          cleanupClaimed: false,
        },
      });
      processed += 1;
    } catch (_error) {
      errors += 1;
    }
  }
  return { processed, errors, found: jobs.length };
}

async function removeExpiredRecords(db, cloud, collectionName, now) {
  const result = await db
    .collection(collectionName)
    .where({ expiresAt: db.command.lte(now) })
    .orderBy("expiresAt", "asc")
    .limit(MAX_EPHEMERAL_RECORDS)
    .get();
  const records = result.data || [];
  let removed = 0;
  let errors = 0;
  for (const record of records) {
    try {
      if (collectionName === "generation_preparations") {
        await deleteFiles(cloud, record.uploadedFileIds || []);
      }
      await db.collection(collectionName).doc(record._id).remove();
      removed += 1;
    } catch (_error) {
      errors += 1;
    }
  }
  return { removed, errors };
}

async function cleanup({ db, cloud, now }) {
  const current = timestamp(now);
  const reservations = await recoverExpiredReservations({ db, now: current });
  const reservedPerKind = Math.floor(MAX_JOBS / 2);
  const expired = await expireResults({
    db,
    cloud,
    cutoff: new Date(current.getTime() - 30 * DAY_MS),
    limit: reservedPerKind,
    now: current,
  });
  const originals = await cleanOriginals({
    db,
    cloud,
    cutoff: new Date(current.getTime() - 7 * DAY_MS),
    limit: reservedPerKind,
    now: current,
  });
  let extra = { processed: 0, errors: 0 };
  const remaining = MAX_JOBS - expired.processed - originals.processed;
  if (remaining > 0 && expired.found === reservedPerKind && originals.found < reservedPerKind) {
    extra = await expireResults({
      db,
      cloud,
      cutoff: new Date(current.getTime() - 30 * DAY_MS),
      limit: remaining,
      now: current,
    });
  } else if (remaining > 0 && originals.found === reservedPerKind && expired.found < reservedPerKind) {
    extra = await cleanOriginals({
      db,
      cloud,
      cutoff: new Date(current.getTime() - 7 * DAY_MS),
      limit: remaining,
      now: current,
    });
  }
  const preparations = await removeExpiredRecords(
    db, cloud, "generation_preparations", current,
  );
  const shareGrants = await removeExpiredRecords(db, cloud, "share_grants", current);
  return {
    jobsProcessed: expired.processed + originals.processed + extra.processed,
    reservationsRecovered: reservations.recovered,
    ephemeralRecordsRemoved: preparations.removed + shareGrants.removed,
    errors: reservations.errors + expired.errors + originals.errors + extra.errors
      + preparations.errors + shareGrants.errors,
  };
}

function assertMaintenanceInvocationAllowed(wxContext) {
  if (wxContext && wxContext.OPENID) throw new Error("scheduled invocation required");
}

async function main() {
  const cloud = require("wx-server-sdk");
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
  assertMaintenanceInvocationAllowed(cloud.getWXContext());
  const db = cloud.database({ throwOnNotFound: false });
  return cleanup({ db, cloud, now: new Date() });
}

module.exports = { cleanup, main, assertMaintenanceInvocationAllowed };
