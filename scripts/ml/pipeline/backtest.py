"""Threshold-sweep backtest on chronologically-split test data.
Model-agnostic: just needs probability array + label array."""

import numpy as np
from typing import List, Dict, Tuple


def sweep(probs: np.ndarray, y_win: np.ndarray, y_pnl: np.ndarray,
          threshold_min: float = 0.50, threshold_max: float = 0.88,
          threshold_step: float = 0.02) -> List[Dict]:
    """Sweep thresholds and return metrics for each.

    Returns list of dicts with: threshold, pass_pct, trades, wr, pf, sharpe, max_dd, avg_r, total_r
    """
    results = []
    for t in np.arange(threshold_min, threshold_max, threshold_step):
        mask = probs >= t
        n = mask.sum()
        if n < 15:
            continue

        wins = y_win[mask].sum()
        wr = wins / n
        pnls = y_pnl[mask]

        gp = pnls[pnls > 0].sum()
        gl = abs(pnls[pnls < 0].sum())
        pf = gp / gl if gl > 0 else 999.0

        avg_r = pnls.mean()
        total_r = pnls.sum()

        sharpe = avg_r / pnls.std() * np.sqrt(n) if n > 1 and pnls.std() > 0 else 0.0

        # Max DD from R-stream
        eq = np.cumprod(1 + np.clip(pnls, -0.99, None))
        peak = np.maximum.accumulate(eq)
        dd = (peak - eq) / peak
        max_dd = dd.max() * 100 if len(dd) > 0 else 0

        results.append({
            'threshold': round(t, 4),
            'pass_pct': round(n / len(probs) * 100, 2),
            'trades': int(n),
            'wr': round(float(wr), 4),
            'pf': round(float(pf), 2),
            'sharpe': round(float(sharpe), 2),
            'max_dd': round(float(max_dd), 1),
            'avg_r': round(float(avg_r), 3),
            'total_r': round(float(total_r), 2),
        })

    return results


def find_best(results: List[Dict], metric: str = 'sharpe') -> Dict:
    """Find best threshold by metric."""
    valid = [r for r in results if r['trades'] >= 15]
    if not valid:
        return results[0] if results else {}
    return max(valid, key=lambda r: r[metric])


def print_table(results: List[Dict], targets: Dict[str, float] = None):
    """Print formatted sweep table with goal indicators."""
    targets = targets or {'wr': 0.65, 'pf': 3.0}
    print(f"{'Thresh':>8s}  {'Pass%':>6s}  {'Trades':>6s}  {'WR':>6s}  {'PF':>7s}  {'Sharpe':>7s}  {'MaxDD':>6s}  {'AvgR':>6s}  {'TotalR':>8s}")
    print(f"{'-'*8}  {'-'*6}  {'-'*6}  {'-'*6}  {'-'*7}  {'-'*7}  {'-'*6}  {'-'*6}  {'-'*8}")
    for r in results:
        wr_mark = ' ✓' if r['wr'] >= targets['wr'] else ''
        pf_mark = ' ✓' if r['pf'] >= targets['pf'] else ''
        marks = f"{wr_mark}{pf_mark}"
        print(f"{r['threshold']:8.3f}  {r['pass_pct']:5.1f}%  {r['trades']:6d}  {r['wr']*100:5.1f}%  {r['pf']:6.2f}  {r['sharpe']:6.2f}  {r['max_dd']:5.1f}%  {r['avg_r']:5.2f}R  {r['total_r']:+7.1f}R{marks}")


def print_best(result: Dict, targets: Dict[str, float] = None):
    """Print best result summary."""
    targets = targets or {'wr': 0.65, 'pf': 3.0}
    goals = result['wr'] >= targets['wr'] and result['pf'] >= targets['pf']
    print(f"\n{'='*60}")
    print(f"BEST: threshold={result['threshold']:.4f} | {result['trades']} trades | "
          f"WR={result['wr']*100:.1f}% | PF={result['pf']:.2f} | Sharpe={result['sharpe']:.2f}")
    print(f"Goals: WR≥{targets['wr']*100:.0f}%={'✓' if result['wr'] >= targets['wr'] else '✗'} | "
          f"PF≥{targets['pf']}={'✓' if result['pf'] >= targets['pf'] else '✗'} → "
          f"{'🎯 MET' if goals else '❌ NOT MET'}")
    print(f"{'='*60}")
