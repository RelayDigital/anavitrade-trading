import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
  openId: text().unique(),
  name: text(),
  email: text().unique(),
  passwordHash: text(),
  loginMethod: text(),
  role: text().default("user").notNull(),
  emailVerified: integer({ mode: "boolean" }).default(false).notNull(),
  verificationToken: text(),
  verificationTokenExpiresAt: integer({ mode: "timestamp_ms" }),
  resetToken: text(),
  resetTokenExpiresAt: integer({ mode: "timestamp_ms" }),
  createdAt: integer({ mode: "timestamp_ms" }).$default(() => new Date()).notNull(),
  updatedAt: integer({ mode: "timestamp_ms" }).$default(() => new Date()).notNull(),
  lastSignedIn: integer({ mode: "timestamp_ms" }).$default(() => new Date()).notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

export const authSessions = sqliteTable("auth_sessions", {
  sessionIdDigest: text().primaryKey(),
  userId: integer({ mode: "number" }).notNull(),
  expiresAt: integer({ mode: "timestamp_ms" }).notNull(),
  revokedAt: integer({ mode: "timestamp_ms" }),
  createdAt: integer({ mode: "timestamp_ms" }).$default(() => new Date()).notNull(),
});

export const authSessionsUserExpiryIdx = index("auth_sessions_user_expiry_idx")
  .on(authSessions.userId, authSessions.expiresAt);

export type AuthSession = typeof authSessions.$inferSelect;

export const liveAccounts = sqliteTable("live_accounts", {
  id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
  userId: integer({ mode: "number" }).notNull(),
  status: text().default("pending").notNull(),
  subscriptionTier: text().default("none").notNull(),
  killSwitchActive: integer({ mode: "boolean" }).default(false).notNull(),
  maxDailyLossPct: text().default("5.00").notNull(),
  maxLeverage: text().default("10.00").notNull(),
  maxPositionSizePct: text().default("10.00").notNull(),
  maxTotalExposurePct: text().default("25.00").notNull(),
  displayMode: text().default("demo").notNull(),

  // Unified funds tracking — aggregated across all linked providers
  lastTotalEquityUsd: text(),               // cached sum of all linked exchange/wallet equity
  lastAvailableUsd: text(),                  // cached sum of available balances
  depositAddress: text(),                    // platform deposit address (for fiat/CEX deposit)
  linkedExchangesJson: text(),               // cache: JSON array of active exchange IDs

  createdAt: integer({ mode: "timestamp_ms" }).$default(() => new Date()).notNull(),
  updatedAt: integer({ mode: "timestamp_ms" }).$default(() => new Date()).notNull(),
});

export type LiveAccount = typeof liveAccounts.$inferSelect;
export type InsertLiveAccount = typeof liveAccounts.$inferInsert;

export const demoAccounts = sqliteTable("demo_accounts", {
  id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
  userId: integer({ mode: "number" }).unique(),
  username: text().notNull(),
  email: text().notNull(),
  startingCapital: text().notNull(),
  currentBalance: text().notNull(),
  status: text().default("active").notNull(),
  accessToken: text().notNull().unique(),
  lastSyncedSignalId: integer({ mode: "number" }),
  positionSizePct: text().default("5.00").notNull(),
  leverage: text().default("3.00").notNull(),
  strategyTier: text().default("A").notNull(),
  pyramidingEnabled: integer({ mode: "boolean" }).default(false).notNull(),
  pyramidMaxEntries: integer({ mode: "number" }).default(3).notNull(),
  pyramidScalePct: text().default("0.50").notNull(),
  createdAt: integer({ mode: "timestamp_ms" }).$default(() => new Date()).notNull(),
  updatedAt: integer({ mode: "timestamp_ms" }).$default(() => new Date()).notNull(),
});

export type DemoAccount = typeof demoAccounts.$inferSelect;
export type InsertDemoAccount = typeof demoAccounts.$inferInsert;

