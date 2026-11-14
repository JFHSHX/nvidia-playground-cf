// scripts/verify-token-pool.ts — C 滴灌池无网络自测:懒启动/命中预铸/同 lane
// 单 in-flight/失败后可立即按需重试/过期替换/空闲停机/close。
// 运行:node node_modules/tsx/dist/cli.mjs scripts/verify-token-pool.ts
import { CaptchaTokenPool, type PooledCaptcha } from "../src/hcaptcha/token-pool";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, timeoutMs = 500): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!pred() && Date.now() < until) await sleep(2);
}

function fakeMint(counter: { calls: number }, ttlMs = 120, active?: Map<string, number>, peaks?: Map<string, number>) {
  return async (lane?: string): Promise<PooledCaptcha> => {
    const key = lane ?? "";
    const n = ++counter.calls;
    if (active && peaks) {
      const now = (active.get(key) ?? 0) + 1;
      active.set(key, now);
      peaks.set(key, Math.max(peaks.get(key) ?? 0, now));
    }
    await sleep(8);
    if (active) active.set(key, (active.get(key) ?? 1) - 1);
    return { captchaToken: `${key || "default"}-${n}`, functionId: "", expireAtMs: Date.now() + ttlMs };
  };
}

// 1-3: no boot solve, demand miss, then a genuinely prefetched hit.
{
  const count = { calls: 0 };
  const pool = new CaptchaTokenPool(fakeMint(count), { refillMs: 10, idleMs: 400, minFreshMs: 5 });
  check("lazy pool performs no boot solve", count.calls === 0);
  const first = await pool.take("alpha");
  check("first miss mints on demand", first.captchaToken === "alpha-1" && count.calls === 1);
  await waitFor(() => pool.stats().ready === 1 && pool.stats().inFlight === 0);
  const callsBeforeHit = count.calls;
  const second = await pool.take("alpha");
  check("second take consumes prefetched token without another solve", second.captchaToken === "alpha-2" && count.calls === callsBeforeHit);
  pool.close();
}

// 4: concurrent callers on one lane never run duplicate solves; lanes remain independent.
{
  const count = { calls: 0 };
  const active = new Map<string, number>();
  const peaks = new Map<string, number>();
  const pool = new CaptchaTokenPool(fakeMint(count, 200, active, peaks), { refillMs: 10_000, idleMs: 500, minFreshMs: 5 });
  const both = await Promise.all([pool.take("same"), pool.take("same")]);
  await pool.take("other");
  check("same-lane concurrency shares one in-flight solve", peaks.get("same") === 1, `max=${peaks.get("same")}`);
  check("concurrent takes receive distinct one-shot tokens", both[0].captchaToken !== both[1].captchaToken);
  check("different lanes keep independent token identities", (await pool.take("other")).captchaToken.startsWith("other-"));
  pool.close();
}

// 5: a demand failure rejects cleanly and the next request can retry immediately.
{
  let calls = 0;
  const pool = new CaptchaTokenPool(async () => {
    calls++;
    if (calls === 1) throw new Error("synthetic no-pass");
    return { captchaToken: "recovered", functionId: "", expireAtMs: Date.now() + 200 };
  }, { refillMs: 10_000, idleMs: 500, minFreshMs: 5, backoffMinMs: 10_000 });
  let rejected = false;
  await pool.take("retry").catch(() => { rejected = true; });
  const token = await pool.take("retry");
  check("failed fill rejects and next demand retries without backoff wait", rejected && token.captchaToken === "recovered" && calls === 2);
  pool.close();
}

// 6: stale buffered tokens are reaped/replaced instead of being handed out.
{
  const count = { calls: 0 };
  const pool = new CaptchaTokenPool(fakeMint(count, 70), { refillMs: 5, idleMs: 500, minFreshMs: 5 });
  await pool.take("stale");
  await waitFor(() => pool.stats().ready === 1);
  await waitFor(() => pool.stats().expired >= 1 && pool.stats().ready === 1);
  const token = await pool.take("stale");
  check("expired prefetch is replaced before take", token.captchaToken === "stale-3" && pool.stats().expired >= 1, token.captchaToken);
  pool.close();
}

// 7: idle lanes drop tokens and stop all background work until the next take.
{
  const count = { calls: 0 };
  const pool = new CaptchaTokenPool(fakeMint(count, 300), { refillMs: 5, idleMs: 60, minFreshMs: 5 });
  await pool.take("idle");
  await waitFor(() => count.calls >= 2);
  await sleep(100);
  const callsAtIdle = count.calls;
  await sleep(50);
  check("idle timeout drops ready tokens and stops refills", pool.stats().ready === 0 && count.calls === callsAtIdle, `calls=${count.calls}`);
  const restarted = await pool.take("idle");
  check("next take after idle restarts with a fresh token", restarted.captchaToken === `idle-${callsAtIdle + 1}`);
  pool.close();
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
