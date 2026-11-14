// scripts/verify-reliability.ts — P0/P1 无网络回归:默认模型必须指向活快照;
// Pool#acquire timeout 归类队列拥堵并附 queueDepth;NPG_DEBUG_BODY=2 记录完整
// 上游错误体(不受请求体 4KB/默认消息 300 字截断影响)。
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
} finally {
  globalThis.fetch = realFetch;
  console.error = realError;
  if (oldDebug === undefined) delete process.env.NPG_DEBUG_BODY;
  else process.env.NPG_DEBUG_BODY = oldDebug;
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
