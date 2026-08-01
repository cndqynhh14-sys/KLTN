# DB-STAGE4-LEGACY-CLEANUP — consolidate corrective-action storage

## Scope

- Work item: `DB-STAGE4-LEGACY-CLEANUP`
- Evidence RUN_ID: `501d50fa-a58a-4eac-8884-d15309b76894`
- Branch: `codex/refactor-database-stage4`
- Commit before: `1c8d0db32cea3988f3b91fb0334c8ec3e5e324ae`
- Commit after: this change's Git commit
- Decision reference: Stage 4 contract: no separate remediation-evidence management, at most one remediation per nonconformity and evaluation pass, and no responsible-party/completion fields.

## Reproduction / red evidence

```text
.\.tmp\toolchains\node-v20.20.2-win-x64\node.exe scripts\run-with-evidence.js run --work-item "DB-STAGE4-LEGACY-CLEANUP" -- .\.tmp\toolchains\node-v20.20.2-win-x64\node.exe --test test\stage4LegacyCleanup.test.js

Observed before implementation: 3 tests failed because corrective_actions and the duplicate nonconformity/remediation columns still existed and no cleanup guard was present.
Red RUN_ID: 3c2b7d75-37a5-456d-802a-3587cc52c67a
```

## Change

- Changed behavior:
  - migration `0026` backfills and validates canonical remediation data, rebuilds `evaluation_nonconformities`, and removes `corrective_actions` plus `nonconformity`, `remediation`, and `corrective_action_id`;
  - migration aborts transactionally if an independent corrective action, conflicting values, or excluded evidence/responsible-party values would be lost;
  - runtime, dashboard, workspace, reports and exports now read/write canonical nonconformity fields only;
  - the duplicate “create corrective action” route/action was removed; remediation is edited on its owning nonconformity;
  - response/report compatibility aliases remain computed values and are not persisted twice.
- Preserved behavior: authentication/OTP/session, RBAC, suppliers/import, question templates/import, ticket rounds/answers/scoring, approvals, reassessment/extensions, dashboard, reports/exports/downloads, audit, backup/restore and technical tables.
- Migration/API impact: forward migration only; no production migration was run. The obsolete `POST /evaluations/:ticketId/corrective-actions` boundary is removed. Existing nonconformity update API remains.
- Deferred cleanup:
  - `evaluation_questions` and `evaluation_answers.question_id`: active runtime consumers and 1,658 local legacy links;
  - `users.role` and `users.is_admin`: authentication/admin compatibility consumers remain;
  - participant legacy columns/JSON: active compatibility consumers remain, including 36 ticket evaluator and 53 round evaluator values plus 39 attendee JSON rows;
  - legacy report storage/links: 78 exports lack canonical job and artifact provenance;
  - all report, audit, import, lifecycle, reconciliation and technical tables remain.

## Verification / green evidence

| Command | Exit | Result | Evidence |
|---|---:|---|---|
| focused Stage 2/3/4, evaluation, dashboard, workspace and reporting tests | 0 | 32/32 pass | `artifacts/dev-runs/9ea69ce6-f959-4f2f-bf22-b2025e8ebb54/` |
| full `npm test` through the Node 20 evidence runner | 0 | 1,050 tests; 1,047 pass; 0 fail; 3 intentional skip | `artifacts/dev-runs/501d50fa-a58a-4eac-8884-d15309b76894/` |
| `npm run build` through Node 20 | 0 | CSS build complete | `artifacts/dev-runs/54c6ba87-9728-41c0-9ebb-7e7b7e64f162/` |
| local webapp smoke through Node 20 | 0 | 5/5 scenarios pass | `artifacts/dev-runs/fd219a81-197a-456b-a0b5-1952c3be283b/` |
| `scripts/check-stage4-parity.js --db data/qlcl.db` | 0 | PASS; integrity `ok`; FK violations `0` | local verification output |

Upgrade rehearsal, fresh creation, retry, two consecutive startups, migration refusal/rollback on unsafe data, deploy preflight backup/restore and local backup restoration all passed. The verified evidence bundle SHA-256 is `dfd7588b13f28da32c3976de7d05e2fd6047e415deeb4f7e32ca4b3d5b5b7ddd`.

## UAT smoke

- UAT_RUN_ID: `c41fb331-c266-442f-aa3b-64602c58fc7f`
- Request ID sample: `64076df7-81f6-4aab-b8b0-5b62744589cf`
- Synthetic actor/role: local synthetic administrator and synthetic authorization fixtures
- Desktop/mobile route: `/qlcl/` plus the current core/admin route matrix at 1440x1024 and 390x844
- Expected guard: unauthenticated `auth/me` is rejected; synthetic OTP login grants only catalogued actions
- Result: 5 scenarios passed; evidence verification passed with 38 files and 5 traces
- Console/network errors: none reported by the UAT result

## Decision, blocker and rollback

- Decision: remove only corrective-action duplicate storage in this stage; defer every other candidate with an active consumer or unresolved provenance.
- Blocker: production/staging data was not read or migrated. Their preflight must pass the same migration guards before deployment.
- Rollback trigger: migration guard failure, non-zero FK/integrity result, application startup failure, or functional regression.
- Rollback procedure: stop writers, retain the failed database for diagnosis, restore the verified pre-0026 SQLite backup, deploy the prior application version, then run integrity/FK checks and two startup smokes.
- Data restore requirement: required because SQLite migrations are forward-only and `0026` removes duplicate columns/table after validation.

## Safety declaration

- [x] Evidence verify passed and wrapper preserved the child exit status.
- [x] Summary re-run command works from a clean checkout with Node 20 and `npm ci`.
- [x] No chain-of-thought is recorded.
- [x] No secret, OTP, token, cookie, authorization value or real PII is recorded.
- [x] No production DB/WAL/SHM, real upload or generated customer report is included.
- [x] Fixtures and UAT data are deterministic and synthetic.
