// scripts/probe-glm-invoke.ts — loads glm-5-3's playground in a REAL headed
// Chromium, sends a message, and captures every nvcf/predict/chat network
// request to reveal what the page's own widget actually invokes (the user
// verified glm-5-3 works anonymously in the browser UI — our predict call
// got 404, so the page must use a different invocation shape).
// Run: npx tsx scripts/probe-glm-invoke.ts
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();
const reqs: string[] = [];

page.on("request", (r) => {
  const u = r.url();
  if (/nvcf|predict|chat\/completions|hcaptcha|buildapi/.test(u)) {
    reqs.push(`${r.method()} ${u}`);
  }
});
page.on("response", (r) => {
  const u = r.url();
  if (/nvcf|predict|buildapi/.test(u)) {
    console.log(`RESP ${r.status()} ${r.request().method()} ${u.slice(0, 140)}`);
  }
});

await page.goto("https://build.nvidia.com/z-ai/glm-5-3/playground", { waitUntil: "domcontentloaded", timeout: 60000 });
console.log("page loaded; waiting for the widget to settle...");
await page.waitForTimeout(8000);

// The chat input: .chat-text-input contains a textarea or input (v3 layout).
const box = page.locator(".chat-text-input textarea, .chat-text-input input").first();
await box.click();
await box.fill("hi");
await page.keyboard.press("Enter");
console.log("message sent; waiting for the invocation...");
await page.waitForTimeout(25000);

console.log(`\ncaptured ${reqs.length} matching requests (last 25):`);
reqs.slice(-25).forEach((r) => console.log("  " + r));
await browser.close();
