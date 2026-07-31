# DB-STAGE2-CANONICAL — additive canonical schema bridges

## Scope

- Work item: `DB-STAGE2-CANONICAL`
- Evidence RUN_ID: `b639387e-9468-40a1-bec7-1ef146920123` (final full suite); supporting run IDs are listed below.
- Branch: `audit/system-review`
- Commit before: `d890f7668ee307eaa6ef0458a74ec2a29260fdaf`
- Commit after: not committed by this work item
- Decision reference: Stage 2 additive migration; keep every legacy table and column.

## Reproduction / red evidence

```text
npm.cmd run evidence:run -- --work-item "DB-STAGE2-CANONICAL" -- node --test test/stage2CanonicalSchema.test.js
Public failure before implementation: migrations 0020 through 0025 and the canonical bridge schema were missing.
Evidence: artifacts/dev-runs/4e9ec5b6-c72f-4a89-ac34-50a11cd12d0b/
```

## Change

- Changed behavior: added canonical participants, question-item answer links, nonconformity/remediation links, RBAC backfill, report provenance backfill, and snapshot/scoring parity bridges.
- Changed behavior: legacy `Lead miền` and `GĐK` labels are backfilled to their stable RBAC role codes with UTF-8-safe literals.
- Changed behavior: repositories and evaluation routes dual-write canonical fields while retaining legacy fields.
- Preserved behavior: no legacy table or column is dropped; report rows without deterministic provenance remain untouched.
- Migration/API impact: migrations `0020`–`0025` are forward-only and additive; no public API contract was removed.
- Changed files: migrations `0020`–`0025`; evaluation participant/answer/round/ticket/corrective-action repositories; evaluation ticket service and route; parity script; migration and evaluation tests.

## Verification / green evidence

| Command | Exit | Result | Evidence path |
|---|---:|---|---|
| Focused Stage 2 and retained-feature tests | 0 | 48/48 passed | `artifacts/dev-runs/7e7d714b-b23c-49b2-a298-c387b4c1eacc/` |
| Full `npm test` through evidence wrapper | 0 | 345 passed, 1 web E2E skipped by design | `artifacts/dev-runs/b639387e-9468-40a1-bec7-1ef146920123/` |
| Corrected migration rehearsal | 0 | 0020–0025 applied once; second normal bootstrap is a no-op | `artifacts/dev-runs/65ac0e16-f16a-4d51-8199-8e21f70aaf12/`, `artifacts/dev-runs/9c0ca62c-171a-46c7-bdd9-4d2701b6d0f5/` |
| Corrected rehearsal parity | 0 | PASS; integrity `ok`, FK 0, hard failures 0 | `artifacts/dev-runs/673f457c-5cea-4576-943b-c97c2a9c06cf/` |
| Local migration after verified restore | 0 | 25 applied, 0 pending, integrity `ok`, FK 0 | `artifacts/dev-runs/4bf13f07-10a2-47b6-b3f7-022bb0f6873e/` |
| Two consecutive local server startups | 0 | `/health` returned `ok` twice | `artifacts/dev-runs/979eb994-fc58-4fb5-bf5d-cabc1eaa7004/` |
| Final local parity check | 0 | PASS; every hard-failure count is 0 | `artifacts/dev-runs/77473914-860f-4188-a9f4-209365516a36/` |
| `npm run lint` | 0 | 239 checked, 0 failures | `artifacts/dev-runs/53ca65dd-3b6e-463a-87e8-0863974ed0b3/` |
| `npm run build` | 0 | CSS build passed | `artifacts/dev-runs/31ff35e7-107a-4abb-94cb-1f156242dca9/` |
| `npm run test:webapp` | 0 | 5/5 UAT scenarios passed after corrected local migration | `artifacts/dev-runs/d583bf4c-40e1-48bc-b318-8d4be4c51888/` |

## UAT smoke

- UAT_RUN_ID: `3d7d96e4-3fc8-4293-b7bd-7eb2d2ae24e4`
- Request ID: generated and retained only in the redacted UAT safe trace
- Synthetic actor/role: local synthetic administrator
- Desktop/mobile route: evaluation-only core route and administration route matrix
- Expected backend/frontend guard: authenticated synthetic admin receives only authorized routes and actions
- Expected visible navigation/action: evaluation, supplier, question, report, scoring, and administration surfaces remain reachable
- HTTP/UI result: passed 5/5 scenarios
- Console/network errors: none reported

## Decision, blocker and rollback

- Decision: Stage 2 is safe for local and test rehearsal; staging and production remain out of scope.
- Blocker: 78 legacy report exports have no deterministic job/artifact provenance and are deferred rather than guessed.
- Rollback trigger: parity hard failure, integrity/FK failure, migration ledger mismatch, or retained-feature regression.
- Rollback procedure: stop the local writer, preserve the failed database, restore the verified pre-migration backup, then redeploy the pre-Stage-2 application code.
- Data restore requirement: use `artifacts/dev-runs/15533e1e-17ed-48eb-a336-07d6e2a12f0c/stage2/backups/qlcl-predeploy-20260731171056-0a89b2aa.db`; do not down-migrate the additive schema in place.

## Safety declaration

- [x] Evidence verify passed and wrapper preserved the child exit status.
- [x] Summary re-run commands work with the documented local prerequisites.
- [x] No chain-of-thought is recorded.
- [x] No secret, OTP, token, cookie, authorization value or real PII is recorded.
- [x] No production DB/WAL/SHM, real upload or generated customer report is included.
- [x] Fixtures and UAT data are deterministic and synthetic.
