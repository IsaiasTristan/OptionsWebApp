# GitHub Protection Setup

Repository: `IsaiasTristan/OptionsWebApp`

## Required Branch Protection (main)

Set the following in GitHub UI (`Settings -> Branches -> Add rule`) for branch `main`:

- Require a pull request before merging: ON
- Require approvals: ON (min 1)
- Dismiss stale approvals when new commits are pushed: ON
- Require review from Code Owners: ON
- Require status checks to pass before merging: ON
- Required status check: `build`
- Require branches to be up to date before merging: ON
- Restrict who can push to matching branches: ON (admins/team only)
- Do not allow force pushes: ON
- Do not allow deletions: ON

## Repository Settings

- Default branch: `main`
- Actions permissions: allow local actions and reusable workflows only if needed
- Dependabot alerts/security updates: ON

## Notes

CI workflow file: `.github/workflows/ci.yml`
Status check job name: `build`
