// src/node-host/hsw-node.ts — Node-native hsw runner: runs the prepared
// hsw.js bundle inside a node:vm context, mirroring the Go v8go embedder
// (Go hsw.go init/SolveN/Crypto). The shim provides window/module/navigator/
// crypto/atob/btoa/console itself — Node's strict atob would break the v1
// wasm's base64url chunk assembly (hCaptcha wasm chunks use -/_ in various
// combinations; the Go injects a deliberately LENIENT atob for the same
// reason). The solve entry is module.exports called directly (no dispatcher,
// no HTTP hop); the crypto modes go through the Go's hccryptoAdapter.
// Injected via setSolveOverride() from server.ts.
import vm from "node:vm";
import { SOLVE_TIMEOUT_MS, loadBundle } from "../hcaptcha/runner";

// Go hsw.go:269-291 hccryptoAdapter — wraps window.hsw's crypto modes
// (1 = encrypt, 0 = decrypt) behind a base64-string interface so the host
// never has to build typed arrays.
const HCCRYPTO_ADAPTER = `
(function () {
if (window.__hccrypto) return window.__hccrypto;
function b64ToBytes(b64) {
var bin = atob(b64);
var u = new Uint8Array(bin.length);
for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
return u;
}
function bytesToB64(u8) {
if (!u8 || typeof u8.length!== "number") {
return btoa(String(u8 || ""));
}
var out = [];
for (var i = 0; i < u8.length; i += 0x8000) {
out.push(String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)));
}
return btoa(out.join(''));
}
window.__hccrypto = function (mode, b64) {
return window.hsw(mode, b64ToBytes(b64)).then(function (r) {
return bytesToB64(r);
});
};
return window.__hccrypto;
})();
`;

interface WarmContext {
  global: object; // the contextified global (the `this` for solve calls, mirrors Go s.global)
  fnSolve: (this: unknown, jwt: string, fpB64: string) => Promise<string>;
  fnCrypto: ((this: unknown, mode: number, b64: string) => Promise<string>) | null;
}

// One warm vm context per bundle location (mirrors token.go solverCache and
// runner.ts solverCache; failed loads are dropped so a retry rebuilds).
const contextCache = new Map<string, Promise<WarmContext>>();

/** buildContext mirrors the v8go embedder: an EMPTY sandbox. The shim
 * provides window/module/navigator/crypto/atob/btoa/console and the lenient
 * base64 JS fallbacks itself; the host's strict natives would break the v1
 * wasm's base64url chunk assembly. JS built-ins (Date/Math/JSON/Promise/
 * WebAssembly/Uint8Array) are native to every vm realm. */
function buildContext(): vm.Context {
  return vm.createContext({});
}

async function warmContext(location: string): Promise<WarmContext> {
  const cached = contextCache.get(location);
  if (cached) return cached;
  const p = (async () => {
    const bundle = await loadBundle(location);
    const ctx = buildContext();
    try {
      vm.runInContext(bundle.source, ctx, { filename: "hsw-bundle.js" });
    } catch (e) {
      throw new Error(`hsw-node: eval ${bundle.version} bundle: ${e instanceof Error ? e.message : String(e)}`);
    }
    // The solve entry is module.exports (v1: module.exports = window.hsw),
    // same as Go hsw.go:100-123.
    const fnSolve = await vm.runInContext(
      "(typeof module !== 'undefined' && module !== null && module.exports && typeof module.exports === 'function') ? module.exports : ((typeof window !== 'undefined' && window && typeof window.hsw === 'function') ? window.hsw : undefined)",
      ctx,
    ) as unknown;
    if (typeof fnSolve !== "function") {
      throw new Error(`hsw-node: no solve entry (bundle variant ${bundle.version} unsupported)`);
    }
    // The crypto adapter is optional; the solve path still works
    // (Go hsw.go:125-129).
    let fnCrypto: WarmContext["fnCrypto"] = null;
    try {
      const c = await vm.runInContext(HCCRYPTO_ADAPTER, ctx, { filename: "hccrypto-adapter.js" }) as unknown;
      if (typeof c === "function") fnCrypto = c as WarmContext["fnCrypto"];
    } catch {
      fnCrypto = null;
    }
    return { global: ctx as unknown as object, fnSolve: fnSolve as WarmContext["fnSolve"], fnCrypto };
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

/** solveN mirrors Go hsw.go:183-267 SolveN: module.exports(jwt, fpB64) in
 * the bundle's vm context; the result is a promise the host awaits (Node
 * pumps the vm microtask queue). Throws Error on rejection or timeout. */
export async function solveN(location: string, jwt: string, fpB64: string): Promise<string> {
  const { global, fnSolve } = await warmContext(location);
  let n: string;
  try {
    const work = Promise.resolve().then(() => fnSolve.call(global, jwt, fpB64));
    n = await withTimeout(work, "hsw: solve");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes(`timed out after ${SOLVE_TIMEOUT_MS}ms`)) {
      throw new Error(`hsw: solve timed out after ${SOLVE_TIMEOUT_MS}ms`);
    }
    throw new Error(`hsw: solve rejected: ${msg}`);
  }
  return n ?? "";
}

/** cryptoMode mirrors Go hsw.go Crypto: the bundle's crypto modes (1 =
 * encrypt, 0 = decrypt) via the hccryptoAdapter; data is exchanged as
 * base64. Returns the raw result bytes. */
export async function cryptoMode(location: string, mode: number, data: Uint8Array): Promise<Uint8Array> {
  const { global, fnCrypto } = await warmContext(location);
  if (!fnCrypto) throw new Error(`hsw: crypto mode ${mode}: no crypto adapter`);
  let b64: string;
  try {
    const work = Promise.resolve().then(() => fnCrypto.call(global, mode, b64StdEncode(data)));
    b64 = await withTimeout(work, `hsw: crypto mode ${mode}`);
  } catch (e) {
    throw new Error(`hsw: crypto mode ${mode} timed out after ${SOLVE_TIMEOUT_MS}ms or failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return b64LenientDecode(b64);
}
