// src/hcaptcha/index.ts — hCaptcha solver entry (captcha-pow.go PowExtract).
// Default: every acquire solves from scratch. The Node host may enable the
// per-lane drip pool (C) to prefetch one-shot tokens in the background;
// workerd keeps the fresh-solve path because it has no background lifetime.
import { captchaToken } from "./getcaptcha";
import {
  CaptchaTokenPool,
  type CaptchaTokenPoolOptions,
  type CaptchaTokenPoolStats,
} from "./token-pool";

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

/** Token TTL used for expireAtMs (Go pool.go default 90s; actual hCaptcha
 * tokens live 2-3 minutes, so the pool also keeps a freshness margin). */
export const CAPTCHA_TTL_MS = 90_000;

async function freshNvCaptcha(lane?: string): Promise<NvCaptcha> {
  const token = await captchaToken(PLAYGROUND_SITEKEY, PLAYGROUND_HOST, lane);
  return { captchaToken: token, functionId: "", expireAtMs: Date.now() + CAPTCHA_TTL_MS };
}

let tokenPool: CaptchaTokenPool | null = null;

/** Configure the Node-host background drip pool. Lazy: no solve happens until
 * the first acquire for a lane. size=0 restores the historical fresh-solve
 * path. Reconfiguration closes the old pool and drops its buffered tokens. */
export function configureCaptchaTokenPool(options: CaptchaTokenPoolOptions = {}): void {
  tokenPool?.close();
  const size = options.size ?? 1;
  tokenPool = Number.isFinite(size) && size > 0
    ? new CaptchaTokenPool(freshNvCaptcha, options)
    : null;
}

export function captchaTokenPoolStats(): CaptchaTokenPoolStats | null {
  return tokenPool?.stats() ?? null;
}

/** acquireNvCaptcha returns a fresh one-shot token. lane (the model slug)
 * binds the solve to a stable fingerprint identity from the pool
 * (NPG_FINGERPRINT_COUNT, default 2; set 1 for the historical single identity).
 * With the drip pool enabled, ready tokens are FIFO and never reused; an empty
 * pool shares one demand solve instead of starting duplicate claims. Throws
 * Error on failure, including PowBudgetExceeded (src/hcaptcha/pow.ts). */
export async function acquireNvCaptcha(lane?: string): Promise<NvCaptcha> {
  if (tokenPool) return tokenPool.take(lane);
  return freshNvCaptcha(lane);
}

export { powSelfTest } from "./pow";
