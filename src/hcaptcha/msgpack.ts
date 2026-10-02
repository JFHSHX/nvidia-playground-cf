// src/hcaptcha/msgpack.ts — TS port of internal/hcaptcha/msgpack.go
// (reference/go/msgpack.go): minimal msgpack codec for the getcaptcha
// encrypted exchange. The widget wraps getcaptcha submissions as
// msgpack([ <spec JSON string>, ext(18, <wasm-encrypted params>) ]) and the
// server answers with a payload decrypted by the same wasm (hsw mode 0).
// Only the shapes actually exchanged are implemented: maps with string keys,
// strings, arrays, scalars, bin and ext members.

/** The msgpack extension type msgpack-lite uses for Uint8Array/ArrayBuffer
 * values; the hCaptcha wire uses it for the encrypted payload. */
export const MSGPACK_EXT_CRYPTO = 18;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

function hexTag(tag: number): string {
  return "0x" + tag.toString(16).padStart(2, "0");
}

function safeNum(v: bigint): number | bigint {
  return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
}

// ---------------------------------------------------------------------------
// Encoding (msgpack.go:23-80)
// ---------------------------------------------------------------------------

/** msgpackEncodeString: fixstr (<32 bytes), str8, str16 or str32 — lengths in
 * UTF-8 BYTES (Go len(s) semantics). */
export function msgpackEncodeString(s: string): Uint8Array {
  const bytes = TEXT_ENCODER.encode(s);
  const n = bytes.length;
  if (n < 32) {
    const out = new Uint8Array(1 + n);
    out[0] = 0xa0 | n;
    out.set(bytes, 1);
    return out;
  }
  if (n <= 0xff) {
    const out = new Uint8Array(2 + n);
    out[0] = 0xd9;
    out[1] = n;
    out.set(bytes, 2);
    return out;
  }
  if (n <= 0xffff) {
    const out = new Uint8Array(3 + n);
    out[0] = 0xda;
    out[1] = (n >> 8) & 0xff;
    out[2] = n & 0xff;
    out.set(bytes, 3);
    return out;
  }
  const out = new Uint8Array(5 + n);
  out[0] = 0xdb;
  out[1] = (n >>> 24) & 0xff;
  out[2] = (n >> 16) & 0xff;
  out[3] = (n >> 8) & 0xff;
  out[4] = n & 0xff;
  out.set(bytes, 5);
  return out;
}

/** msgpackEncodeMapString encodes a flat string map (the getcaptcha params):
 * fixmap for <16 keys, map16, map32. */
