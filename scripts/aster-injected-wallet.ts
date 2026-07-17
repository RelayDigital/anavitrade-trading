import type { Page } from "playwright";

export async function installInjectedWallet(
  page: Page,
  address: `0x${string}`,
  signTypedData: (raw: string) => Promise<string>,
) {
  await page.context().exposeFunction("__anaviSignTypedData", signTypedData);

  const script = `(() => {
    const address = ${JSON.stringify(address)};
    const listeners = Object.create(null);
    const emit = (event, ...args) => {
      for (const fn of listeners[event] || []) fn(...args);
    };
    const chainIdHex = "0x1";
    const provider = {
      isMetaMask: true,
      selectedAddress: address,
      chainId: chainIdHex,
      on(event, cb) {
        listeners[event] = listeners[event] || [];
        listeners[event].push(cb);
      },
      removeListener(event, cb) {
        listeners[event] = (listeners[event] || []).filter((fn) => fn !== cb);
      },
      async request(args) {
        switch (args.method) {
          case "eth_requestAccounts":
            emit("accountsChanged", [address]);
            return [address];
          case "eth_accounts":
            return [address];
          case "eth_chainId":
            return chainIdHex;
          case "net_version":
            return "1";
          case "wallet_requestPermissions":
            return [{ parentCapability: "eth_accounts" }];
          case "wallet_switchEthereumChain":
          case "wallet_addEthereumChain":
            return null;
          case "personal_sign":
            throw new Error("personal_sign is not supported by the test wallet");
          case "eth_signTypedData_v4": {
            const params = args.params || [];
            const payload = typeof params[1] === "string" ? params[1] : JSON.stringify(params[1]);
            return window.__anaviSignTypedData(payload);
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