export const demoTrades = sqliteTable("demo_trades", {
  id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
  demoAccountId: integer({ mode: "number" }).notNull(),
  signalId: integer({ mode: "number" }),
  pair: text().notNull(),
  side: text().notNull(),
  entryPrice: text().notNull(),
  exitPrice: text(),
  quantity: text().notNull(),
  pnl: text(),
  pnlPct: text(),
  status: text().default("open").notNull(),
  indicatorName: text(),
  period: text(),
  qualityScore: integer({ mode: "number" }),
  qualityTier: text(),
  maxProfitPct: text(),
  openedAt: integer({ mode: "timestamp_ms" }).notNull(),
  closedAt: integer({ mode: "timestamp_ms" }),
});
export const demoTradesAccountSignalIdx = uniqueIndex("demo_trades_account_signal_idx")
  .on(demoTrades.demoAccountId, demoTrades.signalId);

export type DemoTrade = typeof demoTrades.$inferSelect;
export type InsertDemoTrade = typeof demoTrades.$inferInsert;

export const portfolioSnapshots = sqliteTable("portfolio_snapshots", {
  id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
  demoAccountId: integer({ mode: "number" }).notNull(),
  balance: text().notNull(),
  tradeCount: integer({ mode: "number" }).default(0).notNull(),
  snapshotAt: integer({ mode: "timestamp_ms" }).$default(() => new Date()).notNull(),
});
export const portfolioSnapshotsAccountTradeCountIdx = uniqueIndex("portfolio_snapshots_account_trade_count_idx")
  .on(portfolioSnapshots.demoAccountId, portfolioSnapshots.tradeCount);

export type PortfolioSnapshot = typeof portfolioSnapshots.$inferSelect;
export type InsertPortfolioSnapshot = typeof portfolioSnapshots.$inferInsert;

export const auditLog = sqliteTable("audit_log", {
  id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
  userId: integer({ mode: "number" }),
  action: text().notNull(),
  detail: text(),
  ipAddress: text(),
  createdAt: integer({ mode: "timestamp_ms" }).$default(() => new Date()).notNull(),
});

export type AuditLog = typeof auditLog.$inferSelect;

export const web3WalletSessions = sqliteTable("web3_wallet_sessions", {
  id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
  userId: integer({ mode: "number" }).notNull(),
  walletAddress: text().notNull(),
  chainId: integer({ mode: "number" }).default(1).notNull(),
  walletType: text().notNull(),
  copytradeEnabled: integer({ mode: "boolean" }).default(false).notNull(),
  maxPositionSizeUsd: text(),
  maxDailyLossPct: text().default("5.00"),
  killSwitchActive: integer({ mode: "boolean" }).default(false).notNull(),
  status: text().default("active").notNull(),
  connectedAt: integer({ mode: "timestamp_ms" }).$default(() => new Date()).notNull(),
  lastSeenAt: integer({ mode: "timestamp_ms" }).$default(() => new Date()).notNull(),
  revokedAt: integer({ mode: "timestamp_ms" }),
  ledgerDerivationPath: text(),
  notes: text(),
});

export type Web3WalletSession = typeof web3WalletSessions.$inferSelect;
export type InsertWeb3WalletSession = typeof web3WalletSessions.$inferInsert;

export const coinlegsSignals = sqliteTable("coinlegs_signals", {
  id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
  signalId: integer({ mode: "number" }).notNull().unique(),
  exchg: text().notNull(),
  marketName: text().notNull(),
  market: text().notNull(),
  indicatorName: text().notNull(),
  indicatorShortName: text().notNull(),
  typeId: integer({ mode: "number" }).notNull(),
  signal: integer({ mode: "number" }).notNull(),
  period: text().notNull(),
  price: text().notNull(),
  lastPrice: text(),
  percentage24: text(),
  minPrice: text(),
  maxPrice: text(),
  maxProfit: text(),
  maxProfitDuration: text(),
  signalDate: integer({ mode: "number" }).notNull(),
  signalDateUtc: text(),
  recordDate: integer({ mode: "number" }).notNull(),
  qualityScore: integer({ mode: "number" }).default(0).notNull(),
  qualityTier: text().default("C").notNull(),
  scrapedAt: integer({ mode: "number" }).$default(() => Date.now()).notNull(),
  outcomeValidated: integer({ mode: "number" }).default(0).notNull(),
  actualMaxProfitPct: text(),
  actualDrawdownPct: text(),
  outcomeWarning: integer({ mode: "number" }).default(0).notNull(),
});

