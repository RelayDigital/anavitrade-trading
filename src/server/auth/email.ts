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
}): AuthEmailSender {
  if (config.provider) return config.provider;
  if (config.mode === "production") return new UnavailableAuthEmailSender();
  return new RecordingAuthEmailSender();
}

