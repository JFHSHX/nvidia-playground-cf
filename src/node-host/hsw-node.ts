// src/node-host/hsw-node.ts — Node-native hsw runner: runs the prepared
// hsw.js bundle (shim + patched hsw.js + export line, from runner.ts
// prepareBundle) inside a node:vm context — no workerd, no Worker Loader
// binding. Windows-native counterpart of runner.ts's Dynamic Worker path;
// the Node server entry (server.ts) injects it via setSolveOverride().
import vm from "node:vm";
import { DISPATCHER, SOLVE_TIMEOUT_MS, loadBundle } from "../hcaptcha/runner";

interface WarmContext {
  handler: { fetch(request: Request): Promise<Response> };
}

// One warm vm context per bundle location (mirrors token.go solverCache and
// runner.ts solverCache; failed loads are dropped so a retry rebuilds).
const contextCache = new Map<string, Promise<WarmContext>>();

/** Builds the vm sandbox: the browser-ish globals the shim and bundle expect
 * (workerd provides these natively; Node 18+ has them all as natives). The
 * sandbox object doubles as `window`/`self` so the shim's self=window
 * adaptation works unchanged. */
function buildContext(): vm.Context {
  const sandbox: Record<string, unknown> = {};
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  const moduleShim: { exports: unknown } = { exports: {} };
  sandbox.module = moduleShim;
  sandbox.exports = moduleShim.exports;
  sandbox.console = console;
  sandbox.TextEncoder = TextEncoder;
  sandbox.TextDecoder = TextDecoder;
  sandbox.btoa = (s: string): string => Buffer.from(s, "binary").toString("base64");
  sandbox.atob = (s: string): string => Buffer.from(s, "base64").toString("binary");
  sandbox.crypto = crypto;
  sandbox.performance = performance;
  sandbox.Blob = Blob;
  sandbox.fetch = fetch;
  sandbox.Request = Request;
  sandbox.Response = Response;
  sandbox.AbortController = AbortController;
  sandbox.AbortSignal = AbortSignal;
  sandbox.URL = URL;
  sandbox.URLSearchParams = URLSearchParams;
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.queueMicrotask = queueMicrotask;
  return vm.createContext(sandbox);
}

async function warmContext(location: string): Promise<WarmContext> {
  const cached = contextCache.get(location);
  if (cached) return cached;
  const p = (async () => {
    const bundle = await loadBundle(location);
    const ctx = buildContext();
    // The DISPATCHER is written as an ESM `export default {...}` for the
    // workerd module loader; a vm classic script instead exposes it as a
    // global so it can be called without vm modules.
    const dispatcherScript = DISPATCHER.replace("export default", "globalThis.__hswHandler =");
    vm.runInContext(bundle.source + "\n" + dispatcherScript, ctx, { filename: "hsw-bundle.js" });
    const handler = (ctx as unknown as { __hswHandler?: WarmContext["handler"] }).__hswHandler;
    if (!handler || typeof handler.fetch !== "function") {
      throw new Error("hsw-node: dispatcher exposed no fetch handler (bundle variant unsupported)");
    }
    return { handler };
  })();
  contextCache.set(location, p);
  p.catch(() => contextCache.delete(location));
  return p;
}

function withTimeout<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${SOLVE_TIMEOUT_MS}ms`)), SOLVE_TIMEOUT_MS);
    timer.unref();
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function b64StdEncode(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function b64LenientDecode(s: string): Uint8Array {
  const b64 = s.replace(/[\s-]/g, "").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** solveN mirrors runner.ts solveN: module.exports(jwt, fpB64) inside the
 * bundle's vm context, via the dispatcher's fetch protocol. Throws Error on
 * rejection or timeout. */
export async function solveN(location: string, jwt: string, fpB64: string): Promise<string> {
  const { handler } = await warmContext(location);
  let resp: Response;
  try {
    resp = await withTimeout(handler.fetch(new Request("https://hsw.internal/solve", {
      method: "POST",
      body: JSON.stringify({ op: "solve", jwt, fp: fpB64 }),
    })), "hsw: solve");
  } catch (e) {
    throw new Error(`hsw: solve timed out after ${SOLVE_TIMEOUT_MS}ms or failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const out = await resp.json() as { ok: boolean; n?: string; error?: string };
  if (!out.ok) throw new Error(`hsw: solve rejected: ${out.error ?? "unknown"}`);
  return out.n ?? "";
}

/** cryptoMode mirrors runner.ts cryptoMode: one of the bundle's crypto modes
 * (1 = encrypt, 0 = decrypt) inside the bundle's vm context; data is
 * exchanged as base64. */
export async function cryptoMode(location: string, mode: number, data: Uint8Array): Promise<Uint8Array> {
  const { handler } = await warmContext(location);
  let resp: Response;
  try {
    resp = await withTimeout(handler.fetch(new Request("https://hsw.internal/crypto", {
      method: "POST",
      body: JSON.stringify({ op: "crypto", mode, data: b64StdEncode(data) }),
    })), `hsw: crypto mode ${mode}`);
  } catch (e) {
    throw new Error(`hsw: crypto mode ${mode} timed out after ${SOLVE_TIMEOUT_MS}ms or failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const out = await resp.json() as { ok: boolean; b64?: string; error?: string };
  if (!out.ok || !out.b64) throw new Error(`hsw: crypto mode ${mode} failed: ${out.error ?? "unknown"}`);
  return b64LenientDecode(out.b64);
}
