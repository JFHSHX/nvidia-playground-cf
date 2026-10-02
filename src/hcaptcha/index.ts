// src/hcaptcha/index.ts — the hCaptcha solver entry point (captcha-pow.go's
// PowExtract port): acquireNvCaptcha() performs a full solve and returns a
// fresh one-shot token.
//
// Token freshness guarantee (gateway-api integration risk #3, resolved):
// every call solves from scratch (checksiteconfig -> PoW -> fingerprint ->
// hsw -> getcaptcha) — NO cross-call token caching (mirrors Go PowExtract ->
// hcaptcha.CaptchaToken). expireAtMs = acquisition time + 90s (Go pool.go TTL
// default; hCaptcha tokens live 2-3 minutes). Retries in the gateway
// therefore always mint fresh tokens.
import { captchaToken } from "./getcaptcha";

/** The build.nvidia.com playground widget identity (captcha-pow.go:22-23);
 * the issued token is only valid for this (sitekey, host) pair. */
export const PLAYGROUND_SITEKEY = "0c6a1e45-75d7-43cc-b836-a0c9d886b8ee";
export const PLAYGROUND_HOST = "build.nvidia.com";

/** The solver result handed to the gateway: only captchaToken is consumed
 * (functionId does not participate in predict header assembly — the predict
 * path uses the model registry's per-model UUID; reference/upstream-protocol.md
 * lines 155-157). */
export interface NvCaptcha {
  captchaToken: string;
  functionId: string;
  expireAtMs: number;
}

/** Token TTL used for expireAtMs (Go pool.go default 90s). */
export const CAPTCHA_TTL_MS = 90_000;

/** acquireNvCaptcha: full solve returning a fresh one-shot token. Throws
 * Error on failure — including PowBudgetExceeded when the hashcash stamp
 * search exceeds its wall-clock budget (src/hcaptcha/pow.ts). Safe for
 * concurrent use; each caller gets an independent solve. */
export async function acquireNvCaptcha(): Promise<NvCaptcha> {
  const token = await captchaToken(PLAYGROUND_SITEKEY, PLAYGROUND_HOST);
  return { captchaToken: token, functionId: "", expireAtMs: Date.now() + CAPTCHA_TTL_MS };
}

export { powSelfTest } from "./pow";
