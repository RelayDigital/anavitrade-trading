import assert from "node:assert/strict";
import test from "node:test";

import { renderExecutionMetrics } from "./server";

test("execution service exposes the production poll and lease metric families", () => {
  const metrics = renderExecutionMetrics();

  for (const name of [
    "execution_polls_total",
    "execution_poll_duration_seconds",
    "execution_claimed_jobs_total",
    "execution_submissions_total",
    "execution_failures_total",
    "execution_stale_leases_reclaimed_total",
    "execution_last_success_timestamp_seconds",
  ]) {
    assert.match(metrics, new RegExp(`^${name} \\d+(?:\\.\\d+)?$`, "m"));
  }
});