export function msgpackEncodeMapString(m: Record<string, string>): Uint8Array {
  const keys = Object.keys(m);
  const parts: Uint8Array[] = [];
  let bodyLen = 0;
  for (const k of keys) {
    const ek = msgpackEncodeString(k);
    const ev = msgpackEncodeString(m[k]!);
    parts.push(ek, ev);
    bodyLen += ek.length + ev.length;
  }
  const n = keys.length;
  let head: Uint8Array;
  if (n < 16) {
    head = Uint8Array.of(0x80 | n);
  } else if (n <= 0xffff) {
    head = Uint8Array.of(0xde, (n >> 8) & 0xff, n & 0xff);
  } else {
    head = Uint8Array.of(0xdf, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  }
  const out = new Uint8Array(head.length + bodyLen);
  out.set(head, 0);
  let off = head.length;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** msgpackEncodeWire builds [spec, ext18(cipher)] with the exact layout the
 * widget sends (str16 spec followed by ext8/ext16/ext32 type-18 ciphertext). */
export function msgpackEncodeWire(spec: string, cipher: Uint8Array): Uint8Array {
  const specBytes = msgpackEncodeString(spec);
  let extHead: Uint8Array;
  if (cipher.length <= 0xff) {
    extHead = Uint8Array.of(0xc7, cipher.length, MSGPACK_EXT_CRYPTO);
  } else if (cipher.length <= 0xffff) {
    extHead = Uint8Array.of(0xc8, (cipher.length >> 8) & 0xff, cipher.length & 0xff, MSGPACK_EXT_CRYPTO);
  } else {
    extHead = Uint8Array.of(0xc9, (cipher.length >>> 24) & 0xff, (cipher.length >> 16) & 0xff, (cipher.length >> 8) & 0xff, cipher.length & 0xff, MSGPACK_EXT_CRYPTO);
  }
  const out = new Uint8Array(1 + specBytes.length + extHead.length + cipher.length);
  out[0] = 0x92; // array(2)
  out.set(specBytes, 1);
  out.set(extHead, 1 + specBytes.length);
  out.set(cipher, 1 + specBytes.length + extHead.length);
  return out;
}

// ---------------------------------------------------------------------------
// Decoding (msgpack.go:82-336) — throws Error on malformed input
// ---------------------------------------------------------------------------

/** msgpackDecode parses one msgpack value (map/array/scalar). Ext and bin
 * members come back as Uint8Array; ints as number (BigInt beyond 2^53);
 * floats as number. */
export function msgpackDecode(b: Uint8Array): [value: unknown, rest: Uint8Array] {
  if (b.length === 0) throw new Error("msgpack: empty input");
  const tag = b[0]!;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);

  if (tag <= 0x7f) return [tag, b.subarray(1)];
  if (tag >= 0xe0) return [(tag << 24) >> 24, b.subarray(1)];
  if (tag >= 0x80 && tag <= 0x8f) return decodeMap(b.subarray(1), tag & 0x0f);
  if (tag === 0xde || tag === 0xdf) {
    if (tag === 0xde) {
      if (b.length < 3) throw new Error("msgpack: truncated map16");
      return decodeMap(b.subarray(3), dv.getUint16(1, false));
    }
    if (b.length < 5) throw new Error("msgpack: truncated map32");
    return decodeMap(b.subarray(5), dv.getUint32(1, false));
  }
  if (tag >= 0x90 && tag <= 0x9f) return decodeArray(b.subarray(1), tag & 0x0f);
  if (tag === 0xdc || tag === 0xdd) {
    if (tag === 0xdc) {
      if (b.length < 3) throw new Error("msgpack: truncated array16");
      return decodeArray(b.subarray(3), dv.getUint16(1, false));
    }
    if (b.length < 5) throw new Error("msgpack: truncated array32");
    return decodeArray(b.subarray(5), dv.getUint32(1, false));
  }
  if (tag >= 0xa0 && tag <= 0xbf) {
    const n = tag & 0x1f;
    if (b.length < 1 + n) throw new Error("msgpack: truncated fixstr");
    return [TEXT_DECODER.decode(b.subarray(1, 1 + n)), b.subarray(1 + n)];
  }
  if (tag === 0xd9 || tag === 0xda || tag === 0xdb) return decodeStr(b);
  if (tag === 0xc4 || tag === 0xc5 || tag === 0xc6) {
    const [ln, rest] = msgpackLen(b);
    return [rest.slice(0, ln), rest.subarray(ln)];
  }
  if (tag === 0xc7 || tag === 0xc8 || tag === 0xc9) {
    const [ln, rest] = msgpackLen(b);
    if (rest.length < 1) throw new Error("msgpack: truncated ext type");
    return [rest.slice(1, 1 + ln), rest.subarray(1 + ln)];
  }
  if (tag >= 0xd4 && tag <= 0xd8) {
    const ln = 1 << (tag - 0xd4);
    if (b.length < 2 + ln) throw new Error("msgpack: truncated fixext");
    return [b.slice(2, 2 + ln), b.subarray(2 + ln)];
  }
  if (tag === 0xc0) return [null, b.subarray(1)];
  if (tag === 0xc2) return [false, b.subarray(1)];
  if (tag === 0xc3) return [true, b.subarray(1)];
  if (tag >= 0xcc && tag <= 0xcf) return decodeUint(b, dv);
  if (tag >= 0xd0 && tag <= 0xd3) return decodeInt(b, dv);
  if (tag === 0xca || tag === 0xcb) return decodeFloat(b, dv);
  if (tag === 0xc1) throw new Error("msgpack: reserved tag 0xc1");
  throw new Error(`msgpack: unsupported tag ${hexTag(tag)}`);
}

function decodeMap(rest: Uint8Array, n: number): [Record<string, unknown>, Uint8Array] {
  const m: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) {
    const [k, r] = msgpackDecode(rest);
    if (typeof k !== "string") throw new Error("msgpack: map key is not a string");
    const [v, r2] = msgpackDecode(r);
    m[k] = v;
    rest = r2;
  }
  return [m, rest];
}

