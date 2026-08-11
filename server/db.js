// SQLite connection + prepared statements for QLCL.
// DB file auto-created at the runtime data path; versioned migrations are the
// schema authority and run before data-only application defaults.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const packageInfo = require('../package.json');
const { DB_PATH, MIGRATIONS_DIR, DEFAULT_SEED_PATH } = require('./config/paths');
const { migrateDatabase } = require('./database/migrationRunner');
const { ROLES } = require('./domain/roles');
const { ROLE_CODES } = require('./authorization/permissionCatalog');
const { seedCriteriaWorkbook, verifyCriteriaSeedSource } = require('./services/criteriaImporter');
const { QuestionVersionService } = require('./services/QuestionVersionService');
const { ensureDefaultReportTemplates, REPORT_TYPE_CODES } = require('./services/reporting');
const ReportTemplateVersionRepository = require('./reporting/ReportTemplateVersionRepository');
const { LegacyReportTemplateMigration } = require('./reporting/LegacyReportTemplateMigration');
const { AuthorizationService } = require('./services/AuthorizationService');
const { ApprovalAssignmentService } = require('./services/ApprovalAssignmentService');
const { PolicyService } = require('./services/PolicyService');
const { AuditEventService } = require('./services/AuditEventService');
const { mapLegacyAccessAction } = require('./audit/compatibilityMap');
const logger = require('./logger');
const { sanitizeAccessDetails, sanitizeAccessText } = require('./observability/accessLog');

const db = new Database(DB_PATH, { readonly: false });
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const NOTIFICATION_TYPE_CODES = [
  'REJECTED',
  'APPROVED',
  'REASSESSMENT_DUE',
  'EVALUATION_ASSIGNED',
  'EVALUATION_APPROVAL_ASSIGNED',
  'EVALUATION_APPROVED',
  'EVALUATION_REJECTED',
  'EVALUATION_DEADLINE',
  'SYSTEM_MAINTENANCE',
  'SYSTEM_INCIDENT',
];

// Aliased to avoid confusion with shell exec — this is better-sqlite3's batch
// SQL runner (accepts multi-statement text; no parameter binding).
const runBatchSql = db.exec.bind(db);
let authorizationService;
const QUESTION_SEED_MANIFEST_PATH = path.resolve(__dirname, '..', 'database', 'seeds', 'question-criteria-source.json');
let questionSeedReadiness = { status: 'degraded', code: 'question_seed_not_checked' };

function executeCompatibilitySteps(steps) {
  for (const [name, execute] of steps) {
    try {
      execute();
    } catch (error) {
      error.message = `[compatibility:${name}] ${error.message}`;
      throw error;
    }
  }
}

// Used only by controlled migration repair for historical databases. It is not
// part of the normal evaluation-only boot adapter.
function runLegacyForwardRepairCompatibilityAdapter(schema) {
  executeCompatibilitySteps([
    ['baselineCreateIfMissing', () => runBatchSql(schema)],
    ['ensureUserRoleColumn', ensureUserRoleColumn],
    ['ensureSupplierMasterColumns', ensureSupplierMasterColumns],
    ['ensureSupplierHistoryTable', ensureSupplierHistoryTable],
    ['normalizeLegacySupplierTechnicalReferences', normalizeLegacySupplierTechnicalReferences],
    ['ensureEvaluationTicketColumns', ensureEvaluationTicketColumns],
    ['ensureEvaluationRoundColumns', ensureEvaluationRoundColumns],
    ['ensureCorrectiveActionColumns', ensureCorrectiveActionColumns],
    ['ensureEvaluationNonconformitiesTable', ensureEvaluationNonconformitiesTable],
    ['ensureCorrectionExtensionsTable', ensureCorrectionExtensionsTable],
    ['ensureNotificationsTable', ensureNotificationsTable],
    ['ensureReportExportColumns', ensureReportExportColumns],
    ['ensureReportTypeConstraints', ensureReportTypeConstraints],
    ['ensureReportArtifactExportColumns', ensureReportArtifactExportColumns],
    ['ensureQuestionTemplates', ensureQuestionTemplates],
    ['ensureDoc3Criteria', ensureDoc3Criteria],
    ['ensureQuestionTemplateVersions', ensureQuestionTemplateVersions],
    ['ensureDefaultReportTemplates', () => ensureDefaultReportTemplates(db)],
    ['ensureCanonicalReportTemplateVersions', () => new ReportTemplateVersionRepository(db).ensureCanonicalDefinitions()],
    ['ensureLegacyReportMigrationReview', () => new LegacyReportTemplateMigration({ db }).syncReviewQueue()],
  ]);
}

