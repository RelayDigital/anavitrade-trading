import { COOKIE_NAME } from "@shared/const";
import { TRPCError } from "@trpc/server";
import { serialize } from "cookie";
import { z } from "zod";

import type { Env } from "../_core/env";
import { getClientIp, getSessionCookieOptions } from "../_core/cookies";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import type { User } from "../../drizzle/schema";
import * as db from "../db";
import { createSessionToken, getSessionTokenFromRequest, revokeSessionToken } from "../sdk";
import {
  createAuthEmailSender,
  RecordingAuthEmailSender,
  type AuthEmailSender,
} from "./email";
import { toSafeUser } from "./user";
import {
  createCanonicalAuthUrl,
  getCanonicalAppOrigin,
  isExplicitDevelopmentOrTestnet,
} from "./origin";

type RegistrationResult = { user: User; verificationToken: string };
type VerificationResult = { user: User; verificationToken: string } | undefined;
type ResetTokenResult = { user: User; resetToken: string } | null;

export type AuthRouterDependencies = {
  registerUser(input: { name: string; email: string; password: string }): Promise<RegistrationResult>;
  verifyUserPassword(email: string, password: string): Promise<User | null>;
  verifyEmailToken(token: string): Promise<User>;
  resendVerificationEmail(email: string): Promise<VerificationResult>;
  createPasswordResetToken(email: string): Promise<ResetTokenResult>;
  resetPassword(token: string, password: string): Promise<User>;
  updateUserProfile(userId: number, name: string): Promise<void>;
  updateUserPasswordHash(userId: number, hash: string): Promise<void>;
  hashPassword(password: string): Promise<string>;
  writeAuditLog(userId: number | null, action: string, detail?: string, ip?: string): Promise<void>;
  signSessionToken(user: User): Promise<string>;
  revokeSessionToken(token: string | undefined): Promise<void>;
  getEmailSender(env: Env): AuthEmailSender;
};

const developmentEmailSender = new RecordingAuthEmailSender();

function defaultEmailSender(env: Env): AuthEmailSender {
  const values = env as Env & Record<string, unknown>;
  const mode = values.AUTH_EMAIL_MODE;
  const isExplicitDevelopment =
    mode === "recording" ||
    mode === "development" ||
    mode === "test" ||
    isExplicitDevelopmentOrTestnet(env);
  return isExplicitDevelopment
    ? developmentEmailSender
    : createAuthEmailSender({ mode: "production" });
}

const defaultDependencies: AuthRouterDependencies = {
  registerUser: db.registerUser,
  verifyUserPassword: db.verifyUserPassword,
  verifyEmailToken: db.verifyEmailToken,
  resendVerificationEmail: db.resendVerificationEmail,
  createPasswordResetToken: db.createPasswordResetToken,
  resetPassword: db.resetPassword,
  updateUserProfile: db.updateUserProfile,
  updateUserPasswordHash: db.updateUserPasswordHash,
  hashPassword: db.hashPassword,
  writeAuditLog: db.writeAuditLog,
  signSessionToken: (user) =>
    createSessionToken(user.openId ?? `local:${user.id}`, {
      name: user.name ?? user.email ?? "Anavitrade User",
    }),
  revokeSessionToken,
  getEmailSender: defaultEmailSender,
};

