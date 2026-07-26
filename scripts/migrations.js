'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { DB_PATH, MIGRATIONS_DIR } = require('../server/config/paths');
const { migrationStatus } = require('../server/database/migrationRunner');

function parseArgs(argv) {
  const command = argv[0] || 'status';
  const dbIndex = argv.indexOf('--db');
  return {
    command,
    dbPath: dbIndex >= 0 && argv[dbIndex + 1] ? path.resolve(argv[dbIndex + 1]) : DB_PATH,
  };
}

function main() {
  const { command, dbPath } = parseArgs(process.argv.slice(2));
  if (!['status', 'dry-run'].includes(command)) {
    process.stderr.write('Usage: node scripts/migrations.js <status|dry-run> [--db PATH]\n');
    process.exitCode = 2;
    return;
  }

  const exists = fs.existsSync(dbPath);
  const db = exists
    ? new Database(dbPath, { readonly: true, fileMustExist: true })
    : new Database(':memory:');
  try {
    const rows = migrationStatus(db, { migrationsDir: MIGRATIONS_DIR });
    const output = {
      command,
      database_exists: exists,
      ledger_exists: exists && !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get(),
      pending_count: rows.filter((row) => row.state === 'pending').length,
      applied_count: rows.filter((row) => row.state === 'applied').length,
      migrations: rows,
      mutated: false,
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    db.close();
  }
}

main();
