# 上游协议参考(源自 6Kmfi6HP/nvidia-playgroud-go Go 源码,2026-10-02 抓取)

抓取自 raw.githubusercontent.com/6Kmfi6HP/nvidia-playgroud-go/main 的 registry.go / function_ref.go /
executor.go / client.go / types.go / coalesce.go / normalize.go / reasoning.go / fetch.go / getcaptcha.go。
Gateway 实现以此文件为准。

## Predict 端点与请求(executor.go / client.go)
- `POST {PredictBase}/v2/predict/models/{namespace}/{slug}`
  - `PredictBase = "https://buildapi.ngc.nvidia.com"`(旧 api.ngc.nvidia.com 匿名 404)
  - `Namespace = "qc69jvmznzxy"`(全部 playground 模型共享)
- 请求头(每次 predict,缺一不可):
  - `Content-Type: application/json`
  - `Accept: text/event-stream`(非流式也带这个;上游按 body.stream 决定返回格式)
  - `nv-function-id: {per-model UUID}`(registry 提供)
  - `nv-captcha-token: {P1_ 开头的 hCaptcha passcode}`
  - `Origin: https://build.nvidia.com`
  - `Referer: https://build.nvidia.com/`(注意带尾斜杠)
  - 无 Cookie / 无 Authorization
- 请求体 = OpenAI chat.completion 请求格式(Go executor 直接透传 OpenAI 字段):
  `{model, messages: [{role, content, reasoning_content?}], stream, stream_options?, temperature?, top_p?, max_tokens?, seed?, chat_template_kwargs?, response_format?, tools? ...}`
  - `body.stream` 强制 = 执行模式(forceStreamFlag);stream=true 时:
    `stream_options.include_usage = true`(仅当客户端未设)、`stream_options.continuous_usage_stats = false`(总是覆盖,usage 只在最后一条)
  - body.model 必须是 registry 规范 id(pin `<fid>@<model>` 会被剥掉换成规范 id)
- Go CLI 客户端默认值(client.go,仅 CLI 路径;executor 网关路径不做这些默认):
  max_tokens 16384、seed 42、temperature 1.0、top_p 省略(kimi-k3 等 2026-08 目录模型对 top_p 返回 400)、requestTimeout 120s。
  temperature==0 时替换为默认 1.0(omitempty 导致 0 值省略)。

## nv-function-id(function_ref.go)
- 每模型静态 UUID(scripts/scrape_playground_models.py 从 playground 页 SSR 的
  `"nvcfFunctionId"` + `"namespace"` 抓取),非运行时生成。
- Pin 语法(两种入站形式,body pin 胜):
  - body:`"model": "<function-id>@<publisher>/<slug>"`(第一个 `@` 分割)
  - header:`nv-function-id: <function-id>`
  - 两者都有时 body pin 胜(body 命名端点的地方就是选模型的地方)
- `MaxFunctionIDLen = 128`;ValidFunctionID:非空、≤128、字符集 `[A-Za-z0-9._-]`(防 header 注入)。
  400 文本:`invalid nv-function-id %q: use 1-128 characters from [A-Za-z0-9._-]`
- `ValidSlugRef`:非空、≤256、字符集 `[A-Za-z0-9._/-]`(<publisher>/<slug> 允许)。
- 未知模型 + pin → 仍可调用(合成):slug = model 最后一个 `/` 段,namespace = `nv-function-namespace`
  header(可选)或默认共享 namespace,capability 零值。400 文本:
  `invalid model %q for a function pin: use up to 256 characters from [A-Za-z0-9._/-]`
- 无 body pin 时的 header 合成目标:`nv-function-slug`(必须有效 slug ref)+ `nv-function-id`
  (必须有效)+ `nv-function-namespace`(可选)。400 文本:
  `invalid nv-function-slug %q: use up to 256 characters from [A-Za-z0-9._/-]` /
  `nv-function-slug requires a valid nv-function-id header (got %q)`
- 空模型 id → DefaultModel `moonshotai/kimi-k3`。
- function ref 分隔符 `@`;模型 id 永不含 `@`,第一个 `@` 即分割点;pin/base 都 TrimSpace。

## 上游错误格式与错误映射(executor.go / types.go)
- 上游错误体 JSON:`{"requestStatus": {"statusCode": "...", "statusDescription": "...", "requestId": "..."}}`
  (注意 camelCase 键:statusCode/statusDescription/requestId)
- 网关映射(executor.doPredict + captchaErr):
  - 400:未知模型、malformed pin、invalid json body
  - 401:captcha token 无效/过期(lease commit 失败、或可重试 captcha 失败耗尽重试)。
    文本 `captcha token invalid or expired; retry the request`
  - 408:客户端在等 captcha 槽位/求解时取消(context.Canceled)
  - 502:上游网络错误(`upstream: %v`)或上游 4xx/5xx 非 captcha 失败(消息 = 上游 body trim,空则
    `upstream request failed`)
  - 503:captcha 池空(`captcha pool empty after %s (ready=%d fills=%d takes=%d errors=%d expired=%d);
    retry later`)或 max in-flight 达到(`max in-flight upstream streams reached; retry later`)
