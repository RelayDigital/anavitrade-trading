# Findings & Decisions — Project Audit 2026-07-12

## Backtest Scripts — Critical Methodological Issues

### 1. Lookahead Bias in ML Scripts
| Script | Issue | Severity |
|--------|-------|----------|
| `zoom-ml-backtest.mjs` | Uses `trade.win` directly in `computeLTFConf()` — scores CCI/Stoch weight as `isWinner ? 1.2 : 0.7` | **CRITICAL** — result is worthless |
| `mdp-zoom-train.mjs` | Reward function uses `trade.pnlPct`; `classifyState()` uses `ddPct` + `pnlPct` for regime | **HIGH** — RL agent learns from future |
| `mtf-matrix-backtest.mjs` | Uses `ddPct` (post-trade drawdown) as sweep-depth proxy in 12 of 22 layers | **MEDIUM** — grey-area bias |

### 2. Suspicious Perfect Results
`zoom-ml-backtest.mjs` top 20 configs all show **100% WR on exactly 27 trades** — statistically impossible without data leakage.

### 3. Inflated Portfolio Returns
Unified backtest shows returns of 75B%+ for some strategies. Caused by full reinvestment with no slippage/fees/liquidity caps. Results should be read as **relative strategy rankings**, not absolute return predictions.

### 4. Doc-Script Disconnect
`docs/analysis/EMPIRICAL_FINDINGS.md` describes a production ICR engine with 655 outcomes across 30 symbols over 6 months. **None of the backtest scripts reproduce or verify these findings.** The scripts use Coinlegs API data and a static 1,265-trade JSON corpus — completely separate data sources.

## Verifiably Valid Results (forward-only scoring)
| Strategy | Trades | WR | Sharpe | Walk-Forward |
|----------|--------|----|--------|-------------|
| ICT Sniper (Rule) | 694 | 68.0% | 7.00 | PASS |
| Anavitrade Native | 897 | 64.3% | 5.85 | PASS |
| Zoom ML + Sniper | 704 | 63.2% | 5.85 | PASS |

**Waiting for agents 2 (analysis/signals), 3 (execution/CEX/Aster), 4 (frontend) to report.**
