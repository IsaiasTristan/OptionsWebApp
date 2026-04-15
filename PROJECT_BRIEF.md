### Current Development Focus

Ship and harden the **OPTIX** React + Vite frontend: options pricer / vol surface lab (`OptionsModel`), vol screener and data QC (`ScreenerDashboard`), Supabase-backed watchlist and read-only market tables fed by `../data-pipeline`.

### Key Decisions / Constraints

- **Data**: Supabase is the runtime API; no bespoke backend in this repo. Anon key in the browser — **RLS** on `strategies` (and table policies generally) is mandatory for production.
- **Layers**: UI in `src/*.jsx`; Supabase access in `src/lib/screenerApi.js` and `src/lib/supabase.js`; pricing / surface **pure logic** in `src/domain/`; shared policy constants in `src/lib/marketPolicy.js`.
- **Contracts**: Schema expectations are documented in `docs/DATA_CONTRACT.md`; coordinate breaking changes with the pipeline.
- **Tooling**: Stable **Vite 6**; CI runs lint, unit tests (`vitest`), and production build.

### Major Changes Log

- **2026-04-15**: Screener loads up to ~1 calendar year of `vol_surfaces` history (paginated), date-windowed from latest pipeline `as_of_date`; equity history fetch returns most recent rows; dashboard **Refresh data** clears latest-date cache and refetches tabs.
- **2026-04-13**: QC equity fetch fixed (latest `trade_date` slice per universe); `latestDate` error handling; chain/model queries use `maybeSingle` where appropriate; parity and IV null-safety; domain extraction (`blackScholes`, `volSurface`, `riskFreeRate`); `marketPolicy`, watchlist snapshot validation, `reportError`, lazy-loaded screener, Vitest in CI, `PROJECT_BRIEF.md` / `AGENTS.md`.
