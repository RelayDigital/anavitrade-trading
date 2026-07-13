# Task Plan: Production Pipeline Fix

## Goal
Fix the blocking D1 Date serialization bug so the scraper can insert signals, then re-enable all pipeline stages (analysis engine, outcome validation, fee crystallization, SMC dispatch).

## Current Status
- **Phase 1 (D1 Fix):** PARTIAL — schema fixed, D1 raw binding works, but confluence SELECT still passes `new Date()` → ISO string error
- **Phase 2 (Pipeline):** PENDING — bridge disabled, SMC dispatch disabled, analysis engine never fired (0 runs)
- **Phase 3 (Seeding):** PENDING — need to trigger engines after fix

## Phases

### Phase 1: Fix Remaining Date Object
- [ ] `grep -rn "new Date(" src/server/coinlegs-scraper.ts | grep -v "toISOString\|\.getTime"`
- [ ] Fix confluence SELECT on line 238: replace `new Date(...)` with `Date.now()`
- [ ] Deploy and test: `curl -X POST /api/scraper/run` → expect `signalsInserted > 0`

### Phase 2: Re-enable Bridge & Dispatch
- [ ] Fix `analysis_signals` schema: change `createdAt`, `updatedAt` to `number` mode
- [ ] Re-enable `bridgeCoinlegsSignals` call in scraper
- [ ] Re-enable SMC structural validation + dispatch in scraper
- [ ] Deploy and confirm end-to-end: signals → analysis_signals → TradeIntent → executionJobs

### Phase 3: Prime All Engines
- [ ] Trigger `POST /api/analysis/run` → confirm `analysis_runs` populated
- [ ] Trigger `POST /api/signals/generate` → confirm native generator creates intents
- [ ] Trigger `POST /api/outcome/validate` → confirm `outcomeValidated` increments
- [ ] Trigger `POST /api/fee/crystallize` → confirm `fee_payments` created

### Phase 4: Production Hardening (if needed)
- [ ] Set real `ENCRYPTION_KEY` and `JWT_SECRET` via `npx wrangler secret put`
- [ ] Upgrade wrangler: `npm install --save-dev wrangler@4`
- [ ] Verify `GET /api/signals` returns populated signals

## Key Commands for Next Agent
```bash
# Deploy latest
pnpm check && pnpm build && npx wrangler deploy

# Test scraper
curl -s -H "x-admin-api-key: dev-secret-key-anavitrade-2026" -X POST \
  "https://anavitrade-trading.erhazeariel.workers.dev/api/scraper/run"

# Check DB state
npx wrangler d1 execute anavitrade-db --remote \
  --command "SELECT COUNT(*) FROM coinlegs_signals; SELECT COUNT(*) FROM analysis_signals;"
```
