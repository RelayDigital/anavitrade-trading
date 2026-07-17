import assert from "node:assert/strict";
import test from "node:test";

import {
  AuthEmailUnavailableError,
  RecordingAuthEmailSender,
  createAuthEmailSender,
} from "./email";

test("recording email sender captures messages without network delivery", async () => {
  const sender = new RecordingAuthEmailSender();
  await sender.sendVerification({
    to: "user@example.com",
    name: "User",
    verificationUrl: "https://example.com/verify-email?token=secret",
  });

  assert.equal(sender.messages.length, 1);
  assert.equal(sender.messages[0]?.kind, "verification");
});

test("production email configuration fails closed when no provider is injected", async () => {
  const sender = createAuthEmailSender({ mode: "production" });

  await assert.rejects(
    sender.sendPasswordReset({
      to: "user@example.com",
      name: "User",
      resetUrl: "https://example.com/reset-password?token=secret",
    }),
    AuthEmailUnavailableError,
  );
});

