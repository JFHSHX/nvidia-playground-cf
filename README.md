# nvidia-playground-cf

NVIDIA Build Playground 匿名模型网关(移植自 [6Kmfi6HP/nvidia-playgroud-go](https://github.com/6Kmfi6HP/nvidia-playgroud-go)),OpenAI 兼容 API。**Windows 原生运行(Node + playwright 真实浏览器解算),端到端验证通过(HTTP 200)。**

## 为什么不是 Cloudflare Workers(原始目标)

全部实测(2026-10-03):

- **workerd 禁止一切运行时 wasm 代码生成**("WebAssembly.instantiate(): Wasm code generation disallowed by embedder",promise 与构造器形式都拒)——hsw.js 的 v1 bundle 在运行时从 atob() 块组装 wasm,在 workerd 里不可能跑。
- Worker Loader(Dynamic Workers)需要 Paid 计划(code 10195)。
- **当前 hsw wasm 在一切嵌入器里解算挂死**:`RuntimeError: unreachable`(panic=abort)。v8go(Go 版,容器日志实测 `hsw: solve timed out after 10s`)、Node 26/24 的 vm、plain Node——全部中招;只有真实浏览器正常。NVIDIA/hCaptcha 轮换 bundle 后,作者代码(所有 Docker/WSL2 部署)同样失效。

→ CF Workers 路径双重死,转向 **Node 原生 + playwright**。

## 运行(Windows 原生,无 Docker/WSL2/CF)

    npm install
    npx playwright install chromium    # 一次性,~150MB
    npx tsx src/node-host/server.ts    # http://localhost:8787

## API

- `GET /healthz` → `{status, models, runtime, solver}`
- `GET /v1/models` → OpenAI 模型列表(11 模型快照)
- `POST /v1/chat/completions` → OpenAI 兼容,支持 stream(SSE)与非流式;模型如 `moonshotai/kimi-k3`(默认;`z-ai/glm-5.2` 已被 NVIDIA 移除勿请求)

curl 示例(body 先写临时文件,避免 PS 5.1 引号坑):

    curl -s -X POST http://localhost:8787/v1/chat/completions -H "Content-Type: application/json" -d @body.json

## 架构

    OpenAI 请求 → Node host(node:http, 8787)
      → 管线(Node):checksiteconfig → PoW(真实难度 s=4 → 8 bits → 2^8 次 SHA-1,毫秒级)→ 指纹+章戳(hashcash 1:4:date:powData::salt:counter)
      → 解算(playwright):headless Chromium + page.evaluate 跑 window.hsw —— 真实浏览器是当前 wasm 唯一接受的环境
      → getcaptcha(浏览器内加密/解密,cryptoMode)→ P1_ token(单次有效,寿命 2-3 分钟)
      → predict(POST buildapi.ngc.nvidia.com/v2/predict/models/qc69jvmznzxy/{slug})→ 200

模块:`src/hcaptcha/`(pow/fingerprint/msgpack/shim/runner/getcaptcha/index)、`src/gateway/`(models-snapshot/predict/chat)、`src/node-host/`(server/hsw-node/browser-solver)。`src/index.ts` + `wrangler.toml` 保留 workerd 版作参考(当前不可部署)。详见 PROJECT_NOTES.md。

## 已知点

- `NPG_SOLVER=vm` 强制 node:vm 解算(当前 wasm 会挂,仅调试用;默认 browser)。
- 一次解算 ~1-3s(含浏览器 evaluate);浏览器常驻 headless(~300MB)。
- 章戳预算护栏 10s:难度异常时给出明确错误而非挂死。
- 需要能访问 `build.nvidia.com` / `newassets.hcaptcha.com` 的网络;家宽被墙时给 Node 设代理。
- shim 对 `location`/`setTimeout`/`requestAnimationFrame` 等加 `typeof` 守卫:这些在浏览器是 LegacyUnforgeable,直接赋值会触发导航并杀死脚本(实测 "Failed to set the 'href' property on 'Location'")。
- NVIDIA predict 返回 JSON body 配 `text/event-stream` Content-Type:chat.ts 用 JSON-first 解析,SSE 聚合兜底。
