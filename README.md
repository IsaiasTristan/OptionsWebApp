# OPTIX Platform (Source of Truth)

Production source of truth for the options modeling frontend.

## Scope

- Frontend runtime: React + Vite app in this repository.
- Data backend: Supabase tables populated by `../data-pipeline`.
- Watchlist persistence: Supabase (cloud) with local fallback only when cloud is unavailable.

## Local Development

```bash
npm install
npm run dev
```

If the Vol Screener shows **Failed to fetch**, confirm `.env` has a real Supabase URL/key, restart the dev server, then run **`npm run verify:supabase`** (Node 20+ loads `.env` automatically). See `SUPABASE_SETUP.md` §7.

## Build

```bash
npm run lint
npm run test
npm run build
npm run preview
```

## Architecture

- UI shell and routing: `src/App.jsx`
- Options model UI: `src/OptionsModel.jsx`
- Screener/QC dashboard: `src/ScreenerDashboard.jsx`
- Data access layer: `src/lib/screenerApi.js`
- Supabase client and strategy persistence: `src/lib/supabase.js`
- Domain numerics (framework-agnostic): `src/domain/`
- Shared market thresholds: `src/lib/marketPolicy.js`

## Project orientation

- **`PROJECT_BRIEF.md`** — living summary of focus, constraints, and major changes.
- **`AGENTS.md`** — scope and agent/engineering expectations (keep aligned with Cursor user rules).

## Operating Model

See:
- `docs/OPERATING_MODEL.md`
- `docs/DATA_CONTRACT.md`

## Non-Goals

- No feature development in deprecated standalone folder `../Options Model`.
- No schema changes in production without migration discipline and contract update.
