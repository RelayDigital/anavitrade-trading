type Eip1193Provider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};

type AsterTypedData = {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const REQUIRED_APPROVE_AGENT_FIELDS = [
  "AgentName",
  "AgentAddress",
  "IpWhitelist",
  "Expired",
  "CanSpotTrade",
  "CanPerpTrade",
  "CanWithdraw",
  "Builder",
  "MaxFeeRate",
  "BuilderName",
  "User",
  "Nonce",
];
const REQUIRED_AGENT_MESSAGE_FIELDS = [
  "user",
  "nonce",
  "agentName",
  "agentAddress",
  "expired",
  "signatureChainId",
  "canSpotTrade",
  "canPerpTrade",
  "canWithdraw",
];

function isAddressLike(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function validateAsterRegistrationTypedData(input: {
  account: `0x${string}`;
  signatureChainId: number;
  typedData: AsterTypedData;
}): void {
  const { account, signatureChainId, typedData } = input;
  if (typedData.domain?.name !== "AsterSignTransaction" || typedData.domain?.version !== "1") {
    throw new Error("Invalid Aster signature challenge.");
  }
  if (typedData.domain?.chainId !== signatureChainId) {
    throw new Error("Invalid Aster signature chain.");
  }
  if (String(typedData.domain?.verifyingContract ?? "").toLowerCase() !== ZERO_ADDRESS) {
    throw new Error("Invalid Aster signature verifier.");
  }
  if (typedData.primaryType === "Message") {
    if (typeof typedData.message?.msg !== "string" || typedData.message.msg.length === 0) {
      throw new Error("Invalid Aster signature message.");
    }
    const fields = typedData.types?.Message ?? [];
    if (fields.length !== 1 || fields[0]?.name !== "msg" || fields[0]?.type !== "string") {
      throw new Error("Invalid Aster signature fields.");
    }
    const params = new URLSearchParams(typedData.message.msg);
    if (REQUIRED_AGENT_MESSAGE_FIELDS.some((field) => params.getAll(field).length !== 1)) {
      throw new Error("Invalid Aster signature fields.");
    }
    if (!isAddressLike(params.get("user")) || !isAddressLike(params.get("agentAddress"))) {
      throw new Error("Invalid Aster signature addresses.");
    }
    if (params.get("user")!.toLowerCase() !== account.toLowerCase()) {
      throw new Error("Aster signature account mismatch.");
    }
    if (params.get("signatureChainId") !== String(signatureChainId)) {
      throw new Error("Invalid Aster signature chain.");
    }
    if (
      params.get("canSpotTrade") !== "false"
      || params.get("canPerpTrade") !== "true"
      || params.get("canWithdraw") !== "false"
    ) {
      throw new Error("Invalid Aster agent permissions.");
    }
    if (
      !/^\d+$/.test(params.get("nonce")!)
      || !/^\d+$/.test(params.get("expired")!)
      || !params.get("agentName")!.trim()
    ) {
      throw new Error("Invalid Aster signature fields.");
    }
    return;
  }
  if (typedData.primaryType !== "ApproveAgent") {
    throw new Error("Invalid Aster signature challenge type.");
  }
  const fields = typedData.types?.ApproveAgent ?? [];
  const fieldNames = new Set(fields.map((field) => field.name));
  if (!fields.length || REQUIRED_APPROVE_AGENT_FIELDS.some((field) => !fieldNames.has(field))) {
    throw new Error("Invalid Aster signature fields.");
  }
  if (typedData.message?.CanWithdraw !== false || typedData.message?.CanPerpTrade !== true) {
    throw new Error("Invalid Aster agent permissions.");
  }
  if (!isAddressLike(typedData.message?.AgentAddress) || !isAddressLike(typedData.message?.Builder) || !isAddressLike(typedData.message?.User)) {
    throw new Error("Invalid Aster signature addresses.");
  }
  if (String(typedData.message.User).toLowerCase() !== account.toLowerCase()) {
    throw new Error("Aster signature account mismatch.");
  }
}

/**
 * Aster's EIP-712 signing domain uses a fixed chainId (1666 mainnet / 714
 * testnet) purely as a signature-domain separator — it's not a real chain
 * (Aster's own SDK examples sign it with a raw private key, no wallet/network
 * concept). Wallets that strictly validate eth_signTypedData_v4's
 * domain.chainId against the currently connected network (Rabby, and
 * MetaMask in some configurations) refuse to sign otherwise, so the wallet
 * must actually be switched/added to that chainId first. The RPC endpoint
 * behind this is a read-only stub (src/server/worker.ts,
 * /api/aster-chain-rpc/:network) — it exists solely to pass wallet_addEthereumChain's
 * RPC-liveness check and rejects any state-changing call.
 */
const ASTER_SIGNING_CHAINS: Record<number, { network: "mainnet" | "testnet"; chainName: string }> = {
  1666: { network: "mainnet", chainName: "Aster Signature Domain (Mainnet)" },
  714: { network: "testnet", chainName: "Aster Signature Domain (Testnet)" },
};

async function switchOrAddAsterSigningChain(provider: Eip1193Provider, signatureChainId: number): Promise<void> {
  const config = ASTER_SIGNING_CHAINS[signatureChainId];
  if (!config) throw new Error("Unsupported Aster signature chain.");
  const hexChainId = `0x${signatureChainId.toString(16)}`;

  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexChainId }] });
    return;
  } catch (error: any) {
    const notYetAdded = error?.code === 4902 || /unrecognized chain|not.*been added|4902/i.test(String(error?.message ?? ""));
    if (!notYetAdded) throw error;
  }

  await provider.request({
    method: "wallet_addEthereumChain",
    params: [{
      chainId: hexChainId,
      chainName: config.chainName,
      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: [`${window.location.origin}/api/aster-chain-rpc/${config.network}`],
    }],
  });
}

export async function signAsterRegistrationTypedData(input: {
  provider: Eip1193Provider | null | undefined;
  account: `0x${string}`;
  signatureChainId: number;
  typedData: AsterTypedData;
}): Promise<`0x${string}`> {
  if (!input.provider?.request) {
    throw new Error("Wallet provider is not available. Reconnect your wallet and try again.");
  }
  validateAsterRegistrationTypedData({
    account: input.account,
    signatureChainId: input.signatureChainId,
    typedData: input.typedData,
  });

  await switchOrAddAsterSigningChain(input.provider, input.signatureChainId);

  const signature = await input.provider.request({
    method: "eth_signTypedData_v4",
    params: [input.account, JSON.stringify(input.typedData)],
  });

  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw new Error("Wallet returned an invalid Aster activation signature.");
  }

  return signature as `0x${string}`;
}