function decodeArray(rest: Uint8Array, n: number): [unknown[], Uint8Array] {
  const arr: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const [v, r] = msgpackDecode(rest);
    arr.push(v);
    rest = r;
  }
  return [arr, rest];
}

function decodeStr(b: Uint8Array): [string, Uint8Array] {
  const [ln, rest] = msgpackLen(b);
  if (rest.length < ln) throw new Error("msgpack: truncated str");
  return [TEXT_DECODER.decode(rest.subarray(0, ln)), rest.subarray(ln)];
}

function decodeUint(b: Uint8Array, dv: DataView): [number | bigint, Uint8Array] {
  switch (b[0]!) {
    case 0xcc:
      if (b.length < 2) throw new Error("msgpack: truncated uint8");
      return [b[1]!, b.subarray(2)];
    case 0xcd:
      if (b.length < 3) throw new Error("msgpack: truncated uint16");
      return [dv.getUint16(1, false), b.subarray(3)];
    case 0xce:
      if (b.length < 5) throw new Error("msgpack: truncated uint32");
      return [dv.getUint32(1, false), b.subarray(5)];
    case 0xcf:
      if (b.length < 9) throw new Error("msgpack: truncated uint64");
      return [safeNum(dv.getBigUint64(1, false)), b.subarray(9)];
  }
  throw new Error("msgpack: not a uint");
}

function decodeInt(b: Uint8Array, dv: DataView): [number | bigint, Uint8Array] {
  switch (b[0]!) {
    case 0xd0:
      if (b.length < 2) throw new Error("msgpack: truncated int8");
      return [(b[1]! << 24) >> 24, b.subarray(2)];
    case 0xd1:
      if (b.length < 3) throw new Error("msgpack: truncated int16");
      return [dv.getInt16(1, false), b.subarray(3)];
    case 0xd2:
      if (b.length < 5) throw new Error("msgpack: truncated int32");
      return [dv.getInt32(1, false), b.subarray(5)];
    case 0xd3:
      if (b.length < 9) throw new Error("msgpack: truncated int64");
      return [safeNum(dv.getBigInt64(1, false)), b.subarray(9)];
  }
  throw new Error("msgpack: not an int");
}

function decodeFloat(b: Uint8Array, dv: DataView): [number, Uint8Array] {
  switch (b[0]!) {
    case 0xca:
      if (b.length < 5) throw new Error("msgpack: truncated float32");
      return [dv.getFloat32(1, false), b.subarray(5)];
    case 0xcb:
      if (b.length < 9) throw new Error("msgpack: truncated float64");
      return [dv.getFloat64(1, false), b.subarray(9)];
  }
  throw new Error("msgpack: not a float");
}

/** msgpackLen reads a length prefix after the tag at b[0]: 8-bit (0xd9/0xc4/
 * 0xc7), 16-bit (0xda/0xc5/0xc8) or 32-bit (0xdb/0xc6/0xc9). */
function msgpackLen(b: Uint8Array): [n: number, rest: Uint8Array] {
  const tag = b[0]!;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (tag === 0xd9 || tag === 0xc4 || tag === 0xc7) {
    if (b.length < 2) throw new Error("msgpack: truncated length");
    return [b[1]!, b.subarray(2)];
  }
  if (tag === 0xda || tag === 0xc5 || tag === 0xc8) {
    if (b.length < 3) throw new Error("msgpack: truncated length");
    return [dv.getUint16(1, false), b.subarray(3)];
  }
  if (tag === 0xdb || tag === 0xc6 || tag === 0xc9) {
    if (b.length < 5) throw new Error("msgpack: truncated length");
    return [dv.getUint32(1, false), b.subarray(5)];
  }
  throw new Error(`msgpack: tag ${hexTag(tag)} has no length`);
}
