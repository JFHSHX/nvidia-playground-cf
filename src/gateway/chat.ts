// src/gateway/chat.ts — /v1/chat/completions:predict 组装 + 流式 SSE 透传(TransformStream)+ 非流式聚合
// 协议按 reference/upstream-protocol.md(executor.go / coalesce.go / types.go / reasoning.go)。

import { acquireNvCaptcha } from "../hcaptcha";
import { DEFAULT_MODEL } from "./models-snapshot";
import {
  doPredict,
  resolveInvokeTarget,
  resolveUnlistedTarget,
  GatewayError,
  openAIErrorBody,
  type AcquireCaptcha,
} from "./predict";

const acquire: AcquireCaptcha = acquireNvCaptcha; // 只消费 captchaToken 字段
const NON_STREAM_TIMEOUT_MS = 120_000; // client.go requestTimeout

// --- thinking / chat_template_kwargs(reasoning.go normalizeThinking) ---

interface ReasoningProfile {
  kind: "effort" | "toggle" | "miniMax";
  levels: string[];
  defaultLevel: string;
}

// 按 registry id 的 profile 表(2026-08 目录;removed 模型已随 Go 侧删除)
const REASONING_PROFILES: Record<string, ReasoningProfile> = {
  "deepseek-ai/deepseek-v4-flash-0731": { kind: "effort", levels: ["none", "high", "max"], defaultLevel: "high" },
  "deepseek-ai/deepseek-v4-pro-0813": { kind: "effort", levels: ["none", "high", "max"], defaultLevel: "high" },
  "nvidia/nemotron-3-ultra-550b-a55b": { kind: "effort", levels: ["none", "medium", "high"], defaultLevel: "high" },
  "google/diffusiongemma-26b-a4b-it": { kind: "toggle", levels: [], defaultLevel: "" },
  "minimaxai/minimax-m3": { kind: "miniMax", levels: [], defaultLevel: "" },
};

const EFFORT_RANKS: Record<string, number> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

function normalizeEffort(effort: string, defaultLevel: string): string {
  const normalized = effort.toLowerCase().trim();
  return Object.prototype.hasOwnProperty.call(EFFORT_RANKS, normalized) ? normalized : defaultLevel;
}

function mapEffort(effort: string, profile: ReasoningProfile): string {
  const requestedRank = EFFORT_RANKS[effort] ?? 0;
  for (const level of profile.levels) {
    if ((EFFORT_RANKS[level] ?? 0) >= requestedRank) return level;
  }
  return profile.levels[profile.levels.length - 1] ?? "none";
}

function effortEnablesThinking(effort: string): boolean {
  return effort !== "none";
}

/**
 * 剥掉顶层 thinking/enable_thinking/clear_thinking/reasoning_effort(总是,防不支持的模型 400),
 * 支持的模型把值映射进 chat_template_kwargs;客户端显式发的 chat_template_kwargs 总是保留。
 */
