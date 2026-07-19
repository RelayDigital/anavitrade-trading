# Progress

## 2026-07-18

- Inspected vault, sync state, briefing output, and both automation scripts.
- Confirmed the existing system is active capture, not a multi-network linked knowledge base.
- Next: perform a reversible migration and update automation.

## 2026-07-18 — Rules↔ML cross-pollination (plan: jazzy-spinning-brook.md)

- Track A: ran `locked-walkforward-backtest.py` on the 120-day/49-pair corpus for
  real (first honest ML verdict in repo history). Gate FAILS cleanly: 0 qualified
  test trades, calibrated probs cap at 0.243 vs 0.52 threshold. Commit `f21473b`.
- Track B: wired `divergence.py` (RSI/MACD/AO divergence) + WaveTrend/Money
  Flow/Stochastic RSI into `features.py`/`enrichment.py`/`train.py` as candidate
  features only — isolated from the frozen meta-v22 locked-gate contract.
  Smoke-verified non-degenerate on a 3-pair subset. Commit `844f30e`.
- Track C: live calibrated ML probability now refines entry *timing* (not
  sizing, per correction) — a new confirmation band in `dispatch-gate.ts`
  (`ML_CONFIRM_THRESHOLD`) dispatches marginal-score signals as a LIMIT order
  pulled back toward the stop instead of chasing at market. Commit `33451da`.
- Noted for follow-up: LuxAlgo Smart Money Concepts' EQH/EQL and
  Premium/Discount/Equilibrium zones are genuinely new signal categories
  (not redundant with existing SMC) — deferred, belongs in `smc.py`.
- Two other concurrent sessions were active on this repo throughout (ML
  validation-gate/Thread-E work, PancakeSwap wallet-assets work) — no file
  collisions; verified via subagent before each commit.
