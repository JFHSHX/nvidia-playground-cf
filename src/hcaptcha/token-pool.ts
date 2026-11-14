// src/hcaptcha/token-pool.ts — C: per-lane background captcha drip pool.
// Lazy on first take: an idle process performs no solves. A miss shares the
// lane's single in-flight solve instead of starting a duplicate claim; a hit
// schedules one background refill. Tokens are one-shot and never reused.

export interface PooledCaptcha {
  captchaToken: string;
  functionId: string;
  expireAtMs: number;
}

export type MintPooledCaptcha = (lane?: string) => Promise<PooledCaptcha>;

export interface CaptchaTokenPoolOptions {
  /** Ready tokens per model lane. */
  size?: number;
  /** Delay before replenishing a consumed/expired token. */
  refillMs?: number;
  /** Stop and drop ready tokens after this long without a take. */
  idleMs?: number;
  /** Do not hand out tokens with less than this much lifetime remaining. */
  minFreshMs?: number;
  /** Background refill failure backoff (demand solves still run immediately). */
  backoffMinMs?: number;
  backoffMaxMs?: number;
}

interface LaneState {
  tokens: PooledCaptcha[];
  inFlight: Promise<void> | null;
  timer: (ReturnType<typeof setTimeout> & { unref?: () => void }) | null;
  lastTake: number;
  failures: number;
}

export interface CaptchaTokenPoolStats {
  lanes: number;
  ready: number;
  inFlight: number;
  fills: number;
  takes: number;
  failures: number;
  expired: number;
}

function numberOption(value: number | undefined, fallback: number, min: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min ? value : fallback;
}

export class CaptchaTokenPool {
  private readonly mint: MintPooledCaptcha;
  private readonly size: number;
  private readonly refillMs: number;
  private readonly idleMs: number;
  private readonly minFreshMs: number;
  private readonly backoffMinMs: number;
  private readonly backoffMaxMs: number;
  private readonly states = new Map<string, LaneState>();
  private closed = false;
  private fills = 0;
  private takes = 0;
  private failures = 0;
  private expired = 0;

  constructor(mint: MintPooledCaptcha, options: CaptchaTokenPoolOptions = {}) {
    this.mint = mint;
    this.size = Math.floor(numberOption(options.size, 1, 1));
    this.refillMs = numberOption(options.refillMs, 15_000, 1);
    this.idleMs = numberOption(options.idleMs, 300_000, 50);
    this.minFreshMs = numberOption(options.minFreshMs, 5_000, 0);
    this.backoffMinMs = numberOption(options.backoffMinMs, 5_000, 1);
    this.backoffMaxMs = numberOption(options.backoffMaxMs, 60_000, this.backoffMinMs);
  }

  /** Take a fresh one-shot token. Empty lanes mint on demand; concurrent
   * callers share the same in-flight solve rather than amplifying claims. */
  async take(lane?: string): Promise<PooledCaptcha> {
    if (this.closed) throw new Error("captcha pool closed");
    const key = lane ?? "";
    const state = this.stateFor(key);
    state.lastTake = Date.now(); // demand keeps the lane alive while a solve runs
    let waitedForSolve = false;

    for (;;) {
      if (this.closed) throw new Error("captcha pool closed");
      this.dropExpired(state, key);
      const token = state.tokens.shift();
      if (token) {
        this.takes++;
        state.lastTake = Date.now();
        console.log(
          `[npg] captcha pool${key ? ` lane=${key}` : ""} ${waitedForSolve ? "demand" : "hit"} freshFor=${Math.max(0, token.expireAtMs - state.lastTake)}ms remaining=${state.tokens.length}`,
        );
        this.schedule(state, key, this.refillMs);
        return token;
      }

      // A timer is only a prefetch hint. Real demand never waits for it.
      const pending = state.inFlight ?? this.startFill(state, key, "demand");
      waitedForSolve = true;
      await pending;
    }
  }

  stats(): CaptchaTokenPoolStats {
    let ready = 0;
    let inFlight = 0;
    for (const state of this.states.values()) {
      ready += state.tokens.length;
      if (state.inFlight) inFlight++;
    }
    return {
      lanes: this.states.size,
      ready,
      inFlight,
      fills: this.fills,
      takes: this.takes,
      failures: this.failures,
      expired: this.expired,
    };
  }

