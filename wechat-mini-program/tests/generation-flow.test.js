const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  prepareGeneration,
  registerUpload,
  generate,
  extractCloudPath,
  validateDownloadedImage,
  MAX_IMAGE_BYTES,
} = require("../cloudfunctions/petMemeApi/handlers/generate");
const { getResult, prepareShare } = require("../cloudfunctions/petMemeApi/handlers/result");
const {
  recoverCallerStaleJobs,
  recoverStaleJobs,
} = require("../cloudfunctions/petMemeApi/handlers/recover");
const { bootstrap } = require("../cloudfunctions/petMemeApi/handlers/bootstrap");
const {
  reserveGeneration,
  completeGeneration,
  refundGeneration,
} = require("../cloudfunctions/petMemeApi/domain/credits");
const { createMemoryDb } = require("./helpers/cloud-memory-db");
const {
  png,
  rectangularPng,
  oversizedPng,
  jpeg,
  webp,
} = require("./helpers/images");

const NOW = new Date("2026-09-05T08:20:00.000Z");
const EXPIRED = new Date("2026-09-05T08:00:00.000Z");
const PNG = png();
const JPEG = jpeg();

function firstEvent(openid = "u1") {
  const jobId = "job-123456789012";
  return {
    jobId,
    templateFileId: `cloud://env-current.bucket/uploads/${jobId}/template.png`,
    petFileIds: [
      `cloud://env-current.bucket/uploads/${jobId}/pet-1.jpg`,
      `cloud://env-current.bucket/uploads/${jobId}/pet-2.jpg`,
    ],
    templateWidth: 1080,
    templateHeight: 1080,
    rightsConfirmed: true,
    adjustment: "",
    openid,
  };
}

function seedPreparation(db, jobId, overrides = {}) {
  const preparation = {
    _id: jobId,
    jobId,
    _openid: "u1",
    environmentId: "env-current",
    createdAt: NOW,
    expiresAt: new Date("2026-09-05T08:30:00.000Z"),
    uploadedFileIds: [],
    ...overrides,
  };
  db.seed("generation_preparations", preparation);
  return preparation;
}

function createCloud(files = {}) {
  const calls = { downloads: [], uploads: [], deletions: [], tempUrls: [] };
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
    async deleteFile({ fileList }) {
      calls.deletions.push(...fileList);
      return { fileList: fileList.map((fileID) => ({ fileID, status: 0 })) };
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
    templateFileId: "cloud://env-current.bucket/uploads/source-job-1234567/template.png",
    petFileIds: ["cloud://env-current.bucket/uploads/source-job-1234567/pet-1.jpg"],
    resultFileId: "cloud://env-current.bucket/results/u1/source-job-1234567.png",
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
    environmentId: "env-current",
    randomUUID: () => expected,
    now: NOW,
  });

  assert.deepEqual(result, { jobId: expected });
  assert.deepEqual(db.rows("generation_jobs"), {});
  assert.deepEqual(db.rows("credit_events"), {});
  assert.deepEqual(db.rows("generation_preparations")[expected], {
    _id: expected,
    jobId: expected,
    _openid: "u1",
    environmentId: "env-current",
    createdAt: NOW,
    expiresAt: new Date("2026-09-05T08:30:00.000Z"),
    uploadedFileIds: [],
  });
});

test("上传成功后立即登记到本人准备凭证供过期清理", async () => {
  const db = createMemoryDb();
  const event = firstEvent();
  seedPreparation(db, event.jobId);

  for (const fileId of [event.templateFileId, ...event.petFileIds]) {
    await registerUpload({
      db,
      openid: "u1",
      environmentId: "env-current",
      jobId: event.jobId,
      fileId,
      now: NOW,
    });
  }

  assert.deepEqual(
    db.rows("generation_preparations")[event.jobId].uploadedFileIds,
    [event.templateFileId, ...event.petFileIds],
  );
  await assert.rejects(
    () => registerUpload({
      db,
      openid: "u2",
      environmentId: "env-current",
      jobId: event.jobId,
      fileId: event.templateFileId,
      now: NOW,
    }),
    (error) => error.code === "forbidden",
  );
});

