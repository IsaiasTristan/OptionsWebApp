# Agent guidance (terminal + Cursor)

Keep this file aligned with **Cursor User Rules** for this project. When Cursor rules change, update this file so the meaning stays identical (synchronization only — do not invent new rules here).

**Status freshness (last verified):** 2026-04-15 — `npm run lint`, `npm run test`, `npm run build` succeed on the default stack after dependency updates.

---

## Project Scope

- **Purpose**: Single-page **OPTIX** app for options modelling, vol screening, and data QC against Supabase tables populated by `../data-pipeline`.
- **Problem**: Traders/researchers need a consistent UI for vol surfaces, watchlists, and pipeline health without running the pipeline locally.
- **Capabilities**: Black–Scholes / surface tooling, screener dashboards, QC tab, cloud or local watchlist persistence.
- **Architecture**: React + Vite SPA; `src/lib/screenerApi.js` and `src/lib/supabase.js` for data access; `src/domain/` for framework-agnostic numerics; docs in `docs/`.

---

## Engineering principles (mirror of user rules)

- **Modular monolith**: Preserve `ui → data access → domain` direction; keep business/numeric logic out of giant JSX where practical.
- **Untrusted boundaries**: Validate external payloads (Supabase rows, `localStorage`, screener hand-offs) before trusting shape.
- **Observability**: Use `reportError` (or equivalent) instead of silent failures on important paths.
- **Quality**: Prefer small modules, avoid duplication of policy constants, add tests for pure functions.
- **Security**: Never rely on the UI for authorization; enforce with **Supabase RLS** and key hygiene.
- **Project brief**: Maintain `PROJECT_BRIEF.md` for high-level intent and major changes.

---

## Repository pointers

| Area | Location |
|------|----------|
| Data / QC queries | `src/lib/screenerApi.js` |
| Watchlist cloud API | `src/lib/supabase.js` |
| Pricing & surface core | `src/domain/` |
| Policy constants | `src/lib/marketPolicy.js` |
| Snapshot validation | `src/lib/watchlistSnapshot.js` |
| Data contract | `docs/DATA_CONTRACT.md` |
| Supabase setup + RLS notes | `SUPABASE_SETUP.md` |

---

## Cursor rules mirror

The authoritative copy of user-defined Cursor rules lives in the Cursor settings for this workspace. This `AGENTS.md` summarizes scope and engineering principles above; **if your Cursor rules add requirements, paste or mirror them verbatim in a dedicated section here** so terminal agents see the same text.
