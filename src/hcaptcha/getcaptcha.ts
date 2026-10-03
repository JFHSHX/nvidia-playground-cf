// src/hcaptcha/getcaptcha.ts — TS port of internal/hcaptcha/getcaptcha.go
// (reference/go/getcaptcha.go): submitting the solved hsw proof-of-work and
// extracting the P1_ passcode.
//
// Pipeline: checksiteconfig hands a PoW JWT, the fingerprint + hsw solve
// produce n, and getcaptcha turns (n, c) into the passcode that
// build.nvidia.com accepts as nv-captcha-token. When checksiteconfig reports
// features.enc_get_req, submissions must be wasm-encrypted: the hsw bundle's
// window.hsw(1|0, bytes) modes encrypt/decrypt with a key embedded in its
// WASM, and the wire body is msgpack([<c spec JSON>, ext18(cipher)]) sent as
// application/octet-stream.
//
// Reconstructed (the reference tail was cut by the fetch bridge):
// minimalMotionData, locationVersion, clipBytes, CaptchaToken — rebuilt from
// the doc comments and test assertions; CaptchaTokenDetail is not ported.
// All solver/network phases are async (TS), unlike the Go sync http client.
import { parsePow } from "./pow";
import { buildFingerprint } from "./fingerprint";
import { solveN as solveNWorkerd, cryptoMode as cryptoModeWorkerd, locationFromJWT, HSW_UA } from "./runner";
import { msgpackDecode, msgpackEncodeMapString, msgpackEncodeWire } from "./msgpack";

/** Solver override: a Node host (src/node-host) injects its own vm-based
 * runner at startup; when unset the workerd Worker Loader path is used. */
let solveOverride: {
  solveN(location: string, jwt: string, fpB64: string): Promise<string>;
  cryptoMode(location: string, mode: number, data: Uint8Array): Promise<Uint8Array>;
} | null = null;

/** setSolveOverride routes all solver calls to the given implementation
 * (used by the Node host; must be called before any solve starts). */
export function setSolveOverride(o: NonNullable<typeof solveOverride>): void {
  solveOverride = o;
}

function solveN(location: string, jwt: string, fpB64: string): Promise<string> {
  return solveOverride ? solveOverride.solveN(location, jwt, fpB64) : solveNWorkerd(location, jwt, fpB64);
}

function cryptoMode(location: string, mode: number, data: Uint8Array): Promise<Uint8Array> {
  return solveOverride ? solveOverride.cryptoMode(location, mode, data) : cryptoModeWorkerd(location, mode, data);
}

/** The hCaptcha endpoint that issues challenges and, given a solved challenge,
 * a passcode (getcaptcha.go:34). */
export const GETCAPTCHA_ENDPOINT = "https://api.hcaptcha.com/getcaptcha";

/** Current hCaptcha challenge-frontend build id (getcaptcha.go:41). */
export const GETCAPTCHA_VERSION = "fb397a861c3c93968ee7c496f82ce990e67c959e";
/** Older widget build id kept as a compatibility probe (getcaptcha.go:45). */
export const LEGACY_CAPTCHA_VERSION = "540c361";

const GETCAPTCHA_BODY_LIMIT = 1 << 20;
const GETCAPTCHA_ERROR_CLIP = 800;

/** Matches the browser headers hCaptcha's asset frontend sends
 * (getcaptcha.go:56). */
const GETCAPTCHA_UA = HSW_UA;

/** Matches an hCaptcha passcode anywhere in raw text (getcaptcha.go:71). */
const reP1Token = /P1_[A-Za-z0-9._~-]{20,}/;

/** Describes the solved challenge that getcaptcha variants are built from
 * (getcaptcha.go:76-83 SolveInfo). */
export interface SolveInfo {
  jwt: string;
  location: string;
  key: string; // checksiteconfig c.key, "" on legacy responses
  fingerprint: string; // base64 fingerprint
  n: string; // solved proof-of-work
  elapsedMs: number;
}

/** Records one getcaptcha parameter-variant attempt (getcaptcha.go:88-96). */
export interface CaptchaAttempt {
  name: string;
  params: Record<string, string>;
  status: number; // HTTP status; 0 when the transport failed
  body: Uint8Array | null; // raw response body
  err: string; // transport/failure message, "" when none
  elapsedMs: number;
  token: string; // P1_ passcode found in body, "" if none
}

