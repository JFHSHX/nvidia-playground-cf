# nvidia-playground-cf

把 [NVIDIA Build Playground](https://build.nvidia.com) 的匿名聊天模型包装成 **OpenAI 兼容 API**（`http://localhost:8787/v1`），免账号、免 API key。认证链路 = 完整 hCaptcha PoW 求解（checksiteconfig → hashcash 章戳 + 指纹 → hsw wasm → getcaptcha → `P1_` token），每次请求全新铸出。

移植自 [6Kmfi6HP/nvidia-playgroud-go](https://github.com/6Kmfi6HP/nvidia-playgroud-go)（Go + v8go），重写为 **Windows 原生 Node + Playwright**——全部求解/网关逻辑零运行时依赖（运行时仅 playwright）。

## 为什么不是 Cloudflare Workers

原始目标是 CF Workers（仓库名由来），全部实测后否决（2026-10-03）：

- **workerd 禁止运行时 wasm 代码生成**（`Wasm code generation disallowed by embedder`）——hsw bundle 在运行时从 atob() 块组装 wasm，物理不可能；Worker Loader 还要 Paid 计划（code 10195）。
- **当前 hsw wasm 在一切 JS 嵌入器里解算挂死**（`RuntimeError: unreachable`）：v8go（Go 版容器日志同样 `hsw: solve timed out`）、Node vm、workerd 全中招——只有真实浏览器正常。

→ 转向 Node 原生 + headless Chromium 解算。`src/index.ts` + `wrangler.toml` 保留 workerd 版仅作参考。

## 运行

```powershell
npm install
npx playwright install chromium    # 一次性,~150MB
npm start                          # = npx tsx src/node-host/server.ts → http://localhost:8787
npm run typecheck                  # tsc 双配置零错误
```

需要能访问 `build.nvidia.com` / `newassets.hcaptcha.com` 的网络（家宽被墙时给 Node 设代理）。

## API

| 端点 | 说明 |
|---|---|
| `GET /healthz` | `{status, models, runtime, solver}` |
| `GET /v1/models` | OpenAI 模型列表（23 模型静态快照） |
| `POST /v1/chat/completions` | OpenAI 兼容，`stream: true`（SSE 逐字节透传）/ `false`（聚合） |

curl 示例（body 先写临时文件，避免 PS 5.1 引号坑）：

```powershell
curl -s -X POST http://localhost:8787/v1/chat/completions -H "Content-Type: application/json" -d @body.json
```

body.json 最小示例：

```json
{"model": "moonshotai/kimi-k3_1-pro", "messages": [{"role": "user", "content": "hi"}], "stream": true}
```

### 模型与 pin

- **23 模型快照**（`src/gateway/models-snapshot.ts`，2026-11-05 目录核对）：deepseek-v4.1-flash、glm-5-3 / glm-5-3-flash、kimi-k3_1-pro（1M 上下文）、minimax-m3.1-flash、mistral-large-4-1t、step-5-preview、nemotron 家族（3-super / 3-ultra / 3.5-super-vl / 3.5-bolt / nano-omni）、gpt-oss-20b、laguna-xs、llama-3.2-vision 等。
- **快照外模型也能调**：`"model": "<functionId>@<publisher>/<slug>"`（body pin 最优先），或请求头 `nv-function-id` + `nv-function-slug`（+ 可选 `nv-function-namespace`）——fnId 可从模型 playground 页 SSR 的 `nvcfFunctionId` 抓到。
- 自带 `nv-captcha-token` 请求头可跳过求解（token 单次有效、寿命 2-3 分钟；池供 token 时 captcha 失败最多换 3 次新 token 重试）。

### 思考链控制（reasoning_effort）

顶层 `reasoning_effort` / `thinking.type` / `chat_template_kwargs` 三种写法自动归一：

| 模型 | 行为 |
|---|---|
| kimi-k3_1-pro | **顶层 `reasoning_effort` 原样透传**（passthrough，none/low/medium/high/max；抓包实测 UI 即如此） |
| deepseek-v4-flash/pro、nemotron-3-ultra | 映射进 `chat_template_kwargs.reasoning_effort`（档位按模型表） |
| diffusiongemma | `enable_thinking` 开关 |
| minimax-m3 | `thinking_mode`（disabled/adaptive/enabled） |
| 其余模型 | 顶层思考字段剥掉防 400；显式 `chat_template_kwargs` 总是直发透传 |

## 架构

```
OpenAI 请求 → node:http (8787, per-model 节流队列)
  → hCaptcha 管线:checksiteconfig → PoW(hashcash 章戳 + 指纹构建,TS 零依赖)
    → headless Chromium page.evaluate 跑 window.hsw(求解 + wasm 加解密)
    → getcaptcha(msgpack [c-spec, ext18(cipher)] 加密提交)→ P1_ token
  → predict:POST buildapi.ngc.nvidia.com/v2/predict/models/qc69jvmznzxy/{slug}
    (nv-function-id + nv-captcha-token + Origin/Referer,无 Cookie/Authorization)
  → SSE 透传 / 非流式聚合(JSON-first,SSE 兜底)
```

- `src/hcaptcha/` — PoW/指纹/msgpack/shim/runner/getcaptcha（Go 纯算法 → 手写 TS）
- `src/gateway/` — 模型快照、predict 组装 + 错误映射、chat 处理（含思考链归一）
- `src/node-host/` — server（节流/keep-alive/退化重试）、browser-solver、hsw-node（vm 调试）、logger、degenerate

### 可靠性机制（全是实测踩坑后的产物）

- **per-model 节流**：不同模型 = 不同 NVCF 函数 = 不同共享队列，互相并行；同模型串行 + 最小间隔（默认 3s，`NPG_CHAT_INTERVAL_MS`）——并行高频求解会触发 hCaptcha 34-bit 难度升级。
- **TS 指纹池**：默认 2 身份、lane（模型 slug）粘性分配，分摊求解频率。变体只换占位原串 + 屏幕尺寸（UA/common_keys 自洽不动）。单指纹高频曾触发 34-bit 升级（2^34 次 SHA-1 不可行），双身份后全天零升级。`NPG_FINGERPRINT_COUNT=1` 回历史单指纹。
- **难度尖峰阶梯**：挑战难度由服务端定，尖峰挑战（s=17 → 2^34 章戳搜索）直接放弃重领，最多 3 轮；章戳搜索有 10s 预算护栏（`PowBudgetExceeded`）。
- **502 队列诊断**：上游 `Retries exhausted`（NVIDIA 网关 3×80s 内部重试失败）时自动查免认证 queues 端点，502 错误体带 `queueDepth` 与实例状态。
- **退化响应重试**：空 content / reasoning 单字符重复循环（"!!!!…"）检出即整条废弃换新 token 重试，最多 2 次；SSE 在头部 reasoning delta 到达客户端前拦截。
- **流中止防护**：上游 h2 流中止/客户端断开不炸进程（undici "terminated" 竞态降级为日志）；客户端断开主动断上游流。
- **每模型字段清洗**：如 kimi-k3.1-pro 拒收 `top_p/stop/presence_penalty/frequency_penalty`（400，UI 从不发送）——按 canonicalModel 剥掉（`MODEL_STRIP_FIELDS`）。
- **文件日志**：`logs/npg-YYYY-MM-DD.log`（每日滚动），含每次 captcha 求解（lane/指纹变体/耗时）与每请求模型 + 状态码。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口（127.0.0.1） |
| `NPG_SOLVER` | `browser` | `vm` = node:vm 解算（当前 wasm 会挂，仅调试） |
| `NPG_FINGERPRINT_COUNT` | `2` | 指纹池身份数；`1` = 历史单指纹 |
| `NPG_CHAT_INTERVAL_MS` | `3000` | 同模型请求最小间隔 |
| `NPG_KEEPALIVE_MODELS` | `""`（关） | 逗号分隔模型 id，队列感知预热（保实例温度）；队列深 >32 自动跳过。⚠️ PS 里 `$env:X=""` 是删变量，要禁用请用 `","` |
| `NPG_KEEPALIVE_MS` | `60000` | 预热节奏 |
| `NPG_KEEPALIVE_MAX_QUEUE` | `32` | 超过此队列深度跳过预热 |
| `NPG_DEBUG_BODY` | 关 | `=1` 时上游 4xx/5xx 把发上去的请求体（截 4KB）记日志——定位字段级 400 用 |
| `NPG_CAPTURE_HEADLESS` | 关 | 抓包脚本强制无头 |

## 运维：拥堵与下架（实测运维学）

**判活口诀：查免认证 queues 端点**（`GET buildapi.ngc.nvidia.com/v2/predict/queues/models/qc69jvmznzxy/{slug}`，只需 Origin/Referer）：

| 状态 | 含义 |
|---|---|
| HTTP 404 | **函数被 NVIDIA 摘了**（下架），predict 只会白等 120s → 500 |
| depth 0–100 | 通畅，亚秒~十几秒 |
| depth 500–1000 | 能通但慢 |
| depth 1000+ | 120s `Retries exhausted` → 502（错误体带 queueDepth hint） |

- **下架剧本**：captcha no-pass 尖峰（挣扎期）→ 500 Retries exhausted → queues 404 → spec 最后才 404（spec 活 ≠ 可用）。
- **下架≠永别**：kimi-k3_1-pro 2026-11-06 下线、11-14 带原 fnId 复活（只换 functionVersionId）。queues 404 期间不要删快照条目。
- **无绕队特殊路径**：Playwright 抓包实测 UI 与本代理完全同构（同 v2 predict、同 P1_、同一共享队列，UI 自己也吃 500）；V3/protected 路径要账号级授权（403 RBAC）；真上游 grpc.nvcf.nvidia.com 要 NVCF 元数据鉴权（401）。唯一杠杆 = 按 queueDepth 选模型。
- 细节与协议全记录：`reference/upstream-protocol.md`。

## 排障与探针（scripts/）

| 脚本 | 用途 |
|---|---|
| `npx tsx scripts/verify-fp-pool.ts` | 指纹池自测 13/13（确定性/变体差异/lane 粘性/默认 2） |
| `npx tsx scripts/probe-predict.ts [model]` | 自铸 token 直连 v2 predict，A/B/C… 变体字段二分定位 400 |
| `npx tsx scripts/probe-v3.ts [model]` | V3 stateless 路径探测（已证同队列、30s 快失败） |
| `npx tsx scripts/list-models.ts` | 真浏览器抓 playground 目录，对比快照发现新模型 |
| `npx tsx scripts/capture-network.ts [publisher/slug]` | Playwright 抓包 UI 全部网络请求（headers+body → logs/*.ndjson） |
| `npx tsx scripts/check-snapshot.ts` / `update-snapshot.ts` | 快照核对/刷新 |

探针均需本地能跑 browser solver（同主服务）。

## 接入 DSH / 其他 OpenAI 客户端

`hsw-test/dsh-provider.yaml` 是现成的 provider 配置（23 条，含 contextWindow/maxTokens）：`baseUrl: http://localhost:8787/v1`，key 随意（不校验）。改模型显示名/下线模型都在这份 yaml + 快照注释里维护。

## 已知限制

- 一次求解 ~1-8s（含浏览器 evaluate）；headless Chromium 常驻 ~300MB。
- 请求体清洗只覆盖实测过的字段（kimi-k3.1-pro 四个）；新模型若 400 用 `NPG_DEBUG_BODY=1` + `probe-predict.ts` 定位。
- 非流式响应上限 300s（NVCF 冷启动可达数分钟）；流式不设人工超时。
- 运行时 live 目录抓取未移植 AWS WAF 挑战求解（Go 侧 waftoken）——`/v1/models` 用静态快照 + pin 合成，快照刷新靠 `list-models.ts` 手动跑。
