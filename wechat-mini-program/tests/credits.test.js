const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ensureUser,
  reserveGeneration,
  completeGeneration,
  refundGeneration,
} = require("../cloudfunctions/petMemeApi/domain/credits");
const { validateGenerationInput } = require("../cloudfunctions/petMemeApi/domain/validation");
const { bootstrap } = require("../cloudfunctions/petMemeApi/handlers/bootstrap");
const { createDatabase } = require("../cloudfunctions/petMemeApi/config");

const NOW = new Date("2026-09-05T08:00:00.000Z");

function clone(value) {
  return structuredClone(value);
}

function createMemoryDb() {
  let state = {
    users: {},
    generation_jobs: {},
    credit_events: {},
  };
  let transactionQueue = Promise.resolve();
  let rejectedEventType = null;

  function collectionFor(transactionState, name) {
    const rows = transactionState[name];
    if (!rows) throw new Error(`Unknown collection: ${name}`);

    return {
      doc(id) {
        return {
          async get() {
            return { data: rows[id] ? clone(rows[id]) : null };
          },
          async set({ data }) {
            if (name === "credit_events" && data.eventType === rejectedEventType) {
              throw new Error("credit event write failed");
            }
            rows[id] = { _id: id, ...clone(data) };
            return { stats: { created: 1, updated: 0 } };
          },
          async update({ data }) {
            if (!rows[id]) throw new Error(`Missing document: ${name}/${id}`);
            rows[id] = { ...rows[id], ...clone(data), _id: id };
            return { stats: { updated: 1 } };
          },
        };
      },
    };
  }

  const db = {
    async runTransaction(callback) {
      const run = transactionQueue.then(async () => {
        const transactionState = clone(state);
        const transaction = {
          collection(name) {
            return collectionFor(transactionState, name);
          },
        };
        const result = await callback(transaction);
        state = transactionState;
        return clone(result);
      });
      transactionQueue = run.catch(() => {});
      return run;
    },
    rejectEventTypeOnce(eventType) {
      rejectedEventType = eventType;
    },
    allowEvents() {
      rejectedEventType = null;
    },
  };

  Object.defineProperties(db, {
    users: { get: () => state.users },
    jobs: { get: () => state.generation_jobs },
    creditEvents: { get: () => Object.values(state.credit_events) },
  });

  return db;
}

function inputFor(db, jobId, overrides = {}) {
  return {
    db,
    openid: "u1",
    jobId,
    templateFileId: "cloud://env/uploads/template.jpg",
    petFileIds: ["cloud://env/uploads/pet-1.jpg"],
    adjustment: "",
    sourceJobId: null,
    now: NOW,
    ...overrides,
  };
}

test("CloudBase 数据库查询缺失文档时返回空结果", () => {
  const expectedDb = { runTransaction() {} };
  let databaseOptions;
  const cloud = {
    database(options) {
      databaseOptions = options;
      return expectedDb;
    },
  };

  const db = createDatabase(cloud);

  assert.equal(db, expectedDb);
  assert.deepEqual(databaseOptions, { throwOnNotFound: false });
});

test("新用户只领取一次 300 积分", async () => {
  const db = createMemoryDb();

  const first = await ensureUser({ db, openid: "u1", now: NOW });
  const second = await ensureUser({ db, openid: "u1", now: NOW });

  assert.equal(first.credits, 300);
  assert.equal(second.credits, 300);
  assert.equal(db.users.u1._id, "u1");
  assert.equal(db.creditEvents.filter((row) => row.eventType === "trial").length, 1);
});

test("bootstrap 返回当前微信用户的积分", async () => {
  const db = createMemoryDb();

  const result = await bootstrap({
    db,
    openid: "u1",
    now: NOW,
    recoverCallerStaleJobs: async () => ({ recovered: 0 }),
  });

  assert.deepEqual(result, { credits: 300 });
});

test("并发初始化仍只发放一次体验积分", async () => {
  const db = createMemoryDb();

  await Promise.all([
    ensureUser({ db, openid: "u1", now: NOW }),
    ensureUser({ db, openid: "u1", now: NOW }),
  ]);

  assert.equal(db.users.u1.credits, 300);
  assert.equal(db.creditEvents.filter((row) => row.eventType === "trial").length, 1);
});

