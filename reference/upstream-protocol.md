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

## Playwright 抓包实测(2026-10-06,scripts/capture-network.ts,glm-5-3 手动会话)
- UI 的 predict 与我们完全同构:`POST buildapi.ngc.nvidia.com/v2/predict/models/qc69jvmznzxy/glm-5-3`,
  headers nv-function-id `0cd5c583-435c-4649-a621-f4e421fa12a0`(= models-snapshot.ts:110)、accept
  `text/event-stream`、nv-captcha-token `P1_…`、无 Cookie/Authorization/priority——**无绕开队列的特殊路径**。
- **UI 自己也吃同样的 500**:queueDepth 2090–2205 期间等 120s(x-envoy-upstream-service-time:120322)→
  500 `"Retries exhausted: 3/3"`;500 后 ~2.5min 重发第二个 predict(新 P1_ token,同 body)。
- UI 轮询模式:predict in-flight 期间每 ~10.5s GET `/v2/predict/queues/models/qc69jvmznzxy/{slug}`
  (与我们 warmer 同端点、密度 6 倍;我们的 60s 在 NVIDIA 自家流量画像内);500 后停止;空闲期每 ~30s
  GET spec(api.ngc.nvidia.com,匿名 200,keep-alive 信号)。
- queues 响应含 functionVersionId(当日 `fec26d6c-a599-4e59-8234-487e5c1894a0`)+ queueDepth;
  **无 cancel、无 queue-position 端点**(错误体 requestId 无对应查询/取消路径)。
- 完整网关路径表:UI 经 Next.js Server Action(header `next-action: 40faaf4b5d5d…2916`,body
  `["buildapi-gateway-paths.yaml"]`)取得,27 条,含 `/v3/protected/predict/stateless{/*path}`、
  `/v3/predict/stateful{/*path}`(V3 预测 API,UI 对 glm-5-3 未用)、
  `/v2/predict/blueprints/:orgName/:blueprintName`、`/v2/nemo-services/:orgName/:artifactName{/spec}`、
  `/v2/build/:artifactType/:artifactName/token` 等。
- UI 请求体差异(与拥堵无关):`stream_options.continuous_usage_stats=true`(我们强制 false)、
  tools 数组(演示工具)、temperature 0.5、max_tokens 1024。
- partner-endpoints:`buildapi.ngc.nvidia.com/v2/build/endpoints/{ns}/{slug}/partner-endpoints` 返回
  第三方部署选项(GMICLOUD,USD_INPUT 0.98 / USD_OUTPUT 3.08 每 1M tokens),非拥堵相关。
- 模型元数据 SSR 进页面 HTML(目录 API `api.ngc.nvidia.com/v2/search/catalog/resources/BLUEPRINT`
  对 orgName qc69jvmznzxy + relatedblueprint_glm_5_3 返回空)。

## V3 / 真上游探测(2026-10-06,scripts/probe-v3.ts,glm-5-3)
- `/v3/protected/predict/*`(stateless/models/… 及 queues)→ `403 "RBAC: access denied"`:
  路由真实存在但要账号级授权,captcha token 无用——绕不开。
- `/v3/predict/stateless/models/{ns}/{slug}` **存在且请求形状正确**(与 v2 同构):
  旧 token → `400 "Token is invalid"`(kaizen 格式 `urn:kaizen:problem-details:bad-request`);
  新 token(项目管线 5.9s 铸出)→ **过验证**,转发真上游。
- **真上游暴露在 v3 错误体里**:`504 Gateway Timeout from POST https://grpc.nvcf.nvidia.com/models/{ns}/{slug}`
  ——buildapi 网关只是 grpc.nvcf.nvidia.com 的代理。
- V3 **共享 v2 同一队列**(glm-5-3 depth 2112→2039,探针入队),envoy 上游超时 ~30s
  (x-envoy-upstream-service-time 30112)→ 504 `urn:about:blank` Gateway Timeout。
  **不是绕队通道**,但失败快(v2 是 3×80s 重试 ≈250s)。
- 直连 `grpc.nvcf.nvidia.com/models/{ns}/{slug}` → `401 reason:"no authorization was passed
  in the metadata"`——NVCF 元数据鉴权,captcha 无用,直连死路。
