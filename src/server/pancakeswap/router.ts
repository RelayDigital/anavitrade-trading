import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import { getPancakeswapConfig } from "./config";
import {
  completePancakeswapDelegation,
  getPancakeswapDelegationStatus,
  preparePancakeswapDelegation,
  revokePancakeswapDelegation,
} from "./store";

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const pancakeswapRouter = router({
  getConfig: protectedProcedure.query(() => {
    const config = getPancakeswapConfig();
    return {
      permit2Address: config.permit2Address,
      universalRouterAddress: config.universalRouterAddress,
      environment: config.environment,
      liveOrderSubmissionEnabled: config.liveOrderSubmissionEnabled,
      configured: config.configured,
    };
  }),

  getStatus: protectedProcedure
    .input(z.object({ tokenAddress: addressSchema }))
    .query(({ input, ctx }) => getPancakeswapDelegationStatus(ctx.user.id, input.tokenAddress)),

  prepareDelegation: protectedProcedure
    .input(z.object({
      tokenAddress: addressSchema,
      amountCap: z.string().regex(/^\d+$/),
      expirationDays: z.number().int().min(1).max(365).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      try {
        return await preparePancakeswapDelegation({ userId: ctx.user.id, ...input });
      } catch (e: any) {
        if (e?.message === "NO_WALLET_CONNECTED") {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No wallet connected. Connect a wallet first." });
        }
        if (e?.message === "WALLET_ADDRESS_MISSING") {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Connected wallet is missing an address. Reconnect your wallet and try again." });
        }
        if (e?.message === "WALLET_KILL_SWITCH_ACTIVE") {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Wallet kill switch is active. Resume trading before activating PancakeSwap." });
        }
        if (e?.message === "PANCAKESWAP_EXECUTOR_NOT_CONFIGURED") {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "PancakeSwap executor is not configured." });
        }
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to prepare PancakeSwap delegation." });
      }
    }),

  completeDelegation: protectedProcedure
    .input(z.object({
      tokenAddress: addressSchema,
      signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
    }))
    .mutation(async ({ input, ctx }) => {
      try {
        return await completePancakeswapDelegation({
          userId: ctx.user.id,
          tokenAddress: input.tokenAddress,
          signature: input.signature as `0x${string}`,
        });
      } catch (e: any) {
        if (e?.message === "PANCAKESWAP_DELEGATION_NOT_FOUND") {
          throw new TRPCError({ code: "NOT_FOUND", message: "PancakeSwap delegation was not prepared. Start activation again." });
        }
        if (e?.message === "PANCAKESWAP_DELEGATION_NOT_PENDING") {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "PancakeSwap delegation is not pending. Start activation again." });
        }
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to activate PancakeSwap delegation." });
      }
    }),

  revokeDelegation: protectedProcedure
    .input(z.object({ tokenAddress: addressSchema }))
    .mutation(async ({ input, ctx }) => revokePancakeswapDelegation(ctx.user.id, input.tokenAddress)),
});
