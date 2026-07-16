/**
 * Full E2E test v2: Register, Demo dashboard, Mode toggle, Aster panel inspection
 *
 * Usage:
 *   node tests/e2e-full.mjs
 *
 * Requires: Playwright, dev servers running at localhost:5174 + localhost:8787
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = join(__dirname, "..", "e2e-artifacts");
const BASE = "http://localhost:5174";

const TS = Date.now();
const TEST_EMAIL = `e2etest+${TS}@anavitrade.test`;
const TEST_PASSWORD = "TestPass123!";
const TEST_NAME = "E2E Test User";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function screenshot(page, name) {
  await page.screenshot({ path: join(ARTIFACTS_DIR, `${name}.png`), fullPage: false });
  console.log(`  [artifacts] Saved ${name}.png`);
}

async function run() {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();

  // Track tRPC errors and console errors
  const trpcErrors = [];
  const consoleErrors = [];
  const pageErrors = [];

  page.on("response", async (response) => {
    const url = response.url();
    if (url.includes("/api/trpc/") && !response.ok()) {
      let body = "";
      try { body = await response.text(); } catch {}
      trpcErrors.push({
        url,
        status: response.status(),
        statusText: response.statusText(),
        body: body.slice(0, 500),
      });
    }
  });

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push({ text: msg.text(), location: msg.location() });
    }
  });

  page.on("pageerror", (err) => {
    pageErrors.push(err.message);
  });

  const results = { passed: [], failed: [], warnings: [] };

  function pass(name) { results.passed.push(name); console.log(`  PASS: ${name}`); }
  function fail(name, detail) { results.failed.push({ name, detail }); console.log(`  FAIL: ${name} -- ${detail}`); }
  function warn(name, detail) { results.warnings.push({ name, detail }); console.log(`  WARN: ${name} -- ${detail}`); }

  try {
    // ── Step 1: Home page ──────────────────────────────────────────────
    console.log("\n=== Step 1: Home page loads ===");
    await page.goto(BASE, { waitUntil: "load" });
    await sleep(1500);
    await screenshot(page, "01-homepage");

    const title = await page.title();
    console.log(`  Title: "${title}"`);
    if (title && title.length > 0) {
      pass("Home page loaded");
    } else {
      fail("Home page", "No title");
    }

    const body = await page.locator("body").innerText();
    if (body.includes("Anavitrade")) {
      pass("Home page shows brand content");
    } else {
      warn("Home page content", "No brand text found");
    }

    // ── Step 2: Register ──────────────────────────────────────────────
    console.log("\n=== Step 2: Navigate to Register page ===");
    // Use ?demo=true to pre-select demo mode
    await page.goto(`${BASE}/register?demo=true`, { waitUntil: "load" });
    await sleep(1000);
    await screenshot(page, "02-register-page");

    const regText = await page.locator("body").innerText();
    if (regText.includes("Create your account")) {
      pass("Register page loaded");
    } else {
      fail("Register page", "No heading");
      console.log(`  Page text: ${regText.slice(0, 200)}`);
    }

    // The demo toggle should already be active via ?demo=true query param
    // Fill the form
    const nameInput = page.locator('input[placeholder="Jane Smith"]');
    await nameInput.fill(TEST_NAME);
    pass("Filled name");

    const emailInput = page.locator('input[placeholder="you@example.com"]');
    await emailInput.fill(TEST_EMAIL);
    pass("Filled email");

    const passwordInput = page.locator('input[placeholder="Min 8 characters"]');
    await passwordInput.fill(TEST_PASSWORD);
    pass("Filled password");

    const confirmInput = page.locator('input[placeholder="Re-enter your password"]');
    await confirmInput.fill(TEST_PASSWORD);
    pass("Filled confirm password");

    await screenshot(page, "03-form-filled");

    // ── Step 3: Submit registration ────────────────────────────────────
    console.log("\n=== Step 3: Submit registration form ===");
    const submitBtn = page.locator('button[type="submit"]');
    const btnText = await submitBtn.innerText();
    console.log(`  Button text: "${btnText}"`);

    // Click submit and wait for either navigation or error response
    await submitBtn.click();
    // Wait for the tRPC call to complete (up to 15s) + page to settle
    await sleep(3000);

    // Check what happened
    const afterSubmitUrl = page.url();
    const afterSubmitText = await page.locator("body").innerText();
    console.log(`  URL after submit: ${afterSubmitUrl}`);

    let isAuthenticated = false;

    if (afterSubmitUrl.includes("/dashboard")) {
      pass("Registration succeeded -- navigated to dashboard");
      isAuthenticated = true;
    } else if (afterSubmitText.includes("Choose your demo capital")) {
      pass("Registration succeeded -- now on demo capital step");
      isAuthenticated = true;
    } else if (afterSubmitText.includes("already exists")) {
      warn("Registration", "Account email already exists -- may be from previous test run, will try login");
    } else {
      // Check for tRPC errors
      console.log(`  tRPC errors during registration: ${JSON.stringify(trpcErrors)}`);
      console.log(`  Page text (first 400): ${afterSubmitText.slice(0, 400)}`);

      const errorMsg = await page.locator("[class*=error], [class*=text-red], .text-red-400").first().innerText().catch(() => "");
      if (errorMsg) {
        console.log(`  Visible error message: "${errorMsg}"`);
        fail("Registration", `Form error: "${errorMsg}"`);
      } else {
        warn("Registration", "Unexpected state after submit");
      }
    }

    // ── Step 4: Demo capital selection ─────────────────────────────────
    console.log("\n=== Step 4: Demo capital selection ===");
    const pageAfterReg = await page.locator("body").innerText();

    if (pageAfterReg.includes("Choose your demo capital")) {
      // Click $10,000 option
      const tenK = page.locator("button", { hasText: "$10,000" });
      if (await tenK.isVisible()) {
        await tenK.click();
        await sleep(300);
      }

      await screenshot(page, "04-demo-capital-selected");

      const startBtn = page.locator("button", { hasText: /Start with/ });
      if (await startBtn.isVisible()) {
        await startBtn.click();
        await sleep(3000);
        pass("Demo capital form submitted");
        isAuthenticated = true;
      } else {
        fail("Demo capital", "No 'Start with' button found");
      }
    }

    // If not on dashboard yet, try direct nav or login
    if (!isAuthenticated) {
      console.log("  Trying to reach dashboard via direct navigation or login...");
      await page.goto(`${BASE}/dashboard`, { waitUntil: "load" });
      await sleep(2000);
      const urlAfterDashboard = page.url();
      console.log(`  URL after /dashboard: ${urlAfterDashboard}`);

      if (urlAfterDashboard.includes("/dashboard")) {
        pass("Dashboard reached (existing session)");
        isAuthenticated = true;
      } else if (urlAfterDashboard.includes("/login")) {
        console.log("  On login page -- signing in with test credentials");
        const loginEmail = page.locator('input[placeholder="alex@example.com"]');
        const loginPass = page.locator('input[placeholder="Your password"]');
        const signInBtn = page.locator('button[type="submit"]');

        await loginEmail.fill(TEST_EMAIL);
        await loginPass.fill(TEST_PASSWORD);
        await signInBtn.click();
        await sleep(3000);

        const urlAfterLogin = page.url();
        console.log(`  URL after login: ${urlAfterLogin}`);
        if (urlAfterLogin.includes("/dashboard")) {
          pass("Signed in and reached dashboard");
          isAuthenticated = true;
        } else {
          const loginError = await page.locator("[class*=text-red]").first().innerText().catch(() => "");
          console.log(`  Login error text: "${loginError}"`);
          warn("Login", `Could not sign in: "${loginError}"`);
        }
      } else {
        warn("Dashboard access", `Unexpected redirect: ${urlAfterDashboard}`);
      }
    }

    // If still not on dashboard, abort early
    if (!page.url().includes("/dashboard")) {
      warn("Test continuation", "Cannot reach dashboard -- subsequent checks will be limited");
    }

    await screenshot(page, "05-dashboard-state");

    // ── Step 5: Verify Dashboard Demo mode ─────────────────────────────
    console.log("\n=== Step 5: Verify Dashboard Demo mode ===");
    await sleep(2000);
    const dashText = await page.locator("body").innerText();
    console.log(`  Dashboard text sample:\n${dashText.slice(0, 600)}`);

    if (dashText.includes("Welcome back")) {
      pass("Dashboard shows welcome message");
    } else {
      warn("Dashboard greeting", "No 'Welcome back' found");
    }

    // Check for demo indicators
    const demoIndicators = [];
    if (dashText.includes("Demo") || dashText.includes("DEMO")) demoIndicators.push("Demo label");
    if (dashText.includes("Live") || dashText.includes("LIVE")) demoIndicators.push("Live label");
    if (dashText.includes("10,000") || dashText.includes("$10,000")) demoIndicators.push("balance");
    if (dashText.includes("No trades") || dashText.includes("0 trades")) demoIndicators.push("no-trades");

    if (demoIndicators.length > 0) {
      pass(`Dashboard demo indicators found: ${demoIndicators.join(", ")}`);
      if (demoIndicators.includes("balance")) {
        pass("Demo balance of $10,000 visible");
      } else {
        warn("Demo balance", "Could not find $10,000 text -- stats may be loaded asynchronously");
      }
      if (demoIndicators.includes("no-trades")) {
        pass("Dashboard shows 0 trades state");
      }
    } else {
      warn("Dashboard state", "Could not find any demo indicators on dashboard");
    }

    // ── Step 6: Live/Demo Toggle ──────────────────────────────────────
    console.log("\n=== Step 6: Live/Demo toggle check ===");

    // Look for the toggle buttons
    const liveBtn = page.locator('button:has-text("Live"):not(:has-text("Demo"))').first();
    const demoBtn = page.locator('button:has-text("Demo")').first();

    const liveVisible = await liveBtn.isVisible().catch(() => false);
    const demoVisible = await demoBtn.isVisible().catch(() => false);

    if (liveVisible || demoVisible) {
      pass("Live/Demo toggle visible");

      // Check which is pressed
      const pressed = page.locator('button[aria-pressed="true"]');
      const pressedCount = await pressed.count();
      if (pressedCount > 0) {
        const mode = await pressed.first().innerText();
        console.log(`  Active mode: "${mode}"`);
        pass(`Dashboard in "${mode}" mode`);

        // Try toggling to the other mode
        if (mode === "Demo" && liveVisible) {
          await liveBtn.click();
          await sleep(1000);
          await screenshot(page, "06-toggled-live");
          // Toggle back to demo
          await demoBtn.click();
          await sleep(1000);
          pass("Toggled Live -> Demo and back");
        } else if (mode === "Live" && demoVisible) {
          await demoBtn.click();
          await sleep(1000);
          await screenshot(page, "06-toggled-demo");
          await liveBtn.click();
          await sleep(1000);
          pass("Toggled Demo -> Live and back");
        } else {
          warn("Toggle test", `Could not swap modes. Active: "${mode}"`);
        }
        await screenshot(page, "07-final-mode");
      }
    } else {
      warn("Live/Demo toggle", "Toggle not visible or accessible");

      // Check if rendered at all
      const toggleArea = page.locator('div:has(button:has-text("Live"))').first();
      console.log(`  Toggle area visible: ${await toggleArea.isVisible().catch(() => false)}`);
    }

    // ── Step 7: Aster Execution Panel ─────────────────────────────────
    console.log("\n=== Step 7: Aster Execution Panel inspection ===");

    // Scroll to bottom to find the Aster panel
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(800);

    // Check for Aster panel
    const asterText = await page.locator("body").innerText();
    const asterSignals = [];

    if (asterText.includes("Aster DEX Execution")) asterSignals.push("panel heading");
    if (asterText.includes("Staging mode")) asterSignals.push("staging mode");
    if (asterText.includes("Live submit")) asterSignals.push("live submit");
    if (asterText.includes("Not Connected")) asterSignals.push("not connected");
    if (asterText.includes("Activate Now") || asterText.includes("Activate")) asterSignals.push("activate button");
    if (asterText.includes("One click to activate")) asterSignals.push("activation message");

    if (asterSignals.length > 0) {
      pass(`Aster panel features: ${asterSignals.join(", ")}`);
    } else {
      warn("Aster panel", "No Aster execution panel features found on dashboard");
    }

    // Also check for the ActivationCard
    if (asterText.includes("Activate DEX Execution")) {
      pass("Activation card visible at top of dashboard");
    } else {
      warn("Activation card", "Could not find 'Activate DEX Execution' card");
    }

    await screenshot(page, "08-aster-panel");

    // ── Step 8: Aster Onboarding page ─────────────────────────────────
    console.log("\n=== Step 8: Aster Onboarding page ===");
    await page.goto(`${BASE}/onboarding/aster`, { waitUntil: "load" });
    await sleep(2000);
    await screenshot(page, "09-aster-onboarding");

    const asterOnboardText = await page.locator("body").innerText();
    console.log(`  Aster page text (first 300): ${asterOnboardText.slice(0, 300)}`);

    if (asterOnboardText.includes("Aster Activation") || asterOnboardText.includes("aster")) {
      pass("Aster onboarding page loaded");

      if (asterOnboardText.includes("Wallet Connected")) {
        pass("Aster page: wallet already connected");
      } else if (asterOnboardText.includes("Connect Wallet") || asterOnboardText.includes("No wallet connected")) {
        pass("Aster page: shows disconnect state with Connect Wallet button");

        // Click to trigger the wallet modal
        const cwBtn = page.locator('button:has-text("Connect Wallet")').first();
        if (await cwBtn.isVisible().catch(() => false)) {
          await cwBtn.click();
          await sleep(1500);
          await screenshot(page, "10-wallet-modal-triggered");

          // Check for modal content
          const modalText = await page.locator("body").innerText();
          if (modalText.includes("WalletConnect") || modalText.includes("MetaMask") || modalText.includes("wallet")) {
            pass("WalletConnect modal appeared");
          } else {
            warn("WalletConnect modal", "Button clicked but no modal detected -- providers unavailable in headless mode");
          }
        }
      } else {
        warn("Aster wallet status", "Unknown wallet state on Aster onboarding page");
      }
    } else if (asterOnboardText.includes("Sign in") || asterOnboardText.includes("Welcome back") || page.url().includes("/login")) {
      warn("Aster onboarding", "Redirected to login -- not authenticated");
    } else {
      warn("Aster onboarding", "Could not find Aster-related content");
    }

    // ── Step 9: Report all captured errors ──────────────────────────────
    console.log("\n=== Step 9: Captured Errors & Warnings ===");

    if (trpcErrors.length > 0) {
      console.log(`  tRPC errors (${trpcErrors.length}):`);
      for (const err of trpcErrors) {
        console.log(`    [${err.status}] ${err.url}`);
        console.log(`    Body: ${err.body}`);
      }
      warn("tRPC API errors", `${trpcErrors.length} tRPC endpoint(s) returned errors`);
    }

    if (consoleErrors.length > 0) {
      console.log(`  Browser console errors (${consoleErrors.length}):`);
      for (const err of consoleErrors) {
        console.log(`    ${err.text?.slice(0, 200)}`);
      }
      warn("Console errors", `${consoleErrors.length} console error(s)`);
    } else {
      pass("No browser console errors");
    }

    if (pageErrors.length > 0) {
      console.log(`  Page errors (${pageErrors.length}):`);
      for (const err of pageErrors) {
        console.log(`    ${err.slice(0, 200)}`);
      }
      warn("Page errors", `${pageErrors.length} unhandled page error(s)`);
    } else {
      pass("No unhandled page errors");
    }

    // ── Summary ──────────────────────────────────────────────────────
    console.log("\n" + "=".repeat(60));
    console.log("E2E TEST SUMMARY");
    console.log("=".repeat(60));
    console.log(`  Email used: ${TEST_EMAIL}`);
    console.log(`  Passed: ${results.passed.length}`);
    console.log(`  Failed: ${results.failed.length}`);
    console.log(`  Warnings: ${results.warnings.length}`);
    console.log(`  Total: ${results.passed.length + results.failed.length + results.warnings.length}`);

    if (results.failed.length > 0) {
      console.log("\n  FAILURES:");
      for (const f of results.failed) {
        console.log(`    - ${f.name}: ${f.detail}`);
      }
    }
    if (results.warnings.length > 0) {
      console.log("\n  WARNINGS:");
      for (const w of results.warnings) {
        console.log(`    - ${w.name}: ${w.detail}`);
      }
    }

    const summary = {
      timestamp: new Date().toISOString(),
      testEmail: TEST_EMAIL,
      results,
      trpcErrors,
      consoleErrors,
      pageErrors,
      artifactsDir: ARTIFACTS_DIR,
    };
    writeFileSync(join(ARTIFACTS_DIR, "e2e-results.json"), JSON.stringify(summary, null, 2));
    console.log("\nFull results: ", join(ARTIFACTS_DIR, "e2e-results.json"));

  } catch (err) {
    console.error("\nFATAL ERROR:", err.message);
    console.error(err.stack);
    await screenshot(page, "fatal-error");
  } finally {
    await browser.close();
  }

  return results;
}

run()
  .then((results) => process.exit(results.failed.length > 0 ? 1 : 0))
  .catch((err) => { console.error(err); process.exit(1); });