- kimi-k3 / deepseek-v4.1-flash 的 V3 复测(同日 21:30+08):**与 glm-5-3 完全一致**——
  能过验证、同一队列、`504 after ~30s`(grpc.nvcf.nvidia.com cause);kimi-k3 队列
  2103→2060,deepseek 3020→3070。三个 congested 模型在 V3 上无差异,无绕队通道。
- 队列分布(同日 21:12+08):glm-5-3 1924、kimi-k3 1956、deepseek-v4.1-flash 2984、
  gemma-4-31b-it 587、lightning 504;**7 个模型深度 0**(nemotron-3-super/muse-glimmer/
  nano-omni/laguna/llama-3.2-11b/ultra/gpt-oss-20b),diffusiongemma 1。拥堵是按函数的,
  小模型全空闲。

## 函数下线特征(2026-11-06,kimi-k3_1-pro,fnId b79234a1-…)
- 信号三件套(与 10-17 kimi-k3 下线同剧本,下架是分步的):
  1. **queues 端点 HTTP 404**(最快信号,免费秒回),错误体点名
     `404 Not Found from GET https://api.nvcf.nvidia.com/v2/nvcf/accounts/{acct}/queues/functions/{fnId}`;
  2. **v2 predict 100% 失败**:captcha 正常铸出(6-8s 1 attempt)→ 等 120s →
     `500 "Retries exhausted: 3/3"`(NVIDIA 网关 3 次内部重试全部进不了死函数);
  3. **spec 端点仍 200**(fnId 不变)——目录层最后摘,spec 活≠模型可用。
- **v3 对死函数的行为**:`/v3/predict/stateless/...` 同样接受 captcha、转发真上游,
  envoy 30s 超时 → `504 from POST https://grpc.nvcf.nvidia.com/models/{ns}/{slug}`;
  queues before/after 空。v3 无法区分"拥堵"和"函数已死"(都是 504/30s),
  唯一区别只是失败快(v2 120s 慢死 / v3 30s 快死)。
- 判活口诀:**查 queues 端点——404=函数被摘,有深度=活着,深度大=只是慢**。
- 时间线参考:下线前夜 captcha no-pass 31-33s(函数挣扎期),凌晨 01:01/01:03
  500 Retries exhausted,01:04 fetch failed,晨间 queues 404 定案。
- **复活(2026-11-14,下线 8 天后)**:queues 200、depth 0、ACTIVE;**fnId 未变**
  (仍 b79234a1-…),只换了 functionVersionId(→93718f7f-c6ff-4bb3-a9ff-b2650f063633)。
  即 NVCF 函数可带原 fnId 复活,下架≠永别;queues 404 期间不要删快照条目。

## 成功样本抓包(2026-10-06,nemotron-3-super-120b-a12b,queueDepth 0)
- 200 成功路径与失败路径**请求形状完全一致**(nv-function-id `ac74040f-…`、P1_ token、
  accept text/event-stream、Origin/Referer、无 Cookie/priority)——**成功也没有特殊路径**。
- **x-envoy-upstream-service-time: 735ms**(拥堵 glm-5-3 同头是 120,322ms)——0 深度队列
  <1s 即回;**队列深度就是唯一瓶颈**,实例有容量时 NVIDIA 响应亚秒级。
- 200 响应**无任何特殊头**:无 rate-limit、无 queue-position、无 request-id、无新 nv-* 头
  (只有标准安全头 + `access-control-expose-headers: *` + istio-envoy)。失败/成功信息量相同。
- SSE 块与 glm-5-3 同构:chat.completion.chunk + reasoning_content 增量(nemotron 推理模型)
  + 每块 usage。
- killswitches(匿名 200):`model-page-v3-capabilities.enabled=true`(V3 能力全局开但聊天
  仍走 v2)、`chat/select-example.enabled=true`、`chat/omit-tools=["get_current_weather"]`
  (UI 把这个工具从请求里剔除)。
- queues 响应(0 深度模型):functionVersionId `8ea728d2-…`、functionName
  `ai-nemotron-3-super-120b-a12b`、ACTIVE、queueDepth 0。
- **最终结论(两轮抓包 + V3 三路探测)**:无绕队特殊路径。UI 与我们完全同构(v2 predict +
  P1_ captcha + 同一共享队列);V3/protected/grpc 全要账号级授权。唯一杠杆=按函数
  queueDepth 选模型(深度 0 的 7 个模型亚秒即回)——Gateway ModelSelector 可做拥堵自动切换。
