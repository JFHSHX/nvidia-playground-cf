// scripts/probe-predict.ts — bisect the glm-5-3-flash 400 by posting candidate
// request bodies straight to the v2 predict path with a fresh captcha token.
// Observed symptom (logs/npg-2026-07.log): captcha ok -> 502 with upstream
// `400 Bad Request from POST https://grpc.nvcf.nvidia.com/v1/chat/completions`
// in 5-8s, while glm-5-3-flash queueDepth is only ~177 (so NOT congestion),
// and glm-5-3 (same nvcfInferencePath) instead fails with queue 500s.
//
// Run: npx tsx scripts/probe-predict.ts [model-id]   (default z-ai/glm-5-3-flash)
import { acquireNvCaptcha } from "../src/hcaptcha/index";
import { setSolveOverride } from "../src/hcaptcha/getcaptcha";
import { browserSolveN, browserCryptoMode } from "../src/node-host/browser-solver";
import { MODEL_SNAPSHOT } from "../src/gateway/models-snapshot";

setSolveOverride({ solveN: browserSolveN, cryptoMode: browserCryptoMode });

const modelId = process.argv[2] ?? "z-ai/glm-5-3-flash";
const info = MODEL_SNAPSHOT[modelId];
if (!info) {
  console.error(`[probe] unknown model ${modelId}; known: ${Object.keys(MODEL_SNAPSHOT).join(", ")}`);
  process.exit(1);
}

const url = `https://buildapi.ngc.nvidia.com/v2/predict/models/${info.namespace}/${info.slug}`;
const bodyModel = info.model ?? modelId;
const H: Record<string, string> = { Origin: "https://build.nvidia.com", Referer: "https://build.nvidia.com/" };

const msgs = [{ role: "user", content: "Say OK" }];
const tool = {
  type: "function",
  function: { name: "get_time", description: "Returns the current time.", parameters: { type: "object", properties: { tz: { type: "string" } } } },
};

const variants: Array<[string, Record<string, unknown>]> = [
  ["A minimal", { model: bodyModel, messages: msgs, stream: true }],
  [
    "B dsh-style params",
    { model: bodyModel, messages: msgs, stream: true, stream_options: { include_usage: true, continuous_usage_stats: false }, temperature: 0.5, top_p: 1, max_tokens: 1024, seed: 0, presence_penalty: 0, frequency_penalty: 0, stop: null },
  ],
  [
    "C + tools",
    { model: bodyModel, messages: msgs, stream: true, stream_options: { include_usage: true, continuous_usage_stats: false }, temperature: 0.5, top_p: 1, max_tokens: 1024, seed: 0, presence_penalty: 0, frequency_penalty: 0, stop: null, tool_choice: "auto", tools: [tool] },
  ],
  ["D tools only", { model: bodyModel, messages: msgs, stream: true, tool_choice: "auto", tools: [tool] }],
  // E-H: DSH 侧真实差异点(provider 配置 maxTokens:16384;harness 的复杂 tool schema 与 thinking 参数)
  ["E max_tokens 16384 (provider cfg)", { model: bodyModel, messages: msgs, stream: true, max_tokens: 16384 }],
  [
    "F complex tool schema + 16384",
    {
      model: bodyModel,
      messages: msgs,
      stream: true,
      max_tokens: 16384,
      temperature: 0.5,
      top_p: 1,
      stream_options: { include_usage: true, continuous_usage_stats: false },
      tool_choice: "auto",
      tools: [
        {
          type: "function",
          function: {
            name: "run_shell",
            description: "Run a shell command",
            parameters: {
              type: "object",
              properties: {
                command: { type: "string", description: "cmd" },
                timeout_ms: { type: "integer", minimum: 0, maximum: 600000 },
                mode: { type: "string", enum: ["sync", "async"] },
                env: { type: "object", additionalProperties: { type: "string" } },
                cwd: { type: ["string", "null"] },
              },
              required: ["command"],
              additionalProperties: false,
            },
          },
        },
        { type: "function", function: { name: "apply_patch", description: "Patch", parameters: { type: "object", properties: { patch: { type: "string" }, paths: { type: "array", items: { type: "string" } } }, required: ["patch"] } } },
      ],
    },
  ],
  ["G reasoning_effort top-level", { model: bodyModel, messages: msgs, stream: true, max_tokens: 1024, reasoning_effort: "high" }],
  ["H chat_template_kwargs", { model: bodyModel, messages: msgs, stream: true, max_tokens: 1024, chat_template_kwargs: { enable_thinking: true, clear_thinking: false } }],
  // I-L: messages 级差异(DSH 真实请求会带历史/工具往返/parts)
  [
    "I assistant reasoning_content history",
    {
      model: bodyModel,
      stream: true,
      max_tokens: 1024,
      messages: [
        { role: "system", content: "You are a coding agent." },
        { role: "user", content: "hi" },
        { role: "assistant", content: "ok", reasoning_content: "Let me think about this carefully." },
        { role: "user", content: "Say OK" },
      ],
    },
  ],
  [
    "J tool round-trip",
    {
      model: bodyModel,
      stream: true,
      max_tokens: 1024,
      tool_choice: "auto",
      tools: [tool],
      messages: [
        { role: "user", content: "run ls" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_time", arguments: '{"tz":"UTC"}' } }] },
        { role: "tool", tool_call_id: "call_1", content: "12:00" },
      ],
    },
  ],
  ["K content parts array", { model: bodyModel, stream: true, max_tokens: 1024, messages: [{ role: "user", content: [{ type: "text", text: "Say OK" }] }] }],
  [
    "L long system prompt",
    { model: bodyModel, stream: true, max_tokens: 1024, messages: [{ role: "system", content: "You are a coding agent. ".repeat(200) }, { role: "user", content: "Say OK" }] },
  ],
];

async function post(token: string, body: Record<string, unknown>): Promise<void> {
  const t0 = Date.now();
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { ...H, "Content-Type": "application/json", Accept: "text/event-stream", "nv-function-id": info.functionId, "nv-captcha-token": token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (e) {
    console.log(`    fetch failed after ${Date.now() - t0}ms: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const ct = resp.headers.get("content-type") ?? "";
  const text = await resp.text().catch(() => "<unreadable>");
  console.log(`    -> ${resp.status} in ${Date.now() - t0}ms (${ct}) ${text.slice(0, 300).replace(/\s+/g, " ")}`);
}

async function main(): Promise<void> {
  console.log(`[probe] model ${modelId} -> ${url} (body model "${bodyModel}", fn ${info.functionId})`);
  for (const [name, body] of variants) {
    console.log(`[probe] ${name}: ${body.tools ? `tools=${(body.tools as unknown[]).length}` : "no tools"}`);
    // fresh token per variant: they are one-shot
    let token: string;
    try {
      token = (await acquireNvCaptcha(info.slug)).captchaToken;
      console.log(`    token ok (${token.length})`);
    } catch (e) {
      console.log(`    captcha failed: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    await post(token, body);
  }
}

main().catch((e) => {
  console.error(`[probe] ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(1);
});
