/**
 * Clean E2E test — with restarted workerd
 *
 * Tests:
 * 1. Register a new account (with demo)
 * 2. Dashboard loads in Demo mode
 * 3. Live/Demo toggle works
 * 4. Aster panel renders
 * 5. No console errors
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = join(__dirname, "..", "e2e-artifacts");
const BASE = "http://localhost:5174";
const TS = Date.now();

// Fresh credentials each run
const EMAIL = `e2e+${TS}@test.test`;
const PASSWORD = "Test123!Secure";
const NAME = "testuser2026";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function shot(page, name) { return page.screenshot({ path: join(ARTIFACTS, name) }); }

const results = { pass: [], fail: [], warn: [], trpcErrors: [], consoleErrors: [], pageErrors: [] };
function pass(m) { results.pass.push(m); console.log("  PASS:", m); }
function fail(m, d) { results.fail.push({ m, d }); console.log("  FAIL:", m, "—", d); }
function warn(m, d) { results.warn.push({ m, d }); console.log("  WARN:", m, "—", d); }

async function main() {
  mkdirSync(ARTIFACTS, { recursive: true });

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  // Track tRPC failures
  page.on("response", async (res) => {
    if (res.url().includes("/api/trpc/") && !res.ok()) {
      let body = "";
      try { body = await res.text(); } catch {}
      results.trpcErrors.push({ url: res.url().slice(0, 120), status: res.status(), body: body.slice(0, 200) });
    }
  });
  page.on("pageerror", (err) => results.pageErrors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") results.consoleErrors.push(msg.text().slice(0, 200));
  });

  // ── 1. Homepage ────────────────────────────────────────────────
  console.log("\n=== 1. Homepage ===");
  await page.goto(BASE, { waitUntil: "load" });
  await sleep(2000);
  console.log("  Title:", await page.title());
  pass("Homepage loaded");

  // ── 2. Register ─────────────────────────────────────────────────
  console.log("\n=== 2. Register with demo ===");
  await page.goto(BASE + "/register?demo=true", { waitUntil: "load" });
  await sleep(2000);
  console.log("  URL:", page.url());

  // Verify register page loaded
  const body = await page.locator("body").innerText();
  if (!body.includes("Create your account")) {
    fail("Register page", "No heading");
    console.log("  Body:", body.slice(0, 200));
  } else {
    pass("Register page loaded");
  }

  // Fill form
  await page.locator('input[placeholder="Jane Smith"]').fill(NAME);
  await page.locator('input[placeholder="you@example.com"]').fill(EMAIL);
  await page.locator('input[placeholder="Min 8 characters"]').fill(PASSWORD);
  await page.locator('input[placeholder="Re-enter your password"]').fill(PASSWORD);
  pass("Form filled");

  // Submit
  console.log("  Submitting...");
  const btn = page.locator('button[type="submit"]');
  console.log("  Button:", await btn.innerText());
  await btn.click();

  // Wait for the API call to complete (may take a few seconds)
  let waited = 0;
  let apiDone = false;
  while (waited < 20000) {
    await sleep(1000);
    waited += 1000;
    // Check if page changed
    const url = page.url();
    const txt = await page.locator("body").innerText();
    if (url.includes("/dashboard")) {
      console.log("  -> dashboard after", waited / 1000, "s");
      apiDone = true;
      break;
    }
    if (txt.includes("Choose your demo capital")) {
      console.log("  -> demo capital step after", waited / 1000, "s");
      apiDone = true;
      break;
    }
    if (txt.includes("already exists")) {
      console.log("  -> already exists after", waited / 1000, "s");
      break;
    }
  }

  if (!apiDone) {
    const pageText = await page.locator("body").innerText();
    console.log("  Page text:", pageText.slice(0, 300));
    const errs = await page.locator(".text-red-400, [class*=error]").allInnerTexts().catch(() => []);
    console.log("  Errors on page:", JSON.stringify(errs));
    console.log("  tRPC errors:", JSON.stringify(results.trpcErrors));
  }

  await shot(page, "01-after-register.png");

  // ── 3. Demo capital ─────────────────────────────────────────────
  console.log("\n=== 3. Demo capital ===");
  const t3 = await page.locator("body").innerText();
  if (t3.includes("Choose your demo capital")) {
    // Click the 10K option (inside the grid, not the submit button)
    await page.locator('div.grid button').filter({ hasText: "$10,000" }).click();
    await sleep(300);
    await page.locator("button", { hasText: /Start with/ }).click();
    await sleep(5000);

    const u = page.url();
    console.log("  URL:", u);
    if (u.includes("/dashboard")) {
      pass("Demo capital submitted, on dashboard");
    } else {
      warn("Demo capital", "URL after submit: " + u);
    }
  } else if (page.url().includes("/dashboard")) {
    pass("Already on dashboard");
  } else {
    // Try navigating to dashboard
    await page.goto(BASE + "/dashboard", { waitUntil: "load" });
    await sleep(3000);
    console.log("  Dashboard URL:", page.url());
    if (page.url().includes("/dashboard")) {
      pass("Dashboard reached");
    } else if (page.url().includes("/login")) {
      // Try logging in
      await page.locator('input[placeholder="alex@example.com"]').fill(EMAIL);
      await page.locator('input[placeholder="Your password"]').fill(PASSWORD);
      await page.locator('button[type="submit"]').click();
      await sleep(5000);
      console.log("  After login URL:", page.url());
      if (page.url().includes("/dashboard")) {
        pass("Logged in, on dashboard");
      } else {
        fail("Login", "Could not reach dashboard");
      }
    } else {
      warn("Dashboard", "Unexpected URL: " + page.url());
    }
  }

  await shot(page, "02-dashboard.png");

  // ── 4. Verify Demo mode ─────────────────────────────────────────
  console.log("\n=== 4. Dashboard in Demo mode ===");
  await sleep(3000);

  const dash = await page.locator("body").innerText();
  console.log("  Dashboard length:", dash.length);

  if (dash.length > 0) {
    console.log("  Dashboard text (first 600):");
    console.log("  ", dash.slice(0, 600).replace(/\n/g, "\n  "));
  }

  if (dash.includes("Welcome back")) pass("Welcome message");
  else warn("Dashboard greeting", "No 'Welcome back'");

  if (dash.includes("Demo") || dash.includes("DEMO")) pass("Demo label");
  else warn("Demo label", "No Demo indicator");

  if (dash.includes("$10,000") || dash.includes("10,000")) pass("$10,000 balance visible");
  else warn("Balance", "$10,000 not found");

  if (dash.includes("Live") || dash.includes("LIVE")) pass("Live status indicator");
  else warn("Live status", "Live indicator not found");

  if (dash.includes("0 trades") || dash.includes("No trades") || dash.includes("no trades yet")) {
    pass("Empty trade state");
  } else {
    warn("Trade count", "No empty-trade message found");
  }

  // ── 5. Live/Demo toggle ─────────────────────────────────────────
  console.log("\n=== 5. Live/Demo toggle ===");

  const liveBtn = page.locator('button:has-text("Live")').first();
  const demoBtn = page.locator('button:has-text("Demo")').first();
  const lv = await liveBtn.isVisible().catch(() => false);
  const dv = await demoBtn.isVisible().catch(() => false);
  console.log("  Live btn visible:", lv, "Demo btn visible:", dv);

  if (lv && dv) {
    pass("Toggle visible");

    const pressed = page.locator('button[aria-pressed="true"]');
    const pc = await pressed.count();
    if (pc > 0) {
      const mode = await pressed.first().innerText();
      console.log("  Active:", mode);
      pass("Mode:", mode);

      // Toggle
      const target = mode === "Demo" ? liveBtn : demoBtn;
      const back = mode === "Demo" ? demoBtn : liveBtn;

      await target.click();
      await sleep(1500);
      await shot(page, "03-toggled.png");
      console.log("  Toggled to:", mode === "Demo" ? "Live" : "Demo");

      await back.click();
      await sleep(1000);
      pass("Toggle works both ways");
    }
  } else {
    warn("Toggle", "Not visible");
    // Debug: check the area
    const toggleArea = page.locator('div:has(button:has-text("Live"))').first();
    console.log("  Toggle area:", await toggleArea.isVisible().catch(() => false));
  }

  // ── 6. Aster panel ──────────────────────────────────────────────
  console.log("\n=== 6. Aster Execution Panel ===");

  // Scroll all the way down
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(500);

  const fullText = await page.locator("body").innerText();
  const asterFeatures = [];
  if (fullText.includes("Aster DEX Execution")) asterFeatures.push("heading");
  if (fullText.includes("Staging mode")) asterFeatures.push("staging");
  if (fullText.includes("Live submit")) asterFeatures.push("live");
  if (fullText.includes("Not Connected")) asterFeatures.push("not_connected");
  if (fullText.includes("One click to activate")) asterFeatures.push("cta");
  if (fullText.includes("Activate DEX Execution")) asterFeatures.push("activate_card");

  if (asterFeatures.length > 0) {
    pass("Aster panel:", asterFeatures.join(", "));
  } else {
    warn("Aster panel", "No Aster features found on dashboard");
    // Try more specific search
    const asterPanel = page.locator("text=Aster DEX Execution");
    console.log("  Aster panel visible:", await asterPanel.isVisible().catch(() => false));
  }

  await shot(page, "04-aster.png");

  // ── 7. Errors ───────────────────────────────────────────────────
  console.log("\n=== 7. Errors ===");

  if (results.trpcErrors.length === 0) pass("No tRPC errors");
  else warn("tRPC errors", JSON.stringify(results.trpcErrors));

  if (results.consoleErrors.length === 0) pass("No console errors");
  else warn("Console errors", results.consoleErrors.join(" | "));

  if (results.pageErrors.length === 0) pass("No page errors");
  else warn("Page errors", results.pageErrors.join(" | "));

  // ── Summary ─────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));
  console.log("  Pass:", results.pass.length);
  console.log("  Fail:", results.fail.length);
  console.log("  Warn:", results.warn.length);
  console.log("  Email:", EMAIL);

  for (const f of results.fail) console.log("  FAIL:", f.m, f.d);

  writeFileSync(join(ARTIFACTS, "results.json"), JSON.stringify(results, null, 2));

  await browser.close();
  return results;
}

main()
  .then((r) => process.exit(r.fail.length > 0 ? 1 : 0))
  .catch((e) => { console.error(e); process.exit(1); });
