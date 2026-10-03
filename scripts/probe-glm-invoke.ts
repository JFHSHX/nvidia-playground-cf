// scripts/probe-glm-invoke.ts — loads glm-5-3's playground in a REAL headed
// Chromium, sends a message via the chat textarea, and captures EVERY POST
// request + its response body, to reveal the page's real invocation.
// Run: npx tsx scripts/probe-glm-invoke.ts
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();
const posts: Array<{ url: string; status?: number; body?: string }> = [];

page.on("request", (r) => {
  if (r.method() === "POST" && !/_next|hcaptcha\.com\/c\/|\.css|\.png|\.woff/.test(r.url())) {
    posts.push({ url: r.url() });
  }
});
page.on("response", async (r) => {
  if (r.request().method() !== "POST" || /hcaptcha\.com\/c\//.test(r.url())) return;
  const entry = posts.find((p) => p.url === r.url() && p.status === undefined);
  if (entry) {
    entry.status = r.status();
    try {
      entry.body = (await r.text()).slice(0, 500);
    } catch {
      entry.body = "(body unavailable)";
    }
  }
});

await page.goto("https://build.nvidia.com/z-ai/glm-5-3/playground", { waitUntil: "domcontentloaded", timeout: 60000 });
console.log("page loaded");
await page.waitForTimeout(8000);

// Find the chat input: a plain textarea, else a contenteditable.
let box = page.locator("textarea").first();
if ((await box.count()) === 0) {
  box = page.locator("[contenteditable='true']").first();
}
console.log("input found:", await box.count());
await box.click({ timeout: 15000 }).catch((e) => console.log("click failed:", e.message.slice(0, 120)));
await box.fill("hi").catch((e) => console.log("fill failed:", e.message.slice(0, 120)));
await page.keyboard.press("Enter");
console.log("message sent");
await page.waitForTimeout(25000);

console.log(`\ncaptured ${posts.length} POSTs:`);
posts.forEach((p, i) => {
  console.log(`\n[${i}] ${p.url}`);
  console.log(`    status: ${p.status ?? "?"}`);
  if (p.body) console.log(`    body: ${JSON.stringify(p.body.slice(0, 300))}`);
});
await browser.close();
