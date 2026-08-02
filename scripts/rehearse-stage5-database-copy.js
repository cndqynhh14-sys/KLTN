'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { DB_PATH, MIGRATIONS_DIR } = require('../server/config/paths');
const { migrateDatabase } = require('../server/database/migrationRunner');
const { runParity } = require('./check-stage5-parity');

const TABLES = Object.freeze([
  'users', 'user_roles', 'supplier_master', 'question_templates', 'question_items',
  'evaluation_tickets', 'evaluation_rounds', 'evaluation_answers',
  'evaluation_nonconformities', 'approval_tasks', 'report_exports',
]);

function parseArgs(argv) {
  const index = argv.indexOf('--db');
  return { dbPath: path.resolve(index >= 0 && argv[index + 1] ? argv[index + 1] : DB_PATH) };
}

function counts(db) {
  return Object.fromEntries(TABLES.map((table) => [
    table, Number(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()),
  ]));
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function rehearseDatabaseCopy(dbPath) {
  if (!fs.existsSync(dbPath)) throw new Error('source_database_not_found');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-stage5-existing-'));
  const copyPath = path.join(workspace, 'rehearsal.db');
  try {
    const source = new Database(dbPath, { readonly: true, fileMustExist: true });
    let before;
    try {
      before = {
        last_migration_id: source.prepare('SELECT migration_id FROM schema_migrations ORDER BY migration_id DESC LIMIT 1').pluck().get(),
        counts: counts(source),
        integrity_check: source.pragma('integrity_check', { simple: true }),
        foreign_key_violations: source.pragma('foreign_key_check').length,
      };
      await source.backup(copyPath);
    } finally {
      source.close();
    }

    const backupChecksum = sha256(copyPath);
    const rehearsal = new Database(copyPath);
    rehearsal.pragma('foreign_keys = ON');
    let result;
    try {
      const migrated = migrateDatabase(rehearsal, { migrationsDir: MIGRATIONS_DIR, appVersion: 'stage5-existing-copy' });
      const retry = migrateDatabase(rehearsal, { migrationsDir: MIGRATIONS_DIR, appVersion: 'stage5-existing-copy-retry' });
      const afterCounts = counts(rehearsal);
      const parity = runParity(rehearsal);
      const appliedIds = migrated.results.filter((item) => item.state === 'applied').map((item) => item.id);
      const retryPending = retry.results.filter((item) => item.state !== 'already-applied').length;
      const rowCountParity = JSON.stringify(before.counts) === JSON.stringify(afterCounts);
      const pass = before.integrity_check === 'ok'
        && before.foreign_key_violations === 0
        && rowCountParity
        && retryPending === 0
        && parity.status !== 'FAIL';
      result = {
        status: pass ? 'PASS' : 'FAIL',
        source_last_migration_id: before.last_migration_id,
        backup_sha256: backupChecksum,
        applied_migration_ids: appliedIds,
        retry_pending_count: retryPending,
        row_count_parity: rowCountParity,
        before_counts: before.counts,
        after_counts: afterCounts,
        parity,
      };
    } finally {
      rehearsal.close();
    }
    return result;
  } finally {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(workspace));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('unsafe_rehearsal_cleanup_path');
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

async function main() {
  const result = await rehearseDatabaseCopy(parseArgs(process.argv.slice(2)).dbPath);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== 'PASS') process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { counts, parseArgs, rehearseDatabaseCopy, sha256 };
