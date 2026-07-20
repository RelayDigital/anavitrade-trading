import type { Page } from "playwright";

export async function installInjectedWallet(
  page: Page,
  address: `0x${string}`,
  signTypedData: (raw: string) => Promise<string>,
  signatureChainId = 1666,
) {
  await page.context().exposeFunction("__anaviSignTypedData", signTypedData);

  const script = `(() => {
    const address = ${JSON.stringify(address)};
    const signatureChainId = ${JSON.stringify(signatureChainId)};
    const listeners = Object.create(null);
    const emit = (event, ...args) => {
      for (const fn of listeners[event] || []) fn(...args);
    };
    // Simulates a strict wallet (Rabby-like): starts on mainnet (chainId 1),
    // does NOT know about Aster's signing-domain chainId until
    // wallet_addEthereumChain succeeds, and refuses eth_signTypedData_v4
    // unless the wallet's *current* chainId matches the typed data's
    // domain.chainId — this is the real-world behavior the fix targets.
    const knownChains = new Set(["0x1"]);
    let currentChainHex = "0x1";
    const provider = {
      isMetaMask: true,
      selectedAddress: address,
      get chainId() { return currentChainHex; },
      rpcCalls: [],
      lastAsterSignature: null,
      lastAsterTypedData: null,
      on(event, cb) {
        listeners[event] = listeners[event] || [];
        listeners[event].push(cb);
      },
      removeListener(event, cb) {
        listeners[event] = (listeners[event] || []).filter((fn) => fn !== cb);
      },
      async request(args) {
        provider.rpcCalls.push(args);
        switch (args.method) {
          case "eth_requestAccounts":
            emit("accountsChanged", [address]);
            return [address];
          case "eth_accounts":
            return [address];
          case "eth_chainId":
            return currentChainHex;
          case "net_version":
            return String(parseInt(currentChainHex, 16));
          case "wallet_requestPermissions":
            return [{ parentCapability: "eth_accounts" }];
          case "wallet_switchEthereumChain": {
            const target = args.params?.[0]?.chainId;
            if (!knownChains.has(target)) {
              const err = new Error("Unrecognized chain ID. Try adding the chain using wallet_addEthereumChain first.");
              err.code = 4902;
              throw err;
            }
            currentChainHex = target;
            emit("chainChanged", target);
            return null;
          }
          case "wallet_addEthereumChain": {
            const config = args.params?.[0];
            if (!config?.chainId || !Array.isArray(config.rpcUrls) || config.rpcUrls.length === 0) {
              throw new Error("Invalid wallet_addEthereumChain payload");
            }
            knownChains.add(config.chainId);
            currentChainHex = config.chainId;
            emit("chainChanged", config.chainId);
            return null;
          }
          case "personal_sign":
            throw new Error("personal_sign is not supported by the test wallet");
          case "eth_signTypedData_v4": {
            const params = args.params || [];
            const payload = typeof params[1] === "string" ? params[1] : JSON.stringify(params[1]);
            const typedData = JSON.parse(payload);
            const domainChainHex = "0x" + Number(typedData.domain?.chainId ?? 0).toString(16);
            if (currentChainHex !== domainChainHex) throw new Error("chainId should be same as current chainId");
            if (typedData.domain?.chainId !== signatureChainId) throw new Error("Aster typed-data chainId was not " + signatureChainId);
            if (!["ApproveAgent", "Message"].includes(typedData.primaryType)) throw new Error("Aster activation signed an unexpected typed-data payload");
            if (typedData.primaryType === "ApproveAgent" && typedData.message?.CanWithdraw !== false) throw new Error("Aster activation must not request withdrawals");
            provider.lastAsterTypedData = typedData;
            const signature = await window.__anaviSignTypedData(payload);
            provider.lastAsterSignature = signature;
            return signature;
          }
          default:
            throw new Error("Unsupported injected wallet method: " + args.method);
        }
      },
    };

    Object.defineProperty(window, "ethereum", { value: provider, configurable: true });
    Object.defineProperty(window, "anaviInjectedWalletAddress", { value: address, configurable: true });
  })();`;

  await page.addInitScript(script);
}