function runStartupDataSeeds() {
  executeCompatibilitySteps([
    ['ensureQuestionTemplates', ensureQuestionTemplates],
    ['ensureDoc3Criteria', ensureDoc3Criteria],
    ['ensureQuestionTemplateVersions', ensureQuestionTemplateVersions],
    ['ensureDefaultReportTemplates', () => ensureDefaultReportTemplates(db)],
    ['ensureCanonicalReportTemplateVersions', () => new ReportTemplateVersionRepository(db).ensureCanonicalDefinitions()],
    ['ensureLegacyReportMigrationReview', () => new LegacyReportTemplateMigration({ db }).syncReviewQueue()],
  ]);
}

function initSchema() {
  const seed = fs.readFileSync(DEFAULT_SEED_PATH, 'utf-8');
  migrateDatabase(db, {
    migrationsDir: MIGRATIONS_DIR,
    appVersion: packageInfo.version,
    baselineId: '0001',
    forwardRepair: ({ migration }) => runLegacyForwardRepairCompatibilityAdapter(migration.sql),
  });

  // Application defaults are data-only. Numbered migrations are the sole
  // schema authority during normal startup.
  runBatchSql(seed);
  runStartupDataSeeds();

  // Seed admin users from env on every boot. New env additions auto-provision;
  // removals leave the user in place (admin must demote via /admin/users).
  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const upsertAdmin = db.prepare(
    `INSERT INTO users (email, is_active, created_by)
     VALUES (?, 1, 'seed')
     ON CONFLICT(email) DO UPDATE SET is_active = 1`
  );
  for (const e of adminEmails) upsertAdmin.run(e);

  authorizationService = new AuthorizationService(db);
  for (const e of adminEmails) {
    authorizationService.setPrimaryRole({
      userId: e,
      roleCode: ROLE_CODES.SYS_ADMIN,
      actor: null,
      source: 'MIGRATION',
    });
  }
}

function ensureDoc3Criteria() {
  try {
    if (!fs.existsSync(QUESTION_SEED_MANIFEST_PATH)) {
      questionSeedReadiness = { status: 'degraded', code: 'question_seed_manifest_missing' };
      logger.warn('question.seed.readiness_degraded', { reason: questionSeedReadiness.code });
      return;
    }
    const manifest = JSON.parse(fs.readFileSync(QUESTION_SEED_MANIFEST_PATH, 'utf8'));
    if (manifest.mode !== 'INSERT_ONLY_EMPTY_DATABASE') {
      questionSeedReadiness = { status: 'degraded', code: 'question_seed_mode_invalid' };
      logger.warn('question.seed.readiness_degraded', { reason: questionSeedReadiness.code });
      return;
    }
    const sourcePath = path.resolve(__dirname, '..', manifest.source || '');
    questionSeedReadiness = {
      ...verifyCriteriaSeedSource(sourcePath, manifest.sha256),
      mode: manifest.mode,
      schema_version: manifest.schema_version,
      source: manifest.source,
    };
    if (questionSeedReadiness.status !== 'ready') {
      logger.warn('question.seed.readiness_degraded', {
        reason: questionSeedReadiness.code,
        expected_sha256: questionSeedReadiness.expected_sha256,
        actual_sha256: questionSeedReadiness.actual_sha256,
      });
      return;
    }
    const published = tableExists('question_template_versions')
      ? db.prepare("SELECT COUNT(*) AS n FROM question_template_versions WHERE status IN ('PUBLISHED', 'RETIRED')").get().n
      : 0;
    const existingQuestions = tableExists('question_items')
      ? db.prepare('SELECT COUNT(*) AS n FROM question_items').get().n
      : 0;
    if (published > 0 || existingQuestions > 0) return;
    const seeded = seedCriteriaWorkbook(db, sourcePath, { expectedChecksum: manifest.sha256 });
    questionSeedReadiness = {
      ...questionSeedReadiness,
      code: 'question_seed_applied',
      imported_rows: seeded.imported,
    };
  } catch (error) {
    questionSeedReadiness = { status: 'degraded', code: error.code || 'question_seed_failed' };
    logger.warn('question.seed.readiness_degraded', { reason: questionSeedReadiness.code });
  }
}

