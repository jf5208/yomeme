const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  prepareGeneration,
  generate,
  extractCloudPath,
  validateDownloadedImage,
} = require("../cloudfunctions/petMemeApi/handlers/generate");
const { getResult, prepareShare } = require("../cloudfunctions/petMemeApi/handlers/result");
const {
  recoverCallerStaleJobs,
  recoverStaleJobs,
} = require("../cloudfunctions/petMemeApi/handlers/recover");
const { bootstrap } = require("../cloudfunctions/petMemeApi/handlers/bootstrap");
const { createMemoryDb } = require("./helpers/cloud-memory-db");

const NOW = new Date("2026-09-05T08:20:00.000Z");
const EXPIRED = new Date("2026-09-05T08:00:00.000Z");
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);

function firstEvent(openid = "u1") {
  const jobId = "job-123456789012";
  return {
    jobId,
    templateFileId: `cloud://env/uploads/${jobId}/template.png`,
    petFileIds: [
      `cloud://env/uploads/${jobId}/pet-1.jpg`,
      `cloud://env/uploads/${jobId}/pet-2.jpg`,
    ],
    templateWidth: 1080,
    templateHeight: 1080,
    rightsConfirmed: true,
    adjustment: "",
    openid,
  };
}

function createCloud(files = {}) {
  const calls = { downloads: [], uploads: [], tempUrls: [] };
  return {
    calls,
    async downloadFile({ fileID }) {
      calls.downloads.push(fileID);
      if (!(fileID in files)) throw new Error("missing cloud file");
      return { fileContent: files[fileID] };
    },
    async uploadFile({ cloudPath, fileContent }) {
      calls.uploads.push({ cloudPath, fileContent });
      return { fileID: `cloud://env/${cloudPath}` };
    },
    async getTempFileURL({ fileList }) {
      calls.tempUrls.push([...fileList]);
      return {
        fileList: fileList.map((fileID) => ({
          fileID,
          status: 0,
          tempFileURL: `https://temp.example/${encodeURIComponent(fileID)}`,
        })),
      };
    },
  };
}

function seedSucceededJob(db, overrides = {}) {
  const job = {
    _id: "source-job-1234567",
    jobId: "source-job-1234567",
    _openid: "u1",
    status: "succeeded",
    creditCost: 100,
    templateFileId: "cloud://env/uploads/source-job-1234567/template.png",
    petFileIds: ["cloud://env/uploads/source-job-1234567/pet-1.jpg"],
    resultFileId: "cloud://env/results/u1/source-job-1234567.png",
    adjustment: "",
    sourceJobId: null,
    isRegeneration: false,
    errorCode: null,
    createdAt: EXPIRED,
    completedAt: NOW,
    reservationExpiresAt: EXPIRED,
    ...overrides,
  };
  db.seed("generation_jobs", job);
  return job;
}

test("prepareGeneration 只返回服务端 UUID 且不预占积分", async () => {
  const db = createMemoryDb();
  const expected = "11111111-2222-4333-8444-555555555555";

  const result = await prepareGeneration({
    db,
    openid: "u1",
    randomUUID: () => expected,
    now: NOW,
  });

  assert.deepEqual(result, { jobId: expected });
  assert.deepEqual(db.rows("generation_jobs"), {});
  assert.deepEqual(db.rows("credit_events"), {});
});

test("首次生成成功后扣 100 积分、保存固定结果路径并完成任务", async () => {
  const db = createMemoryDb();
  const event = firstEvent();
  const cloud = createCloud({
    [event.templateFileId]: PNG,
    [event.petFileIds[0]]: JPEG,
    [event.petFileIds[1]]: JPEG,
  });
  const modelCalls = [];

  const result = await generate({
    db,
    cloud,
    openid: "u1",
    event,
    now: NOW,
    generateImage: async (input) => {
      modelCalls.push(input);
      return { bytes: PNG, mimeType: "image/png" };
    },
  });

  assert.deepEqual(result, { jobId: event.jobId, status: "succeeded" });
  assert.equal(db.rows("users").u1.credits, 200);
  assert.equal(db.rows("generation_jobs")[event.jobId].status, "succeeded");
  assert.equal(
    db.rows("generation_jobs")[event.jobId].resultFileId,
    `cloud://env/results/u1/${event.jobId}.png`,
  );
  assert.deepEqual(cloud.calls.uploads.map(({ cloudPath }) => cloudPath), [
    `results/u1/${event.jobId}.png`,
  ]);
  assert.deepEqual(modelCalls[0].images.map(({ mimeType }) => mimeType), [
    "image/png",
    "image/jpeg",
    "image/jpeg",
  ]);
});

