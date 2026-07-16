export type AsterApprovalStatus = "pending" | "approved" | "rejected" | "revoked" | "expired";

export type AsterAgentAccountStatus =
  | "missing"
  | "pending_approval"
  | "active"
  | "paused"
  | "revoked";

export type AsterAgentPermissions = {
  perp: boolean;
  spot: boolean;
  withdraw: boolean;
  maxFeeRate?: string;
  expiresAt?: string;
  ipWhitelist?: string[];
};

export type AsterAgentStatusView = {
  status: AsterAgentAccountStatus;
  asterAccountAddress?: string;
  signerAddress?: string;
  builderAddress?: string;
  agentStatus?: AsterApprovalStatus;
  builderStatus?: AsterApprovalStatus;
  feeRate?: string | null;
  maxFeeRate?: string | null;
  approvalExpiresAt?: number | null;
  lastValidatedAt?: number | null;
  permissions?: AsterAgentPermissions;
};

export type AsterOrderType =
  | "MARKET"
  | "LIMIT"
  | "STOP_MARKET"
  | "TAKE_PROFIT_MARKET";

export type AsterOrderRequest = {
  user: string;
  signer: string;
  symbol: string;
  side: "BUY" | "SELL";
  type: AsterOrderType;
  quantity: string;
  price?: string;
  stopPrice?: string;
  timeInForce?: "GTC" | "IOC" | "FOK" | "GTX";
  newClientOrderId?: string;
  leverage?: number;
  builder: string;
  feeRate?: string;
  reduceOnly?: boolean;
  closePosition?: boolean;
  workingType?: "CONTRACT_PRICE" | "MARK_PRICE";
  priceProtect?: boolean;
};


export type AsterStrategySubOrder = {
  strategySubId: string;
  securityType: "USDT_FUTURES";
  symbol: string;
  side: "BUY" | "SELL";
  positionSide?: "BOTH" | "LONG" | "SHORT";
  type: AsterOrderType;
  quantity?: string;
  price?: string;
  stopPrice?: string;
  timeInForce?: "GTC" | "IOC" | "FOK" | "GTX";
  workingType?: "CONTRACT_PRICE" | "MARK_PRICE";
  reduceOnly?: "true" | "false";
  closePosition?: "true" | "false";
  priceProtect?: "TRUE" | "FALSE";
  clientOrderId?: string;
  firstDrivenId?: string;
  firstDrivenOn?: string;
  firstTrigger?: string;
  secondDrivenId?: string;
  secondDrivenOn?: string;
  secondTrigger?: string;
};

export type AsterStrategyOrderRequest = {
  user: string;
  signer: string;
  clientStrategyId: string;
  strategyType: "OTOCO";
  subOrderList: AsterStrategySubOrder[];
  builder: string;
  feeRate?: string;
};

export type ExecutionAdapterReceipt = {
  provider: "aster" | "cex";
  orderId: string;
  status: "accepted" | "filled" | "rejected" | "cancelled";
  raw?: unknown;
};

export type AsterBalanceSnapshot = {
  asset: string;
  equityUsd: number;
  availableUsd: number;
  unrealizedPnlUsd?: number;
  raw: unknown;
};

export type ExecutionAdapter = {
  submitOrder(jobId: number, request: AsterOrderRequest): Promise<ExecutionAdapterReceipt>;
  cancelOrder(orderId: string): Promise<ExecutionAdapterReceipt>;
};

export type AsterRemoteAgent = {
  agentAddress?: string;
  agentName?: string;
  ipWhitelist?: string;
  expired?: number;
  source?: string;
  canRead?: boolean;
  canSpotTrade?: boolean;
  canPerpTrade?: boolean;
  canWithdraw?: boolean;
};

export type AsterRemoteBuilder = {
  userAddress?: string;
  builderAddress?: string;
  maxFeeRate?: string | number;
  builderName?: string;
};

export type AsterOrderLookupRequest = {
  user: string;
  symbol: string;
  orderId?: string;
  origClientOrderId?: string;
};

export type AsterAgentRegistrationParams = {
  agentName: string;
  agentAddress: string;
  ipWhitelist?: string;
  expired: number;
  canSpotTrade: boolean;
  canPerpTrade: boolean;
  canWithdraw: boolean;
  builder: string;
  maxFeeRate: string;
  builderName: string;
  asterChain?: string;
  user: string;
  nonce: number;
};

export type AsterManagementTypedData = {
  domain: {
    name: "AsterSignTransaction";
    version: "1";
    chainId: number;
    verifyingContract: "0x0000000000000000000000000000000000000000";
  };
  types: Record<string, Array<{ name: string; type: "string" | "bool" | "uint256" }>>;
  primaryType: "ApproveAgent";
  message: Record<string, string | boolean | number>;
};

export type AsterAgentRegistrationChallenge = {
  params: AsterAgentRegistrationParams;
  typedData: AsterManagementTypedData;
};
