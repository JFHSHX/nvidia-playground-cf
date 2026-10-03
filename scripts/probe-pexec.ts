// scripts/probe-pexec.ts — tests the DIRECT NVCF function invocation
// (https://api.ngc.nvidia.com/v2/nvcf/pexec/functions/{id}) against glm-5-3:
// the page's widget invokes functions directly (chunk 0-mop4w978kgs.js shows
// getNvcfRequestOptions with captchaToken + /v2/nvcf/pexec/status polling),
// NOT via buildapi predict — which 404s for glm-5-3.
// Run: npx tsx scripts/probe-pexec.ts
import { setSolveOverride, captchaToken } from "../src/hcaptcha/getcaptcha";
import { MODEL_SNAPSHOT } from "../src/gateway/models-snapshot";
import { browserSolveN, browserCryptoMode } from "../src/node-host/browser-solver";

// The probe runs outside server.ts, so it must inject the solver itself —
// otherwise the default workerd path's dynamic import("cloudflare:workers")
// fails in plain Node.
setSolveOverride({ solveN: browserSolveN, cryptoMode: browserCryptoMode });

const token = await captchaToken("0c6a1e45-75d7-43cc-b836-a0c9d886b8ee", "build.nvidia.com");
console.log("token:", token.slice(0, 20) + "...");

const info = MODEL_SNAPSHOT["z-ai/glm-5-3"]!;
console.log("functionId:", info.functionId, "namespace:", info.namespace);

const body = JSON.stringify({
  model: "z-ai/glm-5-3",
  messages: [{ role: "user", content: "用一句话介绍你自己" }],
  stream: false,
});

const res = await fetch(`https://api.ngc.nvidia.com/v2/nvcf/pexec/functions/${info.functionId}`, {
  method: "POST",
  headers: {
    "nv-function-id": info.functionId,
    "nv-captcha-token": token,
    Origin: "https://build.nvidia.com",
    Referer: "https://build.nvidia.com/",
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  },
  body,
});
console.log("pexec status:", res.status);
const rh: Record<string, string> = {};
res.headers.forEach((v, k) => { rh[k] = v; });
console.log("resp headers:", JSON.stringify(rh).slice(0, 500));
const text = await res.text();
console.log("body head:", JSON.stringify(text.slice(0, 400)));
