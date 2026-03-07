# Data Contract

Contract version: `v1.0.0`
Last updated: `2026-03-07`

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

## Change Policy

- Backward-compatible additions: minor version bump.
- Breaking changes (rename/drop/type change): major version bump and coordinated rollout.
- No breaking schema changes without updating this file and frontend consumption logic in the same PR set.