test("相同 jobId 重试只返回已有状态且不重复外部工作或扣费", async () => {
  const db = createMemoryDb();
  const event = firstEvent();
  const cloud = createCloud({
    [event.templateFileId]: PNG,
    [event.petFileIds[0]]: JPEG,
    [event.petFileIds[1]]: JPEG,
  });
  let modelCalls = 0;
  const input = {
    db,
    cloud,
    openid: "u1",
    event,
    now: NOW,
    generateImage: async () => {
      modelCalls += 1;
      return { bytes: PNG, mimeType: "image/png" };
    },
  };

  const first = await generate(input);
  const second = await generate(input);

  assert.deepEqual(first, second);
  assert.equal(modelCalls, 1);
  assert.equal(cloud.calls.downloads.length, 3);
  assert.equal(cloud.calls.uploads.length, 1);
  assert.equal(db.rows("users").u1.credits, 200);
});

test("预占后的任意失败都会幂等退款并只保存安全错误码", async () => {
  const db = createMemoryDb();
  const event = firstEvent();
  const cloud = createCloud({
    [event.templateFileId]: PNG,
    [event.petFileIds[0]]: JPEG,
    [event.petFileIds[1]]: JPEG,
  });

  await assert.rejects(
    () => generate({
      db,
      cloud,
      openid: "u1",
      event,
      now: NOW,
      generateImage: async () => {
        throw new Error("ARK_API_KEY=secret and raw provider payload");
      },
    }),
    (error) => error.code === "generation_failed"
      && error.message === "生成失败，本次未扣积分。",
  );

  assert.equal(db.rows("users").u1.credits, 300);
  assert.equal(db.rows("generation_jobs")[event.jobId].status, "failed");
  assert.equal(db.rows("generation_jobs")[event.jobId].errorCode, "generation_failed");
  assert.equal(JSON.stringify(db.rows("generation_jobs")).includes("secret"), false);
});

test("首次生成只接受当前 jobId 的固定上传目录和文件名", async () => {
  const valid = firstEvent();
  assert.equal(extractCloudPath(valid.templateFileId), `uploads/${valid.jobId}/template.png`);

  const invalidEvents = [
    { ...valid, templateFileId: "cloud://env/uploads/other-job/template.png" },
    { ...valid, templateFileId: `cloud://env/private/${valid.jobId}/template.png` },
    { ...valid, templateFileId: `cloud://env/uploads/${valid.jobId}/pet-1.jpg` },
    { ...valid, petFileIds: [`cloud://env/uploads/${valid.jobId}/pet-2.jpg`] },
    { ...valid, petFileIds: [
      `cloud://env/uploads/${valid.jobId}/pet-1.jpg`,
      `cloud://env/uploads/${valid.jobId}/pet-1.jpg`,
    ] },
    { ...valid, petFileIds: [`cloud://env/uploads/${valid.jobId}/pet-1.exe`] },
    { ...valid, templateFileId: `cloud://env/uploads/${valid.jobId}/template.png?token=x` },
  ];

  for (const event of invalidEvents) {
    const db = createMemoryDb();
    const cloud = createCloud();
    await assert.rejects(
      () => generate({
        db,
        cloud,
        openid: "u1",
        event,
        now: NOW,
        generateImage: async () => ({ bytes: PNG, mimeType: "image/png" }),
      }),
      (error) => error.code === "invalid_input",
    );
    assert.deepEqual(db.rows("generation_jobs"), {});
    assert.equal(cloud.calls.downloads.length, 0);
  }
});

test("下载内容必须是 Buffer 且具有可信图片签名", () => {
  assert.deepEqual(validateDownloadedImage({ fileContent: PNG }), {
    bytes: PNG,
    mimeType: "image/png",
  });
  assert.throws(
    () => validateDownloadedImage({ fileContent: Buffer.from("not-image") }),
    (error) => error.code === "invalid_image",
  );
  assert.throws(
    () => validateDownloadedImage({ fileContent: "base64-string" }),
    (error) => error.code === "invalid_image",
  );
});

test("下载到伪图片后不会调用模型且自动退款", async () => {
  const db = createMemoryDb();
  const event = firstEvent();
  const cloud = createCloud({
    [event.templateFileId]: Buffer.from("not-image"),
    [event.petFileIds[0]]: JPEG,
    [event.petFileIds[1]]: JPEG,
  });
  let modelCalls = 0;

  await assert.rejects(
    () => generate({
      db,
      cloud,
      openid: "u1",
      event,
      now: NOW,
      generateImage: async () => { modelCalls += 1; },
    }),
    (error) => error.code === "generation_failed",
  );

  assert.equal(modelCalls, 0);
  assert.equal(db.rows("users").u1.credits, 300);
  assert.equal(db.rows("generation_jobs")[event.jobId].errorCode, "invalid_image");
});