export type CoinlegsSignal = typeof coinlegsSignals.$inferSelect;
export type InsertCoinlegsSignal = typeof coinlegsSignals.$inferInsert;

export const scraperRuns = sqliteTable("scraper_runs", {
  id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
  status: text().notNull(),
  signalsFetched: integer({ mode: "number" }).default(0).notNull(),
  signalsInserted: integer({ mode: "number" }).default(0).notNull(),
  signalsDuplicate: integer({ mode: "number" }).default(0).notNull(),
  tierA: integer({ mode: "number" }).default(0).notNull(),
  tierB: integer({ mode: "number" }).default(0).notNull(),
  tierC: integer({ mode: "number" }).default(0).notNull(),
  errorMessage: text(),
  durationMs: integer({ mode: "number" }),
  startedAt: integer({ mode: "timestamp_ms" }).$default(() => new Date()).notNull(),
  completedAt: integer({ mode: "timestamp_ms" }),
});

export type ScraperRun = typeof scraperRuns.$inferSelect;

export const binanceSettings = sqliteTable("binance_settings", {
  id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
  killSwitchActive: integer({ mode: "boolean" }).default(false).notNull(),
  positionSizePct: text().default("5.00").notNull(),
  leverage: integer({ mode: "number" }).default(3).notNull(),
  minQualityScore: integer({ mode: "number" }).default(0).notNull(),
  autoTradeEnabled: integer({ mode: "boolean" }).default(true).notNull(),
  updatedAt: integer({ mode: "timestamp_ms" }).notNull(),
});

export type BinanceSettings = typeof binanceSettings.$inferSelect;

export const tradeExecutions = sqliteTable("trade_executions", {
  id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
  signalId: integer({ mode: "number" }).notNull(),
  symbol: text().notNull(),
  side: text().notNull(),
  qty: text().notNull(),
  entryPrice: text(),
  stopLossPrice: text(),
  takeProfitPrice: text(),
  leverage: integer({ mode: "number" }).default(3).notNull(),
  orderId: text(),
  slOrderId: text(),
  tpOrderId: text(),
  status: text().default("pending").notNull(),
  errorMessage: text(),
  realisedPnl: text(),
  executedAt: integer({ mode: "timestamp_ms" }).$default(() => new Date()).notNull(),
  closedAt: integer({ mode: "timestamp_ms" }),
});

export type TradeExecution = typeof tradeExecutions.$inferSelect;
export type InsertTradeExecution = typeof tradeExecutions.$inferInsert;


export const asterAgentAccounts = sqliteTable("aster_agent_accounts", {
  id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
  userId: integer({ mode: "number" }).notNull(),
  liveAccountId: integer({ mode: "number" }).notNull(),
  asterAccountAddress: text().notNull(),
  signerAddress: text().notNull(),
  encryptedSignerPrivateKey: text().notNull(),
  builderAddress: text().notNull(),
  agentStatus: text().default("pending").notNull(),
  builderStatus: text().default("pending").notNull(),
  maxFeeRate: text(),
  feeRate: text(),
  permissionsJson: text(),
  ipWhitelistJson: text(),
  approvalExpiresAt: integer({ mode: "number" }),
  status: text().default("pending_approval").notNull(),
  lastValidatedAt: integer({ mode: "number" }),
  revokedAt: integer({ mode: "number" }),
  createdAt: integer({ mode: "number" }).$default(() => Date.now()).notNull(),
  updatedAt: integer({ mode: "number" }).$default(() => Date.now()).notNull(),
});

