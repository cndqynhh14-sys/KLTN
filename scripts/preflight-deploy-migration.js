'use strict';

require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { APP_ROOT, DATA_DIR, DB_PATH, MIGRATIONS_DIR } = require('../server/config/paths');
const { migrationStatus } = require('../server/database/migrationRunner');

function parseArgs(argv) {
  const valueAfter = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : null;
  };
  return {
    dbPath: path.resolve(valueAfter('--db') || DB_PATH),
    backupDir: path.resolve(valueAfter('--backup-dir') || path.join(DATA_DIR, 'deploy-backups')),
  };
}

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function verifyDatabase(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const integrityRows = db.pragma('integrity_check');
    const integrityOk = integrityRows.length === 1 && Object.values(integrityRows[0])[0] === 'ok';
    const foreignKeysOk = db.pragma('foreign_key_check').length === 0;
    if (!integrityOk || !foreignKeysOk) throw new Error('database_backup_verification_failed');
    return { integrityOk, foreignKeysOk };
  } finally {
    db.close();
  }
}

async function createVerifiedBackup(sourcePath, backupDir) {
  if (!fs.existsSync(sourcePath)) throw new Error('source_database_not_found');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const suffix = crypto.randomBytes(4).toString('hex');
  const backupPath = path.join(backupDir, `qlcl-predeploy-${stamp}-${suffix}.db`);
  const partialPath = `${backupPath}.partial`;
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(partialPath);
  } finally {
    source.close();
  }
  try {
    verifyDatabase(partialPath);
    fs.renameSync(partialPath, backupPath);
    return backupPath;
  } finally {
    if (fs.existsSync(partialPath)) fs.rmSync(partialPath, { force: true });
  }
}

function runMigrationBootstrap(preflightDbPath, preflightDir) {
  const dbModulePath = path.join(APP_ROOT, 'server', 'db.js');
  const bootstrap = [
    `const mod = require(${JSON.stringify(dbModulePath)});`,
    "mod.db.pragma('wal_checkpoint(TRUNCATE)');",
    'mod.db.close();',
  ].join(' ');
  const child = spawnSync(process.execPath, ['-e', bootstrap], {
    cwd: APP_ROOT,
    env: {
      ADMIN_EMAILS: '',
      AUTHZ_ALLOW_LEGACY_SESSION: 'false',
      DATA_DIR: preflightDir,
      DB_PATH: preflightDbPath,
      EMAIL_MODE: 'console',
      HOME: process.env.HOME || '',
      NODE_ENV: 'deployment-preflight',
      PATH: process.env.PATH || '',
      SystemRoot: process.env.SystemRoot || '',
      TEMP: process.env.TEMP || '',
      TMP: process.env.TMP || '',
      USE_IN_MEMORY_OTP: 'true',
    },
    encoding: 'utf8',
    timeout: 180000,
    windowsHide: true,
  });
  if (child.status !== 0) {
    const error = new Error('migration_preflight_failed');
    error.exitCode = child.status;
    throw error;
  }
}

async function runDeployPreflight({ dbPath, backupDir }) {
  const backupPath = await createVerifiedBackup(dbPath, backupDir);
  const preflightDir = fs.mkdtempSync(path.join(backupDir, '.preflight-'));
  const preflightDbPath = path.join(preflightDir, 'qlcl-preflight.db');
  try {
    fs.copyFileSync(backupPath, preflightDbPath, fs.constants.COPYFILE_EXCL);
    runMigrationBootstrap(preflightDbPath, preflightDir);
    const verification = verifyDatabase(preflightDbPath);
    const migrated = new Database(preflightDbPath, { readonly: true, fileMustExist: true });
    try {
      const status = migrationStatus(migrated, { migrationsDir: MIGRATIONS_DIR });
      if (!status.length || status.some((row) => row.state !== 'applied')) {
        throw new Error('migration_preflight_incomplete');
      }
      return {
        verified: true,
        backup_path: backupPath,
        integrity_check: verification.integrityOk,
        foreign_key_check: verification.foreignKeysOk,
        migration_ids: status.map((row) => row.id),
      };
    } finally {
      migrated.close();
    }
  } finally {
    if (!isInside(backupDir, preflightDir)) throw new Error('unsafe_preflight_cleanup_path');
    fs.rmSync(preflightDir, { recursive: true, force: true });
  }
}

async function main() {
  const result = await runDeployPreflight(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: error.message, exit_code: error.exitCode ?? null })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  createVerifiedBackup,
  isInside,
  parseArgs,
  runDeployPreflight,
  verifyDatabase,
};