test("调整再生成只使用已授权成功原任务中保存的素材", async () => {
  const db = createMemoryDb();
  const source = seedSucceededJob(db);
  db.seed("users", {
    _id: "u1",
    _openid: "u1",
    credits: 200,
    trialGranted: true,
    createdAt: EXPIRED,
    updatedAt: EXPIRED,
  });
  const event = {
    ...firstEvent(),
    jobId: "regen-job-12345678",
    sourceJobId: source.jobId,
    templateFileId: "cloud://env/uploads/regen-job-12345678/template.png",
    petFileIds: ["cloud://env/uploads/regen-job-12345678/pet-1.jpg"],
    adjustment: "耳朵更像原宠物",
  };
  const cloud = createCloud({
    [source.templateFileId]: PNG,
    [source.petFileIds[0]]: JPEG,
  });
  let modelInput;

  await generate({
    db,
    cloud,
    openid: "u1",
    event,
    now: NOW,
    generateImage: async (input) => {
      modelInput = input;
      return { bytes: PNG, mimeType: "image/png" };
    },
  });

  assert.deepEqual(cloud.calls.downloads, [source.templateFileId, ...source.petFileIds]);
  assert.equal(modelInput.adjustment, "耳朵更像原宠物");
  const regeneration = db.rows("generation_jobs")[event.jobId];
  assert.equal(regeneration.sourceJobId, source.jobId);
  assert.equal(regeneration.templateFileId, source.templateFileId);
  assert.deepEqual(regeneration.petFileIds, source.petFileIds);
});

test("调整再生成拒绝他人的或未成功的原任务且不预占积分", async () => {
  for (const sourceOverrides of [
    { _openid: "another-user" },
    { status: "failed" },
  ]) {
    const db = createMemoryDb();
    const source = seedSucceededJob(db, sourceOverrides);
    const event = {
      jobId: "regen-job-12345678",
      sourceJobId: source.jobId,
      rightsConfirmed: true,
      adjustment: "更像一点",
    };

    await assert.rejects(
      () => generate({
        db,
        cloud: createCloud(),
        openid: "u1",
        event,
        now: NOW,
        generateImage: async () => ({ bytes: PNG, mimeType: "image/png" }),
      }),
      (error) => ["forbidden", "invalid_source_job"].includes(error.code),
    );
    assert.equal(db.rows("generation_jobs")[event.jobId], undefined);
  }
});

test("分享口令只保存哈希，非所有者必须持正确口令且只能读脱敏结果", async () => {
  const db = createMemoryDb();
  const job = seedSucceededJob(db);
  const cloud = createCloud();
  const tokenBytes = Buffer.from("00112233445566778899aabbccddeeff0011", "hex");
  const plaintext = tokenBytes.toString("base64url");

  const share = await prepareShare({
    db,
    openid: "u1",
    jobId: job.jobId,
    randomBytes: () => tokenBytes,
    now: NOW,
  });

  assert.deepEqual(share, { jobId: job.jobId, token: plaintext });
  const stored = db.rows("generation_jobs")[job.jobId];
  assert.equal(stored.shareTokenHash, crypto.createHash("sha256").update(plaintext).digest("hex"));
  assert.equal(JSON.stringify(stored).includes(plaintext), false);

  await assert.rejects(
    () => getResult({ db, cloud, openid: "u2", jobId: job.jobId, token: "wrong" }),
    (error) => error.code === "forbidden",
  );
  const shared = await getResult({
    db,
    cloud,
    openid: "u2",
    jobId: job.jobId,
    token: plaintext,
  });
  assert.deepEqual(Object.keys(shared).sort(), [
    "generatedAt",
    "imageUrl",
    "jobId",
    "readOnly",
    "status",
  ]);
  assert.equal(shared.readOnly, true);
  assert.equal(shared.imageUrl.startsWith("https://temp.example/"), true);
  assert.equal(JSON.stringify(shared).includes("uploads/"), false);
  assert.equal(JSON.stringify(shared).includes("shareTokenHash"), false);

  const owner = await getResult({ db, cloud, openid: "u1", jobId: job.jobId });
  assert.equal(owner.readOnly, false);
});

