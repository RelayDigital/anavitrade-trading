
## 2026-07-19 — Opus trade-judgment gate

- Found: the shared dispatch gate's step 5 (ML score >= 0.52 threshold) was
  rejecting essentially all live TradeIntents platform-wide, from every
  source, because today's locked walk-forward test proved meta-v22-definitive
  never produces a score above 0.243. This silently blocked live dispatch
  AND testnet evidence accumulation (Thread C's release gate).
- Fix (commit 543e217): replaced the statistical ML score with
  src/server/analysis/llm-trade-judge.ts — Claude Opus judges each candidate
  via forced tool-use, feeding its 0-1 confidence into the same mlScore slot
  the pure gate (dispatch-gate.ts) already consumed. Zero changes to the
  pure gate logic itself (31 existing tests still pass unchanged).
  ML_THRESHOLD moved from the old model card (0.52) to 0.65 (starting value
  for Opus's confidence scale, not backtest-derived).
- Requires ANTHROPIC_API_KEY (documented in .env.example) — without it,
  intents still fail closed at ml_unreachable, same R1.3 guarantee as before.
- Also shipped this session: Binance perp top-gainers/volume-breakout signal
  source (commit 761f316), wired to the same 60s cron as Coinlegs.
- Next: get ANTHROPIC_API_KEY set as a Worker secret so this actually starts
  judging live intents; then Thread C (operator gates) is the real remaining
  blocker to MVP.
