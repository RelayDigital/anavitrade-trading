/**
 * Debug E2E: Focus on registration + auth flow
 * Checks each step with detailed output and server request tracking
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = join(__dirname, "..", "e2e-artifacts");
const BASE = "http://localhost:5174";

const TS = Date.now();
const TEST_EMAIL = `e2edebug+${TS}@anavitrade.test`;
const TEST_PASSWORD = "DebugPass123!";
const TEST_NAME = "Debug E2E User";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function shot(page, name) {
  await page.screenshot({ path: join(ARTIFACTS_DIR, name) });
  console.log(`  [ss] ${name}`);
}

async function run() {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  const requests = [];

  // Track ALL network requests to /api/
  page.on("request", (req) => {
    if (req.url().includes("/api/")) {
      console.log(`  [REQ] ${req.method()} ${req.url().substring(50)}`);
      requests.push({ type: "req", url: req.url(), method: req.method(), ts: Date.now() });
    }
  });
  page.on("response", async (res) => {
    if (res.url().includes("/api/")) {
      const status = res.status();
      let body = "";
      try { body = await res.text(); } catch {}
      console.log(`  [RES] ${status} ${res.url().substring(50)}`);
      if (status >= 400) {
        console.log(`  [ERR_BODY] ${body.slice(0, 300)}`);
      }
      requests.push({ type: "res", url: res.url(), status, body: body.slice(0, 500), ts: Date.now() });
    }
  });

  const pageErrors = [];
  page.on("pageerror", (err) => { pageErrors.push(err.message); console.log(`  [PAGE_ERR] ${err.message}`); });
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log(`  [CONSOLE_ERR] ${msg.text()}`);
  });

  console.log("=== 1. Open Home Page ===");
  await page.goto(BASE, { waitUntil: "load" });
  await sleep(2000);
  await shot(page, "debug-01-home.png");
  console.log(`  Title: ${await page.title()}`);

  console.log("\n=== 2. Open Register page ===");
  await page.goto(`${BASE}/register?demo=true`, { waitUntil: "load" });
  await sleep(2000);
  await shot(page, "debug-02-register.png");
  console.log(`  URL: ${page.url()}`);

  // Check if demo toggle is pre-selected by checking body text
  let pageText = await page.locator("body").innerText();
  console.log(`  Has 'Create your account': ${pageText.includes("Create your account")}`);
  console.log(`  Has 'Start with a demo account': ${pageText.includes("Start with a demo account")}`);

  // Fill form
  await page.locator('input[placeholder="Jane Smith"]').fill(TEST_NAME);
  await page.locator('input[placeholder="you@example.com"]').fill(TEST_EMAIL);
  await page.locator('input[placeholder="Min 8 characters"]').fill(TEST_PASSWORD);
  await page.locator('input[placeholder="Re-enter your password"]').fill(TEST_PASSWORD);
  await shot(page, "debug-03-filled.png");

  console.log("\n=== 3. Click Submit ===");
  const submitBtn = page.locator('button[type="submit"]');
  console.log(`  Button text: "${await submitBtn.innerText()}"`);

  await submitBtn.click();
  await sleep(5000); // Wait for API call to complete

  pageText = await page.locator("body").innerText();
  console.log(`  URL after submit: ${page.url()}`);

  if (pageText.includes("Choose your demo capital")) {
    console.log("  -> Demo capital step appeared!");
    await shot(page, "debug-04-demo-capital.png");

    // Select $10K and submit
    await page.locator("button", { hasText: "$10,000" }).click();
    await sleep(300);
    const startBtn = page.locator("button", { hasText: /Start with/ });
    console.log(`  Start button visible: ${await startBtn.isVisible()}`);
    if (await startBtn.isVisible()) {
      await startBtn.click();
      await sleep(5000);
      console.log(`  URL after demo create: ${page.url()}`);
      await shot(page, "debug-05-after-demo.png");
    }
  } else if (pageText.includes("already exists")) {
    console.log("  -> Account already exists");
  } else if (pageText.includes("Create your account")) {
    console.log("  -> Still on register page - form didn't submit");
    // Check for validation errors
    const errors = await page.locator(".text-red-400, [class*=error]").allInnerTexts().catch(() => []);
    console.log(`  Visible errors: ${JSON.stringify(errors)}`);
  } else {
    console.log(`  -> Unexpected state. URL: ${page.url()}`);
    // Check what the page shows
    const errElems = await page.locator(".text-red-400, [role=alert], .sonner-toast").allInnerTexts().catch(() => []);
    console.log(`  Alert/error elements: ${JSON.stringify(errElems)}`);
  }

  await shot(page, "debug-06-final.png");

  // Now check /dashboard
  console.log("\n=== 4. Navigate to /dashboard ===");
  await page.goto(`${BASE}/dashboard`, { waitUntil: "load" });
  await sleep(4000);
  await shot(page, "debug-07-dashboard.png");
  console.log(`  Dashboard URL: ${page.url()}`);

  pageText = await page.locator("body").innerText();
  console.log(`  Dashboard body length: ${pageText.length}`);
  console.log(`  Dashboard body (first 500): "${pageText.slice(0, 500)}"`);

  // Check if we're on /login
  if (page.url().includes("/login")) {
    console.log("  Redirected to /login");
    // Fill login form and submit
    await page.locator('input[placeholder="alex@example.com"]').fill(TEST_EMAIL);
    await page.locator('input[placeholder="Your password"]').fill(TEST_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await sleep(3000);
    console.log(`  URL after login: ${page.url()}`);
    await shot(page, "debug-08-after-login.png");

    pageText = await page.locator("body").innerText();
    console.log(`  Post-login body length: ${pageText.length}`);
    console.log(`  Post-login body (first 500): "${pageText.slice(0, 500)}"`);
  }

  // Summary
  console.log("\n=== SUMMARY ===");
  console.log(`  Page errors: ${pageErrors.length}`);
  console.log(`  Total API requests tracked: ${requests.length}`);
  for (const r of requests) {
    if (r.type === "res" && r.status >= 400) {
      console.log(`  API ERROR: [${r.status}] ${r.url.substring(60)} -> ${r.body?.slice(0, 200)}`);
    }
  }

  writeFileSync(join(ARTIFACTS_DIR, "debug-requests.json"), JSON.stringify(requests, null, 2));

  await browser.close();
}

run().catch((err) => { console.error(err); process.exit(1); });
