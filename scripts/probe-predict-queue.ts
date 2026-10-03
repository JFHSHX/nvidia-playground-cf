// scripts/probe-predict-queue.ts — the user's F12 capture shows the page's
// predict body uses model "z-ai/glm-5.3" (a DOT — the URL slug is glm-5-3
// with a dash!), stream:true, max_tokens etc. This probe mirrors the page's
// exact body shape to find which difference unblocks glm-5-3.
// Run: npx tsx scripts/probe-predict-queue.ts
import { setSolveOverride, captchaToken } from "../src/hcaptcha/getcaptcha";
import { MODEL_SNAPSHOT, PREDICT_BASE } from "../src/gateway/models-snapshot";
import { browserSolveN, browserCryptoMode } from "../src/node-host/browser-solver";

setSolveOverride({ solveN: browserSolveN, cryptoMode: browserCryptoMode });

const token = await captchaToken("0c6a1e45-75d7-43cc-b836-a0c9d886b8ee", "build.nvidia.com");
console.log("token:", token.slice(0, 20) + "...");

const info = MODEL_SNAPSHOT["z-ai/glm-5-3"]!;
const predictURL = `${PREDICT_BASE}/v2/predict/models/${info.namespace}/${info.slug}`;

// Isolation test: model name "z-ai/glm-5.3" (the dot) ALONE with a minimal
// non-stream body — distinguishes the model-name fix from the stream/extras.
const body = JSON.stringify({
  model: "z-ai/glm-5.3",
  messages: [{ role: "user", content: "你好" }],
  stream: false,
});

const res = await fetch(predictURL, {
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
console.log("predict status:", res.status);
const text = await res.text();
console.log("body head:", JSON.stringify(text.slice(0, 400)));
