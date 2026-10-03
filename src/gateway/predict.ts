// src/gateway/predict.ts — predict 请求组装、nv-function-id/slug 校验、错误映射、重试
// 协议细节全按 reference/upstream-protocol.md(executor.go / function_ref.go / types.go)。

import { DEFAULT_NAMESPACE as DEFAULT_NS, MODEL_SNAPSHOT, predictEndpoint, type ModelInfo } from "./models-snapshot";

// --- 模型查找(快照 + live registry 覆盖层) ---

let lookupOverlay: ((model: string) => ModelInfo | null) | null = null;

/** chat.ts / models.ts 注入 live registry 覆盖层(优先于快照)。 */
export function setLookupOverlay(fn: (model: string) => ModelInfo | null): void {
  lookupOverlay = fn;
}

function lookupModel(model: string): ModelInfo | null {
  const overlay = lookupOverlay ? lookupOverlay(model) : null;
  if (overlay !== null) return overlay;
  return Object.prototype.hasOwnProperty.call(MODEL_SNAPSHOT, model) ? MODEL_SNAPSHOT[model] : null;
}

// --- 错误类型(OpenAI 兼容 error 体) ---

export class GatewayError extends Error {
  readonly status: number;
  readonly code: string;
  readonly type: string;

  constructor(status: number, code: string, message: string, type?: string) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.code = code;
    this.type = type ?? defaultErrorType(status);
  }
}

function defaultErrorType(status: number): string {
  if (status === 400) return "invalid_request_error";
  if (status === 503) return "service_unavailable";
  if (status >= 500) return "upstream_error";
  return "invalid_request_error";
}

