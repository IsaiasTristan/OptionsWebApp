# Operating Model

## Governance

- `main` is protected.
- All changes go through pull requests.
- At least one reviewer approval is required.
- Direct pushes to `main` are disabled.

## Release Process

1. Develop on feature branch.
2. Open PR with scope and risk summary.
3. CI must pass (lint + build).
4. Merge to `main`.
5. Deploy web app from `main` only.

## Environment Strategy

- `dev`, `stage`, and `prod` Supabase projects are separate.
- Environment variables are managed per environment.
- Production keys are never used in local development.

## Incident Handling

- Roll back by redeploying the previous successful build.
- If issue is data-related, freeze screener queries to latest known-good `as_of_date`.
- Capture root cause and add regression test or guard.

## Ownership

- Frontend ownership: this repo (`options-model-web`).
- Data ownership: `../data-pipeline`.
- Interface ownership: documented in `docs/DATA_CONTRACT.md`.
