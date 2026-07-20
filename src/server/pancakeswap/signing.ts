import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { AllowanceTransfer } from "@pancakeswap/permit2-sdk";
import type { PancakeswapPermitSingle, PancakeswapPermitTypedData } from "./types";

/**
 * Builds the Permit2 PermitSingle EIP-712 typed-data challenge for the user to
 * sign, via PancakeSwap's own permit2-sdk (guarantees the domain/types match
 * exactly what their Permit2 deployment expects — hand-rolling this is a real
 * footgun since PancakeSwap's Permit2 is a separate deployment from Uniswap's).
 */
export function buildPermitSingleTypedData(input: {
  chainId: number;
  permit2Address: string;
  permit: PancakeswapPermitSingle;
}): PancakeswapPermitTypedData {
  const data = AllowanceTransfer.getPermitData(
    input.permit,
    input.permit2Address as `0x${string}`,
    input.chainId,
  );
  return {
    domain: {
      name: "Permit2",
      chainId: input.chainId,
      verifyingContract: input.permit2Address,
    },
    types: { PermitSingle: data.types.PermitSingle, PermitDetails: data.types.PermitDetails },
    primaryType: "PermitSingle",
    message: {
      details: {
        token: String(data.values.details.token),
        amount: String(data.values.details.amount),
        expiration: Number(data.values.details.expiration),
        nonce: Number(data.values.details.nonce),
      },
      spender: String(data.values.spender),
      sigDeadline: Number(data.values.sigDeadline),
    },
  };
}

/**
 * Custodial-scaffold-only helper (not used by the live Permit2 path). Mirrors
 * aster/signing.ts's agent keypair generation.
 */
export function createPancakeswapAgentKeypair() {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  return { signerAddress: account.address.toLowerCase(), privateKey };
}