  /** Stop timers and discard buffered tokens. An already-running solve cannot
   * be cancelled, but its result is dropped when it settles. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const state of this.states.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      state.tokens = [];
    }
    this.states.clear();
  }

  private stateFor(key: string): LaneState {
    let state = this.states.get(key);
    if (!state) {
      state = { tokens: [], inFlight: null, timer: null, lastTake: Date.now(), failures: 0 };
      this.states.set(key, state);
    }
    return state;
  }

  private isIdle(state: LaneState): boolean {
    return Date.now() - state.lastTake >= this.idleMs;
  }

  private clearTimer(state: LaneState): void {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  }

  private dropExpired(state: LaneState, key: string): void {
    let dropped = 0;
    const now = Date.now();
    while (state.tokens.length > 0 && state.tokens[0]!.expireAtMs - now <= this.minFreshMs) {
      state.tokens.shift();
      dropped++;
    }
    if (dropped > 0) {
      this.expired += dropped;
      console.log(`[npg] captcha pool${key ? ` lane=${key}` : ""} dropped ${dropped} stale token(s)`);
    }
  }

  private startFill(state: LaneState, key: string, reason: "demand" | "refill"): Promise<void> {
    if (state.inFlight) return state.inFlight;
    if (this.closed || this.isIdle(state) && reason === "refill") return Promise.resolve();
    this.clearTimer(state);

    const pending = (async () => {
      const token = await this.mint(key || undefined);
      // A slow demand solve must still serve its waiter, even if it outlives
      // the idle window; only an unsolicited background refill is discarded.
      if (this.closed || reason === "refill" && this.isIdle(state)) return;
      if (token.expireAtMs - Date.now() <= this.minFreshMs) {
        throw new Error("captcha pool: freshly minted token is already stale");
      }
      // One in-flight fill per lane and capacity checks before every fill keep
      // the buffer bounded. A demand waiter consumes it immediately on wakeup.
      if (state.tokens.length < this.size) {
        state.tokens.push(token);
        this.fills++;
      }
    })();

    state.inFlight = pending;
    // Attach both handlers immediately: background failures must never become
    // unhandled rejections, while demand callers still await the original
    // promise and receive the solve error for the gateway's no-pass retry.
    void pending.then(
      () => {
        if (state.inFlight === pending) state.inFlight = null;
        if (this.closed) return;
        state.failures = 0;
        if (reason === "refill") {
          console.log(`[npg] captcha pool${key ? ` lane=${key}` : ""} refill ready=${state.tokens.length}`);
        }
        if (reason === "refill" && this.isIdle(state)) {
          state.tokens = [];
          this.clearTimer(state);
          return;
        }
        if (state.tokens.length < this.size) {
          this.schedule(state, key, this.refillMs);
        } else {
          const untilStale = state.tokens[0]!.expireAtMs - this.minFreshMs - Date.now();
          this.schedule(state, key, untilStale);
        }
      },
      (err) => {
        if (state.inFlight === pending) state.inFlight = null;
        state.failures++;
        this.failures++;
        if (this.closed) return;
        const backoff = Math.min(this.backoffMaxMs, this.backoffMinMs * 2 ** (state.failures - 1));
        if (reason === "refill") {
          console.error(
            `[npg] captcha pool${key ? ` lane=${key}` : ""} refill failed (${state.failures} consecutive), retry in ${backoff}ms: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        this.schedule(state, key, backoff);
      },
    );
    return pending;
  }

  private schedule(state: LaneState, key: string, delayMs: number): void {
    this.clearTimer(state);
    if (this.closed) return;
    if (this.isIdle(state)) {
      state.tokens = [];
      return;
    }
    // The same timer handles refill, stale replacement, backoff and idle stop.
    const untilIdle = state.lastTake + this.idleMs - Date.now();
    const delay = Math.max(1, Math.min(delayMs, untilIdle));
    const timer = setTimeout(() => {
      state.timer = null;
      if (this.closed) return;
      if (this.isIdle(state)) {
        state.tokens = [];
        return;
      }
      this.dropExpired(state, key);
      if (state.tokens.length < this.size) {
        void this.startFill(state, key, "refill");
      } else {
        this.schedule(state, key, state.tokens[0]!.expireAtMs - this.minFreshMs - Date.now());
      }
    }, delay) as ReturnType<typeof setTimeout> & { unref?: () => void };
    timer.unref?.(); // prefetch must never keep the Node process alive
    state.timer = timer;
  }
}
