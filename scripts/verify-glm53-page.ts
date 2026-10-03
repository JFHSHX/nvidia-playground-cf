import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Log all requests to predict/inference endpoints
  const apiCalls: { url: string; status?: number; method: string }[] = [];
  page.on('request', (r) => {
    const u = r.url();
    if (/predict|inference|chat|completions/i.test(u)) {
      apiCalls.push({ url: u, method: r.method() });
      console.log('[req]', r.method(), u);
    }
  });
  page.on('response', async (r) => {
    const u = r.url();
    if (/predict|inference|chat|completions/i.test(u)) {
      const st = r.status();
      console.log('[resp]', st, u);
      apiCalls[apiCalls.length - 1].status = st;
      try {
        const body = await r.text();
        console.log('[resp body]', body.slice(0, 600));
      } catch {}
    }
  });

  console.log('Opening https://build.nvidia.com/z-ai/glm-5-3/playground ...');
  await page.goto('https://build.nvidia.com/z-ai/glm-5-3/playground', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });

  // Wait for UI to settle (hCaptcha PoW etc.)
  await page.waitForTimeout(6000);

  // Dismiss cookie banner if present
  for (const cookieSel of [
    'button:has-text("Accept All")',
    'button:has-text("Accept")',
    'button:has-text("同意")',
  ]) {
    const b = page.locator(cookieSel).first();
    if (await b.count().catch(() => 0)) {
      await b.click({ timeout: 2000 }).catch(() => {});
      console.log('Clicked cookie banner:', cookieSel);
      await page.waitForTimeout(500);
    }
  }

  // Dismiss the "Before You Use AI Models" consent dialog if present
  for (const dlgSel of [
    'dialog button:has-text("Accept")',
    'dialog button:has-text("I Agree")',
    'dialog button:has-text("Agree")',
    'dialog button:has-text("Continue")',
    'dialog button[aria-label="close"]',
    'button:has-text("Accept")',
    'button:has-text("I Agree")',
  ]) {
    const b = page.locator(dlgSel).first();
    if (await b.isVisible().catch(() => false)) {
      await b.click({ timeout: 2000 }).catch(() => {});
      console.log('Dismissed dialog via:', dlgSel);
      await page.waitForTimeout(1000);
    }
  }

  // Dump visible text briefly
  const bodyText = await page.locator('body').innerText().catch(() => '');
  console.log('--- PAGE TEXT (first 1200 chars) ---');
  console.log(bodyText.slice(0, 1200));
  console.log('--- END PAGE TEXT ---');

  // Try to find an input/textarea and submit a prompt
  const candidates = [
    'textarea',
    'input[type="text"]',
    '[contenteditable="true"]',
  ];
  let typed = false;
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (await loc.count().catch(() => 0)) {
      try {
        await loc.click({ timeout: 3000 });
        await page.keyboard.type('Hello, who are you?');
        typed = true;
        console.log('Typed prompt into:', sel);
        break;
      } catch (e: any) {
        console.log('Failed typing into', sel, e.message);
      }
    }
  }

  if (typed) {
    // Confirm the textarea kept our text
    const val = await page.locator('textarea').first().inputValue().catch(() => '');
    console.log('textarea value after typing:', JSON.stringify(val));

    // Try clicking a Send button first, fall back to Enter
    const sendBtn = page.locator('button[aria-label*="Send" i], button:has(svg[data-testid*="send" i]), button:has-text("Send")').first();
    if (await sendBtn.isVisible().catch(() => false)) {
      await sendBtn.click().catch((e: any) => console.log('send click failed:', e.message));
      console.log('Clicked Send button');
    } else {
      await page.keyboard.press('Enter');
      console.log('Pressed Enter');
    }
    console.log('Submitted. Waiting for response (up to 60s)...');
    // Wait for any assistant-like text to grow
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(5000);
      const t = await page.locator('body').innerText().catch(() => '');
      const marker = t.match(/glm|GLM|nvidia|NVIDIA|您好|hello|sorry|error|login/i);
      console.log(`[wait ${(i + 1) * 5}s] page text len=${t.length}, marker=${marker ? marker[0] : 'none'}`);
      if (t.length > 2000 && i > 4) {
        console.log('--- FINAL PAGE TEXT (last 1500 chars) ---');
        console.log(t.slice(-1500));
        break;
      }
    }
  }

  console.log('--- API calls captured ---');
  for (const c of apiCalls) console.log(`${c.method} ${c.status ?? '?'} ${c.url}`);

  await browser.close();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