function ensureUserRoleColumn() {
  const cols = db.prepare("PRAGMA table_info('users')").all().map((row) => row.name);
  if (!cols.includes('role')) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'Chuyên viên'");
  }
  db.prepare("UPDATE users SET role = ? WHERE is_admin = 1 AND (role IS NULL OR role = '' OR role = ?)").run(ROLES.ADMIN, ROLES.SPECIALIST);
  db.prepare("UPDATE users SET role = ? WHERE role IS NULL OR role = ''").run(ROLES.SPECIALIST);
}

function ensureSupplierMasterColumns() {
  const cols = db.prepare("PRAGMA table_info('supplier_master')").all().map((row) => row.name);
  const add = (name, type) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE supplier_master ADD COLUMN ${name} ${type}`);
  };
  add('production_address', 'TEXT');
  add('evaluation_address', 'TEXT');
  add('linked_facility_code', 'TEXT');
  add('linked_facility_name', 'TEXT');
  add('linked_facility_address', 'TEXT');
  add('linked_facility_type', 'TEXT');
  add('region', 'TEXT');
  add('province', 'TEXT');
  add('business_type', 'TEXT');
  add('cmc_owner', 'TEXT');
  add('cmc_head', 'TEXT');
  add('business_license_file', 'TEXT');
  add('attp_certificate_type', 'TEXT');
  add('attp_certificate_file', 'TEXT');
}

function ensureSupplierHistoryTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS supplier_master_history (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id     INTEGER,
      supplier_code   TEXT NOT NULL,
      actor_user_id   TEXT,
      action          TEXT NOT NULL,
      comment         TEXT,
      field_name      TEXT,
      previous_value  TEXT,
      new_value       TEXT,
      payload_json    TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (supplier_id) REFERENCES supplier_master(id) ON DELETE SET NULL,
      FOREIGN KEY (actor_user_id) REFERENCES users(email) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_supplier_master_history_code_time ON supplier_master_history(supplier_code, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_supplier_master_history_supplier_time ON supplier_master_history(supplier_id, created_at DESC, id DESC);
  `);
}

function normalizeLegacySupplierTechnicalReferences() {
  if (!tableExists('supplier_master')) return;
  db.exec(`
    UPDATE supplier_master
    SET source_type = 'MANUAL'
    WHERE source_type NOT IN ('EXCEL_UPLOAD', 'MANUAL') OR source_type IS NULL;

    UPDATE supplier_master
    SET import_batch_id = NULL
    WHERE import_batch_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM supplier_import_batches b WHERE b.id = supplier_master.import_batch_id);

    UPDATE supplier_master
    SET created_by = NULL
    WHERE created_by IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.email = supplier_master.created_by);

    UPDATE supplier_master
    SET updated_by = NULL
    WHERE updated_by IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.email = supplier_master.updated_by);
  `);
}

