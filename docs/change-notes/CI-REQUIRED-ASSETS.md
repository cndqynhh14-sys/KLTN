# CI-REQUIRED-ASSETS — make clean checkouts reproducible

## Scope

- Work item: Investigate and fix the Stage 3 draft PR CI failure.
- Evidence RUN_ID: red `c8f87d27-7f34-42d8-a49f-4b854eb7526e`; candidate green `62f37c70-718b-48cf-a618-293089b44f49`.
- Branch: `codex/refactor-database-stage3`.
- Commit before: `eeaf0c4dee0465c163158ff48444b22c941be942`.
- Commit after: this commit.
- Decision reference: no domain decision; source-controlled runtime/test assets only.

## Reproduction / red evidence

```text
Node 20.20.2 / npm 10.8.2
npm ci
npm run evidence:test -- --work-item "CI test"
Result: 346 tests, 313 pass, 32 fail, 1 skip, exit 1.
```

The clean PR merge checkout omitted the canonical criteria workbook, report templates,
runtime help guides, release-gate fixtures, generated navigation document, and the
Stage 3 canonical read regression test. The same files existed only as untracked local
files, so the local working tree masked the checkout failure.

## Change

- Changed behavior: clean checkouts receive the assets already required by startup,
  report generation, contextual help, release-gate tests, and Stage 3 regression tests.
- Preserved behavior: no database schema, migration, API, service, repository, frontend,
  scoring, approval, or other Stage 3 business logic changes.
- Migration/API impact: none.
- Changed files: required workbook templates, required Markdown/JSON fixtures,
  `test/stage3CanonicalReads.test.js`, and this note.

## Verification / green evidence

| Command | Exit | Duration | Pass/fail/skip | Evidence path |
|---|---:|---:|---|---|
| `npm ci` | 0 | 8.6 s | install succeeded | clean worktree |
| `npm run evidence:test -- --work-item "CI test"` | 0 | 14.2 s | 348/0/1 (349 total) | `artifacts/dev-runs/62f37c70-718b-48cf-a618-293089b44f49/` |
| `npm run evidence:verify -- --run-id 62f37c70-718b-48cf-a618-293089b44f49` | 0 | — | verified; no checksum, NDJSON, or secret findings | same run |
| `npm run evidence:bundle -- --run-id 62f37c70-718b-48cf-a618-293089b44f49` | 0 | — | bundle created | ignored evidence bundle |

## UAT smoke

Not applicable. This change does not alter UI, authentication, authorization, or navigation behavior.

## Decision, blocker and rollback

- Decision: version the assets that existing runtime and tests already consume.
- Blocker: none after clean-checkout verification.
- Rollback trigger: a committed asset is shown to contain non-template customer data or
  a clean checkout no longer reproduces the expected tests.
- Rollback procedure: revert this CI asset commit; do not alter Stage 3 implementation commits.
- Data restore requirement: none.

## Safety declaration

- [x] Evidence verify passed and wrapper preserved the child exit status.
- [x] Summary re-run command works from a clean checkout with documented prerequisites.
- [x] No chain-of-thought is recorded.
- [x] No secret, OTP, token, cookie, authorization value or real PII is recorded.
- [x] No production DB/WAL/SHM, real upload or generated customer report is included.
- [x] Fixtures and test data are deterministic and synthetic.
