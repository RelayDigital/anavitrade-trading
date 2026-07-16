# NN Scoring Engine — ML Pipeline (Stage 3)

Pipeline for building training data, training LightGBM models, and exporting to ONNX for TypeScript inference.

## Pipeline Overview

```
┌──────────────────────────┐      ┌──────────────────────┐      ┌──────────────────────┐
│  build-training-data.ts  │ ───> │  train_model.py      │ ───> │  models/             │
│                          │      │                      │      │  ├── *.onnx          │
│  Raw OHLCV klines        │      │  JSON/CSV features   │      │  ├── shap_*.json     │
│       ↓                  │      │       ↓              │      │  └── feature_*.json  │
│  Enriched candles        │      │  LightGBM classifier │      └──────────────────────┘
│  ICR gate scores         │      │  LightGBM regressor  │               │
│  Forward outcome labels  │      │  SHAP analysis       │               ▼
│                          │      │  ONNX export         │      ┌──────────────────────┐
│  Output: training.json   │      │                      │      │  TypeScript          │
└──────────────────────────┘      └──────────────────────┘      │  inference engine    │
                                                                │  (onnxruntime-web)   │
                                                                └──────────────────────┘
```

## Prerequisites

### Data Builder (TypeScript)

```bash
# Runtime
pnpm install          # tsx is a dependency of the project
# Or run via npx:
npx tsx scripts/ml/build-training-data.ts --help
```

### Model Training (Python)

```bash
pip install numpy pandas scikit-learn lightgbm shap skl2onnx onnxruntime
```

## Step 1: Build Training Data

The data builder reads raw OHLCV klines, computes all features WITHOUT lookahead, and labels each bar with forward outcomes.

### Input Format

Supply klines as a JSON file with one entry per symbol+timeframe combination:

```json
[
  {
    "symbol": "BTCUSDT",
    "timeframe": "4h",
    "klines": [
      {
        "timestamp": 1720000000000,
        "open": 50000.0,
        "high": 51000.0,
        "low": 49500.0,
        "close": 50500.0,
        "volume": 1234.5
      }
    ]
  }
]
```

### Getting Klines

Option A: Export from the Worker's D1 database (production data).

Option B: Fetch from Binance API directly:

```bash
# Example: fetch 6 months of 4h BTCUSDT klines
npx tsx scripts/ml/fetch-klines.ts --symbol BTCUSDT --timeframe 4h --limit 1080
```

Option C: Use the backfill scripts in `scripts/backfill-klines-to-r2.ts`.

### Running the Builder

```bash
# JSON output (default)
npx tsx scripts/ml/build-training-data.ts \
  --input klines.json \
  --output training-data.json

# CSV output (for pandas)
npx tsx scripts/ml/build-training-data.ts \
  --input klines.json \
  --output training-data.csv \
  --format csv

# Custom stop/TP multipliers
npx tsx scripts/ml/build-training-data.ts \
  --input klines.json \
  --output training-data.json \
  --stop-atr-mult 1.5 \
  --tp-atr-mult 3.0 \
  --max-lookforward 100
```

### CLI Options

| Option | Default | Description |
|--------|---------|-------------|
| `--input` | (required) | Path to input JSON with klines |
| `--output` | (required) | Path for output file |
| `--format` | `json` | Output format: `json` or `csv` |
| `--stop-atr-mult` | `1.5` | Stop distance in ATR multiples |
| `--tp-atr-mult` | `3.0` | Take-profit distance in ATR multiples |
| `--max-lookforward` | `100` | Max bars to look forward for outcome |

### Output Schema

Each row contains:

**Identifiers:** symbol, timeframe, timestamp, direction

**Market Structure (12):** ma7_slope, ma25_slope, ma99_slope, ma_separation, atr14, atr_percentile, bb_width, bb_position, volume_zscore, volume_trend, rsi14, displacement

**ICR Gate Scores (7):** trend_score (0-20), impulse_score (0-20), pullback_score (0-15), compression_score (0-15), trigger_score (0-15), volume_score (0-10), rr_score (0-5)

**Trade Structure (4):** rr_ratio, stop_dist_atr, target_dist_atr, timeframe_encoded

**Context (6):** hour_of_day, day_of_week, ma_regime, vol_regime, pair_encoded, direction_encoded

**Labels (6):** hitTP, hitStop, maxFavorableR, maxAdverseR, pnlR, barsToOutcome

## Step 2: Train Models

