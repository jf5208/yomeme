const { buildPrompt } = require("./prompt");

const API_URL = "https://ark.cn-beijing.volces.com/api/v3/images/generations";
const DEFAULT_MODEL = "doubao-seedream-4-5-251128";
const REQUEST_TIMEOUT_MS = 180_000;

const BUSINESS_ERRORS = {
  provider_not_configured: "生成服务暂未配置，请联系管理员。",
  provider_timeout: "生成超时，请稍后重试。",
  content_rejected: "图片内容未通过安全审核，请更换素材后重试。",
  provider_insufficient_balance: "生成服务余额不足，请联系管理员。",
  provider_model_inactive: "生成服务尚未开通，请联系管理员。",
  provider_rejected: "图片请求未被接受，请检查素材后重试。",
  provider_failed: "图片生成失败，请稍后再试。",
};

const AUTH_ERROR_CODES = new Set([
  "authenticationerror",
]);
const OVERDUE_ERROR_CODES = new Set([
  "accountoverdueerror",
  "operationdenied.serviceoverdue",
]);
const PRESSURE_ERROR_CODES = new Set([
  "quotaexceeded",
  "ratelimitexceeded.endpointrpmexceeded",
  "ratelimitexceeded.endpointtpmexceeded",
  "modelaccountrpmratelimitexceeded",
  "modelaccounttpmratelimitexceeded",
  "modelaccountipmratelimitexceeded",
  "accountratelimitexceeded",
  "apiaccountrpmratelimitexceeded",
  "serveroverloaded",
  "requestbursttoofast",
  "inflightbatchsizeexceeded",
]);
const CONTENT_ERROR_CODES = new Set([
  "inputimagesensitivecontentdetected",
  "outputimagesensitivecontentdetected",
  "sensitivecontentdetected",
]);
const INACTIVE_MODEL_ERROR_CODES = new Set([
  "invalidendpointormodel.notfound",
  "modelnotopen",
  "modelnotfound",
]);

class SeedreamBusinessError extends Error {
  constructor(code) {
    super(BUSINESS_ERRORS[code] || BUSINESS_ERRORS.provider_failed);
    this.name = "SeedreamBusinessError";
    this.code = code in BUSINESS_ERRORS ? code : "provider_failed";
  }
}

function asDataUrl(image) {
  return `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}`;
}

function providerErrorDetails(payload) {
  if (!payload || typeof payload !== "object") return { code: "", text: "" };
  const error = payload.error;
  if (error && typeof error === "object") {
    const code = String(error.code || "").trim().toLowerCase();
    return { code, text: `${error.code || ""} ${error.message || ""}` };
  }
  const code = String(payload.code || "").trim().toLowerCase();
  return { code, text: `${payload.code || ""} ${payload.message || ""}` };
}

function mapProviderError(status, payload) {
  const { code, text } = providerErrorDetails(payload);

  if (AUTH_ERROR_CODES.has(code)) {
    return new SeedreamBusinessError("provider_not_configured");
  }
  if (OVERDUE_ERROR_CODES.has(code)) {
    return new SeedreamBusinessError("provider_insufficient_balance");
  }
  if (PRESSURE_ERROR_CODES.has(code)) {
    return new SeedreamBusinessError("provider_failed");
  }
  if (CONTENT_ERROR_CODES.has(code)) {
    return new SeedreamBusinessError("content_rejected");
  }
  if (INACTIVE_MODEL_ERROR_CODES.has(code)) {
    return new SeedreamBusinessError("provider_model_inactive");
  }

  if (/invalid credentials|invalid api key|authentication failed|鉴权失败|凭证.*(?:无效|过期)/i.test(text)) {
    return new SeedreamBusinessError("provider_not_configured");
  }
  if (/sensitive|safety|moderation|content.?review|risk.?control|审核|敏感/i.test(text)) {
    return new SeedreamBusinessError("content_rejected");
  }
  if (/account.*overdue|service.*overdue|insufficient balance|arrear|欠费|余额不足/i.test(text)) {
    return new SeedreamBusinessError("provider_insufficient_balance");
  }
  if (/not.?activated|not.?open|model.*not.?found|invalidendpointormodel|未开通|未激活/i.test(text)) {
    return new SeedreamBusinessError("provider_model_inactive");
  }
  if (/queue|concurrenc|rate.?limit|too many requests|high load|overload|排队|并发|限流|繁忙/i.test(text)) {
    return new SeedreamBusinessError("provider_failed");
  }
  if (status === 400 || status === 401 || status === 403 || status === 404 || status === 422) {
    return new SeedreamBusinessError("provider_rejected");
  }
  return new SeedreamBusinessError("provider_failed");
}

function detectMimeType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return null;
}

function decodeBase64(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  if (value.includes("=") && value.length % 4 !== 0) return null;
  if (value.length % 4 === 1) return null;

  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0) return null;
  const canonicalInput = value.replace(/=+$/, "");
  const canonicalOutput = bytes.toString("base64").replace(/=+$/, "");
  return canonicalInput === canonicalOutput ? bytes : null;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch (_error) {
    return null;
  }
}

async function generateImage({ apiKey, model, images, adjustment, fetchImpl } = {}) {
  const resolvedApiKey = String(apiKey || process.env.ARK_API_KEY || "").trim();
  if (!resolvedApiKey) {
    throw new SeedreamBusinessError("provider_not_configured");
  }

  const resolvedModel = String(
    model || process.env.SEEDREAM_MODEL || DEFAULT_MODEL,
  ).trim() || DEFAULT_MODEL;
  const request = fetchImpl || globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await request(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resolvedApiKey}`,
      },
      body: JSON.stringify({
        model: resolvedModel,
        prompt: buildPrompt(images.length - 1, adjustment),
        image: images.map(asDataUrl),
        sequential_image_generation: "disabled",
        stream: false,
        size: "2048x2048",
        response_format: "b64_json",
        watermark: false,
      }),
      signal: controller.signal,
    });
    const payload = await readJson(response);

    if (!response.ok) {
      throw mapProviderError(response.status, payload);
    }

    const encoded = payload && Array.isArray(payload.data)
      ? payload.data.find((item) => item && item.b64_json)?.b64_json
      : null;
    if (!encoded) {
      throw new SeedreamBusinessError("provider_failed");
    }

    const bytes = decodeBase64(encoded);
    const mimeType = bytes ? detectMimeType(bytes) : null;
    if (!bytes || !mimeType) {
      throw new SeedreamBusinessError("provider_failed");
    }
    return { bytes, mimeType };
  } catch (error) {
    if (error instanceof SeedreamBusinessError) throw error;
    if (controller.signal.aborted || (error && error.name === "AbortError")) {
      throw new SeedreamBusinessError("provider_timeout");
    }
    throw new SeedreamBusinessError("provider_failed");
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  API_URL,
  DEFAULT_MODEL,
  REQUEST_TIMEOUT_MS,
  SeedreamBusinessError,
  generateImage,
};
