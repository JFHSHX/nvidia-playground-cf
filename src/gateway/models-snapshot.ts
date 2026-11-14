// src/gateway/models-snapshot.ts — 静态模型快照(live 探测刷新,2026-10-03;
// 2026-11-05 目录核对:23 个。glm-5-3/kimi-k3/nemotron-3-super-120b/llama-3.2-11b
// 已从目录页下架但 functionId/spec 仍活,保留待真正下线(实测时好时坏)。
// 注意(2026-10-17 实测):kimi-k3 与 ising-calibration-1-35b-a3b 已被上游下架
// (queues 端点 404、spec 无 functionVersionId),请求会得到 502 upstream 404。
// 注意(2026-11-06 实测):kimi-k3_1-pro 曾下架(queues 404、predict 全 500、
// v3 504),2026-11-14 实测复活(queues 200、depth 0、ACTIVE,fnId 未变)。
// 判活口诀:查 queues 端点,404=函数被摘,有深度=活着
// (详见 reference/upstream-protocol.md)。

export const PREDICT_BASE = "https://buildapi.ngc.nvidia.com";
export const DEFAULT_NAMESPACE = "qc69jvmznzxy";
// 缺省必须指向活函数:kimi-k3 已于 2026-10-17 永久下线;kimi-k3_1-pro
// 2026-11-14 实测复活(queues 200 / ACTIVE),缺省 model 的请求不再打死函数。
export const DEFAULT_MODEL = "moonshotai/kimi-k3_1-pro";

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
  "minimaxai/minimax-m3.1-flash": {
    slug: "minimax-m3.1-flash",
    namespace: "qc69jvmznzxy",
    functionId: "eb8265c4-e47d-4047-918d-c12746cc2cee",
  },
  "mistralai/mistral-large-4-1t-a52b": {
    slug: "mistral-large-4-1t-a52b",
    namespace: "qc69jvmznzxy",
    functionId: "f238fb4a-8a45-473f-a81f-b7d30f56e2b0",
  },
  "moonshotai/kimi-k3": {
    slug: "kimi-k3",
    namespace: "qc69jvmznzxy",
    functionId: "1586112a-925c-48af-8631-7c815dbd749c",
  },
  "moonshotai/kimi-k3_1-pro": {
    slug: "kimi-k3_1-pro",
    namespace: "qc69jvmznzxy",
    functionId: "b79234a1-64e1-479e-87e7-1c8e3af74262",
    // 实测(2026-11-05):body 规范名带点;最小 body 200,DSH 风格参数(疑 top_p/
    // stop 等)400——与 kimi-k3 同族的严格校验,接入时注意
    // 曾下架(2026-11-06~11-13,queues 404 函数被摘),2026-11-14 实测复活:
    // queues 200、depth 0、ACTIVE、fnId 未变(只换 functionVersionId)。
    // 复活后显示名用 kimi-k3.1-pro(带点,与 body 规范名一致)。
    model: "moonshotai/kimi-k3.1-pro",
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
  "nvidia/nemotron-3.5-bolt-e4b": {
    slug: "nemotron-3.5-bolt-e4b",
    namespace: "qc69jvmznzxy",
    functionId: "9fd8dea3-511e-4771-bafb-e6f207d11cc8",
  },
  "nvidia/nemotron-3.5-super-vl-120b-a12b": {
    slug: "nemotron-3.5-super-vl-120b-a12b",
    namespace: "qc69jvmznzxy",
    functionId: "b300b2c8-f52e-40c2-aa0c-6a55fd5e50e1",
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
  "stepfun-ai/step-5-preview": {
    slug: "step-5-preview",
    namespace: "qc69jvmznzxy",
    functionId: "d64c848d-0a4b-400a-b780-75d603c6bc3a",
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