function normalizeThinking(raw: Record<string, unknown>): void {
  const model = typeof raw["model"] === "string" ? raw["model"] : "";
  const profile = Object.prototype.hasOwnProperty.call(REASONING_PROFILES, model)
    ? REASONING_PROFILES[model]
    : null;
  const hadKwargs = raw["chat_template_kwargs"] !== undefined && raw["chat_template_kwargs"] !== null;
  const kwIn =
    hadKwargs && typeof raw["chat_template_kwargs"] === "object"
      ? (raw["chat_template_kwargs"] as Record<string, unknown>)
      : {};
  const kw: Record<string, unknown> = { ...kwIn };
  const thinkingObj =
    typeof raw["thinking"] === "object" && raw["thinking"] !== null
      ? (raw["thinking"] as Record<string, unknown>)
      : {};

  let effort = "";
  let hasEffort = false;
  const kwEffort = kw["reasoning_effort"];
  if (typeof kwEffort === "string" && kwEffort.trim() !== "") {
    effort = normalizeEffort(kwEffort, profile?.defaultLevel ?? "high");
    hasEffort = true;
  } else if (typeof raw["reasoning_effort"] === "string" && (raw["reasoning_effort"] as string).trim() !== "") {
    effort = normalizeEffort(raw["reasoning_effort"] as string, profile?.defaultLevel ?? "high");
    hasEffort = true;
  } else if (typeof thinkingObj["reasoning_effort"] === "string") {
    effort = normalizeEffort(thinkingObj["reasoning_effort"] as string, profile?.defaultLevel ?? "high");
    hasEffort = true;
  }

  let enabled: boolean | undefined;
  const kwEnabled = kw["enable_thinking"];
  if (typeof kwEnabled === "boolean") {
    enabled = kwEnabled;
  } else if (typeof thinkingObj["type"] === "string") {
    const t = (thinkingObj["type"] as string).toLowerCase().trim();
    if (t === "enabled" || t === "enable" || t === "on") enabled = true;
    else if (t === "disabled" || t === "disable" || t === "off") enabled = false;
  } else if (typeof raw["enable_thinking"] === "boolean") {
    enabled = raw["enable_thinking"] as boolean;
  }

  let clearThinking: unknown;
  let hasClearThinking = false;
  if (kw["clear_thinking"] !== undefined) {
    clearThinking = kw["clear_thinking"];
    hasClearThinking = true;
  } else if (thinkingObj["clear_thinking"] !== undefined) {
    clearThinking = thinkingObj["clear_thinking"];
    hasClearThinking = true;
  } else if (raw["clear_thinking"] !== undefined) {
    clearThinking = raw["clear_thinking"];
    hasClearThinking = true;
  }

  delete raw["thinking"];
  delete raw["enable_thinking"];
  delete raw["clear_thinking"];
  delete raw["reasoning_effort"];

  if (profile !== null) {
    if (profile.kind === "effort") {
      delete kw["enable_thinking"];
      if (hasEffort) kw["reasoning_effort"] = mapEffort(effort, profile);
      else if (enabled !== undefined) kw["reasoning_effort"] = mapEffort(enabled ? profile.defaultLevel : "none", profile);
    } else if (profile.kind === "toggle") {
      delete kw["reasoning_effort"];
      if (enabled !== undefined) kw["enable_thinking"] = enabled;
      else if (hasEffort) kw["enable_thinking"] = effortEnablesThinking(effort);
      if (hasClearThinking) kw["clear_thinking"] = clearThinking;
    } else {
      // miniMax
      delete kw["enable_thinking"];
      delete kw["reasoning_effort"];
      if (hasEffort) {
        kw["thinking_mode"] =
          effort === "none"
            ? "disabled"
            : effort === "minimal" || effort === "low" || effort === "medium"
              ? "adaptive"
              : "enabled";
      } else if (enabled !== undefined) {
        kw["thinking_mode"] = enabled ? "enabled" : "disabled";
      }
    }
  }

  if (Object.keys(kw).length > 0 || hadKwargs) raw["chat_template_kwargs"] = kw;
  else delete raw["chat_template_kwargs"];
}

// --- 请求体组装(executor.go preparePayload + forceStreamFlag) ---

function forceStreamFlag(body: Record<string, unknown>, stream: boolean): void {
  body["stream"] = stream;
  if (stream) {
    const optsIn =
      typeof body["stream_options"] === "object" && body["stream_options"] !== null
        ? (body["stream_options"] as Record<string, unknown>)
        : {};
    const opts: Record<string, unknown> = { ...optsIn };
    if (!("include_usage" in opts)) opts["include_usage"] = true;
    opts["continuous_usage_stats"] = false;
    body["stream_options"] = opts;
  }
}

interface ChatMessage {
  role?: unknown;
  content?: unknown;
  [key: string]: unknown;
}