```bash
# Full training pipeline
python scripts/ml/train_model.py \
  --input training-data.json \
  --model-dir models/

# Skip SHAP for speed
python scripts/ml/train_model.py \
  --input training-data.csv \
  --model-dir models/ \
  --no-shap

# Train only the classifier
python scripts/ml/train_model.py \
  --input training-data.json \
  --model-dir models/ \
  --skip-regressor \
  --skip-onnx

# Custom CV folds
python scripts/ml/train_model.py \
  --input training-data.json \
  --model-dir models/ \
  --n-folds 5
```

### What Gets Trained

1. **LightGBM Classifier** — predicts `hitTP` (binary: does price reach TP before stop?)
2. **LightGBM Regressor** — predicts `maxFavorableR` (best R-multiple reached)

### Cross-Validation

Uses **purged k-fold time-series cross-validation**: each fold trains on earlier data and tests on later data, with a 1% purge gap between train and test to prevent label overlap leakage.

### CLI Options

| Option | Default | Description |
|--------|---------|-------------|
| `--input` | (required) | Path to training data (JSON or CSV) |
| `--model-dir` | `models/` | Output directory for trained models |
| `--n-folds` | `5` | Number of CV folds |
| `--no-shap` | `false` | Skip SHAP analysis |
| `--shap-samples` | `5000` | Samples for SHAP computation |
| `--skip-classifier` | `false` | Skip classifier training |
| `--skip-regressor` | `false` | Skip regressor training |
| `--skip-onnx` | `false` | Skip ONNX export |

### Output Files

```
models/
├── hitTP_classifier.onnx         # ONNX model for hitTP prediction
├── maxFavorableR_regressor.onnx  # ONNX model for maxFavorableR prediction
├── feature_importance.json       # LightGBM feature importance
└── shap_importance.json          # SHAP feature importance
```

## Step 3: TypeScript Inference (Stage 3c)

The ONNX models are loaded into a Cloudflare Worker or Node.js runtime using `onnxruntime-web` (or `onnxruntime-node` for server-side). The inference engine:

1. Builds the same 29-feature vector from enriched candles + ICR gate scores
2. Runs the ONNX classifier: returns P(hitTP) in [0, 1]
3. Runs the ONNX regressor: returns E[maxFavorableR]
4. Combines into a trade probability: `score = P(hitTP) * clip(E[maxFavorableR] / 3, 0, 1)`
5. Falls back to rule-based ICR scoring when the ONNX model is unavailable

### Inference Skeleton

```typescript
// src/server/analysis/ml/inference.ts (future)
import * as ort from "onnxruntime-web";

export interface MlPrediction {
  hitProbability: number;
  expectedR: number;
  score: number;        // combined: P(hitTP) * E[R] / 3
  confidence: number;   // model confidence proxy
}

export async function predict(
  features: Float32Array,  // 29 features
  clfModel: ort.InferenceSession,
  regModel: ort.InferenceSession,
): Promise<MlPrediction> {
  const input = new ort.Tensor("float32", features, [1, 29]);

  const clfOutput = await clfModel.run({ float_input: input });
  const regOutput = await regModel.run({ float_input: input });

  const hitProb = clfOutput["output_label"][1] ?? clfOutput["output_probability"].data[0];
  const expectedR = regOutput["variable"].data[0];

  return {
    hitProbability: hitProb,
    expectedR: Math.max(0, expectedR),
    score: hitProb * Math.min(1, Math.max(0, expectedR / 3)),
    confidence: Math.abs(hitProb - 0.5) * 2, // 0-1, 1 = most confident
  };
}
```

## Acceptance Criteria

| Criteria | Target | Check |
|----------|--------|-------|
| Training examples | 100K+ | Check builder output count |
| Classifier AUC | > 0.65 | Check cross-validation summary |
| Brier score | < 0.20 | Check cross-validation summary |
| SHAP confirms top features | RR, trend, timeframe | Check shap_importance.json |
| ONNX model size | < 10 MB | Check filesize of .onnx files |
| Inference latency | < 50ms | Benchmarked in Worker |

## Feature Engineering Notes

All features are computed using ONLY data available at the entry bar:
- Indicators use only current and past values (no repainting)
- ICR gate scores use the detection logic from `src/server/analysis/icr/`
- The label (forward outcome) is the ONLY component that looks ahead

Feature parameter values are consistent with `DEFAULT_ICR_CONFIG` in `src/server/analysis/icr/config.ts`:
- MA periods: 7, 25, 99 (fast, mid, slow)
- ATR length: 14
- Bollinger: 20-period, 2-std
- Volume MA: 20-period
- Compression lookback: 8 bars
- Impulse: 2-14 bars, 1.2x ATR minimum
- Pullback: min 2 bars
- Score threshold: 65 (not used in feature computation, only in signal detection)