test("首次生成成功后扣 100 积分、保存固定结果路径并完成任务", async () => {
  const db = createMemoryDb();
  const event = firstEvent();
  seedPreparation(db, event.jobId);
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
    environmentId: "env-current",
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
  assert.equal(db.rows("generation_preparations")[event.jobId], undefined);
});

test("相同 jobId 重试只返回已有状态且不重复外部工作或扣费", async () => {
  const db = createMemoryDb();
  const event = firstEvent();
  seedPreparation(db, event.jobId);
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
    environmentId: "env-current",
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
  seedPreparation(db, event.jobId);
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
      environmentId: "env-current",
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

test("结果上传后结算失败会删除孤立结果并退款", async () => {
  const db = createMemoryDb();
  const event = firstEvent();
  seedPreparation(db, event.jobId);
  const originalRunTransaction = db.runTransaction.bind(db);
  let transactionCalls = 0;
  db.runTransaction = async (callback) => {
    transactionCalls += 1;
    if (transactionCalls === 2) throw new Error("completion unavailable");
    return originalRunTransaction(callback);
  };
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
      environmentId: "env-current",
      event,
      now: NOW,
      generateImage: async () => ({ bytes: PNG, mimeType: "image/png" }),
    }),
    (error) => error.code === "generation_failed",
  );

  assert.deepEqual(cloud.calls.deletions, [`cloud://env/results/u1/${event.jobId}.png`]);
  assert.equal(db.rows("generation_jobs")[event.jobId].status, "failed");
  assert.equal(db.rows("generation_jobs")[event.jobId].pendingResultFileId, null);
  assert.equal(db.rows("users").u1.credits, 300);
});

test("孤立结果即时删除失败时在任务中保留文件编号供定时清理", async () => {
  const db = createMemoryDb();
  const event = firstEvent();
  seedPreparation(db, event.jobId);
  const originalRunTransaction = db.runTransaction.bind(db);
  let transactionCalls = 0;
  db.runTransaction = async (callback) => {
    transactionCalls += 1;
    if (transactionCalls === 2) throw new Error("completion unavailable");
    return originalRunTransaction(callback);
  };
  const cloud = createCloud({
    [event.templateFileId]: PNG,
    [event.petFileIds[0]]: JPEG,
    [event.petFileIds[1]]: JPEG,
  });
  cloud.deleteFile = async ({ fileList }) => ({
    fileList: fileList.map((fileID) => ({ fileID, status: -1, errCode: "delete_failed" })),
  });

  await assert.rejects(
    () => generate({
      db,
      cloud,
      openid: "u1",
      environmentId: "env-current",
      event,
      now: NOW,
      generateImage: async () => ({ bytes: PNG, mimeType: "image/png" }),
    }),
    (error) => error.code === "generation_failed",
  );

  assert.equal(
    db.rows("generation_jobs")[event.jobId].pendingResultFileId,
    `cloud://env/results/u1/${event.jobId}.png`,
  );
});