test("同任务同用户并发预占只有一个调用获得执行权", async () => {
  const db = createMemoryDb();
  await ensureUser({ db, openid: "u1", now: NOW });

  const [first, second] = await Promise.all([
    reserveGeneration(inputFor(db, "job-123456789012")),
    reserveGeneration(inputFor(db, "job-123456789012")),
  ]);

  assert.equal(first.acquired, true);
  assert.equal(second.acquired, false);
  assert.equal(first.job.status, "reserved");
  assert.equal(second.job.status, "reserved");
  assert.deepEqual(first.job.reservationExpiresAt, new Date("2026-09-05T08:10:00.000Z"));
  assert.equal(db.jobs["job-123456789012"]._id, "job-123456789012");
  assert.equal(db.users.u1.credits, 200);
  assert.equal(db.creditEvents.filter((row) => row.eventType === "generation_reserve").length, 1);
});

test("同任务不同用户并发预占只有所有者成功", async () => {
  const db = createMemoryDb();

  const [owner, other] = await Promise.allSettled([
    reserveGeneration(inputFor(db, "job-123456789012")),
    reserveGeneration(inputFor(db, "job-123456789012", { openid: "u2" })),
  ]);

  assert.equal(owner.status, "fulfilled");
  assert.equal(owner.value.acquired, true);
  assert.equal(other.status, "rejected");
  assert.equal(other.reason.code, "job_conflict");
  assert.equal(db.jobs["job-123456789012"]._openid, "u1");
  assert.equal(db.users.u2, undefined);
});

test("同用户不同任务并发预占分别扣费", async () => {
  const db = createMemoryDb();
  await ensureUser({ db, openid: "u1", now: NOW });

  const results = await Promise.all([
    reserveGeneration(inputFor(db, "job-123456789001")),
    reserveGeneration(inputFor(db, "job-123456789002")),
  ]);

  assert.deepEqual(results.map(({ acquired }) => acquired), [true, true]);
  assert.deepEqual(results.map(({ job }) => job.jobId), ["job-123456789001", "job-123456789002"]);
  assert.equal(db.users.u1.credits, 100);
  assert.equal(db.creditEvents.filter((row) => row.eventType === "generation_reserve").length, 2);
});

test("余额不足时不创建任务或积分流水", async () => {
  const db = createMemoryDb();
  await ensureUser({ db, openid: "u1", now: NOW });
  await reserveGeneration(inputFor(db, "job-123456789001"));
  await reserveGeneration(inputFor(db, "job-123456789002"));
  await reserveGeneration(inputFor(db, "job-123456789003"));

  await assert.rejects(
    () => reserveGeneration(inputFor(db, "job-123456789004")),
    (error) => error.code === "insufficient_credits",
  );

  assert.equal(db.users.u1.credits, 0);
  assert.equal(db.jobs["job-123456789004"], undefined);
  assert.equal(db.creditEvents.filter((row) => row.eventType === "generation_reserve").length, 3);
});

test("预占积分和流水写入任一失败时全部回滚", async () => {
  const db = createMemoryDb();
  await ensureUser({ db, openid: "u1", now: NOW });
  db.rejectEventTypeOnce("generation_reserve");

  await assert.rejects(
    () => reserveGeneration(inputFor(db, "job-123456789012")),
    /credit event write failed/,
  );

  assert.equal(db.users.u1.credits, 300);
  assert.equal(db.jobs["job-123456789012"], undefined);
  assert.equal(db.creditEvents.filter((row) => row.eventType === "generation_reserve").length, 0);
});

test("生成成功只完成一次且不再次改变余额", async () => {
  const db = createMemoryDb();
  await reserveGeneration(inputFor(db, "job-123456789012"));

  const first = await completeGeneration({
    db,
    openid: "u1",
    jobId: "job-123456789012",
    resultFileId: "cloud://env/results/job.png",
    now: NOW,
  });
  const second = await completeGeneration({
    db,
    openid: "u1",
    jobId: "job-123456789012",
    resultFileId: "cloud://env/results/job.png",
    now: NOW,
  });

  assert.equal(first.status, "succeeded");
  assert.equal(second.status, "succeeded");
  assert.equal(db.users.u1.credits, 200);
  assert.equal(db.creditEvents.filter((row) => row.eventType === "generation_success").length, 1);
});