/** 组装上游请求体;返回 JSON 字符串。校验失败抛 GatewayError(400)。 */
function buildUpstreamBody(payload: Record<string, unknown>, stream: boolean, canonicalModel: string): string {
  const body: Record<string, unknown> = { ...payload };
  normalizeThinking(body);
  body["model"] = canonicalModel;
  forceStreamFlag(body, stream);
  return JSON.stringify(body);
}

// --- 非流式:上游 SSE → chat.completion 聚合(coalesce 场景兜底) ---

interface SseChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index?: number;
    message?: { role?: string; content?: string | null; reasoning_content?: string | null };
    delta?: { role?: string; content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
    logprobs?: unknown;
  }>;
  usage?: Record<string, unknown> | null;
  system_fingerprint?: string;
  service_tier?: string;
}

/** 把 SSE 文本聚合为 chat.completion JSON;无有效事件返回 null。 */
function aggregateSse(text: string): Record<string, unknown> | null {
  let id = "";
  let object = "chat.completion";
  let created = 0;
  let model = "";
  let systemFingerprint = "";
  let serviceTier = "";
  let role = "assistant";
  let content = "";
  let reasoning = "";
  let finishReason = "";
  let usage: Record<string, unknown> | null = null;
  let sawEvent = false;

  for (const line of text.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (trimmed === "" || trimmed.startsWith(":")) continue;
    if (trimmed === "data: [DONE]") break;
    if (!trimmed.startsWith("data: ")) continue;
    let chunk: SseChunk;
    try {
      chunk = JSON.parse(trimmed.slice(6)) as SseChunk;
    } catch {
      continue;
    }
    sawEvent = true;
    if (id === "" && typeof chunk.id === "string") id = chunk.id;
    if (created === 0 && typeof chunk.created === "number") created = chunk.created;
    if (model === "" && typeof chunk.model === "string") model = chunk.model;
    if (systemFingerprint === "" && typeof chunk.system_fingerprint === "string") {
      systemFingerprint = chunk.system_fingerprint;
    }
    if (serviceTier === "" && typeof chunk.service_tier === "string") serviceTier = chunk.service_tier;
    if (chunk.usage && typeof chunk.usage === "object") usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? choice.message;
    if (delta) {
      if (typeof delta.role === "string" && delta.role !== "") role = delta.role;
      if (typeof delta.content === "string") content += delta.content;
      if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
    }
    if (typeof choice.finish_reason === "string" && choice.finish_reason !== "") {
      finishReason = choice.finish_reason;
    }
  }
  if (!sawEvent && content === "" && reasoning === "" && usage === null) return null;

  const message: Record<string, unknown> = { role, content };
  if (reasoning !== "") message["reasoning_content"] = reasoning;
  const out: Record<string, unknown> = {
    id,
    object,
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
  };
  if (usage !== null) out["usage"] = usage;
  if (systemFingerprint !== "") out["system_fingerprint"] = systemFingerprint;
  if (serviceTier !== "") out["service_tier"] = serviceTier;
  return out;
}

// --- 主处理 ---

interface ChatCompletionRequest {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
  [key: string]: unknown;
}

