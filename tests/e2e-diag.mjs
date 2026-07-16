/**
 * Ultra-focused debug: just check registration API + dashboard rendering
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = join(__dirname, "..", "e2e-artifacts");
const BASE = "http://localhost:5174";
const TS = Date.now();
const TEST_EMAIL = `e2ediag+${TS}@anavitrade.test`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  // Log ALL requests
  page.on("request", (req) => {
    const url = req.url();
    if (url.includes("/api/") || url.includes("trpc")) {
      console.log(`  > ${req.method()} ${url} [${req.resourceType()}]`);
    }
  });

  page.on("response", async (res) => {
    const url = res.url();
    if (url.includes("/api/") || url.includes("trpc")) {
      const status = res.status();
      const headers = await res.allHeaders().catch(() => ({}));
      let text = "";
      try { text = await res.text(); } catch {}
      console.log(`  < ${status} ${url.slice(0, 120)}`);
      if (status >= 400) {
        console.log(`  < BODY: ${text.slice(0, 500)}`);
      }
    }
  });

  // 1. Check the proxy is working
  console.log("=== 1. Health check ===");
  await page.goto(`${BASE}/api/health`, { waitUntil: "domcontentloaded" });
  await sleep(500);
  const healthText = await page.locator("pre, body").innerText().catch(() => "");
  console.log(`  Health: ${healthText}`);

  // 2. Check register page renders
  console.log("\n=== 2. Register page ===");
  await page.goto(`${BASE}/register?demo=true`, { waitUntil: "domcontentloaded" });
  await sleep(2000);

  console.log(`  URL: ${page.url()}`);
  console.log(`  Content length: ${(await page.locator("body").innerText()).length}`);
  const html = await page.content();
  const rootContent = html.match(/<div[^>]*id="root"[^>]*>([\s\S]*?)<\/div>/i);
  console.log(`  Root div content length: ${rootContent ? rootContent[1].length : "N/A"}`);

  // 3. Submit registration with LONG wait
  console.log("\n=== 3. Submit registration (20s wait) ===");
  await page.locator('input[placeholder="Jane Smith"]').fill("Diag User");
  await page.locator('input[placeholder="you@example.com"]').fill(TEST_EMAIL);
  await page.locator('input[placeholder="Min 8 characters"]').fill("DiagPass123!");
  await page.locator('input[placeholder="Re-enter your password"]').fill("DiagPass123!");

  const submitBtn = page.locator('button[type="submit"]');
  console.log(`  Button: "${await submitBtn.innerText()}"`);
  await submitBtn.click();

  // Wait 20 seconds for the API call
  await sleep(20000);
  const urlAfter = page.url();
  const bodyAfter = await page.locator("body").innerText();
  console.log(`  URL after 20s: ${urlAfter}`);
  console.log(`  Body length: ${bodyAfter.length}`);
  if (bodyAfter.length > 0) {
    console.log(`  Body (first 300): ${bodyAfter.slice(0, 300)}`);
  }
  console.log(`  Has demo capital: ${bodyAfter.includes("Choose your demo capital")}`);
  console.log(`  Has error: ${bodyAfter.includes("already") || bodyAfter.includes("error") || bodyAfter.includes("failed")}`);

  await page.screenshot({ path: join(ARTIFACTS_DIR, "diag-after-register.png") });

  // 4. Navigate to dashboard
  console.log("\n=== 4. Dashboard check ===");
  await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
  await sleep(5000);

  const dashUrl = page.url();
  const dashBody = await page.locator("body").innerText();
  const dashHtml = await page.content();
  const dashRoot = dashHtml.match(/<div[^>]*id="root"[^>]*>([\s\S]*?)<\/div>/i);
  const rootLen = dashRoot ? dashRoot[1].trim().length : -1;

  console.log(`  URL: ${dashUrl}`);
  console.log(`  Body length: ${dashBody.length}`);
  console.log(`  Root div content length: ${rootLen}`);
  console.log(`  Body content: "${dashBody.slice(0, 300)}"`);
  console.log(`  Has 'Loading': ${dashBody.includes("Loading")}`);
  console.log(`  Has 'Welcome': ${dashBody.includes("Welcome")}`);
  console.log(`  Has 'demo': ${dashBody.toLowerCase().includes("demo")}`);

  if (dashBody.length === 0 && rootLen < 100) {
    console.log("\n  --- Root div appears nearly empty. Checking for scripts...");
    const scripts = dashHtml.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || [];
    const srcScripts = dashHtml.match(/<script[^>]*src="[^"]*"[^>]*>/gi) || [];
    console.log(`  Inline scripts: ${scripts.length}`);
    console.log(`  External scripts: ${srcScripts.length}`);
    for (const s of srcScripts.slice(0, 5)) {
      console.log(`    ${s.slice(0, 150)}`);
    }
  }

  await page.screenshot({ path: join(ARTIFACTS_DIR, "diag-dashboard.png") });
  writeFileSync(join(ARTIFACTS_DIR, "diag-dashboard.html"), dashHtml);

  console.log("\n=== 5. Trying to log in with same credentials ===");
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await sleep(2000);
  console.log(`  Login URL: ${page.url()}`);

  await page.locator('input[placeholder="alex@example.com"]').fill(TEST_EMAIL);
  await page.locator('input[placeholder="Your password"]').fill("DiagPass123!");
  await page.locator('button[type="submit"]').click();
  await sleep(10000);
  console.log(`  URL after login: ${page.url()}`);
  const loginBody = await page.locator("body").innerText();
  console.log(`  Login body length: ${loginBody.length}`);
  if (loginBody.includes("Welcome back")) {
    console.log("  SUCCESS: Login worked!");
  } else if (loginBody.includes("Invalid")) {
    console.log("  Login error shown");
  }

  await browser.close();
}

run().catch((err) => { console.error(err); process.exit(1); });
