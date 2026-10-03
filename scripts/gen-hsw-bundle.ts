// scripts/gen-hsw-bundle.ts — generates the composed hsw bundle (shim +
// patched hsw.js + export line + dispatcher) for the raw-workerd wasm test:
// hsw-test/hsw-worker.js, plus the jwt/fingerprint pair for a solve POST.
// Run: npx tsx scripts/gen-hsw-bundle.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { DISPATCHER, loadBundle } from "../src/hcaptcha/runner";
import { fetchChecksite } from "../src/hcaptcha/getcaptcha";
import { parsePow } from "../src/hcaptcha/pow";
import { buildFingerprint } from "../src/hcaptcha/fingerprint";

const [jwt, location] = await fetchChecksite("0c6a1e45-75d7-43cc-b836-a0c9d886b8ee", "build.nvidia.com");
const bundle = await loadBundle(location);
mkdirSync("hsw-test", { recursive: true });
const composed = bundle.source + "\n" + DISPATCHER;
writeFileSync("hsw-test/hsw-worker.js", composed);
const pow = parsePow(jwt);
const fp = buildFingerprint(pow);
writeFileSync("hsw-test/jwt.txt", jwt);
writeFileSync("hsw-test/fp.txt", fp);
console.log("version:", bundle.version);
console.log("wasmB64 length:", bundle.wasmB64.length);
console.log("location:", location);
console.log("difficulty s:", pow.s, "-> stamp bits:", pow.s * 2);
console.log("fp b64 length:", fp.length);
console.log("composed bytes:", composed.length);