/** OpenAI 兼容错误响应体:{"error": {"message", "type", "code"}} */
export function openAIErrorBody(err: unknown): { error: { message: string; type: string; code: string } } {
  if (err instanceof GatewayError) {
    return { error: { message: err.message, type: err.type, code: err.code } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { error: { message, type: "invalid_request_error", code: "invalid_request" } };
}

// --- function ref pin 校验(function_ref.go) ---

const MAX_FUNCTION_ID_LEN = 128;

/** 第一个 "@" 分割 pin 与 model id(模型 id 永不含 "@");无 pin 返回 null。 */
export function splitFunctionRef(model: string): { pin: string; base: string } | null {
  const i = model.indexOf("@");
  if (i < 0) return null;
  return { pin: model.slice(0, i).trim(), base: model.slice(i + 1).trim() };
}

/** nv-function-id 头值可发送性:非空、≤128、[A-Za-z0-9._-](防 header 注入)。 */
export function validFunctionID(id: string): boolean {
  if (id === "" || id.length > MAX_FUNCTION_ID_LEN) return false;
  return /^[A-Za-z0-9._-]+$/.test(id);
}

/** predict slug ref 可用性:非空、≤256、[A-Za-z0-9._/-]。 */
export function validSlugRef(ref: string): boolean {
  if (ref === "" || ref.length > 256) return false;
  return /^[A-Za-z0-9._/-]+$/.test(ref);
}

/** 400 文本:function_ref.go InvalidFunctionIDError */
export function invalidFunctionIDMessage(id: string): string {
  return `invalid nv-function-id "${id}": use 1-${MAX_FUNCTION_ID_LEN} characters from [A-Za-z0-9._-]`;
}

export function invalidFunctionIDError(id: string): GatewayError {
  return new GatewayError(400, "invalid_function_id", invalidFunctionIDMessage(id));
}

// --- 模型解析(pin 应用 + 未知模型合成;executor.go resolveInvokeTarget) ---

export interface InvokeTarget {
  info: ModelInfo;
  /** 上游 body 应携带的规范 model id(pin 已剥掉) */
  canonical: string;
}

/**
 * 解析模型 id → predict 目标。pin 来源:model 字段 "<function-id>@<model>"(胜)或
 * nv-function-id 头。pin 指向 registry 未列模型 → 合成(slug = 最后一段,namespace 可被
 * nsOverride 覆盖)。无 pin 的未知模型 → 400。
 */
export function resolveInvokeTarget(
  model: string,
  pinFromHeader: string,
  nsOverride: string,
): InvokeTarget {
  const split = splitFunctionRef(model);
  const hasPin = split !== null;
  const pin = hasPin ? split.pin : "";
  const base = hasPin ? split.base : model;

  if (hasPin) {
    if (!validFunctionID(pin)) throw invalidFunctionIDError(pin);
    if (base === "") {
      throw new GatewayError(400, "invalid_function_id", `missing model id after "@" in the model field`);
    }
  }

  // 无 body pin、但 nv-function-slug 头命名了未列目标:全部来自头。
  // (chat.ts 直接用 resolveUnlistedTarget 处理;此处只走 body pin / registry。)

  if (!hasPin) {
    const info = lookupModel(base);
    if (info === null) {
      throw new GatewayError(400, "unknown_model", `unknown model: ${base}`);
    }
    let out = info;
    const hdr = pinFromHeader.trim();
    if (hdr !== "") {
      if (!validFunctionID(hdr)) throw invalidFunctionIDError(hdr);
      out = { ...info, functionId: hdr };
    }
    return { info: out, canonical: out.model ?? model };
  }

  // 有 body pin
  const info = lookupModel(base);
  if (info !== null) {
    return { info: { ...info, functionId: pin }, canonical: info.model ?? base };
  }
  // pin 指向未列模型:合成 triple
  if (!validSlugRef(base)) {
    throw new GatewayError(
      400,
      "invalid_model",
      `invalid model "${base}" for a function pin: use up to 256 characters from [A-Za-z0-9._/-]`,
    );
  }
  const lastSlash = base.lastIndexOf("/");
  const slug = lastSlash >= 0 ? base.slice(lastSlash + 1) : base;
  const namespace = nsOverride.trim() !== "" ? nsOverride.trim() : DEFAULT_NS;
  return { info: { slug, namespace, functionId: pin }, canonical: base };
}

/** 无 body pin 时按 nv-function-* 头合成目标(executor.go synthesizeHeaderTarget)。 */
export function resolveUnlistedTarget(
  slugRef: string,
  pin: string,
  nsOverride: string,
): InvokeTarget {
  if (!validSlugRef(slugRef)) {
    throw new GatewayError(
      400,
      "invalid_model",
      `invalid nv-function-slug "${slugRef}": use up to 256 characters from [A-Za-z0-9._/-]`,
    );
  }
  const trimmedPin = pin.trim();
  if (!validFunctionID(trimmedPin)) {
    throw new GatewayError(
      400,
      "invalid_function_id",
      `nv-function-slug requires a valid nv-function-id header (got "${trimmedPin}")`,
    );
  }
  const lastSlash = slugRef.lastIndexOf("/");
  const slug = lastSlash >= 0 ? slugRef.slice(lastSlash + 1) : slugRef;
  const namespace = nsOverride.trim() !== "" ? nsOverride.trim() : DEFAULT_NS;
  return { info: { slug, namespace, functionId: trimmedPin }, canonical: slugRef };
}

// --- 上游错误识别(executor.go isRetryableCaptchaFailure) ---

interface UpstreamErrorShape {
  requestStatus?: { statusCode?: string; statusDescription?: string; requestId?: string };
}

/** 4xx 且 body 提示 token/captcha 问题 → 可换新 token 重试。 */
export function isRetryableCaptchaFailure(status: number, raw: string): boolean {
  if (status < 400 || status >= 500) return false;
  if (raw.length === 0) return false;
  let er: UpstreamErrorShape | null = null;
  try {
    er = JSON.parse(raw) as UpstreamErrorShape;
  } catch {
    er = null;
  }
  if (er !== null && er.requestStatus) {
    const desc = (er.requestStatus.statusDescription ?? "").toLowerCase();
    if (desc.includes("token is invalid") || desc.includes("invalid token")) return true;
    if (er.requestStatus.statusCode === "INVALID_REQUEST" && desc.includes("token")) return true;
  }
  const low = raw.toLowerCase();
  if (low.includes("token is invalid")) return true;
  return low.includes("captcha") || low.includes("hcaptcha");
}

/** 从上游错误体提取人类可读消息(parseError 顺序:requestStatus → error.message → raw clip)。 */
export function upstreamErrorMessage(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "upstream request failed";
  try {
    const er = JSON.parse(trimmed) as UpstreamErrorShape & { error?: { message?: string } };
    if (er.requestStatus?.statusDescription) return er.requestStatus.statusDescription;
    if (er.error?.message) return er.error.message;
  } catch {
    // 非 JSON:用原文
  }
  return trimmed.slice(0, 300);
}

// --- predict 执行(executor.go doPredict;client 供 token 时 maxAttempts=1,池供 token 时 3) ---

export type AcquireCaptcha = () => Promise<{ captchaToken: string }>;

const PREDICT_ATTEMPTS_WITH_POOL = 3;

export interface PredictHeaders {
  "Content-Type": string;
  Accept: string;
  "nv-function-id": string;
  "nv-captcha-token": string;
  Origin: string;
  Referer: string;
  [key: string]: string;
}

export function buildPredictHeaders(info: ModelInfo, token: string): PredictHeaders {
  return {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "nv-function-id": info.functionId,
    "nv-captcha-token": token,
    Origin: "https://build.nvidia.com",
    Referer: "https://build.nvidia.com/",
  };
}

/**
 * 执行 predict:POST 端点,重试可重试 captcha 失败(换新 token)。返回 status < 400 的
 * 上游 Response;失败抛 GatewayError(400/401/408/502/503)。
 * clientToken 非空时只用它(maxAttempts=1);否则 acquireCaptcha() 供 token,最多 3 次。
 */
export async function doPredict(
  info: ModelInfo,
  body: string,
  clientToken: string,
  acquireCaptcha: AcquireCaptcha,
  signal?: AbortSignal,
): Promise<Response> {
  const maxAttempts = clientToken !== "" ? 1 : PREDICT_ATTEMPTS_WITH_POOL;
  const endpoint = predictEndpoint(info);

  let lastUpstreamMessage = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let token = clientToken;
    if (token === "") {
      let acquired: { captchaToken: string };
      try {
        acquired = await acquireCaptcha();
      } catch (err) {
        // 求解失败:池空 → 503;取消 → 408;其余 → 401
        const msg = err instanceof Error ? err.message : String(err);
        if (signal?.aborted) {
          throw new GatewayError(408, "client_cancelled", `client cancelled during captcha solve: ${msg}`);
        }
        if (msg.includes("pool empty") || msg.includes("captcha pool")) {
          throw new GatewayError(503, "captcha_pool_empty", `${msg}; retry later`);
        }
        throw new GatewayError(401, "captcha_error", msg);
      }
      token = acquired.captchaToken;
    }

    let resp: Response;
    try {
      resp = await fetch(endpoint, {
        method: "POST",
        headers: buildPredictHeaders(info, token),
        body,
        signal,
      });
    } catch (err) {
      if (signal?.aborted) {
        throw new GatewayError(504, "upstream_timeout", "upstream request timed out");
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new GatewayError(502, "upstream_error", `upstream: ${msg}`);
    }

    if (resp.status < 400) return resp;

    // 读错误体(限 4KB)。text() 已消费并关闭 body——**不要调用 body.cancel()**:
    // Node webstreams 中已锁定的流 cancel 会抛 ERR_INVALID_STATE(ReadableStream
    // is locked),其 Promise rejection 还会成为未处理拒绝;Go 版 CloseBody 的
    // "close failure has no effect" 语义在这里不适用。
    const raw = await resp.text();
    lastUpstreamMessage = raw;

    if (isRetryableCaptchaFailure(resp.status, raw) && attempt < maxAttempts) {
      continue; // 换新 token 重试
    }
    if (isRetryableCaptchaFailure(resp.status, raw)) {
      throw new GatewayError(401, "captcha_token_expired", "captcha token invalid or expired; retry the request");
    }
    throw new GatewayError(502, "upstream_error", upstreamErrorMessage(raw));
  }
  throw new GatewayError(
    502,
    "upstream_error",
    `upstream failed after ${maxAttempts} attempts: ${upstreamErrorMessage(lastUpstreamMessage)}`,
  );
}
