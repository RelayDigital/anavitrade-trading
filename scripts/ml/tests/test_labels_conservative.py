import unittest

from scripts.ml.pipeline.config import PipelineConfig
from scripts.ml.pipeline.features import EnrichedBar
from scripts.ml.pipeline.labels import compute_outcome


def bar(timestamp, open_, high, low, close, atr=1.0):
    values = {
        field: 0.0
        for field in EnrichedBar.__dataclass_fields__
    }
    values.update(
        timestamp=timestamp,
        open=open_,
        high=high,
        low=low,
        close=close,
        volume=1.0,
        atr14=atr,
    )
    return EnrichedBar(**values)


class ConservativeOutcomeTests(unittest.TestCase):
    def test_same_bar_stop_and_target_resolves_to_stop(self):
        bars = [
            bar(0, 100, 100, 100, 100),
            bar(1, 100, 103, 98, 100),
        ]
        cfg = PipelineConfig(stop_atr_mult=1.0, rr_target=2.0, max_lookforward_bars=1)

        result = compute_outcome(bars, 0, "long", cfg)

        self.assertFalse(result["hitTP"])
        self.assertTrue(result["hitStop"])
        self.assertEqual(result["pnlR"], -1.0)


if __name__ == "__main__":
    unittest.main()
