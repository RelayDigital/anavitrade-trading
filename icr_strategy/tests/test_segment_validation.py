from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from icr.segment_validation import (
    SegmentValidationConfig,
    prepare_trades_frame,
    run_segment_validation,
    write_segment_validation_reports,
)


def _base_frame(n: int, seed: int = 7) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    start = pd.Timestamp("2024-01-01", tz="UTC")
    hours = rng.integers(0, 24, size=n)
    times = [start + pd.Timedelta(days=int(i // 3), hours=int(h)) for i, h in enumerate(hours)]
    return pd.DataFrame(
        {
            "symbol": rng.choice(["AAAUSDT", "BBBUSDT", "CCCUSDT", "DDDUSDT", "EEEUSDT"], size=n),
            "direction": rng.choice(["long", "short"], size=n),
            "entry_time": [t.isoformat() for t in times],
            "score": rng.integers(75, 101, size=n),
            "total_r": rng.normal(-0.05, 1.0, size=n),
            "reason": ["ny_killzone=False; DIV(0): none/neutral"] * n,
        }
    )


@pytest.mark.unit
def test_prepare_trades_frame_derives_pre_entry_axes_without_mutation() -> None:
    df = _base_frame(30)
    before = df.copy(deep=True)
    out = prepare_trades_frame(df)
    pd.testing.assert_frame_equal(df, before)  # input not mutated
    for col in ("session", "day_of_week", "entry_year", "score_bucket", "ny_killzone", "divergence_class"):
        assert col in out.columns
    assert set(out["session"]).issubset({"asia", "london", "new_york", "rollover_other"})


@pytest.mark.unit
def test_pure_noise_yields_no_validated_segments() -> None:
    df = _base_frame(240, seed=11)
    cfg = SegmentValidationConfig(n_permutations=500, n_bootstrap=300, seed=3)
    report = run_segment_validation(df, cfg)
    validated = [s for s in report.segments if s.verdict == "VALIDATED"]
    assert validated == []


@pytest.mark.unit
def test_injected_session_effect_is_detected_and_validated() -> None:
    df = _base_frame(360, seed=5)
    prepared = prepare_trades_frame(df)
    rng = np.random.default_rng(9)
    ny = (prepared["session"] == "new_york").to_numpy()
    r = np.where(ny, rng.normal(0.9, 0.6, size=len(df)), rng.normal(-0.25, 0.6, size=len(df)))
    df = df.assign(total_r=r)
    cfg = SegmentValidationConfig(n_permutations=800, n_bootstrap=300, seed=3)
    report = run_segment_validation(df, cfg)
    ny_rows = [s for s in report.segments if s.axis == "session" and s.level == "new_york"]
    assert len(ny_rows) == 1
    assert ny_rows[0].verdict == "VALIDATED"
    assert ny_rows[0].p_permutation < 0.05
    assert ny_rows[0].holm_significant


@pytest.mark.unit
def test_single_symbol_concentration_blocks_validation() -> None:
    df = _base_frame(300, seed=13)
    prepared = prepare_trades_frame(df)
    ny = (prepared["session"] == "new_york").to_numpy()
    one_symbol = (df["symbol"] == "AAAUSDT").to_numpy()
    r = np.where(ny & one_symbol, 3.0, np.where(ny, -0.10, -0.05))
    df = df.assign(total_r=r + np.random.default_rng(1).normal(0, 0.05, len(df)))
    cfg = SegmentValidationConfig(n_permutations=500, n_bootstrap=300, seed=3)
    report = run_segment_validation(df, cfg)
    ny_rows = [s for s in report.segments if s.axis == "session" and s.level == "new_york"]
    if ny_rows:  # if it looks significant, the LOSO gate must stop validation
        assert ny_rows[0].verdict != "VALIDATED"
        assert ny_rows[0].loso_min_expectancy_r is not None
        assert ny_rows[0].loso_min_expectancy_r <= 0


@pytest.mark.unit
def test_half_life_effect_blocks_validation() -> None:
    # Effect exists only in the first chronological half: split-half gate must trip.
    df = _base_frame(320, seed=17).sort_values("entry_time").reset_index(drop=True)
    prepared = prepare_trades_frame(df)
    ny = (prepared["session"] == "new_york").to_numpy()
    first_half = np.arange(len(df)) < len(df) // 2
    rng = np.random.default_rng(2)
    r = np.where(ny & first_half, rng.normal(1.4, 0.4, len(df)), rng.normal(-0.15, 0.4, len(df)))
    df = df.assign(total_r=r)
    cfg = SegmentValidationConfig(n_permutations=500, n_bootstrap=300, seed=3)
    report = run_segment_validation(df, cfg)
    ny_rows = [s for s in report.segments if s.axis == "session" and s.level == "new_york"]
    if ny_rows and ny_rows[0].p_permutation < 0.05:
        assert ny_rows[0].verdict != "VALIDATED"
        assert not ny_rows[0].split_half_consistent


@pytest.mark.integration
def test_writer_outputs_csv_and_json(tmp_path: Path) -> None:
    df = _base_frame(120, seed=23)
    cfg = SegmentValidationConfig(n_permutations=200, n_bootstrap=200, seed=3)
    report = run_segment_validation(df, cfg)
    paths = write_segment_validation_reports(report, tmp_path)
    assert paths["segment_candidates"].exists()
    assert paths["segment_validation"].exists()
    payload = json.loads(paths["segment_validation"].read_text())
    assert payload["schema"] == "ICR_SEGMENT_VALIDATION_v1"
    assert payload["n_trades"] == 120
    assert payload["family_size"] == len(report.segments)
    frame = pd.read_csv(paths["segment_candidates"])
    if not frame.empty:
        assert {"axis", "level", "verdict", "p_permutation", "p_holm"}.issubset(frame.columns)


@pytest.mark.unit
def test_empty_and_tiny_frames_do_not_crash() -> None:
    cfg = SegmentValidationConfig(n_permutations=100, n_bootstrap=100)
    empty = run_segment_validation(_base_frame(0), cfg)
    assert empty.segments == []
    tiny = run_segment_validation(_base_frame(5), cfg)
    assert all(s.verdict != "VALIDATED" for s in tiny.segments)
