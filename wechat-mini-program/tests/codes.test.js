const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createCodes,
  redeemCode,
  listCodes,
  disableCode,
} = require("../cloudfunctions/petMemeApi/domain/codes");
const { redeem } = require("../cloudfunctions/petMemeApi/handlers/redeem");
const {
  adminCreateCodes,
  adminListCodes,
  adminDisableCode,
} = require("../cloudfunctions/petMemeApi/handlers/admin");

const NOW = new Date("2026-09-05T08:00:00.000Z");
const NEXT = new Date("2026-09-05T09:00:00.000Z");
const KNOWN_BYTES = Buffer.from("00112233445566778899aabb", "hex");
const KNOWN_CODE = "ABEiM0RVZneImaq7";
const KNOWN_HASH = "e5a982f63ffcacbadc82823b01bb5e7f0a62714ec8b42616d12540100bd97286";

function clone(value) {
  return structuredClone(value);
}

function createMemoryDb() {
  let state = {
    users: {},
    redemption_codes: {},
    credit_events: {},
  };
  let transactionQueue = Promise.resolve();
  let rejectedEventType = null;
  let rejectedCodeSetNumber = null;
  let codeSetCount = 0;

  function collectionFor(transactionState, name) {
    const rows = transactionState[name];
    if (!rows) throw new Error(`Unknown collection: ${name}`);

    let orderings = [];
    let offset = 0;
    let pageSize = Infinity;

    const collection = {
      doc(id) {
        return {
          async get() {
            return { data: rows[id] ? clone(rows[id]) : null };
          },
          async set({ data }) {
            if (name === "credit_events" && data.eventType === rejectedEventType) {
              throw new Error("credit event write failed");
            }
            if (name === "redemption_codes") {
              codeSetCount += 1;
              if (codeSetCount === rejectedCodeSetNumber) {
                throw new Error("redemption code write failed");
              }
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
      orderBy(field, direction) {
        orderings.push({ field, direction });
        return collection;
      },
      skip(value) {
        offset = value;
        return collection;
      },
      limit(value) {
        pageSize = value;
        return collection;
      },
      async get() {
        const data = Object.values(rows).map(clone);
        data.sort((left, right) => {
          for (const { field, direction } of orderings) {
            const leftValue = left[field] instanceof Date ? left[field].getTime() : left[field];
            const rightValue = right[field] instanceof Date ? right[field].getTime() : right[field];
            if (leftValue === rightValue) continue;
            const comparison = leftValue < rightValue ? -1 : 1;
            return direction === "desc" ? -comparison : comparison;
          }
          return 0;
        });
        return { data: data.slice(offset, offset + pageSize) };
      },
    };
    return collection;
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
    collection(name) {
      return collectionFor(state, name);
    },
    rejectEventType(eventType) {
      rejectedEventType = eventType;
    },
    rejectCodeSetNumber(number) {
      rejectedCodeSetNumber = number;
    },
    allowWrites() {
      rejectedEventType = null;
      rejectedCodeSetNumber = null;
      codeSetCount = 0;
    },
  };

  Object.defineProperties(db, {
    users: { get: () => state.users },
    codes: { get: () => state.redemption_codes },
    creditEvents: { get: () => Object.values(state.credit_events) },
  });

  return db;
}

function codeIdFor(index) {
  return index.toString(16).padStart(64, "0");
}

function createPagedListDb() {
  const documents = [];
  for (let index = 204; index >= 0; index -= 1) {
    const codeId = codeIdFor(index);
    documents.push({
      _id: codeId,
      codeHash: codeId,
      codeHint: `C${String(index).padStart(3, "0")}...SAFE`,
      codePlaintext: `SECRET-${index}`,
      credits: 1000,
      status: index % 2 === 0 ? "unused" : "redeemed",
      redeemedBy: index % 2 === 0 ? null : `user-${index}`,
      redeemedAt: index % 2 === 0 ? null : NEXT,
      createdBy: "owner",
      createdAt: index >= 100 ? NEXT : NOW,
    });
  }

  const calls = [];
  return {
    calls,
    collection(name) {
      assert.equal(name, "redemption_codes");
      let orderings = [];
      let offset = 0;
      let requestedLimit;
      const query = {
        orderBy(field, direction) {
          orderings.push({ field, direction });
          return query;
        },
        skip(value) {
          offset = value;
          return query;
        },
        limit(value) {
          requestedLimit = value;
          return query;
        },
        async get() {
          const servicePageLimit = 100;
          const effectiveLimit = Math.min(requestedLimit || servicePageLimit, servicePageLimit);
          const sorted = documents.slice();
          sorted.sort((left, right) => {
            for (const { field, direction } of orderings) {
              const leftValue = left[field] instanceof Date ? left[field].getTime() : left[field];
              const rightValue = right[field] instanceof Date ? right[field].getTime() : right[field];
              if (leftValue === rightValue) continue;
              const comparison = leftValue < rightValue ? -1 : 1;
              return direction === "desc" ? -comparison : comparison;
            }
            return 0;
          });
          calls.push({ orderings: clone(orderings), offset, limit: requestedLimit });
          return { data: sorted.slice(offset, offset + effectiveLimit).map(clone) };
        },
      };
      return query;
    },
  };
}

function fixedRandomBytes() {
  return Buffer.from(KNOWN_BYTES);
}

function sequentialRandomBytes() {
  let byte = 0;
  return (size) => {
    byte += 1;
    return Buffer.alloc(size, byte);
  };
}

test.beforeEach(() => {
  process.env.ADMIN_OPENIDS = " owner, backup-owner, owner ";
});

test.afterEach(() => {
  delete process.env.ADMIN_OPENIDS;
});

test("创建兑换码只返回一次明文，数据库只保存哈希与提示", async () => {
  const db = createMemoryDb();

  const [created] = await createCodes({
    db,
    adminOpenid: "owner",
    count: 1,
    credits: 1000,
    now: NOW,
    randomBytes: fixedRandomBytes,
  });

  assert.equal(created.code, KNOWN_CODE);
  assert.equal(created.codeId, KNOWN_HASH);
  assert.equal(created.codeHint, "ABEi...maq7");
  assert.equal(db.codes[KNOWN_HASH].codeHash, KNOWN_HASH);
  assert.equal(db.codes[KNOWN_HASH].codeHint, "ABEi...maq7");
  assert.equal(JSON.stringify(db.codes), JSON.stringify(db.codes).replaceAll(KNOWN_CODE, ""));
});

test("1000 积分兑换码只能兑换一次", async () => {
  const db = createMemoryDb();
  const [created] = await createCodes({
    db,
    adminOpenid: "owner",
    count: 1,
    credits: 1000,
    now: NOW,
    randomBytes: fixedRandomBytes,
  });

  const balance = await redeemCode({
    db,
    openid: "u1",
    plaintextCode: created.code,
    now: NEXT,
  });

  assert.equal(balance.credits, 1300);
  assert.equal(db.codes[created.codeId].status, "redeemed");
  assert.equal(db.codes[created.codeId].redeemedBy, "u1");
  assert.equal(db.creditEvents.filter((row) => row.eventType === "redeem").length, 1);
  await assert.rejects(
    () => redeemCode({ db, openid: "u2", plaintextCode: created.code, now: NEXT }),
    (error) => error.code === "code_redeemed",
  );
  assert.equal(db.users.u2, undefined);
  assert.equal(db.creditEvents.filter((row) => row.eventType === "redeem").length, 1);
});

test("同一用户重试兑换不会重复充值", async () => {
  const db = createMemoryDb();
  const [created] = await createCodes({
    db,
    adminOpenid: "owner",
    count: 1,
    credits: 1000,
    now: NOW,
    randomBytes: fixedRandomBytes,
  });

  await redeemCode({ db, openid: "u1", plaintextCode: created.code, now: NEXT });
  await assert.rejects(
    () => redeemCode({ db, openid: "u1", plaintextCode: created.code, now: NEXT }),
    (error) => error.code === "code_redeemed",
  );

  assert.equal(db.users.u1.credits, 1300);
  assert.equal(db.creditEvents.filter((row) => row.eventType === "redeem").length, 1);
});

test("兑换流水写入失败时兑换码和余额全部回滚", async () => {
  const db = createMemoryDb();
  const [created] = await createCodes({
    db,
    adminOpenid: "owner",
    count: 1,
    credits: 1000,
    now: NOW,
    randomBytes: fixedRandomBytes,
  });
  db.rejectEventType("redeem");

  await assert.rejects(
    () => redeemCode({ db, openid: "u1", plaintextCode: created.code, now: NEXT }),
    /credit event write failed/,
  );

  assert.equal(db.codes[created.codeId].status, "unused");
  assert.equal(db.users.u1, undefined);
  assert.equal(db.creditEvents.filter((row) => row.eventType === "redeem").length, 0);

  db.allowWrites();
  const balance = await redeemCode({ db, openid: "u1", plaintextCode: created.code, now: NEXT });
  assert.equal(balance.credits, 1300);
});

test("批量创建中任一写入失败时不留下部分兑换码", async () => {
  const db = createMemoryDb();
  db.rejectCodeSetNumber(2);

  await assert.rejects(
    () => createCodes({
      db,
      adminOpenid: "owner",
      count: 3,
      credits: 1000,
      now: NOW,
      randomBytes: sequentialRandomBytes(),
    }),
    /redemption code write failed/,
  );

  assert.deepEqual(db.codes, {});
});

test("非管理员不能创建、查看或停用兑换码", async () => {
  const db = createMemoryDb();

  await assert.rejects(
    () => createCodes({ db, adminOpenid: "u1", count: 1, credits: 1000, now: NOW }),
    (error) => error.code === "forbidden",
  );
  await assert.rejects(
    () => listCodes({ db, adminOpenid: "u1" }),
    (error) => error.code === "forbidden",
  );
  await assert.rejects(
    () => disableCode({ db, adminOpenid: "u1", codeId: KNOWN_HASH, now: NOW }),
    (error) => error.code === "forbidden",
  );
});

test("管理员名单缺失或为空时拒绝所有管理员操作", async () => {
  const db = createMemoryDb();

  for (const value of [undefined, "", " , "]) {
    if (value === undefined) delete process.env.ADMIN_OPENIDS;
    else process.env.ADMIN_OPENIDS = value;
    await assert.rejects(
      () => createCodes({ db, adminOpenid: "owner", count: 1, credits: 1000, now: NOW }),
      (error) => error.code === "admin_not_configured",
    );
  }
});

test("创建数量和积分值必须在允许范围内", async () => {
  const db = createMemoryDb();
  const invalidInputs = [
    { count: 0, credits: 1000 },
    { count: 51, credits: 1000 },
    { count: 1.5, credits: 1000 },
    { count: 1, credits: 0 },
    { count: 1, credits: 150 },
    { count: 1, credits: 10100 },
  ];

  for (const input of invalidInputs) {
    await assert.rejects(
      () => createCodes({ db, adminOpenid: "owner", ...input, now: NOW }),
      (error) => error.code === "invalid_input",
    );
  }
  assert.deepEqual(db.codes, {});
});

test("无效、已停用和已兑换的兑换码返回不同错误且不改余额", async () => {
  const db = createMemoryDb();

  await assert.rejects(
    () => redeemCode({ db, openid: "u1", plaintextCode: "not-a-real-code", now: NEXT }),
    (error) => error.code === "invalid_code",
  );
  assert.equal(db.users.u1, undefined);

  const [disabled] = await createCodes({
    db,
    adminOpenid: "owner",
    count: 1,
    credits: 1000,
    now: NOW,
    randomBytes: fixedRandomBytes,
  });
  await disableCode({ db, adminOpenid: "owner", codeId: disabled.codeId, now: NEXT });
  await assert.rejects(
    () => redeemCode({ db, openid: "u1", plaintextCode: disabled.code, now: NEXT }),
    (error) => error.code === "code_disabled",
  );
  assert.equal(db.users.u1, undefined);
});

test("列表只返回管理所需字段且永不包含兑换码明文", async () => {
  const db = createMemoryDb();
  const created = await createCodes({
    db,
    adminOpenid: "owner",
    count: 2,
    credits: 1000,
    now: NOW,
    randomBytes: sequentialRandomBytes(),
  });
  await redeemCode({ db, openid: "u1", plaintextCode: created[0].code, now: NEXT });

  const summaries = await listCodes({ db, adminOpenid: "backup-owner" });

  assert.equal(summaries.length, 2);
  for (const summary of summaries) {
    assert.deepEqual(
      Object.keys(summary).sort(),
      ["codeHint", "codeId", "credits", "redeemedAt", "status"],
    );
  }
  for (const item of created) {
    assert.equal(JSON.stringify(summaries).includes(item.code), false);
  }
  assert.equal(JSON.stringify(summaries).includes("codeHash"), false);
  assert.equal(JSON.stringify(summaries).includes("redeemedBy"), false);
  assert.equal(JSON.stringify(summaries).includes("createdBy"), false);
});

test("列表分页读取超过 100 个兑换码并保持确定顺序和安全字段", async () => {
  const db = createPagedListDb();

  const summaries = await listCodes({ db, adminOpenid: "owner" });

  const expectedIds = [
    ...Array.from({ length: 105 }, (_, index) => codeIdFor(index + 100)),
    ...Array.from({ length: 100 }, (_, index) => codeIdFor(index)),
  ];
  assert.equal(summaries.length, 205);
  assert.deepEqual(summaries.map(({ codeId }) => codeId), expectedIds);
  assert.equal(new Set(summaries.map(({ codeId }) => codeId)).size, 205);
  assert.deepEqual(db.calls, [
    {
      orderings: [
        { field: "createdAt", direction: "desc" },
        { field: "_id", direction: "asc" },
      ],
      offset: 0,
      limit: 100,
    },
    {
      orderings: [
        { field: "createdAt", direction: "desc" },
        { field: "_id", direction: "asc" },
      ],
      offset: 100,
      limit: 100,
    },
    {
      orderings: [
        { field: "createdAt", direction: "desc" },
        { field: "_id", direction: "asc" },
      ],
      offset: 200,
      limit: 100,
    },
  ]);
  for (const summary of summaries) {
    assert.deepEqual(
      Object.keys(summary).sort(),
      ["codeHint", "codeId", "credits", "redeemedAt", "status"],
    );
  }
  assert.equal(JSON.stringify(summaries).includes("SECRET-"), false);
});

test("未使用兑换码可停用且重复停用保持幂等，已兑换码不可停用", async () => {
  const db = createMemoryDb();
  const created = await createCodes({
    db,
    adminOpenid: "owner",
    count: 2,
    credits: 1000,
    now: NOW,
    randomBytes: sequentialRandomBytes(),
  });

  const first = await disableCode({
    db,
    adminOpenid: "owner",
    codeId: created[0].codeId,
    now: NEXT,
  });
  const second = await disableCode({
    db,
    adminOpenid: "owner",
    codeId: created[0].codeId,
    now: NEXT,
  });
  assert.equal(first.status, "disabled");
  assert.deepEqual(second, first);

  await redeemCode({ db, openid: "u1", plaintextCode: created[1].code, now: NEXT });
  await assert.rejects(
    () => disableCode({
      db,
      adminOpenid: "owner",
      codeId: created[1].codeId,
      now: NEXT,
    }),
    (error) => error.code === "code_redeemed",
  );
});

test("兑换与管理员处理器使用调用者微信身份", async () => {
  const db = createMemoryDb();
  const [created] = await adminCreateCodes({
    db,
    openid: "owner",
    count: 1,
    credits: 1000,
    now: NOW,
    randomBytes: fixedRandomBytes,
  });

  const balance = await redeem({ db, openid: "u1", code: created.code, now: NEXT });
  const listed = await adminListCodes({ db, openid: "owner" });
  const disabledDb = createMemoryDb();
  const [unused] = await adminCreateCodes({
    db: disabledDb,
    openid: "owner",
    count: 1,
    credits: 1000,
    now: NOW,
    randomBytes: fixedRandomBytes,
  });
  const disabled = await adminDisableCode({
    db: disabledDb,
    openid: "owner",
    codeId: unused.codeId,
    now: NEXT,
  });

  assert.equal(balance.credits, 1300);
  assert.equal(listed[0].status, "redeemed");
  assert.equal(disabled.status, "disabled");
});
