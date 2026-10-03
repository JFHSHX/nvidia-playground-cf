// src/hcaptcha/runner.ts — TS port of internal/hsw (reference/go/hsw.go +
// fetch.go): downloads and patches hCaptcha's hsw.js bundle, runs it inside a
// Dynamic Worker (Worker Loader binding), and exposes SolveN/Crypto
// equivalents.
//
// Architecture change vs the Go implementation (deliberate):
// - Go runs hsw.js inside an embedded v8go isolate with a shim; workerd
//   disallows eval()/new Function during request handling (the
//   allow_eval_during_startup flag is startup-only), so the patched bundle is
//   loaded as a Dynamic Worker module via env.LOADER.get(id, factory) —
//   runtime code execution without eval. The loader caches one warm worker
//   per bundle location (mirrors token.go's solverCache).
// - Go's syncWasmInstantiate patch (v8go never settles the promise form of
//   WebAssembly.instantiate) is NOT ported: workerd settles promises
//   natively.
// - The dispatcher appended to the bundle exposes solve/crypto over an
//   internal entrypoint fetch (no real network; globalOutbound null blocks
//   outbound access from the dynamic worker).
import { buildShim } from "./shim";
import { ASSET_BASE } from "./fingerprint";

/** Where hCaptcha serves hsw.js and challenge assets (hsw.go:32). */
export { ASSET_BASE };
/** The config endpoint that returns the challenge JWT and bundle location
 * (hsw.go:35). */
export const CHECKSITE_BASE = "https://api.hcaptcha.com/checksiteconfig";

/** Browser UA hCaptcha's asset frontend sends (fetch.go:94, getcaptcha.go:56). */
export const HSW_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Bounds a single solve/crypto execution (hsw.go:30 DefaultSolveTimeout). */
export const SOLVE_TIMEOUT_MS = 10_000;
const MAX_BUNDLE_SIZE = 16 << 20; // hsw.js is ~1 MB; be generous.
const DYN_COMPAT_DATE = "2026-09-01";

// --- bundle patching (fetch.go:213-265 Prepare) ---

/** Matches the v1 bundle tail: window.hsw = function(...)...
 * (fetch.go:50). */
const reWindowHSW = /window\.hsw\s*=/;
/** Matches wasm-bindgen's embedded base64 WASM literal, e.g.
 * instantiate(..., 0, null, "<base64>",...) (fetch.go:54). */
const reEmbeddedWasm = /0,\s*null,\s*"([A-Za-z0-9+/=]{200,})"/;
/** Matches a data: URL carrying the wasm base64 (fetch.go:56). */
const reDataWasm = /data:(?:application\/octet-stream|application\/wasm);base64,([A-Za-z0-9+/=]{200,})/;

// --- sync wasm instantiation (fetch.go:252-307) ---

// reInstantiateThen matches the promise-based wasm instantiate call found in
// v1 bundles. hCaptcha renames the local variables between bundle releases
// (e.g. "Lc=WebAssembly.instantiate(vv,afs).then(function(vv){ajz(vv)})" and
// "NN=WebAssembly.instantiate(cl,_l).then(function(cl){xL(cl)})"), so the
// rewrite is shape-based rather than byte-identical:
//
// X = WebAssembly.instantiate(bytes, imports).then(function(cb){fn(cb)})
const reInstantiateThen = /([A-Za-z0-9_$]+)=WebAssembly\.instantiate\(([A-Za-z0-9_$]+),([A-Za-z0-9_$]+)\)\.then\(function\(([A-Za-z0-9_$]+)\)\{([A-Za-z0-9_$]+)\([A-Za-z0-9_$]+\)\}\)/;

// reInstantiateBare matches the same call without the .then callback.
const reInstantiateBare = /([A-Za-z0-9_$]+)=WebAssembly\.instantiate\(([A-Za-z0-9_$]+),([A-Za-z0-9_$]+)\)/;