export type AsterAgentAccount = typeof asterAgentAccounts.$inferSelect;
export type InsertAsterAgentAccount = typeof asterAgentAccounts.$inferInsert;

/**
 * Non-custodial PancakeSwap delegation (Permit2 AllowanceTransfer model) — the
 * LIVE execution path. The user grants a capped, expiring allowance on a token
 * to Anavitrade's executor address via an off-chain-signed PermitSingle. Funds
 * never leave the user's wallet except for the exact pulled trade amount,
 * immediately swapped and delivered back to the user. One row per (user, token).
 */
export const pancakeswapDelegations = sqliteTable("pancakeswap_delegations", {
  id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
  userId: integer({ mode: "number" }).notNull(),
  walletAddress: text().notNull(),
  tokenAddress: text().notNull(),
  spenderAddress: text().notNull(),
  amountCap: text().notNull(),
  expiration: integer({ mode: "number" }).notNull(),
  nonce: integer({ mode: "number" }).notNull(),
  sigDeadline: integer({ mode: "number" }).notNull(),
  signature: text(),
  permitTxHash: text(),
  status: text().default("pending").notNull(), // pending | active | expired | revoked
  lastValidatedAt: integer({ mode: "number" }),
  revokedAt: integer({ mode: "number" }),
  createdAt: integer({ mode: "number" }).$default(() => Date.now()).notNull(),
  updatedAt: integer({ mode: "number" }).$default(() => Date.now()).notNull(),
});

export type PancakeswapDelegation = typeof pancakeswapDelegations.$inferSelect;
export type InsertPancakeswapDelegation = typeof pancakeswapDelegations.$inferInsert;

export const pancakeswapDelegationUserTokenIdx = uniqueIndex("pancakeswap_delegations_user_token_idx")
  .on(pancakeswapDelegations.userId, pancakeswapDelegations.tokenAddress);

/**
 * Custodial agent-wallet scaffold — NOT the live path (see docs). Mirrors
 * asterAgentAccounts's shape, but unlike Aster's Agent (which Aster's own
 * exchange contract restricts to perps-only/no-withdraw), a key stored here
 * has no protocol-level restriction: it is genuine full custody of whatever
 * is deposited to it. Kept inert (no dispatch wiring) until/unless a future
 * decision explicitly promotes this path.
 */
export const pancakeswapAgentAccounts = sqliteTable("pancakeswap_agent_accounts", {
  id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
  userId: integer({ mode: "number" }).notNull(),
  signerAddress: text().notNull(),
  encryptedSignerPrivateKey: text().notNull(),
  status: text().default("pending_approval").notNull(),
  lastValidatedAt: integer({ mode: "number" }),
  revokedAt: integer({ mode: "number" }),
  createdAt: integer({ mode: "number" }).$default(() => Date.now()).notNull(),
  updatedAt: integer({ mode: "number" }).$default(() => Date.now()).notNull(),
});

export type PancakeswapAgentAccount = typeof pancakeswapAgentAccounts.$inferSelect;
export type InsertPancakeswapAgentAccount = typeof pancakeswapAgentAccounts.$inferInsert;

/**
 * Per-user CEX (centralized exchange) API-key connections for non-custodial
 * copytrading. Key custody is deliberately SEPARATE from aster_agent_accounts
 * (handoff rule). CEXs need both an apiKey and an apiSecret (some also a
 * passphrase), each encrypted at rest via encryptKey().
 */
