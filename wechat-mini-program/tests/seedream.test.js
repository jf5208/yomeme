const test = require("node:test");
const assert = require("node:assert/strict");

const {
  generateImage,
} = require("../cloudfunctions/petMemeApi/services/seedream");

const API_URL = "https://ark.cn-beijing.volces.com/api/v3/images/generations";
const DEFAULT_MODEL = "doubao-seedream-4-5-251128";
const SECRET = "ark-test-secret-value";
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const IMAGES = [
  { bytes: Buffer.from("template"), mimeType: "image/png" },
  { bytes: Buffer.from("pet-one"), mimeType: "image/jpeg" },
  { bytes: Buffer.from("pet-two"), mimeType: "image/webp" },
];

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

async function captureError(run) {
  try {
    await run();
  } catch (error) {
    return error;
  }
  assert.fail("Expected the operation to reject");
}

test("Seedream 请求按模板优先顺序发送多图并返回首张 base64 图片", async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return jsonResponse(200, {
      model: DEFAULT_MODEL,
      created: 1788566400,
      data: [{ b64_json: PNG_BYTES.toString("base64"), size: "2048x2048" }],
      usage: { generated_images: 1, output_tokens: 1, total_tokens: 1 },
    });
  };

  const result = await generateImage({
    apiKey: SECRET,
    model: "custom-seedream-model",
    images: IMAGES,
    adjustment: "眼睛更像第二张宠物照",
    fetchImpl,
  });

  assert.equal(request.url, API_URL);
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers["Content-Type"], "application/json");
  assert.equal(request.options.headers.Authorization, `Bearer ${SECRET}`);
  assert.ok(request.options.signal instanceof AbortSignal);

  const body = JSON.parse(request.options.body);
  assert.deepEqual(body, {
    model: "custom-seedream-model",
    prompt: body.prompt,
    image: [
      `data:image/png;base64,${Buffer.from("template").toString("base64")}`,
      `data:image/jpeg;base64,${Buffer.from("pet-one").toString("base64")}`,
      `data:image/webp;base64,${Buffer.from("pet-two").toString("base64")}`,
    ],
    sequential_image_generation: "disabled",
    stream: false,
    size: "2048x2048",
    response_format: "b64_json",
    watermark: false,
  });
  assert.match(body.prompt, /Image 1 is the original single-animal Meme template/);
  assert.match(body.prompt, /Images 2 through 3 are the sole identity references/);
  assert.match(body.prompt, /眼睛更像第二张宠物照/);
  assert.deepEqual(result.bytes, PNG_BYTES);
  assert.equal(result.mimeType, "image/png");
});

test("未显式传配置时读取环境变量并使用批准的默认模型", async () => {
  const originalKey = process.env.ARK_API_KEY;
  const originalModel = process.env.SEEDREAM_MODEL;
  process.env.ARK_API_KEY = SECRET;
  delete process.env.SEEDREAM_MODEL;
  let body;

  try {
    await generateImage({
      images: IMAGES.slice(0, 2),
      adjustment: "",
      fetchImpl: async (_url, options) => {
        body = JSON.parse(options.body);
        return jsonResponse(200, {
          data: [{ b64_json: PNG_BYTES.toString("base64") }],
        });
      },
    });
  } finally {
    if (originalKey === undefined) delete process.env.ARK_API_KEY;
    else process.env.ARK_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.SEEDREAM_MODEL;
    else process.env.SEEDREAM_MODEL = originalModel;
  }

  assert.equal(body.model, DEFAULT_MODEL);
});

test("缺少 API Key 时在发出请求前返回配置错误", async () => {
  const originalKey = process.env.ARK_API_KEY;
  delete process.env.ARK_API_KEY;
  let requestCount = 0;

  try {
    const error = await captureError(() => generateImage({
      images: IMAGES.slice(0, 2),
      adjustment: "",
      fetchImpl: async () => {
        requestCount += 1;
        return jsonResponse(200, {
          data: [{ b64_json: PNG_BYTES.toString("base64") }],
        });
      },
    }));
    assert.equal(error.code, "provider_not_configured");
    assert.equal(error.message, "生成服务暂未配置，请联系管理员。");
  } finally {
    if (originalKey === undefined) delete process.env.ARK_API_KEY;
    else process.env.ARK_API_KEY = originalKey;
  }

  assert.equal(requestCount, 0);
});

