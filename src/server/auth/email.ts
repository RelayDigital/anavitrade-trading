import type { Env } from "../_core/env";

export type VerificationEmail = {
  to: string;
  name: string;
  verificationUrl: string;
};

export type PasswordResetEmail = {
  to: string;
  name: string;
  resetUrl: string;
};

export interface AuthEmailSender {
  sendVerification(message: VerificationEmail): Promise<void>;
  sendPasswordReset(message: PasswordResetEmail): Promise<void>;
}

export type RecordedAuthEmail =
  | ({ kind: "verification" } & VerificationEmail)
  | ({ kind: "password-reset" } & PasswordResetEmail);

export class RecordingAuthEmailSender implements AuthEmailSender {
  readonly messages: RecordedAuthEmail[] = [];

  async sendVerification(message: VerificationEmail): Promise<void> {
    this.messages.push({ kind: "verification", ...message });
  }

  async sendPasswordReset(message: PasswordResetEmail): Promise<void> {
    this.messages.push({ kind: "password-reset", ...message });
  }
}

export class AuthEmailUnavailableError extends Error {
  constructor() {
    super("Authentication email delivery is not configured.");
    this.name = "AuthEmailUnavailableError";
  }
}

type FetchLike = typeof fetch;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function textEmail(title: string, greeting: string, actionLabel: string, actionUrl: string): string {
  return `${title}\n\n${greeting}\n\n${actionLabel}: ${actionUrl}\n\nIf you did not request this, you can safely ignore this email.`;
}

function htmlEmail(title: string, greeting: string, actionLabel: string, actionUrl: string): string {
  const safeTitle = escapeHtml(title);
  const safeGreeting = escapeHtml(greeting);
  const safeActionLabel = escapeHtml(actionLabel);
  const safeActionUrl = escapeHtml(actionUrl);
  return `<main><h1>${safeTitle}</h1><p>${safeGreeting}</p><p><a href="${safeActionUrl}">${safeActionLabel}</a></p><p>If you did not request this, you can safely ignore this email.</p></main>`;
}

function parseEmailFrom(value: string): { email: string; name?: string } | null {
  const match = /^(?:(.+?)\s*<)?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>?$/i.exec(value.trim());
  if (!match) return null;
  const name = match[1]?.trim();
  return { email: match[2]!, ...(name ? { name } : {}) };
}

/** Cloudflare-native transactional sender. No API key leaves the Worker. */
export class CloudflareAuthEmailSender implements AuthEmailSender {
  private readonly from: { email: string; name?: string };

  constructor(
    private readonly email: NonNullable<Env["AUTH_EMAIL"]>,
    emailFrom: string,
  ) {
    const from = parseEmailFrom(emailFrom);
    if (!from) throw new AuthEmailUnavailableError();
    this.from = from;
  }

  async sendVerification(message: VerificationEmail): Promise<void> {
    await this.send({
      to: message.to,
      subject: "Verify your Anavitrade email",
      text: textEmail("Verify your Anavitrade email", `Hi ${message.name},`, "Verify your email", message.verificationUrl),
      html: htmlEmail("Verify your Anavitrade email", `Hi ${message.name},`, "Verify your email", message.verificationUrl),
    });
  }

  async sendPasswordReset(message: PasswordResetEmail): Promise<void> {
    await this.send({
      to: message.to,
      subject: "Reset your Anavitrade password",
      text: textEmail("Reset your Anavitrade password", `Hi ${message.name},`, "Reset your password", message.resetUrl),
      html: htmlEmail("Reset your Anavitrade password", `Hi ${message.name},`, "Reset your password", message.resetUrl),
    });
  }

  private async send(message: { to: string; subject: string; text: string; html: string }): Promise<void> {
    await this.email.send({ from: this.from, ...message });
  }
}

/** Minimal transactional sender for Worker runtime; no SDK or server-only dependency. */
export class ResendAuthEmailSender implements AuthEmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchFn: FetchLike = fetch,
  ) {}

  async sendVerification(message: VerificationEmail): Promise<void> {
    await this.send({
      to: message.to,
      subject: "Verify your Anavitrade email",
      text: textEmail("Verify your Anavitrade email", `Hi ${message.name},`, "Verify your email", message.verificationUrl),
      html: htmlEmail("Verify your Anavitrade email", `Hi ${message.name},`, "Verify your email", message.verificationUrl),
    });
  }

  async sendPasswordReset(message: PasswordResetEmail): Promise<void> {
    await this.send({
      to: message.to,
      subject: "Reset your Anavitrade password",
      text: textEmail("Reset your Anavitrade password", `Hi ${message.name},`, "Reset your password", message.resetUrl),
      html: htmlEmail("Reset your Anavitrade password", `Hi ${message.name},`, "Reset your password", message.resetUrl),
    });
  }

  private async send(message: { to: string; subject: string; text: string; html: string }): Promise<void> {
    const response = await this.fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: this.from, ...message }),
    });
    if (!response.ok) {
      throw new Error(`Authentication email delivery failed with status ${response.status}.`);
    }
  }
}

class UnavailableAuthEmailSender implements AuthEmailSender {
  async sendVerification(): Promise<never> {
    throw new AuthEmailUnavailableError();
  }

  async sendPasswordReset(): Promise<never> {
    throw new AuthEmailUnavailableError();
  }
}

export function createAuthEmailSender(config: {
  mode: "development" | "test" | "recording" | "production";
  provider?: AuthEmailSender;
  cloudflareEmail?: Env["AUTH_EMAIL"];
  resendApiKey?: string;
  emailFrom?: string;
}): AuthEmailSender {
  if (config.provider) return config.provider;
  if (config.mode === "production") {
    if (config.cloudflareEmail && config.emailFrom?.trim()) {
      return new CloudflareAuthEmailSender(config.cloudflareEmail, config.emailFrom);
    }
    if (config.resendApiKey?.trim() && config.emailFrom?.trim()) {
      return new ResendAuthEmailSender(config.resendApiKey, config.emailFrom);
    }
    return new UnavailableAuthEmailSender();
  }
  return new RecordingAuthEmailSender();
}