- 重试:client 自带 token 时 maxAttempts=1;池供 token 时 maxAttempts=3。
- isRetryableCaptchaFailure(4xx 且 body 提示 token/captcha 问题,可换新 token 重试):
  - body JSON requestStatus.statusDescription 含 `token is invalid` 或 `invalid token` → true
  - statusCode == `INVALID_REQUEST` 且 description 含 `token` → true
  - body 小写含 `token is invalid` → true;含 `captcha` 或 `hcaptcha` → true
- 非重试 4xx/5xx → 502 带上游消息。parseError 尝试:requestStatus.statusDescription →
  OpenAI `error.message`(`nvidia: {type}: {message}`)→ `nvidia: http error: {前300字节}`。

## SSE 流(coalesce.go / client.go / types.go)
- 标准 OpenAI SSE:`data: {...}` 行、`data: [DONE]` 终止、`:` 开头 comment/keep-alive 忽略、事件间空行。
- chunk 形状:`{id, object: "chat.completion.chunk", created, model, choices: [{index, delta: {role?,
  content?, reasoning_content?}, finish_reason, logprobs}], usage?, system_fingerprint?, service_tier?}`
  最后 usage-only chunk 的 choices 为空数组。
- 非流式(stream=false)上游返回普通 JSON chat.completion(非 SSE):
  `{id, object: "chat.completion", created, model, choices: [{index, message: {role, content,
  reasoning_content?}, finish_reason, logprobs?}], usage?, system_fingerprint?, service_tier?}`
  usage: `{prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details?: {cached_tokens,
  audio_tokens}}`
- Coalescing(Go 优化,CLI 用;Workers 网关透传 SSE 不需要):首个 content token 立即 flush(TTFT),
  后续纯 content delta(delta 只含 content/role、无 usage、无 finish_reason、content 非空)在窗口内合并;
  不可合并 chunk 先 flush pending 再发;[DONE] 前 flush pending。

## thinking / chat_template_kwargs(reasoning.go + client.go)
- Playground 风格:`chat_template_kwargs: {enable_thinking: true, clear_thinking: false}`。
- 只对声明 Thinking capability 的模型注入;2026-08 目录大部分(kimi-k3 等)对 thinking kwargs 返回 400。
  registry.go 的静态快照没有设置任何 Capability(全 nil)→ 默认不注入。
- normalizeThinking(按 registry id 的 profile 表)总是先剥掉顶层 `thinking` / `enable_thinking` /
  `clear_thinking` / `reasoning_effort` 字段(包括不支持的模型 → 防 400);支持的模型把值映射进
  chat_template_kwargs:
  - deepseek-ai/deepseek-v4-flash-0731、deepseek-ai/deepseek-v4-pro-0813:reasoning_effort,levels
    [none, high, max],default high
  - nvidia/nemotron-3-ultra-550b-a55b:reasoning_effort,levels [none, medium, high],default high
  - google/diffusiongemma-26b-a4b-it:enable_thinking toggle
  - minimaxai/minimax-m3:thinking_mode(none→disabled;minimal/low/medium→adaptive;否则 enabled)
  - effortRanks: none 0, minimal 1, low 2, medium 3, high 4, xhigh 5, max 6;未知 effort → defaultLevel
  - mapEffort:profile.levels 里第一个 rank ≥ 请求 rank 的 level;mapEnabled(false)→mapEffort("none")
  - clear_thinking 只保留给 toggle/effortAndToggle profile
  - 客户端显式发的 chat_template_kwargs(hadKwargs)总是保留(即使不支持模型)。

## 模型 registry(registry.go,2026-08-30:24 端点、11 个带内联 nvcfFunctionId)
```json
{
  "deepseek-ai/deepseek-v4-flash-0731": { "slug": "deepseek-v4-flash-0731", "function_id": "281478d0-f307-49f4-9e0f-080b63b16c47" },
  "deepseek-ai/deepseek-v4-pro-0813": { "slug": "deepseek-v4-pro-0813", "function_id": "6e70713f-4eeb-4ef7-b4f8-2d984f4141f6" },
  "google/diffusiongemma-26b-a4b-it": { "slug": "diffusiongemma-26b-a4b-it", "function_id": "ffd13b18-1c55-4a7a-b71a-acbfde9ce8a0" },
  "meta/muse-glimmer-30b": { "slug": "muse-glimmer-30b", "function_id": "fd21cc19-b4ff-4949-ba07-90dd663c416a" },
  "minimaxai/minimax-m3": { "slug": "minimax-m3", "function_id": "87ea0ddc-cff1-4bca-bf8b-3bd98a35ddd0" },
  "moonshotai/kimi-k3": { "slug": "kimi-k3", "function_id": "1586112a-925c-48af-8631-7c815dbd749c" },
  "nvidia/ising-calibration-1.5-31b": { "slug": "ising-calibration-1.5-31b", "function_id": "499210d3-3bf7-44bf-88b5-9460edfa8a38" },
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning": { "slug": "nemotron-3-nano-omni-30b-a3b-reasoning", "function_id": "c4ed50ff-b5c3-409d-ab57-b79c33f5bb39" },
  "nvidia/nemotron-3-ultra-550b-a55b": { "slug": "nemotron-3-ultra-550b-a55b", "function_id": "948fe171-ce7a-4332-8bc0-5e14e90259f9" },
  "nvidia/nemotron-3.5-lightning-30b-a3b": { "slug": "nemotron-3.5-lightning-30b-a3b", "function_id": "0a213807-640b-43fb-bfbf-2919f9b666ad" },
  "poolside/laguna-xs-2.1": { "slug": "laguna-xs-2.1", "function_id": "4a8f921c-c99d-4cde-92c1-c92ba9e4c50f" }
}
```
- 所有 slug 的 namespace 都是 qc69jvmznzxy。
- function id 几乎都每模型唯一,但 NVIDIA 会把部分后端版本别名到同一 NVCF function(如
  ising-calibration-1-35b-a3b 与 ising-calibration-1.5-31b 共享 499210d3);predict 按 namespace/slug 键,
  每 registry key 唯一,所以没问题。