test("普通 400 拒绝转成不泄露密钥的业务错误", async () => {
  const error = await captureError(() => generateImage({
    apiKey: SECRET,
    images: IMAGES.slice(0, 2),
    adjustment: "",
    fetchImpl: async () => jsonResponse(400, {
      error: {
        code: "InvalidParameter",
        message: `bad input while using ${SECRET}`,
      },
    }),
  }));

  assert.equal(error.code, "provider_rejected");
  assert.equal(error.message, "图片请求未被接受，请检查素材后重试。");
  assert.doesNotMatch(`${error.name} ${error.code} ${error.message} ${error.stack}`, new RegExp(SECRET));
});

test("官方鉴权错误优先映射为服务配置错误且不泄露上游内容", async () => {
  const cases = [
    {
      status: 401,
      body: { error: { code: "AuthenticationError", message: `sensitive information ${SECRET}` } },
    },
    {
      status: 401,
      body: { error: { code: "Unauthorized", message: `invalid credentials ${SECRET}` } },
    },
  ];

  for (const item of cases) {
    const error = await captureError(() => generateImage({
      apiKey: SECRET,
      images: IMAGES.slice(0, 2),
      adjustment: "",
      fetchImpl: async () => jsonResponse(item.status, item.body),
    }));
    assert.equal(error.code, "provider_not_configured");
    assert.equal(error.message, "生成服务暂未配置，请联系管理员。");
    assert.doesNotMatch(error.stack, new RegExp(SECRET));
  }
});

test("官方欠费错误优先映射为服务余额不足", async () => {
  const officialCodes = ["AccountOverdueError", "OperationDenied.ServiceOverdue"];

  for (const code of officialCodes) {
    const error = await captureError(() => generateImage({
      apiKey: SECRET,
      images: IMAGES.slice(0, 2),
      adjustment: "",
      fetchImpl: async () => jsonResponse(403, {
        error: { code, message: "request denied" },
      }),
    }));
    assert.equal(error.code, "provider_insufficient_balance");
    assert.equal(error.message, "生成服务余额不足，请联系管理员。");
  }
});

test("官方配额、队列、并发和限流压力映射为临时生成失败", async () => {
  const officialCodes = [
    "QuotaExceeded",
    "RateLimitExceeded.EndpointRPMExceeded",
    "RateLimitExceeded.EndpointTPMExceeded",
    "ModelAccountRpmRateLimitExceeded",
    "ModelAccountTpmRateLimitExceeded",
    "ModelAccountIpmRateLimitExceeded",
    "AccountRateLimitExceeded",
    "APIAccountRpmRateLimitExceeded",
    "ServerOverloaded",
    "RequestBurstTooFast",
    "InflightBatchsizeExceeded",
  ];

  for (const code of officialCodes) {
    const error = await captureError(() => generateImage({
      apiKey: SECRET,
      images: IMAGES.slice(0, 2),
      adjustment: "",
      fetchImpl: async () => jsonResponse(429, {
        error: { code, message: "insufficient balance, retry later" },
      }),
    }));
    assert.equal(error.code, "provider_failed");
    assert.equal(error.message, "图片生成失败，请稍后再试。");
  }
});

test("内容审核、模型未开通和未知错误使用简短中文提示", async () => {
  const cases = [
    {
      status: 400,
      body: { error: { code: "OutputImageSensitiveContentDetected", message: "sensitive information" } },
      code: "content_rejected",
      message: "图片内容未通过安全审核，请更换素材后重试。",
    },
    {
      status: 404,
      body: { error: { code: "InvalidEndpointOrModel.NotFound", message: "model has not activated" } },
      code: "provider_model_inactive",
      message: "生成服务尚未开通，请联系管理员。",
    },
    {
      status: 503,
      body: { error: { code: "InternalError", message: "upstream unavailable" } },
      code: "provider_failed",
      message: "图片生成失败，请稍后再试。",
    },
  ];

  for (const item of cases) {
    const error = await captureError(() => generateImage({
      apiKey: SECRET,
      images: IMAGES.slice(0, 2),
      adjustment: "",
      fetchImpl: async () => jsonResponse(item.status, item.body),
    }));
    assert.equal(error.code, item.code);
    assert.equal(error.message, item.message);
  }
});

