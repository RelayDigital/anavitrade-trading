export type LivePortfolioBalance = {
  exchange: string;
  label: string | null;
  equityUsd: number;
  availableUsd: number;
  error?: boolean;
};

export function composeLivePortfolio(input: {
  cexBalances: LivePortfolioBalance[];
  asterConnected: boolean;
  asterEquityUsd: number;
  asterAvailableUsd: number;
}) {
  const balances = [...input.cexBalances];
  if (input.asterConnected) {
    balances.push({
      exchange: "aster",
      label: "Aster Futures",
      equityUsd: input.asterEquityUsd,
      availableUsd: input.asterAvailableUsd,
    });
  }
  return {
    balances,
    totalEquityUsd: balances.reduce((sum, balance) => sum + balance.equityUsd, 0),
    totalAvailableUsd: balances.reduce((sum, balance) => sum + balance.availableUsd, 0),
  };
}
