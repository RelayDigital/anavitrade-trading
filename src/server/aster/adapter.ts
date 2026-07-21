import { eq } from "drizzle-orm";
import { asterAgentAccounts } from "../../drizzle/schema";
import { getDb, decryptKey } from "../db";
import { privateKeyToAccount } from "viem/accounts";
import { AsterApiClient } from "./client";
import type { AsterOrderRequest, AsterStrategySubOrder, ExecutionAdapter, ExecutionAdapterReceipt } from "./types";

/**
 * Aster DEX execution adapter - conforms to the shared ExecutionAdapter contract
 * (provider "aster"). Decrypts the agent's signer key, signs orders with EIP-712,
 * and submits to the Aster REST API.
 */
export class AsterExecutionAdapter implements ExecutionAdapter {
  constructor(private readonly agentId: number) {}

  private async loadSigner() {
    const db = getDb();
    const [row] = await db.select().from(asterAgentAccounts)
      .where(eq(asterAgentAccounts.id, this.agentId))
      .limit(1);
    if (!row) throw new Error("ASTER_AGENT_NOT_FOUND");
    if (row.status !== "active") throw new Error("ASTER_AGENT_NOT_ACTIVE");
    const builderReady = row.builderAddress
      ? row.builderStatus === "approved"
      : row.builderStatus === "not_required" || row.builderStatus === "approved";
    if (row.agentStatus !== "approved" || !builderReady) {
      throw new Error("ASTER_APPROVAL_NOT_CONFIRMED");
    }

    const feeRate = Number(row.feeRate ?? 0);
    const maxFeeRate = Number(row.maxFeeRate ?? row.feeRate ?? 0);
    if (!Number.isFinite(feeRate) || !Number.isFinite(maxFeeRate) || feeRate > maxFeeRate) {
      throw new Error("ASTER_FEE_RATE_EXCEEDS_APPROVAL");
    }

    const privateKey = await decryptKey(row.encryptedSignerPrivateKey);
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    return { row, account };
  }

  async submitOrder(_jobId: number, request: any): Promise<ExecutionAdapterReceipt> {
    const { row, account } = await this.loadSigner();
    const client = new AsterApiClient();
    const orderRequest: AsterOrderRequest = {
      user: row.asterAccountAddress,
      signer: row.signerAddress,
      symbol: request.symbol,
      side: request.side,
      type: request.type ?? "MARKET",
      quantity: request.quantity,
      price: request.price,
      timeInForce: request.timeInForce,
      newClientOrderId: request.newClientOrderId,
      leverage: request.leverage ?? 1,
      builder: row.builderAddress,
      feeRate: row.feeRate ?? undefined,
    };

    if (orderRequest.leverage !== undefined) {
      await client.setLeverage(orderRequest.symbol, orderRequest.leverage, orderRequest.user, account);
    }

    const hasStop = Boolean(request.stopLossPrice);
    const hasTakeProfit = Boolean(request.takeProfitPrice);
    if (hasStop !== hasTakeProfit) throw new Error("ASTER_OTOCO_REQUIRES_STOP_LOSS_AND_TAKE_PROFIT");
    if (hasStop && hasTakeProfit) {
      const exitSide = orderRequest.side === "BUY" ? "SELL" : "BUY";
      const baseClientId = (orderRequest.newClientOrderId ?? String(Date.now())).slice(0, 24);
      const entryOrder: AsterStrategySubOrder = {
        strategySubId: "1",
        securityType: "USDT_FUTURES",
        symbol: orderRequest.symbol,
        side: orderRequest.side,
        positionSide: "BOTH",
        type: orderRequest.type,
        quantity: orderRequest.quantity,
        clientOrderId: `${baseClientId}-entry`.slice(0, 36),
        ...(orderRequest.type === "LIMIT" ? { price: orderRequest.price, timeInForce: orderRequest.timeInForce ?? "GTC" } : {}),
      };
      return client.submitStrategyOrder({
        user: row.asterAccountAddress,
        signer: row.signerAddress,
        clientStrategyId: `${baseClientId}-otoco`.slice(0, 28),
        strategyType: "OTOCO",
        builder: row.builderAddress,
        feeRate: row.feeRate ?? undefined,
        subOrderList: [
          entryOrder,
          {
            strategySubId: "2",
            securityType: "USDT_FUTURES",
            symbol: orderRequest.symbol,
            side: exitSide,
            positionSide: "BOTH",
            type: "STOP_MARKET",
            quantity: orderRequest.quantity,
            stopPrice: request.stopLossPrice,
            reduceOnly: "true",
            workingType: "CONTRACT_PRICE",
            clientOrderId: `${baseClientId}-sl`.slice(0, 36),
            firstDrivenId: "1",
            firstDrivenOn: "FILLED",
            firstTrigger: "PLACE_ORDER",
            secondDrivenId: "3",
            secondDrivenOn: "FILLED",
            secondTrigger: "CANCEL_ORDER",
          },
          {
            strategySubId: "3",
            securityType: "USDT_FUTURES",
            symbol: orderRequest.symbol,
            side: exitSide,
            positionSide: "BOTH",
            type: "TAKE_PROFIT_MARKET",
            quantity: orderRequest.quantity,
            stopPrice: request.takeProfitPrice,
            reduceOnly: "true",
            workingType: "CONTRACT_PRICE",
            clientOrderId: `${baseClientId}-tp`.slice(0, 36),
            firstDrivenId: "1",
            firstDrivenOn: "FILLED",
            firstTrigger: "PLACE_ORDER",
            secondDrivenId: "2",
            secondDrivenOn: "FILLED",
            secondTrigger: "CANCEL_ORDER",
          },
        ],
      }, account);
    }

    return client.submitOrder(orderRequest, account);
  }

  async queryOrder(symbol: string, orderId: string): Promise<ExecutionAdapterReceipt> {
    const { row, account } = await this.loadSigner();
    return new AsterApiClient().queryOrder({ user: row.asterAccountAddress, symbol, orderId }, account);
  }

  async queryStrategyOrder(strategyId: string): Promise<ExecutionAdapterReceipt> {
    const { row, account } = await this.loadSigner();
    return new AsterApiClient().queryStrategyOrder(row.asterAccountAddress, strategyId, account);
  }

  async readBalance() {
    const { row, account } = await this.loadSigner();
    return new AsterApiClient().getFuturesBalance(row.asterAccountAddress, account);
  }

  async cancelOrder(orderId: string, symbol?: string): Promise<ExecutionAdapterReceipt> {
    const { row, account } = await this.loadSigner();
    if (!symbol) throw new Error("ASTER_CANCEL_SYMBOL_REQUIRED");
    return new AsterApiClient().cancelOrder({ user: row.asterAccountAddress, symbol, orderId }, account);
  }
}
