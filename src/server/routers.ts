import { z } from "zod";
import { serialize } from "cookie";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions, getClientIp } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, adminProcedure, router } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import { SignJWT } from "jose";
import { getEnv } from "./_core/env";
import {
  registerUser, verifyUserPassword, verifyEmailToken, resendVerificationEmail,
  createPasswordResetToken, resetPassword, getUserById,
  getLiveAccountByUserId, toggleKillSwitch, updateRiskSettings,
  createDemoAccount, getDemoAccountByToken, getDemoTradesByAccountId,
  saveWeb3WalletSession, getWeb3WalletSession, revokeWeb3WalletSession,
  toggleWeb3KillSwitch, dispatchCopytradeSignal,
  writeAuditLog,
  getSignals, getScraperStatus, getTopBangers, getSignalStats, getPerformance,
  getPortfolioSnapshotsByAccountId,
  syncSignalsToDemoAccounts,
  getJulyResults,
  getOrCreatePublicDemoAccount, updateDemoAccountSettings, PUBLIC_DEMO_TOKEN,
  getPublicDemoStats,
  getOrCreateDemoAccountForUser,
  getDemoAccountByUserId,
  getDemoTradesByUserId,
  getPortfolioSnapshotsByUserId,
  getDisplayMode,
  setDisplayMode,
} from "./db";
import {
  getBinanceSettings, toggleKillSwitch as toggleBinanceKillSwitch,
  updateBinanceSettings, getTradeExecutions, getFuturesBalance,
} from "./binance";
import { asterRouter } from "./aster/router";
import { cexRouter } from "./cex/router";
import { execRouter } from "./execution/router";

