type Eip1193Provider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};

type PermitSingleTypedData = {
  domain: Record<string, unknown>;
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
};

function isAddressLike(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function validatePermitSingleTypedData(input: {
  account: `0x${string}`;
  expectedTokenAddress: string;
  expectedSpenderAddress: string;
  expectedAmountCap: string;
  typedData: PermitSingleTypedData;
}): void {
  const { account, expectedTokenAddress, expectedSpenderAddress, expectedAmountCap, typedData } = input;
  if (typedData.domain?.name !== "Permit2") {
    throw new Error("Invalid PancakeSwap signature challenge.");
  }
  if (typedData.primaryType !== "PermitSingle") {
    throw new Error("Invalid PancakeSwap signature challenge type.");
  }
  const fields = typedData.types?.PermitSingle ?? [];
  const fieldNames = new Set(fields.map((field) => field.name));
  if (!fields.length || !fieldNames.has("details") || !fieldNames.has("spender") || !fieldNames.has("sigDeadline")) {
    throw new Error("Invalid PancakeSwap signature fields.");
  }
  const details = typedData.message?.details as Record<string, unknown> | undefined;
  if (!details || !isAddressLike(details.token) || !isAddressLike(typedData.message?.spender)) {
    throw new Error("Invalid PancakeSwap signature addresses.");
  }
  if (String(details.token).toLowerCase() !== expectedTokenAddress.toLowerCase()) {
    throw new Error("PancakeSwap signature token mismatch.");
  }
  if (String(typedData.message.spender).toLowerCase() !== expectedSpenderAddress.toLowerCase()) {
    throw new Error("PancakeSwap signature spender mismatch — refusing to sign an unexpected delegate.");
  }
  if (String(details.amount) !== expectedAmountCap) {
    throw new Error("PancakeSwap signature amount cap mismatch.");
  }
  void account;
}

/** Validates the server-issued Permit2 PermitSingle challenge matches what the
 *  user requested before asking the wallet to sign — mirrors
 *  signAsterRegistrationTypedData's anti-tamper check for the Aster flow. */
export async function signPancakeswapPermitTypedData(input: {
  provider: Eip1193Provider | null | undefined;
  account: `0x${string}`;
  expectedTokenAddress: string;
  expectedSpenderAddress: string;
  expectedAmountCap: string;
  typedData: PermitSingleTypedData;
}): Promise<`0x${string}`> {
  if (!input.provider?.request) {
    throw new Error("Wallet provider is not available. Reconnect your wallet and try again.");
  }
  validatePermitSingleTypedData({
    account: input.account,
    expectedTokenAddress: input.expectedTokenAddress,
    expectedSpenderAddress: input.expectedSpenderAddress,
    expectedAmountCap: input.expectedAmountCap,
    typedData: input.typedData,
  });

  const signature = await input.provider.request({
    method: "eth_signTypedData_v4",
    params: [input.account, JSON.stringify(input.typedData)],
  });

  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw new Error("Wallet returned an invalid PancakeSwap delegation signature.");
  }

  return signature as `0x${string}`;
}
