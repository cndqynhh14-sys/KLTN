'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { migrateDatabase } = require('../server/database/migrationRunner');
const { HistoricalEvaluationImporter, classifyHistoricalRound2, finiteScore } = require('../server/services/HistoricalEvaluationImporter');
const { readHistoricalEvaluationWorkbook } = require('../server/services/historicalEvaluationWorkbook');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'migrations');
const EXPECTED_ROUND_1_ONLY = 263;
const EXPECTED_ROUND_2 = 107;

function parseArgs(argv) {
  const options = { commit: false, confirmation: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--commit') options.commit = true;
    else if (arg === '--file') options.file = argv[++index];
    else if (arg === '--db') options.db = argv[++index];
    else if (arg === '--source-id') options.sourceId = argv[++index];
    else if (arg === '--output') options.output = argv[++index];
    else if (arg === '--confirm-live-import') options.confirmation = argv[++index];
    else throw new Error(`unknown_argument:${arg}`);
  }
  if (!options.file) throw new Error('historical_file_required');
  options.file = path.resolve(options.file);
  options.db = path.resolve(options.db || path.join(ROOT, 'data', 'qlcl.db'));
  options.sourceId = options.sourceId || path.basename(options.file, path.extname(options.file));
  options.output = path.resolve(options.output || path.join(ROOT, 'artifacts', 'run34-historical-evaluations', 'dry-run.json'));
  if (options.commit && options.confirmation !== 'RUN34_COMMIT') throw new Error('live_import_confirmation_required');
  return options;
}

function tableCounts(db) {
  const tables = ['supplier_master', 'evaluation_tickets', 'evaluation_rounds', 'evaluation_answers', 'evaluation_nonconformities', 'workflow_history', 'approval_tasks', 'notifications'];
  return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()]));
}

function violationCounts(records) {
  const counts = new Map();
  records.flatMap((record) => record.violations || []).forEach((item) => {
    counts.set(item.group, (counts.get(item.group) || 0) + 1);
  });
  return [...counts.entries()].map(([group, count]) => ({ group, count }))
    .sort((a, b) => b.count - a.count || a.group.localeCompare(b.group, 'vi'));
}

function roundRuleCounts(records) {
  let scoreChanged = 0;
  let reasonOrDateWithoutScoreChange = 0;
  records.forEach((record) => {
    if (!classifyHistoricalRound2(record)) return;
    const score1 = finiteScore(record.scoreRound1);
    const score2 = finiteScore(record.scoreAfterCorrection);
    if (score1 != null && score2 != null && Math.abs(score2 - score1) > 1e-9) scoreChanged += 1;
    else reasonOrDateWithoutScoreChange += 1;
  });
  return { scoreChanged, reasonOrDateWithoutScoreChange };
}

async function backupDatabase(sourcePath, targetPath) {
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(targetPath);
  } finally {
    source.close();
  }
}

function writeReport(outputPath, report) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
}