test("孤立结果已被生命周期删除时按清理成功处理", async () => {
  const db = createMemoryDb();
  const event = firstEvent();
  seedPreparation(db, event.jobId);
  const originalRunTransaction = db.runTransaction.bind(db);
  let transactionCalls = 0;
  db.runTransaction = async (callback) => {
    transactionCalls += 1;
    if (transactionCalls === 2) throw new Error("completion unavailable");
    return originalRunTransaction(callback);
  };
  const cloud = createCloud({
    [event.templateFileId]: PNG,
    [event.petFileIds[0]]: JPEG,
    [event.petFileIds[1]]: JPEG,
  });
  cloud.deleteFile = async ({ fileList }) => ({
    fileList: fileList.map((fileID) => ({
      fileID,
      status: -503003,
      errMsg: "storage file not exists",
    })),
  });

  await assert.rejects(
    () => generate({
      db,
      cloud,
      openid: "u1",
      environmentId: "env-current",
      event,
      now: NOW,
      generateImage: async () => ({ bytes: PNG, mimeType: "image/png" }),
    }),
    (error) => error.code === "generation_failed",
  );

  assert.equal(db.rows("generation_jobs")[event.jobId].pendingResultFileId, null);
  assert.equal(db.rows("users").u1.credits, 300);
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
    { ...valid, templateFileId: `cloud://env-current.bucket/uploads/${valid.jobId}/template.png?token=x` },
    { ...valid, templateFileId: `cloud://other-env.bucket/uploads/${valid.jobId}/template.png` },
  ];

  for (const event of invalidEvents) {
    const db = createMemoryDb();
    seedPreparation(db, event.jobId);
    const cloud = createCloud();
    await assert.rejects(
      () => generate({
        db,
        cloud,
        openid: "u1",
        environmentId: "env-current",
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

test("下载内容必须能被完整解码为受支持的图片", async () => {
  assert.deepEqual(await validateDownloadedImage({ fileContent: PNG }), {
    bytes: PNG,
    mimeType: "image/png",
    width: 16,
    height: 16,
  });
  await assert.rejects(
    validateDownloadedImage({ fileContent: Buffer.from("not-image") }),
    (error) => error.code === "invalid_image",
  );
  await assert.rejects(
    validateDownloadedImage({ fileContent: "base64-string" }),
    (error) => error.code === "invalid_image",
  );
  await assert.rejects(
    validateDownloadedImage({
      fileContent: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    }),
    (error) => error.code === "invalid_image",
  );
  await assert.rejects(
    validateDownloadedImage({ fileContent: Buffer.alloc(MAX_IMAGE_BYTES + 1) }),
    (error) => error.code === "invalid_image",
  );
  await assert.rejects(
    validateDownloadedImage({ fileContent: oversizedPng() }),
    (error) => error.code === "invalid_image",
  );
});

test("真实图片被截断后必须解码失败", async () => {
  for (const bytes of [png(), jpeg(), webp()]) {
    const truncated = bytes.subarray(0, Math.floor(bytes.length * 0.65));
    await assert.rejects(
      validateDownloadedImage({ fileContent: truncated }),
      (error) => error.code === "invalid_image",
    );
  }
});

test("服务端读取真实模板尺寸并拒绝伪报为正方形的长方形模板", async () => {
  const db = createMemoryDb();
  const event = firstEvent();
  seedPreparation(db, event.jobId);
  const cloud = createCloud({
    [event.templateFileId]: rectangularPng(),
    [event.petFileIds[0]]: JPEG,
    [event.petFileIds[1]]: JPEG,
  });
  let modelCalls = 0;

  await assert.rejects(
    () => generate({
      db,
      cloud,
      openid: "u1",
      environmentId: "env-current",
      event: { ...event, templateWidth: 1080, templateHeight: 1080 },
      now: NOW,
      generateImage: async () => { modelCalls += 1; },
    }),
    (error) => error.code === "generation_failed",
  );

  assert.equal(modelCalls, 0);
  assert.equal(db.rows("users").u1.credits, 300);
  assert.equal(db.rows("generation_jobs")[event.jobId].errorCode, "invalid_image");
});

test("服务端以真实图片为准，不依赖客户端上报的模板宽高", async () => {
  const db = createMemoryDb();
  const event = { ...firstEvent(), templateWidth: 1, templateHeight: 999 };
  seedPreparation(db, event.jobId);
  const cloud = createCloud({
    [event.templateFileId]: PNG,
    [event.petFileIds[0]]: JPEG,
    [event.petFileIds[1]]: JPEG,
  });

  const result = await generate({
    db,
    cloud,
    openid: "u1",
    environmentId: "env-current",
    event,
    now: NOW,
    generateImage: async () => ({ bytes: PNG, mimeType: "image/png" }),
  });

  assert.equal(result.status, "succeeded");
  assert.equal(db.rows("users").u1.credits, 200);
});

test("截断的生成结果不会上传或结算并自动退款", async () => {
  const db = createMemoryDb();
  const event = firstEvent();
  seedPreparation(db, event.jobId);
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
      environmentId: "env-current",
      event,
      now: NOW,
      generateImage: async () => ({
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        mimeType: "image/png",
      }),
    }),
    (error) => error.code === "generation_failed",
  );

  assert.equal(cloud.calls.uploads.length, 0);
  assert.equal(db.rows("users").u1.credits, 300);
  assert.equal(db.rows("generation_jobs")[event.jobId].status, "failed");
});

test("下载到伪图片后不会调用模型且自动退款", async () => {
  const db = createMemoryDb();
  const event = firstEvent();
  seedPreparation(db, event.jobId);
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
      environmentId: "env-current",
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
  seedPreparation(db, event.jobId);
  const cloud = createCloud({
    [source.templateFileId]: PNG,
    [source.petFileIds[0]]: JPEG,
  });
  let modelInput;

  await generate({
    db,
    cloud,
    openid: "u1",
    environmentId: "env-current",
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
    seedPreparation(db, event.jobId);

    await assert.rejects(
      () => generate({
        db,
        cloud: createCloud(),
        openid: "u1",
        environmentId: "env-current",
        event,
        now: NOW,
        generateImage: async () => ({ bytes: PNG, mimeType: "image/png" }),
      }),
      (error) => ["forbidden", "invalid_source_job"].includes(error.code),
    );
    assert.equal(db.rows("generation_jobs")[event.jobId], undefined);
  }
});

test("多个分享口令保持有效，跨任务口令无效且响应只含脱敏结果", async () => {
  const db = createMemoryDb();
  const job = seedSucceededJob(db);
  const cloud = createCloud();
  const firstBytes = Buffer.from("00112233445566778899aabbccddeeff0011", "hex");
  const secondBytes = Buffer.from("11112233445566778899aabbccddeeff0022", "hex");
  const firstToken = firstBytes.toString("base64url");
  const secondToken = secondBytes.toString("base64url");

  const firstShare = await prepareShare({
    db,
    openid: "u1",
    jobId: job.jobId,
    randomBytes: () => firstBytes,
    now: NOW,
  });
  const secondShare = await prepareShare({
    db,
    openid: "u1",
    jobId: job.jobId,
    randomBytes: () => secondBytes,
    now: NOW,
  });

  assert.deepEqual(firstShare, { jobId: job.jobId, token: firstToken });
  assert.deepEqual(secondShare, { jobId: job.jobId, token: secondToken });
  const stored = db.rows("generation_jobs")[job.jobId];
  assert.equal(stored.shareTokenHash, undefined);
  const firstHash = crypto.createHash("sha256").update(firstToken).digest("hex");
  const secondHash = crypto.createHash("sha256").update(secondToken).digest("hex");
  assert.equal(db.rows("share_grants")[firstHash].jobId, job.jobId);
  assert.equal(db.rows("share_grants")[secondHash].jobId, job.jobId);
  assert.equal(JSON.stringify(db.rows("share_grants")).includes(firstToken), false);
  assert.equal(JSON.stringify(db.rows("share_grants")).includes(secondToken), false);

  await assert.rejects(
    () => getResult({ db, cloud, openid: "u2", jobId: job.jobId, token: "wrong", now: NOW }),
    (error) => error.code === "forbidden",
  );
  const shared = await getResult({
    db,
    cloud,
    openid: "u2",
    jobId: job.jobId,
    token: firstToken,
    now: NOW,
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
  assert.equal(shared.generatedAt, NOW.toISOString());

  const secondShared = await getResult({
    db,
    cloud,
    openid: "u3",
    jobId: job.jobId,
    token: secondToken,
    now: NOW,
  });
  assert.equal(secondShared.readOnly, true);

  const firstGrant = db.rows("share_grants")[firstHash];
  assert.ok(firstGrant.expiresAt instanceof Date);
  await assert.rejects(
    () => getResult({
      db,
      cloud,
      openid: "u4",
      jobId: job.jobId,
      token: firstToken,
      now: new Date(firstGrant.expiresAt.getTime() + 1),
    }),
    (error) => error.code === "forbidden",
  );

  const otherJob = seedSucceededJob(db, {
    _id: "other-source-123456",
    jobId: "other-source-123456",
  });
  await assert.rejects(
    () => getResult({
      db,
      cloud,
      openid: "u2",
      jobId: otherJob.jobId,
      token: firstToken,
      now: NOW,
    }),
    (error) => error.code === "forbidden",
  );

  const owner = await getResult({ db, cloud, openid: "u1", jobId: job.jobId, now: NOW });
  assert.equal(owner.readOnly, false);
  assert.equal(owner.canAdjust, true);
  assert.equal(owner.generatedAt, NOW.toISOString());

  const adjusted = seedSucceededJob(db, {
    _id: "adjusted-result-1234",
    jobId: "adjusted-result-1234",
    isRegeneration: true,
    sourceJobId: job.jobId,
  });
  const adjustedResult = await getResult({
    db,
    cloud,
    openid: "u1",
    jobId: adjusted.jobId,
  });
  assert.equal(adjustedResult.canAdjust, false);

  const cleaned = seedSucceededJob(db, {
    _id: "cleaned-source-1234",
    jobId: "cleaned-source-1234",
    originalsCleaned: true,
    templateFileId: null,
    petFileIds: [],
  });
  const cleanedResult = await getResult({
    db,
    cloud,
    openid: "u1",
    jobId: cleaned.jobId,
    now: NOW,
  });
  assert.equal(cleanedResult.canAdjust, false);

  const cleanupClaimed = seedSucceededJob(db, {
    _id: "cleanup-claimed-1234",
    jobId: "cleanup-claimed-1234",
    cleanupClaimed: true,
  });
  const cleanupClaimedResult = await getResult({
    db,
    cloud,
    openid: "u1",
    jobId: cleanupClaimed.jobId,
    now: NOW,
  });
  assert.equal(cleanupClaimedResult.canAdjust, false);
});

test("分享口令不会超过作品剩余保存期", async () => {
  const db = createMemoryDb();
  const createdAt = new Date(NOW.getTime() - 29 * 24 * 60 * 60 * 1000);
  const job = seedSucceededJob(db, { createdAt });
  const bytes = Buffer.from("22112233445566778899aabbccddeeff0033", "hex");
  const share = await prepareShare({
    db,
    openid: "u1",
    jobId: job.jobId,
    randomBytes: () => bytes,
    now: NOW,
  });
  const hash = crypto.createHash("sha256").update(share.token).digest("hex");

  assert.equal(
    db.rows("share_grants")[hash].expiresAt.getTime(),
    createdAt.getTime() + 30 * 24 * 60 * 60 * 1000,
  );
});

test("只有所有者能创建分享口令且任务必须已成功", async () => {
  for (const overrides of [{ _openid: "u2" }, { status: "reserved" }]) {
    const db = createMemoryDb();
    const job = seedSucceededJob(db, overrides);
    await assert.rejects(
      () => prepareShare({ db, openid: "u1", jobId: job.jobId }),
      (error) => ["forbidden", "result_not_ready"].includes(error.code),
    );
    assert.deepEqual(db.rows("share_grants"), {});
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

test("结算已提交但回包失败时保留成功结果且不退款", async () => {
  const db = createMemoryDb();
  const event = firstEvent();
  seedPreparation(db, event.jobId);
  const originalRunTransaction = db.runTransaction.bind(db);
  let transactionCalls = 0;
  db.runTransaction = async (callback) => {
    transactionCalls += 1;
    const result = await originalRunTransaction(callback);
    if (transactionCalls === 2) throw new Error("completion response lost");
    return result;
  };
  const cloud = createCloud({
    [event.templateFileId]: PNG,
    [event.petFileIds[0]]: JPEG,
    [event.petFileIds[1]]: JPEG,
  });

  const result = await generate({
    db,
    cloud,
    openid: "u1",
    environmentId: "env-current",
    event,
    now: NOW,
    generateImage: async () => ({ bytes: PNG, mimeType: "image/png" }),
  });

  assert.deepEqual(result, { jobId: event.jobId, status: "succeeded" });
  assert.deepEqual(cloud.calls.deletions, []);
  assert.equal(db.rows("generation_jobs")[event.jobId].status, "succeeded");
  assert.equal(db.rows("generation_jobs")[event.jobId].pendingResultFileId, null);
  assert.equal(db.rows("users").u1.credits, 200);
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
    const recoveryQueries = db.queryCalls.filter(({ collection }) => collection === "generation_jobs");
    assert.equal(recoveryQueries.length >= 3, true);
    assert.equal(recoveryQueries.every(({ offset }) => offset === 0), true);
  } finally {
    delete process.env.ADMIN_OPENIDS;
  }
});

test("恢复集合连续两批没有缩小时安全中止而不是继续循环", async () => {
  const job = {
    _id: "stuck-job-12345678",
    jobId: "stuck-job-12345678",
    _openid: "u1",
    status: "reserved",
    creditCost: 100,
    reservationExpiresAt: EXPIRED,
  };
  let queryCount = 0;
  const transactionCollection = (name) => ({
    doc() {
      return {
        async get() {
          if (name === "generation_jobs") return { data: structuredClone(job) };
          if (name === "users") return { data: { _id: "u1", _openid: "u1", credits: 200 } };
          return { data: null };
        },
        async update() {},
        async set() {},
      };
    },
  });
  const db = {
    command: { lte: (value) => value },
    collection() {
      const query = {
        where() { return query; },
        orderBy() { return query; },
        limit() { return query; },
        async get() {
          queryCount += 1;
          return { data: queryCount <= 2 ? [structuredClone(job)] : [] };
        },
      };
      return query;
    },
    async runTransaction(callback) {
      return callback({ collection: transactionCollection });
    },
  };

  await assert.rejects(
    () => recoverCallerStaleJobs({ db, openid: "u1", now: NOW }),
    (error) => error.code === "recovery_stalled",
  );
  assert.equal(queryCount, 2);
});

test("生成前必须有当前环境、当前用户且未过期的准备租约", async () => {
  const cases = [
    { name: "missing", prepare: false },
    { name: "wrong-owner", preparation: { _openid: "u2" } },
    { name: "expired", preparation: { expiresAt: new Date("2026-09-05T08:19:59.000Z") } },
    { name: "wrong-environment", preparation: { environmentId: "env-other" } },
  ];
  for (const item of cases) {
    const db = createMemoryDb();
    const event = firstEvent();
    if (item.prepare !== false) seedPreparation(db, event.jobId, item.preparation);
    let modelCalls = 0;

    await assert.rejects(
      () => generate({
        db,
        cloud: createCloud(),
        openid: "u1",
        environmentId: "env-current",
        event,
        now: NOW,
        generateImage: async () => { modelCalls += 1; },
      }),
      (error) => ["preparation_required", "forbidden", "preparation_expired"].includes(error.code),
      item.name,
    );
    assert.equal(modelCalls, 0, item.name);
    assert.deepEqual(db.rows("generation_jobs"), {}, item.name);
    assert.deepEqual(db.rows("users"), {}, item.name);
  }
});

test("已有任务在准备租约过期后重试仍返回原状态", async () => {
  const db = createMemoryDb();
  const event = firstEvent();
  seedPreparation(db, event.jobId, {
    expiresAt: new Date("2026-09-05T08:19:59.000Z"),
  });
  db.seed("generation_jobs", {
    _id: event.jobId,
    jobId: event.jobId,
    _openid: "u1",
    status: "succeeded",
    resultFileId: `cloud://env-current.bucket/results/u1/${event.jobId}.png`,
  });
  let modelCalls = 0;

  const result = await generate({
    db,
    cloud: createCloud(),
    openid: "u1",
    environmentId: "env-current",
    event,
    now: NOW,
    generateImage: async () => { modelCalls += 1; },
  });

  assert.deepEqual(result, { jobId: event.jobId, status: "succeeded" });
  assert.equal(modelCalls, 0);
});

test("并发恢复只统计真正发生的一次退款", async () => {
  const db = createMemoryDb();
  const jobId = "concurrent-recover-1";
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
    reservationExpiresAt: EXPIRED,
  });

  const results = await Promise.all([
    recoverCallerStaleJobs({ db, openid: "u1", now: NOW }),
    recoverCallerStaleJobs({ db, openid: "u1", now: NOW }),
  ]);

  assert.equal(results.reduce((sum, item) => sum + item.recovered, 0), 1);
  assert.equal(db.rows("users").u1.credits, 300);
});

test("生成结果按已验证 MIME 使用匹配扩展名", async () => {
  for (const [mimeType, extension, bytes] of [
    ["image/png", "png", png()],
    ["image/jpeg", "jpg", jpeg()],
    ["image/webp", "webp", webp()],
  ]) {
    const db = createMemoryDb();
    const event = firstEvent();
    event.jobId = `output-${extension}-123456789`;
    event.templateFileId = `cloud://env-current.bucket/uploads/${event.jobId}/template.png`;
    event.petFileIds = [`cloud://env-current.bucket/uploads/${event.jobId}/pet-1.jpg`];
    seedPreparation(db, event.jobId);
    const cloud = createCloud({
      [event.templateFileId]: png(),
      [event.petFileIds[0]]: jpeg(),
    });

    await generate({
      db,
      cloud,
      openid: "u1",
      environmentId: "env-current",
      event,
      now: NOW,
      generateImage: async () => ({ bytes, mimeType }),
    });

    assert.deepEqual(cloud.calls.uploads.map(({ cloudPath }) => cloudPath), [
      `results/u1/${event.jobId}.${extension}`,
    ]);
    assert.equal(
      db.rows("generation_jobs")[event.jobId].resultFileId,
      `cloud://env/results/u1/${event.jobId}.${extension}`,
    );
  }
});

function reserveAdjustment(db, jobId, sourceJobId) {
  return reserveGeneration({
    db,
    openid: "u1",
    jobId,
    templateFileId: "cloud://malicious/replacement.png",
    petFileIds: ["cloud://malicious/replacement-pet.jpg"],
    adjustment: "更像我家宠物",
    sourceJobId,
    now: NOW,
  });
}

test("并发不同子任务只能原子占用一个调整名额", async () => {
  const db = createMemoryDb();
  const source = seedSucceededJob(db);
  db.seed("users", {
    _id: "u1",
    _openid: "u1",
    credits: 300,
    trialGranted: true,
    createdAt: EXPIRED,
    updatedAt: EXPIRED,
  });

  const results = await Promise.allSettled([
    reserveAdjustment(db, "adjust-child-a-1234", source.jobId),
    reserveAdjustment(db, "adjust-child-b-1234", source.jobId),
  ]);

  assert.deepEqual(results.map(({ status }) => status), ["fulfilled", "rejected"]);
  assert.equal(results[1].reason.code, "adjustment_in_progress");
  const child = results[0].value.job;
  assert.equal(child.templateFileId, source.templateFileId);
  assert.deepEqual(child.petFileIds, source.petFileIds);
  assert.equal(db.rows("generation_jobs")[source.jobId].adjustmentReservedJobId, child.jobId);
});

test("一次调整成功后永久占用名额且不能从调整结果继续串联", async () => {
  const db = createMemoryDb();
  const source = seedSucceededJob(db);
  db.seed("users", {
    _id: "u1",
    _openid: "u1",
    credits: 300,
    trialGranted: true,
    createdAt: EXPIRED,
    updatedAt: EXPIRED,
  });
  const first = await reserveAdjustment(db, "adjust-child-a-1234", source.jobId);
  await completeGeneration({
    db,
    openid: "u1",
    jobId: first.job.jobId,
    resultFileId: "cloud://env-current.bucket/results/u1/adjust-child-a-1234.png",
    now: NOW,
  });

  await assert.rejects(
    () => reserveAdjustment(db, "adjust-child-b-1234", source.jobId),
    (error) => error.code === "adjustment_limit_reached",
  );
  await assert.rejects(
    () => reserveAdjustment(db, "adjust-chain-123456", first.job.jobId),
    (error) => error.code === "invalid_source_job",
  );
  assert.equal(db.rows("generation_jobs")[source.jobId].adjustmentSucceededJobId, first.job.jobId);
});

test("失败退款会释放调整名额供新任务重试", async () => {
  const db = createMemoryDb();
  const source = seedSucceededJob(db);
  db.seed("users", {
    _id: "u1",
    _openid: "u1",
    credits: 300,
    trialGranted: true,
    createdAt: EXPIRED,
    updatedAt: EXPIRED,
  });
  const first = await reserveAdjustment(db, "adjust-child-a-1234", source.jobId);
  await refundGeneration({
    db,
    openid: "u1",
    jobId: first.job.jobId,
    errorCode: "provider_failed",
    now: NOW,
  });

  const retry = await reserveAdjustment(db, "adjust-child-b-1234", source.jobId);

  assert.equal(retry.acquired, true);
  assert.equal(db.rows("generation_jobs")[source.jobId].adjustmentReservedJobId, retry.job.jobId);
});
