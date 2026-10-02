// src/index.ts — worker 入口:路由 /healthz、/v1/models、/v1/chat/completions + CORS
// (文件以注释行开头,规避网关对 {" 的误判)

import { handleChatCompletions } from "./gateway/chat";
import { MODEL_SNAPSHOT, type ModelInfo } from "./gateway/models-snapshot";
import { GatewayError, openAIErrorBody, setLookupOverlay } from "./gateway/predict";

// --- live 模型 registry(best-effort;WAF 挑战 → 回退快照;fetch.go 移植) ---

const MODELS_URL = "https://build.nvidia.com/models?filters=nimType%3Anim_type_preview&pageSize=100";
const FALLBACK_MODELS_URL = "https://build.nvidia.com/models";
const FETCH_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const LIVE_TTL_MS = 600_000; // 10 分钟
const PROBE_CONCURRENCY = 8;

let liveRegistry: Map<string, ModelInfo> | null = null;
let liveAtMs = 0;
let livePromise: Promise<Map<string, ModelInfo> | null> | null = null;

function browserHeaders(): Record<string, string> {
  return {
    "User-Agent": FETCH_UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://build.nvidia.com/",
    "Sec-CH-UA": `"Not A(Brand";v="99", "Google Chrome";v="131", "Chromium";v="131"`,
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": `"macOS"`,
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Upgrade-Insecure-Requests": "1",
  };
}

/** AWS WAF JS 挑战页:body >0 且 <64KB 且含 gokuProps(fetch.go httpStatusChallenge)。 */
function isChallenge(body: string): boolean {
  return body.length > 0 && body.length < 65536 && body.includes("gokuProps");
}

async function getCatalog(url: string): Promise<string> {
  const resp = await fetch(url, { headers: browserHeaders() });
  if (resp.status !== 200) {
    try {
      await resp.body?.cancel();
    } catch {
      // 忽略
    }
    throw new Error(`GET ${url}: ${resp.status}`);
  }
  const text = await resp.text();
  if (isChallenge(text)) throw new Error(`GET ${url}: AWS WAF challenge`);
  return text;
}

/** 目录页 → {publisher}/{slug} id 列表(fetch.go fetchCatalogIDs 的正则解析)。 */
function parseCatalogIds(body: string): string[] {
  const resIds = new Set<string>();
  for (const m of body.matchAll(/qc69jvmznzxy\/([A-Za-z0-9_.+~\-]+)/g)) {
    resIds.add(m[1]);
  }
  const slugToPub = new Map<string, string>();
  for (const m of body.matchAll(/href="\/([a-zA-Z0-9_.-]+)\/([A-Za-z0-9_.+~\-]+)"/g)) {
    const pub = m[1];
    const slug = m[2];
    if (pub === "models" || pub === "explore" || pub === "blueprints" || pub === "skills" || pub === "_next" || pub === "") {
      continue;
    }
    if (slug === "playground" || slug === "community" || slug === "") continue;
    if (resIds.size > 0 && !resIds.has(slug)) continue; // 只要 catalog 端点,不要导航链接
    if (!slugToPub.has(slug)) slugToPub.set(slug, pub);
  }
  const ids: string[] = [];
  for (const [slug, pub] of slugToPub) ids.push(`${pub}/${slug}`);
  ids.sort();
  return ids;
}

/** 探测一个 playground 页 → nvcfFunctionId/namespace;无内联 function id 返回 null。 */
async function probePlayground(id: string): Promise<ModelInfo | null> {
  const slash = id.indexOf("/");
  if (slash < 0) return null;
  const pub = id.slice(0, slash);
  const slug = id.slice(slash + 1);
  let body: string;
  try {
    body = await getCatalog(`https://build.nvidia.com/${pub}/${slug}/playground`);
  } catch {
    return null;
  }
  const fnMatch = body.match(/"nvcfFunctionId\\?":\\?"([a-f0-9-]{36})\\?"/);
  if (fnMatch === null || !/^[a-f0-9-]{36}$/.test(fnMatch[1])) return null;
  const nsMatch = body.match(/"namespace\\?":\\?"([0-9a-z]+)\\?"/);
  const namespace = nsMatch !== null ? nsMatch[1] : "qc69jvmznzxy";
  return { slug, namespace, functionId: fnMatch[1] };
}

