# DB-STAGE4B-CANONICAL-PARTICIPANTS — retire duplicate participant storage

## Scope

- Work item: `DB Stage 4B canonical evaluation participants`
- Baseline RUN_ID: `93551dbf-5913-4ee4-8947-26a475fff318`
- Red RUN_ID: `9fba415f-3fac-4374-9f4c-9259ff1dbabc`
- Green RUN_ID: `0e9059d2-dbae-404b-90f2-0a3211c83a1d`
- Branch: `codex/refactor-database-stage4b`
- Commit before: `4310df5`
- Commit after: this change's Git commit
- Decision reference: Stage 4B makes `evaluation_participants` authoritative while preserving the direct specialist assignment used for workflow scope.

## Reproduction / red evidence

```text
npm run evidence:run -- --work-item "DB Stage 4B canonical evaluation participants" -- node --test test/stage4bCanonicalParticipants.test.js

Observed before implementation: 3 tests failed because fresh and upgraded schemas still retained participant columns/JSON, no guarded backfill/drop existed, and malformed attendee JSON was not rejected by a Stage 4B migration.
```

## Change

- Changed behavior:
  - migration `0027` validates and backfills ticket/round roles and attendance into `evaluation_participants` before rebuilding the owning tables;
  - removes `evaluation_tickets.evaluator_name`, `qa_lead_id`, `qa_support_ids` and `evaluation_rounds.evaluator_id`, `attendees_json`;
  - repositories, services, routes, reports and frontend read/write canonical participant rows only;
  - API compatibility field names remain computed response/input adapters and are no longer database storage;
  - migration runner supports a controlled `foreign_keys=off` directive around one transaction and always restores the previous setting;
  - `assigned_specialist_id` remains because it is the workflow/data-scope assignment, with an `OWNER` participant projection retained.
- Preserved behavior: authentication/OTP/session, RBAC, supplier/question imports, ticket creation, at most two evaluation rounds, answers/scoring, nonconformity remediation, approval, reassessment, dashboard/workspace, reports/exports/downloads, audit and backup/restore.
- Migration/API impact: forward migration only. Existing API aliases remain accepted/emitted for compatibility. No production or staging database was accessed or migrated.
- Remaining deferred cleanup:
  - `evaluation_questions` and `evaluation_answers.question_id` still have active compatibility consumers;
  - `users.role` and `users.is_admin` remain in authentication/admin compatibility paths;
  - legacy report links/provenance remain until every export has canonical job/artifact provenance.

## Verification / green evidence

| Command | Exit | Result | Evidence |
|---|---:|---|---|
| focused migration/evaluation/report tests | 0 | 42/42 pass | `artifacts/dev-runs/98ac43cf-22a9-4b9b-8dc9-8087d73db8f4/` |
| full `npm test` through the Node 20 evidence runner | 0 | 1,055 tests; 1,052 pass; 0 fail; 3 intentional skip | `artifacts/dev-runs/0e9059d2-dbae-404b-90f2-0a3211c83a1d/` |
| `npm ci` | 0 | 255 packages installed from lockfile | local verification output |
| `npm run build` | 0 | CSS build complete | local verification output |
| `npm run lint` | 0 | 244 files checked; 0 failures | local verification output |
| `npm run test:webapp` | 0 | 5/5 smoke scenarios pass | `artifacts/uat-runs/e6ccfb10-56ae-493e-94b9-2cade29531e8/` |
| `npm run stage4b:parity` | 0 | PASS; 178 participants; integrity `ok`; FK violations `0` | local verification output |

Fresh creation, populated `0026` upgrade, retry/idempotency, malformed/conflicting-input rollback, migration-runner FK restoration, backup rehearsal and two consecutive startups passed. Rehearsal preserved table row counts except the expected migration-ledger row and two startup seed reconciliation rows. No schema index, trigger or view was lost. The verified full-suite evidence bundle SHA-256 is `8d02ecceff94843b1489531ab719709b8f74be49ff5aae49ded38d8cc3d44ba8`.

## UAT smoke

- UAT_RUN_ID: `e6ccfb10-56ae-493e-94b9-2cade29531e8`
- Request ID sample: `86944636-0b22-4893-8994-958d9d2f52ea`
- Synthetic actor/role: local synthetic administrator and authorization fixtures
- Desktop/mobile route: `/qlcl/` and current core/admin route matrix at 1440x1024 and 390x844
- Expected guard/action: unauthenticated requests are rejected; synthetic OTP grants only catalogued actions; evaluation and configuration routes remain available
- HTTP/UI result: 5 scenarios passed; evidence verification passed with 38 files, 5 traces and 822 request-context events
- Console/network errors: none reported by the UAT result

## Decision, blocker and rollback

- Decision: remove only the five participant duplicate/JSON columns proven fully represented by `evaluation_participants`; retain `assigned_specialist_id` and all unrelated deferred cleanup.
- Blocker: staging/production data has not been inspected. Deployment must first run the same backup rehearsal and migration guard against an environment-specific clone.
- Rollback trigger: migration guard failure, non-zero integrity/FK check, participant parity failure, startup failure or functional regression.
- Rollback procedure: stop writers, retain the failed database for diagnosis, restore the verified pre-0027 SQLite backup, deploy the previous application version, then rerun integrity/FK checks and two startup smokes.
- Data restore requirement: required after a successful `0027`, because the forward migration removes five legacy columns after canonical parity validation.

## Safety declaration

- [x] Evidence verify passed and wrapper preserved the child exit status.
- [x] Summary re-run command works from a clean checkout with Node 20 and `npm ci`.
- [x] No chain-of-thought is recorded.
- [x] No secret, OTP, token, cookie, authorization value or real PII is recorded.
- [x] No production DB/WAL/SHM, real upload or generated customer report is included.
- [x] Fixtures and UAT data are deterministic and synthetic.