async function runDryRun(options, workbookData) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-run34-'));
  const clonePath = path.join(tempDir, 'dry-run.db');
  let clone;
  try {
    const live = new Database(options.db, { readonly: true, fileMustExist: true });
    const liveBefore = tableCounts(live);
    const liveMigrationBefore = live.prepare('SELECT migration_id FROM schema_migrations ORDER BY applied_at DESC, migration_id DESC LIMIT 1').pluck().get();
    live.close();
    await backupDatabase(options.db, clonePath);
    clone = new Database(clonePath);
    clone.pragma('foreign_keys = ON');
    migrateDatabase(clone, { migrationsDir: MIGRATIONS_DIR, appVersion: 'RUN-34-DRY-RUN' });
    const importer = new HistoricalEvaluationImporter(clone);
    const importOptions = {
      records: workbookData.records,
      sourceId: options.sourceId,
      sourceFile: path.basename(options.file),
      sourceFileHash: workbookData.sourceFileHash,
    };
    const plan = importer.importRecords({ ...importOptions, commit: false });
    const first = importer.importRecords({ ...importOptions, commit: true });
    const second = importer.importRecords({ ...importOptions, commit: true });
    const cloneCounts = tableCounts(clone);
    const foreignKeyErrors = clone.prepare('PRAGMA foreign_key_check').all().length;
    clone.close();
    clone = null;
    const liveAfterDb = new Database(options.db, { readonly: true, fileMustExist: true });
    const liveAfter = tableCounts(liveAfterDb);
    const liveMigrationAfter = liveAfterDb.prepare('SELECT migration_id FROM schema_migrations ORDER BY applied_at DESC, migration_id DESC LIMIT 1').pluck().get();
    liveAfterDb.close();
    return {
      status: foreignKeyErrors === 0 && second.insertedTickets === 0 && JSON.stringify(liveBefore) === JSON.stringify(liveAfter)
        ? 'PASS'
        : 'FAIL',
      mode: 'DRY_RUN_DATABASE_CLONE',
      source: {
        file: path.basename(options.file),
        sheet: workbookData.sheetName,
        sha256: workbookData.sourceFileHash,
        total_rows: workbookData.totalSourceRows,
        valid_rows: workbookData.validRows,
        invalid_rows: workbookData.invalidRows.length,
      },
      expected: { round_1_only: EXPECTED_ROUND_1_ONLY, round_2: EXPECTED_ROUND_2 },
      planned: {
        mapped_suppliers: plan.mappedSupplierCount,
        unmapped_suppliers: plan.unmappedSupplierCount,
        tickets: plan.ticketCount,
        round_1: plan.round1Count,
        round_1_only: plan.round1OnlyCount,
        round_2: plan.round2Count,
        missing_round_1_score: plan.missingScoreRound1Count,
        round_2_missing_correction_date: plan.round2MissingCorrectionDateCount,
        duplicate_tickets: plan.duplicateCount,
        evaluation_answers: 0,
        nonconformities: workbookData.records.reduce((sum, record) => sum + record.violations.length, 0),
      },
      round_2_reasons: roundRuleCounts(workbookData.records),
      violation_groups: violationCounts(workbookData.records),
      first_import_on_clone: first,
      second_import_on_clone: second,
      clone_counts: cloneCounts,
      foreign_key_errors: foreignKeyErrors,
      live_database: {
        counts_unchanged: JSON.stringify(liveBefore) === JSON.stringify(liveAfter),
        migration_before: liveMigrationBefore,
        migration_after: liveMigrationAfter,
        written: false,
      },
    };
  } finally {
    if (clone) clone.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function runCommit(options, workbookData) {
  const db = new Database(options.db);
  try {
    db.pragma('foreign_keys = ON');
    migrateDatabase(db, { migrationsDir: MIGRATIONS_DIR, appVersion: 'RUN-34-COMMIT' });
    const importer = new HistoricalEvaluationImporter(db);
    return importer.importRecords({
      records: workbookData.records,
      sourceId: options.sourceId,
      sourceFile: path.basename(options.file),
      sourceFileHash: workbookData.sourceFileHash,
      commit: true,
    });
  } finally {
    db.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const workbookData = readHistoricalEvaluationWorkbook(options.file);
  const round2Count = workbookData.records.filter(classifyHistoricalRound2).length;
  const round1OnlyCount = workbookData.records.length - round2Count;
  if (workbookData.invalidRows.length || round1OnlyCount !== EXPECTED_ROUND_1_ONLY || round2Count !== EXPECTED_ROUND_2) {
    const report = {
      status: 'STOPPED_BASELINE_MISMATCH',
      source: {
        file: path.basename(options.file),
        total_rows: workbookData.totalSourceRows,
        valid_rows: workbookData.validRows,
        invalid_rows: workbookData.invalidRows.length,
      },
      expected: { round_1_only: EXPECTED_ROUND_1_ONLY, round_2: EXPECTED_ROUND_2 },
      actual: { round_1_only: round1OnlyCount, round_2: round2Count },
      database_written: false,
    };
    writeReport(options.output, report);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 2;
    return;
  }
  const report = options.commit ? runCommit(options, workbookData) : await runDryRun(options, workbookData);
  writeReport(options.output, report);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  const payload = {
    status: 'ERROR',
    error: error.code || error.message,
    mapping_failures: (error.items || []).map((item) => ({
      source_row: item.sourceRowNumber || null,
      source_stt: item.sourceStt || null,
      supplier_code: item.supplierCode || null,
      code: item.code || null,
    })),
    database_written: false,
  };
  console.error(JSON.stringify(payload, null, 2));
  process.exitCode = 1;
});
