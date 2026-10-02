# nvidia-playground-cf

NVIDIA Build Playground 匿名模型网关的 Cloudflare Workers 原生重写(移植自 [6Kmfi6HP/nvidia-playgroud-go](https://github.com/6Kmfi6HP/nvidia-playgroud-go))。OpenAI 兼容 API,零运行时依赖。

> 需要 Cloudflare Workers **Paid** 计划:hCaptcha PoW 求解约 1s CPU,免费计划 10ms 上限必失败。

## 状态

🚧 移植中。任务看板:hCaptcha PoW 移植(src/hcaptcha)/ OpenAI 兼容网关(src/gateway + src/index.ts)。详见 PROJECT_NOTES.md。

## 部署

    npx tsc --noEmit      # 类型检查
    npx wrangler dev      # 本地验证
    npx wrangler deploy   # 部署

## 已知降级(vs Go 版)

- `/v1/models` live 抓取:CF IP 无 Chrome TLS 指纹 + AWS WAF,大概率失败 → 回退内嵌静态快照(11 模型)。
- 无常驻 token 池:每请求现解 PoW(+~1s 延迟);Go 版是后台池 TTL 90s。