function jsonError(err: unknown): Response {
  const body = JSON.stringify(openAIErrorBody(err));
  const status = err instanceof GatewayError ? err.status : 400;
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** GET/POST /v1/chat/completions 入口。返回 Response(index.ts 加 CORS)。 */
export async function handleChatCompletions(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return jsonError(new GatewayError(405, "method_not_allowed", "method not allowed; use POST"));
  }

  let payload: ChatCompletionRequest;
  try {
    payload = (await request.json()) as ChatCompletionRequest;
  } catch {
    return jsonError(new GatewayError(400, "invalid_json", "invalid json body"));
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return jsonError(new GatewayError(400, "invalid_json", "invalid json body"));
  }
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    return jsonError(
      new GatewayError(400, "invalid_messages", "invalid request: messages must be a non-empty array"),
    );
  }
  for (const m of payload.messages as ChatMessage[]) {
    if (m === null || typeof m !== "object" || Array.isArray(m)) {
      return jsonError(new GatewayError(400, "invalid_messages", "invalid request: messages entries must be objects"));
    }
  }

  // 模型解析:model 字段胜于 nv-function-id 头;body pin 胜于一切(executor.go resolveInvokeTarget)
  const requestedModel =
    typeof payload.model === "string" && payload.model.trim() !== "" ? payload.model.trim() : DEFAULT_MODEL;
  const pinFromHeader = request.headers.get("nv-function-id") ?? "";
  const nsOverride = request.headers.get("nv-function-namespace") ?? "";
  const slugHeader = (request.headers.get("nv-function-slug") ?? "").trim();
  const hasBodyPin = requestedModel.includes("@");

  let target;
  try {
    if (!hasBodyPin && slugHeader !== "") {
      target = resolveUnlistedTarget(slugHeader, pinFromHeader, nsOverride);
    } else {
      target = resolveInvokeTarget(requestedModel, pinFromHeader, nsOverride);
    }
  } catch (err) {
    return jsonError(err);
  }

  const stream = payload.stream === true;
  let upstreamBody: string;
  try {
    upstreamBody = buildUpstreamBody(payload, stream, target.canonical);
  } catch (err) {
    return jsonError(err instanceof GatewayError ? err : new GatewayError(400, "invalid_json", "invalid json body"));
  }

  const clientToken = request.headers.get("nv-captcha-token") ?? "";

  // 非流式:上游 120s 超时 → 504;流式:不设人工超时(不中断进行中的 SSE)
  const controller = stream ? undefined : abortAfterTimeout(NON_STREAM_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await doPredict(target.info, upstreamBody, clientToken, acquire, controller?.signal);
  } catch (err) {
    controller?.abort();
    return jsonError(err);
  }

  if (stream) {
    return streamUpstreamSse(upstream);
  }
  return nonStreamResponse(upstream);
}

function abortAfterTimeout(ms: number): AbortController {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  // 定时器只在请求上下文内存活;worker 请求结束后自动清理
  void timer;
  return controller;
}

// --- 流式:SSE 透传(TransformStream) ---

function streamUpstreamSse(upstream: Response): Response {
  // workerd:上游 ReadableStream 经 identity TransformStream 透传(字节级不变,
  // 保留 SSE 结构:data: 行、[DONE]、keep-alive;供未来过滤/改写的接缝)。
  const pass = new TransformStream<Uint8Array, Uint8Array>();
  const body = upstream.body !== null ? upstream.body.pipeThrough(pass) : new ReadableStream<Uint8Array>();
  const headers = new Headers();
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache");
  headers.set("Connection", "keep-alive");
  const contentType = upstream.headers.get("Content-Type");
  if (contentType !== null && contentType.includes("text/event-stream")) {
    headers.set("X-Upstream-Content-Type", contentType);
  }
  return new Response(body, { status: 200, headers });
}

// --- 非流式:上游 JSON(或 SSE 兜底聚合)---

async function nonStreamResponse(upstream: Response): Promise<Response> {
  const contentType = upstream.headers.get("Content-Type") ?? "";
  const text = await upstream.text();

  let out: Record<string, unknown> | null = null;
  // NVIDIA's predict returns a JSON chat.completion body with a misleading
  // text/event-stream Content-Type, so try the JSON parse FIRST and fall
  // back to SSE aggregation only when the body is not JSON.
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      out = parsed as Record<string, unknown>;
    }
  } catch {
    out = null;
  }
  if (out === null) {
    out = aggregateSse(text);
  }
  if (out === null) {
    console.error(`[npg-gw] unparseable upstream: status=${upstream.status} ct=${contentType} len=${text.length} head=${JSON.stringify(text.slice(0, 200))}`);
    return jsonError(new GatewayError(502, "upstream_error", "upstream returned an unparseable response"));
  }
  return new Response(JSON.stringify(out), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
