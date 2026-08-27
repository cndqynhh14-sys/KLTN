process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const cookieParser = require('cookie-parser');
const { canonicalTokenFactory } = require('./helpers/canonicalAuth');
const { upsertCanonicalUser } = require('./helpers/canonicalUser');

function clearServerModules() {
  [
    '../server/db',
    '../server/config/paths',
    '../server/middleware/auth',
    '../server/routes/dashboard',
    '../server/repositories/dashboard/nccEvaluationsAggregateRepository',
    '../server/services/dashboard/nccEvaluationsAggregateService',
    '../server/domain/reporting/month',
    '../server/domain/reporting/evaluationViolationGroups',
  ].forEach((modulePath) => {
    delete require.cache[require.resolve(modulePath)];
  });
}

function freshModules(dbPath) {
  process.env.DB_PATH = dbPath;
  clearServerModules();
  const dbModule = require('../server/db');
  const auth = require('../server/middleware/auth');
  const dashboardRouter = require('../server/routes/dashboard');
  const NccEvaluationsAggregateRepository = require('../server/repositories/dashboard/nccEvaluationsAggregateRepository');
  const NccEvaluationsAggregateService = require('../server/services/dashboard/nccEvaluationsAggregateService');
  return {
    ...dbModule,
    ...auth,
    signToken: canonicalTokenFactory(dbModule, auth),
    dashboardRouter,
    NccEvaluationsAggregateRepository,
    NccEvaluationsAggregateService,
  };
}

function closeDb(db) {
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
  try { db.pragma('journal_mode = DELETE'); } catch {}
  db.close();
}

function startApp(router) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/dashboard', router);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function seedUsers(db) {
  upsertCanonicalUser(db, {
    email: 'admin@masangroup.com', roleCode: 'SYS_ADMIN', displayName: 'Admin',
  });
  upsertCanonicalUser(db, {
    email: 'qa.one@masangroup.com', roleCode: 'QLCL_SPECIALIST', displayName: 'QA One',
  });
  upsertCanonicalUser(db, {
    email: 'qa.two@masangroup.com', roleCode: 'QLCL_SPECIALIST', displayName: 'QA Two',
  });
}

function insertSupplier(db, code, name, extra = {}) {
  return db.prepare(`
    INSERT INTO supplier_master (
      supplier_code, supplier_name, tax_code, address, region, province, business_type,
      contact_name, contact_email, contact_phone, status, source_type, created_by
    )
    VALUES (
      @supplier_code, @supplier_name, @tax_code, @address, @region, @province, @business_type,
      @contact_name, @contact_email, @contact_phone, 'ACTIVE', 'MANUAL', 'admin@masangroup.com'
    )
  `).run({
    supplier_code: code,
    supplier_name: name,
    tax_code: extra.tax_code || `${code}-TAX`,
    address: 'HQ',
    region: 'MB',
    province: 'Thành phố Hà Nội',
    business_type: 'Tự sản xuất',
    contact_name: 'Contact',
    contact_email: `${code.toLowerCase()}@example.com`,
    contact_phone: '0900000000',
  }).lastInsertRowid;
}

function insertTemplate(db) {
  const info = db.prepare(`
    INSERT INTO question_templates (template_code, template_name, description, active)
    VALUES ('DASHBOARD-TEMPLATE', 'Dashboard Aggregate Template', 'Dashboard aggregate tests', 1)
    ON CONFLICT(template_code) DO UPDATE SET active=1
  `).run();
  const row = db.prepare("SELECT id FROM question_templates WHERE template_code = 'DASHBOARD-TEMPLATE'").get();
  return row.id || info.lastInsertRowid;
}

