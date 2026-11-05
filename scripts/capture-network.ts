// scripts/capture-network.ts — Playwright capture of every network request the
// build.nvidia.com playground makes during a manual chat session. Goal: find
// congestion-relevant paths (cancel endpoints, queue-position polling, function
// id variants, the UI's own retry policy) by recording full headers/bodies for
// NVIDIA hosts and urls-only for the rest.
// Usage: npx tsx scripts/capture-network.ts [model-path]
//   e.g. npx tsx scripts/capture-network.ts z-ai/glm-5-3
// Output: logs/capture-<ts>.ndjson (one JSON object per line).
// Browser is HEADFUL by default (profile .capture-profile/ so captcha/login
// state persists across runs); interact manually and close the window (or
// Ctrl+C) to stop. NPG_CAPTURE_HEADLESS=1 forces headless (smoke tests).
import { chromium, type BrowserContext, type Request, type Response, type WebSocket } from "playwright";
import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const MODEL = process.argv[2] ?? "z-ai/glm-5-3";
const START_URL = `https://build.nvidia.com/${MODEL}`;
const PROFILE = ".capture-profile";
const OUT_DIR = "logs";
const BODY_CAP = 128 * 1024; // generous on purpose: 4KB caps hid detail fields before
const FRAME_CAP = 4 * 1024;

// Full headers/body capture for NVIDIA hosts; urls-only for the rest.
const NVIDIA_HOSTS = ["nvidia.com"];
function isNvidia(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return NVIDIA_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, `capture-${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`);
let nReq = 0, nResp = 0, nFail = 0, nWs = 0;
function line(obj: unknown): void {
  appendFileSync(outPath, `${JSON.stringify(obj)}\n`);
}
function now(): string {
  return new Date().toISOString();
}

const context: BrowserContext = await chromium.launchPersistentContext(PROFILE, {
  headless: process.env.NPG_CAPTURE_HEADLESS === "1",
  viewport: null,
});

context.on("request", (req: Request) => {
  nReq++;
  const rec: Record<string, unknown> = { t: now(), dir: "req", method: req.method(), url: req.url(), type: req.resourceType() };
  if (isNvidia(req.url())) {
    rec.headers = req.headers();
    if (req.method() !== "GET") rec.postData = req.postData();
  }
  line(rec);
});

context.on("response", (resp: Response) => {
  nResp++;
  const rec: Record<string, unknown> = { t: now(), dir: "resp", status: resp.status(), url: resp.url() };
  if (!isNvidia(resp.url())) {
    line(rec);
    return;
  }
  rec.headers = resp.headers();
  const ct = resp.headers()["content-type"] ?? "";
  if (!/text|json|event-stream|javascript/.test(ct)) {
    line(rec);
    return;
  }
  // SSE bodies resolve at stream end; a client-side abort rejects — caught below.
  void resp
    .text()
    .then((body) => {
      rec.body = body.length > BODY_CAP ? `${body.slice(0, BODY_CAP)}…(+${body.length - BODY_CAP}B truncated)` : body;
      line(rec);
    })
    .catch(() => {
      rec.body = "<body unavailable>";
      line(rec);
    });
});

context.on("requestfailed", (req: Request) => {
  nFail++;
  line({ t: now(), dir: "fail", method: req.method(), url: req.url(), error: req.failure()?.errorText ?? "unknown" });
});

context.on("websocket", (ws: WebSocket) => {
  nWs++;
  line({ t: now(), dir: "ws-open", url: ws.url() });
  ws.on("framesent", (f) =>
    line({
      t: now(), dir: "ws-send", url: ws.url(),
      payload: typeof f.payload === "string"
        ? (f.payload.length > FRAME_CAP ? `${f.payload.slice(0, FRAME_CAP)}…` : f.payload)
        : `<binary ${f.payload.length}B>`,
    }),
  );
  ws.on("framereceived", (f) =>
    line({
      t: now(), dir: "ws-recv", url: ws.url(),
      payload: typeof f.payload === "string"
        ? (f.payload.length > FRAME_CAP ? `${f.payload.slice(0, FRAME_CAP)}…` : f.payload)
        : `<binary ${f.payload.length}B>`,
    }),
  );
  ws.on("close", () => line({ t: now(), dir: "ws-close", url: ws.url() }));
});

const page = context.pages()[0] ?? (await context.newPage());
await page.goto(START_URL, { waitUntil: "domcontentloaded" }).catch((e) => console.error(`[capture] goto failed: ${e}`));

console.log(`[capture] page: ${START_URL}`);
console.log(`[capture] recording -> ${outPath}`);
console.log(`[capture] interact manually (send a message; solve captcha if shown). Close the browser window or Ctrl+C to stop.`);

function summary(): void {
  console.log(`[capture] summary: ${nReq} req / ${nResp} resp / ${nFail} failed / ${nWs} ws -> ${outPath}`);
}
context.on("close", () => { summary(); process.exit(0); });
process.on("SIGINT", () => { summary(); void context.close().finally(() => process.exit(0)); });
setInterval(() => undefined, 1 << 30); // keep the process alive; close event exits
