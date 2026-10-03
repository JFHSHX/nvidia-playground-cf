// scripts/probe-glm-chunks.ts — fetches glm-5-3's playground page + its JS
// chunks and greps for NVCF invocation URL patterns, to find what the page's
// widget actually calls (the user verified glm-5-3 works anonymously in the
// browser UI, so the page must use a different invocation than buildapi
// predict). Run: npx tsx scripts/probe-glm-chunks.ts
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const pageRes = await fetch("https://build.nvidia.com/z-ai/glm-5-3/playground", {
  headers: { "User-Agent": UA, Accept: "text/html" },
});
const html = await pageRes.text();
console.log("page:", pageRes.status, "bytes:", html.length);

const chunks = [...new Set([...html.matchAll(/\/_next\/static\/chunks\/[A-Za-z0-9._-]+\.js/g)].map((m) => m[0]!))];
console.log("chunks referenced:", chunks.length);

const re = /.{60}(?:nvcf|pexec|grpc\.nvcf|invocationUrl|invokeUrl)[^"']{0,140}/gi;
for (const c of chunks) {
  try {
    const res = await fetch("https://build.nvidia.com" + c, { headers: { "User-Agent": UA } });
    if (res.status !== 200) continue;
    const js = await res.text();
    if (/nvcf|pexec|grpc\.nvcf|invocationUrl|invokeUrl/i.test(js)) {
      console.log(`\nHIT: ${c} (${js.length} bytes)`);
      let m: RegExpExecArray | null;
      let count = 0;
      while ((m = re.exec(js)) !== null && count < 8) {
        console.log("   ", JSON.stringify(m[0].slice(-200)));
        count++;
      }
      re.lastIndex = 0;
    }
  } catch {
    // skip
  }
}
