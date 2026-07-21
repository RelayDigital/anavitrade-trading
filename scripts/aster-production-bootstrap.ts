import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { privateKeyToAccount } from "viem/accounts";
import type { AppRouter } from "../src/server/routers";

const apiBaseUrl = process.env.ASTER_BOOTSTRAP_API_BASE_URL
  ?? "https://anavitrade-trading.erhazeariel.workers.dev";
const browserOrigin = process.env.ASTER_BOOTSTRAP_BROWSER_ORIGIN
  ?? "https://anavitrade-trading.vercel.app";
const email = process.env.ASTER_BOOTSTRAP_EMAIL;
const password = process.env.ASTER_BOOTSTRAP_PASSWORD;
const walletPrivateKey = process.env.ASTER_BOOTSTRAP_WALLET_PRIVATE_KEY as `0x${string}` | undefined;
const auditOnly = process.env.ASTER_BOOTSTRAP_AUDIT_ONLY === "true";
if (!email || !password || (!auditOnly && !walletPrivateKey)) {
  throw new Error(
    auditOnly
      ? "ASTER_BOOTSTRAP_EMAIL and ASTER_BOOTSTRAP_PASSWORD are required."
      : "ASTER_BOOTSTRAP_EMAIL, ASTER_BOOTSTRAP_PASSWORD, and ASTER_BOOTSTRAP_WALLET_PRIVATE_KEY are required.",
  );
}

let cookie = "";

function updateCookie(response: Response) {
  const setCookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean) as string[];
  for (const entry of setCookies) {
    const pair = entry.split(";", 1)[0];
    const name = pair.slice(0, pair.indexOf("=") + 1);
    const existing = cookie.split("; ").filter((item) => !item.startsWith(name));
    cookie = [...existing, pair].filter(Boolean).join("; ");
  }
}

const sessionFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("Origin", browserOrigin);
  headers.set("X-Client", "web");
  if (cookie) headers.set("Cookie", cookie);
  const response = await fetch(input, { ...init, headers });
  updateCookie(response);
  return response;
};

const client = createTRPCProxyClient<AppRouter>({
  links: [httpBatchLink({
    url: `${apiBaseUrl}/api/trpc`,
    transformer: superjson,
    fetch: sessionFetch,
  })],
});

async function main() {
  try {
    await client.auth.register.mutate({ name: "Aster Live Proof", email, password });
  } catch (error: any) {
    if (!String(error?.message ?? error).toLowerCase().includes("already")) throw error;
  }

  await client.auth.login.mutate({ email, password });
  if (auditOnly) {
    const [config, status, balance] = await Promise.all([
      client.aster.getConfig.query(),
      client.aster.getStatus.query(),
      client.aster.syncBalance.mutate(),
    ]);
    console.log(JSON.stringify({ config, status, balance }, null, 2));
    return;
  }

  const wallet = privateKeyToAccount(walletPrivateKey!);
  await client.web3Wallet.connect.mutate({
    walletAddress: wallet.address,
    walletType: "metamask",
    chainId: 1,
  });

  const challenge = await client.aster.prepareRegistration.mutate();
  const signature = await wallet.signTypedData({
    domain: challenge.typedData.domain,
    types: challenge.typedData.types,
    primaryType: challenge.typedData.primaryType,
    message: challenge.typedData.message,
  });
  const status = await client.aster.completeRegistration.mutate({
    activationMode: challenge.activationMode,
    endpoint: challenge.endpoint,
    signatureChainId: challenge.signatureChainId,
    params: challenge.params,
    signature,
  });

  let balance: unknown = null;
  try {
    balance = await client.aster.syncBalance.mutate();
  } catch (error: any) {
    balance = { error: String(error?.message ?? error) };
  }

  console.log(JSON.stringify({
    walletAddress: wallet.address,
    activationMode: challenge.activationMode,
    signatureChainId: challenge.signatureChainId,
    status,
    balance,
  }, null, 2));
}

main().catch((error) => {
  console.error("ASTER_PRODUCTION_BOOTSTRAP_FAILED", error?.message ?? error);
  process.exit(1);
});
