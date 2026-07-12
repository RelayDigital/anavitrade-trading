import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import { listExchangesPublic } from "./registry";
import {
  listCexConnections, prepareCexConnection, validateCexConnection,
  revokeCexConnection, toggleCexKillSwitch, getCexBalance,
} from "./store";
import { getAllCexBalances, getUnifiedSummary } from "./store";

const exchangeInput = z.object({ exchange: z.string().min(2).max(20) });

const EXCHANGE_ERROR_PREFIXES = [
  "BINANCE_", "BITUNIX_", "BYBIT_", "OKX_", "KRAKEN_", "KUCOIN_", "GATEIO_", "COINBASE_",
];

export const cexRouter = router({
  /** Consumer dropdown source of truth. */
  listExchanges: protectedProcedure.query(() => listExchangesPublic()),

  /** All of the user's non-revoked connections. */
  getConnections: protectedProcedure.query(async ({ ctx }) => listCexConnections(ctx.user.id)),

  /** Store keys (encrypted) for an exchange — status stays pending until validate. */
  connect: protectedProcedure
    .input(z.object({
      exchange: z.string().min(2).max(20),
      apiKey: z.string().min(8).max(256),
      apiSecret: z.string().min(8).max(256),
      passphrase: z.string().max(256).optional(),
      attestTradeOnly: z.boolean(),
      label: z.string().max(64).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      try {
        await prepareCexConnection({ userId: ctx.user.id, ...input });
        const result = await validateCexConnection(ctx.user.id, input.exchange);
        return { success: true, ...result };
      } catch (e: any) {
        const msg = String(e?.message ?? "");
        if (msg.includes("EXCHANGE_NOT_LIVE")) throw new TRPCError({ code: "BAD_REQUEST", message: "That exchange isn't available yet." });
        if (msg.includes("PASSPHRASE_REQUIRED")) throw new TRPCError({ code: "BAD_REQUEST", message: "This exchange requires an API passphrase." });
        if (msg.includes("KEY_HAS_WITHDRAWAL_PERMISSION")) throw new TRPCError({ code: "BAD_REQUEST", message: "This API key has withdrawal permission enabled. Create a trade-only key (withdrawals OFF) and try again." });
        if (msg.includes("ATTESTATION_REQUIRED")) throw new TRPCError({ code: "BAD_REQUEST", message: "Please confirm withdrawals are disabled on this key." });
        if (EXCHANGE_ERROR_PREFIXES.some(p => msg.startsWith(p))) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "The exchange rejected these keys. Double-check the key, secret, and that Futures trading is enabled." });
        }
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Could not connect exchange." });
      }
    }),

  /** Re-validate an existing connection (refresh balance / permission state). */
  validate: protectedProcedure.input(exchangeInput).mutation(async ({ input, ctx }) => {
    try {
      return await validateCexConnection(ctx.user.id, input.exchange);
    } catch (e: any) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Validation failed. The keys may have been revoked on the exchange." });
    }
  }),

  revoke: protectedProcedure.input(exchangeInput).mutation(async ({ input, ctx }) =>
    revokeCexConnection(ctx.user.id, input.exchange)),

  toggleKillSwitch: protectedProcedure
    .input(exchangeInput.extend({ active: z.boolean() }))
    .mutation(async ({ input, ctx }) => toggleCexKillSwitch(ctx.user.id, input.exchange, input.active)),

  getBalance: protectedProcedure.input(exchangeInput).query(async ({ input, ctx }) =>
    getCexBalance(ctx.user.id, input.exchange)),

  /** Unified balance: all active CEX connections' balances + aggregated total. */
  getUnifiedBalance: protectedProcedure.query(async ({ ctx }) => {
    const balances = await getAllCexBalances(ctx.user.id);
    const summary = getUnifiedSummary(balances);
    return { balances, summary };
  }),
});
