## Session: jazzy-spinning-brook (started 2026-07-18T19:46:45Z)

### Rules↔ML cross-pollination
- Track A: ran `locked-walkforward-backtest.py` on the 120-day/49-pair corpus for real.
  Gate FAILS cleanly: 0 qualified test trades, calibrated probs cap at 0.243 vs 0.52
  threshold. Commit `f21473b`.
- Track B: wired `divergence.py` (RSI/MACD/AO divergence, previously dead code) +
  WaveTrend (Market Cipher B) + Money Flow + Stochastic RSI into `features.py`/
  `enrichment.py`/`train.py` as candidate features, isolated from the frozen meta-v22
  locked-gate contract. Smoke-verified non-degenerate. Commit `844f30e`.
- Track C: live calibrated ML probability now refines entry *timing* (confirmation band
  in `dispatch-gate.ts`, not sizing per user correction) — marginal-score signals dispatch
  as a LIMIT order pulled back toward the stop instead of chasing at market. Commit `33451da`.
- Deferred: LuxAlgo SMC's EQH/EQL + Premium/Discount zones (genuinely new, belongs in
  `smc.py`), internal-vs-swing two-scale structure, drawdown circuit-breaker/cooldown
  (blocked on trade-outcome attribution not existing anywhere yet).

### Incident: stale-read clobber of progress.md
- A Read-then-Edit race against a concurrent session's commit caused ~117 lines of that
  session's history to be discarded when I committed. Caught, restored in full from git
  history (`c414956~1`), corrected inline rather than deleting the other session's note.
  Fixed in `ca56319`. This incident is the direct motivation for Part 2 below.

### Part 1 — VPS testing consolidation (in progress)
- Found: VPS cron (`0 */6 * * * vps-train.sh`) runs the leaky `train.py` path and
  blind-`cp`'s every historical `meta-v*/` dir (20+) into production models with zero
  gating; includes a broken DL step and a 0-trade RL step. The honest tool
  (`locked-walkforward-backtest.py`) has never been on a schedule. A third, older,
  disconnected AUC-floor gate (`scripts/cortex/modules/metacognitive-train.js`) also
  exists, unwired.
- Plan: new `scripts/ml/vps-locked-gate.sh` — daily cron, runs the locked gate, deploys
  only on pass to a single `champion/` dir, ledger-logs every run (pass or fail).

### Part 2 — Multi-session coordination (in progress)
- Session registry: `.claude/sessions/<slug>.json` (this file: `jazzy-spinning-brook.json`).
- Per-session append-only progress logs (this file) replacing direct edits to the shared
  `progress.md`, which becomes a generated roll-up via `scripts/merge-session-logs.sh`.
- Advisory lock convention (`.claude/locks/<file>.lock`) for genuinely singular shared
  files that can't be append-only.
- Convention documented in `docs/ops/multi-session-coordination.md`.

### Part 1 — VPS testing consolidation (done)
- Wrote `scripts/ml/vps-locked-gate.sh`: daily cron, fetches a fresh checksum-verified
  49-pair/120-day corpus (`binance_archive.py`, window ends at the last completed month —
  Binance Vision has no current-month monthly archive, discovered during testing),
  runs `locked-walkforward-backtest.py`, deploys to `/opt/anavitrade/models/champion/`
  only on `test.acceptance.passed`, ledger-logs every run to `locked-gate.jsonl`.
- Tested end-to-end on the live VPS (user-authorized SSH) with a 2-symbol smoke corpus:
  fetch -> gate -> ledger all verified working; confirmed fail-closed behavior (gate
  failed on the tiny sample, champion/ correctly left untouched).
- Found and fixed a real gap along the way: `meta-v22-definitive/model_card.json` (the
  frozen contract) was never on the VPS — `deploy-vps.sh`'s rsync excludes all `*.json`.
  Copied the contract (`model_card.json` + `classifier.txt`) to the VPS as a one-time
  prerequisite; not yet added to the automated deploy script (follow-up).