/** live 抓取:目录页 → id 列表 → 并发探测 playground;0 可用模型 = 失败(null)。 */
async function fetchLiveRegistry(): Promise<Map<string, ModelInfo> | null> {
  let catalogBody: string;
  try {
    try {
      catalogBody = await getCatalog(MODELS_URL);
    } catch {
      catalogBody = await getCatalog(FALLBACK_MODELS_URL); // 过滤页挑战/失败 → 无过滤页
    }
  } catch {
    return null;
  }
  const ids = parseCatalogIds(catalogBody);
  if (ids.length === 0) return null;

  const out = new Map<string, ModelInfo>();
  for (let i = 0; i < ids.length; i += PROBE_CONCURRENCY) {
    const batch = ids.slice(i, i + PROBE_CONCURRENCY);
    const results = await Promise.allSettled(batch.map((id) => probePlayground(id)));
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === "fulfilled" && r.value !== null) out.set(batch[j], r.value);
    }
  }
  if (out.size === 0) return null;
  return out;
}

/** TTL 缓存 + in-flight promise 去重;失败返回 null(调用方回退快照)。 */
async function getLiveRegistry(): Promise<Map<string, ModelInfo> | null> {
  const now = Date.now();
  if (liveRegistry !== null && now - liveAtMs < LIVE_TTL_MS) return liveRegistry;
  if (livePromise !== null) return livePromise;
  livePromise = fetchLiveRegistry()
    .then((result) => {
      if (result !== null) {
        liveRegistry = result;
        liveAtMs = Date.now();
      }
      return result;
    })
    .catch(() => null)
    .finally(() => {
      livePromise = null;
    });
  return livePromise;
}

// live registry 覆盖层:live 优先于快照(chat.ts 的模型查找用)
setLookupOverlay((model) => (liveRegistry !== null ? liveRegistry.get(model) ?? null : null));

// --- /v1/models(OpenAI list;live + 快照并集,live 胜) ---

async function handleModels(): Promise<Response> {
  const live = await getLiveRegistry();
  const merged: Record<string, ModelInfo> = { ...MODEL_SNAPSHOT };
  if (live !== null) {
    for (const [id, info] of live) merged[id] = info;
  }
  const data = Object.keys(merged)
    .sort()
    .map((id) => ({ id, object: "model", created: 0, owned_by: id.split("/")[0] ?? id }));
  return new Response(JSON.stringify({ object: "list", data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// --- 路由 + CORS ---

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, nv-function-id, nv-captcha-token, nv-function-slug, nv-function-namespace",
  "Access-Control-Max-Age": "86400",
};

function withCors(resp: Response): Response {
  for (const [key, value] of Object.entries(CORS_HEADERS)) resp.headers.set(key, value);
  return resp;
}

function errorResponse(err: unknown): Response {
  const status = err instanceof GatewayError ? err.status : 500;
  return new Response(JSON.stringify(openAIErrorBody(err)), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (request.method === "OPTIONS") {
        return withCors(new Response(null, { status: 204 }));
      }
      if (path === "/healthz") {
        return withCors(
          new Response(JSON.stringify({ status: "ok", models: Object.keys(MODEL_SNAPSHOT).length }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      if (path === "/v1/models") {
        return withCors(await handleModels());
      }
      if (path === "/v1/chat/completions") {
        return withCors(await handleChatCompletions(request));
      }
      return withCors(errorResponse(new GatewayError(404, "not_found", `not found: ${path}`)));
    } catch (err) {
      return withCors(errorResponse(err));
    }
  },
} satisfies ExportedHandler;
