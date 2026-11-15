// src/gateway/predict.ts — predict 请求组装、nv-function-id/slug 校验、错误映射、重试
// 协议细节全按 reference/upstream-protocol.md(executor.go / function_ref.go / types.go)。

import { DEFAULT_NAMESPACE as DEFAULT_NS, MODEL_SNAPSHOT, predictEndpoint, queuesEndpoint, type ModelInfo } from "./models-snapshot";

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

/** NVIDIA 共享队列/连接池耗尽的两种实测错误:
 * - Retries exhausted: 网关内部 3 次排队重试失败;
 * - Pool#acquire ... configured timeout: 后端连接池 45s 拿不到执行槽。
 * 两者都应附 queues 深度,而不是误报成普通 upstream_error。 */
export function isQueueOverloadFailure(raw: string): boolean {
  if (raw.includes("Retries exhausted")) return true;
  return raw.includes("Pool#acquire") && raw.includes("configured timeout");
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

export type AcquireCaptcha = (lane?: string) => Promise<{ captchaToken: string }>;

const PREDICT_ATTEMPTS_WITH_POOL = 3;

function envNum(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

// no-pass 阵发重试:hCaptcha 34-bit 升级是阵发的(实测 401 后 14s 即回 1-attempt
// ok),求解全败不立刻 401,退避后换新挑战再领,通常一两轮就过。退避期间持
// per-model 锁(throttleFor 串行)顺带挡住同 lane 后续请求在尖峰窗口里继续喂
// claim(每一发都是白耗 33s 的求解)。
const CAPTCHA_RETRY_ROUNDS = Math.max(1, Math.floor(envNum("NPG_CAPTCHA_RETRY_ROUNDS", 3)));
const CAPTCHA_RETRY_BASE_MS = envNum("NPG_CAPTCHA_RETRY_MS", 5000);

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

/** queueDepthHint: "Retries exhausted" 时查一次队列深度(免认证端点),把
 * 根因写进 502 错误消息,让调用方一眼看出是公共拥堵还是实例问题。
 * 查不到返回空串。 */
async function queueDepthHint(info: ModelInfo): Promise<string> {
  try {
    const r = await fetch(queuesEndpoint(info), {
      headers: { Origin: "https://build.nvidia.com", Referer: "https://build.nvidia.com/" },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return "";
    const j = await r.json() as { queues?: Array<{ queueDepth?: number; functionStatus?: string }> };
    const q = j?.queues?.[0];
    if (!q || typeof q.queueDepth !== "number") return "";
    return ` (instance ${q.functionStatus ?? "unknown"}, queueDepth ${q.queueDepth}: shared-instance congestion — NVIDIA's own 3 internal retries cannot reach the queue head; retry later or use another model)`;
  } catch {
    return "";
  }
}

function errorDetail(value: unknown): string {
  const record = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
  const name = value instanceof Error ? value.name : typeof record.name === "string" ? record.name : "";
  const message = value instanceof Error
    ? value.message
    : typeof record.message === "string" ? record.message : String(value);
  const fields = ["code", "errno", "syscall", "address", "port"]
    .filter((key) => record[key] !== undefined)
    .map((key) => `${key}=${String(record[key])}`);
  return `${name ? `${name}: ` : ""}${message}${fields.length > 0 ? ` (${fields.join(", ")})` : ""}`;
}

/** fetch 的 TypeError 本身只有 "fetch failed";undici 把 socket/TLS 原因放在 cause。 */
export function formatFetchError(err: unknown): string {
  const top = errorDetail(err);
  const cause = err !== null && typeof err === "object" ? (err as { cause?: unknown }).cause : undefined;
  return cause === undefined ? top : `${top}; cause: ${errorDetail(cause)}`;
}

const FETCH_RETRY_DELAY_MS = 1000;

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
  requestId = "-",
): Promise<Response> {
  const maxAttempts = clientToken !== "" ? 1 : PREDICT_ATTEMPTS_WITH_POOL;
  const endpoint = predictEndpoint(info);

  let lastUpstreamMessage = "";
  let fetchRetried = false;
  // 传输重试只增加一个循环槽;HTTP/captcha 的重试上限仍由 maxAttempts 约束。
  for (let attempt = 1; attempt <= maxAttempts + (fetchRetried ? 1 : 0); attempt++) {
    let token = clientToken;
    if (token === "") {
      let acquired: { captchaToken: string } | null = null;
      let lastErr = "";
      for (let round = 1; round <= CAPTCHA_RETRY_ROUNDS; round++) {
        try {
          acquired = await acquireCaptcha(info.slug);
          break;
        } catch (err) {
          // 池空 → 503(不重试);取消 → 408;其余 = 求解 no-pass(34-bit 尖峰
          // 阵发)→ 退避换新挑战再领
          const msg = err instanceof Error ? err.message : String(err);
          if (signal?.aborted) {
            throw new GatewayError(408, "client_cancelled", `client cancelled during captcha solve: ${msg}`);
          }
          if (msg.includes("pool empty") || msg.includes("captcha pool")) {
            throw new GatewayError(503, "captcha_pool_empty", `${msg}; retry later`);
          }
          lastErr = msg;
          if (round >= CAPTCHA_RETRY_ROUNDS) break;
          const delay = CAPTCHA_RETRY_BASE_MS * round;
          console.error(`[npg-gw] captcha no-pass (difficulty spike), retry ${round}/${CAPTCHA_RETRY_ROUNDS - 1} in ${delay}ms [${info.slug}]: ${msg}`);
          await new Promise((r) => setTimeout(r, delay));
          if (signal?.aborted) {
            throw new GatewayError(408, "client_cancelled", "client cancelled during captcha retry wait");
          }
        }
      }
      if (acquired === null) {
        throw new GatewayError(401, "captcha_error", lastErr);
      }
      token = acquired.captchaToken;
    }

    let resp: Response;
    const fetchStartedAt = Date.now();
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
      const details = formatFetchError(err);
      const elapsed = Date.now() - fetchStartedAt;
      const canRetry = msg === "fetch failed" && clientToken === "" && !fetchRetried;
      console.error(
        `[npg-gw] predict fetch failed [req=${requestId}] [${info.slug}] attempt=${attempt} elapsed=${elapsed}ms: ${details}`,
      );
      if (canRetry) {
        fetchRetried = true;
        console.error(
          `[npg-gw] transport retry 1/1 in ${FETCH_RETRY_DELAY_MS}ms [req=${requestId}] [${info.slug}]: fresh captcha token`,
        );
        await new Promise((r) => setTimeout(r, FETCH_RETRY_DELAY_MS));
        if (signal?.aborted) {
          throw new GatewayError(504, "upstream_timeout", "upstream request timed out during transport retry wait");
        }
        continue; // fetch 未返回 Response(未收到响应头);下一次循环重新领取一次性 token。
      }
      // 客户端自带 token 不能换发,无法安全重试;其他异常也不盲目重放。
      throw new GatewayError(502, "upstream_error", `upstream: ${details}`);
    }

    if (resp.status < 400) return resp;

    // 完整读错误体(供 NPG_DEBUG_BODY=2;默认消息由 upstreamErrorMessage 截短)。
    // text() 已消费并关闭 body——**不要调用 body.cancel()**:
    // Node webstreams 中已锁定的流 cancel 会抛 ERR_INVALID_STATE(ReadableStream
    // is locked),其 Promise rejection 还会成为未处理拒绝;Go 版 CloseBody 的
    // "close failure has no effect" 语义在这里不适用。
    const raw = await resp.text();
    lastUpstreamMessage = raw;

    // NPG_DEBUG_BODY=1:上游 4xx/5xx 时把发上去的请求体(截断)记进日志——实测
    // glm-5-3-flash / nemotron-ultra 的 400 上游 cause 会被截断在 URL 中间,
    // 看不到被拒的确切字段。=2 额外记录完整上游错误体(默认错误消息仍截短,
    // 完整内容只进本地日志)。默认关闭,只在需要定位时开。
    const debugBody = process.env.NPG_DEBUG_BODY ?? "";
    if (debugBody === "1" || debugBody === "2") {
      const cap = 4 * 1024;
      console.error(
        `[npg-gw] upstream ${resp.status} on ${endpoint}; request body: ${body.length > cap ? `${body.slice(0, cap)}…(+${body.length - cap}B truncated)` : body}`,
      );
    }
    if (debugBody === "2") {
      console.error(`[npg-gw] upstream ${resp.status} on ${endpoint}; complete response body (${raw.length}B): ${raw}`);
    }

    if (isQueueOverloadFailure(raw)) {
      // Retries exhausted = NVIDIA 网关自己的 3 次内部重试已放弃;
      // Pool#acquire timeout = 后端连接池 45s 仍拿不到执行槽。两者都是共享
      // 实例拥堵,再试只会再排一次队;查一次免认证队列深度把根因带回调用方。
      const hint = await queueDepthHint(info);
      throw new GatewayError(502, "upstream_queue_overloaded", `upstream: ${upstreamErrorMessage(raw)}${hint}`);
    }

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
