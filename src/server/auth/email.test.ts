import assert from "node:assert/strict";
import test from "node:test";

import {
  AuthEmailUnavailableError,
  CloudflareAuthEmailSender,
  ResendAuthEmailSender,
  createAuthEmailSender,
} from "./email";

test("production email sender fails closed when Resend configuration is absent", async () => {
  const sender = createAuthEmailSender({ mode: "production" });
  await assert.rejects(
    sender.sendVerification({
      to: "user@example.com",
      name: "User",
      verificationUrl: "https://app.example.com/verify-email?token=abc",
    }),
    AuthEmailUnavailableError,
  );
});

test("Cloudflare sender uses the Worker binding with parsed sender identity", async () => {
  const messages: Array<Record<string, unknown>> = [];
  const sender = new CloudflareAuthEmailSender({
    send: async (message) => { messages.push(message); },
  }, "Anavitrade <auth@example.com>");

  await sender.sendPasswordReset({
    to: "user@example.com",
    name: "User",
    resetUrl: "https://app.example.com/reset-password?token=abc",
  });

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0]!.from, { email: "auth@example.com", name: "Anavitrade" });
  assert.equal(messages[0]!.to, "user@example.com");
  assert.match(String(messages[0]!.html), /Reset your password/);
});

test("Resend sender posts a transactional verification message without leaking the API key", async () => {
  const requests: Request[] = [];
  const sender = new ResendAuthEmailSender(
    "re_secret",
    "Anavitrade <auth@example.com>",
    async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(JSON.stringify({ id: "email-id" }), { status: 200 });
    },
  );

  await sender.sendVerification({
    to: "user@example.com",
    name: "<User>",
    verificationUrl: "https://app.example.com/verify-email?token=abc",
  });

  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.url, "https://api.resend.com/emails");
  assert.equal(request.headers.get("authorization"), "Bearer re_secret");
  const payload = await request.json() as Record<string, string>;
  assert.equal(payload.from, "Anavitrade <auth@example.com>");
  assert.equal(payload.to, "user@example.com");
  assert.match(payload.html, /&lt;User&gt;/);
  assert.doesNotMatch(payload.html, /re_secret/);
});

test("Resend sender reports provider failures without response body leakage", async () => {
  const sender = new ResendAuthEmailSender(
    "re_secret",
    "Anavitrade <auth@example.com>",
    async () => new Response("provider diagnostic", { status: 429 }),
  );

  await assert.rejects(
    sender.sendPasswordReset({
      to: "user@example.com",
      name: "User",
      resetUrl: "https://app.example.com/reset-password?token=abc",
    }),
    /status 429/,
  );
});
