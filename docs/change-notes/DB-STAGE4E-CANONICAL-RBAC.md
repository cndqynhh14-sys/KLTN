# DB Stage 4E — canonical RBAC runtime

## Scope

- Work item: DB Stage 4E RBAC canonical-only
- Baseline RUN_ID: `aaa65176-69ed-4d95-8c6f-8719530360de`
- Red RUN_ID: `54a68cdb-f33c-476d-916c-128d1a68f4a3`
- Green RUN_ID: `435a179b-eb77-4c6b-a71d-fb85f11e9ccb`
- Clean-checkout RUN_ID: `717e9282-d281-4907-843b-10f89ee52be4`
- Branch: `codex/refactor-database-stage4e`
- Commit before: `a96c505759904575b6d5b977c13b9835446e4c95`
- Decision: `CANONICAL_RUNTIME_COMPLETE_COLUMN_CLEANUP_DEFERRED`

## Reproduction / red evidence

```text
npm run evidence:run -- --work-item "DB Stage 4E RBAC canonical-only" -- node --test test/stage4eCanonicalRbac.test.js test/authMiddleware.test.js
RUN_ID 54a68cdb-f33c-476d-916c-128d1a68f4a3: 0 pass, 6 fail before implementation.
```

## Change

- Authentication, middleware, user administration and personnel import use canonical `user_roles`/role codes.
- Migration 0029 validates canonical coverage, increments `authz_version` and revokes old sessions.
- Legacy response labels remain derived presentation fields.
- `users.role` and `users.is_admin` are retained; physical deletion is not authorized before full UAT.

## Verification / green evidence

```text
node --test --test-concurrency=4 test
372 tests: 371 pass, 0 fail, 1 skipped

npm ci && npm run evidence:test -- --work-item "DB Stage 4E clean checkout"
clean checkout: 372 tests, 0 fail; npm audit found 0 vulnerabilities

npm run evidence:verify -- --run-id 435a179b-eb77-4c6b-a71d-fb85f11e9ccb
verified=true; checksum_failures=[]; ndjson_failures=[]; secret_findings=[]

npm run lint
251 files checked; 0 failures

npm run build
passed

npm run stage4e:parity -- --db .tmp/stage4e-validation-20260802.db
CANONICAL_RUNTIME_COMPLETE_COLUMN_CLEANUP_DEFERRED
integrity_check=ok; foreign_key_violations=0; all hard failures=0
```

Fresh database validation applied 29 migrations. Two consecutive startup passes
kept the synthetic administrator at the same `authz_version` (`3`), proving that
canonical startup seeding is idempotent.

## UAT smoke

- Command: `npm run test:webapp`
- UAT RUN_ID: `3a17a632-031f-4cc1-902e-3495a25e6fa6`
- Result: 5/5 synthetic local scenarios passed; evidence verification passed
  with 38 files, 5 traces and 817 request-context events.
- Desktop/mobile routes: `/qlcl/#/admin/users`, `/qlcl/#/admin/roles`,
  `/qlcl/#/admin/personnel-import` and the administration route matrix at
  1440x1024 and 390x844.
- Expected guards/actions: canonical `SYS_ADMIN` can manage roles and personnel;
  a scoring-policy-only account can simulate scoring but cannot publish a
  question template; self-escalation to `SYS_ADMIN` remains blocked.
- Key HTTP evidence: canonical role assignment returned 200
  (`8fe6c24f-46b4-4b1d-adae-f5fda8e2fc03`); unauthorized question publish
  returned 403 (`a30370a9-6804-4d11-902a-7e8646592ea0`).
- Visible actions and guards rendered at both target viewports; scenario
  assertions found no unexpected console or network errors.
- Staging rehearsal and merge remain deferred.

## Decision, blocker and rollback

- Decision: canonical runtime is in scope; physical column cleanup is deferred.
- Blocker: no approved full staging/UAT evidence for deleting compatibility columns.
- Rollback: revert Stage 4E code and migration before deployment; after migration deployment, restore the pre-migration backup because session/authz version changes are intentionally irreversible through down migration.
- Data restore requirement: consistent SQLite backup for any environment rehearsal.

## Safety declaration

- Evidence and fixtures use synthetic identities only.
- No secret, token, cookie, production database, upload or generated report is committed.
