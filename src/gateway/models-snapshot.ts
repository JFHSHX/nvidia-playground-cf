// src/gateway/models-snapshot.ts — 静态模型快照(源自 Go internal/models/registry.go,2026-08-30)
// 11 个带内联 nvcfFunctionId 的 playground 模型;live 抓取失败时回退本快照。

export const PREDICT_BASE = "https://buildapi.ngc.nvidia.com";
export const DEFAULT_NAMESPACE = "qc69jvmznzxy";
export const DEFAULT_MODEL = "moonshotai/kimi-k3";

export interface ModelInfo {
  /** predict URL 路径段(模型 id 最后一个 "/") */
  slug: string;
  /** NVCF namespace(当前全部共享 DEFAULT_NAMESPACE) */
  namespace: string;
  /** nv-function-id 头值(每模型 UUID) */
  functionId: string;
}

export const MODEL_SNAPSHOT: Record<string, ModelInfo> = {
  "deepseek-ai/deepseek-v4-flash-0731": {
    slug: "deepseek-v4-flash-0731",
    namespace: DEFAULT_NAMESPACE,
    functionId: "281478d0-f307-49f4-9e0f-080b63b16c47",
  },
  "deepseek-ai/deepseek-v4-pro-0813": {
    slug: "deepseek-v4-pro-0813",
    namespace: DEFAULT_NAMESPACE,
    functionId: "6e70713f-4eeb-4ef7-b4f8-2d984f4141f6",
  },
  "google/diffusiongemma-26b-a4b-it": {
    slug: "diffusiongemma-26b-a4b-it",
    namespace: DEFAULT_NAMESPACE,
    functionId: "ffd13b18-1c55-4a7a-b71a-acbfde9ce8a0",
  },
  "meta/muse-glimmer-30b": {
    slug: "muse-glimmer-30b",
    namespace: DEFAULT_NAMESPACE,
    functionId: "fd21cc19-b4ff-4949-ba07-90dd663c416a",
  },
  "minimaxai/minimax-m3": {
    slug: "minimax-m3",
    namespace: DEFAULT_NAMESPACE,
    functionId: "87ea0ddc-cff1-4bca-bf8b-3bd98a35ddd0",
  },
  "moonshotai/kimi-k3": {
    slug: "kimi-k3",
    namespace: DEFAULT_NAMESPACE,
    functionId: "1586112a-925c-48af-8631-7c815dbd749c",
  },
  "nvidia/ising-calibration-1.5-31b": {
    slug: "ising-calibration-1.5-31b",
    namespace: DEFAULT_NAMESPACE,
    functionId: "499210d3-3bf7-44bf-88b5-9460edfa8a38",
  },
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning": {
    slug: "nemotron-3-nano-omni-30b-a3b-reasoning",
    namespace: DEFAULT_NAMESPACE,
    functionId: "c4ed50ff-b5c3-409d-ab57-b79c33f5bb39",
  },
  "nvidia/nemotron-3-ultra-550b-a55b": {
    slug: "nemotron-3-ultra-550b-a55b",
    namespace: DEFAULT_NAMESPACE,
    functionId: "948fe171-ce7a-4332-8bc0-5e14e90259f9",
  },
  "nvidia/nemotron-3.5-lightning-30b-a3b": {
    slug: "nemotron-3.5-lightning-30b-a3b",
    namespace: DEFAULT_NAMESPACE,
    functionId: "0a213807-640b-43fb-bfbf-2919f9b666ad",
  },
  "poolside/laguna-xs-2.1": {
    slug: "laguna-xs-2.1",
    namespace: DEFAULT_NAMESPACE,
    functionId: "4a8f921c-c99d-4cde-92c1-c92ba9e4c50f",
  },
};

export function predictEndpoint(info: ModelInfo): string {
  return `${PREDICT_BASE}/v2/predict/models/${info.namespace}/${info.slug}`;
}
