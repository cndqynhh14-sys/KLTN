'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  DATA_DIR,
  DB_PATH,
  ATTACHMENT_DIR,
  REPORT_EXPORT_DIR,
} = require('../server/config/paths');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_EVIDENCE_ROOT = path.join(ROOT, 'artifacts', 'run31-cleanup');
const DEFAULT_BACKUP_ROOT = path.join(DATA_DIR, 'backups', 'run31');

const DELETE_ORDER = Object.freeze([
  'report_artifact_events',
  'report_exports',
  'report_artifacts',
  'report_source_snapshots',
  'report_export_jobs',
  'approval_tasks',
  'notifications',
  'workflow_history',
  'correction_extensions',
  'evaluation_nonconformities',
  'evaluation_attachments',
  'evaluation_participants',
  'evaluation_answers',
  'evaluation_rounds',
  'evaluation_tickets',
  'supplier_master_history',
  'supplier_master',
  'supplier_import_batches',
]);

const KEEP_GROUPS = Object.freeze({
  security_compliance: Object.freeze([
    'access_log', 'audit_events', 'audit_retention_policies',
  ]),
  identity_authorization: Object.freeze([
    'users', 'auth_sessions', 'roles', 'permissions', 'role_permissions',
    'user_roles', 'user_scope_assignments', 'authz_change_log',
    'authz_scope_review_queue', 'usage_acknowledgements',
  ]),
  master_data: Object.freeze([
    'master_data_catalogs', 'merchandise_hierarchy',
  ]),
  question_configuration: Object.freeze([
    'question_templates', 'question_template_versions', 'question_items',
    'question_template_variants', 'question_template_assignments',
    'question_template_version_events', 'question_import_batches',
    'question_import_rows', 'question_import_changes', 'question_import_events',
    'question_version_reconciliations',
  ]),
  scoring_configuration: Object.freeze([
    'scoring_policies', 'scoring_policy_versions', 'scoring_policy_assignments',
    'scoring_policy_version_events', 'scoring_policy_reconciliations',
  ]),
  workflow_configuration: Object.freeze([
    'approval_stage_assignments', 'custom_scope_schemas', 'org_units',
  ]),
  report_configuration: Object.freeze([
    'report_definitions', 'report_templates', 'report_template_versions',
    'report_template_assignments', 'report_template_version_events',
    'report_legacy_migration_review', 'report_legacy_template_links',
  ]),
  administration_configuration: Object.freeze([
    'personnel_import_batches', 'schema_migrations',
  ]),
});

const KEEP_TABLES = new Set(Object.values(KEEP_GROUPS).flat());
const DELETE_TABLES = new Set(DELETE_ORDER);

function parseArgs(argv) {
  const valueAfter = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : null;
  };
  return {
    execute: argv.includes('--execute'),
    dbPath: path.resolve(valueAfter('--db') || DB_PATH),
    evidenceRoot: path.resolve(valueAfter('--evidence-dir') || DEFAULT_EVIDENCE_ROOT),
    backupRoot: path.resolve(valueAfter('--backup-dir') || DEFAULT_BACKUP_ROOT),
    skipFiles: argv.includes('--skip-files'),
  };
}

function assertSafeIdentifier(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`unsafe_identifier:${value}`);
  return value;
}

function quoteIdentifier(value) {
  return `"${assertSafeIdentifier(value)}"`;
}

function listTables(db) {
  return db.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map((row) => row.name);
}

