import type { ExecutionAdapter, ExecutionAdapterReceipt } from "../aster/types";

export type PancakeswapDelegationStatus = "pending" | "active" | "expired" | "revoked";

/** Permit2 AllowanceTransfer.PermitDetails — matches Permit2's on-chain struct exactly. */
export type PancakeswapPermitDetails = {
  token: string;
  amount: string; // uint160, decimal string
  expiration: number; // uint48, unix seconds
  nonce: number; // uint48
};

/** Permit2 AllowanceTransfer.PermitSingle — the EIP-712 message the user signs. */
export type PancakeswapPermitSingle = {
  details: PancakeswapPermitDetails;
  spender: string;
  sigDeadline: number; // uint256, unix seconds
};

export type PancakeswapPermitTypedData = {
  domain: {
    name: "Permit2";
    chainId: number;
    verifyingContract: string;
  };
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: "PermitSingle";
  message: {
    details: {
      token: string;
      amount: string;
      expiration: number;
      nonce: number;
    };
    spender: string;
    sigDeadline: number;
  };
};

export type PancakeswapDelegationChallenge = {
  chainId: number;
  permit2Address: string;
  spenderAddress: string;
  typedData: PancakeswapPermitTypedData;
};

export type PancakeswapSwapRequest = {
  userWalletAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  side: "BUY" | "SELL";
  newClientOrderId?: string;
};

export type PancakeswapExecutionAdapter = ExecutionAdapter;
export type { ExecutionAdapterReceipt };