function ensureEvaluationTicketColumns() {
  const cols = db.prepare("PRAGMA table_info('evaluation_tickets')").all().map((row) => row.name);
  const add = (name, type) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE evaluation_tickets ADD COLUMN ${name} ${type}`);
  };
  add('supplier_code', 'TEXT');
  add('supplier_name', 'TEXT');
  add('tax_code', 'TEXT');
  add('supplier_address', 'TEXT');
  add('production_address', 'TEXT');
  add('evaluation_address', 'TEXT');
  add('linked_facility_code', 'TEXT');
  add('linked_facility_name', 'TEXT');
  add('linked_facility_address', 'TEXT');
  add('linked_facility_type', 'TEXT');
  add('region', 'TEXT');
  add('province', 'TEXT');
  add('business_type', 'TEXT');
  add('cmc_owner', 'TEXT');
  add('cmc_head', 'TEXT');
  add('business_license_file', 'TEXT');
  add('attp_certificate_type', 'TEXT');
  add('attp_certificate_file', 'TEXT');
  add('contact_name', 'TEXT');
  add('contact_email', 'TEXT');
  add('contact_phone', 'TEXT');
  add('mch2', 'TEXT');
  add('mch3', 'TEXT');
  add('product_group', 'TEXT');
  add('product_name', 'TEXT');
  add('evaluation_method', 'TEXT');
  add('evaluator_name', 'TEXT');
  add('qa_lead_id', 'TEXT');
  add('qa_support_ids', 'TEXT');
  add('evaluation_department', 'TEXT');
  add('planned_date', 'TEXT');
  add('actual_evaluation_date', 'TEXT');
  add('score_percent', 'REAL');
  add('grade_code', 'TEXT');
  add('result_label', 'TEXT');
  add('result_reason', 'TEXT');
  add('corrected_score_percent', 'REAL');
  add('corrected_grade_code', 'TEXT');
  add('corrected_result_label', 'TEXT');
  add('correction_date', 'TEXT');
  add('next_evaluation_date', 'TEXT');
  add('final_conclusion', 'TEXT');
  add('specialist_proposal', 'TEXT');
  add('supplier_introduction', 'TEXT');
  add('scoring_locked', 'INTEGER NOT NULL DEFAULT 0');
  add('completed_round', 'INTEGER NOT NULL DEFAULT 1');
  add('is_deleted', 'INTEGER NOT NULL DEFAULT 0');
  add('deleted_at', 'TEXT');
  add('deleted_by', 'TEXT');
  add('deleted_reason', 'TEXT');
  add('cancelled_reason', 'TEXT');
  add('cancelled_by', 'TEXT');
  add('cancelled_at', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_eval_tickets_deleted_status ON evaluation_tickets(is_deleted, current_status)');
}

function tableColumns(tableName) {
  return db.prepare(`PRAGMA table_info('${tableName}')`).all().map((row) => row.name);
}

function tableExists(tableName) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
}

function ensureQuestionTemplateVersions() {
  if (!tableExists('question_template_versions')) return;
  const reconciliation = new QuestionVersionService(db).ensureCanonicalV1();
  if (reconciliation.status !== 'CLEAN') {
    const error = new Error('question_version_reconciliation_failed');
    error.reconciliation_id = reconciliation.id;
    throw error;
  }
}

function runForeignKeySafeSchemaChange(change) {
  if (db.inTransaction) {
    change();
    return;
  }
  const foreignKeysEnabled = db.pragma('foreign_keys', { simple: true });
  if (foreignKeysEnabled) db.pragma('foreign_keys = OFF');
  try {
    db.transaction(change)();
  } finally {
    db.pragma(`foreign_keys = ${foreignKeysEnabled ? 'ON' : 'OFF'}`);
  }
}

function ensureCorrectiveActionColumns() {
  const cols = db.prepare("PRAGMA table_info('corrective_actions')").all().map((row) => row.name);
  if (!cols.includes('responsible_party')) {
    db.exec('ALTER TABLE corrective_actions ADD COLUMN responsible_party TEXT');
  }
  if (!cols.includes('evidence_attachment_id')) db.exec('ALTER TABLE corrective_actions ADD COLUMN evidence_attachment_id INTEGER');
  if (!cols.includes('created_by')) db.exec('ALTER TABLE corrective_actions ADD COLUMN created_by TEXT');
  if (!cols.includes('updated_by')) db.exec('ALTER TABLE corrective_actions ADD COLUMN updated_by TEXT');
  if (!cols.includes('updated_at')) db.exec('ALTER TABLE corrective_actions ADD COLUMN updated_at TEXT');
}

function ensureEvaluationRoundColumns() {
  const cols = db.prepare("PRAGMA table_info('evaluation_rounds')").all().map((row) => row.name);
  const add = (name, type) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE evaluation_rounds ADD COLUMN ${name} ${type}`);
  };
  add('assessment_code', 'TEXT');
  add('assessment_date', 'TEXT');
  add('evaluator_id', 'TEXT');
  add('attendees_json', 'TEXT');
  add('source_round_id', 'INTEGER');
  add('correction_locked', 'INTEGER NOT NULL DEFAULT 0');
  db.exec(`
    UPDATE evaluation_rounds
    SET source_round_id = (
      SELECT source.id
      FROM evaluation_rounds source
      WHERE source.ticket_id = evaluation_rounds.ticket_id
        AND source.round_no = 1
    )
    WHERE round_no = 2
      AND source_round_id IS NULL
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_eval_rounds_assessment_code ON evaluation_rounds(assessment_code)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_eval_rounds_source ON evaluation_rounds(source_round_id)');
}

function ensureEvaluationNonconformitiesTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS evaluation_nonconformities (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id              INTEGER NOT NULL,
      round_id               INTEGER,
      question_id            INTEGER,
      clause_code            TEXT,
      category               TEXT,
      nonconformity          TEXT NOT NULL,
      remediation            TEXT,
      due_date               TEXT,
      severity               TEXT,
      status                 TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
      corrective_action_id   INTEGER,
      created_at             TEXT NOT NULL DEFAULT (datetime('now')),
      created_by             TEXT,
      updated_at             TEXT,
      updated_by             TEXT,
      FOREIGN KEY (ticket_id) REFERENCES evaluation_tickets(id) ON DELETE CASCADE,
      FOREIGN KEY (round_id) REFERENCES evaluation_rounds(id) ON DELETE SET NULL,
      FOREIGN KEY (question_id) REFERENCES evaluation_questions(id) ON DELETE SET NULL,
      FOREIGN KEY (corrective_action_id) REFERENCES corrective_actions(id) ON DELETE SET NULL,
      FOREIGN KEY (created_by) REFERENCES users(email) ON DELETE SET NULL,
      FOREIGN KEY (updated_by) REFERENCES users(email) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_eval_nonconformities_ticket ON evaluation_nonconformities(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_eval_nonconformities_round ON evaluation_nonconformities(round_id);
    CREATE INDEX IF NOT EXISTS idx_eval_nonconformities_status_due ON evaluation_nonconformities(status, due_date);
  `);
}

function ensureCorrectionExtensionsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS correction_extensions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id        INTEGER NOT NULL,
      extension_no     INTEGER NOT NULL,
      old_due_date     TEXT,
      new_due_date     TEXT NOT NULL,
      reason           TEXT NOT NULL,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      created_by       TEXT,
      FOREIGN KEY (ticket_id) REFERENCES evaluation_tickets(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(email) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_correction_extensions_ticket ON correction_extensions(ticket_id, extension_no);
  `);
}

function ensureNotificationsTable() {
  const allowed = NOTIFICATION_TYPE_CODES.map((code) => `'${code}'`).join(', ');
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      receiver_user_id   TEXT NOT NULL,
      sender_user_id     TEXT,
      ticket_id          INTEGER,
      notification_type  TEXT NOT NULL CHECK (notification_type IN (${allowed})),
      title              TEXT,
      message            TEXT NOT NULL,
      payload_json       TEXT,
      unique_key         TEXT,
      is_read            INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
      read_at            TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (receiver_user_id) REFERENCES users(email) ON DELETE CASCADE,
      FOREIGN KEY (sender_user_id) REFERENCES users(email) ON DELETE SET NULL,
      FOREIGN KEY (ticket_id) REFERENCES evaluation_tickets(id) ON DELETE CASCADE,
      UNIQUE (unique_key)
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_receiver_read_time ON notifications(receiver_user_id, is_read, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notifications_ticket ON notifications(ticket_id, created_at DESC);
  `);
  const cols = db.prepare("PRAGMA table_info('notifications')").all().map((row) => row.name);
  const add = (name, type) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE notifications ADD COLUMN ${name} ${type}`);
  };
  add('title', 'TEXT');
  add('payload_json', 'TEXT');
  add('unique_key', 'TEXT');
  add('read_at', 'TEXT');
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notifications'").get();
  const sql = row?.sql || '';
  const needsTypeUpgrade = NOTIFICATION_TYPE_CODES.some((code) => !sql.includes(`'${code}'`));
  if (needsTypeUpgrade) {
    runForeignKeySafeSchemaChange(() => {
      db.exec(`
        CREATE TABLE notifications_new (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          receiver_user_id   TEXT NOT NULL,
          sender_user_id     TEXT,
          ticket_id          INTEGER,
          notification_type  TEXT NOT NULL CHECK (notification_type IN (${allowed})),
          title              TEXT,
          message            TEXT NOT NULL,
          payload_json       TEXT,
          unique_key         TEXT,
          is_read            INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
          read_at            TEXT,
          created_at         TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (receiver_user_id) REFERENCES users(email) ON DELETE CASCADE,
          FOREIGN KEY (sender_user_id) REFERENCES users(email) ON DELETE SET NULL,
          FOREIGN KEY (ticket_id) REFERENCES evaluation_tickets(id) ON DELETE CASCADE,
          UNIQUE (unique_key)
        );
        INSERT INTO notifications_new (
          id, receiver_user_id, sender_user_id, ticket_id, notification_type,
          title, message, payload_json, unique_key, is_read, read_at, created_at
        )
        SELECT id, receiver_user_id, sender_user_id, ticket_id, notification_type,
               title, message, payload_json, unique_key, is_read, read_at, created_at
        FROM notifications;
        DROP TABLE notifications;
        ALTER TABLE notifications_new RENAME TO notifications;
      `);
    });
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_notifications_receiver_read_time ON notifications(receiver_user_id, is_read, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notifications_ticket ON notifications(ticket_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_unique_key ON notifications(unique_key);
  `);
}