test("生成失败只退款一次", async () => {
  const db = createMemoryDb();
  await reserveGeneration(inputFor(db, "job-123456789012"));

  const first = await refundGeneration({
    db,
    openid: "u1",
    jobId: "job-123456789012",
    errorCode: "provider_failed",
    now: NOW,
  });
  const second = await refundGeneration({
    db,
    openid: "u1",
    jobId: "job-123456789012",
    errorCode: "provider_failed",
    now: NOW,
  });

  assert.equal(first.status, "failed");
  assert.equal(second.status, "failed");
  assert.equal(first.refunded, true);
  assert.equal(second.refunded, false);
  assert.equal(db.users.u1.credits, 300);
  assert.equal(db.creditEvents.filter((row) => row.eventType === "generation_refund").length, 1);
});

test("完成与退款竞态只提交第一个终态", async () => {
  for (const firstAction of ["complete", "refund"]) {
    const db = createMemoryDb();
    await reserveGeneration(inputFor(db, "job-123456789012"));
    const complete = () => completeGeneration({
      db,
      openid: "u1",
      jobId: "job-123456789012",
      resultFileId: "cloud://env/results/job.png",
      now: NOW,
    });
    const refund = () => refundGeneration({
      db,
      openid: "u1",
      jobId: "job-123456789012",
      errorCode: "provider_failed",
      now: NOW,
    });
    const operations = firstAction === "complete" ? [complete(), refund()] : [refund(), complete()];

    const outcomes = await Promise.all(operations);

    const expectedStatus = firstAction === "complete" ? "succeeded" : "failed";
    const expectedBalance = firstAction === "complete" ? 200 : 300;
    assert.deepEqual(outcomes.map(({ status }) => status), [expectedStatus, expectedStatus]);
    assert.equal(db.jobs["job-123456789012"].status, expectedStatus);
    assert.equal(db.users.u1.credits, expectedBalance);
    assert.equal(db.creditEvents.filter((row) => row.eventType === "generation_success").length, firstAction === "complete" ? 1 : 0);
    assert.equal(db.creditEvents.filter((row) => row.eventType === "generation_refund").length, firstAction === "refund" ? 1 : 0);
  }
});

test("生成输入校验后返回按模板优先排列的云文件", () => {
  const result = validateGenerationInput({
    jobId: "job-123456789012",
    templateFileId: "cloud://env/uploads/template.jpg",
    petFileIds: [
      "cloud://env/uploads/pet-1.jpg",
      "cloud://env/uploads/pet-2.jpg",
    ],
    templateWidth: 1080,
    templateHeight: 1080,
    rightsConfirmed: true,
    adjustment: "  额头白色花纹更明显  ",
  });

  assert.deepEqual(result, {
    fileIds: [
      "cloud://env/uploads/template.jpg",
      "cloud://env/uploads/pet-1.jpg",
      "cloud://env/uploads/pet-2.jpg",
    ],
    adjustment: "额头白色花纹更明显",
  });
});

test("生成输入拒绝非法任务编号、文件、比例、权利和超长调整", () => {
  const valid = {
    jobId: "job-123456789012",
    templateFileId: "cloud://env/uploads/template.jpg",
    petFileIds: ["cloud://env/uploads/pet-1.jpg"],
    templateWidth: 1080,
    templateHeight: 1080,
    rightsConfirmed: true,
    adjustment: "",
  };
  const invalidCases = [
    { ...valid, jobId: "short" },
    { ...valid, jobId: "job_123456789012" },
    { ...valid, jobId: 1234567890123456 },
    { ...valid, templateFileId: "" },
    { ...valid, templateFileId: "https://example.com/template.jpg" },
    { ...valid, petFileIds: [] },
    { ...valid, petFileIds: [...valid.petFileIds, "cloud://pet-2", "cloud://pet-3", "cloud://pet-4"] },
    { ...valid, petFileIds: ["cloud://pet-1", ""] },
    { ...valid, rightsConfirmed: false },
    { ...valid, adjustment: "猫".repeat(301) },
  ];

  for (const event of invalidCases) {
    assert.throws(
      () => validateGenerationInput(event),
      (error) => error.code === "invalid_input",
    );
  }
});