export const cexConnections = sqliteTable("cex_connections", {
  id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
  userId: integer({ mode: "number" }).notNull(),
  liveAccountId: integer({ mode: "number" }).notNull(),
  exchange: text().notNull(),                 // "binance" | "bitunix" | ...
  label: text(),
  encryptedApiKey: text().notNull(),
  encryptedApiSecret: text().notNull(),
  encryptedPassphrase: text(),                // e.g. OKX/KuCoin/Coinbase
  status: text().default("pending").notNull(), // pending | active | revoked | error
  copytradeEnabled: integer({ mode: "boolean" }).default(true).notNull(),
  killSwitchActive: integer({ mode: "boolean" }).default(false).notNull(),
  permissionsVerified: integer({ mode: "boolean" }).default(false).notNull(),
  withdrawalDisabledVerified: integer({ mode: "boolean" }).default(false).notNull(),
  attested: integer({ mode: "boolean" }).default(false).notNull(),
  lastBalanceUsd: text(),
  lastValidatedAt: integer({ mode: "timestamp_ms" }),
  revokedAt: integer({ mode: "timestamp_ms" }),
  consecutiveLosses: integer({ mode: "number" }).default(0).notNull(),
  circuitBreakerUntil: text(),  // ISO timestamp, nullable — set when consecutiveLosses reaches threshold
  highWaterMark: text(),        // decimal string, nullable — highest NAV observed for drawdown factor
  createdAt: integer({ mode: "timestamp_ms" }).$default(() => new Date()).notNull(),
  updatedAt: integer({ mode: "timestamp_ms" }).$default(() => new Date()).notNull(),
});

export type CexConnection = typeof cexConnections.$inferSelect;
export type InsertCexConnection = typeof cexConnections.$inferInsert;

export const tradeIntents = sqliteTable("trade_intents", {
  id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
  source: text().notNull(),
  externalSignalId: text(),
  symbol: text().notNull(),
  side: text().notNull(),
  orderType: text().default("market").notNull(),
  requestedNotionalUsd: text(),
  targetLeverage: integer({ mode: "number" }),
  limitPrice: text(),
  stopLossPrice: text(),
  takeProfitPrice: text(),
  thesis: text(),
  status: text().default("created").notNull(),
  createdBy: text(),
  sourceSignal: text(),
  createdAt: integer({ mode: "timestamp_ms" }).$default(() => new Date()).notNull(),
  updatedAt: integer({ mode: "timestamp_ms" }).$default(() => new Date()).notNull(),
});

export type TradeIntent = typeof tradeIntents.$inferSelect;
export type InsertTradeIntent = typeof tradeIntents.$inferInsert;

export const executionJobs = sqliteTable("execution_jobs", {
  id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
  tradeIntentId: integer({ mode: "number" }).notNull(),
  userId: integer({ mode: "number" }).notNull(),
  asterAgentAccountId: integer({ mode: "number" }),
  cexConnectionId: integer({ mode: "number" }),
  pancakeswapDelegationId: integer({ mode: "number" }),
  provider: text().default("aster").notNull(),
  riskApproved: integer({ mode: "boolean" }).default(false).notNull(),
  symbol: text().notNull(),
  side: text().notNull(),
  orderType: text().default("market").notNull(),
  notionalUsd: text(),
  quantity: text(),
  leverage: integer({ mode: "number" }),
  limitPrice: text(),
  status: text().default("queued").notNull(),
  idempotencyKey: text().notNull(),
  orderId: text(),
  errorMessage: text(),
  queuedAt: integer({ mode: "number" }).$default(() => Date.now()).notNull(),
  submittedAt: integer({ mode: "number" }),
  filledAt: integer({ mode: "number" }),
  cancelledAt: integer({ mode: "number" }),
  leaseToken: text(),
  leaseOwner: text(),
  leaseExpiresAt: integer({ mode: "number" }),
  leaseAttempt: integer({ mode: "number" }).default(0).notNull(),
  leaseAction: text(),
  leasePreviousStatus: text(),
  updatedAt: integer({ mode: "number" }).$default(() => Date.now()).notNull(),
});

export type ExecutionJob = typeof executionJobs.$inferSelect;
export type InsertExecutionJob = typeof executionJobs.$inferInsert;

/** Composite unique index: one job per (user, idempotencyKey) prevents duplicate mirrors. */
export const executionJobIdempotencyIdx = uniqueIndex("execution_jobs_idempotency_idx")
  .on(executionJobs.userId, executionJobs.idempotencyKey);
