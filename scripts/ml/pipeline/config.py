"""Central config — change ONCE, affects all pipeline stages."""
from pathlib import Path
from dataclasses import dataclass
from typing import List, Optional

@dataclass(frozen=True)
class PipelineConfig:
    """Immutable pipeline configuration. Create new instances for experiments."""

    # ── Timeframes ──
    primary_tf: str = "1h"           # "4h" | "1h" — bars per row
    chart_tf: str = "15m"            # For continuous features when using 4h primary

    # ── Data ──
    klines_input: Path = Path("scripts/data/klines-mtf.json")
    training_output: Path = Path("scripts/data/training-data-1h-pure.json")
    model_dir: Path = Path("scripts/data/models/meta-v8")

    # ── Indicator parameters ──
    ma_fast: int = 7
    ma_mid: int = 25
    ma_slow: int = 99
    atr_period: int = 14
    rsi_period: int = 14
    bb_period: int = 20
    bb_std: float = 2.0
    ao_fast: int = 5
    ao_slow: int = 34
    vol_period: int = 20

    # ── SMC parameters ──
    smc_ob_lookback: int = 15
    smc_fvg_lookback: int = 12
    smc_sweep_lookback: int = 8
    smc_choch_lookback: int = 12
    smc_swing_lookback: int = 4
    smc_fvg_min_size_atr: float = 0.12
    smc_ob_rally_pct: float = 2.0

    # ── Labeling ──
    stop_atr_mult: float = 2.0          # ATR multiplier for stop distance
    rr_target: float = 2.0              # TP = entry ± stop_dist * rr_target
    max_lookforward_bars: int = 48      # Max bars to scan ahead for outcome

    # ── Model ──
    lgbm_estimators: int = 200
    lgbm_max_depth: int = 7
    lgbm_learning_rate: float = 0.03
    lgbm_subsample: float = 0.8
    lgbm_colsample: float = 0.8
    lgbm_min_child: int = 50
    lgbm_reg_alpha: float = 0.1
    lgbm_reg_lambda: float = 1.0

    # ── Backtest ──
    train_split: float = 0.6            # Chronological 60/40 split
    n_folds: int = 4                    # Rolling window folds
    threshold_min: float = 0.50         # Min threshold for sweep
    threshold_max: float = 0.88         # Max threshold for sweep
    threshold_step: float = 0.02

    # ── Target metrics ──
    target_wr: float = 0.65
    target_pf: float = 3.0


# Default config
DEFAULT = PipelineConfig()

# Alternative configs for experiments
CONFIG_4H = PipelineConfig(primary_tf="4h", chart_tf="15m",
                           training_output=Path("scripts/data/training-data-4h-pure.json"),
                           model_dir=Path("scripts/data/models/meta-v8-4h"))

CONFIG_1H_TIGHT = PipelineConfig(primary_tf="1h",
                                 smc_fvg_min_size_atr=0.15,
                                 smc_ob_rally_pct=3.0,
                                 stop_atr_mult=1.5,
                                 model_dir=Path("scripts/data/models/meta-v8-1h-tight"))

CONFIG_1H_WIDE = PipelineConfig(primary_tf="1h",
                                smc_fvg_min_size_atr=0.08,
                                smc_ob_rally_pct=1.5,
                                stop_atr_mult=2.5,
                                rr_target=3.0,
                                model_dir=Path("scripts/data/models/meta-v8-1h-wide"))
