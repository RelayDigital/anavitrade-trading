import assert from "node:assert/strict";
import test from "node:test";
import { requireAuthoritativeRiskDecision } from "./dispatch";

test("a denied or zero risk decision neither invokes a provider nor leaves a queued risk-approved job", async () => {
  let providerCalls = 0;
  const queuedJobs: Array<{ riskApproved: boolean; status: string; notionalUsd: number }> = [];
  const adapter = {
    readBalance: async () => { providerCalls++; },
  };

  async function attemptAutomatedExecution(decision: unknown) {
    const approved = requireAuthoritativeRiskDecision(decision as any);
    if (!approved) return;
    queuedJobs.push({ riskApproved: true, status: "queued", notionalUsd: approved.notionalUsd });
    await adapter.readBalance();
  }

  await attemptAutomatedExecution({ approved: false, reason: "missing_nav" });
  await attemptAutomatedExecution({ approved: true, notionalUsd: 0, leverage: 3 });

  assert.equal(providerCalls, 0);
  assert.deepEqual(queuedJobs, []);
});