export const executionJobClaimEligibilityIdx = index("execution_jobs_claim_eligibility_idx")
  .on(executionJobs.provider, executionJobs.riskApproved, executionJobs.status, executionJobs.leaseAttempt, executionJobs.queuedAt);
export const executionJobLeaseExpiryIdx = index("execution_jobs_lease_expiry_idx")
  .on(executionJobs.status, executionJobs.leaseAction, executionJobs.leaseExpiresAt);

/** Performance indexes for coinlegs_signals — filtered queries, Top Bangers, tier-based profit queries. */
export const coinlegsTierSignalDateIdx = index("coinlegs_tier_signal_date_idx")
  .on(coinlegsSignals.qualityTier, coinlegsSignals.signalDate);
export const coinlegsQualityScoreIdx = index("coinlegs_quality_score_idx")
  .on(coinlegsSignals.qualityScore);
export const coinlegsTierMaxProfitIdx = index("coinlegs_tier_max_profit_idx")
  .on(coinlegsSignals.qualityTier, coinlegsSignals.maxProfit);

export const orderEvents = sqliteTable("order_events", {
  id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
  executionJobId: integer({ mode: "number" }).notNull(),
  provider: text().default("aster").notNull(),
  eventType: text().notNull(),
  exchangeOrderId: text(),
  payloadJson: text(),
  occurredAt: integer({ mode: "number" }).$default(() => Date.now()).notNull(),
});

export type OrderEvent = typeof orderEvents.$inferSelect;
export type InsertOrderEvent = typeof orderEvents.$inferInsert;

export const executionReports = sqliteTable("execution_reports", {
  reportId: text().primaryKey(),
  executionJobId: integer({ mode: "number" }).notNull(),
  leaseAttempt: integer({ mode: "number" }).notNull(),
  status: text().notNull(),
  orderId: text(),
  errorCode: text(),
  stopLossOrderId: text(),
  takeProfitOrderId: text(),
  compensationState: text(),
  compensationOrderId: text(),
  createdAt: integer({ mode: "number" }).$default(() => Date.now()).notNull(),
});

export const executionReportsJobIdx = index("execution_reports_job_idx")
  .on(executionReports.executionJobId, executionReports.leaseAttempt);

export type ExecutionReport = typeof executionReports.$inferSelect;
export type InsertExecutionReport = typeof executionReports.$inferInsert;

export const navSnapshots = sqliteTable("nav_snapshots", {
  id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
  userId: integer({ mode: "number" }).notNull(),
  provider: text().default("aster").notNull(),
  accountEquityUsd: text().notNull(),
  availableBalanceUsd: text(),
  unrealizedPnlUsd: text(),
  realizedPnlUsd: text(),
  depositsUsd: text(),
  withdrawalsUsd: text(),
  snapshotAt: integer({ mode: "number" }).$default(() => Date.now()).notNull(),
  source: text().default("provider_sync").notNull(),
});

export type NavSnapshot = typeof navSnapshots.$inferSelect;
export type InsertNavSnapshot = typeof navSnapshots.$inferInsert;

export const feePeriods = sqliteTable("fee_periods", {
  id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
  userId: integer({ mode: "number" }).notNull(),
  periodStart: integer({ mode: "timestamp_ms" }).notNull(),
  periodEnd: integer({ mode: "timestamp_ms" }).notNull(),
  startingNavUsd: text().notNull(),
  endingNavUsd: text(),
  highWaterMarkUsd: text().notNull(),
  managementFeeUsd: text().default("0.00").notNull(),
  performanceFeeUsd: text().default("0.00").notNull(),
  status: text().default("open").notNull(),
  crystallizedAt: integer({ mode: "timestamp_ms" }),
  createdAt: integer({ mode: "timestamp_ms" }).$default(() => new Date()).notNull(),
});

