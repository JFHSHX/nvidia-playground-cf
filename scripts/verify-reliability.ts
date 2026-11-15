// scripts/verify-reliability.ts — P0/P1 无网络回归:默认模型必须指向活快照;
// Pool#acquire timeout 归类队列拥堵并附 queueDepth;NPG_DEBUG_BODY=2 记录完整
// 上游错误体(不受请求体 4KB/默认消息 300 字截断影响);fetch cause/requestId 与一次安全重试。
import { DEFAULT_MODEL, MODEL_SNAPSHOT } from "../src/gateway/models-snapshot";
import { doPredict, GatewayError, isQueueOverloadFailure } from "../src/gateway/predict";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

check("default model is the revived kimi-k3_1-pro", DEFAULT_MODEL === "moonshotai/kimi-k3_1-pro");
check("default model resolves in snapshot", Object.prototype.hasOwnProperty.call(MODEL_SNAPSHOT, DEFAULT_MODEL));
check(
  "Pool#acquire configured timeout is queue overload",
  isQueueOverloadFailure("Pool#acquire(Duration) has been pending for more than the configured timeout of 45000ms"),
);
check("ordinary upstream 400 is not queue overload", !isQueueOverloadFailure('{"status":400,"detail":"bad request"}'));

const info = MODEL_SNAPSHOT[DEFAULT_MODEL]!;
const realFetch = globalThis.fetch;
const realError = console.error;
const oldDebug = process.env.NPG_DEBUG_BODY;
const logs: string[] = [];
console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

try {
  // Pool#acquire → upstream_queue_overloaded + live queueDepth hint (mocked).
  globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/queues/")) {
      return new Response(JSON.stringify({ queues: [{ queueDepth: 7, functionStatus: "ACTIVE" }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: "Pool#acquire(Duration) has been pending for more than the configured timeout of 45000ms" } }), { status: 500 });
  };
  let queueError: unknown = null;
  await doPredict(info, '{"model":"test"}', "client-token", async () => { throw new Error("must not solve"); }).catch((e) => { queueError = e; });
  check(
    "Pool#acquire maps to queue overload with queueDepth hint",
    queueError instanceof GatewayError && queueError.code === "upstream_queue_overloaded" && queueError.message.includes("queueDepth 7"),
    queueError instanceof Error ? queueError.message : String(queueError),
  );

  // Debug level 2 must retain a marker beyond the old 4KB diagnostic boundary.
  const marker = "END_OF_COMPLETE_UPSTREAM_BODY";
  const raw = JSON.stringify({ error: { message: `${"x".repeat(5000)}${marker}` } });
  globalThis.fetch = async () => new Response(raw, { status: 400 });
  process.env.NPG_DEBUG_BODY = "2";
  logs.length = 0;
  await doPredict(info, '{"model":"test"}', "client-token", async () => { throw new Error("must not solve"); }).catch(() => undefined);
  const output = logs.join("\n");
  check("NPG_DEBUG_BODY=2 logs request body", output.includes("request body:"));
  check("NPG_DEBUG_BODY=2 logs complete upstream response body", output.includes(`complete response body (${raw.length}B): ${raw}`) && output.includes(marker));

  process.env.NPG_DEBUG_BODY = "";
  const makeSocketFailure = (): TypeError => {
    const failure = new TypeError("fetch failed") as TypeError & { cause?: unknown };
    failure.cause = Object.assign(new Error("socket closed"), { code: "UND_ERR_SOCKET", errno: "ECONNRESET", syscall: "read" });
    return failure;
  };

  // 第一次 fetch 在响应头前失败 → 等 1s、换 token,第二次成功。
  let transportCalls = 0;
  let mintCount = 0;
  const seenTokens: string[] = [];
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    transportCalls++;
    seenTokens.push(new Headers(init?.headers).get("nv-captcha-token") ?? "");
    if (transportCalls === 1) throw makeSocketFailure();
    return new Response("{}", { status: 200 });
  };
  logs.length = 0;
  const retriedResponse = await doPredict(
    info,
    '{"model":"test"}',
    "",
    async () => ({ captchaToken: `transport-token-${++mintCount}` }),
    undefined,
    "req-transport",
  );
  const transportOutput = logs.join("\n");
  check("pre-header fetch failure recovers on the single transport retry", retriedResponse.status === 200 && transportCalls === 2);
  check(
    "transport retry mints and sends a fresh one-shot token",
    seenTokens.join(",") === "transport-token-1,transport-token-2",
    seenTokens.join(","),
  );
  check(
    "transport logs retain request id and undici cause fields",
    transportOutput.includes("req=req-transport") && transportOutput.includes("UND_ERR_SOCKET") && transportOutput.includes("ECONNRESET") && transportOutput.includes("syscall=read"),
    transportOutput,
  );

  // 持续失败 → 总计 2 次 fetch(原始 + 唯一一次重试),错误体保留 cause。
  transportCalls = 0;
  mintCount = 0;
  seenTokens.length = 0;
  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    transportCalls++;
    seenTokens.push(new Headers(init?.headers).get("nv-captcha-token") ?? "");
    throw makeSocketFailure();
  };
  let persistentError: unknown = null;
  await doPredict(
    info,
    '{"model":"test"}',
    "",
    async () => ({ captchaToken: `persistent-token-${++mintCount}` }),
    undefined,
    "req-persistent",
  ).catch((e) => { persistentError = e; });
  check("persistent fetch failure stops after exactly one retry", transportCalls === 2 && seenTokens.length === 2);
  check(
    "terminal transport GatewayError exposes the causal diagnosis",
    persistentError instanceof GatewayError && persistentError.code === "upstream_error" && persistentError.message.includes("UND_ERR_SOCKET"),
    persistentError instanceof Error ? persistentError.message : String(persistentError),
  );

  // 客户端 token 不能换发,因此不得自动重放。
  transportCalls = 0;
  globalThis.fetch = async (): Promise<Response> => {
    transportCalls++;
    throw makeSocketFailure();
  };
  let clientTokenError: unknown = null;
  await doPredict(
    info,
    '{"model":"test"}',
    "client-token",
    async () => { throw new Error("must not solve"); },
    undefined,
    "req-client-token",
  ).catch((e) => { clientTokenError = e; });
  check(
    "client-provided token is never transport-retried",
    transportCalls === 1 && clientTokenError instanceof GatewayError && clientTokenError.code === "upstream_error",
  );

  // 已取消请求同样不得重试。
  transportCalls = 0;
  const cancelled = new AbortController();
  cancelled.abort();
  let cancelledError: unknown = null;
  await doPredict(
    info,
    '{"model":"test"}',
    "",
    async () => ({ captchaToken: "cancelled-token" }),
    cancelled.signal,
    "req-cancelled",
  ).catch((e) => { cancelledError = e; });
  check(
    "cancelled request is never transport-retried",
    transportCalls === 1 && cancelledError instanceof GatewayError && cancelledError.status === 504,
  );
} finally {
  globalThis.fetch = realFetch;
  console.error = realError;
  if (oldDebug === undefined) delete process.env.NPG_DEBUG_BODY;
  else process.env.NPG_DEBUG_BODY = oldDebug;
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
