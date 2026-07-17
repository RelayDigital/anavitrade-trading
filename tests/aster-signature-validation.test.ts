import assert from "node:assert/strict";
import { signAsterRegistrationTypedData } from "../src/lib/asterWalletSignature";

let providerCalls = 0;
const provider = {
  async request() {
    providerCalls += 1;
    return "0xabcdef";
  },
};

const account = "0x3333333333333333333333333333333333333333" as const;

await assert.rejects(
  signAsterRegistrationTypedData({
    provider,
    account,
    typedData: {
      domain: {
        name: "NotAster",
        version: "1",
        chainId: 1666,
        verifyingContract: "0x0000000000000000000000000000000000000000",
      },
      types: { ApproveAgent: [{ name: "User", type: "string" }] },
      primaryType: "ApproveAgent",
      message: { User: account, CanPerpTrade: true, CanWithdraw: false },
    },
  }),
  /Invalid Aster signature challenge/,
);

assert.equal(providerCalls, 0, "invalid server challenges must fail before opening the wallet prompt");

console.log("ASTER_SIGNATURE_VALIDATION_TEST_PASS");