export function createAuthRouter(dependencies: AuthRouterDependencies = defaultDependencies) {
  return router({
    me: publicProcedure.query(({ ctx }) => (ctx.user ? toSafeUser(ctx.user) : null)),

    register: publicProcedure
      .input(z.object({
        name: z.string().trim().min(2).max(80),
        email: z.string().trim().toLowerCase().email(),
        password: z.string().min(8).max(128),
      }))
      .mutation(async ({ input, ctx }) => {
        try {
          getCanonicalAppOrigin(ctx.env);
          const result = await dependencies.registerUser(input);
          const verificationUrl = createCanonicalAuthUrl(ctx.env, "/verify-email", {
            token: result.verificationToken,
            email: result.user.email!,
          });
          await dependencies.getEmailSender(ctx.env).sendVerification({
            to: result.user.email!,
            name: result.user.name ?? "Anavitrade User",
            verificationUrl,
          });
          await dependencies.writeAuditLog(
            result.user.id,
            "USER_REGISTERED",
            input.email,
            getClientIp(ctx.req),
          );
          const safeUser = toSafeUser(result.user);
          return isExplicitDevelopmentOrTestnet(ctx.env)
            ? { ...safeUser, developmentVerificationUrl: verificationUrl }
            : safeUser;
        } catch (error: any) {
          if (error?.message === "EMAIL_EXISTS") {
            throw new TRPCError({
              code: "CONFLICT",
              message: "An account with this email already exists.",
            });
          }
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Registration failed." });
        }
      }),

    login: publicProcedure
      .input(z.object({ email: z.string().trim().toLowerCase().email(), password: z.string() }))
      .mutation(async ({ input, ctx }) => {
        const user = await dependencies.verifyUserPassword(input.email, input.password);
        if (!user?.emailVerified) {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid email or password." });
        }
        const sessionToken = await dependencies.signSessionToken(user);
        ctx.setHeader(
          "Set-Cookie",
          serialize(COOKIE_NAME, sessionToken, getSessionCookieOptions(ctx.env)),
        );
        await dependencies.writeAuditLog(
          user.id,
          "USER_LOGIN",
          input.email,
          getClientIp(ctx.req),
        );
        return toSafeUser(user);
      }),

    logout: publicProcedure.mutation(async ({ ctx }) => {
      await dependencies.revokeSessionToken(getSessionTokenFromRequest(ctx.req));
      ctx.setHeader("Set-Cookie", serialize(COOKIE_NAME, "", {
        ...getSessionCookieOptions(ctx.env),
        maxAge: 0,
        expires: new Date(0),
      }));
      return { success: true } as const;
    }),

    verifyEmail: publicProcedure
      .input(z.object({ token: z.string().min(20).max(256) }))
      .mutation(async ({ input }) => {
        try {
          await dependencies.verifyEmailToken(input.token);
          return { success: true } as const;
        } catch (error: any) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: error?.message === "TOKEN_EXPIRED"
              ? "Verification link has expired."
              : "Invalid verification link.",
          });
        }
      }),

    forgotPassword: publicProcedure
      .input(z.object({ email: z.string().trim().toLowerCase().email() }))
      .mutation(async ({ input, ctx }) => {
        getCanonicalAppOrigin(ctx.env);
        try {
          const result = await dependencies.createPasswordResetToken(input.email);
          if (result) {
            await dependencies.getEmailSender(ctx.env).sendPasswordReset({
              to: result.user.email!,
              name: result.user.name ?? "Anavitrade User",
              resetUrl: createCanonicalAuthUrl(ctx.env, "/reset-password", { token: result.resetToken }),
            });
          }
        } catch {
          // Keep the public result independent of account existence and provider state.
        }
        return { success: true } as const;
      }),

    resetPassword: publicProcedure
      .input(z.object({ token: z.string().min(20).max(256), password: z.string().min(8).max(128) }))
      .mutation(async ({ input }) => {
        try {
          await dependencies.resetPassword(input.token, input.password);
          return { success: true } as const;
        } catch (error: any) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: error?.message === "TOKEN_EXPIRED"
              ? "Reset link has expired."
              : "Invalid reset link.",
          });
        }
      }),

    resendVerification: publicProcedure
      .input(z.object({ email: z.string().trim().toLowerCase().email() }))
      .mutation(async ({ input, ctx }) => {
        getCanonicalAppOrigin(ctx.env);
        const result = await dependencies.resendVerificationEmail(input.email);
        if (result) {
          await dependencies.getEmailSender(ctx.env).sendVerification({
            to: result.user.email!,
            name: result.user.name ?? "Anavitrade User",
            verificationUrl: createCanonicalAuthUrl(ctx.env, "/verify-email", {
              token: result.verificationToken,
              email: result.user.email!,
            }),
          });
        }
        return { success: true } as const;
      }),

    updateProfile: protectedProcedure
      .input(z.object({ name: z.string().trim().min(2).max(80) }))
      .mutation(async ({ input, ctx }) => {
        await dependencies.updateUserProfile(ctx.user.id, input.name);
        return { success: true } as const;
      }),

    changePassword: protectedProcedure
      .input(z.object({ currentPassword: z.string(), newPassword: z.string().min(8).max(128) }))
      .mutation(async ({ input, ctx }) => {
        if (!ctx.user.email) throw new TRPCError({ code: "UNAUTHORIZED" });
        const user = await dependencies.verifyUserPassword(ctx.user.email, input.currentPassword);
        if (!user) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "Current password is incorrect.",
          });
        }
        await dependencies.updateUserPasswordHash(
          ctx.user.id,
          await dependencies.hashPassword(input.newPassword),
        );
        await dependencies.writeAuditLog(ctx.user.id, "PASSWORD_CHANGED");
        return { success: true } as const;
      }),
  });
}

export const authRouter = createAuthRouter();
