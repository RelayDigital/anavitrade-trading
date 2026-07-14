import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import { getAsterConfig } from "./config";
import {
  completeAsterRegistration,
  getAsterAgentStatus,
  prepareAsterAgent,
  prepareAsterRegistration,
  recordAsterApprovals,
  revokeAsterAgent,
} from "./store";

const registrationParamsSchema = z.object({
  user: z.string().min(10).max(100),
  nonce: z.string().regex(/^\d+$/),
  agentName: z.string().min(1).max(64),
  agentAddress: z.string().min(10).max(100),
  expired: z.string().regex(/^\d+$/),
  signatureChainId: z.literal("56"),
  canSpotTrade: z.enum(["true", "false"]),
  canPerpTrade: z.enum(["true", "false"]),
  canWithdraw: z.enum(["true", "false"]),
  ipWhitelist: z.string().max(512),
});

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

  prepareRegistration: protectedProcedure
    .mutation(async ({ ctx }) => {
      try {
        return await prepareAsterRegistration({ userId: ctx.user.id });
      } catch (e: any) {
        if (e?.message === "NO_WALLET_CONNECTED") {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No wallet connected. Connect a wallet first." });
        }
        if (e?.message === "ASTER_BUILDER_ADDRESS_NOT_CONFIGURED") {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Aster builder address is not configured." });
        }
        if (e?.message === "WALLET_ADDRESS_MISSING") {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Connected wallet is missing an address. Reconnect your wallet and try again." });
        }
        if (e?.message === "WALLET_KILL_SWITCH_ACTIVE") {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Wallet kill switch is active. Resume trading before activating Aster." });
        }
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to prepare Aster registration." });
      }
    }),

  activateWithWallet: protectedProcedure
    .mutation(() => {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Aster activation now requires a wallet signature. Open Aster onboarding and use Sign & Activate Aster.",
      });
    }),

  completeRegistration: protectedProcedure
    .input(z.object({
      params: registrationParamsSchema,
      signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
    }))
    .mutation(async ({ input, ctx }) => {
      try {
        return await completeAsterRegistration({ userId: ctx.user.id, ...input });
      } catch (e: any) {
        if (String(e?.message ?? "").startsWith("ASTER_REGISTRATION_")) {
          throw new TRPCError({ code: "BAD_REQUEST", message: e.message });
        }
        if (e?.message === "ASTER_AGENT_NOT_FOUND") {
          throw new TRPCError({ code: "NOT_FOUND", message: "Aster registration was not prepared. Start activation again." });
        }
        if (e?.message === "ASTER_AGENT_NOT_PENDING") {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Aster registration is not pending. Start activation again." });
        }
        if (String(e?.message ?? "").startsWith("ASTER_AGENT_REGISTRATION_REJECTED")) {
          throw new TRPCError({ code: "BAD_REQUEST", message: e.message });
        }
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to register Aster agent." });
      }
    }),
});
