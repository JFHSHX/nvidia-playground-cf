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
      const request = new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      const resp = await handleChatCompletions(request);
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