function clipBytes(body: Uint8Array | null): string {
  if (!body || body.length === 0) return "";
  const s = new TextDecoder().decode(body.slice(0, GETCAPTCHA_ERROR_CLIP));
  return body.length > GETCAPTCHA_ERROR_CLIP ? s + `...(${body.length} bytes)` : s;
}

function encodeUtf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** walkToken recursively finds the first P1_ string value in a decoded JSON
 * document (getcaptcha.go:130-150). */
function walkToken(v: unknown): string {
  if (typeof v === "string") {
    return v.startsWith("P1_") && v.length >= 20 ? v : "";
  }
  if (Array.isArray(v)) {
    for (const e of v) {
      const s = walkToken(e);
      if (s) return s;
    }
    return "";
  }
  if (v !== null && typeof v === "object") {
    for (const e of Object.values(v as Record<string, unknown>)) {
      const s = walkToken(e);
      if (s) return s;
    }
  }
  return "";
}

/** FindP1Token scans a getcaptcha response body for an hCaptcha passcode:
 * the whole body is walked for P1_ string values first and then matched as
 * raw text (getcaptcha.go:115-126). */
export function findP1Token(body: Uint8Array | null): string {
  if (!body || body.length === 0) return "";
  const text = new TextDecoder().decode(body);
  try {
    const doc = JSON.parse(text) as unknown;
    const tok = walkToken(doc);
    if (tok) return tok;
  } catch {
    /* fall through to raw regex */
  }
  return reP1Token.exec(text)?.[0] ?? "";
}

/** specFromClaim extracts the challenge spec from a getcaptcha (or
 * checksiteconfig) claim response and returns it as the JSON string the
 * submission's c parameter must carry, plus the challenge jwt inside it
 * (getcaptcha.go:575-593). */