/** syncWasmInstantiate rewrites the promise-based instantiate call found in
 * v1 bundles into a synchronous Module + Instance pair wrapped in an already
 * resolved Promise, preserving the {module, instance} shape that the
 * original then-callback receives. Returns [out, applied]. The glue's init
 * is fire-and-forget, so the dispatcher's solve can run before the promise
 * settles and trap the wasm — needed on workerd as much as on v8go. */
function syncWasmInstantiate(src: string): [string, number] {
  const m = reInstantiateThen.exec(src);
  if (!m) return [src, 0];
  const repl = m[1] + "=(function(){var __m=new WebAssembly.Module(" + m[2] +
    ");var __i=new WebAssembly.Instance(__m," + m[3] +
    ");var __r={module:__m,instance:__i};queueMicrotask(function(){" + m[5] +
    "(__r)});return Promise.resolve(__r)})()";
  return [src.replaceAll(m[0], repl), 1];
}

/** syncWasmInstantiateBare handles the no-then variant. */
function syncWasmInstantiateBare(src: string): [string, number] {
  const m = reInstantiateBare.exec(src);
  if (!m) return [src, 0];
  const repl = m[1] + "=(function(){var __m=new WebAssembly.Module(" + m[2] +
    ");var __i=new WebAssembly.Instance(__m," + m[3] +
    ");return Promise.resolve({module:__m,instance:__i})})()";
  return [src.replaceAll(m[0], repl), 1];
}

/** A fully prepared hsw.js execution unit (fetch.go:59-67 Bundle). */
export interface HswBundle {
  location: string;
  url: string;
  version: string; // "v1" (window.hsw) | "v2-node" | "v2" | "unknown"
  wasmB64: string; // embedded v2 wasm base64, empty for v1
  source: string; // complete script: shim + patched hsw.js + export line
}

/** AssetURL builds the hsw.js URL for a location: a leading "/" means the
 * location is already a path; otherwise prefixed with "/c/"
 * (fetch.go:165-171). */
export function assetURL(location: string): string {
  const loc = location.replace(/\/$/, "");
  if (loc.startsWith("/")) return ASSET_BASE + loc + "/hsw.js";
  return ASSET_BASE + "/c/" + loc + "/hsw.js";
}

