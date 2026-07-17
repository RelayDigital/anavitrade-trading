import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { appRouter } from "./routers";
import type { TrpcContext } from "./context";

const demoSource = new URL("./routers.ts", import.meta.url);

function anonymousContext(): TrpcContext {
  return {
    req: new Request("https://app.example.com/api/trpc"),
    env: {
      DB: {},
      JWT_SECRET: "test-secret-that-is-long-enough",
      ENCRYPTION_KEY: "test-encryption-key-that-is-long-enough",
      VITE_APP_ID: "test-app",
    },
    user: null,
    setHeader: () => undefined,
  };
}

test("anonymous callers cannot invoke demo mutations", async () => {
  const caller = appRouter.createCaller(anonymousContext());

  await assert.rejects(
    caller.demo.triggerSync({ token: "public" }),
    (error: any) => error.code === "UNAUTHORIZED",
  );
  await assert.rejects(
    caller.demo.updateSettings({ positionSizePct: 5 }),
    (error: any) => error.code === "UNAUTHORIZED",
  );
  await assert.rejects(
    caller.demo.syncMySignals(),
    (error: any) => error.code === "UNAUTHORIZED",
  );
});

test("the demo router has no shared-token public mutation path", async () => {
  const source = await readFile(demoSource, "utf8");
  const demoBlock = source.slice(source.indexOf("/* Demo Account */"), source.indexOf("/* Signals */"));

  assert.doesNotMatch(demoBlock, /PUBLIC_DEMO_TOKEN|getOrCreatePublicDemoAccount|bootstrapPublicDemo/);
  assert.match(demoBlock, /getPublicDemo:\s*publicProcedure\.query\(async \(\) => \{[\s\S]*getPublicDemoAccount\(\)/);
  assert.match(demoBlock, /syncMySignals:\s*protectedProcedure\.mutation\(async \(\{ ctx \}\) =>[\s\S]*syncSignalsToDemoAccount\(ctx\.user\.id\)/);
  assert.match(demoBlock, /triggerSync:\s*protectedProcedure[\s\S]*syncSignalsToDemoAccount\(ctx\.user\.id\)/);
  assert.doesNotMatch(demoBlock, /syncSignalsToDemoAccounts\(\)/);
});
