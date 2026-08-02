# DB-STAGE4D-REPORT-PROVENANCE — reconcile report export provenance

## Scope

- Work item: `DB Stage 4D report provenance`
- Baseline RUN_ID: `64e1f5e5-2fb0-4d72-9f2d-e285a6634f03`
- Red RUN_ID: `a2c3bca2-4f3a-4dfd-a4e3-ddd9ba15f35f`
- Path-boundary red RUN_ID: `0495eeb5-d106-4efd-98b8-3016bf464091`
- Branch: `codex/refactor-database-stage4d`
- Commit before: `b3e478fe7f9bbdb170dda97d597f4586b203b6a0`
- Commit after: this change's Git commit
- Decision reference: Stage 4D verifies canonical report provenance and classifies legacy exports without deleting or inventing provenance.

## Reproduction / red evidence

```text
npm run evidence:run -- --work-item "DB Stage 4D report provenance" -- node --test test/stage4dReportProvenance.test.js

Observed before implementation: 3 tests failed because reconciliation did not checksum its inventory, had no guarded/idempotent classification apply operation, and did not audit canonical artifact bytes.
```

## Change

- Added a deterministic Stage 4D reconciliation report covering export/job/artifact/source-snapshot relationships and stored artifact bytes.
- Legacy paths are disclosed only as SHA-256 hashes. Files are read only after proving that the resolved path is inside the approved legacy root.
- The approved root and candidate are resolved to real filesystem paths before reading, so a symlink or junction cannot escape the root boundary.
- Classification apply is transaction-bound, inventory-checksum guarded and idempotent. It changes only reconciliation and availability status; it does not delete, import, relink or rewrite files.
- Added `npm run stage4d:parity` with explicit database, legacy-root and artifact-root overrides for safe database-copy rehearsal.
- No `0029` migration was created. The local inventory contains 81 exports: 3 canonical exports verified successfully and 78 legacy exports classified `OUTSIDE_ROOT`. Those 78 rows remain cleanup blockers.
- Existing export, download and retention behavior is preserved. No production or staging resource was accessed.

## Verification / green evidence

| Command | Exit | Result | Evidence |
|---|---:|---|---|
| focused Stage 4D and report artifact tests | 0 | 12/12 pass, including symlink/junction escape rejection | `artifacts/dev-runs/2fa6bb33-e9bc-402a-ad00-d047f5d14993/` |
| full `npm test` after `npm ci` through evidence runner | 0 | 1,426 tests; 1,422 pass; 0 fail; 4 intentional skip | `artifacts/dev-runs/9123b3af-6f5f-4c68-b86f-a00d49563a59/` |
| `npm ci` | 0 | 247 packages installed; 0 vulnerabilities | local verification output |
| `npm run build` | 0 | CSS build complete | local verification output |
| `npm run lint` | 0 | 248 files checked; 0 failures | local verification output |
| `npm run stage4d:parity` | 0 | 3/3 canonical artifacts verified; 78 legacy blockers | local verification output |
| two consecutive starts against fresh DB | 0 | `/health` returned HTTP 200 twice | local verification output |

Rehearsal classification on a SQLite backup copy updated 78 rows on the first pass and 0 rows on the second pass. With the original canonical artifact root supplied explicitly, canonical verification passed 3/3; `PRAGMA integrity_check` returned `ok` and `PRAGMA foreign_key_check` returned no rows. A fresh database also reached all 28 migrations, reported `READY_FOR_CLEANUP` with zero legacy rows, and passed both SQLite checks. The verified final full-suite evidence bundle SHA-256 is `58bd8e2548f1c4129bb4d6b7a047950e40d691db877d71d27b1b6dc6e1cc8550`.

## UAT smoke

Not applicable. Stage 4D changes an offline reconciliation command and its persistence audit; it does not change UI, authentication, authorization or navigation behavior.

## Decision, blocker and rollback

- Decision: `RECONCILIATION_COMPLETE — CLEANUP_DEFERRED`.
- Blocker: 78 exports have neither `job_id` nor `artifact_id`, and their stored paths resolve outside the approved legacy root. Their files and provenance cannot be verified safely.
- Rollback trigger: checksum guard failure, canonical provenance failure, integrity/FK failure, or unexpected row/link/file mutation.
- Rollback procedure: stop the rehearsal, discard its database copy, retain the original database unchanged, and revert the Stage 4D application commit if necessary.
- Data restore requirement: none for dry-run. A classification apply on a real database requires a verified SQLite backup even though it does not delete data.

## Safety declaration

- [x] Evidence verify passed and wrapper preserved the child exit status.
- [x] Summary re-run command works from a clean checkout with documented prerequisites.
- [x] No chain-of-thought is recorded.
- [x] No secret, OTP, token, cookie, authorization value or real PII is recorded.
- [x] No production DB/WAL/SHM, real upload or generated customer report is included.
- [x] Fixtures and UAT data are deterministic and synthetic.
