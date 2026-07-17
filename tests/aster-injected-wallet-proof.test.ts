import assert from "node:assert/strict";
import { chromium } from "playwright";
import { installInjectedWallet } from "../scripts/aster-injected-wallet";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const address = "0x3333333333333333333333333333333333333333" as const;

await installInjectedWallet(page, address, async () => "0xabcdef", 1666);
await page.goto("data:text/html,<title>aster-proof</title>");

await page.evaluate(async () => {
  const provider = (window as any).ethereum;
  await provider.request({
    method: "eth_signTypedData_v4",
    params: [provider.selectedAddress, JSON.stringify({
      domain: { chainId: 1666 },
      primaryType: "ApproveAgent",
      message: { CanWithdraw: false },
    })],
  });
});

const proof = await page.evaluate(() => {
  const provider = (window as any).ethereum;
  return {
    rpcCalls: provider.rpcCalls,
    signature: provider.lastAsterSignature,
    typedData: provider.lastAsterTypedData,
  };
});

assert.equal(proof.rpcCalls.filter((call: { method: string }) => call.method === "eth_signTypedData_v4").length, 1);
assert.equal(proof.signature, "0xabcdef");
assert.equal(proof.typedData.domain.chainId, 1666);
await assert.rejects(
  page.evaluate(() => (window as any).ethereum.request({ method: "wallet_switchEthereumChain" })),
  /must not switch wallet chains/,
);

await browser.close();
console.log("ASTER_INJECTED_WALLET_PROOF_TEST_PASS");
