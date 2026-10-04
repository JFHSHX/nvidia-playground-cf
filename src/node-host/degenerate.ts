// src/node-host/degenerate.ts — retryable model-variance detection + SSE head
// guard. Covers two observed kimi-k3 failure modes that break dsh turns:
// (a) empty content (the thinking model spent its whole budget on reasoning),
// (b) reasoning degenerated into a single-character repetition loop
// ("!!!!…" ×62 in dsh session.v4.jsonl). Streaming responses (text/event-stream)
// are guarded by scanning the head reasoning deltas BEFORE anything reaches
// the client; non-stream JSON by full-body inspection.

/** degenerateRun: true when `text` contains a single-character repetition
 * loop (≥12 consecutive identical chars covering ≥50% of the text). */
export function degenerateRun(text: string): boolean {
  if (text.length < 12) return false;
  const m = text.match(/(.)\1{11,}/);
  return !!(m && m[0]!.length >= text.length * 0.5);
}

/** isDegenerateResponse: true when a non-stream JSON response is a retryable
 * model-variance failure. Reads a CLONE so the original response stays
 * writable. */
export async function isDegenerateResponse(resp: Response): Promise<boolean> {
  try {
    const ct = resp.headers.get("content-type") ?? "";
    if (resp.status !== 200) return false; // 错误响应不是"退化",别浪费重试
    if (!ct.includes("application/json")) return false; // SSE: see guardSseHead
    const body = await resp.clone().json() as { choices?: Array<{ message?: { content?: string | null; reasoning_content?: string | null } }> };
    const msg = body?.choices?.[0]?.message;
    if (!msg) return true;
    if (msg.content === null || msg.content === "") return true;
    return degenerateRun(msg.reasoning_content ?? "");
  } catch {
    return false;
  }
}

// HEAD_SCAN_CHARS:放行前要扫描的 reasoning 量。正常推理很快越过(<1s),
// 退化循环在 ~24 字符内就检出。
const HEAD_SCAN_CHARS = 200;

/** replayHead: a Response that first re-emits the bytes buffered during the
 * head scan, then pipes the remainder of the original stream untouched. */
function replayHead(resp: Response, buffered: Uint8Array[], reader: ReadableStreamDefaultReader<Uint8Array>): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of buffered) controller.enqueue(chunk);
      const pump = (): Promise<void> => reader.read().then(({ done, value }) => {
        if (done) { controller.close(); return; }
        controller.enqueue(value!);
        return pump();
      }).catch((e) => controller.error(e));
      void pump();
    },
    cancel() { reader.cancel().catch(() => {}); },
  });
  return new Response(stream, { status: resp.status, headers: resp.headers });
}

/** guardSseHead: peek at the head of an SSE response and scan the reasoning
 * deltas for a repetition loop BEFORE anything reaches the client. Returns
 * null when the head is degenerate (original body fully consumed — caller
 * retries with a fresh token); otherwise returns a Response that replays the
 * buffered bytes then pipes the rest. */
export async function guardSseHead(resp: Response): Promise<Response | null> {
  const reader = resp.body!.getReader();
  const buffered: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let reasoning = "";
  let carry = ""; // 不完整的 SSE 行尾
  try {
    while (reasoning.length < HEAD_SCAN_CHARS) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered.push(value);
      carry += decoder.decode(value, { stream: true });
      const lines = carry.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload) as { choices?: Array<{ delta?: { reasoning_content?: string | null; content?: string | null } }> };
          const d = j?.choices?.[0]?.delta;
          if (!d) continue;
          if (typeof d.content === "string" && d.content !== "") {
            return replayHead(resp, buffered, reader); // 答案在流 = 干净,立即放行
          }
          if (typeof d.reasoning_content === "string") reasoning += d.reasoning_content;
          if (degenerateRun(reasoning)) {
            try { await reader.cancel(); } catch { /* already closed */ }
            return null; // 头部退化:整条废弃
          }
        } catch { /* 非 JSON data 行(心跳/注释):忽略 */ }
      }
    }
    return replayHead(resp, buffered, reader);
  } catch {
    // 头部扫描读取异常:保守放行已缓冲内容,剩余交由原流继续
    return replayHead(resp, buffered, reader);
  }
}

/** degenerateGuard: unified retryable-failure guard. Returns the response to
 * write (possibly head-guarded for SSE), or null when it is a retryable
 * degenerate failure (body consumed — caller retries with a fresh token). */
export async function degenerateGuard(resp: Response): Promise<Response | null> {
  if (resp.status !== 200) return resp; // 错误响应:不是退化,原样放行
  if (resp.body == null) return resp;
  const ct = resp.headers.get("content-type") ?? "";
  if (ct.includes("text/event-stream")) return guardSseHead(resp);
  return (await isDegenerateResponse(resp)) ? null : resp;
}