async function signSessionToken(userId: number, name: string) {
  const env = getEnv();
  const jwtSecret = new TextEncoder().encode(env.JWT_SECRET);
  return new SignJWT({
    openId: `local:${userId}`,
    appId: env.VITE_APP_ID,
    name: name || "Anavitrade User",
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(jwtSecret);
}

export const appRouter = router({
  system: systemRouter,
  aster: asterRouter,
  cex: cexRouter,
  exec: execRouter,

  /* Auth */
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),

    register: publicProcedure
      .input(z.object({ name: z.string().min(2).max(80), email: z.string().email(), password: z.string().min(8).max(128) }))
      .mutation(async ({ input, ctx }) => {
        try {
          const { user, verificationToken } = await registerUser(input);
          const token = await signSessionToken(user!.id, input.name);
          const cookieOptions = getSessionCookieOptions(ctx.req);
          ctx.setHeader("Set-Cookie", serialize(COOKIE_NAME, token, { ...cookieOptions, maxAge: 30 * 24 * 60 * 60 * 1000 }));
          await writeAuditLog(user!.id, "USER_REGISTERED", input.email, getClientIp(ctx.req));
          return { success: true, userId: user!.id, verificationToken };
        } catch (e: any) {
          if (e.message === "EMAIL_EXISTS") throw new TRPCError({ code: "CONFLICT", message: "An account with this email already exists." });
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Registration failed." });
        }
      }),

    login: publicProcedure
      .input(z.object({ email: z.string().email(), password: z.string() }))
      .mutation(async ({ input, ctx }) => {
        const user = await verifyUserPassword(input.email, input.password);
        if (!user) throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid email or password." });
        const token = await signSessionToken(user.id, user.name ?? input.email);
        const cookieOptions = getSessionCookieOptions(ctx.req);
        ctx.setHeader("Set-Cookie", serialize(COOKIE_NAME, token, { ...cookieOptions, maxAge: 30 * 24 * 60 * 60 * 1000 }));
        await writeAuditLog(user.id, "USER_LOGIN", input.email, getClientIp(ctx.req));
        return { success: true, userId: user.id };
      }),

    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.setHeader("Set-Cookie", serialize(COOKIE_NAME, "", { ...cookieOptions, maxAge: -1 }));
      return { success: true } as const;
    }),

    verifyEmail: publicProcedure
      .input(z.object({ token: z.string() }))
      .mutation(async ({ input }) => {
        try { await verifyEmailToken(input.token); return { success: true }; }
        catch (e: any) { throw new TRPCError({ code: "BAD_REQUEST", message: e.message === "TOKEN_EXPIRED" ? "Verification link has expired." : "Invalid verification link." }); }
      }),

    forgotPassword: publicProcedure
      .input(z.object({ email: z.string().email() }))
      .mutation(async ({ input }) => { await createPasswordResetToken(input.email); return { success: true }; }),

    resetPassword: publicProcedure
      .input(z.object({ token: z.string(), password: z.string().min(8).max(128) }))
      .mutation(async ({ input }) => {
        try { await resetPassword(input.token, input.password); return { success: true }; }
        catch (e: any) { throw new TRPCError({ code: "BAD_REQUEST", message: e.message === "TOKEN_EXPIRED" ? "Reset link has expired." : "Invalid reset link." }); }
      }),

    resendVerification: publicProcedure
      .input(z.object({ email: z.string().email() }))
      .mutation(async ({ input }) => { await resendVerificationEmail(input.email); return { success: true }; }),

    updateProfile: protectedProcedure
      .input(z.object({ name: z.string().min(2).max(80) }))
      .mutation(async ({ input, ctx }) => {
        const { getDb } = await import("./db");
        const { users } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        await db.update(users).set({ name: input.name } as any).where(eq(users.id, ctx.user.id));
        return { success: true };
      }),

    changePassword: protectedProcedure
      .input(z.object({ currentPassword: z.string(), newPassword: z.string().min(8).max(128) }))
      .mutation(async ({ input, ctx }) => {
        const user = await verifyUserPassword(ctx.user.email!, input.currentPassword);
        if (!user) throw new TRPCError({ code: "UNAUTHORIZED", message: "Current password is incorrect." });
        const { resetPassword } = await import("./db");
        const { getDb } = await import("./db");
        const { users } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        // User is already verified by verifyUserPassword above, so re-hash
        const { hashPassword: hashPw } = await import("./db");
        const passwordHash = await hashPw(input.newPassword);
        await db.update(users).set({ passwordHash } as any).where(eq(users.id, ctx.user.id));
        await writeAuditLog(ctx.user.id, "PASSWORD_CHANGED");
        return { success: true };
      }),
  }),

  /* Live Account */
  liveAccount: router({
    get: protectedProcedure.query(async ({ ctx }) => {
      const account = await getLiveAccountByUserId(ctx.user.id);
      return { account };
    }),
    toggleKillSwitch: protectedProcedure.input(z.object({ active: z.boolean() })).mutation(async ({ input, ctx }) => {
      await toggleKillSwitch(ctx.user.id, input.active);
      return { success: true, killSwitchActive: input.active };
    }),
    updateRiskSettings: protectedProcedure.input(z.object({ maxDailyLossPct: z.string().optional(), maxLeverage: z.string().optional(), maxPositionSizePct: z.string().optional() })).mutation(async ({ input, ctx }) => {
      await updateRiskSettings(ctx.user.id, input);
      return { success: true };
    }),
    getDisplayMode: protectedProcedure.query(async ({ ctx }) => {
      const mode = await getDisplayMode(ctx.user.id);
      return { mode };
    }),
    setDisplayMode: protectedProcedure.input(z.object({ mode: z.enum(["live", "demo"]) })).mutation(async ({ input, ctx }) => {
      await setDisplayMode(ctx.user.id, input.mode);
      return { success: true, mode: input.mode };
    }),
  }),

  /* Web3 Wallet & Copytrade */
  web3Wallet: router({
    connect: protectedProcedure.input(z.object({ walletAddress: z.string().min(10).max(100), walletType: z.enum(["ledger", "metamask", "walletconnect", "coinbase", "other"]), chainId: z.number().optional(), maxPositionSizeUsd: z.number().optional(), maxDailyLossPct: z.number().min(0.5).max(50).optional(), ledgerDerivationPath: z.string().optional() })).mutation(async ({ input, ctx }) => {
      const session = await saveWeb3WalletSession({ userId: ctx.user!.id, walletAddress: input.walletAddress, walletType: input.walletType, chainId: input.chainId, maxPositionSizeUsd: input.maxPositionSizeUsd, maxDailyLossPct: input.maxDailyLossPct, ledgerDerivationPath: input.ledgerDerivationPath });
      return { success: true, walletAddress: session?.walletAddress, walletType: session?.walletType, copytradeEnabled: session?.copytradeEnabled ?? false, message: "Wallet registered. Copytrade will activate once the algo signal feed is wired in." };
    }),
    getSession: protectedProcedure.query(async ({ ctx }) => {
      const session = await getWeb3WalletSession(ctx.user!.id);
      if (!session) return null;
      return { walletAddress: session.walletAddress, walletType: session.walletType, chainId: session.chainId, copytradeEnabled: session.copytradeEnabled, killSwitchActive: session.killSwitchActive, maxPositionSizeUsd: session.maxPositionSizeUsd, maxDailyLossPct: session.maxDailyLossPct, status: session.status, connectedAt: session.connectedAt, lastSeenAt: session.lastSeenAt, ledgerDerivationPath: session.ledgerDerivationPath };
    }),
    toggleKillSwitch: protectedProcedure.input(z.object({ active: z.boolean() })).mutation(async ({ input, ctx }) => {
      await toggleWeb3KillSwitch(ctx.user!.id, input.active);
      return { success: true, killSwitchActive: input.active };
    }),
    revoke: protectedProcedure.mutation(async ({ ctx }) => { await revokeWeb3WalletSession(ctx.user!.id); return { success: true, message: "Wallet access revoked. No further signals will be dispatched." }; }),
    dispatchSignal: protectedProcedure.input(z.object({ pair: z.string(), side: z.enum(["buy", "sell"]), size: z.number().positive(), price: z.number().positive(), stopLoss: z.number().optional(), takeProfit: z.number().optional() })).mutation(async ({ input, ctx }) => dispatchCopytradeSignal(ctx.user!.id, input)),
  }),

  /* Demo Account */
  demo: router({
    create: protectedProcedure.input(z.object({ startingCapital: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
      const { accessToken } = await createDemoAccount({
        username: ctx.user.name ?? ctx.user.email ?? `user_${ctx.user.id}`,
        email: ctx.user.email ?? `user_${ctx.user.id}@anavitrade.demo`,
        startingCapital: String(input.startingCapital),
        userId: ctx.user.id,
      });
      return { accessToken };
    }),

    /* Per-User Demo (userId-based, protected — for Dashboard mode toggle) */
    getMyDemo: protectedProcedure.query(async ({ ctx }) => {
      const account = await getOrCreateDemoAccountForUser(ctx.user.id, {
        username: ctx.user.name ?? `user_${ctx.user.id}`,
        email: ctx.user.email ?? `user_${ctx.user.id}@anavitrade.demo`,
      });
      return { account };
    }),
    getMyTrades: protectedProcedure.query(async ({ ctx }) => {
      return getDemoTradesByUserId(ctx.user.id);
    }),
    getMyPortfolioSeries: protectedProcedure.query(async ({ ctx }) => {
      const account = await getDemoAccountByUserId(ctx.user.id);
      if (!account) return [];
      const snapshots = await getPortfolioSnapshotsByUserId(ctx.user.id);
      const JULY_1 = new Date("2026-07-01T00:00:00Z");
      const startingCapital = parseFloat(String(account.startingCapital));
      const firstSnapshotTime = snapshots.length > 0 ? new Date(snapshots[0].snapshotAt).getTime() : Date.now();
      const baselinePoints: Array<{ value: number; timestamp: number; label: string; tradeCount: number }> = [];
      const ONE_DAY = 24 * 60 * 60 * 1000;
      let cursor = JULY_1.getTime();
      while (cursor < firstSnapshotTime) {
        baselinePoints.push({ value: startingCapital, timestamp: cursor, label: new Date(cursor).toLocaleDateString("en-US", { month: "short", day: "numeric" }), tradeCount: 0 });
        cursor += ONE_DAY;
      }
      const tradePoints = snapshots.map((s) => ({ value: parseFloat(String(s.balance)), timestamp: new Date(s.snapshotAt).getTime(), label: new Date(s.snapshotAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }), tradeCount: s.tradeCount ?? 0 }));
      return [...baselinePoints, ...tradePoints];
    }),
    syncMySignals: protectedProcedure.mutation(async () => {
      return syncSignalsToDemoAccounts();
    }),
    getByToken: publicProcedure.input(z.object({ token: z.string() })).query(async ({ input }) => {
      const account = await getDemoAccountByToken(input.token);
      if (!account) throw new TRPCError({ code: "NOT_FOUND", message: "Demo account not found." });
      return account;
    }),
    getTrades: publicProcedure.input(z.object({ token: z.string() })).query(async ({ input }) => {
      const account = await getDemoAccountByToken(input.token);
      if (!account) return [];
      return getDemoTradesByAccountId(account.id);
    }),
    getPortfolioSeries: publicProcedure.input(z.object({ token: z.string() })).query(async ({ input }) => {
      const account = await getDemoAccountByToken(input.token);
      if (!account) return [];
      const snapshots = await getPortfolioSnapshotsByAccountId(account.id);
      const JULY_1 = new Date("2026-07-01T00:00:00Z");
      const startingCapital = parseFloat(String(account.startingCapital));
      const firstSnapshotTime = snapshots.length > 0 ? new Date(snapshots[0].snapshotAt).getTime() : Date.now();
      const baselinePoints: Array<{ value: number; timestamp: number; label: string; tradeCount: number }> = [];
      const ONE_DAY = 24 * 60 * 60 * 1000;
      let cursor = JULY_1.getTime();
      while (cursor < firstSnapshotTime) {
        baselinePoints.push({ value: startingCapital, timestamp: cursor, label: new Date(cursor).toLocaleDateString("en-US", { month: "short", day: "numeric" }), tradeCount: 0 });
        cursor += ONE_DAY;
      }
      const tradePoints = snapshots.map((s) => ({ value: parseFloat(String(s.balance)), timestamp: new Date(s.snapshotAt).getTime(), label: new Date(s.snapshotAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }), tradeCount: s.tradeCount ?? 0 }));
      return [...baselinePoints, ...tradePoints];
    }),
    triggerSync: publicProcedure.input(z.object({ token: z.string() })).mutation(async ({ input }) => {
      const account = await getDemoAccountByToken(input.token);
      if (!account) throw new TRPCError({ code: "NOT_FOUND", message: "Demo account not found." });
      return syncSignalsToDemoAccounts();
    }),
    getRecentSignals: publicProcedure.input(z.object({ token: z.string() })).query(async ({ input }) => {
      const account = await getDemoAccountByToken(input.token);
      if (!account) throw new TRPCError({ code: "NOT_FOUND", message: "Demo account not found." });
      const result = await getSignals({ page: 0, limit: 20, tier: "all", sortBy: "date" });
      return result.signals;
    }),
    getPublicDemoStats: publicProcedure.query(async () => getPublicDemoStats()),
    getPublicDemo: publicProcedure.query(async () => {
      const account = await getOrCreatePublicDemoAccount();
      return { token: PUBLIC_DEMO_TOKEN, account };
    }),
    bootstrapPublicDemo: publicProcedure.mutation(async () => { await getOrCreatePublicDemoAccount(); return syncSignalsToDemoAccounts(); }),
    updateSettings: publicProcedure.input(z.object({ token: z.string(), positionSizePct: z.number().min(0.1).max(25).optional(), leverage: z.number().min(1).max(10).optional(), strategyTier: z.enum(["A", "AB", "ABC"]).optional(), pyramidingEnabled: z.boolean().optional(), pyramidMaxEntries: z.number().int().min(1).max(10).optional(), pyramidScalePct: z.number().min(0.1).max(100).optional() })).mutation(async ({ input }) => { const { token, ...settings } = input; return updateDemoAccountSettings(token, settings); }),
  }),

  /* Signals */
  signals: router({
    list: publicProcedure.input(z.object({ page: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(20), tier: z.enum(["A", "B", "C", "all"]).default("all"), period: z.string().optional(), exchg: z.string().optional(), sortBy: z.enum(["quality", "date"]).default("quality") })).query(async ({ input }) => getSignals(input)),
    scraperStatus: publicProcedure.query(async () => getScraperStatus()),
    topBangers: publicProcedure.input(z.object({ limit: z.number().int().min(1).max(12).default(6) })).query(async ({ input }) => getTopBangers(input.limit)),
    stats: publicProcedure.query(async () => getSignalStats()),
    performance: publicProcedure.query(async () => getPerformance()),
    julyResults: publicProcedure.query(async () => getJulyResults()),
  }),

  /* Binance Auto-Trading */
  binance: router({
    getSettings: protectedProcedure.query(async () => getBinanceSettings()),
    getBalance: protectedProcedure.query(async () => {
      try { const balance = await getFuturesBalance(); return { balance, currency: "USDT" }; }
      catch (e: any) { return { balance: 0, currency: "USDT", error: e?.message }; }
    }),
    toggleKillSwitch: adminProcedure.input(z.object({ active: z.boolean() })).mutation(async ({ input, ctx }) => {
      await toggleBinanceKillSwitch(input.active);
      await writeAuditLog(ctx.user.id, input.active ? "BINANCE_KILL_SWITCH_ON" : "BINANCE_KILL_SWITCH_OFF");
      return { killSwitchActive: input.active };
    }),
    updateSettings: adminProcedure.input(z.object({ positionSizePct: z.number().min(0.5).max(25).optional(), leverage: z.number().int().min(1).max(20).optional(), autoTradeEnabled: z.boolean().optional() })).mutation(async ({ input }) => { await updateBinanceSettings(input); return getBinanceSettings(); }),
    getExecutions: protectedProcedure.input(z.object({ limit: z.number().int().min(1).max(200).default(50) })).query(async ({ input }) => getTradeExecutions(input.limit)),
  }),
});

export type AppRouter = typeof appRouter;