function ensureReportExportColumns() {
  const cols = db.prepare("PRAGMA table_info('report_exports')").all().map((row) => row.name);
  const add = (name, type) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE report_exports ADD COLUMN ${name} ${type}`);
  };
  add('round_id', 'INTEGER');
  add('file_format', "TEXT NOT NULL DEFAULT 'PDF'");
  add('export_scope', "TEXT NOT NULL DEFAULT 'TICKET'");
  db.exec('CREATE INDEX IF NOT EXISTS idx_report_exports_round ON report_exports(round_id)');
}

function reportTypeConstraintNeedsUpgrade(tableName) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
  const sql = row?.sql || '';
  return sql.includes('report_type') && REPORT_TYPE_CODES.some((code) => !sql.includes(`'${code}'`));
}

function ensureReportTypeConstraints() {
  const upgradeTemplates = reportTypeConstraintNeedsUpgrade('report_templates');
  const upgradeExports = reportTypeConstraintNeedsUpgrade('report_exports');
  if (!upgradeTemplates && !upgradeExports) return;

  const allowed = REPORT_TYPE_CODES.map((code) => `'${code}'`).join(', ');
  runForeignKeySafeSchemaChange(() => {
    if (upgradeTemplates) {
      db.exec(`
        CREATE TABLE report_templates_new (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          template_name TEXT NOT NULL,
          report_type   TEXT NOT NULL CHECK (report_type IN (${allowed})),
          template_body TEXT NOT NULL,
          active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
          created_at    TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at    TEXT,
          UNIQUE (template_name, report_type)
        );
        INSERT INTO report_templates_new (id, template_name, report_type, template_body, active, created_at, updated_at)
        SELECT id, template_name, report_type, template_body, active, created_at, updated_at
        FROM report_templates;
        DROP TABLE report_templates;
        ALTER TABLE report_templates_new RENAME TO report_templates;
        CREATE INDEX IF NOT EXISTS idx_report_templates_type_active ON report_templates(report_type, active);
      `);
    }
    if (upgradeExports) {
      db.exec(`
        CREATE TABLE report_exports_new (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          ticket_id          INTEGER NOT NULL,
          round_id           INTEGER,
          report_template_id INTEGER,
          report_type        TEXT NOT NULL CHECK (report_type IN (${allowed})),
          file_format        TEXT NOT NULL DEFAULT 'PDF',
          export_scope       TEXT NOT NULL DEFAULT 'TICKET',
          file_path          TEXT NOT NULL,
          exported_by        TEXT,
          exported_at        TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (ticket_id) REFERENCES evaluation_tickets(id) ON DELETE CASCADE,
          FOREIGN KEY (round_id) REFERENCES evaluation_rounds(id) ON DELETE SET NULL,
          FOREIGN KEY (report_template_id) REFERENCES report_templates(id) ON DELETE SET NULL,
          FOREIGN KEY (exported_by) REFERENCES users(email) ON DELETE SET NULL
        );
        INSERT INTO report_exports_new (
          id, ticket_id, round_id, report_template_id, report_type, file_format,
          export_scope, file_path, exported_by, exported_at
        )
        SELECT id, ticket_id, round_id, report_template_id, report_type, file_format,
               export_scope, file_path, exported_by, exported_at
        FROM report_exports;
        DROP TABLE report_exports;
        ALTER TABLE report_exports_new RENAME TO report_exports;
        CREATE INDEX IF NOT EXISTS idx_report_exports_ticket ON report_exports(ticket_id);
        CREATE INDEX IF NOT EXISTS idx_report_exports_type_time ON report_exports(report_type, exported_at DESC);
        CREATE INDEX IF NOT EXISTS idx_report_exports_round ON report_exports(round_id);
      `);
    }
  });
}

function ensureReportArtifactExportColumns() {
  if (!tableExists('report_export_jobs') || !tableExists('report_artifacts')) return;
  const cols = db.prepare("PRAGMA table_info('report_exports')").all().map((row) => row.name);
  const add = (name, type) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE report_exports ADD COLUMN ${name} ${type}`);
  };
  add('report_template_version_id', 'INTEGER REFERENCES report_template_versions(id) ON DELETE SET NULL');
  add('definition_code', 'TEXT REFERENCES report_definitions(definition_code)');
  add('context_checksum', 'TEXT');
  add('component_checksum', 'TEXT');
  add('scoring_compatibility_marker', 'TEXT');
  add('job_id', 'TEXT REFERENCES report_export_jobs(id) ON DELETE SET NULL');
  add('artifact_id', 'INTEGER REFERENCES report_artifacts(id) ON DELETE SET NULL');
  add('availability_status', "TEXT NOT NULL DEFAULT 'LEGACY_UNASSESSED'");
  add('legacy_reconciliation_status', "TEXT NOT NULL DEFAULT 'UNASSESSED'");
  add('is_regenerated', 'INTEGER NOT NULL DEFAULT 0');
  add('legacy_source', 'TEXT');
  add('legacy_alias_version', 'TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_report_exports_template_version
      ON report_exports(report_template_version_id, exported_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_report_exports_job
      ON report_exports(job_id) WHERE job_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_report_exports_artifact
      ON report_exports(artifact_id) WHERE artifact_id IS NOT NULL;
  `);
}

function ensureQuestionTemplates() {
  const insert = db.prepare(`
    INSERT INTO question_templates (template_code, template_name, description, active)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(template_code) DO NOTHING
  `);
  insert.run('BM01', 'BM01: Rau củ quả, trái cây', 'Rau củ quả, trái cây');
  insert.run('BM02', 'BM02: Thịt', 'Thịt');
  insert.run('BM03', 'BM03: Thủy hải sản', 'Thủy hải sản');
  insert.run('BM04', 'BM04: Thực phẩm sơ chế, chế biến', 'Thực phẩm sơ chế, chế biến');
}

initSchema();
const approvalAssignmentService = new ApprovalAssignmentService(db, authorizationService);
const policyService = new PolicyService(authorizationService, approvalAssignmentService);
const auditEventService = new AuditEventService(db);
authorizationService.setAuditEventService(auditEventService);

// Prepared statements — created once, reused per request.
const stmts = {
  // ---- Auth ----
  getUser: db.prepare('SELECT email, is_active, display_name, authz_version FROM users WHERE email = ? AND is_active = 1'),
  upsertUser: db.prepare(
    `INSERT INTO users (email, is_active, display_name, created_by)
     VALUES (@email, 1, @display_name, @created_by)
     ON CONFLICT(email) DO UPDATE SET
       is_active = 1,
       display_name = COALESCE(excluded.display_name, users.display_name)`
  ),
  deactivateUser: db.prepare('UPDATE users SET is_active = 0 WHERE email = ?'),
  listUsers: db.prepare(`SELECT u.email,
      CASE WHEN EXISTS (
        SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = u.email AND ur.active = 1 AND r.active = 1
          AND r.role_code = 'SYS_ADMIN'
      ) THEN 1 ELSE 0 END AS is_admin,
      CASE
        WHEN EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.email AND ur.active=1 AND r.active=1 AND r.role_code='SYS_ADMIN') THEN 'Admin'
        WHEN EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.email AND ur.active=1 AND r.active=1 AND r.role_code='BLOCK_DIRECTOR_APPROVER') THEN 'GÄK'
        WHEN EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.email AND ur.active=1 AND r.active=1 AND r.role_code='DEPARTMENT_HEAD_APPROVER') THEN 'TBP'
        WHEN EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.email AND ur.active=1 AND r.active=1 AND r.role_code='REGIONAL_LEAD_APPROVER') THEN 'Lead miá»n'
        WHEN EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.email AND ur.active=1 AND r.active=1 AND r.role_code='SUPPLIER_USER') THEN 'NCC'
        WHEN EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.email AND ur.active=1 AND r.active=1 AND r.role_code='QLCL_SPECIALIST') THEN 'ChuyÃªn viÃªn'
        ELSE NULL
      END AS role,
      u.is_active, u.display_name, u.created_at
    FROM users u ORDER BY is_admin DESC, role, u.email`),

  // ---- Ack ----
  getAck: db.prepare('SELECT rules_version, acknowledged_at FROM usage_acknowledgements WHERE email = ?'),
  upsertAck: db.prepare(
    `INSERT INTO usage_acknowledgements (email, rules_version, ip, ua)
     VALUES (@email, @rules_version, @ip, @ua)
     ON CONFLICT(email) DO UPDATE SET
       rules_version = excluded.rules_version,
       acknowledged_at = datetime('now'),
       ip = excluded.ip,
       ua = excluded.ua`
  ),

  // ---- Access log ----
  insertAccessLog: db.prepare(
    `INSERT INTO access_log (email, action, details, ip, ua) VALUES (@email, @action, @details, @ip, @ua)`
  ),

};

function logAccess({ email, action, details, ip, ua }) {
  const safeAction = sanitizeAccessText(action, 128) || 'UNKNOWN';
  const safeDetails = sanitizeAccessDetails(safeAction, details);
  try {
    const write = db.transaction(() => {
      stmts.insertAccessLog.run({
        email: sanitizeAccessText(email, 320),
        action: safeAction,
        details: safeDetails ? JSON.stringify(safeDetails) : null,
        ip: sanitizeAccessText(ip, 128),
        ua: sanitizeAccessText(ua, 512),
      });
      const mapped = mapLegacyAccessAction(safeAction, safeDetails || {});
      auditEventService.record({
        ...mapped,
        actorUserId: sanitizeAccessText(email, 320),
        summary: `Compatibility access event: ${safeAction}`,
      });
    });
    write();
    logger.info('audit.access.recorded', {
      access_action: safeAction,
      metadata: safeDetails,
    });
  } catch (e) {
    logger.error('audit.access.write_failed', { access_action: safeAction, error: e });
  }
}

function ensureScoringCategoryCodes() {
  if (!tableExists('scoring_policy_reconciliations')) return;
  db.exec(`
    UPDATE question_items SET
      category_code = CASE category
        WHEN 'Hồ sơ pháp lý' THEN 'LEGAL_RECORDS'
        WHEN 'Kiểm soát ATVSTP' THEN 'FOOD_SAFETY_CONTROL'
        WHEN 'Kiểm soát chất lượng' THEN 'QUALITY_CONTROL'
        WHEN 'Kiểm soát chất lượng sản phẩm' THEN 'PRODUCT_QUALITY_CONTROL'
        WHEN 'Truy xuất nguồn gốc' THEN 'TRACEABILITY'
        ELSE category_code END,
      category_label_snapshot = COALESCE(category_label_snapshot, category);
    INSERT INTO scoring_policy_reconciliations (
      migration_id, source_type, source_id, category_label_snapshot, category_code, status
    )
    SELECT 'RUN-19-RUNTIME', 'EVALUATION_QUESTION', CAST(q.id AS TEXT),
      q.category_label_snapshot, q.category_code,
      CASE WHEN q.category_code IS NULL THEN 'UNMAPPED' ELSE 'CLEAN' END
    FROM question_items q
    WHERE NOT EXISTS (
      SELECT 1 FROM scoring_policy_reconciliations r
      WHERE r.migration_id='RUN-19-RUNTIME'
        AND r.source_type='EVALUATION_QUESTION' AND r.source_id=CAST(q.id AS TEXT)
    );
  `);
}

module.exports = { db, stmts, logAccess, authorizationService, approvalAssignmentService, policyService, auditEventService, questionSeedReadiness };
