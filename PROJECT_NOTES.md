# nvidia-playground-cf — 项目契约与约束(队员先读这份)

## 目标
把 https://github.com/6Kmfi6HP/nvidia-playgroud-go(Go + cgo/v8go)的 NVIDIA Build Playground 匿名模型网关重写为 Cloudflare Workers 原生 TypeScript 版本:零运行时依赖,OpenAI 兼容 API,hCaptcha PoW(hsw.js)跑在 Dynamic Worker(Worker Loader binding)里。

## 已核实的上游事实(来自 Go 源码与 README,2026-09 时点)
- 认证 = hCaptcha PoW token。sitekey `0c6a1e45-75d7-43cc-b836-a0c9d886b8ee`,host `build.nvidia.com`。
  - Go 侧:纯 Go PoW 算法(internal/hcaptchapow)+ v8go 内嵌 V8 跑 hsw.js(internal/hsw = hsw.go + shimjs.go 浏览器环境 shim + fetch.go)。
  - token 单次有效,寿命 2-3 分钟;求解 CPU 随难度:JWT 难度 s 是半位,hashcash stamp 需 s×2 个 SHA-1 前导零位(真实捕获 JWT s=16 → 32 bits → 2^32 次 → Go 端几十秒;真实服务大概率发个位数小值,captcha-pow.go 观察"a few hundred ms CPU")。src/hcaptcha/pow.ts 的 mintStamp 带 10s 预算护栏。
- 预测端点:`POST https://buildapi.ngc.nvidia.com/v2/predict/models/{namespace}/{slug}`,namespace `qc69jvmznzxy`(共享)。
  - 请求头:`nv-function-id` + `nv-captcha-token` + `Origin`/`Referer` = `https://build.nvidia.com`。无需 Cookie/Authorization。
  - 上游即 OpenAI chat 格式,SSE 流式。
- 模型注册表:11 模型(internal/models = registry.go 静态快照 + fetch.go 运行时抓取 /models 目录)。目录抓取在 Go 侧用 Chrome 131 TLS 指纹 + AWS WAF 挑战求解(internal/waftoken),失败时回退无过滤页(24 候选)。
- 默认模型 `moonshotai/kimi-k3`。z-ai/glm-5.2 已被 NVIDIA 移除(404),勿请求。

## Workers 侧架构与模块边界
- `src/hcaptcha/` — hCaptcha PoW 移植(【任务 A 专有】,已完成):internal/hcaptchapow 纯算法 → 手写 TS(pow/fingerprint/msgpack/shim/runner/getcaptcha/index 7 文件);hsw.js 运行时抓取(AssetURL /c/<location>/hsw.js,便于 NVIDIA 轮换)+ 补丁后装入 **Dynamic Worker**(Worker Loader binding,`env.LOADER.get(id, factory)` 按 bundle 缓存热 worker)——运行时代码执行不经过 eval(eval/new Function 仅限启动阶段);shim 为 shimjs.go 对应物,workerd 原生 atob/btoa/TextEncoder/crypto 直接复用。
- **`src/node-host/` — Windows 原生运行入口(最终方案,端到端验证 200 OK)**:`npx tsx src/node-host/server.ts`(8787)——node:http + 与 workerd 版相同的 OpenAI 兼容 API;**解算走 playwright 真实浏览器**(src/node-host/browser-solver.ts:headless Chromium + page.evaluate 跑 window.hsw)。原因(全部实测):①当前 hsw wasm 在一切嵌入器(v8go/Node vm/workerd)解算挂死,只有真实浏览器正常;②workerd 禁止一切运行时 wasm 代码生成 → CF 部署双重死(Paid + code-gen);③Go 版容器日志证实作者代码也死于同一步。shim 的 location/timers/rAF 赋值加 typeof 守卫(LegacyUnforgeable 在浏览器里会触发导航杀脚本)。chat.ts JSON-first(NVIDIA predict 返回 JSON body 配 text/event-stream Content-Type)。
- `src/gateway/` + `src/index.ts` — OpenAI 兼容网关(【任务 B 专有】):/v1/chat/completions(流式 SSE + 非流式)、/v1/models(内嵌快照为基线,尽力 live 抓取,失败回退快照)、/healthz、错误映射、CORS。
- 模块间唯一接口(先按此签名写代码,最终签名由任务 A 确认后 message 给 Lead 转发):
  `export async function acquireNvCaptcha(): Promise<{ captchaToken: string; functionId: string; expireAtMs: number }>`

## 硬约束
- 运行时 workerd:无 Node API、无 fs/net 原生模块;fetch / WebSocket / TransformStream 可用;**eval/new Function 仅限启动阶段**(allow_eval_during_startup,2025-06-01 起默认启用)——请求阶段动态执行代码走 Worker Loader binding(wrangler.toml `[[worker_loaders]] binding = "LOADER"`)。
- 零运行时依赖:只用 devDeps(typescript / wrangler / @cloudflare/workers-types)。PoW 算法手写 TS,不引 npm 库。
- CPU 预算:PoW ~1s CPU/次 → 目标 Workers **Paid** 计划(30s CPU 上限);免费计划 10ms 必失败。代码避免无谓 CPU 浪费。
- v1 **不移植** internal/waftoken(AWS WAF 挑战求解):/models live 抓取从 CF IP 大概率被 WAF 挑战且无 TLS 指纹,直接回退静态快照(Go 侧本身也是这么兜底的)。
- 本会话 pwsh 执行环境故障(0xC0000142 STATUS_DLL_INIT_FAILED),**所有成员都不能本地构建/测试**:写代码靠仔细 + strict TS;tsc --noEmit 由用户侧跑;真实验证在部署后。
- PowerShell 5.1 会剥离 JSON 双引号(工作区已验证的教训):给用户的测试命令一律写临时文件后 curl -d @file 或用 irm。

## 参考源码(web 工具可抓,fetch 后可写入工作区自己的参考目录)
- 目录列表:`https://api.github.com/repos/6Kmfi6HP/nvidia-playgroud-go/contents/internal/<dir>`
- 文件原文:`https://raw.githubusercontent.com/6Kmfi6HP/nvidia-playgroud-go/main/<path>`
- 关键文件:internal/hcaptchapow/(全部,纯 Go PoW 算法)、internal/hsw/hsw.go + shimjs.go + fetch.go、internal/models/registry.go + fetch.go、predict 请求组装与 nv-function-id 生成逻辑(在 internal/ 或 cmd/serve/ 里探索,用 GitHub API 列目录确认实际路径)。

## 部署路径(用户侧,与 ClankerMux-cf 同模式)
- 完成后推 GitHub → GitHub Actions 或 `wrangler deploy`。
- 用户先 `npx tsc --noEmit` + `npx wrangler dev` 本地验证,再 deploy。