- Backed up the existing crontab (`/tmp/crontab.bak.20260718230454` on the VPS) and
  swapped `0 */6 * * * vps-train.sh` (leaky path, blind-deployed 20+ historical model
  dirs, broken DL/RL steps) for `0 3 * * * vps-locked-gate.sh`.
- Documented in `docs/ops/SYSTEM_OPERATIONS.md`: CORTEX's AUC-floor gate marked
  deprecated for the meta-v22 lineage (kept for reference/other lineages), new
  VPS-locked-gate section added.

### Part 1 follow-up — continuous altcoin coverage, not repeated re-fetching
- User correction: the gate shouldn't just refresh candles for the same 49
  pairs forever -- it should expand to test altcoins not yet covered.
- New `scripts/ml/select-untested-pairs.py`: pulls the live Binance USD-M
  perpetual universe (~480 symbols after majors + illiquid-floor exclusion),
  ranks by 24h quoteVolume **ascending** (deliberately -- edge shows up on
  smaller alts per EMPIRICAL_FINDINGS.md, a volume-descending queue would
  starve exactly those), picks the next untested batch of 20, persists state
  in `scripts/cortex/memory/tested-pairs.json`, cycles once the universe is
  exhausted. Filtered out a non-ASCII anomaly symbol found during testing.
- Wired into `vps-locked-gate.sh` as a new [1/4] step, replacing the static
  49-pair file (deleted).
- Hit the VPS's known fapi.binance.com geo-block (HTTP 451) on the
  exchangeInfo/ticker endpoints this selector needs (data.binance.vision, used
  for the actual kline archives, is unaffected). Added the same X-MBX-APIKEY
  bypass-header pattern already used by kline-cron.ts/fetch-klines-mtf.mjs,
  plus a `.env`-sourcing step in the cron script so cron's minimal environment
  picks up `BINANCE_API_KEY` once set. **Blocked on a credential**: no
  Binance API key is configured on the VPS yet (read-only market-data key is
  sufficient -- no trading permission needed). Asked the user to provide one.
- Verified fail-closed behavior end-to-end on the VPS without the key: logs
  a `select_pairs` stage failure to the ledger, doesn't crash, doesn't touch
  champion/. Feature is inert (falls back to failing safely) until the key
  is added, at which point the daily cron will start expanding coverage
  automatically with no further changes needed.

### Walk-forward false-negative fix (Fable subagent, per user's diagnosis)
- User's instinct was correct: unified-backtest.mjs's walkForward() FAILs on
  ICR Strategy/RR Conservative/RR Optimal/Consensus were false negatives, not
  real fragility. Root cause I diagnosed before delegating: backtest-prioritized.json
  has NO timestamp field; the array is sorted by descending score. The
  positional 60/40 "chronological" split was actually a score-sorted split,
  quarantining every score-selective strategy's accepted trades into "train".
- Delegated the fix to a Fable-5 subagent with full diagnosis already done
  (root cause, exact function/lines, recommended approach). Fix: score-quintile
  stratified, fixed-seed (1337) reproducible split instead of positional slice.
- Result: all 4 previously-FAILing strategies now PASS (robust) -- val Sharpe
  8-10 on 43-108 trades, matching train partitions. Verified no trades lost
  (train+val sums match full-corpus accepted counts exactly) and output is
  byte-identical across repeated runs.
- Honest caveat baked into the code comment: without timestamps this is
  split-stability evidence, not temporal generalization evidence. Still
  inherits every bias already in the corpus. Committed as `1b5510d`.

