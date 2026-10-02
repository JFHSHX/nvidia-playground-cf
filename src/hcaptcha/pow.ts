// src/hcaptcha/pow.ts — TS port of internal/hcaptchapow (reference/go/pow.go,
// rand.go, stamp.go, xxhash.go): PoW JWT parsing, hashcash stamp minting,
// CRC-32 rand computation and XXH64 hashing. Zero runtime dependencies.
//
// DIFFICULTY SEMANTICS (critical): the JWT claim "s" counts HALF-bits. The
// hashcash stamp must satisfy s*2 leading-zero bits of SHA-1(stamp) (first 8
// bytes read as a big-endian u64; stamp.go:24-25, fingerprint.go:43-45 which
// calls MintStamp(uint(pow.Difficulty*2), pow.PowData) unconditionally per
// solve). The captured real JWT (reference/go/pow_test.go:10-13) has s=16 ->
// 32 bits -> ~2^32 attempts expected — minutes of single-threaded JS. The
// challenge's own c=1000 (timeout ms) suggests hCaptcha normally serves much
// smaller s; mintStamp therefore enforces a wall-clock budget and throws
// PowBudgetExceeded instead of burning CPU past it.
//
// Go searches concurrently across all cores when stampBits > 10
// (stamp.go:64-79); workerd gives one core, so this port is always
// single-threaded with a deterministic sequential counter from 0.

/** Decoded payload of an hCaptcha PoW JWT (challenge type "w"). Mirrors
 * pow.go:15-25. */
export interface Pow {
  fingerprintType: number; // claim f
  difficulty: number; // claim s (half-bits)
  type: string; // claim t ("w")
  powData: string; // claim d
  location: string; // claim l
  signature: string; // claim i
  timestamp: number; // claim e (issued-at)
  n: string; // claim n ("hsw")
  timeout: number; // claim c (ms)
}

export interface MintStampOptions {
  /** Wall-clock budget for the search, ms (default 10000; Infinity disables). */
  budgetMs?: number;
  /** Override the timestamp (tests). */
  now?: Date;
  /** Override the salt (tests). */
  salt?: string;
}

/** Thrown when the stamp search exceeds its wall-clock budget. */
export class PowBudgetExceeded extends Error {
  stampBits: number;
  budgetMs: number;
  attempts: number;
  constructor(stampBits: number, budgetMs: number, attempts: number) {
    super(`hcaptchapow: stamp search exceeded ${budgetMs}ms budget (${stampBits} bits, ${attempts} attempts)`);
    this.name = "PowBudgetExceeded";
    this.stampBits = stampBits;
    this.budgetMs = budgetMs;
    this.attempts = attempts;
  }
}

export const DEFAULT_STAMP_BUDGET_MS = 10_000;
const STAMP_VERSION = "1";
const STAMP_SALT_LENGTH = 8;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

// ---------------------------------------------------------------------------
// ParsePow (pow.go:27-80)
// ---------------------------------------------------------------------------

function numClaim(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0; // null / missing -> Go zero value
}

function strClaim(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** base64url-decode one JWT segment: raw encoding standard, padded accepted
 * (pow.go:50-58 normalize to standard alphabet and let atob handle both). */
function b64urlDecode(seg: string): Uint8Array {
  const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** ParsePow decodes the payload of an hCaptcha PoW JWT
 * (header.payload.signature, base64url payload) and validates required
 * claims: non-empty t, d, l, i, n and non-zero s, e, c. Signature is NOT
 * verified. Throws Error on malformed tokens. */
export function parsePow(token: string): Pow {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("hcaptchapow: pow jwt must have three dot-separated parts");
  }
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(TEXT_DECODER.decode(b64urlDecode(parts[1]))) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`hcaptchapow: decode pow jwt payload: ${e instanceof Error ? e.message : String(e)}`);
  }
  const p: Pow = {
    fingerprintType: numClaim(claims["f"]),
    difficulty: numClaim(claims["s"]),
    type: strClaim(claims["t"]),
    powData: strClaim(claims["d"]),
    location: strClaim(claims["l"]),
    signature: strClaim(claims["i"]),
    timestamp: numClaim(claims["e"]),
    n: strClaim(claims["n"]),
    timeout: numClaim(claims["c"]),
  };
  if (p.type === "") throw new Error("hcaptchapow: pow jwt missing claim t");
  if (p.powData === "") throw new Error("hcaptchapow: pow jwt missing claim d");
  if (p.location === "") throw new Error("hcaptchapow: pow jwt missing claim l");
  if (p.signature === "") throw new Error("hcaptchapow: pow jwt missing claim i");
  if (p.n === "") throw new Error("hcaptchapow: pow jwt missing claim n");
  if (p.difficulty === 0) throw new Error("hcaptchapow: pow jwt missing or zero claim s");
  if (p.timestamp === 0) throw new Error("hcaptchapow: pow jwt missing or zero claim e");
  if (p.timeout === 0) throw new Error("hcaptchapow: pow jwt missing or zero claim c");
  return p;
}

