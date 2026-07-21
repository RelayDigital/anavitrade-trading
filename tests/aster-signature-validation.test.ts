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
    signatureChainId: 1666,
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

await assert.rejects(
  signAsterRegistrationTypedData({
    provider,
    account,
    signatureChainId: 56,
    typedData: {
      domain: {
        name: "AsterSignTransaction",
        version: "1",
        chainId: 56,
        verifyingContract: "0x0000000000000000000000000000000000000000",
      },
      types: { Message: [{ name: "msg", type: "string" }] },
      primaryType: "Message",
      message: {
        msg: new URLSearchParams({
          user: account,
          nonce: "1784444809000000",
          agentName: "Anavitrade",
          agentAddress: "0x4444444444444444444444444444444444444444",
          expired: "1787036809517",
          signatureChainId: "56",
          canSpotTrade: "false",
          canPerpTrade: "true",
          canWithdraw: "true",
          ipWhitelist: "",
        }).toString(),
      },
    },
  }),
  /Invalid Aster agent permissions/,
);

assert.equal(providerCalls, 0, "withdraw-capable Agent challenges must fail before opening the wallet prompt");

console.log("ASTER_SIGNATURE_VALIDATION_TEST_PASS");
