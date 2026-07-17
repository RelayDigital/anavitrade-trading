import unittest

import numpy as np

from scripts.ml.pipeline.validation import (
    last_closed_bar_index,
    purged_chronological_split,
    select_threshold_on_validation,
)


class ClosedBarAlignmentTests(unittest.TestCase):
    def test_rejects_still_forming_higher_timeframe_bar(self):
        hour = 60 * 60 * 1000
        opens = np.array([0, hour, 2 * hour], dtype=np.int64)

        self.assertEqual(last_closed_bar_index(opens, hour, hour + 30 * 60 * 1000), 0)
        self.assertEqual(last_closed_bar_index(opens, hour, 2 * hour), 1)

    def test_returns_minus_one_before_first_bar_closes(self):
        hour = 60 * 60 * 1000
        opens = np.array([0, hour], dtype=np.int64)
        self.assertEqual(last_closed_bar_index(opens, hour, hour - 1), -1)


class PurgedSplitTests(unittest.TestCase):
    def test_enforces_embargo_before_validation_and_test(self):
        step = 15 * 60 * 1000
        timestamps = np.arange(100, dtype=np.int64) * step
        metadata = [{"timestamp": int(ts)} for ts in timestamps]
        embargo = 4 * step

        train, validation, test = purged_chronological_split(
            metadata,
            train_ratio=0.60,
            validation_ratio=0.20,
            embargo_ms=embargo,
        )

        train_ts = [metadata[i]["timestamp"] for i in train]
        validation_ts = [metadata[i]["timestamp"] for i in validation]
        test_ts = [metadata[i]["timestamp"] for i in test]

        self.assertGreaterEqual(min(validation_ts) - max(train_ts), embargo)
        self.assertGreaterEqual(min(test_ts) - max(validation_ts), embargo)
        self.assertTrue(set(train).isdisjoint(validation))
        self.assertTrue(set(train).isdisjoint(test))
        self.assertTrue(set(validation).isdisjoint(test))


class ValidationThresholdTests(unittest.TestCase):
    def test_threshold_is_selected_only_from_validation_arrays(self):
        validation_probs = np.array([0.95, 0.85, 0.75, 0.65])
        validation_pnl = np.array([2.0, 2.0, -1.0, -1.0])

        selected = select_threshold_on_validation(
            validation_probs,
            validation_pnl,
            thresholds=[0.60, 0.70, 0.80, 0.90],
            min_trades=2,
            metric="pf",
        )

        self.assertEqual(selected["threshold"], 0.80)
        self.assertEqual(selected["trades"], 2)


if __name__ == "__main__":
    unittest.main()
