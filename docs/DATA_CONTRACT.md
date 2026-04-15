# Data Contract

Contract version: `v1.1.0`
Last updated: `2026-04-15`

## Producer

`../data-pipeline`

## Consumer

`options-model-web` via Supabase reads in `src/lib/screenerApi.js`

## Required Tables

- `tickers`
- `options_chains`
- `equity_daily`
- `vol_surfaces`
- `screener_output`
- `strategies` (cloud watchlist)

## Required Fields (minimum used by frontend)

### vol_surfaces
- `symbol`
- `as_of_date`
- `atm_iv_30d`
- `atm_iv_60d`
- `atm_iv_90d`
- `atm_iv_180d`
- `term_slope`
- `skew_25d_30d`
- `rv_20d`
- `iv_rv_spread`
- `total_opt_vol`
- `total_oi`
- `pc_volume_ratio`

### screener_output
- `symbol`
- `as_of_date`
- `rank`
- `volume_ratio`
- `skew_zscore`
- `composite_score`
- `flags`

### options_chains
- `symbol`
- `as_of_date`
- `strike`
- `expiry`
- `option_type`
- `implied_vol`
- `volume`
- `open_interest`
- `dte`
- `bid`
- `ask`
- `in_the_money`

### equity_daily
- `symbol`
- `trade_date`
- `close`

## Snapshot storage (append vs overwrite)

The web app **only reads** Supabase. It shows the latest `as_of_date` / `trade_date` present in the tables; it cannot invent rows through a target calendar date.

**Intended producer behavior** (see `../data-pipeline`):

- **`vol_surfaces`, `screener_output`, `options_chains`** — One logical row per **symbol per snapshot date** (`as_of_date`). Loading a **new** trading day should **add** rows for that date. Rows for **older dates stay in the database** so the UI can chart history and IV rank.
- **Re-running the same date** — If the pipeline uses `upsert` / `ON CONFLICT … DO UPDATE` on `(symbol, as_of_date)` (and the same idea for chain rows including strike/expiry/type), only that snapshot is updated; **other dates are not removed**.
- **`equity_daily`** — One row per `(symbol, trade_date)`. New dates append; the same date may be updated if re-ingested.
- **What would remove history** — Explicit `DELETE` (or truncating a table) before reload. That is not required for normal daily loads.

**Checking coverage through a target date (e.g. 2026-04-15)** — In Supabase **SQL Editor** (service role / SQL; not the browser anon key):

```sql
select 'vol_surfaces' as tbl, max(as_of_date) as latest from vol_surfaces
union all
select 'screener_output', max(as_of_date) from screener_output
union all
select 'options_chains', max(as_of_date) from options_chains
union all
select 'equity_daily', max(trade_date) from equity_daily;
```

If `latest` is before your target, run or backfill the **data-pipeline** for each missing trading day through that date until these maxima reach the pipeline’s “caught up” state.

## Change Policy

- Backward-compatible additions: minor version bump.
- Breaking changes (rename/drop/type change): major version bump and coordinated rollout.
- No breaking schema changes without updating this file and frontend consumption logic in the same PR set.
