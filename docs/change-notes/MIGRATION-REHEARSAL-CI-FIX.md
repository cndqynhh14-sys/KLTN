# Migration rehearsal CI — provision Playwright Chromium

## Scope

- Work item: Fix migration rehearsal CI browser provisioning
- Evidence RUN_ID: `65738a91-890b-4782-8c2e-243966e45c60`, `7e457f3b-6ad6-40b6-9a47-e3c61b2682aa`, `c91f771f-5e5b-4861-9f5c-70ee983f704d`, `f02f0444-c1cb-4f8a-92ab-6d877bbe5237`
- Branch: `codex/fix-migration-rehearsal-ci`
- Commit before: `4fb4201`
- Decision reference: GitHub Actions run `30740823320`

## Reproduction / red evidence

```text
node --test test/migrationRehearsal.test.js
The workflow contract failed because no Playwright Chromium installation or failure-safe report upload was configured.
```

GitHub Actions had already completed migrations 0028–0029, integrity/FK checks and both startups. The UAT process failed on Ubuntu because the workflow selected Playwright Chromium but only installed npm packages; Playwright 1.60 does not install browser binaries through `npm ci`.

## Change

- Changed behavior: the workflow installs Chromium with its Ubuntu dependencies before UAT.
- Preserved behavior: migrations, application runtime, synthetic fixture and report safety rules are unchanged.
- Migration/API impact: none.
- Changed files: migration rehearsal workflow, workflow contract test and this change note.
- Diagnostic behavior: sanitized migration and UAT reports are uploaded with `if: always()` even when rehearsal fails.

## Verification / green evidence

| Command | Exit | Result | Evidence path |
|---|---:|---|---|
| `node --test test/migrationRehearsal.test.js` | 0 | 2 pass, 0 fail | `artifacts/dev-runs/7e457f3b-6ad6-40b6-9a47-e3c61b2682aa/` |
| `npm run rehearsal:stage4:uat -- --output-dir artifacts/migration-rehearsal/ci-fix-local` | 0 | PASS; UAT 5/5 | `artifacts/dev-runs/c91f771f-5e5b-4861-9f5c-70ee983f704d/` |
| `npm run evidence:test -- --work-item "Fix migration rehearsal CI browser provisioning"` | 0 | 373 pass, 0 fail, 1 skip | `artifacts/dev-runs/f02f0444-c1cb-4f8a-92ab-6d877bbe5237/` |
| `npm run lint` | 0 | 254 checked, 0 failures | local command output |
| `npm run build` | 0 | PASS | local command output |

All three green evidence runs passed verification and secret scanning and were bundled locally.

## UAT smoke

- UAT_RUN_ID: `d4cce272-da5c-4065-a824-0593a2cc5abf`
- Synthetic actor/role: generated local test identities only
- Desktop/mobile route: local smoke scenario
- Expected guard: authentication and canonical authorization remain enforced
- HTTP/UI result: PASS, 5/5 scenarios
- Console/network errors: none reported

## Decision, blocker and rollback

- Decision: merge only after both normal CI and the Migration rehearsal PR check pass on Ubuntu.
- Blocker: Stage 5 remains blocked until the fixed workflow is merged and manually passes on `main`.
- Rollback trigger: browser provisioning or sanitized artifact checks introduce a new failure.
- Rollback procedure: revert this workflow-only change.
- Data restore requirement: none; no application database is modified.

## Safety declaration

- [x] Evidence verify passed and wrapper preserved the child exit status.
- [x] Summary re-run command works from a clean checkout with documented prerequisites.
- [x] No chain-of-thought is recorded.
- [x] No secret, OTP, token, cookie, authorization value or real PII is recorded.
- [x] No production DB/WAL/SHM, real upload or generated customer report is included.
- [x] Fixtures and UAT data are deterministic and synthetic.
