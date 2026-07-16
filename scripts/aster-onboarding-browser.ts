import { chromium, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const BASE_URL = process.env.ASTER_BROWSER_BASE_URL ?? "http://127.0.0.1:5174";
const ARTIFACTS_DIR = process.env.ASTER_BROWSER_ARTIFACTS_DIR ?? "e2e-artifacts/aster-onboarding";
const PASSWORD = "BrowserAster123!";
const now = Date.now();
const email = process.env.ASTER_BROWSER_EMAIL ?? `aster-browser+${now}@anavitrade.test`;
const privateKey = (process.env.ASTER_BROWSER_WALLET_PRIVATE_KEY ?? generatePrivateKey()) as `0x${string}`;
const account = privateKeyToAccount(privateKey);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function screenshot(page: Page, name: string) {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  await page.screenshot({ path: join(ARTIFACTS_DIR, name), fullPage: true });
}

async function installInjectedWallet(page: Page) {
  await page.context().exposeFunction("__anaviSignTypedData", async (raw: string) => {
    const typedData = JSON.parse(raw);
    return account.signTypedData({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
    });
  });

  await page.addInitScript(({ address }) => {
    const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    const emit = (event: string, ...args: unknown[]) => {
      for (const fn of listeners[event] ?? []) fn(...args);
    };
    const chainIdHex = "0x1";
    const provider = {
      isMetaMask: true,
      selectedAddress: address,
      chainId: chainIdHex,
      on(event: string, cb: (...args: unknown[]) => void) {
        listeners[event] = listeners[event] ?? [];
        listeners[event].push(cb);
      },
      removeListener(event: string, cb: (...args: unknown[]) => void) {
        listeners[event] = (listeners[event] ?? []).filter((fn) => fn !== cb);
      },
      async request(args: { method: string; params?: unknown[] }) {
        switch (args.method) {
          case "eth_requestAccounts":
            emit("accountsChanged", [address]);
            return [address];
          case "eth_accounts":
            return [address];
          case "eth_chainId":
            return chainIdHex;
          case "net_version":
            return "1";
          case "wallet_requestPermissions":
            return [{ parentCapability: "eth_accounts" }];
          case "wallet_switchEthereumChain":
          case "wallet_addEthereumChain":
            return null;
          case "personal_sign":
            throw new Error("personal_sign is not supported by the test wallet");
          case "eth_signTypedData_v4": {
            const params = args.params ?? [];
            const payload = typeof params[1] === "string" ? params[1] : JSON.stringify(params[1]);
            return (window as any).__anaviSignTypedData(payload);
          }
          default:
            throw new Error(`Unsupported injected wallet method: ${args.method}`);
        }
      },
    };

    Object.defineProperty(window, "ethereum", {
      value: provider,
      configurable: true,
    });
    Object.defineProperty(window, "anaviInjectedWalletAddress", {
      value: address,
      configurable: true,
    });
  }, { address: account.address });
}

async function main() {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  console.log("[aster-browser] base", BASE_URL);
  console.log("[aster-browser] email", email);
  console.log("[aster-browser] wallet", account.address);

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1366, height: 960 } });
  const page = await context.newPage();
  await installInjectedWallet(page);

  const apiEvents: Array<{ method?: string; url: string; status?: number; body?: string }> = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/")) {
      apiEvents.push({ method: req.method(), url: req.url() });
    }
  });
  page.on("response", async (res) => {
    if (!res.url().includes("/api/")) return;
    let body = "";
    if (res.status() >= 400) {
      try { body = (await res.text()).slice(0, 1000); } catch {}
    }
    apiEvents.push({ url: res.url(), status: res.status(), body });
    if (res.status() >= 400) {
      console.log("[aster-browser] api-error", res.status(), res.url(), body);
    }
  });
  page.on("pageerror", (err) => console.log("[aster-browser] page-error", err.message));
  page.on("console", (msg) => {
    if (["error", "warning"].includes(msg.type())) {
      console.log(`[aster-browser] console-${msg.type()}`, msg.text());
    }
  });

  try {
    await page.goto(`${BASE_URL}/register`, { waitUntil: "domcontentloaded" });
    await page.getByPlaceholder("Jane Smith").fill("Aster Browser");
    await page.getByPlaceholder("you@example.com").fill(email);
    await page.getByPlaceholder("Min 8 characters").fill(PASSWORD);
    await page.getByPlaceholder("Re-enter your password").fill(PASSWORD);
    await screenshot(page, "01-register-filled.png");
    await page.getByRole("button", { name: /^Create Account$/ }).click();
    await page.waitForURL(/\/dashboard/, { timeout: 30000 });
    await screenshot(page, "02-dashboard.png");

    await page.goto(`${BASE_URL}/onboarding/aster`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: /One-click Aster Activation/i }).waitFor({ timeout: 20000 });
    await screenshot(page, "03-aster-onboarding.png");

    await page.getByRole("button", { name: /Connect Wallet & Activate/i }).click();
    await page.getByRole("button", { name: /MetaMask/i }).click();
    await page.getByText(/Wallet Connected/i).waitFor({ timeout: 20000 });
    await page.waitForTimeout(1000);
    await screenshot(page, "04-wallet-connected.png");
    await page.getByRole("button", { name: /Sign & Activate Aster/i }).waitFor({ timeout: 20000 });

    await page.getByRole("button", { name: /Sign & Activate Aster/i }).click();
    await Promise.race([
      page.getByText(/Already Active|Activated! Redirecting|Active - ready|Active . ready/i).waitFor({ timeout: 90000 }),
      page.getByText(/Failed to activate Aster|Failed to register Aster|registration/i).waitFor({ timeout: 90000 }),
    ]);
    await sleep(1000);
    await screenshot(page, "05-after-activation.png");

    const body = await page.locator("body").innerText();
    const active = /Already Active|Activated! Redirecting|Active\s*.\s*ready/i.test(body);
    if (!active) {
      throw new Error(`Aster activation did not reach active state. Visible text: ${body.slice(0, 1000)}`);
    }

    console.log("[aster-browser] ASTER_BROWSER_ONBOARDING_PASS");
  } catch (error: any) {
    await screenshot(page, "failure.png").catch(() => {});
    console.log("[aster-browser] API events");
    for (const event of apiEvents.slice(-20)) {
      console.log(JSON.stringify(event));
    }
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error("[aster-browser] ASTER_BROWSER_ONBOARDING_FAIL", error?.message ?? error);
  process.exit(1);
});
