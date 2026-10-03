// scripts/probe-browser.ts — diagnostic: load the composed hsw bundle into a
// headless Chromium page (about:blank) and inspect which globals the bundle
// actually installed. Run: npx tsx scripts/probe-browser.ts
import { chromium } from "playwright";
import { loadBundle, locationFromJWT } from "../src/hcaptcha/runner";
import { readFileSync } from "node:fs";

const jwt = readFileSync("hsw-test/jwt.txt", "utf8").trim();
const location = locationFromJWT(jwt);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message.slice(0, 200)));
page.on("console", (m) => console.log("PAGE-CONSOLE:", m.type(), m.text().slice(0, 120)));

await page.goto("about:blank");
console.log("location:", location);
const bundle = await loadBundle(location);
console.log("bundle version:", bundle.version, "bytes:", bundle.source.length);
await page.addScriptTag({ content: bundle.source });
const info = await page.evaluate(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  const mod = g["module"] as { exports?: unknown } | undefined;
  return {
    hswType: typeof g["hsw"],
    moduleType: typeof g["module"],
    winIsGlobal: g["window"] === globalThis,
    moduleExportsType: mod ? typeof mod.exports : "no-module",
    atobType: typeof g["atob"],
  };
});
console.log("GLOBALS:", JSON.stringify(info));
await browser.close();
