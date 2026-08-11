'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');
const { migrateDatabase } = require('../server/database/migrationRunner');
const {
  HistoricalEvaluationImporter,
  classifyHistoricalRound2,
} = require('../server/services/HistoricalEvaluationImporter');
const { assertTicketMutable, isHistoricalTicket } = require('../server/domain/historicalEvaluation');
const SupplierEvaluationStatisticsRepository = require('../server/repositories/dashboard/supplierEvaluationStatisticsRepository');
const StatisticalDashboardService = require('../server/services/dashboard/statisticalDashboardService');
const { QuestionVersionService } = require('../server/services/QuestionVersionService');

const migrationsDir = path.resolve(__dirname, '..', 'migrations');

function createDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrateDatabase(db, { migrationsDir, appVersion: 'RUN-34-TEST' });
  const insert = db.prepare(`
    INSERT INTO supplier_master (
      supplier_code, supplier_name, status, source_type
    ) VALUES (?, ?, 'ACTIVE', 'MANUAL')
  `);
  insert.run('NCC-001', 'Supplier One');
  insert.run('NCC-002', 'Supplier Two');
  return db;
}

function record(overrides = {}) {
  return {
    sourceRowNumber: 4,
    sourceStt: 1,
    year: 2026,
    month: 'Tháng 01',
    mch2: 'Thực phẩm tươi sống, chế biến',
    mch3: 'Rau củ',
    cmcOwner: 'CMC A',
    cmcHead: 'CMC Head',
    region: 'MN',
    province: 'Tỉnh Đồng Nai',
    evaluationType: 'Định kỳ',
    businessType: 'Sản xuất và kinh doanh',
    supplierCode: 'NCC-001',
    supplierName: 'Supplier One',
    supplierEvaluationAddress: 'Nhà máy A',
    linkedFacilityName: 'Cơ sở liên kết A',
    linkedFacilityAddress: 'Địa chỉ liên kết A',
    contactName: 'Nguyễn Văn A',
    contactPhone: '0900000000',
    contactEmail: 'supplier@example.com',
    productName: 'Rau xanh',
    qaLeadNames: ['QA Lead'],
    qaSupportNames: ['QA Support'],
    evaluationDepartment: 'QA NCC',
    actualEvaluationDate: '2026-01-15',
    scoreRound1: 72.5,
    conclusionRound1: 'Đạt mức cơ bản và tái đánh giá sau 6 tháng',
    scoreAfterCorrection: 72.5,
    conclusionAfterCorrection: 'Đạt mức cơ bản và tái đánh giá sau 6 tháng',
    adjustmentReason: null,
    correctionDate: null,
    nextEvaluationDate: '2026-07-15',
    finalConclusion: 'Đạt',
    violations: [
      { group: 'Lỗi kiểm soát chất lượng', content: 'Thiếu hồ sơ kiểm soát nguồn.' },
    ],
    sourcePayload: { STT: 1 },
    ...overrides,
  };
}

test('RUN-34 migration permits sparse HISTORICAL tickets but keeps NATIVE ticket constraints', () => {
  const db = createDb();
  try {
    const ticketColumns = db.prepare("PRAGMA table_info('evaluation_tickets')").all();
    const nonconformityColumns = db.prepare("PRAGMA table_info('evaluation_nonconformities')").all();
    assert.ok(ticketColumns.some((column) => column.name === 'source_kind'));
    assert.equal(ticketColumns.find((column) => column.name === 'template_id').notnull, 0);
    assert.equal(ticketColumns.find((column) => column.name === 'facility_type').notnull, 0);
    assert.equal(ticketColumns.find((column) => column.name === 'supplier_scale').notnull, 0);
    assert.equal(nonconformityColumns.find((column) => column.name === 'evaluation_answer_id').notnull, 0);

    const supplierId = db.prepare("SELECT id FROM supplier_master WHERE supplier_code='NCC-001'").pluck().get();
    assert.throws(() => db.prepare(`
      INSERT INTO evaluation_tickets (
        ticket_code, supplier_id, evaluation_type, current_status, source_kind
      ) VALUES ('NATIVE-SPARSE', ?, 'Định kỳ', 'Khởi tạo', 'NATIVE')
    `).run(supplierId), /CHECK constraint failed/);
  } finally {
    db.close();
  }
});

