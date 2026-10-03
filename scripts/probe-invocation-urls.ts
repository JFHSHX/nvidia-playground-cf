// scripts/probe-invocation-urls.ts — greps the saved NVCF main chunk for
// every invocation-URL-shaped token, to find what endpoint the page's widget
// actually POSTs to. Run: npx tsx scripts/probe-invocation-urls.ts
import { readFileSync } from "node:fs";

const js = readFileSync("hsw-test/nvcf-main-chunk.js", "utf8");
console.log("chunk bytes:", js.length);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pats = ["pexec", "buildapi", "chat/completions", "/functions/", "invocationUrl", "invokeUrl", "nvcf/pexec", "pexec/functions"];

for (const p of pats) {
  const re = new RegExp(`[\\w./$:-]{0,70}${escape(p)}[\\w./$:-]{0,70}`, "gi");
  const hits = new Set<string>();
  let m: RegExpExecArray | null;
  let count = 0;
  while ((m = re.exec(js)) !== null && count < 15) {
    hits.add(m[0]);
    count++;
  }
  console.log(`\n=== ${p}: ${hits.size} unique hits`);
  [...hits].slice(0, 10).forEach((h) => console.log("  ", JSON.stringify(h)));
}
