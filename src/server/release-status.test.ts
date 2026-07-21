import assert from "node:assert/strict";
import test from "node:test";
import { getPublicReleaseStatus } from "./release-status";

test("production platform status stays distinct from disabled execution", () => {
  const status = getPublicReleaseStatus({
    APP_ENVIRONMENT: "production",
    AUTOMATED_SIGNAL_DISPATCH_ENABLED: "false",
    ASTER_ENVIRONMENT: "testnet",
    ASTER_LIVE_ORDER_SUBMISSION_ENABLED: "false",
  });

  assert.equal(status.platformEnvironment, "production");
  assert.equal(status.releaseLane, "production-platform-execution-disabled");
  assert.equal(status.automatedSignalDispatchEnabled, false);
  assert.equal(status.customerCapitalExecutionEnabled, false);
  assert.equal(status.authenticationEmailConfigured, false);
  assert.equal(status.emailVerificationRequired, true);
  assert.equal(status.adapters.aster.environment, "testnet");
  assert.equal(status.adapters.aster.orderSubmissionEnabled, false);
  assert.equal(status.adapters.aster.maxOrderNotionalUsd, null);
});

test("customer-capital execution is reported only for an explicit adapter enablement", () => {
  const status = getPublicReleaseStatus({
    APP_ENVIRONMENT: "production",
    ASTER_ENVIRONMENT: "production",
    ASTER_LIVE_ORDER_SUBMISSION_ENABLED: "true",
    ASTER_MAX_ORDER_NOTIONAL_USD: "100",
    ASTER_BUILDER_ADDRESS: "0xbuilder",
    RESEND_API_KEY: "re_test",
    EMAIL_FROM: "Anavitrade <auth@example.com>",
  });

  assert.equal(status.releaseLane, "production-execution-enabled");
  assert.equal(status.customerCapitalExecutionEnabled, true);
  assert.equal(status.authenticationEmailConfigured, true);
  assert.equal(status.adapters.aster.configured, true);
  assert.equal(status.adapters.aster.maxOrderNotionalUsd, 100);
});

test("production Aster agent-only execution is reported as configured", () => {
  const status = getPublicReleaseStatus({
    APP_ENVIRONMENT: "production",
    ASTER_ENVIRONMENT: "production",
    ASTER_AGENT_ONLY_ENABLED: "true",
    ASTER_LIVE_ORDER_SUBMISSION_ENABLED: "true",
    ASTER_BUILDER_ADDRESS: "",
  });

  assert.equal(status.adapters.aster.configured, true);
  assert.equal(status.adapters.aster.orderSubmissionEnabled, true);
  assert.equal(status.releaseLane, "production-execution-enabled");
});

test("email verification is exposed as an explicit release flag", () => {
  const status = getPublicReleaseStatus({
    APP_ENVIRONMENT: "production",
    REQUIRE_EMAIL_VERIFICATION: "false",
  });
  assert.equal(status.emailVerificationRequired, false);
});
