// scripts/probe-hsw-plain.ts — runs the composed hsw bundle in a PLAIN Node
// global (no vm, no contextify) to isolate the sandbox from the equation:
// if the solve works here, the vm contextify is the problem; if it traps or
// hangs too, the shim/bundle itself is broken under Node.
// Run: npx tsx scripts/probe-hsw-plain.ts
process.on("unhandledRejection", (r) => console.error("UNHANDLED:", r instanceof Error ? r.stack : String(r)));
process.on("uncaughtException", (err) => console.error("UNCAUGHT:", err.stack ?? err.message));

const { loadBundle, locationFromJWT } = await import("../src/hcaptcha/runner");
const { readFileSync } = await import("node:fs");

const jwt = readFileSync("hsw-test/jwt.txt", "utf8").trim();
const fp = readFileSync("hsw-test/fp.txt", "utf8").trim();
const location = locationFromJWT(jwt);
console.log("location:", location);

const bundle = await loadBundle(location);
console.log("bundle version:", bundle.version, "bytes:", bundle.source.length);

// Browser-ish globals on the REAL global (no vm): the bundle's `var window`
// will overwrite window with its own object, mirroring the shim design.
const g = globalThis as unknown as Record<string, unknown>;
g.parent = g;
g.top = g;
g.frames = g;
g.opener = null;
g.module = { exports: {} };
g.exports = (g.module as { exports: unknown }).exports;

const t0 = Date.now();
(0, eval)(bundle.source);
console.log("eval done in", Date.now() - t0, "ms");
// The v1 bundle's wasm init is async (WebAssembly.instantiate promise + the
// glue's then-callback setup); give the microtask queue a macrotask tick to
// drain before calling the solve entry, or the wasm state is half-ready.
await new Promise((r) => setTimeout(r, 50));
console.log("setup tick done");
const mod = g.module as { exports: unknown };
const win = g.window as Record<string, unknown>;
console.log("module.exports type:", typeof mod.exports);
console.log("window.hsw type:", typeof win.hsw);
const fn = typeof mod.exports === "function" ? mod.exports : win.hsw;
if (typeof fn !== "function") {
  console.error("NO SOLVE ENTRY");
  process.exit(1);
}
console.log("calling fn(jwt, fp)...");
const t1 = Date.now();
const n = await (fn as (jwt: string, fp: string) => Promise<string>)(jwt, fp);
console.log("SOLVE OK in", Date.now() - t1, "ms, n head:", String(n).slice(0, 40));
