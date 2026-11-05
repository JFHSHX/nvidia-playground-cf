// scripts/list-models.ts — list the current NVIDIA playground model catalog
// with a real browser (pwsh/undici TLS fingerprints get AWS-WAF challenged,
// status 202 + empty body; Chromium passes). Extracts qc69jvmznzxy/<slug>
// ids + inline nvcfFunctionId pairs from the rendered page HTML and prints
// them; diff against the proxy's static snapshot to find NEW models.
// Run: npx tsx scripts/list-models.ts
import { chromium } from "playwright";

const URL = "https://build.nvidia.com/models?pageSize=100";

const context = await chromium.launchPersistentContext(".capture-profile", { headless: true, viewport: null });
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
// WAF interstitial (awswaf) self-clears in a real browser; wait for model cards or content
await page.waitForLoadState("networkidle", { timeout: 45_000 }).catch(() => {});
await page.waitForTimeout(3_000);

const html = await page.content();
const slugs = [...new Set([...html.matchAll(/qc69jvmznzxy\/([A-Za-z0-9_.+~\-]+)/g)].map((m) => m[1]!))].sort();
const fnPairs = [...html.matchAll(/"nvcfFunctionId\\?":\\?"([a-f0-9-]{36})\\?"/g)].map((m) => m[1]!);

// DOM anchor extraction as a second source (model page links)
const hrefs: string[] = await page.evaluate(() =>
  [...document.querySelectorAll("a[href]")].map((a) => (a as HTMLAnchorElement).getAttribute("href") ?? "").filter(Boolean),
);
const pageSlugs = [...new Set(hrefs.filter((h) => /^\/[a-z0-9][a-z0-9-]*\/[A-Za-z0-9_.+~-]+$/.test(h) && !/^\/(_next|models|explore|blueprints|skills|community|about|build)$/.test(h)).map((h) => h.slice(1)))].sort();

console.log(`[list-models] qc69jvmznzxy slugs from HTML: ${slugs.length}`);
for (const s of slugs) console.log(`  ${s}`);
console.log(`[list-models] inline nvcfFunctionId pairs: ${fnPairs.length}`);
console.log(`[list-models] page links (candidate model pages): ${pageSlugs.length}`);
for (const s of pageSlugs) console.log(`  ${s}`);
await context.close();
