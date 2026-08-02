# DB Stage 5 — verified legacy cleanup

## Scope and decision

- Baseline commit: `b925d2c` on `main`.
- Migration: `0030_remove_legacy_user_authorization.sql`.
- Authorization source of truth: `users`, `user_roles`, `roles`, `permissions`, `role_permissions` and `authz_version`.
- Decision: remove only `users.role` and `users.is_admin`; defer report-storage cleanup that cannot be proven lossless.
- Baseline evidence RUN_ID: `b2875b96-d71e-4eac-8b15-fc78f8a7e7d2`.
- Red evidence RUN_ID: `03784d15-53e6-4180-a8a8-6908c29e4748`.
- Green evidence RUN_ID: `b932af26-775c-4c8c-bd59-5ba97311d3fa`.

## Read-only inventory and decision matrix

| Candidate | Consumers/data check | Decision | Evidence |
|---|---|---|---|
| `users.role` | Runtime SQL is canonical; all 12 local users have canonical role history | Remove | Migration 0029 applied in rehearsal before 0030; Stage 5 guard requires complete role coverage |
| `users.is_admin` | All six historical admin flags map to active `SYS_ADMIN` assignments | Remove | Migration guard aborts if any historical administrator lacks canonical `SYS_ADMIN` |
| Pre-cutover sessions | 0029 increments `authz_version` and revokes sessions | Retain session table; remove legacy authorization columns | 0030 aborts if a session issued before 0029 remains live |
| Legacy report provenance/storage | 81 local exports; 78 have neither `job_id` nor `artifact_id` | Deferred | No file/link is guessed, deleted, or represented by a fabricated artifact |
| Historical forward-repair adapter in `server/db.js` | Required to upgrade pre-ledger databases before numbered migrations | Retained | It is not executed during a normal ledger-backed startup |
| Historical migration fixtures | Required to test upgrades from schemas before 0030 | Retained | Legacy writes are isolated to bounded historical test setup |

## Migration behavior

Migration 0030 is transactional and fails closed unless:

- migration 0029 is recorded;
- every account has canonical role history;
- every active account has an effective active role;
- every historical active administrator has `SYS_ADMIN`;
- no pre-0029 session remains live.

SQLite `ALTER TABLE ... DROP COLUMN` removes the two columns while preserving the
`users` primary key and incoming foreign keys. The migration records the cleanup
decision in `authz_change_log`. It does not modify report rows or report files.

## Rehearsal and rollback

The repository rehearsal now creates representative data at 0027, upgrades its
source database through 0029, takes a consistent backup, and applies only 0030 to
the rehearsal copy. It verifies retry idempotency, two startups, authentication,
row-count parity, `integrity_check`, `foreign_key_check`, and backup restore. The
sanitized report publishes no database bytes.

The local existing-database rehearsal ran against a consistent temporary backup
of the database whose ledger ended at 0028. It applied 0029 and 0030, then a
second migration pass found zero pending work. Counts were identical before and
after for all selected retained tables: 12 users, 12 role assignments, 19
suppliers, 835 question items, 36 tickets, 53 rounds, 1,658 answers, 321
nonconformities, 25 approval tasks and 81 report exports. The result was
`PASS_WITH_REPORT_PROVENANCE_DEFERRED`; `integrity_check` returned `ok` and
`foreign_key_check` returned zero rows. The source database was opened read-only
and was not migrated.

## Verification

| Command | Result |
|---|---|
| `npm test` | 377 tests; 376 pass, 0 fail, 1 intentional E2E skip |
| `npm run evidence:test -- --work-item "DB Stage 5 verified cleanup"` | PASS; RUN_ID `b932af26-775c-4c8c-bd59-5ba97311d3fa` |
| `npm run evidence:verify -- --run-id b932af26-775c-4c8c-bd59-5ba97311d3fa` | Verified; no checksum, NDJSON, or secret findings |
| `npm run rehearsal:stage5:uat` | PASS; applied 0030 only; startup HTTP 200 twice; UAT RUN_ID `d1d114ec-48b6-4a46-81ed-d1871a932bb7` |
| `npm run rehearsal:stage5:database-copy -- --db data/qlcl.db` | PASS on temporary backup; applied 0029 and 0030; row-count parity true |
| `npm run lint` | 258 files checked; 0 failures |
| `npm run build` | PASS |

Both rehearsal paths returned `integrity_check=ok` and zero foreign-key
violations. No rehearsal database bytes are part of the publishable evidence.

Rollback is backup-based. Before applying 0030 to an environment, take and verify
a consistent SQLite backup. If migration, parity, startup, UAT, integrity, or FK
checks fail, stop deployment and restore that backup; do not reconstruct legacy
role values from display labels and do not alter historical migration files.

## Safety boundary

- No production or staging database is accessed by repository rehearsal.
- No database, WAL, SHM, secret, token, OTP, upload, or real report is committed.
- Unresolved report exports remain queryable and are explicitly deferred.
- Migration 0031 is not created because report provenance is not at 100%.
