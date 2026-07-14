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
  permissions?: AsterAgentPermissions;
};

export type AsterOrderRequest = {
  user: string;
  signer: string;
  symbol: string;
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT";
  quantity: string;
  price?: string;
  leverage?: number;
  builder: string;
  feeRate?: string;
};

export type ExecutionAdapterReceipt = {
  provider: "aster" | "cex";
  orderId: string;
  status: "accepted" | "filled" | "rejected";
  raw?: unknown;
};

export type ExecutionAdapter = {
  submitOrder(jobId: number, request: AsterOrderRequest): Promise<ExecutionAdapterReceipt>;
  cancelOrder(orderId: string): Promise<ExecutionAdapterReceipt>;
};
