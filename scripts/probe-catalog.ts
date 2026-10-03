// scripts/probe-catalog.ts — fetches the live build.nvidia.com/models page
// and lists the model ids found in it. Run: npx tsx scripts/probe-catalog.ts
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

for (const url of [
  "https://build.nvidia.com/models?filters=nimType%3Anim_type_preview&pageSize=100",
  "https://build.nvidia.com/models?pageSize=100",
]) {
  let html = "";
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
    html = await res.text();
    console.log(`\n=== ${url}\nstatus: ${res.status} bytes: ${html.length}`);
    if (res.status !== 200) continue;
  } catch (e) {
    console.log(`\n=== ${url}\nFETCH FAILED: ${e instanceof Error ? e.message : String(e)}`);
    continue;
  }
  const re = /href="\/([a-z0-9_-]+)\/([a-z0-9._-]+)"/g;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const pub = m[1]!;
    const slug = m[2]!;
    if (["models", "build", "docs", "blog", "nemo", "solutions", "use-cases", "about", "login"].includes(pub)) continue;
    seen.add(pub + "/" + slug);
  }
  console.log("model ids found:", seen.size);
  for (const id of [...seen].sort()) console.log("  " + id);
}
