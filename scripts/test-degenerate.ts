// scripts/test-degenerate.ts — smoke test for degenerate.ts (run: npx tsx scripts/test-degenerate.ts)
import { degenerateRun, guardSseHead, isDegenerateResponse } from "../src/node-host/degenerate";

function sseBody(deltas: Array<{ reasoning_content?: string; content?: string }>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const lines = deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`);
  lines.push("data: [DONE]\n\n");
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < lines.length) controller.enqueue(enc.encode(lines[i++]));
      else controller.close();
    },
  });
}

function sseResp(deltas: Array<{ reasoning_content?: string; content?: string }>): Response {
  return new Response(sseBody(deltas), { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function readAll(resp: Response): Promise<string> {
  return await resp.text();
}

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
}

// degenerateRun
check("run: 62 bangs detected", degenerateRun("!".repeat(62)));
check("run: 24 bangs detected", degenerateRun("!".repeat(24)));
check("run: normal text clean", !degenerateRun("Let me think about this problem carefully and then answer."));
check("run: short bursts clean", !degenerateRun("step 1 !!! step 2 !!! step 3"));
check("run: 12 bangs + long text clean", !degenerateRun("!".repeat(12) + " plus plenty of normal reasoning text follows here to dilute"));
check("run: short text clean", !degenerateRun("!!!!"));

// non-stream JSON
const emptyResp = new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, reasoning_content: "thought" } }] }), { status: 200, headers: { "content-type": "application/json" } });
check("non-stream: empty content detected", await isDegenerateResponse(emptyResp));
const bangResp = new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "", reasoning_content: "!".repeat(62) } }] }), { status: 200, headers: { "content-type": "application/json" } });
check("non-stream: bang reasoning detected", await isDegenerateResponse(bangResp));
const goodResp = new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "hello", reasoning_content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });
check("non-stream: good response clean", !(await isDegenerateResponse(goodResp)));

// SSE head guard: degenerate head -> null
const deg = await guardSseHead(sseResp([{ reasoning_content: "!".repeat(10) }, { reasoning_content: "!".repeat(52) }]));
check("sse: degenerate head -> null", deg === null);

// SSE head guard: clean reasoning + content -> replayed response with full body
const clean = await guardSseHead(sseResp([{ reasoning_content: "Thinking about the problem. " }, { reasoning_content: "More careful analysis. " }, { content: "The answer is 42." }]));
check("sse: clean head -> response", clean !== null);
if (clean) {
  const text = await readAll(clean);
  check("sse: replayed body complete (3 deltas + DONE)", text.includes("Thinking about") && text.includes("More careful") && text.includes("answer is 42") && text.includes("[DONE]"));
}

// SSE head guard: reasoning longer than HEAD_SCAN_CHARS (200) then content
const longReasoning = ("The model reasons carefully about the question before answering. ").repeat(4);
const long = await guardSseHead(sseResp([{ reasoning_content: longReasoning }, { content: "done" }]));
check("sse: >200 char reasoning -> replayed", long !== null);
if (long) check("sse: long replay complete", (await readAll(long)).includes("before answering"));

// SSE head guard: non-thinking model (content only, immediate)
const contentOnly = await guardSseHead(sseResp([{ content: "hi" }, { content: " there" }]));
check("sse: content-only immediate replay", contentOnly !== null && (await readAll(contentOnly)).includes("hi"));

process.exit(failures === 0 ? 0 : 1);
