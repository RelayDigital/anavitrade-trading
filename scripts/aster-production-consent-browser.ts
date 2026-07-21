import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const baseUrl = process.env.ASTER_BOOTSTRAP_BROWSER_ORIGIN
  ?? "https://anavitrade-trading.vercel.app";
const email = process.env.ASTER_BOOTSTRAP_EMAIL;
const password = process.env.ASTER_BOOTSTRAP_PASSWORD;
const screenshotPath = process.env.ASTER_BROWSER_SCREENSHOT_PATH
  ?? "output/playwright/aster-production-consent.png";
const keepOpen = process.env.ASTER_BROWSER_KEEP_OPEN === "true";

if (!email || !password) {
  throw new Error("ASTER_BOOTSTRAP_EMAIL and ASTER_BOOTSTRAP_PASSWORD are required.");
}

await mkdir(new URL("../output/playwright/", import.meta.url), { recursive: true });
const browser = await chromium.launch({ headless: process.env.ASTER_BROWSER_HEADED !== "true" });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const browserErrors: string[] = [];
page.on("console", (message) => {
  if (message.type() === "error") browserErrors.push(message.text());
});

try {
  await page.goto(`${baseUrl}/login`, { waitUntil: "networkidle" });
  await page.getByPlaceholder("alex@example.com").fill(email);
  await page.getByPlaceholder("Your password").fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL("**/dashboard", { timeout: 15_000 });

  await page.goto(`${baseUrl}/onboarding/aster`, { waitUntil: "networkidle" });
  await page.getByText("Anavitrade never signs this authorization on your behalf", { exact: false }).waitFor();
  await page.getByText("renewal requires another wallet signature", { exact: false }).waitFor();
  await page.getByText("typed-data signing domain (chain 56)", { exact: false }).waitFor();
  await page.getByText("No withdrawal access", { exact: true }).waitFor();
  await page.screenshot({ path: screenshotPath, fullPage: true });

  console.log(JSON.stringify({
    status: "ASTER_PRODUCTION_CONSENT_BROWSER_PASS",
    url: page.url(),
    screenshotPath,
    keepOpen,
  }));
  if (keepOpen) await new Promise<void>(() => undefined);
} catch (error) {
  const failureScreenshotPath = screenshotPath.replace(/\.png$/, "-failure.png");
  await page.screenshot({ path: failureScreenshotPath, fullPage: true }).catch(() => undefined);
  console.error(JSON.stringify({
    status: "ASTER_PRODUCTION_CONSENT_BROWSER_FAILED",
    url: page.url(),
    title: await page.title().catch(() => ""),
    headings: await page.getByRole("heading").allTextContents().catch(() => []),
    buttons: await page.getByRole("button").allTextContents().catch(() => []),
    hasConsentCopy: await page.getByText("Anavitrade never signs this authorization on your behalf", { exact: false }).count() > 0,
    browserErrors,
    failureScreenshotPath,
    error: error instanceof Error ? error.message : String(error),
  }));
  throw error;
} finally {
  await browser.close();
}