function insertQuestion(db, templateId, code, category, text, orderIndex) {
  let version = db.prepare(`SELECT id FROM question_template_versions
    WHERE template_id=? AND status='DRAFT' ORDER BY version_no DESC LIMIT 1`).get(templateId);
  if (!version) {
    const info = db.prepare(`INSERT INTO question_template_versions
      (template_id, version_no, status, checksum, lock_version, created_by)
      VALUES (?, 1, 'DRAFT', ?, 1, 'fixture')`).run(templateId, 'd'.repeat(64));
    version = { id: Number(info.lastInsertRowid) };
  }
  return db.prepare(`
    INSERT INTO question_items (
      question_template_version_id, facility_type, supplier_scale, question_code, question_text, category, order_index, active
    )
    VALUES (?, 'ALL', 'ALL', ?, ?, ?, ?, 1)
  `).run(version.id, code, text, category, orderIndex).lastInsertRowid;
}

function insertTicket(db, ticketCode, supplierId, templateId, fields = {}) {
  return db.prepare(`
    INSERT INTO evaluation_tickets (
      ticket_code, supplier_id, supplier_code, supplier_name, evaluation_type, template_id,
      question_template_version_id,
      facility_type, supplier_scale, current_status, product_group, mch3, mch2,
      result_label, final_conclusion, is_deleted
    )
    VALUES (
      @ticket_code, @supplier_id, @supplier_code, @supplier_name, 'Đánh giá định kỳ', @template_id,
      @question_template_version_id, 'ALL', 'LARGE', @current_status, @product_group, @mch3, @mch2,
      @result_label, @final_conclusion, @is_deleted
    )
  `).run({
    ticket_code: ticketCode,
    supplier_id: supplierId,
    supplier_code: fields.supplier_code || ticketCode,
    supplier_name: fields.supplier_name || `${ticketCode} Supplier`,
    template_id: templateId,
    question_template_version_id: db.prepare(`SELECT id FROM question_template_versions
      WHERE template_id=? ORDER BY version_no DESC LIMIT 1`).pluck().get(templateId),
    current_status: fields.current_status || 'Hoàn thành',
    product_group: fields.product_group ?? null,
    mch3: fields.mch3 ?? null,
    mch2: fields.mch2 ?? null,
    result_label: fields.result_label ?? null,
    final_conclusion: fields.final_conclusion ?? null,
    is_deleted: fields.is_deleted || 0,
  }).lastInsertRowid;
}

