// src/node-host/browser-solver.ts — real-browser hsw solver: runs the hsw.js
// bundle inside headless Chromium (playwright). The current hsw wasm traps in
// every embedder tested (v8go, node vm, workerd code-gen ban) but works in a
// real browser; this module moves ONLY the solve/crypto calls into the
// browser via page.evaluate, keeping the rest of the pipeline (checksiteconfig,
// PoW, fingerprint, getcaptcha) in Node. Injected via setSolveOverride().
import { chromium, type Browser, type Page } from "playwright";
import { SOLVE_TIMEOUT_MS, loadBundle } from "../hcaptcha/runner";

interface SolverState {
  browser: Browser;
  page: Page;
  loadedLocation: string;
  chain: Promise<unknown>; // serialization queue (window.hsw is per-page global)
}

let state: Promise<SolverState> | null = null;

/** ensurePage lazily launches one persistent headless Chromium. The page
 * stays on about:blank: the v1 bundle is self-contained (assembles its wasm
 * from atob() chunks, no network), so the browser needs nothing but its real
 * JS environment. */
async function ensurePage(): Promise<SolverState> {
  if (!state) {
    state = (async () => {
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      const st: SolverState = { browser, page, loadedLocation: "", chain: Promise.resolve() };
      return st;
    })();
    state.catch(() => { state = null; });
  }
  return state;
}

/** withPage serializes all solver work through one page: on a location
 * change the page is reset to about:blank (which clears every script) and
 * the bundle for the new location is injected. The shim inside the bundle is
 * a silent no-op on the real window (LegacyUnforgeable), so the browser's
 * own window survives and the bundle installs window.hsw on it. */
async function withPage<T>(location: string, fn: (page: Page) => Promise<T>): Promise<T> {
  const st = await ensurePage();
  const run = st.chain.then(async () => {
    if (st.loadedLocation !== location) {
      const bundle = await loadBundle(location);
      await st.page.goto("about:blank");
      await st.page.addScriptTag({ content: bundle.source });
      st.loadedLocation = location;
    }
    return fn(st.page);
  });
  st.chain = run.then(() => undefined, () => undefined);
  return run;
}

function withTimeout<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${SOLVE_TIMEOUT_MS}ms`)), SOLVE_TIMEOUT_MS);
    timer.unref();
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** browserSolveN: window.hsw(jwt, fpB64) evaluated in the real browser; the
 * returned promise is awaited by playwright. Mirrors Go hsw.go SolveN. */
export async function browserSolveN(location: string, jwt: string, fpB64: string): Promise<string> {
  let n: unknown;
  try {
    n = await withTimeout(withPage(location, (page) =>
      page.evaluate(([j, f]) => {
        const g = globalThis as unknown as { hsw?: unknown; module?: { exports?: unknown } };
        const modExports = g.module?.exports;
        const fn = (typeof modExports === "function" ? modExports : g.hsw) as ((jwt: string, fp: string) => Promise<string>) | undefined;
        if (typeof fn !== "function") throw new Error("hsw: no solve entry (bundle variant unsupported)");
        return fn(j, f);
      }, [jwt, fpB64] as [string, string]),
    ), "hsw: solve");
  } catch (e) {
    throw new Error(`hsw: solve failed in browser: ${e instanceof Error ? e.message : String(e)}`);
  }
  return String(n ?? "");
}

/** browserCryptoMode: window.hsw(mode, bytes) with the data exchanged as
 * base64 (mirrors Go hsw.go Crypto via hccryptoAdapter). Returns the raw
 * result bytes. */
export async function browserCryptoMode(location: string, mode: number, data: Uint8Array): Promise<Uint8Array> {
  let outB64: string;
  try {
    outB64 = await withTimeout(withPage(location, (page) =>
      page.evaluate(([m, d]) => {
        const g = globalThis as unknown as { hsw: (mode: number, bytes: Uint8Array) => Promise<ArrayBuffer | Uint8Array> };
        const bytes = Uint8Array.from(atob(d), (c) => c.charCodeAt(0));
        const r = g.hsw(m, bytes);
        return Promise.resolve(r).then((res: ArrayBuffer | Uint8Array) => {
          const u8 = res instanceof Uint8Array ? res : new Uint8Array(res);
          let bin = "";
          for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000) as unknown as number[]);
          return btoa(bin);
        });
      }, [mode, btoa(String.fromCharCode(...data.subarray(0, Math.min(data.length, 0x8000))))] as [number, string]),
    ), `hsw: crypto mode ${mode}`);
  } catch (e) {
    throw new Error(`hsw: crypto mode ${mode} failed in browser: ${e instanceof Error ? e.message : String(e)}`);
  }
  const padded = outB64.replace(/[\s-]/g, "").replace(/_/g, "/");
  const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
