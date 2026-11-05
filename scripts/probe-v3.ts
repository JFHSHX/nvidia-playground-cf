// scripts/probe-v3.ts — probe the V3 stateless predict path discovered via
// packet capture: POST /v3/predict/stateless/models/{ns}/{slug} accepted our
// request shape (400 "Token is invalid" with an expired token, kaizen
// problem-details format — route EXISTS, unlike /v3/protected/* which 403s
// RBAC). Goal: mint a fresh captcha token via the project's own pipeline and
// test whether V3 is a WORKING alternate predict path — and whether it shares
// the v2 queue. Fast 200 while the v2 queue is deep => different queue, real
// alternative. ~120s+ then 500 "Retries exhausted" => same queue, dead end.
//
// Run: npx tsx scripts/probe-v3.ts [model-id]   (default z-ai/glm-5-3)
import { acquireNvCaptcha } from "../src/hcaptcha/index";
import { setSolveOverride } from "../src/hcaptcha/getcaptcha";
import { browserSolveN, browserCryptoMode } from "../src/node-host/browser-solver";
import { MODEL_SNAPSHOT } from "../src/gateway/models-snapshot";

setSolveOverride({ solveN: browserSolveN, cryptoMode: browserCryptoMode });

const modelId = process.argv[2] ?? "z-ai/glm-5-3";
const info = MODEL_SNAPSHOT[modelId];
if (!info) {
  console.error(`[probe-v3] unknown model ${modelId}; known: ${Object.keys(MODEL_SNAPSHOT).join(", ")}`);
  process.exit(1);
}

const PREDICT_BASE = "https://buildapi.ngc.nvidia.com";
const queuesUrl = `${PREDICT_BASE}/v2/predict/queues/models/${info.namespace}/${info.slug}`;
const v3Url = `${PREDICT_BASE}/v3/predict/stateless/models/${info.namespace}/${info.slug}`;
const H: Record<string, string> = { Origin: "https://build.nvidia.com", Referer: "https://build.nvidia.com/" };

async function queues(): Promise<string> {
  try {
    const r = await fetch(queuesUrl, { headers: H });
    const j = (await r.json()) as { queues?: Array<{ queueDepth?: number; functionStatus?: string }> };
    const q = j.queues?.[0];
    return q ? `depth=${q.queueDepth} status=${q.functionStatus}` : "empty";
  } catch (e) {
    return `ERR ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function main(): Promise<void> {
  console.log(`[probe-v3] ${modelId} queue before: ${await queues()}`);

  console.log("[probe-v3] minting fresh captcha token (full solve)...");
  const t0 = Date.now();
  const { captchaToken } = await acquireNvCaptcha(info.slug);
  console.log(`[probe-v3] token minted in ${Date.now() - t0}ms (len ${captchaToken.length})`);

  const body = JSON.stringify({
    model: info.model ?? modelId,
    messages: [{ role: "user", content: "Say OK" }],
    stream: true,
  });

  console.log(`[probe-v3] POST ${v3Url}`);
  const t1 = Date.now();
  let resp: Response;
  try {
    resp = await fetch(v3Url, {
      method: "POST",
      headers: {
        ...H,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "nv-function-id": info.functionId,
        "nv-captcha-token": captchaToken,
      },
      body,
      signal: AbortSignal.timeout(300_000),
    });
  } catch (e) {
    console.log(`[probe-v3] fetch failed after ${Date.now() - t1}ms: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  console.log(`[probe-v3] status ${resp.status} after ${Date.now() - t1}ms`);
  const ct = resp.headers.get("content-type") ?? "";
  console.log(`[probe-v3] content-type: ${ct}`);
  for (const [k, v] of resp.headers) {
    if (/^(nv-|x-envoy|x-request|retry|ratelimit|x-ratelimit)/i.test(k)) console.log(`  ${k}: ${v}`);
  }

  // Read up to 2KB of the body then cancel — enough for the verdict
  // (SSE chunks on success; a kaizen/v2 error JSON on failure).
  const reader = resp.body?.getReader();
  if (reader) {
    const enc = new TextDecoder();
    let seen = 0;
    try {
      while (seen < 2048) {
        const { done, value } = await reader.read();
        if (done) break;
        process.stdout.write(enc.decode(value, { stream: true }));
        seen += value.length;
        if (!ct.includes("event-stream")) break; // non-SSE: one JSON body
      }
      console.log();
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  console.log(`[probe-v3] ${modelId} queue after: ${await queues()}`);
}

main().catch((e) => {
  console.error(`[probe-v3] ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(1);
});
