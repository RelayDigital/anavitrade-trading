import assert from "node:assert/strict";
import { chromium } from "playwright";
import { installInjectedWallet } from "../scripts/aster-injected-wallet";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const pageErrors: string[] = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

const address = "0x3333333333333333333333333333333333333333" as const;
await installInjectedWallet(page, address, async () => "0xabcdef");
await page.goto("data:text/html,<title>wallet-check</title>");

const result = await page.evaluate(async () => {
  const provider = (window as any).ethereum;
  return {
    accounts: await provider.request({ method: "eth_accounts" }),
    chainId: await provider.request({ method: "eth_chainId" }),
    signature: await provider.request({
      method: "eth_signTypedData_v4",
      params: [provider.selectedAddress, JSON.stringify({ primaryType: "ApproveAgent" })],
    }),
  };
});

assert.deepEqual(result, { accounts: [address], chainId: "0x1", signature: "0xabcdef" });
assert.deepEqual(pageErrors, []);

await browser.close();
console.log("ASTER_INJECTED_WALLET_TEST_PASS");
