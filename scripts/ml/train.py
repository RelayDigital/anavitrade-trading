#!/usr/bin/env python3
"""
End-to-end ML pipeline training entry point.
Composes features → SMC → enrichment → labels → model → backtest.

Usage:
  python -m scripts.ml.train                    # Default config (1h primary)
  python -m scripts.ml.train --tf 4h            # 4h primary timeframe
  python -m scripts.ml.train --config wide      # Wide SMC params
  python -m scripts.ml.train --dry-run          # Just build data, skip training
"""

import sys, json, argparse, time
import numpy as np
from pathlib import Path

# Ensure project root in path for both local and VPS
_sys_path = Path(__file__).resolve().parent.parent.parent
if str(_sys_path) not in sys.path:
    sys.path.insert(0, str(_sys_path))

# Try absolute imports first (local), fall back to relative (VPS)
try:
    from scripts.ml.pipeline.config import PipelineConfig, DEFAULT, CONFIG_4H, CONFIG_1H_WIDE
    from scripts.ml.pipeline.features import enrich
    from scripts.ml.pipeline.smc import extract, SMCSignals
    from scripts.ml.pipeline.enrichment import build_row
    from scripts.ml.pipeline.labels import compute_outcome
    from scripts.ml.pipeline.model import train_chronological, save_model
except ImportError:
    from pipeline.config import PipelineConfig, DEFAULT, CONFIG_4H, CONFIG_1H_WIDE
    from pipeline.features import enrich
    from pipeline.smc import extract, SMCSignals
    from pipeline.enrichment import build_row
    from pipeline.labels import compute_outcome
    from pipeline.model import train_chronological, save_model


def main():
    parser = argparse.ArgumentParser(description='Anavitrade ML Pipeline')
    parser.add_argument('--tf', default='1h', choices=['4h', '1h'], help='Primary timeframe')
    parser.add_argument('--config', default='default', choices=['default', 'wide', 'tight'],
                       help='Parameter preset')
    parser.add_argument('--dry-run', action='store_true', help='Build data only, skip training')
    parser.add_argument('--output', type=str, help='Override training data output path')
    parser.add_argument('--version', type=str, default='meta-v21',
                       help='Model version directory name (default: meta-v21)')
    args = parser.parse_args()

    # Select config
    if args.tf == '4h':
        cfg = CONFIG_4H
    elif args.config == 'wide':
        cfg = CONFIG_1H_WIDE
    else:
        cfg = DEFAULT

    t0 = time.time()

    # ═══ 1. Load klines ═══
    # Look in multiple locations: project-relative, adjacent, absolute
    klines_path = Path(__file__).resolve().parent.parent / 'data' / 'klines-mtf.json'
    if not klines_path.exists():
        klines_path = Path(__file__).resolve().parent / 'klines-mtf.json'
    if not klines_path.exists():
        klines_path = Path('klines-mtf.json')
    if not klines_path.exists():
        klines_path = Path('scripts/data/klines-mtf.json')
    if hasattr(args, 'input') and args.input:
        klines_path = Path(args.input)

    print(f"Loading klines from {klines_path}...")
    with open(klines_path) as f:
        pairs = json.load(f)
    print(f"  {len(pairs)} pairs")

    # ═══ 2. Build features + SMC + enrichment + labels ═══
    all_rows = []
    total_pairs = 0
    warmup_bars = cfg.ma_slow  # MA99 warmup

    for pair_idx, pair in enumerate(pairs):
        symbol = pair['symbol']
        klines_data = pair.get('klines', {})
        raw_klines = klines_data.get(cfg.primary_tf, [])

        if len(raw_klines) < warmup_bars + 50:
            continue

        total_pairs += 1

        # Enrich bars with indicators
        bars = enrich(raw_klines, cfg)
        if len(bars) < warmup_bars + 50:
            continue

        # Pre-compute SMC for all bars
        smc_signals = [SMCSignals.empty() for _ in bars]
        for i in range(warmup_bars, len(bars)):
            smc_signals[i] = extract(bars, i, cfg) if bars[i].atr14 > 0 else SMCSignals.empty()

        # Build rows for every bar after warmup (both directions)
        for i in range(warmup_bars, min(len(bars), len(bars) - cfg.max_lookforward_bars)):
            if bars[i].atr14 <= 0:
                continue

            for direction in ('long', 'short'):
                row = build_row(bars, smc_signals, i, direction, symbol, cfg)
                if not row:
                    continue

                # Compute forward labels
                outcome = compute_outcome(bars, i, direction, cfg)
                row.update(outcome)
                row['_bar_index'] = i

                all_rows.append(row)

        if (pair_idx + 1) % 10 == 0:
            elapsed = time.time() - t0
            print(f"  {pair_idx+1}/{len(pairs)} pairs, {len(all_rows)} rows ({elapsed:.0f}s)...")

    elapsed = time.time() - t0
    print(f"\nBuilt {len(all_rows)} labeled rows from {total_pairs} pairs in {elapsed:.0f}s")
    wins = sum(1 for r in all_rows if r['hitTP'])
    losses = sum(1 for r in all_rows if r['hitStop'])
    print(f"  Wins: {wins}, Losses: {losses}, Baseline WR: {wins/(wins+losses)*100:.1f}%\n")

    # Save training data (project-relative)
    output_path = args.output if hasattr(args, 'output') and args.output else None
    if not output_path:
        output_path = str(Path(__file__).resolve().parent.parent / 'data' / 'training-data-1h-pure.json')

    with open(output_path, 'w') as f:
        for row in all_rows:
            clean = {}
            for k, v in row.items():
                if hasattr(v, 'item'): clean[k] = v.item()
                elif isinstance(v, (np.integer, np.floating)): clean[k] = v.item()
                elif isinstance(v, np.bool_): clean[k] = bool(v)
                else: clean[k] = v
            f.write(json.dumps(clean) + '\n')
    print(f"Saved training data to {output_path} ({len(all_rows)} rows)")

    if hasattr(args, 'dry_run') and args.dry_run:
        print("Dry run complete. Skipping training.")
        return

    # ═══ 3. Train model ═══
    print("\nTraining model...")
    artifacts = train_chronological(all_rows, cfg)
    models_root = Path(__file__).resolve().parent.parent / 'data' / 'models'
    model_version = args.version
    model_dir = models_root / model_version
    save_model(artifacts, model_dir)

    elapsed_total = time.time() - t0
    print(f"\nPipeline complete in {elapsed_total:.0f}s")

if __name__ == '__main__':
    main()
