import { z } from "zod";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, adminProcedure, router } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import {
  getLiveAccountByUserId, toggleKillSwitch, updateRiskSettings,
  createDemoAccount, getDemoTradesByAccountId,
  saveWeb3WalletSession, getWeb3WalletSession, revokeWeb3WalletSession,
  toggleWeb3KillSwitch, dispatchCopytradeSignal,
  writeAuditLog,
  getSignals, getScraperStatus, getTopBangers, getSignalStats, getPerformance,
  getPortfolioSnapshotsByAccountId,
  syncSignalsToDemoAccount,
  getJulyResults,
  getPublicDemoAccount, getPublicDemoAccountForRead, updateDemoAccountSettingsForUser, PUBLIC_DEMO_READ_KEY,
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
import { pancakeswapRouter } from "./pancakeswap/router";
import { cexRouter } from "./cex/router";
import { execRouter } from "./execution/router";
import { inferenceRouter } from "./ml/inference-router";
import { authRouter } from "./auth/router";

export const appRouter = router({
  system: systemRouter,
  aster: asterRouter,
  pancakeswap: pancakeswapRouter,
  cex: cexRouter,
  exec: execRouter,
  inference: inferenceRouter,

  auth: authRouter,

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
      await createDemoAccount({
        username: ctx.user.name ?? ctx.user.email ?? `user_${ctx.user.id}`,
        email: ctx.user.email ?? `user_${ctx.user.id}@anavitrade.demo`,
        startingCapital: String(input.startingCapital),
        userId: ctx.user.id,
      });
      return { success: true };
    }),

    /* Per-User Demo (userId-based, protected — for Dashboard mode toggle) */
    getMyDemo: protectedProcedure.query(async ({ ctx }) => {
      const account = await getOrCreateDemoAccountForUser(ctx.user.id, {
        username: ctx.user.name ?? `user_${ctx.user.id}`,
        email: ctx.user.email ?? `user_${ctx.user.id}@anavitrade.demo`,
      });
      const { accessToken: _accessToken, ...clientAccount } = account;
      return { account: clientAccount };
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
    syncMySignals: protectedProcedure.mutation(async ({ ctx }) => {
      return syncSignalsToDemoAccount(ctx.user.id);
    }),
    getByToken: publicProcedure.input(z.object({ token: z.string() })).query(async ({ input }) => {
      const account = await getPublicDemoAccountForRead(input.token);
      if (!account) throw new TRPCError({ code: "NOT_FOUND", message: "Demo account not found." });
      const { accessToken: _accessToken, ...clientAccount } = account;
      return clientAccount;
    }),
    getTrades: publicProcedure.input(z.object({ token: z.string() })).query(async ({ input }) => {
      const account = await getPublicDemoAccountForRead(input.token);
      if (!account) return [];
      return getDemoTradesByAccountId(account.id);
    }),
    getPortfolioSeries: publicProcedure.input(z.object({ token: z.string() })).query(async ({ input }) => {
      const account = await getPublicDemoAccountForRead(input.token);
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
    triggerSync: protectedProcedure.input(z.object({ token: z.string().optional() })).mutation(async ({ ctx }) => {
      return syncSignalsToDemoAccount(ctx.user.id);
    }),
    getRecentSignals: publicProcedure.input(z.object({ token: z.string() })).query(async ({ input }) => {
      const account = await getPublicDemoAccountForRead(input.token);
      if (!account) throw new TRPCError({ code: "NOT_FOUND", message: "Demo account not found." });
      const result = await getSignals({ page: 0, limit: 20, tier: "all", sortBy: "date" });
      return result.signals;
    }),
    getPublicDemoStats: publicProcedure.query(async () => getPublicDemoStats()),
    getPublicDemo: publicProcedure.query(async () => {
      const account = await getPublicDemoAccount();
      if (!account) return { token: PUBLIC_DEMO_READ_KEY, account: null };
      const { accessToken: _accessToken, ...clientAccount } = account;
      return { token: PUBLIC_DEMO_READ_KEY, account: clientAccount };
    }),
    updateSettings: protectedProcedure.input(z.object({ token: z.string().optional(), positionSizePct: z.number().min(0.1).max(25).optional(), leverage: z.number().min(1).max(10).optional(), strategyTier: z.enum(["A", "AB", "ABC"]).optional(), pyramidingEnabled: z.boolean().optional(), pyramidMaxEntries: z.number().int().min(1).max(10).optional(), pyramidScalePct: z.number().min(0.1).max(100).optional() })).mutation(async ({ input, ctx }) => { const { token: _ignoredToken, ...settings } = input; return updateDemoAccountSettingsForUser(ctx.user.id, settings); }),
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