function insertRound(db, ticketId, roundNo, fields = {}) {
  return db.prepare(`
    INSERT INTO evaluation_rounds (
      ticket_id, round_no, assessment_date, completed_at, locked_at, status, total_score, final_result, classification
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ticketId,
    roundNo,
    fields.assessment_date ?? null,
    fields.completed_at ?? null,
    fields.locked_at ?? null,
    fields.status || 'Hoàn thành',
    fields.total_score ?? null,
    fields.final_result ?? null,
    fields.classification ?? null,
  ).lastInsertRowid;
}

function insertAnswer(db, roundId, questionId, score) {
  db.prepare(`
    INSERT INTO evaluation_answers (round_id, question_item_id, score, comment, calculated_score, answered_by)
    VALUES (?, ?, ?, 'Dashboard aggregate test', 0, 'admin@masangroup.com')
    ON CONFLICT(round_id, question_item_id) DO UPDATE SET score=excluded.score
  `).run(roundId, questionId, score);
}

function insertNonconformity(db, ticketId, roundId, questionId, clauseCode, category, status = 'OPEN') {
  db.prepare(`INSERT INTO evaluation_answers
    (round_id, question_item_id, score, comment, calculated_score, answered_by)
    VALUES (?, ?, 'B', 'Aggregate finding', 75, 'admin@masangroup.com')
    ON CONFLICT(round_id, question_item_id) DO NOTHING`).run(roundId, questionId);
  const answerId = db.prepare(`SELECT id FROM evaluation_answers
    WHERE round_id=? AND question_item_id=?`).pluck().get(roundId, questionId);
  db.prepare(`
    INSERT INTO evaluation_nonconformities (
      ticket_id, round_id, evaluation_answer_id, clause_code, category, nonconformity_content, severity, status, created_by
    )
    VALUES (?, ?, ?, ?, ?, 'Aggregate finding', 'B', ?, 'admin@masangroup.com')
  `).run(ticketId, roundId, answerId, clauseCode, category, status);
}

test('NCC evaluations workflow aggregate counts one latest classifiable supplier and dedupes violations by selected round', () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-dashboard-evals-${Date.now()}-${Math.random()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const { db, NccEvaluationsAggregateRepository, NccEvaluationsAggregateService } = freshModules(dbPath);
  try {
    seedUsers(db);
    const templateId = insertTemplate(db);
    const legalQuestion = insertQuestion(db, templateId, 'LEGAL-01', 'Hồ sơ pháp lý', 'Business license valid', 1);
    const legalQuestion2 = insertQuestion(db, templateId, 'LEGAL-02', 'Hồ sơ pháp lý', 'Food safety license valid', 2);
    const qualityQuestion = insertQuestion(db, templateId, 'QUALITY-01', 'Kiểm soát chất lượng', 'Quality records maintained', 2);
    const traceQuestion = insertQuestion(db, templateId, 'TRACE-01', 'Truy xuất nguồn gốc', 'Traceability by lot', 3);
    const foodQuestion = insertQuestion(db, templateId, 'ATTP-01', 'Kiểm soát ATVSTP', 'Food safety certificate', 4);

    const supplierA = insertSupplier(db, 'NCC-A', 'Supplier A');
    const ticketA = insertTicket(db, 'TICKET-A', supplierA, templateId, { supplier_code: 'NCC-A', product_group: 'Fresh' });
    const oldRoundA = insertRound(db, ticketA, 1, { assessment_date: '2026-04-03', completed_at: '2026-04-04', total_score: 50, final_result: 'Không đạt', classification: 'D' });
    const latestRoundA = insertRound(db, ticketA, 2, { assessment_date: '2026-04-20', completed_at: '2026-04-21', total_score: 80, final_result: 'Đạt mức khá', classification: 'B' });
    insertNonconformity(db, ticketA, oldRoundA, legalQuestion, 'LEGAL-01', 'Hồ sơ pháp lý');
    insertNonconformity(db, ticketA, latestRoundA, foodQuestion, 'ATTP-01', 'Kiểm soát ATVSTP');
    insertAnswer(db, latestRoundA, qualityQuestion, 'C');

    const supplierB = insertSupplier(db, 'NCC-B', 'Supplier B');
    const ticketB1 = insertTicket(db, 'TICKET-B1', supplierB, templateId, { supplier_code: 'NCC-B', mch3: 'Dry' });
    insertRound(db, ticketB1, 1, { assessment_date: '2026-04-10', completed_at: '2026-04-11', total_score: 90, final_result: 'Không đạt', classification: 'A' });
    const ticketB2 = insertTicket(db, 'TICKET-B2', supplierB, templateId, { supplier_code: 'NCC-B', mch3: 'Dry' });
    const latestRoundB = insertRound(db, ticketB2, 1, { assessment_date: '2026-04-25', completed_at: '2026-04-26', total_score: 90, final_result: 'Không đạt', classification: 'A' });
    insertNonconformity(db, ticketB2, latestRoundB, legalQuestion, 'LEGAL-01', 'Hồ sơ pháp lý');
    insertNonconformity(db, ticketB2, latestRoundB, legalQuestion2, 'LEGAL-02', 'Hồ sơ pháp lý');
    insertAnswer(db, latestRoundB, traceQuestion, 'B');
    insertAnswer(db, latestRoundB, legalQuestion, 'C');

    const supplierC = insertSupplier(db, 'NCC-C', 'Supplier C');
    const cancelledTicket = insertTicket(db, 'TICKET-CANCEL', supplierC, templateId, { supplier_code: 'NCC-C', current_status: 'Hủy', product_group: 'Cancelled' });
    insertRound(db, cancelledTicket, 1, { assessment_date: '2026-04-05', total_score: 20, final_result: 'Không đạt', classification: 'D' });

    const supplierD = insertSupplier(db, 'NCC-D', 'Supplier D');
    const missingDateTicket = insertTicket(db, 'TICKET-MISSING-DATE', supplierD, templateId, { supplier_code: 'NCC-D' });
    insertRound(db, missingDateTicket, 1, { total_score: 75, final_result: 'Đạt mức khá', classification: 'B' });

    const supplierE = insertSupplier(db, 'NCC-E', 'Supplier E');
    const unclassifiableTicket = insertTicket(db, 'TICKET-UNCLASS', supplierE, templateId, { supplier_code: 'NCC-E' });
    insertRound(db, unclassifiableTicket, 1, { completed_at: '2026-04-12 08:00:00' });

    const supplierF = insertSupplier(db, 'NCC-F', 'Supplier F');
    const inProgressTicket = insertTicket(db, 'TICKET-IN-PROGRESS', supplierF, templateId, { supplier_code: 'NCC-F', current_status: 'Đang xử lý' });
    insertRound(db, inProgressTicket, 1, {
      status: 'Đang xử lý',
      assessment_date: '2026-04-28',
      total_score: 20,
      final_result: 'Không đạt',
      classification: 'D',
    });

    const service = new NccEvaluationsAggregateService({ repository: new NccEvaluationsAggregateRepository(db) });
    const result = service.get('2026-04');
    assert.equal(result.data_source, 'workflow');
    assert.deepEqual(result.overview, { total: 2, passed: 1, failed: 1, passed_ratio: 0.5, failed_ratio: 0.5 });
    assert.equal(result.by_category.reduce((sum, row) => sum + row.total, 0), result.overview.total);
    assert.equal(result.by_category.find((row) => row.category === 'Fresh').passed, 1);
    assert.equal(result.by_category.find((row) => row.category === 'Dry').failed, 1);
    assert.equal(result.meta.data_quality.excluded_missing_reporting_date, 1);
    assert.equal(result.meta.data_quality.excluded_unclassifiable_result, 1);
    assert.equal(result.meta.data_quality.score_result_conflicts, 1);

    const byViolation = new Map(result.violations.map((row) => [row.code, row]));
    assert.deepEqual(result.violations.map((row) => row.code), ['LEGAL', 'QUALITY_CONTROL', 'TRACEABILITY', 'FOOD_SAFETY']);
    assert.equal(byViolation.get('LEGAL').supplier_count, 1);
    assert.equal(byViolation.get('QUALITY_CONTROL').supplier_count, 1);
    assert.equal(byViolation.get('TRACEABILITY').supplier_count, 1);
    assert.equal(byViolation.get('FOOD_SAFETY').supplier_count, 1);
    result.violations.forEach((row) => assert.ok(row.supplier_count <= result.overview.total));

    const may = service.get('2026-05');
    assert.deepEqual(may.overview, { total: 0, passed: 0, failed: 0, passed_ratio: 0, failed_ratio: 0 });
    assert.deepEqual(may.violations, []);
    assert.throws(() => service.get('2026-13'), /YYYY-MM/);
  } finally {
    closeDb(db);
    if (oldDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = oldDbPath;
  }
});

test('evaluation dashboard routes preserve auth, strict month errors and unmount NCC docs', async () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-dashboard-routes-${Date.now()}-${Math.random()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const oldJwtSecret = process.env.JWT_SECRET;
  const { db, signToken, dashboardRouter } = freshModules(dbPath);
  let server;
  try {
    seedUsers(db);
    const appInfo = await startApp(dashboardRouter);
    server = appInfo.server;
    const token = signToken({ email: 'admin@masangroup.com', isAdmin: true, role: 'Admin' }, 3600);
    const headers = { Cookie: `qlcl_token=${token}` };

    const unauth = await fetch(`${appInfo.baseUrl}/dashboard/ncc-evaluations?month=2026-04`);
    assert.equal(unauth.status, 401);
    const unauthStatistics = await fetch(`${appInfo.baseUrl}/dashboard/statistics?period=2026-04`);
    assert.equal(unauthStatistics.status, 401);

    const missing = await fetch(`${appInfo.baseUrl}/dashboard/ncc-evaluations`, { headers });
    assert.equal(missing.status, 400);
    assert.deepEqual(await missing.json(), {
      error: {
        code: 'INVALID_MONTH',
        message: 'Query parameter month must use YYYY-MM.',
      },
    });

    const malformed = await fetch(`${appInfo.baseUrl}/dashboard/ncc-evaluations?month=2026-4`, { headers });
    assert.equal(malformed.status, 400);

    const malformedStatistics = await fetch(`${appInfo.baseUrl}/dashboard/statistics?period=2026-4`, { headers });
    assert.equal(malformedStatistics.status, 400);
    assert.deepEqual(await malformedStatistics.json(), {
      error: {
        code: 'INVALID_DASHBOARD_PERIOD',
        message: 'Kỳ báo cáo không hợp lệ.',
      },
    });

    const quarterStatistics = await fetch(`${appInfo.baseUrl}/dashboard/statistics?periodType=QUARTER&periodValue=2026-Q3`, { headers });
    assert.equal(quarterStatistics.status, 200);
    const quarterStatisticsJson = await quarterStatistics.json();
    assert.equal(quarterStatisticsJson.period.value, '2026-Q3');
    assert.equal(quarterStatisticsJson.period.start, '2026-07-01');
    assert.equal(quarterStatisticsJson.trend.length, 6);
    assert.ok(Array.isArray(quarterStatisticsJson.status_distribution.items));

    const docs = await fetch(`${appInfo.baseUrl}/dashboard/ncc-docs?month=2026-04`, { headers });
    assert.equal(docs.status, 404);

    const evals = await fetch(`${appInfo.baseUrl}/dashboard/ncc-evaluations?month=2026-04`, { headers });
    const evalsJson = await evals.json();
    assert.equal(evals.status, 200, JSON.stringify(evalsJson));
    assert.equal(evalsJson.data_source, 'workflow');
    assert.deepEqual(evalsJson.overview, { total: 0, passed: 0, failed: 0, passed_ratio: 0, failed_ratio: 0 });
    assert.deepEqual(evalsJson.violations, []);
    assert.equal(evalsJson.meta.grain, 'latest_completed_round_per_supplier_per_month');

    const statistics = await fetch(`${appInfo.baseUrl}/dashboard/statistics?period=2026-04`, { headers });
    const statisticsJson = await statistics.json();
    assert.equal(statistics.status, 200, JSON.stringify(statisticsJson));
    assert.equal(statisticsJson.period.value, '2026-04');
    assert.equal(statisticsJson.meta.data_source, 'workflow');
    assert.equal(statisticsJson.status_distribution.total, 0);
    assert.deepEqual(statisticsJson.trend.map((item) => item.period_value), ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04']);
    statisticsJson.trend.forEach((item) => {
      assert.equal(item.evaluation_ticket_count, item.passed_ticket_count + item.failed_ticket_count);
    });
    assert.equal(statisticsJson.kpis.evaluated_supplier_count.current_value, 0);
    assert.equal(statisticsJson.kpis.evaluation_ticket_count.current_value, 0);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    closeDb(db);
    if (oldDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = oldDbPath;
    if (oldJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldJwtSecret;
  }
});

test('RUN-30 removes the standalone NCC evaluation screen while retaining the backend aggregate contract', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const stateJs = fs.readFileSync(path.join(root, 'public/js/state.js'), 'utf8');

  assert.doesNotMatch(stateJs, /nccEvaluationsDashboard/);
  assert.doesNotMatch(html, /id="view-ncc-eval"|id="ncc-eval-summary"|id="ncc-violations-chart"/);
  assert.match(html, /id="dashboard-view-segment"[\s\S]*data-dashboard-mode="overview"[\s\S]*data-dashboard-mode="detail"/);
  assert.match(app, /route\.split\('\?'\)\[0\] !== '\/dashboard\/ncc-evaluations'/);
  assert.doesNotMatch(stateJs, /nccDocsDashboard/);
  assert.doesNotMatch(html, /id="ncc-summary"|id="view-ncc-docs"/);
  assert.doesNotMatch(app, /validNccDocsResponse|\/dashboard\/ncc-docs/);
});