test('RUN-34 round-2 rule uses only changed score, adjustment reason or correction date', () => {
  assert.equal(classifyHistoricalRound2(record()), false);
  assert.equal(classifyHistoricalRound2(record({ scoreAfterCorrection: 80 })), true);
  assert.equal(classifyHistoricalRound2(record({ adjustmentReason: 'NCC đã gửi hành động khắc phục' })), true);
  assert.equal(classifyHistoricalRound2(record({ correctionDate: '2026-01-20' })), true);
});

test('RUN-34 importer stores aggregate historical tickets without fake answers/workflow and is idempotent', () => {
  const db = createDb();
  try {
    const importer = new HistoricalEvaluationImporter(db);
    const records = [
      record(),
      record({
        sourceRowNumber: 5,
        sourceStt: 2,
        supplierCode: 'NCC-002',
        supplierName: 'Supplier Two',
        scoreRound1: 55,
        scoreAfterCorrection: 65,
        adjustmentReason: 'Đã khắc phục',
        correctionDate: null,
        finalConclusion: 'Đạt',
        violations: [{ group: 'Lỗi truy xuất nguồn gốc SP', content: 'Thiếu nhật ký truy xuất.' }],
        sourcePayload: { STT: 2 },
      }),
      record({
        sourceRowNumber: 6,
        sourceStt: 3,
        scoreRound1: null,
        scoreAfterCorrection: null,
        violations: [],
        sourcePayload: { STT: 3 },
      }),
    ];
    const options = {
      records,
      sourceId: 'RUN34_TEST_SOURCE',
      sourceFile: 'historical.xlsx',
      sourceFileHash: 'a'.repeat(64),
    };

    const dryRun = importer.importRecords({ ...options, commit: false });
    assert.equal(dryRun.ticketCount, 3);
    assert.equal(dryRun.round1Count, 3);
    assert.equal(dryRun.round2Count, 1);
    assert.equal(dryRun.missingScoreRound1Count, 1);
    assert.equal(dryRun.round2MissingCorrectionDateCount, 1);
    assert.equal(db.prepare('SELECT COUNT(*) FROM evaluation_tickets').pluck().get(), 0);

    const first = importer.importRecords({ ...options, commit: true });
    assert.equal(first.insertedTickets, 3);
    assert.equal(first.insertedRounds, 4);
    assert.equal(first.insertedNonconformities, 2);
    assert.equal(first.duplicateCount, 0);
    assert.equal(db.prepare('SELECT COUNT(*) FROM evaluation_answers').pluck().get(), 0);
    assert.equal(db.prepare('SELECT COUNT(*) FROM workflow_history').pluck().get(), 0);
    assert.equal(db.prepare('SELECT COUNT(*) FROM approval_tasks').pluck().get(), 0);
    assert.equal(db.prepare('SELECT COUNT(*) FROM notifications').pluck().get(), 0);

    const historical = db.prepare(`
      SELECT * FROM evaluation_tickets WHERE historical_source_stt = 2
    `).get();
    assert.equal(historical.source_kind, 'HISTORICAL');
    assert.equal(historical.current_status, 'Hoàn thành');
    assert.equal(historical.template_id, null);
    assert.equal(historical.question_template_version_id, null);
    assert.equal(historical.scoring_policy_version_id, null);
    assert.equal(historical.facility_type, null);
    assert.equal(historical.supplier_scale, null);
    assert.equal(historical.scoring_locked, 1);
    assert.equal(historical.completed_round, 2);

    const rounds = db.prepare(`
      SELECT round_no, assessment_date, completed_at, total_score, scoring_policy_version_id
      FROM evaluation_rounds WHERE ticket_id=? ORDER BY round_no
    `).all(historical.id);
    assert.deepEqual(rounds, [
      { round_no: 1, assessment_date: '2026-01-15', completed_at: '2026-01-15 00:00:00', total_score: 55, scoring_policy_version_id: null },
      { round_no: 2, assessment_date: null, completed_at: null, total_score: 65, scoring_policy_version_id: null },
    ]);
    const nonconformity = db.prepare(`
      SELECT evaluation_answer_id, nonconformity_content
      FROM evaluation_nonconformities WHERE ticket_id=?
    `).get(historical.id);
    assert.equal(nonconformity.evaluation_answer_id, null);
    assert.equal(nonconformity.nonconformity_content, 'Thiếu nhật ký truy xuất.');

    const second = importer.importRecords({ ...options, commit: true });
    assert.equal(second.insertedTickets, 0);
    assert.equal(second.insertedRounds, 0);
    assert.equal(second.insertedNonconformities, 0);
    assert.equal(second.duplicateCount, 3);
    assert.equal(db.prepare('SELECT COUNT(*) FROM evaluation_tickets').pluck().get(), 3);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    db.close();
  }
});