function b64urlDecodePart(seg: string): Uint8Array {
  const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** LocationFromJWT extracts the hsw.js bundle location from a challenge JWT
 * payload's "l" claim (fetch.go:131-150). */
export function locationFromJWT(jwt: string): string {
  const parts = jwt.split(".");
  if (parts.length < 2) throw new Error("jwt: expected <header>.<payload>");
  let claims: { l?: string };
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlDecodePart(parts[1]!))) as { l?: string };
  } catch (e) {
    throw new Error(`jwt payload decode: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!claims.l) throw new Error("jwt payload has no l claim");
  return claims.l;
}

/** Download fetches the raw hsw.js for location with browser headers
 * (fetch.go:174-196). */
export async function downloadBundle(location: string): Promise<Uint8Array> {
  const u = assetURL(location);
  let resp: Response;
  try {
    resp = await fetch(u, { headers: { "User-Agent": HSW_UA, Accept: "*/*" } });
  } catch (e) {
    throw new Error(`hsw download ${u}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (resp.status !== 200) {
    throw new Error(`hsw download ${u}: HTTP ${resp.status}`);
  }
  const buf = new Uint8Array(await resp.arrayBuffer());
  return buf.length > MAX_BUNDLE_SIZE ? buf.slice(0, MAX_BUNDLE_SIZE) : buf;
}

/** Prepare runs patching + wrapping on raw hsw.js bytes (fetch.go:214-265):
 * neutralize browser-only feature tests, detect the export binding, extract
 * the embedded v2 wasm, wrap with the shim. The syncWasmInstantiate rewrite
 * is deliberately NOT ported (workerd settles wasm promises natively). */
export function prepareBundle(raw: Uint8Array): HswBundle {
  const src = new TextDecoder().decode(raw);

  // Neutralize feature tests that assume a real browser DOM (fetch.go:221-223).
  const patched = src
    .replaceAll("J(I).language", '"en-US"')
    .replaceAll("instanceof Window", "instanceof Object")
    .replaceAll("instanceof PerformanceResourceTiming", "instanceof Object");

  // Detect the export binding so the appended export line matches reality
  // (fetch.go:226-237).
  let exportLine = "module.exports = hsw;";
  let version = "unknown";
  if (reWindowHSW.test(patched)) {
    version = "v1";
    exportLine = "module.exports = window.hsw;";
  } else if (patched.includes("module.exports")) {
    version = "v2-node";
    exportLine = "";
  } else if (patched.includes("__wbg_") || patched.includes("wasm-bindgen")) {
    version = "v2";
  }

  // Embedded v2 wasm (fetch-mock target). v1 assembles its wasm from several
  // atob() chunks, so nothing to extract there (fetch.go:240-246).
  let wasm64 = "";
  const m1 = reEmbeddedWasm.exec(patched);
  if (m1) wasm64 = m1[1]!;
  else {
    const m2 = reDataWasm.exec(patched);
    if (m2) wasm64 = m2[1]!;
  }

  // NOTE: the syncWasmInstantiate patch (Go fetch.go:252-307) is deliberately
  // NOT applied: it exists only for v8go, which never settles the promise
  // form of WebAssembly.instantiate. workerd settles it natively, and so does
  // Node — but workerd DISALLOWS wasm code generation from bytes
  // ("WebAssembly.Module(): Wasm code generation disallowed by embedder"),
  // so the constructor form breaks the workerd path. Keep the promise form.

  return {
    location: "",
    url: "",
    version,
    wasmB64: wasm64,
    source: buildShim(wasm64) + "\n" + patched + "\n" + exportLine,
  };
}

/** Load downloads and prepares a Bundle for location (fetch.go:199-211). */
export async function loadBundle(location: string): Promise<HswBundle> {
  const raw = await downloadBundle(location);
  const b = prepareBundle(raw);
  b.location = location;
  b.url = assetURL(location);
  return b;
}

// --- Dynamic Worker (Worker Loader) glue ---

/** Minimal structural types for the Worker Loader binding; declared locally
 * so the port does not depend on a specific @cloudflare/workers-types
 * version. */
interface WorkerLoaderSource {
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  mainModule: string;
  modules: Record<string, string | ArrayBuffer | Uint8Array>;
  globalOutbound?: unknown;
}
interface WorkerLoaderStub {
  getEntrypoint(): { fetch(request: Request): Promise<Response> };
}
interface WorkerLoaderBinding {
  get(id: string, factory: () => WorkerLoaderSource | Promise<WorkerLoaderSource>): WorkerLoaderStub;
  load(source: WorkerLoaderSource): WorkerLoaderStub;
}

/** The dispatcher appended to the prepared bundle inside the dynamic worker:
 * solve -> hsw(jwt, fp); crypto -> hsw(mode, bytes). Responses are JSON:
 * {ok:true,n} / {ok:true,b64} / {ok:false,error}. */
export const DISPATCHER = `
function __b64ToBytes(b64) {
var bin = atob(b64);
var u = new Uint8Array(bin.length);
for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
return u;
}
function __bytesToB64(u8) {
var out = [];
for (var i = 0; i < u8.length; i += 0x8000) out.push(String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)));
return btoa(out.join(""));
}
export default {
async fetch(request) {
var body = await request.json();
try {
if (body.op === "crypto") {
var r = await window.hsw(body.mode, __b64ToBytes(body.data));
return new Response(JSON.stringify({ ok: true, b64: __bytesToB64(r) }), { headers: { "content-type": "application/json" } });
}
var fn = (typeof module !== "undefined" && module.exports && typeof module.exports === "function") ? module.exports : window.hsw;
if (typeof fn !== "function") throw new Error("hsw: no solve entry (bundle variant unsupported)");
var n = await fn(body.jwt, body.fp);
return new Response(JSON.stringify({ ok: true, n: String(n) }), { headers: { "content-type": "application/json" } });
} catch (e) {
return new Response(JSON.stringify({ ok: false, error: String((e && e.message) || e) }), { status: 500, headers: { "content-type": "application/json" } });
}
}
};
`;

/** LOADER binding access via cloudflare:workers (no contract change for
 * acquireNvCaptcha; only callable inside a request context). */
async function getLoader(): Promise<WorkerLoaderBinding> {
  const { env } = await import("cloudflare:workers");
  const loader = (env as unknown as { LOADER?: WorkerLoaderBinding }).LOADER;
  if (!loader) {
    throw new Error('hsw: LOADER binding missing (add [[worker_loaders]] binding = "LOADER" to wrangler.toml)');
  }
  return loader;
}

// Solver cache: one warm dynamic worker per bundle location, cached as an
// in-flight promise (mirrors token.go solverCache + dedupes concurrent
// loads). Failed loads are dropped so a retry can rebuild.
const solverCache = new Map<string, Promise<WorkerLoaderStub>>();

/** solverStub returns the cached dynamic worker for location, downloading,
 * patching and wrapping the hsw.js bundle on a cache miss. */
function solverStub(location: string): Promise<WorkerLoaderStub> {
  const cached = solverCache.get(location);
  if (cached) return cached;
  const p = (async () => {
    return (await getLoader()).get("hsw:" + location, async () => {
      const bundle = await loadBundle(location);
      return {
        compatibilityDate: DYN_COMPAT_DATE,
        mainModule: "hsw-worker.js",
        modules: { "hsw-worker.js": bundle.source + "\n" + DISPATCHER },
        globalOutbound: null,
      };
    });
  })();
  solverCache.set(location, p);
  p.catch(() => solverCache.delete(location));
  return p;
}

/** SolveN runs module.exports(jwt, fpB64) inside the bundle's dynamic worker
 * and returns the resolved n (hsw.go:183-267 SolveN). Throws Error on
 * failure (JS rejection surfaced with its message) or timeout. */
export async function solveN(location: string, jwt: string, fpB64: string): Promise<string> {
  const stub = await solverStub(location);
  let resp: Response;
  try {
    resp = await stub.getEntrypoint().fetch(new Request("https://hsw.internal/solve", {
      method: "POST",
      body: JSON.stringify({ op: "solve", jwt, fp: fpB64 }),
      signal: AbortSignal.timeout(SOLVE_TIMEOUT_MS),
    }));
  } catch (e) {
    throw new Error(`hsw: solve timed out after ${SOLVE_TIMEOUT_MS}ms or failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const out = await resp.json() as { ok: boolean; n?: string; error?: string };
  if (!out.ok) throw new Error(`hsw: solve rejected: ${out.error ?? "unknown"}`);
  return out.n ?? "";
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

/** Crypto runs one of the hsw bundle's crypto modes (1 = encrypt, 0 =
 * decrypt) inside the bundle's dynamic worker; data is exchanged as base64
 * (hsw.go:306-392 Crypto via hccryptoAdapter). Returns the raw result
 * bytes. */
export async function cryptoMode(location: string, mode: number, data: Uint8Array): Promise<Uint8Array> {
  const stub = await solverStub(location);
  let resp: Response;
  try {
    resp = await stub.getEntrypoint().fetch(new Request("https://hsw.internal/crypto", {
      method: "POST",
      body: JSON.stringify({ op: "crypto", mode, data: b64StdEncode(data) }),
      signal: AbortSignal.timeout(SOLVE_TIMEOUT_MS),
    }));
  } catch (e) {
    throw new Error(`hsw: crypto mode ${mode} timed out after ${SOLVE_TIMEOUT_MS}ms or failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const out = await resp.json() as { ok: boolean; b64?: string; error?: string };
  if (!out.ok || !out.b64) throw new Error(`hsw: crypto mode ${mode} failed: ${out.error ?? "unknown"}`);
  return b64LenientDecode(out.b64);
}
