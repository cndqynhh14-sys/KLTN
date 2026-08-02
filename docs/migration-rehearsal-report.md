# Stage 4 migration rehearsal

## Purpose

This repository provides a staging-equivalent rehearsal for migrations 0028 and 0029. It is independent of Railway and uses deterministic synthetic data only. The rehearsal proves the repository-controlled migration, startup, authorization and restore path; it does not claim that a Railway deployment has been exercised.

## Reproducible command

```powershell
npm ci
npm run rehearsal:stage4:uat -- --output-dir artifacts/migration-rehearsal/local
```

The command performs this sequence:

1. Creates a temporary SQLite database by applying migrations through 0027.
2. Seeds representative synthetic RBAC, supplier, evaluation, nonconformity, report and session records.
3. Creates a consistent SQLite backup and records its SHA-256 digest.
4. Copies the backup to a disposable rehearsal database.
5. Applies migrations 0028 and 0029, then invokes the migration runner again to prove there are no pending migrations.
6. Runs Stage 4C, Stage 4D and Stage 4E parity/reconciliation checks without deleting unresolved legacy report exports.
7. Runs `PRAGMA integrity_check` and `PRAGMA foreign_key_check`.
8. Starts the application twice and requires `/health` to return HTTP 200 each time.
9. Verifies that pre-cutover sessions are revoked and a new canonical RBAC session resolves successfully.
10. Runs the synthetic web smoke suite when `--with-uat` is supplied.
11. Restores the pre-migration backup and verifies its checksum, migration ledger and representative row counts.

## Published evidence

Only `report.json` and `report.md` are written to the requested output directory. Temporary databases, WAL/SHM files and synthetic report bytes are deleted with the operating-system temporary workspace. The GitHub Actions workflow rejects database files before uploading the sanitized reports.

The JSON report contains:

- source and target schema fingerprints;
- backup checksum;
- applied migration identifiers and retry result;
- representative row counts before and after migration;
- parity/reconciliation results;
- integrity and foreign-key results;
- two startup health results;
- canonical authorization result;
- backup restore result;
- synthetic UAT status and run identifier.

## GitHub Actions gate

`.github/workflows/migration-rehearsal.yml` runs on manual dispatch and on a pull request to `main` when migration-relevant files change. It installs dependencies with Node.js 20 and `npm ci`, supplies CI-only placeholder configuration, and never connects to Railway or a production database.

## Latest local verification

Verified on 2026-08-02 with Node.js 20 after `npm ci`:

| Check | Result |
|---|---|
| Rehearsal evidence | `d059ec3e-b70a-4e06-9a46-ebdd6becb586` (verified) |
| Full-suite evidence | `72fb2731-6dc0-4a6f-adef-fb5f38c8b106` (verified) |
| Synthetic UAT | PASS, run `15617474-e83b-4cfe-8a9f-babe23fab5e9` |
| Applied migrations | 0028, 0029 |
| Second migration run | 0 pending |
| Integrity check | `ok` |
| Foreign-key violations | 0 |
| Startup health | HTTP 200, HTTP 200 |
| Backup restore | PASS |
| Full test suite | 1,433 tests; 1,429 passed; 0 failed; 4 skipped |

The generated local report is intentionally ignored by Git. GitHub Actions publishes the equivalent sanitized report as a short-lived workflow artifact.

## Limitations

- Synthetic data covers the known Stage 4 migration shapes but cannot reproduce every distribution found in a real deployment.
- Files that cannot be reconciled by report provenance remain unresolved and are never deleted automatically.
- Railway deployment and volume checks remain a separate operational concern and are not prerequisites for this repository-level proof.