### Cross-pollinate ML+rules / winrate 35-50% goal -- status
- Investigated `scripts/unified-backtest.mjs` (the actual Sharpe-3+-relevant
  system per user's "data tells all" framing) rather than guessing which
  target the user meant. All 8 strategies already show 64-76% WR (above the
  35-50% band, not below it) -- the ambiguity got resolved by fixing the
  walk-forward methodology first, which was the more urgent, concrete,
  well-diagnosed problem. Revisit the specific 35-50% WR target once the user
  clarifies which system/corpus it refers to (EMPIRICAL_FINDINGS.md's
  fat-tailed ~19-23%-WR exit engine is the closest match for "Sharpe 3+, low
  WR" but its raw trade-level data isn't in this repo -- would need
  regenerating via the ICR strategy backtest sweep).

### "Trading edge" goal -- ICR real-data backtest (baseline + parallel variant sweep)
- Ran icr_strategy's `icr.main --binance-htf` for real: 20 altcoins, 4h bars,
  2026-01 to 2026-06 (real Binance data via monthly archives, checksum-implicit
  via the package's own fetcher). Baseline/default config result:
  **n=17 trades, WR 41.2%, PF 1.92, expectancy +0.47R, net +8.0R.**
  Directionally positive and inside the 35-50% WR band previously discussed,
  but n=17 is far too small to call validated (95% CI would span roughly
  20-65 percentage points) -- same small-sample caveat as everything else
  found this session (ML gate, EMPIRICAL_FINDINGS retraction).
- Dispatched 6 parallel subagents (Claude, not DeepSeek -- deepseek-swarm
  skill's scripts don't actually exist in this environment, only SKILL.md;
  no DEEPSEEK_API_KEY configured either) on the SAME cached real klines
  (/tmp/icr-run/binance_data/4h/, no re-fetch, no collision), each testing
  ONE independent pre-registered hypothesis via the package's own
  --real-edge-report (ablation + walk-forward + false-positive-trap
  pipeline), following the established "one variable at a time, negative
  results kept" discipline: disable-divergence, disable-mtf, disable-ict,
  score-threshold=85 (stricter), coil-threshold=80 (stricter). Awaiting
  results -- will aggregate ALL honestly, not cherry-pick the best.

### Parallel variant sweep -- honest results (n too small, real finding on ablations)
- All 6 parallel variants (baseline, disable-divergence, disable-mtf, disable-ict,
  score-threshold=85, coil-threshold=80) produced the IDENTICAL 17-trade result:
  WR 41.2%, PF 1.92, expectancy +0.47R, net +8.0R. Verified this is a real finding,
  not a flag-wiring bug (`enable_ict`/`enable_divergence`/`enable_mtf` are genuinely
  read and checked in ict.py/divergence.py/mtf.py, and all 17 accepted trades score
  100/100 -- the confluence/confirmation layers aren't the binding constraint on
  this window; something in the core structural setup criteria is). Matches
  EMPIRICAL_FINDINGS.md's existing note that SMC patterns are "amplifiers, not
  requisites."
- --real-edge-report's statistical-significance stage (bootstrap/walk-forward)
  did NOT complete for any variant within the 900s per-agent timeout -- 6 CPU-bound
  Python processes competing for cores starved each other. n=17 is also just too
  small a sample regardless.
- Real bottleneck identified: sample size, not parameter tuning. Killed the
  contending processes and launched ONE larger, non-contending run: 2024-01 to
  present (~2.5 years) instead of 6 months, same ~20 altcoins, real-edge-report
  enabled, generous timeout, running solo. In progress.

### Bottom-confluence hypothesis test (user's TradingView indicators) -- honest result after bug fix
- User pushback was fair: I'd never actually tested their specific indicators
  (Market Cipher B WaveTrend, LuxAlgo EQL, Premium/Discount zones) as a
  dedicated long-entry-at-bottoms filter -- only folded generic
  divergence/WaveTrend into an already-failed ML feature vector, and tested
  ICR's own different pattern detectors. Built a standalone, pre-registered
  test (/tmp/test_bottom_confluence.py): EQL sweep + discount zone + WT
  divergence/oversold confluence, LONG only, on real 2yr klines (20 alts).
- Initial result looked strong: n=76, WR 61.8%, expectancy +0.734R, PF 2.92,
  chronological split first-60% +1.02R / holdout +0.49R (both positive).
  Reported this to the user as the strongest finding of the session.
- Caught and fixed a real lookahead bug I'd flagged but not yet verified:
  swing-low confirmation used a +/-5 bar window computed upfront, but the
  main loop allowed using a swing low before it was actually confirmable
  (needed i >= j+5, code allowed swing_idxs <= i). Fixing this dropped the
  sample from 76 to 31 trades and expectancy from +0.734R to +0.381R.
  Corrected split: discovery +0.817R (n=12), holdout +0.105R (n=19) -- thin,
  plausibly noise at that n, does NOT clear +1R in aggregate or holdout.
- Honest reassessment: real signal (stayed directionally positive across the
  split rather than collapsing to zero/negative like the ICR aggregate did),
  but weak and unproven -- not the "strongest finding of the session" it
  looked like before the fix. Corrected the record with the user immediately.
- Dispatched a Fable Plan-mode agent (read-only) to produce a concrete plan
  for what more data/validation would be needed before this is even worth a
  confidence judgment, and (only if it clears that bar later) the integration
  path into the live platform per the new CLAUDE.md hard rules. In progress.

### Bottom-confluence hypothesis -- exhaustive honest test, final state
Tested the WaveTrend+EQL+Discount-zone confluence (and its mirror-image short
version, EQH+Premium-zone) across every reasonable, principled variation:

| Test | n | Expectancy | PF |
|---|---|---|---|
| Long, general alts, 4h (lookahead-fixed) | 31 | +0.38R | 1.73 |
| Long, holdout half, 4h | 19 | +0.10R | 1.17 |
| Long, thin CEX-orderbook-liquidity coins, 4h | 44 | -0.09R | 0.87 |
| Long, verified CEX-vol/DEX-liquidity mismatch coins, 4h | 11 | -0.18R | 0.75 |
| Short (mirror), general alts, 4h | 28 | -0.10R | 0.85 |
| Long, general alts, 1h (19 symbols) | 141 | -0.26R | 0.63 |
| Short (mirror), general alts, 1h | 180 | -0.10R | 0.86 |
| Long, wide-trail exit (EMPIRICAL_FINDINGS.md's proven 5ATR/arm@4R exit, borrowed from the ICR SMC engine), 4h | 28 | -0.29R | 0.59 |
| Long, wide-trail exit, 1h | 136 | -0.39R | 0.56 |

Also properly investigated the user's CEX-volume/DEX-liquidity mismatch angle:
initial ticker-based DEX search was unreliable (returned impersonator/wrong
tokens sharing tickers -- e.g. "ZEC" match showing $3.2B liquidity/$200
volume, obviously wrong). Rebuilt properly via CoinGecko's verified
symbol->market-cap-ranked-id->contract-address mapping (1250 top coins +
17,660-coin platform list, cross-referenced against all 524 Binance USDT
perps), then queried DexScreener by verified contract address. Found real,
confirmed extreme mismatches (BANKUSDT $1.7B vol/$127K liquidity, ACEUSDT
$65M/~$0, TLMUSDT $260M/$5K, AKEUSDT $415M/$1M ratio~406x) -- but backtesting
on this verified set was negative (n=11, -0.18R).

**Final honest conclusion**: no configuration of this hypothesis clears the
+1R bar; the two largest-sample tests (1h, n=141 and n=180) are clearly
negative rather than marginal; borrowing this repo's own proven wide-trail
exit principle makes results worse, indicating this is a different character
of setup (mean-reversion bounce) than what that exit principle was validated
for (trend-continuation). Declined to keep slicing the same entry logic into
further symbol/parameter variations once the evidence was this consistent --
continuing would risk exactly the "test until something looks positive"
pattern this session exists to avoid.

**Overall session edge-search status**: three independent tracks (ML locked
gate, Coinlegs-tier filtering, ICR rule engine on real klines) plus this
fourth track (user-specified WaveTrend/EQL/discount confluence, long and
short, two timeframes, three symbol-selection criteria, two exit models) all
returned no edge meeting the +1R bar. This is the honest, current state of
the codebase's search for tradeable edge as of this session.
