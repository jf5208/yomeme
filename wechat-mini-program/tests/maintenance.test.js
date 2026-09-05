const test = require("node:test");
const assert = require("node:assert/strict");
const { reserveGeneration } = require("../cloudfunctions/petMemeApi/domain/credits");
const { createMemoryDb } = require("./helpers/cloud-memory-db");

const MAINTENANCE_PATH = "../cloudfunctions/petMemeMaintenance/index";
const NOW = new Date("2026-09-05T12:00:00.000Z");

function daysAgo(days) {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

function createDb(jobs = [], preparations = [], grants = []) {
  const rows = {
    generation_jobs: Object.fromEntries(jobs.map((job) => [job._id, structuredClone(job)])),
    generation_preparations: Object.fromEntries(preparations.map((item) => [item._id, structuredClone(item)])),
    share_grants: Object.fromEntries(grants.map((item) => [item._id, structuredClone(item)])),
  };
  const command = {
    lte(value) { return { operator: "lte", value }; },
    in(values) { return { operator: "in", values }; },
  };
  const matches = (actual, expected) => {
    if (expected && expected.operator === "lte") return new Date(actual) <= new Date(expected.value);
    if (expected && expected.operator === "in") return expected.values.includes(actual);
    return actual === expected;
  };
  const collection = (name) => {
    let conditions = {};
    let size = 100;
    let ordering = null;
    const api = {
      where(value) { conditions = value; return api; },
      orderBy(field, direction) { ordering = { field, direction }; return api; },
      limit(value) { size = value; return api; },
      async get() {
        const found = Object.values(rows[name])
          .filter((row) => Object.entries(conditions).every(([key, expected]) => matches(row[key], expected)));
        if (ordering) {
          found.sort((left, right) => {
            const result = new Date(left[ordering.field]) - new Date(right[ordering.field]);
            return ordering.direction === "desc" ? -result : result;
          });
        }
        return { data: structuredClone(found.slice(0, size)) };
      },
      doc(id) {
        return {
          async get() { return { data: rows[name][id] ? structuredClone(rows[name][id]) : null }; },
          async update({ data }) { rows[name][id] = { ...rows[name][id], ...structuredClone(data) }; },
          async remove() { delete rows[name][id]; },
        };
      },
    };
    return api;
  };
  return {
    command,
    collection,
    rows,
    async runTransaction(callback) {
      return callback({ collection });
    },
  };
}

function job(id, age, overrides = {}) {
  return {
    _id: id,
    jobId: id,
    _openid: "u1",
    status: "succeeded",
    createdAt: daysAgo(age),
    templateFileId: `cloud://env/uploads/${id}/template.png`,
    petFileIds: [`cloud://env/uploads/${id}/pet-1.jpg`],
    resultFileId: `cloud://env/results/u1/${id}.png`,
    originalsCleaned: false,
    ...overrides,
  };
}

function createCloud(deleteResult) {
  const deleted = [];
  return {
    deleted,
    async deleteFile({ fileList }) {
      deleted.push(...fileList);
      if (deleteResult) return deleteResult(fileList);
      return { fileList: fileList.map((fileID) => ({ fileID, status: 0 })) };
    },
  };
}

test("6 天任务不删除，8 天只删原图，31 天删除全部并过期", async () => {
  const { cleanup } = require(MAINTENANCE_PATH);
  const db = createDb([job("six-days-job-123", 6), job("eight-days-job-1", 8), job("old-job-12345678", 31)]);
  const cloud = createCloud();

  const result = await cleanup({ db, cloud, now: NOW });

  assert.equal(result.jobsProcessed, 2);
  assert.deepEqual(db.rows.generation_jobs["six-days-job-123"].petFileIds.length, 1);
  assert.equal(db.rows.generation_jobs["eight-days-job-1"].templateFileId, null);
  assert.deepEqual(db.rows.generation_jobs["eight-days-job-1"].petFileIds, []);
  assert.match(db.rows.generation_jobs["eight-days-job-1"].resultFileId, /results/);
  assert.equal(db.rows.generation_jobs["old-job-12345678"].status, "expired");
  assert.equal(db.rows.generation_jobs["old-job-12345678"].resultFileId, null);
  assert.equal(cloud.deleted.length, 5);
});

test("重复清理保持幂等且不会重复删除", async () => {
  const { cleanup } = require(MAINTENANCE_PATH);
  const db = createDb([job("old-job-12345678", 31)]);
  const cloud = createCloud();

  await cleanup({ db, cloud, now: NOW });
  const second = await cleanup({ db, cloud, now: NOW });

  assert.equal(second.jobsProcessed, 0);
  assert.equal(cloud.deleted.length, 3);
});

test("单次最多处理 100 个生成任务", async () => {
  const { cleanup } = require(MAINTENANCE_PATH);
  const jobs = Array.from({ length: 101 }, (_, index) => job(`old-job-${String(index).padStart(12, "0")}`, 31));
  const db = createDb(jobs);
  const cloud = createCloud();

  const result = await cleanup({ db, cloud, now: NOW });

  assert.equal(result.jobsProcessed, 100);
  assert.equal(Object.values(db.rows.generation_jobs).filter(({ status }) => status === "expired").length, 50);
  assert.equal(Object.values(db.rows.generation_jobs).filter(({ originalsCleaned }) => originalsCleaned).length, 100);
});

test("清理过期准备凭证和分享口令", async () => {
  const { cleanup } = require(MAINTENANCE_PATH);
  const db = createDb([], [
    {
      _id: "expired-prep",
      expiresAt: daysAgo(1),
      uploadedFileIds: ["cloud://env/uploads/orphan/template.png"],
    },
    { _id: "live-prep", expiresAt: new Date(NOW.getTime() + 60_000) },
  ], [
    { _id: "expired-grant", expiresAt: daysAgo(1) },
    { _id: "live-grant", expiresAt: new Date(NOW.getTime() + 60_000) },
  ]);

  const cloud = createCloud();
  const result = await cleanup({ db, cloud, now: NOW });

  assert.equal(result.ephemeralRecordsRemoved, 2);
  assert.equal(db.rows.generation_preparations["expired-prep"], undefined);
  assert.ok(db.rows.generation_preparations["live-prep"]);
  assert.equal(db.rows.share_grants["expired-grant"], undefined);
  assert.ok(db.rows.share_grants["live-grant"]);
  assert.deepEqual(cloud.deleted, ["cloud://env/uploads/orphan/template.png"]);
});

test("部分文件删除失败时保留记录并继续处理后续任务", async () => {
  const { cleanup } = require(MAINTENANCE_PATH);
  const first = job("failed-delete-job", 31);
  const second = job("successful-job-1", 31);
  const db = createDb([first, second]);
  let call = 0;
  const cloud = createCloud((fileList) => {
    call += 1;
    return {
      fileList: fileList.map((fileID, index) => ({
        fileID,
        status: call === 1 && index === 0 ? -1 : 0,
      })),
    };
  });

  const result = await cleanup({ db, cloud, now: NOW });

  assert.equal(db.rows.generation_jobs[first._id].status, "succeeded");
  assert.equal(db.rows.generation_jobs[second._id].status, "expired");
  assert.ok(cloud.deleted.includes(first.resultFileId));
  assert.equal(result.jobsProcessed, 2);
  assert.equal(result.errors, 1);
});

test("重试清理时已不存在的文件按成功处理", async () => {
  const { cleanup } = require(MAINTENANCE_PATH);
  const old = job("already-gone-job", 31);
  const db = createDb([old]);
  const cloud = createCloud((fileList) => ({
    fileList: fileList.map((fileID) => ({
      fileID,
      status: -1,
      errCode: "STORAGE_FILE_NONEXIST",
    })),
  }));

  const result = await cleanup({ db, cloud, now: NOW });

  assert.equal(result.errors, 0);
  assert.equal(db.rows.generation_jobs[old._id].status, "expired");
});

test("兼容 wx-server-sdk 对文件不存在的真实包装结果", async () => {
  const { cleanup } = require(MAINTENANCE_PATH);
  const old = job("sdk-missing-file-job", 31);
  const db = createDb([old]);
  const cloud = createCloud((fileList) => ({
    fileList: fileList.map((fileID) => ({
      fileID,
      status: -503003,
      errMsg: "storage file not exists",
    })),
  }));

  const result = await cleanup({ db, cloud, now: NOW });

  assert.equal(result.errors, 0);
  assert.equal(db.rows.generation_jobs[old._id].status, "expired");
});

test("每日维护自动退款过期预占并释放调整名额", async () => {
  const { cleanup } = require(MAINTENANCE_PATH);
  const db = createMemoryDb();
  const source = job("source-for-stale-child", 1, {
    adjustmentReservedJobId: "stale-child-job-1",
  });
  db.seed("generation_jobs", source);
  db.seed("generation_jobs", {
    _id: "stale-child-job-1",
    jobId: "stale-child-job-1",
    _openid: "u1",
    status: "reserved",
    creditCost: 100,
    sourceJobId: source.jobId,
    isRegeneration: true,
    createdAt: daysAgo(1),
    reservationExpiresAt: daysAgo(1),
  });
  db.seed("users", {
    _id: "u1",
    _openid: "u1",
    credits: 200,
    trialGranted: true,
    createdAt: daysAgo(2),
    updatedAt: daysAgo(1),
  });

  const result = await cleanup({ db, cloud: createCloud(), now: NOW });

  assert.equal(result.reservationsRecovered, 1);
  assert.equal(db.rows("users").u1.credits, 300);
  assert.equal(db.rows("generation_jobs")[source.jobId].adjustmentReservedJobId, null);
  assert.equal(db.rows("generation_jobs")["stale-child-job-1"].status, "failed");
  assert.equal(
    Object.values(db.rows("credit_events")).filter(({ eventType }) => eventType === "generation_refund").length,
    1,
  );
});

test("正在执行一次调整时不清理源任务原图", async () => {
  const { cleanup } = require(MAINTENANCE_PATH);
  const source = job("active-adjustment-source", 8, {
    adjustmentReservedJobId: "adjustment-job-1234",
  });
  const db = createDb([source]);

  const result = await cleanup({ db, cloud: createCloud(), now: NOW });

  assert.equal(result.jobsProcessed, 0);
  assert.equal(db.rows.generation_jobs[source._id].originalsCleaned, false);
});

test("正在执行一次调整时即使超过结果保存期也暂不清理", async () => {
  const { cleanup } = require(MAINTENANCE_PATH);
  const source = job("old-active-adjustment", 31, {
    adjustmentReservedJobId: "adjustment-job-1234",
  });
  const db = createDb([source]);

  const result = await cleanup({ db, cloud: createCloud(), now: NOW });

  assert.equal(result.jobsProcessed, 0);
  assert.equal(db.rows.generation_jobs[source._id].status, "succeeded");
  assert.equal(db.rows.generation_jobs[source._id].originalsCleaned, false);
});

test("清理开始后并发调整不能再占用即将删除的原图", async () => {
  const { cleanup } = require(MAINTENANCE_PATH);
  const db = createMemoryDb();
  const source = job("cleanup-source-job", 8);
  db.seed("generation_jobs", source);
  db.seed("users", {
    _id: "u1",
    _openid: "u1",
    credits: 300,
    trialGranted: true,
    createdAt: daysAgo(9),
    updatedAt: daysAgo(9),
  });
  let releaseDeletion;
  let notifyDeletionStarted;
  let firstDeletion = true;
  const deletionStarted = new Promise((resolve) => { notifyDeletionStarted = resolve; });
  const cloud = {
    async deleteFile({ fileList }) {
      if (firstDeletion) {
        firstDeletion = false;
        notifyDeletionStarted();
        await new Promise((resolve) => { releaseDeletion = resolve; });
      }
      return { fileList: fileList.map((fileID) => ({ fileID, status: 0 })) };
    },
  };

  const cleanupPromise = cleanup({ db, cloud, now: NOW });
  await deletionStarted;
  await assert.rejects(
    () => reserveGeneration({
      db,
      openid: "u1",
      jobId: "new-adjust-job-1",
      templateFileId: source.templateFileId,
      petFileIds: source.petFileIds,
      adjustment: "眼神再委屈一点",
      sourceJobId: source.jobId,
      now: NOW,
    }),
    (error) => error.code === "invalid_source_job",
  );
  releaseDeletion();
  await cleanupPromise;

  assert.equal(db.rows("generation_jobs")[source.jobId].originalsCleaned, true);
});

test("旧结果积压时仍给旧原图保留清理名额", async () => {
  const { cleanup } = require(MAINTENANCE_PATH);
  const expired = Array.from({ length: 100 }, (_, index) =>
    job(`expired-${String(index).padStart(12, "0")}`, 31));
  const originals = Array.from({ length: 100 }, (_, index) =>
    job(`original-${String(index).padStart(12, "0")}`, 8));
  const db = createDb([...expired, ...originals]);

  const result = await cleanup({ db, cloud: createCloud(), now: NOW });

  assert.equal(result.jobsProcessed, 100);
  assert.equal(expired.filter(({ _id }) => db.rows.generation_jobs[_id].status === "expired").length, 50);
  assert.equal(originals.filter(({ _id }) => db.rows.generation_jobs[_id].originalsCleaned).length, 50);
});

test("维护函数拒绝带微信用户身份的客户端调用", () => {
  const { assertMaintenanceInvocationAllowed } = require(MAINTENANCE_PATH);

  assert.doesNotThrow(() => assertMaintenanceInvocationAllowed({}));
  assert.throws(
    () => assertMaintenanceInvocationAllowed({ OPENID: "ordinary-user" }),
    /scheduled invocation required/,
  );
});
