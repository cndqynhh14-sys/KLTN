'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { migrateDatabase, migrationStatus } = require('../server/database/migrationRunner');
const { HistoricalEvaluationImporter, classifyHistoricalRound2 } = require('../server/services/HistoricalEvaluationImporter');
const { readHistoricalEvaluationWorkbook } = require('../server/services/historicalEvaluationWorkbook');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'migrations');
const EXPECTED = Object.freeze({
  sourceHash: 'c13494cc5d7c1efc3180660114b486f64256edbf8c02b6adfa4b661ccf898f7e',
  tickets: 370,
  round1: 370,
  round2: 107,
  round1Only: 263,
  missingRound1Score: 5,
  round2MissingCorrectionDate: 37,
  nonconformities: 832,
});

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--file') options.file = argv[++index];
    else if (arg === '--db') options.db = argv[++index];
    else if (arg === '--source-id') options.sourceId = argv[++index];
    else if (arg === '--backup-dir') options.backupDir = argv[++index];
    else if (arg === '--output') options.output = argv[++index];
    else if (arg === '--confirm') options.confirm = argv[++index];
    else throw new Error(`unknown_argument:${arg}`);
  }
  if (options.confirm !== 'RUN35_COMMIT') throw new Error('run35_confirmation_required');
  if (!options.file) throw new Error('historical_file_required');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    file: path.resolve(options.file),
    db: path.resolve(options.db || path.join(ROOT, 'data', 'qlcl.db')),
    sourceId: options.sourceId || 'DATA_PHIEU_DANH_GIA_NCC',
    backupDir: path.resolve(options.backupDir || path.join(ROOT, 'data', 'backups', 'run35', `run35-${stamp}`)),
    output: path.resolve(options.output || path.join(ROOT, 'artifacts', 'run35-historical-evaluations', 'commit-report.json')),
  };
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function fileManifest(filePath, role) {
  const stats = fs.statSync(filePath);
  return {
    role,
    file: path.basename(filePath),
    bytes: stats.size,
    sha256: sha256(filePath),
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function counts(db) {
  const scalar = (sql, params = []) => Number(db.prepare(sql).pluck().get(...params) || 0);
  return {
    supplier_master: scalar('SELECT COUNT(*) FROM supplier_master'),
    evaluation_tickets: scalar('SELECT COUNT(*) FROM evaluation_tickets'),
    historical_tickets: scalar("SELECT COUNT(*) FROM evaluation_tickets WHERE source_kind='HISTORICAL'"),
    historical_round_1: scalar(`SELECT COUNT(*) FROM evaluation_rounds er JOIN evaluation_tickets t ON t.id=er.ticket_id WHERE t.source_kind='HISTORICAL' AND er.round_no=1`),
    historical_round_2: scalar(`SELECT COUNT(*) FROM evaluation_rounds er JOIN evaluation_tickets t ON t.id=er.ticket_id WHERE t.source_kind='HISTORICAL' AND er.round_no=2`),
    historical_nonconformities: scalar(`SELECT COUNT(*) FROM evaluation_nonconformities nc JOIN evaluation_tickets t ON t.id=nc.ticket_id WHERE t.source_kind='HISTORICAL'`),
    historical_answers: scalar(`SELECT COUNT(*) FROM evaluation_answers a JOIN evaluation_rounds er ON er.id=a.round_id JOIN evaluation_tickets t ON t.id=er.ticket_id WHERE t.source_kind='HISTORICAL'`),
    workflow_history: scalar('SELECT COUNT(*) FROM workflow_history'),
    approval_tasks: scalar('SELECT COUNT(*) FROM approval_tasks'),
    notifications: scalar('SELECT COUNT(*) FROM notifications'),
  };
}

function latestMigration(db) {
  return db.prepare('SELECT migration_id FROM schema_migrations ORDER BY migration_id DESC LIMIT 1').pluck().get();
}

function assertPreflight(db, workbook) {
  migrationStatus(db, { migrationsDir: MIGRATIONS_DIR });
  const migration = latestMigration(db);
  if (!['0033', '0034', '0035'].includes(migration)) throw new Error(`unexpected_migration:${migration}`);
  const before = counts(db);
  if (before.evaluation_tickets !== 0
    || before.historical_round_1 !== 0
    || before.historical_round_2 !== 0
    || before.historical_nonconformities !== 0
    || before.historical_answers !== 0) {
    throw new Error('evaluation_data_not_empty');
  }
  const round2 = workbook.records.filter(classifyHistoricalRound2).length;
  const nonconformities = workbook.records.reduce((total, row) => total + row.violations.length, 0);
  const actual = {
    sourceHash: workbook.sourceFileHash,
    tickets: workbook.records.length,
    round1: workbook.records.length,
    round2,
    round1Only: workbook.records.length - round2,
    missingRound1Score: workbook.records.filter((row) => row.scoreRound1 == null).length,
    round2MissingCorrectionDate: workbook.records.filter((row) => classifyHistoricalRound2(row) && !row.correctionDate).length,
    nonconformities,
    invalidRows: workbook.invalidRows.length,
  };
  const mismatches = Object.entries(EXPECTED).filter(([key, value]) => actual[key] !== value);
  if (actual.invalidRows || mismatches.length) {
    const error = new Error('run35_baseline_mismatch');
    error.details = { actual, mismatches };
    throw error;
  }
  return { migration, before, actual };
}

async function createBackup(options, preflight, workbook) {
  fs.mkdirSync(options.backupDir, { recursive: true });
  const files = [];
  const rawTargets = [
    [options.db, 'database_raw'],
    [`${options.db}-wal`, 'wal_raw'],
    [`${options.db}-shm`, 'shm_raw'],
  ];
  for (const [source, role] of rawTargets) {
    if (!fs.existsSync(source)) continue;
    const target = path.join(options.backupDir, path.basename(source));
    fs.copyFileSync(source, target);
    files.push(fileManifest(target, role));
  }
  const consistentPath = path.join(options.backupDir, 'qlcl-consistent.db');
  const source = new Database(options.db, { readonly: true, fileMustExist: true });
  try {
    await source.backup(consistentPath);
  } finally {
    source.close();
  }
  files.push(fileManifest(consistentPath, 'database_consistent'));
  const manifest = {
    run: 'RUN-35',
    created_at: new Date().toISOString(),
    database: options.db,
    migration_before: preflight.migration,
    counts_before: preflight.before,
    source: {
      file: path.basename(options.file),
      bytes: fs.statSync(options.file).size,
      sha256: workbook.sourceFileHash,
    },
    files,
  };
  const manifestPath = path.join(options.backupDir, 'backup-manifest.json');
  writeJson(manifestPath, manifest);
  return { manifest, manifestPath, consistentPath };
}

function verifyCommitted(db) {
  const after = counts(db);
  const invalidSupplierLinks = Number(db.prepare(`
    SELECT COUNT(*) FROM evaluation_tickets t
    LEFT JOIN supplier_master sm ON sm.id=t.supplier_id
    WHERE t.source_kind='HISTORICAL' AND sm.id IS NULL
  `).pluck().get());
  const fkErrors = db.pragma('foreign_key_check');
  const integrity = db.pragma('integrity_check').map((row) => Object.values(row)[0]);
  const checks = {
    tickets: after.historical_tickets === EXPECTED.tickets,
    round1: after.historical_round_1 === EXPECTED.round1,
    round2: after.historical_round_2 === EXPECTED.round2,
    nonconformities: after.historical_nonconformities === EXPECTED.nonconformities,
    answers: after.historical_answers === 0,
    suppliers: invalidSupplierLinks === 0,
    foreignKeys: fkErrors.length === 0,
    integrity: integrity.length === 1 && integrity[0] === 'ok',
  };
  if (Object.values(checks).some((value) => !value)) {
    const error = new Error('run35_post_commit_verification_failed');
    error.details = { after, invalidSupplierLinks, foreignKeyErrors: fkErrors.length, integrity, checks };
    throw error;
  }
  return { after, invalidSupplierLinks, foreignKeyErrors: fkErrors.length, integrity, checks };
}

function restoreBackup(options, backup) {
  for (const sidecar of [`${options.db}-wal`, `${options.db}-shm`]) {
    if (fs.existsSync(sidecar)) fs.rmSync(sidecar, { force: true });
  }
  fs.copyFileSync(backup.consistentPath, options.db);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const workbook = readHistoricalEvaluationWorkbook(options.file);
  let db = new Database(options.db, { readonly: true, fileMustExist: true });
  let preflight;
  try {
    preflight = assertPreflight(db, workbook);
  } finally {
    db.close();
  }
  const backup = await createBackup(options, preflight, workbook);
  let report;
  try {
    db = new Database(options.db);
    db.pragma('foreign_keys = ON');
    migrateDatabase(db, { migrationsDir: MIGRATIONS_DIR, appVersion: 'RUN-35-COMMIT' });
    const importer = new HistoricalEvaluationImporter(db);
    const importOptions = {
      records: workbook.records,
      sourceId: options.sourceId,
      sourceFile: path.basename(options.file),
      sourceFileHash: workbook.sourceFileHash,
    };
    const firstImport = importer.importRecords({ ...importOptions, commit: true });
    const verification = verifyCommitted(db);
    const secondImport = importer.importRecords({ ...importOptions, commit: true });
    if (secondImport.insertedTickets || secondImport.insertedRounds
      || secondImport.insertedNonconformities || secondImport.insertedParticipants
      || secondImport.duplicateCount !== EXPECTED.tickets) {
      throw new Error('run35_idempotency_verification_failed');
    }
    report = {
      run: 'RUN-35',
      status: 'COMMITTED',
      committed_at: new Date().toISOString(),
      source: { file: path.basename(options.file), sha256: workbook.sourceFileHash },
      migration_before: preflight.migration,
      migration_after: latestMigration(db),
      before: preflight.before,
      first_import: firstImport,
      after: verification.after,
      supplier_link_errors: verification.invalidSupplierLinks,
      foreign_key_errors: verification.foreignKeyErrors,
      integrity_check: verification.integrity,
      idempotency_second_import: secondImport,
      backup_manifest: backup.manifestPath,
      rollback_performed: false,
    };
    db.close();
    db = null;
  } catch (error) {
    if (db) {
      db.close();
      db = null;
    }
    restoreBackup(options, backup);
    report = {
      run: 'RUN-35',
      status: 'ROLLED_BACK',
      failed_at: new Date().toISOString(),
      error: error.message,
      details: error.details || null,
      backup_manifest: backup.manifestPath,
      rollback_performed: true,
    };
    writeJson(options.output, report);
    console.error(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }
  writeJson(options.output, report);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ run: 'RUN-35', status: 'FAILED_PRECOMMIT', error: error.message, details: error.details || null }, null, 2));
  process.exitCode = 1;
});