// ---------------------------------------------------------------------------
// RandHash (rand.go) — CRC-32 IEEE scaled by 2^-32
// ---------------------------------------------------------------------------

/** CRC-32 table: bit-reversed hCaptcha polynomial 79764919 = 0x04C11DB7,
 * reversed to 0xEDB88320 (canonical IEEE, identical to
 * crc32.MakeTable(crc32.IEEE)). */
const RAND_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** 2^-32, the multiplier turning the CRC-32 into a float in [0, 1). */
const RAND_SCALE = 2.3283064365386963e-10;

/** RandHash computes the hCaptcha fingerprint rand value: the CRC-32 (IEEE)
 * of the payload (with the "rand" entry removed) scaled by 2^-32. */
export function randHash(input: Uint8Array): { crc: number; randVal: number } {
  let crc = -1;
  for (let i = 0; i < input.length; i++) {
    crc = (RAND_TABLE[(crc ^ input[i]) & 0xff]! ^ (crc >>> 8)) | 0;
  }
  const u = (crc ^ -1) >>> 0;
  return { crc: u, randVal: u * RAND_SCALE };
}

// ---------------------------------------------------------------------------
// XXH64 (xxhash.go) — BigInt 64-bit arithmetic (called a few times per solve,
// not in the hot loop, so BigInt cost is negligible)
// ---------------------------------------------------------------------------

const P1 = 0x9e3779b185ebca87n;
const P2 = 0xc2b2ae3d27d4eb4fn;
const P3 = 0x165667b19e3779f9n;
const P4 = 0x85ebca77c2b2ae63n;
const P5 = 0x27d4eb2f165667c5n;
const M64 = 0xffffffffffffffffn;

/** Seed used by hCaptcha for fingerprint component hashes
 * (web_gl_hash, canvas_hash, ...). */
export const XXH_SEED = 5575352424011909552n;

function rotl64(x: bigint, n: number): bigint {
  return ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64;
}

function xxhRound(acc: bigint, input: bigint): bigint {
  acc = (acc + input * P2) & M64;
  acc = rotl64(acc, 31);
  return (acc * P1) & M64;
}

function xxhMerge(acc: bigint, val: bigint): bigint {
  acc ^= xxhRound(0n, val);
  return (acc * P1 + P4) & M64;
}

function xxhFinalize(h: bigint, length: bigint, dv: DataView, p: number): bigint {
  h = (h + length) & M64;
  while (p + 8 <= dv.byteLength) {
    h ^= xxhRound(0n, dv.getBigUint64(p, true));
    h = (rotl64(h, 27) * P1 + P4) & M64;
    p += 8;
  }
  if (p + 4 <= dv.byteLength) {
    h ^= BigInt(dv.getUint32(p, true)) * P1;
    h = (rotl64(h, 23) * P2 + P3) & M64;
    p += 4;
  }
  while (p < dv.byteLength) {
    h ^= BigInt(dv.getUint8(p)) * P5;
    h = (rotl64(h, 11) * P1) & M64;
    p += 1;
  }
  h ^= h >> 33n;
  h = (h * P2) & M64;
  h ^= h >> 29n;
  h = (h * P3) & M64;
  h ^= h >> 32n;
  return h & M64;
}

