# SECURITY-DEPENDENCY-REMEDIATION — remove known npm vulnerabilities

## Scope

- Work item: Dependency security remediation after database Stage 4B
- Red evidence RUN_ID: `ff292565-a489-45d4-a25a-53d4272b7e64`
- Green evidence RUN_ID: `13a92469-c759-4788-ab81-45451f9b1ddf`
- Branch: `codex/security-dependency-remediation`
- Commit before: `cfdee6b04322d746c23f96cb77b463afd9e27236`
- Commit after: Not committed by this work item
- Decision reference: npm advisory output and upstream package release metadata

## Reproduction / red evidence

```text
npm audit --json
Exit status: 1
Known vulnerabilities: body-parser 1.20.5 (low), nodemailer 6.9.16 (high),
postcss 8.5.15 (high), xlsx 0.18.5 (high).
```

## Change

- Changed behavior: patched vulnerable dependency versions; loaded SheetJS from its official pinned distribution; hardened SMTP transport and message validation against file/URL access and header injection.
- Preserved behavior: authentication/OTP email delivery, spreadsheet import/export, web application behavior, and database schema remain unchanged.
- Migration/API impact: none. No migration, database file, route contract, or frontend contract changed.
- Changed files: `package.json`, `package-lock.json`, `server/services/email.js`, `test/dependencySecurityRemediation.test.js`, and this change note.

## Verification / green evidence

| Command | Exit | Duration | Pass/fail/skip | Evidence path |
|---|---:|---:|---|---|
| `npm ci` | 0 | — | 0 known vulnerabilities | — |
| `npm audit --json` | 0 | — | 0 total vulnerabilities | — |
| `npm run test:security` | 0 | — | 53/0/0 | — |
| focused email and spreadsheet tests | 0 | — | 63/0/0 | `artifacts/dev-runs/cb627a02-2ed2-47f4-ba43-7548459374a9/` |
| `npm run build` | 0 | — | passed | — |
| `npm run lint` | 0 | — | 245 files, 0 failures | — |
| `npm run evidence:test -- --work-item "Dependency security remediation"` | 0 | 34.6 s | 1056/0/3 (1059 total) | `artifacts/dev-runs/13a92469-c759-4788-ab81-45451f9b1ddf/` |
| `npm run test:webapp` | 0 | 34.1 s | 5/0/0 scenarios | `artifacts/uat-runs/308ccd22-0059-40b1-a07e-bf3d8aaa5367/` |

Evidence verification passed. Bundle SHA-256: `a9ea32b74cd2a28cfa3488193e0fbf3c959a0840cf208be86336cd669cbc8722`.

## UAT smoke

- UAT_RUN_ID: `308ccd22-0059-40b1-a07e-bf3d8aaa5367`
- Request ID: recorded per scenario in redacted `safe-trace.ndjson`
- Synthetic actor/role: deterministic local synthetic administrator and authorization fixtures
- Desktop/mobile route: login and current administrative route matrix at 1440×1024 and 390×844
- Expected backend/frontend guard: authentication and authorization guards continue to allow valid synthetic access and reject self-escalation
- Expected visible navigation/action: current core administrative routes and actions remain available
- HTTP/UI result: all 5 scenarios passed
- Console/network errors: none reported by the UAT harness

## Decision, blocker and rollback

- Decision: ready for review; do not combine with database Stage 4C.
- Blocker: none.
- Rollback trigger: mail delivery, spreadsheet processing, or clean-install regression discovered during review or staging smoke.
- Rollback procedure: revert only the five files listed above, run `npm ci`, then re-run audit, focused tests, full evidence tests, and UAT.
- Data restore requirement: none; this change does not modify schema or data.

## Safety declaration

- [x] Evidence verify passed and wrapper preserved the child exit status.
- [x] Summary re-run command works from a clean dependency install using Node.js 20.
- [x] No chain-of-thought is recorded.
- [x] No secret, OTP, token, cookie, authorization value or real PII is recorded.
- [x] No production DB/WAL/SHM, real upload or generated customer report is included.
- [x] Fixtures and UAT data are deterministic and synthetic.
