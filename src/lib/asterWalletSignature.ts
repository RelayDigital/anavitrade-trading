type Eip1193Provider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};

type AsterTypedData = {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
};

export async function signAsterRegistrationTypedData(input: {
  provider: Eip1193Provider | null | undefined;
  account: `0x${string}`;
  typedData: AsterTypedData;
}): Promise<`0x${string}`> {
  if (!input.provider?.request) {
    throw new Error("Wallet provider is not available. Reconnect your wallet and try again.");
  }
  if (
    input.typedData.domain?.name !== "AsterSignTransaction"
    || input.typedData.domain?.version !== "1"
    || input.typedData.domain?.verifyingContract !== "0x0000000000000000000000000000000000000000"
  ) {
    throw new Error("Invalid Aster signature challenge.");
  }
  if (
    input.typedData.primaryType !== "ApproveAgent"
    || !Array.isArray(input.typedData.types?.ApproveAgent)
  ) {
    throw new Error("Invalid Aster signature challenge type.");
  }

  const signature = await input.provider.request({
    method: "eth_signTypedData_v4",
    params: [input.account, JSON.stringify(input.typedData)],
  });

  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw new Error("Wallet returned an invalid Aster activation signature.");
  }

  return signature as `0x${string}`;
}
