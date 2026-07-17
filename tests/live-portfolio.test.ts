import assert from "node:assert/strict";
import { composeLivePortfolio } from "../src/lib/livePortfolio";

const portfolio = composeLivePortfolio({
  cexBalances: [],
  asterConnected: true,
  asterEquityUsd: 1250.5,
  asterAvailableUsd: 900.25,
});

assert.deepEqual(portfolio.balances, [
  {
    exchange: "aster",
    label: "Aster Futures",
    equityUsd: 1250.5,
    availableUsd: 900.25,
  },
]);
assert.equal(portfolio.totalEquityUsd, 1250.5);
assert.equal(portfolio.totalAvailableUsd, 900.25);

console.log("LIVE_PORTFOLIO_TEST_PASS");