test("只有所有者能创建分享口令且任务必须已成功", async () => {
  for (const overrides of [{ _openid: "u2" }, { status: "reserved" }]) {
    const db = createMemoryDb();
    const job = seedSucceededJob(db, overrides);
    await assert.rejects(
      () => prepareShare({ db, openid: "u1", jobId: job.jobId }),
      (error) => ["forbidden", "result_not_ready"].includes(error.code),
    );
    assert.equal(db.rows("generation_jobs")[job.jobId].shareTokenHash, undefined);
  }
});

test("bootstrap 只恢复当前用户的过期预占任务", async () => {
  const db = createMemoryDb();
  for (const openid of ["u1", "u2"]) {
    db.seed("users", {
      _id: openid,
      _openid: openid,
      credits: 200,
      trialGranted: true,
      createdAt: EXPIRED,
      updatedAt: EXPIRED,
    });
    db.seed("generation_jobs", {
      _id: `expired-job-${openid}-1234`,
      jobId: `expired-job-${openid}-1234`,
      _openid: openid,
      status: "reserved",
      creditCost: 100,
      templateFileId: `cloud://env/uploads/${openid}/template.png`,
      petFileIds: [`cloud://env/uploads/${openid}/pet-1.jpg`],
      resultFileId: null,
      adjustment: "",
      sourceJobId: null,
      isRegeneration: false,
      errorCode: null,
      createdAt: EXPIRED,
      completedAt: null,
      reservationExpiresAt: EXPIRED,
    });
  }

  const result = await bootstrap({ db, openid: "u1", now: NOW, recoverCallerStaleJobs });

  assert.deepEqual(result, { credits: 300 });
  assert.equal(db.rows("generation_jobs")["expired-job-u1-1234"].status, "failed");
  assert.equal(db.rows("generation_jobs")["expired-job-u2-1234"].status, "reserved");
  assert.equal(db.rows("users").u2.credits, 200);
});

test("到达 reservationExpiresAt 后立即恢复，不额外等待十分钟", async () => {
  const db = createMemoryDb();
  const jobId = "just-expired-123456";
  db.seed("users", {
    _id: "u1",
    _openid: "u1",
    credits: 200,
    trialGranted: true,
    createdAt: EXPIRED,
    updatedAt: EXPIRED,
  });
  db.seed("generation_jobs", {
    _id: jobId,
    jobId,
    _openid: "u1",
    status: "reserved",
    creditCost: 100,
    templateFileId: `cloud://env/uploads/${jobId}/template.png`,
    petFileIds: [`cloud://env/uploads/${jobId}/pet-1.jpg`],
    resultFileId: null,
    adjustment: "",
    sourceJobId: null,
    isRegeneration: false,
    errorCode: null,
    createdAt: new Date("2026-09-05T08:05:00.000Z"),
    completedAt: null,
    reservationExpiresAt: new Date("2026-09-05T08:15:00.000Z"),
  });

  const result = await recoverCallerStaleJobs({ db, openid: "u1", now: NOW });

  assert.deepEqual(result, { recovered: 1 });
  assert.equal(db.rows("generation_jobs")[jobId].status, "failed");
  assert.equal(db.rows("users").u1.credits, 300);
});

test("管理员恢复分页扫描全部过期预占任务且非管理员被拒绝", async () => {
  process.env.ADMIN_OPENIDS = "admin";
  try {
    const db = createMemoryDb();
    for (let index = 0; index < 205; index += 1) {
      const openid = `user-${index}`;
      const jobId = `expired-${String(index).padStart(12, "0")}`;
      db.seed("users", {
        _id: openid,
        _openid: openid,
        credits: 200,
        trialGranted: true,
        createdAt: EXPIRED,
        updatedAt: EXPIRED,
      });
      db.seed("generation_jobs", {
        _id: jobId,
        jobId,
        _openid: openid,
        status: "reserved",
        creditCost: 100,
        templateFileId: `cloud://env/uploads/${jobId}/template.png`,
        petFileIds: [`cloud://env/uploads/${jobId}/pet-1.jpg`],
        resultFileId: null,
        adjustment: "",
        sourceJobId: null,
        isRegeneration: false,
        errorCode: null,
        createdAt: EXPIRED,
        completedAt: null,
        reservationExpiresAt: EXPIRED,
      });
    }

    await assert.rejects(
      () => recoverStaleJobs({ db, openid: "u1", now: NOW }),
      (error) => error.code === "forbidden",
    );
    const result = await recoverStaleJobs({ db, openid: "admin", now: NOW });

    assert.deepEqual(result, { recovered: 205 });
    assert.equal(
      Object.values(db.rows("generation_jobs")).every((job) => job.status === "failed"),
      true,
    );
    assert.equal(Object.values(db.rows("users")).every((user) => user.credits === 300), true);
  } finally {
    delete process.env.ADMIN_OPENIDS;
  }
});