/** XXH64 (64-bit variant), little-endian input, for the given seed. */
export function xxh64(data: Uint8Array, seed: bigint): bigint {
  const length = BigInt(data.length);
  if (data.length >= 32) {
    let v1 = (seed + P1 + P2) & M64;
    let v2 = (seed + P2) & M64;
    let v3 = seed & M64;
    let v4 = (seed - P1) & M64;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let p = 0;
    const rounds = Math.floor(data.length / 32);
    for (let i = 0; i < rounds; i++) {
      v1 = xxhRound(v1, dv.getBigUint64(p, true));
      v2 = xxhRound(v2, dv.getBigUint64(p + 8, true));
      v3 = xxhRound(v3, dv.getBigUint64(p + 16, true));
      v4 = xxhRound(v4, dv.getBigUint64(p + 24, true));
      p += 32;
    }
    let h = (rotl64(v1, 1) + rotl64(v2, 7) + rotl64(v3, 12) + rotl64(v4, 18)) & M64;
    h = xxhMerge(h, v1);
    h = xxhMerge(h, v2);
    h = xxhMerge(h, v3);
    h = xxhMerge(h, v4);
    return xxhFinalize(h, length, dv, p);
  }
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return xxhFinalize((seed + P5) & M64, length, dv, 0);
}

/** HashString: the decimal string used inside fingerprint JSON, hashing
 * content with XXH_SEED (xxhash.go:22-26). */
export function hashString(content: string | Uint8Array): string {
  const bytes = typeof content === "string" ? TEXT_ENCODER.encode(content) : content;
  return xxh64(bytes, XXH_SEED).toString(10);
}

// ---------------------------------------------------------------------------
// SHA-1 (sync) + hashcash stamp (stamp.go)
// ---------------------------------------------------------------------------

const SHA1_K = [0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xca62c1d6];

/** Synchronous SHA-1 (FIPS 180-1) over a Uint8Array, returned as 20 bytes.
 * 32-bit int ops; stamp messages are tiny so the padded buffer is one or two
 * 64-byte blocks. */
export function sha1(msg: Uint8Array): Uint8Array {
  let h0 = 0x67452301 | 0;
  let h1 = 0xefcdab89 | 0;
  let h2 = 0x98badcfe | 0;
  let h3 = 0x10325476 | 0;
  let h4 = 0xc3d2e1f0 | 0;
  const len = msg.length;
  const bitLenHi = Math.floor(len / 0x20000000) >>> 0; // (len*8) >> 32
  const bitLenLo = (len << 3) >>> 0;
  const total = ((len + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, bitLenHi, false);
  dv.setUint32(total - 4, bitLenLo, false);

  const w = new Int32Array(80);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4, false);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!;
      w[i] = ((x << 1) | (x >>> 31)) | 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = SHA1_K[0]!;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = SHA1_K[1]!;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = SHA1_K[2]!;
      } else {
        f = b ^ c ^ d;
        k = SHA1_K[3]!;
      }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + (w[i]! | 0)) | 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) | 0;
      b = a;
      a = temp;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }
  const out = new Uint8Array(20);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, h0 >>> 0, false);
  odv.setUint32(4, h1 >>> 0, false);
  odv.setUint32(8, h2 >>> 0, false);
  odv.setUint32(12, h3 >>> 0, false);
  odv.setUint32(16, h4 >>> 0, false);
  return out;
}

/** Leading zero bits of the first 8 bytes of `digest` read as a big-endian
 * u64 — the hashcash difficulty check (stamp.go:129-135). */
export function leadingZeros64(digest: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < 8; i++) {
    const b = digest[i]!;
    if (b === 0) {
      n += 8;
      continue;
    }
    n += Math.clz32(b) - 24;
    break;
  }
  return n;
}

/** randomSalt: 8 random bytes base64-encoded (StdEncoding alphabet),
 * truncated to the first 8 characters (stamp.go:119-127). */