export type FeePeriod = typeof feePeriods.$inferSelect;
export type InsertFeePeriod = typeof feePeriods.$inferInsert;

export const feePayments = sqliteTable("fee_payments", {
  id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
  feePeriodId: integer({ mode: "number" }).notNull(),
  userId: integer({ mode: "number" }).notNull(),
  amountUsd: text().notNull(),
  status: text().default("pending").notNull(),
  txHash: text(),
  paidAt: integer({ mode: "timestamp_ms" }),
  createdAt: integer({ mode: "timestamp_ms" }).$default(() => new Date()).notNull(),
});

export type FeePayment = typeof feePayments.$inferSelect;
export type InsertFeePayment = typeof feePayments.$inferInsert;

export const globalSettings = sqliteTable("global_settings", {
  id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
  key: text().notNull().unique(),
  value: text().notNull(),
  updatedAt: integer({ mode: "timestamp_ms" }).$default(() => new Date()).notNull(),
});

export type GlobalSetting = typeof globalSettings.$inferSelect;
export type InsertGlobalSetting = typeof globalSettings.$inferInsert;

export const klines = sqliteTable("klines", {
  id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
  symbol: text().notNull(),
  timeframe: text().notNull(),
  openTime: integer({ mode: "number" }).notNull(),
  open: text().notNull(),
  high: text().notNull(),
  low: text().notNull(),
  close: text().notNull(),
  volume: text().notNull(),
  closeTime: integer({ mode: "number" }).notNull(),
  fetchedAt: integer({ mode: "number" }).notNull(),
});

export type Kline = typeof klines.$inferSelect;
export type InsertKline = typeof klines.$inferInsert;

export const klinesSymbolTfOpenTimeIdx = uniqueIndex("klines_symbol_tf_opentime_idx")
  .on(klines.symbol, klines.timeframe, klines.openTime);
export const klinesSymbolTfIdx = index("klines_symbol_tf_idx")
  .on(klines.symbol, klines.timeframe);

/* ─── Detector Signals ────────────────────────────────────────────────
 * Research table for the corpus builder. Stores every detection module's
 * output per candle. NOT queried by the live Worker — purely for offline
 * ML training and backtest analysis. Unique per (symbol, timeframe,
 * openTime, detectorName) so re-running the corpus builder is idempotent. */

export const detectorSignals = sqliteTable("detector_signals", {
  id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
  symbol: text().notNull(),
  timeframe: text().notNull(),
  openTime: integer({ mode: "number" }).notNull(),
  detectorName: text().notNull(),
  signal: integer({ mode: "number" }).notNull(),    // 1=buy, -1=sell, 0=neutral
  direction: text(),                                  // "long" | "short"
  confidence: integer({ mode: "number" }),            // 0-100
  score: integer({ mode: "number" }),                 // detector-specific
  metadataJson: text(),                               // full detector output
  tier: text(),                                       // "A" | "B" | "C" | null
  entryPrice: text(),
  stopLoss: text(),
  takeProfit: text(),
  exitSimR: text(),                                   // simulated R from smart exit
  exitReason: text(),                                 // "stop" | "trail" | "tp" | "time"
  createdAt: integer({ mode: "timestamp_ms" }).$default(() => new Date()).notNull(),
});

export const detectorSignalsSymTfTimeDetectorIdx = uniqueIndex("detector_signals_sym_tf_time_detector_idx")
  .on(detectorSignals.symbol, detectorSignals.timeframe, detectorSignals.openTime, detectorSignals.detectorName);

export type DetectorSignal = typeof detectorSignals.$inferSelect;
export type InsertDetectorSignal = typeof detectorSignals.$inferInsert;

export const derivativesSnapshots = sqliteTable("derivatives_snapshots", {
  id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
  symbol: text().notNull(),
  openInterest: text().notNull(),
  oiChange24hPct: text(),
  fundingRate: text(),
  longShortRatio: text(),
  longPct: text(),
  shortPct: text(),
  snapshotAt: integer({ mode: "number" }).notNull(),
});

