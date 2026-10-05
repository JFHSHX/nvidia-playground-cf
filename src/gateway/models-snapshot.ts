// src/gateway/models-snapshot.ts — 静态模型快照(live 探测刷新,2026-10-03)
// 17 个带内联 nvcfFunctionId 的 playground 模型;live 抓取失败时回退本快照。

export const PREDICT_BASE = "https://buildapi.ngc.nvidia.com";
export const DEFAULT_NAMESPACE = "qc69jvmznzxy";
export const DEFAULT_MODEL = "moonshotai/kimi-k3";

export function predictEndpoint(info: ModelInfo): string {
  return `${PREDICT_BASE}/v2/predict/models/${info.namespace}/${info.slug}`;
}

/** predict/queues 查询端点:免认证(实测只需 Origin/Referer),返回
 * functionStatus + queueDepth——用来区分"实例挂了"和"公共队列拥堵"。 */
export function queuesEndpoint(info: ModelInfo): string {
  return `${PREDICT_BASE}/v2/predict/queues/models/${info.namespace}/${info.slug}`;
}

export interface ModelInfo {
  /** predict URL 路径段(模型 id 最后一个 "/") */
  slug: string;
  /** NVCF namespace */
  namespace: string;
  /** nv-function-id 头值(每模型 UUID) */
  functionId: string;
  /** 上游 body 里 model 字段的名字;URL slug 与它可能不同(glm-5-3 的 body
   * 用 "z-ai/glm-5.3" 带点,实测用 slug 会 500 "Retries exhausted");缺省
   * 等于模型 id */
  model?: string;
}

export const MODEL_SNAPSHOT: Record<string, ModelInfo> = {
  "deepseek-ai/deepseek-v4.1-flash": {
    slug: "deepseek-v4.1-flash",
    namespace: "qc69jvmznzxy",
    functionId: "380aea97-e004-4f73-81b7-2ad4d26f4b24",
  },
  "google/diffusiongemma-26b-a4b-it": {
    slug: "diffusiongemma-26b-a4b-it",
    namespace: "qc69jvmznzxy",
    functionId: "ffd13b18-1c55-4a7a-b71a-acbfde9ce8a0",
  },
  "google/gemma-4-31b-it": {
    slug: "gemma-4-31b-it",
    namespace: "qc69jvmznzxy",
    functionId: "48c619ec-c254-48da-8fcc-6ef8a04fed6e",
  },
  "meta/llama-3.2-11b-vision-instruct": {
    slug: "llama-3.2-11b-vision-instruct",
    namespace: "qc69jvmznzxy",
    functionId: "9fa6fd04-ba2c-4bb3-90b7-ede407a9290f",
  },
  "meta/llama-3.2-90b-vision-instruct": {
    slug: "llama-3.2-90b-vision-instruct",
    namespace: "qc69jvmznzxy",
    functionId: "24e0c62b-f7d0-44ba-8012-012c2a1aaf31",
  },
  "meta/muse-glimmer-30b": {
    slug: "muse-glimmer-30b",
    namespace: "qc69jvmznzxy",
    functionId: "fd21cc19-b4ff-4949-ba07-90dd663c416a",
  },
  "moonshotai/kimi-k3": {
    slug: "kimi-k3",
    namespace: "qc69jvmznzxy",
    functionId: "1586112a-925c-48af-8631-7c815dbd749c",
  },
  "nvidia/ising-calibration-1-35b-a3b": {
    slug: "ising-calibration-1-35b-a3b",
    namespace: "qc69jvmznzxy",
    functionId: "499210d3-3bf7-44bf-88b5-9460edfa8a38",
  },
  "nvidia/ising-calibration-1.5-31b": {
    slug: "ising-calibration-1.5-31b",
    namespace: "qc69jvmznzxy",
    functionId: "499210d3-3bf7-44bf-88b5-9460edfa8a38",
  },
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning": {
    slug: "nemotron-3-nano-omni-30b-a3b-reasoning",
    namespace: "qc69jvmznzxy",
    functionId: "c4ed50ff-b5c3-409d-ab57-b79c33f5bb39",
  },
  "nvidia/nemotron-3-super-120b-a12b": {
    slug: "nemotron-3-super-120b-a12b",
    namespace: "qc69jvmznzxy",
    functionId: "ac74040f-9fc9-4c5e-ac74-279ba5161d69",
  },
  "nvidia/nemotron-3-ultra-550b-a55b": {
    slug: "nemotron-3-ultra-550b-a55b",
    namespace: "qc69jvmznzxy",
    functionId: "948fe171-ce7a-4332-8bc0-5e14e90259f9",
  },
  "nvidia/nemotron-3.5-lightning-30b-a3b": {
    slug: "nemotron-3.5-lightning-30b-a3b",
    namespace: "qc69jvmznzxy",
    functionId: "0a213807-640b-43fb-bfbf-2919f9b666ad",
  },
  "openai/gpt-oss-20b": {
    slug: "gpt-oss-20b",
    namespace: "qc69jvmznzxy",
    functionId: "24d90582-d41c-4fc6-adc0-53c97f5a710f",
  },
  "poolside/laguna-xs-2.1": {
    slug: "laguna-xs-2.1",
    namespace: "qc69jvmznzxy",
    functionId: "4a8f921c-c99d-4cde-92c1-c92ba9e4c50f",
  },
  "z-ai/glm-5-3": {
    slug: "glm-5-3",
    namespace: "qc69jvmznzxy",
    functionId: "0cd5c583-435c-4649-a621-f4e421fa12a0",
    model: "z-ai/glm-5.3",
  },
  "z-ai/glm-5-3-flash": {
    slug: "glm-5-3-flash",
    namespace: "qc69jvmznzxy",
    functionId: "f7e3a881-2cde-455d-bbfd-fb8eb1bd1520",
    model: "z-ai/glm-5.3-flash",
  },
};
