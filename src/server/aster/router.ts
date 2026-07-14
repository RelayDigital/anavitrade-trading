import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import { getAsterConfig } from "./config";
import { getAsterAgentStatus, prepareAsterAgent, recordAsterApprovals, revokeAsterAgent, activateAsterWithWallet } from "./store";

export const asterRouter = router({
  getConfig: protectedProcedure.query(() => {
    const config = getAsterConfig();
    return {
      builderAddress: config.builderAddress,
      defaultFeeRate: config.defaultFeeRate,
      environment: config.environment,
      liveOrderSubmissionEnabled: config.liveOrderSubmissionEnabled,
      configured: Boolean(config.builderAddress),
    };
  }),

  getStatus: protectedProcedure.query(async ({ ctx }) => getAsterAgentStatus(ctx.user.id)),

  prepareAgent: protectedProcedure
    .input(z.object({
      asterAccountAddress: z.string().min(10).max(100),
      maxFeeRate: z.string().regex(/^\d+(\.\d+)?$/).optional(),
      approvalExpiresAt: z.coerce.date().optional(),
      ipWhitelist: z.array(z.string().min(3).max(64)).max(8).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      try {
        return await prepareAsterAgent({ userId: ctx.user.id, ...input });
      } catch (e: any) {
        if (e?.message === "ASTER_BUILDER_ADDRESS_NOT_CONFIGURED") {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Aster builder address is not configured." });
        }
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to prepare Aster agent." });
      }
    }),

  recordApprovals: protectedProcedure
    .input(z.object({
      agentApproved: z.boolean(),
      builderApproved: z.boolean(),
      maxFeeRate: z.string().regex(/^\d+(\.\d+)?$/).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      try {
        return await recordAsterApprovals({ userId: ctx.user.id, ...input });
      } catch (e: any) {
        if (e?.message === "ASTER_AGENT_NOT_FOUND") {
          throw new TRPCError({ code: "NOT_FOUND", message: "Aster agent has not been prepared." });
        }
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to record Aster approvals." });
      }
    }),

  revokeAgent: protectedProcedure.mutation(async ({ ctx }) => revokeAsterAgent(ctx.user.id)),

  /* ── One-click activation ──
     Uses the user's already-connected web3 wallet (no address input needed).
     See store.ts for the security rationale. */
  activateWithWallet: protectedProcedure
    .mutation(async ({ ctx }) => {
      try {
        return await activateAsterWithWallet({ userId: ctx.user.id });
      } catch (e: any) {
        if (e?.message === "NO_WALLET_CONNECTED") {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No wallet connected. Connect a wallet first." });
        }
        if (e?.message === "ASTER_BUILDER_ADDRESS_NOT_CONFIGURED") {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Aster builder address is not configured." });
        }
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to activate Aster." });
      }
    }),
});
