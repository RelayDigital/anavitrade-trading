import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import { getAsterConfig } from "./config";
import {
  completeAsterRegistration,
  getAsterAgentStatus,
  prepareAsterAgent,
  prepareAsterRegistration,
  revokeAsterAgent,
  syncAsterFuturesBalance,
} from "./store";

const activationModeSchema = z.enum(["approveAgentWithBuilder", "registerAndApproveAgent"]);
const activationEndpointSchema = z.enum(["/fapi/v3/approveAgent", "/fapi/v3/registerAndApproveAgent"]);

const registrationParamsSchema = z.object({
  agentName: z.string().min(1).max(64),
  agentAddress: z.string().min(10).max(100),
  ipWhitelist: z.string().max(512).optional(),
  expired: z.number().int().positive(),
  canSpotTrade: z.boolean(),
  canPerpTrade: z.boolean(),
  canWithdraw: z.boolean(),
  builder: z.string().min(10).max(100),
  maxFeeRate: z.string().regex(/^\d+(\.\d+)?$/),
  builderName: z.string().min(1).max(64),
  asterChain: z.string().min(1).max(64).optional(),
  user: z.string().min(10).max(100),
  nonce: z.number().int().positive(),
});

export const asterRouter = router({
  getConfig: protectedProcedure.query(() => {
    const config = getAsterConfig();
    return {
      builderAddress: config.builderAddress,
      defaultFeeRate: config.defaultFeeRate,
      environment: config.environment,
      asterChain: config.asterChain,
      codeSigningChainId: config.codeSigningChainId,
      registrationSigningChainId: config.registrationSigningChainId,
      includeCompatParams: config.includeCompatParams,
      liveOrderSubmissionEnabled: config.liveOrderSubmissionEnabled,
      configured: Boolean(config.builderAddress) || config.agentOnlyEnabled,
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
    .mutation(() => {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Aster approvals must be verified through signed registration readback. Use Sign & Activate Aster.",
      });
    }),

  revokeAgent: protectedProcedure.mutation(async ({ ctx }) => revokeAsterAgent(ctx.user.id)),

  syncBalance: protectedProcedure.mutation(async ({ ctx }) => {
    try {
      return await syncAsterFuturesBalance(ctx.user.id);
    } catch (e: any) {
      if (e?.message === "ASTER_AGENT_NOT_FOUND") {
        throw new TRPCError({ code: "NOT_FOUND", message: "No active Aster agent found." });
      }
      if (e?.message === "ASTER_APPROVAL_NOT_CONFIRMED") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Aster approval is not confirmed." });
      }
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to sync Aster balance." });
    }
  }),

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
      activationMode: activationModeSchema,
      endpoint: activationEndpointSchema,
      signatureChainId: z.number().int().positive(),
      params: registrationParamsSchema.or(z.object({
        user: z.string().min(10).max(100),
        nonce: z.number().int().positive(),
        agentName: z.string().min(1).max(64),
        agentAddress: z.string().min(10).max(100),
        expired: z.number().int().positive(),
        signatureChainId: z.number().int().positive(),
        canSpotTrade: z.boolean(),
        canPerpTrade: z.boolean(),
        canWithdraw: z.boolean(),
        ipWhitelist: z.string().max(512).optional(),
      })),
      signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
    }))
    .mutation(async ({ input, ctx }) => {
      try {
        return await completeAsterRegistration({
          userId: ctx.user.id,
          activationMode: input.activationMode,
          endpoint: input.endpoint,
          signatureChainId: input.signatureChainId,
          params: input.params!,
          signature: input.signature,
        });
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