function tableExists(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

function tableCount(db, table) {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdentifier(table)}`).get().n);
}

function tableCounts(db, tables) {
  return Object.fromEntries(tables.filter((table) => tableExists(db, table)).map((table) => [table, tableCount(db, table)]));
}

function tableFingerprint(db, table) {
  const rows = db.prepare(`SELECT * FROM ${quoteIdentifier(table)} ORDER BY rowid`).all();
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function keepFingerprints(db, tables) {
  return Object.fromEntries(tables.filter((table) => tableExists(db, table)).map((table) => [table, {
    count: tableCount(db, table),
    sha256: tableFingerprint(db, table),
  }]));
}

function schemaFingerprint(db) {
  const schema = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all();
  return crypto.createHash('sha256').update(JSON.stringify(schema)).digest('hex');
}

function tableClassification(table) {
  if (DELETE_TABLES.has(table)) return { decision: 'DELETE', group: 'ncc_evaluation_business_data' };
  for (const [group, tables] of Object.entries(KEEP_GROUPS)) {
    if (tables.includes(table)) return { decision: 'KEEP', group };
  }
  return { decision: 'KEEP', group: 'conservative_unclassified' };
}

function collectDependencyAudit(db) {
  const tables = listTables(db);
  const dependencies = tables.map((table) => ({
    table,
    count: tableCount(db, table),
    ...tableClassification(table),
    foreign_keys: db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).all().map((row) => ({
      from: row.from,
      to_table: row.table,
      to: row.to,
      on_update: row.on_update,
      on_delete: row.on_delete,
    })),
  }));
  const unsafeReferences = dependencies.flatMap((entry) => entry.foreign_keys
    .filter((foreignKey) => DELETE_TABLES.has(foreignKey.to_table) && !DELETE_TABLES.has(entry.table))
    .map((foreignKey) => ({ table: entry.table, ...foreignKey })));
  return {
    schema_table_count: tables.length,
    delete_order: DELETE_ORDER,
    keep_groups: KEEP_GROUPS,
    dependencies,
    conservative_keep: dependencies.filter((entry) => entry.group === 'conservative_unclassified').map((entry) => entry.table),
    unsafe_references: unsafeReferences,
  };
}

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function timestampId() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) files.push(target);
    }
  };
  visit(root);
  return files.sort();
}

function fileHash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function validateFileRoots(fileRoots) {
  return fileRoots.map((root) => {
    const resolved = path.resolve(root);
    if (!isInside(DATA_DIR, resolved)) throw new Error(`cleanup_root_outside_data_dir:${resolved}`);
    return resolved;
  });
}

function backupBusinessFiles(fileRoots, backupDirectory) {
  const manifest = [];
  for (const root of validateFileRoots(fileRoots)) {
    const rootName = path.basename(root);
    for (const filePath of walkFiles(root)) {
      const relative = path.relative(root, filePath);
      const destination = path.join(backupDirectory, 'files', rootName, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(filePath, destination);
      manifest.push({ root: rootName, relative_path: relative, size_bytes: fs.statSync(filePath).size, sha256: fileHash(filePath) });
    }
  }
  return manifest;
}

function removeEmptyChildren(root, directory = root) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    removeEmptyChildren(root, path.join(directory, entry.name));
  }
  if (directory !== root && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
}

function cleanupBusinessFiles(fileRoots) {
  let removed = 0;
  for (const root of validateFileRoots(fileRoots)) {
    for (const filePath of walkFiles(root)) {
      fs.unlinkSync(filePath);
      removed += 1;
    }
    removeEmptyChildren(root);
  }
  return { removed, remaining: fileRoots.reduce((sum, root) => sum + walkFiles(root).length, 0) };
}

function defaultFileRoots(dbPath, skipFiles) {
  if (skipFiles || path.resolve(dbPath) !== path.resolve(DB_PATH)) return [];
  return [ATTACHMENT_DIR, REPORT_EXPORT_DIR, path.resolve(`${DB_PATH}.report-artifacts`)];
}

function validateDeleteClosure(audit) {
  if (audit.unsafe_references.length) {
    throw new Error(`cleanup_dependency_review_required:${JSON.stringify(audit.unsafe_references)}`);
  }
  const missing = DELETE_ORDER.filter((table) => !audit.dependencies.some((entry) => entry.table === table));
  if (missing.length) throw new Error(`cleanup_expected_tables_missing:${missing.join(',')}`);
}

function deleteBusinessData(db) {
  const statements = DELETE_ORDER.map((table) => db.prepare(`DELETE FROM ${quoteIdentifier(table)}`));
  const maintenanceTriggers = db.prepare(`SELECT name, sql FROM sqlite_master
    WHERE type='trigger' AND tbl_name IN (${DELETE_ORDER.map(() => '?').join(',')})
      AND lower(sql) LIKE '%before delete%'
    ORDER BY name`).all(...DELETE_ORDER);
  if (maintenanceTriggers.some((trigger) => !trigger.sql)) throw new Error('cleanup_trigger_definition_missing');
  db.transaction(() => {
    for (const trigger of maintenanceTriggers) db.exec(`DROP TRIGGER ${quoteIdentifier(trigger.name)}`);
    for (const statement of statements) statement.run();
    for (const trigger of maintenanceTriggers) db.exec(trigger.sql);
  })();
}

function verifyDatabase(db, keepBefore, schemaBefore) {
  const businessCounts = tableCounts(db, DELETE_ORDER);
  const keepAfter = keepFingerprints(db, Object.keys(keepBefore));
  const changedKeepTables = Object.keys(keepBefore).filter((table) => JSON.stringify(keepBefore[table]) !== JSON.stringify(keepAfter[table]));
  const foreignKeyViolations = db.pragma('foreign_key_check');
  const integrity = db.pragma('integrity_check', { simple: true });
  return {
    business_counts: businessCounts,
    all_business_zero: Object.values(businessCounts).every((count) => count === 0),
    keep_fingerprints: keepAfter,
    changed_keep_tables: changedKeepTables,
    foreign_key_violations: foreignKeyViolations.length,
    integrity_check: integrity,
    schema_fingerprint_before: schemaBefore,
    schema_fingerprint_after: schemaFingerprint(db),
    pass: Object.values(businessCounts).every((count) => count === 0)
      && changedKeepTables.length === 0
      && foreignKeyViolations.length === 0
      && integrity === 'ok'
      && schemaBefore === schemaFingerprint(db),
  };
}

async function backupDatabase(db, backupPath, expectedCounts) {
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  if (fs.existsSync(backupPath)) throw new Error(`backup_already_exists:${backupPath}`);
  await db.backup(backupPath);
  const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    const result = {
      path: backupPath,
      size_bytes: fs.statSync(backupPath).size,
      sha256: fileHash(backupPath),
      integrity_check: backup.pragma('integrity_check', { simple: true }),
      foreign_key_violations: backup.pragma('foreign_key_check').length,
      business_counts: tableCounts(backup, DELETE_ORDER),
    };
    result.counts_match = JSON.stringify(result.business_counts) === JSON.stringify(expectedCounts);
    result.pass = result.integrity_check === 'ok' && result.foreign_key_violations === 0 && result.counts_match;
    if (!result.pass) throw new Error(`backup_verification_failed:${JSON.stringify(result)}`);
    return result;
  } finally {
    backup.close();
  }
}

async function runCleanup(options = {}) {
  const dbPath = path.resolve(options.dbPath || DB_PATH);
  const evidenceRoot = path.resolve(options.evidenceRoot || DEFAULT_EVIDENCE_ROOT);
  const backupRoot = path.resolve(options.backupRoot || DEFAULT_BACKUP_ROOT);
  const runId = options.runId || `run31-${timestampId()}`;
  const evidenceDirectory = path.join(evidenceRoot, runId);
  const backupDirectory = path.join(backupRoot, runId);
  const backupPath = path.join(backupDirectory, 'qlcl-pre-cleanup.db');
  const fileRoots = options.fileRoots || defaultFileRoots(dbPath, options.skipFiles);
  if (!fs.existsSync(dbPath)) throw new Error(`database_not_found:${dbPath}`);

  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma('foreign_keys = ON');
  try {
    const audit = collectDependencyAudit(db);
    validateDeleteClosure(audit);
    const beforeCounts = tableCounts(db, DELETE_ORDER);
    const keepTables = audit.dependencies.filter((entry) => entry.decision === 'KEEP').map((entry) => entry.table);
    const keepBefore = keepFingerprints(db, keepTables);
    const schemaBefore = schemaFingerprint(db);
    const backup = await backupDatabase(db, backupPath, beforeCounts);
    const fileManifest = backupBusinessFiles(fileRoots, backupDirectory);

    writeJson(path.join(evidenceDirectory, 'dependency-audit.json'), audit);
    writeJson(path.join(evidenceDirectory, 'pre-cleanup-counts.json'), {
      database: dbPath,
      business_counts: beforeCounts,
      keep_fingerprints: keepBefore,
      schema_fingerprint: schemaBefore,
      file_count: fileManifest.length,
    });
    writeJson(path.join(evidenceDirectory, 'backup-verification.json'), backup);
    writeJson(path.join(evidenceDirectory, 'business-file-backup-manifest.json'), fileManifest);

    deleteBusinessData(db);
    const verification = verifyDatabase(db, keepBefore, schemaBefore);
    const fileCleanup = cleanupBusinessFiles(fileRoots);
    verification.files = fileCleanup;
    verification.pass = verification.pass && fileCleanup.remaining === 0;
    writeJson(path.join(evidenceDirectory, 'post-cleanup-verification.json'), verification);
    if (!verification.pass) throw new Error(`post_cleanup_verification_failed:${JSON.stringify(verification)}`);

    return {
      status: 'PASS',
      run_id: runId,
      database: dbPath,
      backup: backupPath,
      evidence_directory: evidenceDirectory,
      before_counts: beforeCounts,
      after_counts: verification.business_counts,
      master_configuration_changed: verification.changed_keep_tables,
      foreign_key_violations: verification.foreign_key_violations,
      integrity_check: verification.integrity_check,
      files_backed_up: fileManifest.length,
      files_removed: fileCleanup.removed,
    };
  } finally {
    db.close();
  }
}

function auditOnly(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return collectDependencyAudit(db);
  } finally {
    db.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.execute) {
    process.stdout.write(`${JSON.stringify({ mode: 'AUDIT_ONLY', database: options.dbPath, ...auditOnly(options.dbPath) }, null, 2)}\n`);
    return;
  }
  const result = await runCleanup(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: 'FAIL', error: error.message })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DELETE_ORDER,
  KEEP_GROUPS,
  auditOnly,
  collectDependencyAudit,
  parseArgs,
  runCleanup,
  tableClassification,
};