function randomSalt(): string {
  const raw = new Uint8Array(STAMP_SALT_LENGTH);
  crypto.getRandomValues(raw);
  let bin = "";
  for (let i = 0; i < raw.length; i++) bin += String.fromCharCode(raw[i]!);
  return btoa(bin).slice(0, STAMP_SALT_LENGTH);
}

/** MintStamp mints an hCaptcha hashcash stamp for the given pow data.
 * Layout: `1:<bits/2>:<date>:<powData>::<salt>:<counter>` where bits is the
 * full proof-of-work difficulty (JWT s*2, must be even), date is UTC
 * YYYY-MM-DD, salt is 8 base64 chars and counter is a lowercase hex number.
 * SHA-1(stamp) must have at least `bits` leading zero bits. Mirrors the Go
 * single-threaded fast path (stamp.go:64-79) with a wall-clock budget guard;
 * throws PowBudgetExceeded when the budget elapses. */
export function mintStamp(stampBits: number, powData: string, opts?: MintStampOptions): string {
  if (!Number.isInteger(stampBits) || stampBits < 0 || stampBits % 2 !== 0) {
    throw new Error(`hcaptchapow: stamp bits must be even (JWT difficulty s*2), got ${stampBits}`);
  }
  const budgetMs = opts?.budgetMs ?? DEFAULT_STAMP_BUDGET_MS;
  const salt = opts?.salt !== undefined ? opts.salt : randomSalt();
  const now = opts?.now ?? new Date();
  const date = now.toISOString().slice(0, 10);
  const prefix = `${STAMP_VERSION}:${stampBits / 2}:${date}:${powData}::${salt}:`;
  const prefixBytes = TEXT_ENCODER.encode(prefix);
  const buf = new Uint8Array(prefixBytes.length + 16);
  buf.set(prefixBytes);

  const start = Date.now();
  let counter = 0;
  for (;;) {
    const hex = counter.toString(16);
    const msgLen = prefixBytes.length + hex.length;
    for (let i = 0; i < hex.length; i++) buf[prefixBytes.length + i] = hex.charCodeAt(i);
    if (leadingZeros64(sha1(buf.subarray(0, msgLen))) >= stampBits) {
      return TEXT_DECODER.decode(buf.subarray(0, msgLen));
    }
    counter++;
    if ((counter & 0x3fff) === 0 && Date.now() - start > budgetMs) {
      throw new PowBudgetExceeded(stampBits, budgetMs, counter);
    }
  }
}

/** CheckStamp: whether stamp satisfies `want` leading-zero bits
 * (stamp.go:113-117). */
export function checkStamp(stamp: string, want: number): boolean {
  return leadingZeros64(sha1(TEXT_ENCODER.encode(stamp))) >= want;
}

// ---------------------------------------------------------------------------
// Self-test: known vectors, callable from a probe endpoint at runtime
// ---------------------------------------------------------------------------

/** Verifies SHA-1, CRC-32 and XXH64 against published test vectors plus a
 * real hashcash mint at difficulty s=2 (4 bits). Returns an array of
 * failures (empty = all pass). */
export function powSelfTest(): string[] {
  const failures: string[] = [];
  const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  if (hex(sha1(TEXT_ENCODER.encode("abc"))) !== "a9993e364706816aba3e25717850c26c9cd0d89d") {
    failures.push("sha1(abc)");
  }
  if (randHash(TEXT_ENCODER.encode("123456789")).crc !== 0xcbf43926) {
    failures.push("crc32(123456789)");
  }
  if (xxh64(new Uint8Array(0), 0n) !== 0xef46db3751d8e999n) {
    failures.push("xxh64(empty,0)");
  }
  try {
    const stamp = mintStamp(4, "selftest", { salt: "AAAAAAAA" });
    if (!checkStamp(stamp, 4)) failures.push("mintStamp(4) failed its own check");
    if (!stamp.startsWith("1:2:")) failures.push("mintStamp(4) layout");
  } catch (e) {
    failures.push(`mintStamp(4) threw: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    parsePow("not-a-jwt");
    failures.push("parsePow(one part) accepted");
  } catch {
    /* expected */
  }
  return failures;
}
