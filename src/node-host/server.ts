// src/node-host/server.ts — Node-native server entry: node:http exposing the
// same OpenAI-compatible API as the workerd worker (src/index.ts), with the
// hsw.js bundle executed in a node:vm context (hsw-node.ts) instead of a
// Dynamic Worker. Run with: npx tsx src/node-host/server.ts (Windows native).
import http from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { handleChatCompletions } from "../gateway/chat";
import { MODEL_SNAPSHOT, DEFAULT_MODEL } from "../gateway/models-snapshot";
import { setSolveOverride } from "../hcaptcha/getcaptcha";
import { solveN as vmSolveN, cryptoMode as vmCryptoMode } from "./hsw-node";
import { browserSolveN, browserCryptoMode } from "./browser-solver";
import { initFileLog } from "./logger";
import { degenerateGuard } from "./degenerate";

initFileLog();

const PORT = Number(process.env.PORT ?? 8787);

// The hsw bundle's async wasm init can reject inside the vm (e.g. a wasm
// trap); an unhandled rejection would kill the process by default. Log and
// keep serving instead.
process.on("unhandledRejection", (reason) => {
  console.error(`[npg] unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});
process.on("uncaughtException", (err) => {
  console.error(`[npg] uncaughtException: ${err.stack ?? err.message}`);
});

// Route all solver calls to the chosen implementation (must be set before
// any solve). The current hsw wasm traps in every embedder except a real
// browser, so the browser solver is the default; NPG_SOLVER=vm forces the
// node:vm runner.
if ((process.env.NPG_SOLVER ?? "browser") === "vm") {
  setSolveOverride({ solveN: vmSolveN, cryptoMode: vmCryptoMode });
} else {
  setSolveOverride({ solveN: browserSolveN, cryptoMode: browserCryptoMode });
}
const SOLVER_NAME = (process.env.NPG_SOLVER ?? "browser");

// --- keep-alive warmer:保持 NVCF 实例温热(队列感知) ---
// 实例缩容后,下一次真实请求会撞上冷启动(可用模型 5-30s)或直接 502
// "Retries exhausted 3/3"。但共享实例 ACTIVE 而队列爆满时(queueDepth 数百),
// predict 进队后 NVIDIA 网关自己的 3 次重试(~80s each)等不到队头就 500
// "Retries exhausted 3/3"——此时预热 ping 只是给死队列再加一个请求 + 白耗
// hCaptcha 求解,反而有害。队列浅时 ping 才有保持温热的价值。queues 端点
// 免认证(实测只需 Origin/Referer)。
const KEEPALIVE_MS = Number(process.env.NPG_KEEPALIVE_MS ?? 60_000);
const KEEPALIVE_MODELS = (process.env.NPG_KEEPALIVE_MODELS ?? "z-ai/glm-5-3").split(",").map((s) => s.trim()).filter(Boolean);
const QUEUE_SKIP_DEPTH = Number(process.env.NPG_KEEPALIVE_MAX_QUEUE ?? 32);
const QUEUES_ENDPOINT = "https://buildapi.ngc.nvidia.com/v2/predict/queues/models";
const PREDICT_NAMESPACE = "qc69jvmznzxy";

/** queueDepthFor: 查共享实例当前队列深度;查不到返回 -1(未知 → 照常 ping,保守)。 */
async function queueDepthFor(slug: string): Promise<number> {
  try {
    const r = await fetch(`${QUEUES_ENDPOINT}/${PREDICT_NAMESPACE}/${slug}`, {
      headers: { Origin: "https://build.nvidia.com", Referer: "https://build.nvidia.com/" },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return -1;
    const j = await r.json() as { queues?: Array<{ queueDepth?: number }> };
    return j?.queues?.[0]?.queueDepth ?? -1;
  } catch {
    return -1;
  }
}

function keepAliveRequest(modelId: string): Request {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: false }),
  });
}

async function keepAliveLoop(): Promise<void> {
  // 第一轮立即打(server 启动就预热实例),之后按 KEEPALIVE_MS 节奏;首次
  // ping 可能要等 NVCF 实例冷启动(~2min),之后都是快 ping。
  for (let first = true; ; first = false) {
    if (!first) await new Promise((r) => setTimeout(r, KEEPALIVE_MS));
    console.log(`[npg] keep-alive tick ${new Date().toISOString()}`);
    for (const id of KEEPALIVE_MODELS) {
      try {
        // 队列感知:队列深 = 实例本来就热,预热 ping 只会排队 + 白耗求解 → 跳过
        const slug = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
        const depth = await queueDepthFor(slug);
        if (depth > QUEUE_SKIP_DEPTH) {
          console.log(`[npg] keep-alive ${id} skipped: queueDepth ${depth} > ${QUEUE_SKIP_DEPTH} (instance hot, ping would just queue behind ${depth})`);
          continue;
        }
        const r = await throttleFor(id, () => handleChatCompletions(keepAliveRequest(id)));
        // 错误响应不抛异常;按真实状态报告,别把 502 也记成 ok
        console.log(`[npg] keep-alive ${id} ${r.status === 200 ? "ok" : `upstream ${r.status}`}${depth >= 0 ? ` (queueDepth ${depth})` : ""}`);
      } catch (e) {
        console.error(`[npg] keep-alive ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

function withCors(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, nv-function-id, nv-function-slug, nv-function-namespace, nv-captcha-token");
}

function errorBody(message: string, type: string, code: string): string {
  return JSON.stringify({ error: { message, type, code } });
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function writeResponse(resp: Response, res: http.ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  resp.headers.forEach((value, key) => { headers[key] = value; });
  res.writeHead(resp.status, headers);
  if (!resp.body) { res.end(); return; }
  // Stream the body (SSE passthrough stays chunk-by-chunk).
  Readable.fromWeb(resp.body as unknown as NodeWebReadableStream).pipe(res);
}

// Global chat throttle: serialize chat requests and pace them with a minimum
// interval, because rapid programmatic solving escalates hCaptcha's adaptive
// difficulty (observed s=4 → s=17 → 2^34 stamp search, infeasible in JS; the
// difficulty decays after ~10-20 min of lighter use).
const CHAT_MIN_INTERVAL_MS = Number(process.env.NPG_CHAT_INTERVAL_MS ?? 3000);
let chatChain: Promise<unknown> = Promise.resolve();
let lastChatDone = 0;

function throttle<T>(work: () => Promise<T>): Promise<T> {
  const run = chatChain.then(async () => {
    const wait = lastChatDone + CHAT_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await work();
    } finally {
      lastChatDone = Date.now();
    }
  });
  chatChain = run.then(() => undefined, () => undefined);
  return run;
}

// --- per-model throttle queues:不同模型 = 不同 NVCF 函数 = 不同共享队列 ---
// glm-5-3/kimi-k3/nemotron-ultra 各自排各自的队,互相并行(排队时间 ÷ 模型数);
// 每个模型内部仍是 3s 节奏,不触发 hCaptcha 升级。同一模型的多个请求仍串行
// (同一函数只有一条 NVIDIA 队列,开并发只会加深队列、放大 502)。
const chatChains = new Map<string, Promise<unknown>>();
const lastChatDoneByModel = new Map<string, number>();

function poolKey(model: string): string {
  // pin 语法 "<fid>@<model>":池子按 base 模型分
  const at = model.indexOf("@");
  return at >= 0 ? model.slice(at + 1) : model;
}

function throttleFor<T>(model: string, work: () => Promise<T>): Promise<T> {
  const key = poolKey(model);
  const chain = chatChains.get(key) ?? Promise.resolve();
  const run = chain.then(async () => {
    const wait = (lastChatDoneByModel.get(key) ?? 0) + CHAT_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await work();
    } finally {
      lastChatDoneByModel.set(key, Date.now());
    }
  });
  chatChains.set(key, run.then(() => undefined, () => undefined));
  return run;
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  res.on("finish", () => console.log(`req ${req.method} ${req.url} -> ${res.statusCode} ${Date.now() - t0}ms`));
  const url = new URL(req.url ?? "/", "http://localhost");
  withCors(res);
  try {
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", models: Object.keys(MODEL_SNAPSHOT).length, runtime: "node", solver: SOLVER_NAME }));
      return;
    }
    if (url.pathname === "/v1/models") {
      const list = {
        object: "list",
        data: Object.entries(MODEL_SNAPSHOT).map(([id, m]) => ({ id, object: "model", created: 0, owned_by: m.namespace })),
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(list));
      return;
    }
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      const body = await readBody(req);
      // 按请求的模型分队列:不同模型 = 不同 NVCF 共享队列,可互相并行
      let reqModel = DEFAULT_MODEL;
      try {
        const p = JSON.parse(body) as { model?: unknown };
        if (p && typeof p.model === "string" && p.model !== "") reqModel = p.model;
      } catch {
        // bad body:handler 会 400;仍按默认模型节流
      }
      // 每次尝试用全新的 Request(上一次尝试已消费 request 的 body 流,
      // 复用会得到 "invalid json body");body 字符串本身可重复使用。
      const makeReq = () => new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      let resp = await throttleFor(reqModel, () => handleChatCompletions(makeReq()));
      // 可重试的模型方差失败:(a) 空 content;(b) reasoning 重复字符退化
      // ("!!!!…" ×N,dsh 实测触发 harness 的 degenerated 判定)。非流式:
      // 全量检测;SSE:头部扫描(reasoning delta 在到达客户端前拦截)。
      // 检出就整条废弃换新 token 重试,最多 2 次(共 3 次尝试)。
      for (let retry = 1; retry <= 2; retry++) {
        const guarded = await degenerateGuard(resp);
        if (guarded) { resp = guarded; break; }
        console.error(`[npg] degenerate response (empty content or repetition-loop reasoning), retry ${retry}/2`);
        resp = await throttleFor(reqModel, () => handleChatCompletions(makeReq()));
      }
      await writeResponse(resp, res);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(errorBody("not found", "invalid_request_error", "not_found"));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(errorBody(message, "internal_error", "internal_error"));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`nvidia-playground-cf (node host) listening on http://localhost:${PORT}`);
  if (KEEPALIVE_MODELS.length > 0) {
    console.log(`keep-alive warmer on: ${KEEPALIVE_MODELS.join(", ")} every ${KEEPALIVE_MS}ms`);
    void keepAliveLoop();
  }
});
