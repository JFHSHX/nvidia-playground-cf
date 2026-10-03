// src/node-host/server.ts — Node-native server entry: node:http exposing the
// same OpenAI-compatible API as the workerd worker (src/index.ts), with the
// hsw.js bundle executed in a node:vm context (hsw-node.ts) instead of a
// Dynamic Worker. Run with: npx tsx src/node-host/server.ts (Windows native).
import http from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { handleChatCompletions } from "../gateway/chat";
import { MODEL_SNAPSHOT } from "../gateway/models-snapshot";
import { setSolveOverride } from "../hcaptcha/getcaptcha";
import { solveN as vmSolveN, cryptoMode as vmCryptoMode } from "./hsw-node";
import { browserSolveN, browserCryptoMode } from "./browser-solver";
import { initFileLog } from "./logger";

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

function withCors(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, nv-function-id, nv-function-slug, nv-function-namespace, nv-captcha-token");
}

function errorBody(message: string, type: string, code: string): string {
  return JSON.stringify({ error: { message, type, code } });
}

/** isEmptyAssistantContent: true when a non-stream JSON response carries an
 * assistant message with null/empty content (a thinking model that spent its
 * whole token budget on reasoning). Reads a CLONE so the original response
 * stays writable. */
async function isEmptyAssistantContent(resp: Response): Promise<boolean> {
  try {
    const ct = resp.headers.get("content-type") ?? "";
    if (resp.status !== 200) return false; // 错误响应不是"空 content",别浪费重试
    if (!ct.includes("application/json")) return false; // streaming: never touched
    const body = await resp.clone().json() as { choices?: Array<{ message?: { content?: string | null } }> };
    const msg = body?.choices?.[0]?.message;
    return !msg || msg.content === null || msg.content === "";
  } catch {
    return false;
  }
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
      // 每次尝试用全新的 Request(上一次尝试已消费 request 的 body 流,
      // 复用会得到 "invalid json body");body 字符串本身可重复使用。
      const makeReq = () => new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      let resp = await throttle(() => handleChatCompletions(makeReq()));
      // 思考模型(kimi-k3 等)偶发把全部 token 花在 reasoning 上,content 返回
      // null → harness/客户端拿到空回合。检测到空 content 就换新 token 重试
      // 一次(采样方差通常第二次就有 content)。
      if (await isEmptyAssistantContent(resp)) {
        console.error(`[npg] empty content in response, retrying once with a fresh token`);
        resp = await throttle(() => handleChatCompletions(makeReq()));
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
});