test('RUN-34 importer aborts the whole batch when a supplier code does not map uniquely', () => {
  const db = createDb();
  try {
    const importer = new HistoricalEvaluationImporter(db);
    assert.throws(() => importer.importRecords({
      records: [record(), record({ sourceStt: 2, supplierCode: 'UNKNOWN' })],
      sourceId: 'RUN34_TEST_SOURCE',
      sourceFile: 'historical.xlsx',
      sourceFileHash: 'b'.repeat(64),
      commit: true,
    }), (error) => error.code === 'historical_supplier_mapping_failed');
    assert.equal(db.prepare('SELECT COUNT(*) FROM evaluation_tickets').pluck().get(), 0);
  } finally {
    db.close();
  }
});

test('RUN-34 historical tickets are immutable and remain visible in aggregate dashboard statistics', () => {
  const db = createDb();
  try {
    const importer = new HistoricalEvaluationImporter(db);
    importer.importRecords({
      records: [
        record(),
        record({
          sourceRowNumber: 5,
          sourceStt: 2,
          supplierCode: 'NCC-002',
          supplierName: 'Supplier Two',
          scoreRound1: 55,
          scoreAfterCorrection: 65,
          adjustmentReason: 'Đã khắc phục',
          correctionDate: null,
          finalConclusion: 'Đạt',
          violations: [{ group: 'Lỗi truy xuất nguồn gốc SP', content: 'Thiếu nhật ký truy xuất.' }],
          sourcePayload: { STT: 2 },
        }),
      ],
      sourceId: 'RUN34_DASHBOARD_SOURCE',
      sourceFile: 'historical.xlsx',
      sourceFileHash: 'c'.repeat(64),
      commit: true,
    });

    const ticket = db.prepare("SELECT * FROM evaluation_tickets WHERE historical_source_stt=2").get();
    assert.equal(isHistoricalTicket(ticket), true);
    assert.throws(() => assertTicketMutable(ticket), (error) => (
      error.status === 409 && error.code === 'historical_ticket_readonly'
    ));

    const service = new StatisticalDashboardService({
      repository: new SupplierEvaluationStatisticsRepository(db),
    });
    const dashboard = service.get({ periodType: 'MONTH', periodValue: '2026-01' });
    assert.equal(dashboard.kpis.evaluated_supplier_count.current_value, 2);
    assert.equal(dashboard.kpis.evaluation_ticket_count.current_value, 2);
    const corrected = dashboard.top_suppliers.find((row) => row.supplier_code === 'NCC-002');
    assert.equal(corrected.average_final_score, 65);
    assert.equal(dashboard.details.violation_distribution.total_violations, 2);
    assert.equal(db.prepare('SELECT COUNT(*) FROM evaluation_answers').pluck().get(), 0);
  } finally {
    db.close();
  }
});

test('RUN-34 startup question reconciliation ignores intentionally unpinned HISTORICAL tickets', () => {
  const db = createDb();
  try {
    new HistoricalEvaluationImporter(db).importRecords({
      records: [record()],
      sourceId: 'RUN34_STARTUP_SOURCE',
      sourceFile: 'historical.xlsx',
      sourceFileHash: 'd'.repeat(64),
      commit: true,
    });
    const reconciliation = new QuestionVersionService(db).ensureCanonicalV1();
    assert.equal(reconciliation.status, 'CLEAN');
    assert.equal(reconciliation.orphan_ticket_count, 0);
    const historical = db.prepare("SELECT template_id, question_template_version_id FROM evaluation_tickets WHERE source_kind='HISTORICAL'").get();
    assert.deepEqual(historical, { template_id: null, question_template_version_id: null });
  } finally {
    db.close();
  }
});
