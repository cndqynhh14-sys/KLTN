# Stage 4 migration rehearsal — repository-level staging equivalent

## Scope

- Work item: Stage 4 migration rehearsal environment
- Evidence RUN_ID: `d059ec3e-b70a-4e06-9a46-ebdd6becb586`, `f643bdb0-a0d9-46c5-bc5a-cea1fb4f1140`
- Branch: `codex/refactor-database-stage4e`
- Commit before: `0475941`
- Decision reference: use a synthetic staging-equivalent gate while Railway staging remains unavailable

## Reproduction / red evidence

```text
node --test test/migrationRehearsal.test.js
Missing scripts/rehearse-database-migrations.js (RUN_ID b5220d74-2c78-4098-aee2-82809b4a9345).

npm run rehearsal:stage4:uat -- --output-dir artifacts/migration-rehearsal/local-stage4
The Windows npm child process failed to launch with EINVAL (RUN_ID f8af3d20-2a9e-492f-9b58-26e9d7b105f5).

The first clean-worktree UAT measured two mobile personnel-import action targets at 42.78125px, below the required 44px.
```

## Change

- Changed behavior: added a deterministic pre-0028 database generator, migration/backup/restore orchestrator, sanitized reports and a GitHub Actions gate; enforced the existing 44px mobile target-size contract for sticky admin actions.
- Preserved behavior: migrations 0028 and 0029, runtime business logic and unresolved legacy report exports are unchanged.
- Migration/API impact: no new migration and no API contract change.
- Changed files: package scripts, rehearsal scripts/test, workflow and documentation.

## Verification / green evidence

| Command | Exit | Result | Evidence path |
|---|---:|---|---|
| `npm run rehearsal:stage4:uat -- --output-dir artifacts/migration-rehearsal/local-stage4` | 0 | PASS | `artifacts/dev-runs/d059ec3e-b70a-4e06-9a46-ebdd6becb586/` |
| `npm run evidence:test -- --work-item "Stage 4 clean CI verification"` | 0 | 373 pass, 0 fail, 1 skip | clean checkout `artifacts/dev-runs/f643bdb0-a0d9-46c5-bc5a-cea1fb4f1140/` |
| `npm run lint` | 0 | 254 files, 0 failures | local command output |
| `npm run build` | 0 | PASS | local command output |

Both evidence runs passed checksum, NDJSON and secret scans and were bundled locally.

## UAT smoke

- UAT_RUN_ID: `13ca677f-e9e1-4ddd-b39d-836a5ae6713a` (clean checkout)
- Accessibility regression verification: `f51dd230-205a-4996-bf06-cdec4ccaadc6` (5/5 scenarios passed)
- Synthetic actor/role: generated local test identities only
- Desktop/mobile route: local smoke scenario
- Expected guard: authentication and canonical authorization remain enforced
- HTTP/UI result: PASS
- Console/network errors: none reported

## Decision, blocker and rollback

- Decision: the repository-level gate is sufficient to validate Stage 4 merge safety without claiming Railway validation.
- Blocker: Railway staging remains outside this proof; production deployment is not authorized by this change.
- Rollback trigger: rehearsal workflow or full CI fails after the PR is retargeted to `main`.
- Rollback procedure: revert this tooling-only commit; migrations and production data are unaffected.
- Data restore requirement: none for the tooling commit; the rehearsal itself verifies restoration of its synthetic backup.

## Safety declaration

- [x] Evidence verify passed and wrapper preserved the child exit status.
- [x] Summary re-run command works from a dependency-clean workspace with documented prerequisites.
- [x] No chain-of-thought is recorded.
- [x] No secret, OTP, token, cookie, authorization value or real PII is recorded.
- [x] No production DB/WAL/SHM, real upload or generated customer report is included.
- [x] Fixtures and UAT data are deterministic and synthetic.