export function specFromClaim(body: Uint8Array | null): [spec: string, jwt: string] {
  let doc: { c?: { type?: string; req?: string } | null };
  try {
    doc = JSON.parse(new TextDecoder().decode(body ?? new Uint8Array(0))) as typeof doc;
  } catch (e) {
    throw new Error(`decode claim: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!doc.c || !doc.c.req) {
    throw new Error(`no challenge in claim: ${clipBytes(body)}`);
  }
  return [JSON.stringify(doc.c), doc.c.req];
}

/** mustJSONString quotes s as a JSON string value (getcaptcha.go:609-615). */
function mustJSONString(s: string): string {
  return JSON.stringify(s);
}

/** specJSON renders the challenge spec getcaptcha expects in its "c"
 * parameter (getcaptcha.go:604-606). */
function specJSON(solve: SolveInfo): string {
  return `{"type":"hsw","req":${mustJSONString(solve.jwt)}}`;
}

/** minimalMotionData returns a structurally plausible motionData blob
 * (RECONSTRUCTED — the reference body was cut by the fetch bridge; real
 * widgets send their obfuscated motion VM's output, this static stand-in only
 * makes the variant's shape plausible). */
function minimalMotionData(): string {
  const t = Date.now();
  return JSON.stringify({
    v: 1,
    topLevel: {
      st: t,
      sc: { availWidth: 1280, availHeight: 860, width: 1280, height: 900, colorDepth: 24, pixelDepth: 24 },
      sr: 2,
      mm: [],
      md: [],
      mu: null,
    },
    session: [],
    widget: [],
  });
}

/** locationVersion derives a "v" build id from the hsw bundle location
 * (RECONSTRUCTED): the bare bundle id (older short hex ids like "540c361")
 * or the location's first path segment; falls back to the current frontend
 * build id. */
function locationVersion(location: string): string {
  const loc = location.replace(/\/$/, "").replace(/^\/c\//, "");
  const short = loc.split("/")[0] ?? "";
  return short || GETCAPTCHA_VERSION;
}

/** gcVariant is one getcaptcha parameter variant (getcaptcha.go:596-599). */
interface GcVariant {
  name: string;
  params: Record<string, string>;
}

/** gcParams merges maps into a fresh param map (getcaptcha.go:645-653). */
function gcParams(...parts: Array<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of parts) {
    for (const k of Object.keys(p)) out[k] = p[k]!;
  }
  return out;
}

/** getCaptchaVariants builds the ordered getcaptcha parameter variants for a
 * solved challenge: phase-A bare claim, c as raw JWT vs spec JSON, current vs
 * legacy client builds, a motionData submission and a location-versioned
 * legacy-flags variant (getcaptcha.go:622-642). */
function getCaptchaVariants(sitekey: string, host: string, solve: SolveInfo): GcVariant[] {
  const base = { v: GETCAPTCHA_VERSION, sitekey, host, hl: "en" };
  const sub = gcParams(base, { n: solve.n });
  const vs: GcVariant[] = [
    { name: "phaseA-bare", params: base },
    { name: "build c=jwt", params: gcParams(sub, { c: solve.jwt }) },
    { name: "build c=spec", params: gcParams(sub, { c: specJSON(solve) }) },
    { name: "legacy v c=spec", params: gcParams(sub, { v: LEGACY_CAPTCHA_VERSION, c: specJSON(solve) }) },
    { name: "build c=spec motion", params: gcParams(sub, { c: specJSON(solve), motionData: minimalMotionData() }) },
    { name: "locv c=spec legacy-flags", params: gcParams(sub, { v: locationVersion(solve.location), c: specJSON(solve), sc: "true", swa: "0", spst: "0" }) },
  ];
  if (solve.key !== "") {
    vs.push({ name: "build c=key", params: gcParams(sub, { c: solve.key }) });
  }
  return vs;
}

// --- HTTP (getcaptcha.go:167-259) ---

interface GcHttpResult {
  status: number; // 0 when no full HTTP response was received
  body: Uint8Array | null;
  err: string; // "" when none
}

function postGetCaptchaBody(sitekey: string, body: Uint8Array | string, contentType: string, label: string): Promise<GcHttpResult> {
  let endpoint = GETCAPTCHA_ENDPOINT;
  if (sitekey !== "") {
    endpoint = GETCAPTCHA_ENDPOINT.replace(/\/$/, "") + "/" + sitekey;
  }
  return (async (): Promise<GcHttpResult> => {
    let resp: Response;
    try {
      resp = await fetch(endpoint, {
        method: "POST",
        body,
        headers: {
          "Content-Type": contentType,
          Accept: "application/json, application/octet-stream",
          "User-Agent": GETCAPTCHA_UA,
          Origin: "https://newassets.hcaptcha.com",
          Referer: "https://newassets.hcaptcha.com/",
        },
      });
    } catch (e) {
      return { status: 0, body: null, err: `hcaptcha: getcaptcha (${label}): ${e instanceof Error ? e.message : String(e)}` };
    }
    try {
      const buf = new Uint8Array(await resp.arrayBuffer());
      return { status: resp.status, body: buf.length > GETCAPTCHA_BODY_LIMIT ? buf.slice(0, GETCAPTCHA_BODY_LIMIT) : buf, err: "" };
    } catch (e) {
      return { status: resp.status, body: null, err: `hcaptcha: getcaptcha (${label}): read body: ${e instanceof Error ? e.message : String(e)}` };
    }
  })();
}

/** PostGetCaptcha POSTs params to the hCaptcha getcaptcha endpoint: JSON body
 * first; on transport failure or non-2xx it retries with an
 * x-www-form-urlencoded body (getcaptcha.go:182-198). The returned
 * status/body belong to the last attempt; err is non-empty only when every
 * attempt failed before producing a full HTTP response. */
export async function postGetCaptcha(params: Record<string, string>): Promise<GcHttpResult> {
  const jsonBody = encodeUtf8(JSON.stringify(params));
  let res = await postGetCaptchaBody(params["sitekey"] ?? "", jsonBody, "application/json", "application/json");
  if (res.err === "" && res.status >= 200 && res.status < 300) return res;
  const jsonSummary = res.err !== "" ? res.err : `status=${res.status} body=${clipBytes(res.body)}`;
  const form = new URLSearchParams(params).toString();
  res = await postGetCaptchaBody(params["sitekey"] ?? "", form, "application/x-www-form-urlencoded", "x-www-form-urlencoded");
  if (res.err !== "") {
    return { status: 0, body: null, err: `hcaptcha: getcaptcha: json (${jsonSummary}); form: ${res.err}` };
  }
  return res;
}

/** fetchChecksite fetches checksiteconfig and returns the challenge jwt, the
 * hsw bundle location, the challenge key and whether the site declares
 * features.enc_get_req (getcaptcha.go:271-310). */
export async function fetchChecksite(sitekey: string, host: string): Promise<[jwt: string, location: string, key: string, encGetReq: boolean]> {
  const u = `https://api.hcaptcha.com/checksiteconfig?host=${encodeURIComponent(host)}&sitekey=${encodeURIComponent(sitekey)}&sc=1&swa=0&spst=0&hl=en`;
  let resp: Response;
  try {
    resp = await fetch(u, { headers: { "User-Agent": GETCAPTCHA_UA } });
  } catch (e) {
    throw new Error(`checksiteconfig: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (resp.status !== 200) {
    throw new Error(`checksiteconfig: HTTP ${resp.status}`);
  }
  let out: {
    c?: { type?: string; req?: string; key?: string; jwt?: string } | null;
    l?: string;
    pass?: boolean;
    features?: { enc_get_req?: boolean } | null;
  };
  try {
    out = JSON.parse(new TextDecoder().decode(new Uint8Array(await resp.arrayBuffer()).slice(0, GETCAPTCHA_BODY_LIMIT))) as typeof out;
  } catch (e) {
    throw new Error(`checksiteconfig decode: ${e instanceof Error ? e.message : String(e)}`);
  }
  let jwt = out.c?.req ?? "";
  if (jwt === "") jwt = out.c?.jwt ?? "";
  let key = out.c?.key ?? "";
  if (jwt === "" && key.includes(".")) {
    jwt = key; // legacy body where c.key carried the jwt itself
    key = "";
  }
  if (jwt === "") {
    throw new Error("checksiteconfig: no challenge jwt in response");
  }
  let location = out.l ?? "";
  if (location === "") {
    location = locationFromJWT(jwt);
  }
  return [jwt, location, key, out.features?.enc_get_req ?? false];
}

// --- pipeline (getcaptcha.go:344-437 CaptchaAttempts + 449-557) ---

/** CaptchaAttempts solves the hCaptcha challenge for sitekey/host and submits
 * it to getcaptcha, returning the raw per-attempt results. Both routes share
 * a speculative phase-A claim fired at t=0, concurrent with checksiteconfig.
 * - features.enc_get_req (encrypted-only site): skip the challenge solve and
 *   the plaintext variants, submit the speculatively claimed challenge over
 *   the wasm-encrypted wire.
 * - otherwise: solve the challenge and try the plaintext variants in order,
 *   stopping at the first P1_ passcode, then fall back to a freshly claimed
 *   encrypted submission.
 * Throws (stage-prefixed) on the fatal stages; variant failures are
 * recorded in the attempts. */
export async function captchaAttempts(sitekey: string, host: string): Promise<[solve: SolveInfo, attempts: CaptchaAttempt[]]> {
  const start = Date.now();

  // Speculative phase-A claim, concurrent with checksiteconfig
  // (getcaptcha.go:347-357 — started immediately, joined below).
  const claimP: Promise<GcHttpResult> = postGetCaptcha({ v: GETCAPTCHA_VERSION, sitekey, host, hl: "en" });

  let jwt: string, location: string, key: string, encGetReq: boolean;
  try {
    [jwt, location, key, encGetReq] = await fetchChecksite(sitekey, host);
  } catch (e) {
    await claimP.catch(() => null); // join the speculative claim before returning
    throw new Error(`hcaptcha: getcaptcha: fetch challenge: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (encGetReq) {
    // Encrypted-only fast path: adopt the speculative claim (or claim fresh
    // if it failed) and skip the plaintext variants (getcaptcha.go:365-376).
    const claim = await claimP;
    const pclaim: GcHttpResult | null = claim.err === "" ? claim : null;
    const [at, info] = await runEncryptedAttempt(sitekey, host, pclaim);
    info.elapsedMs = Date.now() - start;
    return [info, [at]];
  }

  // Legacy route: discard the speculative claim and solve the challenge for
  // the plaintext variants (getcaptcha.go:380).
  await claimP;

  let pow;
  try {
    pow = parsePow(jwt);
  } catch (e) {
    throw new Error(`hcaptcha: getcaptcha: parse pow: ${e instanceof Error ? e.message : String(e)}`);
  }
  let fpB64: string;
  try {
    fpB64 = buildFingerprint(pow);
  } catch (e) {
    throw new Error(`hcaptcha: getcaptcha: build fingerprint: ${e instanceof Error ? e.message : String(e)}`);
  }
  let n: string;
  try {
    n = await solveN(location, jwt, fpB64);
  } catch (e) {
    throw new Error(`hcaptcha: getcaptcha: solve: ${e instanceof Error ? e.message : String(e)}`);
  }
  const solve: SolveInfo = { jwt, location, key, fingerprint: fpB64, n, elapsedMs: Date.now() - start };

  const attempts: CaptchaAttempt[] = [];
  const variants = getCaptchaVariants(sitekey, host, solve);
  for (let i = 0; i < variants.length; i++) {
    const t0 = Date.now();
    const res = await postGetCaptcha(variants[i]!.params);
    const at: CaptchaAttempt = {
      name: `${i + 1}-${variants[i]!.name}`,
      params: variants[i]!.params,
      status: res.status,
      body: res.body,
      err: res.err,
      elapsedMs: Date.now() - t0,
      token: findP1Token(res.body),
    };
    attempts.push(at);
    if (at.token !== "") return [solve, attempts];
  }

  // Encrypted fallback on a fresh claim (getcaptcha.go:434-436).
  const [at] = await runEncryptedAttempt(sitekey, host, null);
  attempts.push(at);
  return [solve, attempts];
}

/** runEncryptedAttempt performs the widget-faithful encrypted getcaptcha
 * submission: phase-A claim (given, or fresh when null), solve the claimed
 * jwt, encrypt the params and submit the [spec, ext18(cipher)] wire
 * (getcaptcha.go:449-557). Never throws — failures are carried on the
 * attempt. */
async function runEncryptedAttempt(sitekey: string, host: string, claim: GcHttpResult | null): Promise<[at: CaptchaAttempt, info: SolveInfo]> {
  const params = { v: GETCAPTCHA_VERSION, sitekey, host, hl: "en" };
  const info: SolveInfo = { jwt: "", location: "", key: "", fingerprint: "", n: "", elapsedMs: 0 };
  const t0 = Date.now();
  const at: CaptchaAttempt = { name: "encrypted-claim", params, status: 0, body: null, err: "", elapsedMs: 0, token: "" };

  // Phase A: claim a challenge from getcaptcha (n absent), like the widget.
  let status = 0;
  let claimBody: Uint8Array | null = null;
  if (claim !== null) {
    status = claim.status;
    claimBody = claim.body;
    if (claim.err !== "") {
      at.status = status;
      at.body = claimBody;
      at.err = `hcaptcha: getcaptcha: claim: ${claim.err}`;
      at.elapsedMs = Date.now() - t0;
      return [at, info];
    }
  } else {
    const res = await postGetCaptcha(params);
    status = res.status;
    claimBody = res.body;
    if (res.err !== "") {
      at.status = status;
      at.body = claimBody;
      at.err = `hcaptcha: getcaptcha: claim: ${res.err}`;
      at.elapsedMs = Date.now() - t0;
      return [at, info];
    }
  }
  at.status = status;
  at.body = claimBody;

  let spec: string, jwt: string;
  try {
    [spec, jwt] = specFromClaim(claimBody);
  } catch (e) {
    at.err = `hcaptcha: getcaptcha: claim: ${e instanceof Error ? e.message : String(e)}`;
    at.elapsedMs = Date.now() - t0;
    return [at, info];
  }
  info.jwt = jwt;

  // Solve the claimed challenge; the solver is keyed by the claimed JWT's own
  // bundle location (getcaptcha.go:480-506).
  let location: string;
  try {
    location = locationFromJWT(jwt);
  } catch (e) {
    at.err = `hcaptcha: getcaptcha: claim location: ${e instanceof Error ? e.message : String(e)}`;
    at.elapsedMs = Date.now() - t0;
    return [at, info];
  }
  info.location = location;

  let pow;
  try {
    pow = parsePow(jwt);
  } catch (e) {
    at.err = `hcaptcha: getcaptcha: parse claimed pow: ${e instanceof Error ? e.message : String(e)}`;
    at.elapsedMs = Date.now() - t0;
    return [at, info];
  }
  let fpB64: string;
  try {
    fpB64 = buildFingerprint(pow);
  } catch (e) {
    at.err = `hcaptcha: getcaptcha: build claimed fingerprint: ${e instanceof Error ? e.message : String(e)}`;
    at.elapsedMs = Date.now() - t0;
    return [at, info];
  }
  info.fingerprint = fpB64;
  let n: string;
  try {
    n = await solveN(location, jwt, fpB64);
  } catch (e) {
    at.err = `hcaptcha: getcaptcha: solve claimed challenge: ${e instanceof Error ? e.message : String(e)}`;
    at.elapsedMs = Date.now() - t0;
    return [at, info];
  }
  info.n = n;

  // Encrypt the params and submit the msgpack [c-spec, ext18(cipher)] wire as
  // application/octet-stream (getcaptcha.go:509-529).
  const sub = gcParams(params, { n });
  at.params = sub;
  let plain: Uint8Array, cipher: Uint8Array;
  try {
    plain = msgpackEncodeMapString(sub);
    cipher = await cryptoMode(location, 1, plain);
  } catch (e) {
    at.err = `hcaptcha: getcaptcha: encrypt: ${e instanceof Error ? e.message : String(e)}`;
    at.elapsedMs = Date.now() - t0;
    return [at, info];
  }
  const wire = msgpackEncodeWire(spec, cipher);
  const res = await postGetCaptchaBody(sitekey, wire, "application/octet-stream", "octet-stream");
  at.status = res.status;
  at.body = res.body;
  if (res.err !== "") {
    at.err = `hcaptcha: getcaptcha: ${res.err}`;
    at.elapsedMs = Date.now() - t0;
    return [at, info];
  }
  at.token = findP1Token(res.body);
  if (at.token !== "" || res.status !== 200) {
    at.elapsedMs = Date.now() - t0;
    return [at, info];
  }
  // A 200 answer to an encrypted submission is the wasm-encrypted response;
  // decrypt (mode 0) and msgpack-decode before scanning for a passcode
  // (getcaptcha.go:531-556).
  let dec: Uint8Array;
  try {
    dec = await cryptoMode(location, 0, res.body!);
  } catch (e) {
    at.err = `hcaptcha: getcaptcha: decrypt: ${e instanceof Error ? e.message : String(e)}`;
    at.elapsedMs = Date.now() - t0;
    return [at, info];
  }
  let msg: unknown, rest: Uint8Array;
  try {
    [msg, rest] = msgpackDecode(dec);
  } catch (e) {
    at.err = `hcaptcha: getcaptcha: decode response: ${e instanceof Error ? e.message : String(e)}`;
    at.elapsedMs = Date.now() - t0;
    return [at, info];
  }
  if (rest.length > 0) {
    at.err = `hcaptcha: getcaptcha: decode response: ${rest.length} trailing bytes`;
    at.elapsedMs = Date.now() - t0;
    return [at, info];
  }
  const j = JSON.stringify(msg);
  at.token = findP1Token(encodeUtf8(j));
  if (at.token === "") {
    at.err = `hcaptcha: getcaptcha: encrypted response carries no passcode: ${clipBytes(encodeUtf8(j))}`;
  }
  at.elapsedMs = Date.now() - t0;
  return [at, info];
}

/** CaptchaToken solves the challenge and returns the first P1_ passcode
 * (RECONSTRUCTED from captcha-pow.go's PowExtract contract: each call
 * performs a full solve and returns a fresh one-shot token). */
export async function captchaToken(sitekey: string, host: string): Promise<string> {
  const [, attempts] = await captchaAttempts(sitekey, host);
  for (const at of attempts) {
    if (at.token !== "") return at.token;
  }
  throw new Error(`hcaptcha: no passcode in ${attempts.length} attempts`);
}
