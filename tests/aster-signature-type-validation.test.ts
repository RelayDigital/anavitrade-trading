import assert from "node:assert/strict";
import { signAsterRegistrationTypedData } from "../src/lib/asterWalletSignature";

let providerCalls = 0;
const account = "0x3333333333333333333333333333333333333333" as const;

await assert.rejects(
  signAsterRegistrationTypedData({
    provider: {
      async request() {
        providerCalls += 1;
        return "0xabcdef";
      },
    },
    account,
    signatureChainId: 1666,
    typedData: {
      domain: {
        name: "AsterSignTransaction",
        version: "1",
        chainId: 1666,
        verifyingContract: "0x0000000000000000000000000000000000000000",
      },
      types: { Unsupported: [{ name: "msg", type: "string" }] },
      primaryType: "Unsupported",
      message: { msg: "not an agent approval" },
    },
  }),
  /Invalid Aster signature challenge type/,
);

assert.equal(providerCalls, 0);

console.log("ASTER_SIGNATURE_TYPE_VALIDATION_TEST_PASS");
