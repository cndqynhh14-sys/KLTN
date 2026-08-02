# DB-STAGE4C-CANONICAL-QUESTIONS — Canonical question persistence

## Scope

- Work item: Stage 4C removes legacy evaluation-question persistence after verified canonical parity.
- Evidence RUN_ID: `7384b9b1-2ba8-4add-8ab2-38125ad5d6ad` (full suite), `b034dc83-afae-4ba9-a043-546f6e60ef90` (focused migration).
- Branch: `codex/refactor-database-stage4c`
- Commit before: `a723e7bd0110e3a119dac9c9f7b34a8da9fdbeb2`
- Commit after: not committed in this work item.
- Decision reference: Stage 4C is local-only; staging, Railway, production, push and merge are deferred.

## Reproduction / red evidence

```text
npm run evidence:run -- --work-item "DB Stage 4C canonical questions" -- node --test test/stage4cCanonicalQuestions.test.js
RUN_ID=1f735f0a-09c1-44bf-b061-bc64e7570302
Exit 1: all three Stage 4C contract tests failed before migration 0028 existed.
```

## Change

- Changed behavior: evaluation answers and nonconformities persist canonical `question_item_id`; active question queries read `question_items` through the ticket-pinned template version.
- Preserved behavior: API compatibility may still expose the field name `question_id`, but its value is now the canonical question-item identifier.
- Migration/API impact: migration `0028_canonicalize_evaluation_questions.sql` validates parity, rebuilds dependent tables, removes legacy question columns and drops `evaluation_questions`. The compatibility view `pinned_evaluation_questions` now projects canonical items only.
- Changed files: migration 0028; Stage 4C parity script; evaluation/question repositories, services and routes; startup/readiness; browser adapter; affected canonical fixtures/tests; package script.

## Verification / green evidence

| Command | Exit | Duration | Pass/fail/skip | Evidence path |
|---|---:|---:|---|---|
| `node --test test/stage4cCanonicalQuestions.test.js` | 0 | 0.974 s | 3/0/0 | `artifacts/dev-runs/b034dc83-afae-4ba9-a043-546f6e60ef90/` |
| `npm test` | 0 | 38.617 s | 1059/0/3 (1062 total) | `artifacts/dev-runs/7384b9b1-2ba8-4add-8ab2-38125ad5d6ad/` |
| `npm run lint` | 0 | 11.8 s | 247 files, 0 failures | local terminal output |
| `npm run build` | 0 | 12.8 s | build passed | local terminal output |
| `npm run stage4c:parity -- --db data\\qlcl.db` | 0 | local | parity passed; all hard failures 0 | local terminal output |
| `PRAGMA integrity_check; PRAGMA foreign_key_check;` | 0 | local | `ok`; 0 FK violations | local terminal output |

Fresh database creation, upgrade rehearsal, rollback-by-restore rehearsal and two consecutive application startups were also successful. Migration ledger reports 28 applied and 0 pending locally.

## UAT smoke

- UAT_RUN_ID: `b6a9b150-e3b9-4e9d-aa05-138921b57151`
- Request ID: `4edfd437-2b65-4bf5-9344-ddf722dc2bbf` (first request in the failing scenario trace)
- Synthetic actor/role: generated local UAT administrator.
- Desktop/mobile route: `/qlcl/#/admin/personnel-import`; core authentication and current core-route scenarios also ran.
- Expected backend/frontend guard: synthetic local database only; authenticated admin permission guard.
- Expected visible navigation/action: personnel-import mapping and validation actions remain usable at desktop and mobile sizes.
- HTTP/UI result: 4 of 5 scenarios passed. The personnel-import scenario failed twice at the unrelated mobile touch-target size assertion (`>= 44px`) before its commit step; its API/data flow loaded successfully. A clean worktree at base commit `a723e7bd` reproduced the same failure (`UAT_RUN_ID=31e81899-9b9e-4b6a-bcb3-fe851c567ff7`), proving it is not a Stage 4C regression.
- Console/network errors: the four passing scenarios reported no unexpected errors; the failing result is retained under `artifacts/uat-runs/b6a9b150-e3b9-4e9d-aa05-138921b57151/`.

## Decision, blocker and rollback

- Decision: `LOCAL_COMPLETE — STAGING_DEFERRED`. The Stage 4C database/runtime implementation and Node suite are green and may be published as a Draft PR. Do not merge until the independent UAT touch-target gate and staging rehearsal are resolved.
- Blocker: no managed staging environment; a pre-existing mobile touch-target UAT failure in the personnel-import module, reproduced unchanged at the clean base commit.
- Rollback trigger: parity, integrity, foreign-key, startup or retained-feature regression after applying migration 0028.
- Rollback procedure: stop writers, restore the verified pre-0028 SQLite backup, deploy the pre-Stage-4C application revision, then rerun parity and health checks.
- Data restore requirement: SQLite table-drop cleanup is not reversed in place; rollback requires the pre-migration backup.

## Safety declaration

- [x] Green evidence verify passed and the wrapper preserved the child exit status.
- [x] Summary re-run commands work from a clean checkout with Node 20 and `npm ci` prerequisites.
- [x] No chain-of-thought is recorded.
- [x] No secret, OTP, token, cookie, authorization value or real PII is recorded.
- [x] No production DB/WAL/SHM, real upload or generated customer report is included.
- [x] Fixtures and UAT data are deterministic and synthetic.