- DefaultModel `moonshotai/kimi-k3`;z-ai/glm-5.2 已被 NVIDIA 移除(SSR 仍内联 function id 但后端
  grpc.nvcf.nvidia.com 404),勿请求。

## live 模型目录抓取(fetch.go)
- ModelsURL(过滤版,WAF 后):`https://build.nvidia.com/models?filters=nimType%3Anim_type_preview&pageSize=100`
  - AWS WAF JS challenge:无有效 aws-waf-token cookie 时 HTTP 202 + 小挑战页(gokuProps;body >0 且
    <64KB 含 "gokuProps" 即挑战页)
- FallbackModelsURL(无过滤、无 WAF):`https://build.nvidia.com/models`(Next flight data 内嵌目录,卡片少)
- UA 必须 Chrome 131(macOS):`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36
  (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36`,非浏览器 UA 得空 body。
  其余头:Accept `text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8`、
  Accept-Language `en-US,en;q=0.9`、Referer `https://build.nvidia.com/`、Sec-CH-UA
  `"Not A(Brand";v="99", "Google Chrome";v="131", "Chromium";v="131"`、Sec-CH-UA-Mobile `?0`、
  Sec-CH-UA-Platform `"macOS"`、Sec-Fetch-Dest document、Sec-Fetch-Mode navigate、
  Sec-Fetch-Site same-origin、Upgrade-Insecure-Requests 1。
- 流程:GET ModelsURL → 失败/挑战 → (Go:自动解 WAF 重试;Workers v1 不移植 waftoken)→ GET
  FallbackModelsURL → 解析 id → 每个 id GET playground 页 → 提取 nvcfFunctionId/namespace →
  合成 registry;0 可用模型 = 失败,保留旧 registry。
- 正则(Go 语法,`\\?` = 可选字面反斜杠,flight data 里引号可能 \-转义):
  - resIDRe:`qc69jvmznzxy/([A-Za-z0-9_.+~\-]+)`
  - hrefRe:`href="/([a-zA-Z0-9_.-]+)/([A-Za-z0-9_.+~\-]+)"`(pub ∈ {models, explore, blueprints,
    skills, _next, ""} 跳过;slug ∈ {playground, community, ""} 跳过;resID 集非空时只留 catalog 端点)
  - fnIDRe:`"nvcfFunctionId\\?":\\?"([a-f0-9-]{36})\\"?"`
  - nsRe:`"namespace\\?":\\?"([0-9a-z]+)\\"?"`
  - uuidRe:`^[a-f0-9-]{36}$`
- PlaygroundURLTemplate:`https://build.nvidia.com/{pub}/{slug}/playground`
- fetchRetries 3(1s*attempt 退避)、并发 12、目录 body 上限 32MB。

## hCaptcha PoW 概况(getcaptcha.go,细节归任务 A)
- 流程:checksiteconfig(GET,host+sitekey+sc=1&swa=0&spst=0&hl=en)→ challenge JWT + hsw bundle
  location → fingerprint + hsw PoW 求解 n → POST `https://api.hcaptcha.com/getcaptcha/<sitekey>`
  (JSON 先试,失败回退 form;Origin/Referer = `https://newassets.hcaptcha.com`)→ P1_ passcode。
- token 以 `P1_` 开头(base64url 载荷 + "."),全 body 扫描提取(字段名多变:generated_pass_UUID、
  captcha_token、pass...)。现代端点要求 wasm 加密提交(msgpack [c spec, ext18(cipher)],octet-stream)。
- 单次有效,寿命 2-3 分钟;PoW ~1s CPU。
- sitekey `0c6a1e45-75d7-43cc-b836-a0c9d886b8ee`,host `build.nvidia.com`。
- **predict 的 nv-function-id 与 PoW 无关**:executor 用 registry 每模型 UUID 配池供 token
  (token 模型无关);契约 `acquireNvCaptcha(): Promise<{captchaToken, functionId, expireAtMs}>`
  的 functionId 字段不参与 predict 头组装。