export type DerivativesSnapshot = typeof derivativesSnapshots.$inferSelect;
export type InsertDerivativesSnapshot = typeof derivativesSnapshots.$inferInsert;

export const derivativesSnapshotsSymbolSnapshotAtIdx = index("derivatives_snapshots_symbol_snapshotat_idx")
  .on(derivativesSnapshots.symbol, derivativesSnapshots.snapshotAt);

export const analysisSignals = sqliteTable("analysis_signals", {
  id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
  source: text().notNull(),
  externalSignalId: text(),
  symbol: text().notNull(),
  timeframe: text().notNull(),
  direction: text().notNull(),
  entry: text().notNull(),
  stopLoss: text(),
  takeProfit: text(),
  score: integer({ mode: "number" }).default(0).notNull(),
  tier: text().default("C").notNull(),
  thesis: text(),
  componentsJson: text(),
  structuralScore: integer({ mode: "number" }),
  structuralConfidence: text(),
  metadataJson: text(),
  dispatched: integer({ mode: "number" }).default(0).notNull(),
  createdAt: integer({ mode: "number" }).notNull(),
  dispatchedAt: integer({ mode: "number" }),
});

export type AnalysisSignal = typeof analysisSignals.$inferSelect;
export type InsertAnalysisSignal = typeof analysisSignals.$inferInsert;

export const analysisSignalsExternalSignalIdIdx = uniqueIndex(
  "analysis_signals_external_signal_id_idx",
).on(analysisSignals.externalSignalId);

export const analysisSignalsSourceIdx = index("analysis_signals_source_idx")
  .on(analysisSignals.source);
export const analysisSignalsTierCreatedAtIdx = index("analysis_signals_tier_createdat_idx")
  .on(analysisSignals.tier, analysisSignals.createdAt);
export const analysisSignalsSymbolCreatedAtIdx = index("analysis_signals_symbol_createdat_idx")
  .on(analysisSignals.symbol, analysisSignals.createdAt);

export const analysisRuns = sqliteTable("analysis_runs", {
  id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
  source: text().notNull(),
  status: text().notNull(),
  signalsGenerated: integer({ mode: "number" }).default(0).notNull(),
  signalsDispatched: integer({ mode: "number" }).default(0).notNull(),
  signalsRejected: integer({ mode: "number" }).default(0).notNull(),
  klineUpdates: integer({ mode: "number" }).default(0).notNull(),
  errorMessage: text(),
  durationMs: integer({ mode: "number" }),
  startedAt: integer({ mode: "number" }).notNull(),
  completedAt: integer({ mode: "number" }),
});

export type AnalysisRun = typeof analysisRuns.$inferSelect;
export type InsertAnalysisRun = typeof analysisRuns.$inferInsert;

/* ─── ML Inferences ────────────────────────────────────────────────────
 * Stores every MTF model inference result for audit trail and calibration
 * data collection. Recorded by the inference router on every TRADE/SKIP
 * decision. Used to build the 500+ live prediction + outcome dataset
 * needed for future isotonic calibration. */

export const mlInferences = sqliteTable("ml_inferences", {
  id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
  tradeIntentId: integer({ mode: "number" }),
  symbol: text().notNull(),
  direction: text().notNull(),
  proba: text().notNull(),
  threshold: text().notNull(),
  decision: text().notNull(),
  regime: text().notNull(),
  featureVectorJson: text(),
  /* Failing gate name from the ordered dispatch gate (PRD R1.1), or "passed".
   * One of: passed | universe | tier_b_paper | tier_c_reject | rsi_extension |
   * ml | ml_unreachable. Nullable for pre-gate historical rows. */
  gateResult: text("gate_result"),
  createdAt: integer({ mode: "timestamp_ms" }).$default(() => new Date()).notNull(),
});

export type MlInference = typeof mlInferences.$inferSelect;
export type InsertMlInference = typeof mlInferences.$inferInsert;
