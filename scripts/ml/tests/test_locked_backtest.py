import unittest

from scripts.ml.pipeline.locked_backtest import (
    TradeConfig,
    portfolio_metrics,
    select_non_overlapping,
    select_threshold_locked,
    simulate_long_trade,
)


def bar(ts, o, h, l, c):
    return {"timestamp": ts, "open": o, "high": h, "low": l, "close": c, "volume": 1}


class LockedBacktestTests(unittest.TestCase):
    def test_next_open_entry_and_same_bar_ambiguity_is_stop_first(self):
        bars = [
            bar(0, 100, 101, 99, 100),
            bar(900_000, 100, 103, 97, 101),
        ]
        trade = simulate_long_trade(
            bars, signal_index=0, atr=1.0, funding_rates=[],
            config=TradeConfig(stop_atr_mult=1, rr_target=2, max_bars=1,
                               taker_fee_bps=0, slippage_bps=0),
        )
        self.assertEqual(trade["entryTimestamp"], 900_000)
        self.assertEqual(trade["reason"], "stop")
        self.assertEqual(trade["grossR"], -1.0)

    def test_costs_and_actual_funding_are_charged_in_r(self):
        bars = [
            bar(0, 100, 101, 99, 100),
            bar(900_000, 100, 100.5, 99.5, 100),
            bar(1_800_000, 100, 102.5, 99.5, 102),
        ]
        trade = simulate_long_trade(
            bars, signal_index=0, atr=1.0,
            funding_rates=[{"timestamp": 1_200_000, "rate": 0.001}],
            config=TradeConfig(stop_atr_mult=1, rr_target=2, max_bars=2,
                               taker_fee_bps=5, slippage_bps=0),
        )
        self.assertEqual(trade["reason"], "target")
        self.assertAlmostEqual(trade["fundingR"], -0.1, places=8)
        self.assertAlmostEqual(trade["feeR"], -0.101, places=8)
        self.assertAlmostEqual(trade["netR"], 1.799, places=8)

    def test_portfolio_rejects_overlap_and_respects_score_order(self):
        candidates = [
            {"symbol": "AAA", "entryTimestamp": 10, "exitTimestamp": 30, "probability": .8, "netR": 2},
            {"symbol": "BBB", "entryTimestamp": 10, "exitTimestamp": 20, "probability": .9, "netR": -1},
            {"symbol": "CCC", "entryTimestamp": 10, "exitTimestamp": 20, "probability": .7, "netR": 2},
            {"symbol": "BBB", "entryTimestamp": 15, "exitTimestamp": 25, "probability": .95, "netR": 2},
        ]
        accepted, rejected = select_non_overlapping(candidates, threshold=.7, max_positions=2)
        self.assertEqual([x["symbol"] for x in accepted], ["BBB", "AAA"])
        self.assertEqual({x["rejectionReason"] for x in rejected}, {"portfolio_cap", "symbol_open"})

    def test_threshold_is_selected_only_from_supplied_validation_candidates(self):
        candidates = []
        for i in range(10):
            candidates.append({
                "symbol": f"S{i}", "entryTimestamp": i * 10,
                "exitTimestamp": i * 10 + 5, "probability": .9 if i < 5 else .6,
                "netR": 2 if i < 5 else -1,
            })
        selected = select_threshold_locked(candidates, [.5, .8], min_trades=3, max_positions=10)
        self.assertEqual(selected["threshold"], .8)
        self.assertTrue(selected["validationGatePassed"])
        self.assertEqual(selected["metrics"]["trades"], 5)
        self.assertEqual(portfolio_metrics(selected["trades"])["profitFactor"], float("inf"))


if __name__ == "__main__":
    unittest.main()