test("180 秒超时会中止请求并返回超时业务错误", { concurrency: false }, async () => {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  let requestSignal;
  let configuredDelay;

  global.setTimeout = (callback, delay) => {
    configuredDelay = delay;
    const timer = { active: true };
    setImmediate(() => {
      if (timer.active) callback();
    });
    return timer;
  };
  global.clearTimeout = (timer) => {
    timer.active = false;
  };

  let error;
  try {
    error = await captureError(() => generateImage({
      apiKey: SECRET,
      images: IMAGES.slice(0, 2),
      adjustment: "",
      fetchImpl: async (_url, options) => {
        requestSignal = options.signal;
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            const requestError = new Error(`request aborted for ${SECRET}`);
            requestError.name = "AbortError";
            reject(requestError);
          }, { once: true });
        });
      },
    }));
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }

  assert.equal(configuredDelay, 180_000);
  assert.equal(requestSignal.aborted, true);
  assert.equal(error.code, "provider_timeout");
  assert.equal(error.message, "生成超时，请稍后重试。");
  assert.doesNotMatch(error.stack, new RegExp(SECRET));
});

test("请求结束后清理超时定时器", { concurrency: false }, async () => {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  let requestSignal;
  let timer;

  global.setTimeout = (callback) => {
    timer = { active: true };
    originalSetTimeout(() => {
      if (timer.active) callback();
    }, 0);
    return timer;
  };
  global.clearTimeout = (activeTimer) => {
    activeTimer.active = false;
  };

  try {
    await generateImage({
      apiKey: SECRET,
      images: IMAGES.slice(0, 2),
      adjustment: "",
      fetchImpl: async (_url, options) => {
        requestSignal = options.signal;
        return jsonResponse(200, {
          data: [{ b64_json: PNG_BYTES.toString("base64") }],
        });
      },
    });
    await new Promise((resolve) => originalSetTimeout(resolve, 5));
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }

  assert.equal(timer.active, false);
  assert.equal(requestSignal.aborted, false);
});

test("网络异常和无有效图片响应不会泄露上游详情", async () => {
  const networkError = await captureError(() => generateImage({
    apiKey: SECRET,
    images: IMAGES.slice(0, 2),
    adjustment: "",
    fetchImpl: async () => {
      throw new Error(`socket failed with ${SECRET}`);
    },
  }));
  assert.equal(networkError.code, "provider_failed");
  assert.equal(networkError.message, "图片生成失败，请稍后再试。");
  assert.doesNotMatch(networkError.stack, new RegExp(SECRET));

  const responseError = await captureError(() => generateImage({
    apiKey: SECRET,
    images: IMAGES.slice(0, 2),
    adjustment: "",
    fetchImpl: async () => jsonResponse(200, { data: [] }),
  }));
  assert.equal(responseError.code, "provider_failed");
  assert.equal(responseError.message, "图片生成失败，请稍后再试。");
});

test("畸形 Base64 响应不能作为成功图片返回下游", async () => {
  const error = await captureError(() => generateImage({
    apiKey: SECRET,
    images: IMAGES.slice(0, 2),
    adjustment: "",
    fetchImpl: async () => jsonResponse(200, {
      data: [{ b64_json: "%%%not-valid-base64%%%" }],
    }),
  }));

  assert.equal(error.code, "provider_failed");
  assert.equal(error.message, "图片生成失败，请稍后再试。");
});

test("没有 PNG JPEG 或 WebP 签名的字节不能作为成功图片返回下游", async () => {
  const error = await captureError(() => generateImage({
    apiKey: SECRET,
    images: IMAGES.slice(0, 2),
    adjustment: "",
    fetchImpl: async () => jsonResponse(200, {
      data: [{ b64_json: Buffer.from("plain text, not an image").toString("base64") }],
    }),
  }));

  assert.equal(error.code, "provider_failed");
  assert.equal(error.message, "图片生成失败，请稍后再试。");
});

test("只把带 PNG JPEG 或 WebP 签名的解码结果作为成功图片", async () => {
  const cases = [
    { bytes: PNG_BYTES, mimeType: "image/png" },
    { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), mimeType: "image/jpeg" },
    { bytes: Buffer.from("RIFF0000WEBP", "ascii"), mimeType: "image/webp" },
  ];

  for (const item of cases) {
    const result = await generateImage({
      apiKey: SECRET,
      images: IMAGES.slice(0, 2),
      adjustment: "",
      fetchImpl: async () => jsonResponse(200, {
        data: [{ b64_json: item.bytes.toString("base64") }],
      }),
    });
    assert.deepEqual(result, item);
  }
});
