// scripts/update-snapshot.ts — probes the live chat-capable playground models
// for nvcfFunctionId, rewrites src/gateway/models-snapshot.ts, and writes a
// ready-to-paste dsh provider model list. Run: npx tsx scripts/update-snapshot.ts
import { writeFileSync } from "node:fs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Chat-capable LLMs from the live preview catalog (2026-10-03). Excludes
// vision-only/audio/video/embedding/guard non-chat models.
const CHAT_MODELS = [
  "deepseek-ai/deepseek-v4.1-flash",
  "google/diffusiongemma-26b-a4b-it",
  "google/gemma-4-31b-it",
  "meta/llama-3.2-11b-vision-instruct",
  "meta/llama-3.2-90b-vision-instruct",
  "meta/llama-guard-4-12b",
  "meta/muse-glimmer-30b",
  "moonshotai/kimi-k3",
  "nvidia/cosmos3-nano-reasoner",
  "nvidia/ising-calibration-1-35b-a3b",
  "nvidia/ising-calibration-1.5-31b",
  "nvidia/llama-3_1-nemotron-safety-guard-8b-v3",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
  "nvidia/nemotron-3-super-120b-a12b",
  "nvidia/nemotron-3-ultra-550b-a55b",
  "nvidia/nemotron-3.5-lightning-30b-a3b",
  "nvidia/riva-translate-4b-instruct-v1_1",
  "nvidia/riva-translate-4b-instruct-v2",
  "openai/gpt-oss-20b",
  "poolside/laguna-xs-2.1",
  "z-ai/glm-5-3",
  "z-ai/glm-5-3-flash",
];

// [contextWindow, maxTokens] from the dsh nvidia provider list where the model
// is present; conservative guesses otherwise.
const CONTEXT: Record<string, [number, number]> = {
  "deepseek-ai/deepseek-v4.1-flash": [1000000, 131072],
  "google/diffusiongemma-26b-a4b-it": [131072, 16384],
  "google/gemma-4-31b-it": [131072, 16384],
  "meta/llama-guard-4-12b": [131072, 16384],
  "meta/muse-glimmer-30b": [131072, 131072],
  "moonshotai/kimi-k3": [1048576, 131072],
  "nvidia/cosmos3-nano-reasoner": [131072, 16384],
  "nvidia/ising-calibration-1.5-31b": [131072, 16384],
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning": [256000, 65536],
  "nvidia/nemotron-3-super-120b-a12b": [262144, 262144],
  "nvidia/nemotron-3-ultra-550b-a55b": [1000000, 65536],
  "nvidia/nemotron-3.5-lightning-30b-a3b": [262144, 262144],
  "openai/gpt-oss-20b": [131072, 32768],
  "poolside/laguna-xs-2.1": [262144, 16384],
};

interface Info { id: string; slug: string; namespace: string; functionId: string }
const results: Info[] = [];

async function probe(id: string): Promise<Info | null> {
  const slash = id.indexOf("/");
  const pub = id.slice(0, slash);
  const slug = id.slice(slash + 1);
  try {
    const res = await fetch(`https://build.nvidia.com/${pub}/${slug}/playground`, {
      headers: { "User-Agent": UA, Accept: "text/html" },
    });
    if (res.status !== 200) return null;
    const body = await res.text();
    const fnMatch = body.match(/"nvcfFunctionId\\?":\\?"([a-f0-9-]{36})\\?"/);
    if (fnMatch === null || !/^[a-f0-9-]{36}$/.test(fnMatch[1]!)) return null;
    const nsMatch = body.match(/"namespace\\?":\\?"([0-9a-z]+)\\?"/);
    return { id, slug, namespace: nsMatch !== null ? nsMatch[1]! : "qc69jvmznzxy", functionId: fnMatch[1]! };
  } catch {
    return null;
  }
}

const queue = [...CHAT_MODELS];
const workers = Array.from({ length: 6 }, async () => {
  while (queue.length > 0) {
    const id = queue.shift()!;
    const r = await probe(id);
    if (r) results.push(r);
    console.log(r ? `OK   ${id} -> ${r.functionId.slice(0, 8)}…` : `MISS ${id}`);
  }
});
await Promise.all(workers);
results.sort((a, b) => a.id.localeCompare(b.id));
console.log(`\nprobed OK: ${results.length}/${CHAT_MODELS.length}`);

let ts = "// src/gateway/models-snapshot.ts — 静态模型快照(live 探测刷新,2026-10-03)\n// " + results.length + " 个带内联 nvcfFunctionId 的 playground 模型;live 抓取失败时回退本快照。\n\nexport const PREDICT_BASE = \"https://buildapi.ngc.nvidia.com\";\nexport const DEFAULT_NAMESPACE = \"qc69jvmznzxy\";\nexport const DEFAULT_MODEL = \"moonshotai/kimi-k3\";\n\nexport function predictEndpoint(info: ModelInfo): string {\n  return `${PREDICT_BASE}/v2/predict/models/${info.namespace}/${info.slug}`;\n}\n\nexport interface ModelInfo {\n  /** predict URL 路径段(模型 id 最后一个 \"/\") */\n  slug: string;\n  /** NVCF namespace */\n  namespace: string;\n  /** nv-function-id 头值(每模型 UUID) */\n  functionId: string;\n}\n\nexport const MODEL_SNAPSHOT: Record<string, ModelInfo> = {\n";
for (const r of results) {
  ts += `  "${r.id}": {\n    slug: "${r.slug}",\n    namespace: "${r.namespace}",\n    functionId: "${r.functionId}",\n  },\n`;
}
ts += "};\n";
writeFileSync("src/gateway/models-snapshot.ts", ts);
console.log("wrote src/gateway/models-snapshot.ts");

let yaml = "    nvidia-playground:\n      baseUrl: http://localhost:8787/v1\n      apiKeyEnv: NVIDIA_PLAYGROUND_KEY\n      models:\n";
for (const r of results) {
  const [cw, mt] = CONTEXT[r.id] ?? [131072, 16384];
  yaml += `        - id: ${r.id}\n          name: ${r.id.split("/")[1]!}\n          contextWindow: ${cw}\n          maxTokens: ${mt}\n`;
}
writeFileSync("hsw-test/dsh-provider.yaml", yaml);
console.log("wrote hsw-test/dsh-provider.yaml (dsh llm-pi-ai provider, paste into settings)");
