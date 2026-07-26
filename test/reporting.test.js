const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const XLSX = require('xlsx');

function freshDb(dbPath) {
  process.env.DB_PATH = dbPath;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  delete require.cache[require.resolve('../server/db')];
  return require('../server/db').db;
}

function startApp(router) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/evaluations', router);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test('DOC-4 report context includes input columns, sections, category percentages, and planning dates', () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-reporting-test-${Date.now()}-${Math.random()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const oldJwtSecret = process.env.JWT_SECRET;
  const db = freshDb(dbPath);

  try {
    const { buildReportContext, calculateNextEvaluationDate, renderInternalReportHtml, renderReportHtml, renderTemplate, renderWorkingMinutesHtml } = require('../server/services/reporting');
    db.prepare(`
      INSERT INTO users (email, is_admin, role, is_active, display_name)
      VALUES ('admin@masangroup.com', 1, 'Admin', 1, 'Nguyen Van Auditor')
      ON CONFLICT(email) DO UPDATE SET is_admin=1, role='Admin', is_active=1, display_name='Nguyen Van Auditor'
    `).run();
    db.prepare(`
      INSERT INTO users (email, is_admin, role, is_active, display_name)
      VALUES ('support@masangroup.com', 0, 'Chuyên viên', 1, 'Le Thi QA Support')
      ON CONFLICT(email) DO UPDATE SET is_admin=0, role='Chuyên viên', is_active=1, display_name='Le Thi QA Support'
    `).run();
    const supplier = db.prepare(`
      INSERT INTO supplier_master (supplier_code, supplier_name, status, source_type)
      VALUES ('NCC-RPT', 'Report Supplier', 'ACTIVE', 'MANUAL')
    `).run();
    const template = db.prepare(`
      INSERT INTO question_templates (template_code, template_name, active)
      VALUES ('RPT', 'Report Test', 1)
    `).run();
    const insertQuestion = db.prepare(`
      INSERT INTO evaluation_questions (
        template_id, facility_type, supplier_scale, question_code, question_text,
        category, order_index, active
      )
      VALUES (?, 'CHUNG', 'LARGE', ?, ?, ?, ?, 1)
    `);
    const q1 = insertQuestion.run(template.lastInsertRowid, 'LEGAL-01', 'Business license is valid', 'Hồ sơ pháp lý', 1).lastInsertRowid;
    const q2 = insertQuestion.run(template.lastInsertRowid, 'LEGAL-02', 'Contract evidence is complete', 'Hồ sơ pháp lý', 2).lastInsertRowid;
    const q3 = insertQuestion.run(template.lastInsertRowid, 'QUALITY-01', 'Quality records are maintained', 'Kiểm soát chất lượng sản phẩm', 3).lastInsertRowid;
    const q4 = insertQuestion.run(template.lastInsertRowid, 'TRACE-01', 'Traceability is available', 'Truy xuất nguồn gốc', 4).lastInsertRowid;

    const ticketInfo = db.prepare(`
      INSERT INTO evaluation_tickets (
        ticket_code, supplier_id, supplier_code, supplier_name, tax_code, supplier_address,
        production_address, evaluation_address, linked_facility_address, region, province,
        business_type, cmc_owner, cmc_head, business_license_file, attp_certificate_type,
        attp_certificate_file, contact_name, contact_email, contact_phone, mch2, mch3,
        product_group, product_name, evaluation_type, template_id, facility_type, supplier_scale,
        evaluation_method, evaluator_name, qa_lead_id, qa_support_ids, evaluation_department,
        planned_date, actual_evaluation_date, current_status, current_round_no,
        score_percent, grade_code, result_label, result_reason, corrected_score_percent,
        corrected_result_label, correction_date, final_conclusion, specialist_proposal, supplier_introduction,
        scoring_locked, completed_round, assigned_specialist_id, created_by
      )
      VALUES (
        'TICKET-RPT', @supplier_id, 'NCC-RPT', 'Report Supplier', 'TAX-RPT', 'HQ Address',
        'Factory Address', 'Audit Address', 'Linked Address', 'North', 'Ha Noi',
        'Manufacturing', 'CMC Owner', 'CMC Head', 'license.pdf', 'HACCP',
        'attp.pdf', 'Supplier Contact', 'contact@example.com', '0900000000', 'Fresh', 'Vegetable',
        'Produce', 'Carrot', 'Định kỳ', @template_id, 'CHUNG', 'LARGE',
        'Onsite', 'Evaluator', 'admin@masangroup.com', @support_ids, 'QA',
        '2026-07-10', '2026-07-15', 'Hoàn thành', 2,
        70, 'C', 'Đạt mức cơ bản', 'Supplier corrective action', 91,
        'Đạt mức cao', '2026-08-01', 'Final pass', 'Approve supplier', @supplier_introduction,
        1, 2, 'admin@masangroup.com', 'admin@masangroup.com'
      )
    `).run({
      supplier_id: supplier.lastInsertRowid,
      template_id: template.lastInsertRowid,
      support_ids: JSON.stringify(['support@masangroup.com']),
      supplier_introduction: 'Supplier intro line 1\nSupplier intro line 2',
    });
    const round = db.prepare(`
      INSERT INTO evaluation_rounds (ticket_id, round_no, assessment_code, assessment_date, evaluator_id, status, completed_at, total_score, final_result, classification, locked_at, locked_by)
      VALUES (?, 1, 'TICKET-RPT-R1', '2026-07-10', 'admin@masangroup.com', 'Hoàn thành', '2026-07-15', 70, 'Đạt mức cơ bản', 'C', '2026-07-15', 'admin@masangroup.com')
    `).run(ticketInfo.lastInsertRowid);
    const round2 = db.prepare(`
      INSERT INTO evaluation_rounds (ticket_id, round_no, assessment_code, assessment_date, evaluator_id, status, completed_at, total_score, final_result, classification, locked_at, locked_by)
      VALUES (?, 2, 'TICKET-RPT-R2', '2026-08-01', 'admin@masangroup.com', 'Hoàn thành', '2026-08-01', 91, 'Đạt mức cao', 'A', '2026-08-01', 'admin@masangroup.com')
    `).run(ticketInfo.lastInsertRowid);
    const insertAnswer = db.prepare(`
      INSERT INTO evaluation_answers (round_id, question_id, score, comment, calculated_score, answered_by)
      VALUES (?, ?, ?, ?, ?, 'admin@masangroup.com')
    `);
    insertAnswer.run(round.lastInsertRowid, q1, 'A', '', 100);
    insertAnswer.run(round.lastInsertRowid, q2, 'B', 'Missing contract evidence', 75);
    insertAnswer.run(round.lastInsertRowid, q3, 'C', 'Quality records incomplete', 25);
    insertAnswer.run(round.lastInsertRowid, q4, 'NA', 'Not applicable', null);
    insertAnswer.run(round2.lastInsertRowid, q1, 'A', '', 100);
    insertAnswer.run(round2.lastInsertRowid, q2, 'B', 'Missing contract evidence', 75);
    insertAnswer.run(round2.lastInsertRowid, q3, 'C', 'Quality records incomplete', 25);
    insertAnswer.run(round2.lastInsertRowid, q4, 'NA', 'Not applicable', null);
    db.prepare(`
      INSERT INTO evaluation_nonconformities (
        ticket_id, round_id, question_id, clause_code, category, nonconformity,
        remediation, due_date, severity, status, created_by
      )
      VALUES (?, ?, ?, 'LEGAL-02', 'Hồ sơ pháp lý', 'Missing contract evidence',
        'Upload contract', '2026-08-01', 'B', 'OPEN', 'admin@masangroup.com')
    `).run(ticketInfo.lastInsertRowid, round.lastInsertRowid, q2);
    db.prepare(`
      INSERT INTO evaluation_nonconformities (
        ticket_id, round_id, question_id, clause_code, category, nonconformity,
        remediation, due_date, severity, status, created_by
      )
      VALUES (?, ?, ?, 'LEGAL-02', 'Hồ sơ pháp lý', 'Missing contract evidence',
        'Upload contract', '2026-08-01', 'B', 'OPEN', 'admin@masangroup.com')
    `).run(ticketInfo.lastInsertRowid, round2.lastInsertRowid, q2);
    db.prepare(`
      INSERT INTO corrective_actions (ticket_id, round_id, issue_description, required_action, responsible_party, due_date, status, created_by)
      VALUES (?, ?, 'Missing contract evidence', 'Upload contract', 'Supplier', '2026-08-01', 'OPEN', 'admin@masangroup.com')
    `).run(ticketInfo.lastInsertRowid, round.lastInsertRowid);
    db.prepare(`
      INSERT INTO approval_tasks (ticket_id, approval_level, assigned_role, status, acted_at, acted_by, comment)
      VALUES (?, 'TBP', 'TBP', 'APPROVED', '2026-08-02', 'admin@masangroup.com', '{}')
    `).run(ticketInfo.lastInsertRowid);
    const blankTicket = db.prepare('SELECT * FROM evaluation_tickets WHERE id = ?').get(ticketInfo.lastInsertRowid);
    assert.equal(buildReportContext(db, blankTicket).participants_table, '');
    const round1Attendees = [
      { name: 'Round 1 QA Lead', opening: true, closing: true },
      { name: 'Round 1 Supplier Rep', opening: true, closing: false },
    ];
    const attendees = [
      { name: 'Nguyen Van A - QA Lead', opening: true, closing: true },
      { name: 'Tran Thi B - NCC', opening: true, closing: false },
    ];
    db.prepare('UPDATE evaluation_rounds SET attendees_json = ? WHERE id = ?')
      .run(JSON.stringify(round1Attendees), round.lastInsertRowid);
    db.prepare('UPDATE evaluation_rounds SET attendees_json = ? WHERE id = ?')
      .run(JSON.stringify(attendees), round2.lastInsertRowid);
    db.prepare(`
      INSERT INTO evaluation_nonconformities (
        ticket_id, round_id, question_id, clause_code, category, nonconformity,
        remediation, due_date, severity, status, created_by
      )
      VALUES (?, ?, ?, 'R2-ONLY', 'Round 2', 'Round 2 issue must not appear',
        'Round 2 action', '2026-09-01', 'B', 'OPEN', 'admin@masangroup.com')
    `).run(ticketInfo.lastInsertRowid, round2.lastInsertRowid, q3);

    const ticket = db.prepare('SELECT * FROM evaluation_tickets WHERE id = ?').get(ticketInfo.lastInsertRowid);
    const context = buildReportContext(db, ticket);
    const round1Context = buildReportContext(db, ticket, { reportType: 'ROUND1_RESULT' });
    const round2Context = buildReportContext(db, ticket, { reportType: 'ROUND2_RESULT' });
    const minutesContext = buildReportContext(db, ticket, { reportType: 'WORKING_MINUTES' });

    assert.equal(round1Context.doc4.related_information.evaluation_date, '2026-07-15');
    assert.equal(minutesContext.doc4.related_information.evaluation_date, '2026-07-15');
    assert.notEqual(round1Context.doc4.related_information.evaluation_date, ticket.planned_date);
    assert.notEqual(minutesContext.doc4.related_information.evaluation_date, ticket.planned_date);
    const expectedEvaluators = 'Nguyen Van Auditor, Le Thi QA Support';
    [context, round1Context, round2Context, minutesContext].forEach((reportContext) => {
      assert.equal(reportContext.doc4.related_information.evaluators, expectedEvaluators);
      assert.deepEqual(reportContext.doc4.related_information.evaluator_list, ['Nguyen Van Auditor', 'Le Thi QA Support']);
      assert.equal(reportContext.doc4.signatures.evaluator, 'Nguyen Van Auditor');
      assert.equal(reportContext.evaluators, expectedEvaluators);
      assert.equal(reportContext.evaluator, 'Nguyen Van Auditor');
      assert.doesNotMatch(reportContext.doc4.related_information.evaluators, /admin@masangroup\.com|support@masangroup\.com/);
      assert.doesNotMatch(reportContext.doc4.related_information.evaluators, /\badmin\b|\bEvaluator\b/);
      assert.doesNotMatch(reportContext.doc4.signatures.evaluator, /@|\badmin\b|\bEvaluator\b/);
    });
    assert.equal(Object.keys(context.doc4.input_columns).length, 39);
    assert.equal(context.doc4.input_columns.AM.label, 'Phương thức đánh giá');
    assert.equal(context.doc4.input_columns.L.value, 'NCC-RPT');
    assert.equal(context.doc4.input_columns.AI.value, '2028-08-01');
    assert.equal(calculateNextEvaluationDate('2026-07-15', 75), '2027-01-15');
    assert.equal(calculateNextEvaluationDate('2026-07-15', 88), '2027-07-15');
    assert.equal(calculateNextEvaluationDate('2026-07-15', 91), '2028-07-15');

    const legal = context.doc4.compliance_summary.find((row) => row.category === 'Hồ sơ pháp lý');
    assert.ok(legal);
    assert.equal(legal.counts.A, 1);
    assert.equal(legal.counts.B, 1);
    assert.equal(legal.percentage, 87.5);
    const quality = context.doc4.compliance_summary.find((row) => row.category === 'Kiểm soát chất lượng sản phẩm');
    assert.equal(quality.percentage, 25);

    assert.equal(context.doc4.result_summary.final_score, 91);
    assert.equal(context.doc4.result_summary.final_grade, 'A');
    assert.equal(context.doc4.result_summary.final_conclusion, 'Đạt');
    assert.equal(context.doc4.input_columns.AJ.value, 'Đạt');
    assert.equal(context.doc4.result_summary.next_evaluation_date, '2028-08-01');
    assert.equal(context.doc4.related_information.evaluation_address, 'Audit Address');
    assert.equal(context.doc4.scope.product, 'Carrot');
    assert.equal(context.doc4.participants.qa_support[0], 'support@masangroup.com');
    assert.deepEqual(context.doc4.participants.rows, attendees);
    assert.deepEqual(context.doc4.participants.opening_meeting, ['Nguyen Van A - QA Lead', 'Tran Thi B - NCC']);
    assert.deepEqual(context.doc4.participants.closing_meeting, ['Nguyen Van A - QA Lead']);
    assert.match(context.participants_table, /Nguyen Van A - QA Lead \| \[x\] \| \[x\]/);
    assert.match(context.participants_table, /Tran Thi B - NCC \| \[x\] \| \[ \]/);
    assert.equal(context.doc4.supplier_introduction.content, 'Supplier intro line 1\nSupplier intro line 2');
    assert.equal(context.supplier_introduction, 'Supplier intro line 1\nSupplier intro line 2');
    assert.equal(round1Context.supplier_introduction, 'Supplier intro line 1\nSupplier intro line 2');
    assert.equal(round2Context.supplier_introduction, 'Supplier intro line 1\nSupplier intro line 2');
    const nccTemplate = db.prepare("SELECT * FROM report_templates WHERE template_name = 'NCC working minutes' AND report_type = 'NCC'").get();
    assert.match(nccTemplate.template_body, /\{\{participants_table\}\}/);
    assert.match(renderTemplate(nccTemplate.template_body, context), /Thành phần tham dự:\nTen\/Chuc danh \| Tham du hop khai mac \| Tham du hop be mac/);
    assert.equal(context.doc4.supplier_introduction.certificates.attp_certificate_type, 'HACCP');
    assert.equal(context.doc4.nonconformity_summary[0].corrective_action, 'Upload contract');
    assert.equal(context.doc4.signatures.approved_by, 'admin@masangroup.com');
    assert.ok(context.doc4_sections_json.includes('nonconformity_summary'));
    assert.equal(round1Context.round_no, 1);
    assert.equal(round1Context.doc4.result_summary.final_score, 70);
    assert.equal(round1Context.doc4.result_summary.corrected_score, null);
    assert.equal(round1Context.doc4.result_summary.correction_date, '');
    assert.equal(round1Context.doc4.result_summary.next_evaluation_date, '2027-01-15');
    assert.equal(round1Context.doc4.input_columns.AH.value, '');
    assert.equal(round2Context.round_no, 2);
    assert.equal(round2Context.doc4.result_summary.final_score, 91);
    assert.equal(minutesContext.round_no, 1);
    assert.equal(minutesContext.show_scores, false);
    assert.deepEqual(minutesContext.doc4.participants.rows, round1Attendees);
    assert.throws(
      () => buildReportContext(db, ticket, { reportType: 'WORKING_MINUTES', roundNo: 2 }),
      (error) => error.code === 'report_round_not_allowed'
    );
    const round1Html = renderInternalReportHtml(round1Context);
    const round2Html = renderInternalReportHtml(round2Context);
    [round1Html, round2Html].forEach((resultHtml) => {
      assert.match(resultHtml, /body\{[^}]*background:#fff/);
      assert.match(resultHtml, /\.sheet\{width:960px;max-width:calc\(100vw - 32px\);margin:18px auto;background:#fff;border:1px solid #000;padding-bottom:0\}/);
      assert.match(resultHtml, /table\{width:100%;border-collapse:collapse;border-spacing:0;table-layout:fixed/);
      assert.match(resultHtml, /<th class="no-col"><\/th><th class="name-col" rowspan="2">Tên\/Chức danh<\/th><th colspan="2">Tham dự \(√\)<\/th>/);
      assert.match(resultHtml, /<td class="center">1\.<\/td>\s*<td>(Round 1 QA Lead|Nguyen Van A - QA Lead)<\/td>/);
      assert.match(resultHtml, /<td class="center">3\.<\/td>\s*<td><\/td>/);
      assert.match(resultHtml, /@page\{size:A4 landscape;margin:8mm\}/);
      assert.match(resultHtml, /preserveAspectRatio="xMidYMid meet"/);
      assert.match(resultHtml, /viewBox="-28 -8 256 242"/);
      assert.doesNotMatch(resultHtml, /line-cell/);
      assert.doesNotMatch(resultHtml, /width:min\(1120px/);
      assert.doesNotMatch(resultHtml, /overflow:hidden/);
      assert.doesNotMatch(resultHtml, /\.radar\{[^}]*height:210px/);
      assert.doesNotMatch(resultHtml, /background:#f3f4f6|background:#e8e8e8|border-bottom:1px dashed/);
    });
    const minutesHtml = renderWorkingMinutesHtml(minutesContext);
    const round1ReportHtml = renderReportHtml(round1Context);
    const round2ReportHtml = renderReportHtml(round2Context);
    assert.match(minutesHtml, /Biên bản làm việc với NCC/);
    assert.match(minutesHtml, /Round 1 QA Lead/);
    assert.match(minutesHtml, /Supplier intro line 1/);
    assert.match(round1Html, /Supplier intro line 1/);
    assert.match(round2Html, /Supplier intro line 1/);
    assert.doesNotMatch(minutesHtml, /Nguyen Van A - QA Lead|Round 2 issue must not appear/);
    [minutesHtml, round1ReportHtml, round2ReportHtml].forEach((reportHtml) => {
      assert.match(reportHtml, /Nguyen Van Auditor/);
      assert.doesNotMatch(reportHtml, /Nguyen Van Auditor, Evaluator/);
      assert.doesNotMatch(reportHtml, /<tr><th>Người đánh giá<\/th><td>[^<]*(admin@masangroup\.com|support@masangroup\.com|\badmin\b|\bEvaluator\b)/);
      assert.doesNotMatch(reportHtml, /<tr class="sign"><td>[^<]*(admin@masangroup\.com|support@masangroup\.com|\badmin\b|\bEvaluator\b)/);
      assert.doesNotMatch(reportHtml, /Đánh giá viên:[\s\S]{0,120}(admin@masangroup\.com|support@masangroup\.com|\badmin\b|\bEvaluator\b)/);
    });
    assert.doesNotMatch(minutesHtml, /Điểm cuối|Tỷ lệ|phân hạng|70\.0%|91\.0%|Đạt mức cao/);
    db.prepare('UPDATE evaluation_tickets SET actual_evaluation_date = NULL WHERE id = ?').run(ticketInfo.lastInsertRowid);
    const legacyTicket = db.prepare('SELECT * FROM evaluation_tickets WHERE id = ?').get(ticketInfo.lastInsertRowid);
    assert.equal(buildReportContext(db, legacyTicket, { reportType: 'WORKING_MINUTES' }).doc4.related_information.evaluation_date, '2026-07-15');
    assert.equal(buildReportContext(db, legacyTicket, { reportType: 'ROUND1_RESULT' }).doc4.related_information.evaluation_date, '2026-07-15');
  } finally {
    db.close();
    delete require.cache[require.resolve('../server/db')];
    if (oldDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = oldDbPath;
    if (oldJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldJwtSecret;
    fs.rmSync(dbPath, { force: true });
  }
});

test('report exports create streamable XLSX, HTML, and PDF artifacts with metadata records', async () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-report-export-test-${Date.now()}-${Math.random()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const oldJwtSecret = process.env.JWT_SECRET;
  const db = freshDb(dbPath);
  let server;
  try {
    for (const modulePath of ['../server/middleware/auth', '../server/routes/evaluations']) {
      delete require.cache[require.resolve(modulePath)];
    }
    const { signToken } = require('../server/middleware/auth');
    const evaluationsRouter = require('../server/routes/evaluations');
    const { exportReportHtml, exportReportPdf, exportReportXlsx } = require('../server/services/reporting');

    db.prepare(`
      INSERT INTO users (email, is_admin, role, is_active)
      VALUES ('admin@masangroup.com', 1, 'Admin', 1)
      ON CONFLICT(email) DO UPDATE SET is_admin=1, role='Admin', is_active=1
    `).run();
    const supplier = db.prepare(`
      INSERT INTO supplier_master (supplier_code, supplier_name, status, source_type)
      VALUES ('NCC-EXP', 'Export Supplier', 'ACTIVE', 'MANUAL')
    `).run();
    const templateRow = db.prepare(`
      INSERT INTO question_templates (template_code, template_name, active)
      VALUES ('EXP', 'Export Test', 1)
    `).run();
    const ticketInfo = db.prepare(`
      INSERT INTO evaluation_tickets (
        ticket_code, supplier_id, supplier_code, supplier_name, evaluation_type, template_id,
        facility_type, supplier_scale, planned_date, actual_evaluation_date, current_status,
        current_round_no, completed_round, score_percent, grade_code, result_label,
        supplier_introduction, assigned_specialist_id, created_by
      )
      VALUES (
        'TICKET-EXP', @supplier_id, 'NCC-EXP', 'Export Supplier', 'Định kỳ', @template_id,
        'CHUNG', 'LARGE', '2026-07-15', '2026-07-15', 'Hoàn thành',
        1, 1, 92, 'A', 'Đạt mức cao',
        @supplier_introduction, 'admin@masangroup.com', 'admin@masangroup.com'
      )
    `).run({
      supplier_id: supplier.lastInsertRowid,
      template_id: templateRow.lastInsertRowid,
      supplier_introduction: 'Export supplier introduction for reports',
    });
    const attendees = [
      { name: 'Nguyen Van A - QA Lead', opening: true, closing: true },
      { name: 'Tran Thi B - NCC', opening: false, closing: true },
      { name: 'Le Van C - QA', opening: true, closing: false },
      { name: 'Pham Thi D - NCC', opening: true, closing: true },
      { name: 'Hoang Van E - QA', opening: false, closing: true },
      { name: 'Do Thi F - NCC', opening: true, closing: false },
      { name: 'Le Van G - QA', opening: true, closing: true },
    ];
    const roundInfo = db.prepare(`
      INSERT INTO evaluation_rounds (ticket_id, round_no, assessment_code, assessment_date, status, completed_at, attendees_json)
      VALUES (?, 1, 'TICKET-EXP-R1', '2026-07-15', 'Hoan thanh', '2026-07-15', ?)
    `).run(ticketInfo.lastInsertRowid, JSON.stringify(attendees));
    const insertFinding = db.prepare(`
      INSERT INTO evaluation_nonconformities (
        ticket_id, round_id, clause_code, category, nonconformity,
        remediation, due_date, severity, status, created_by
      )
      VALUES (?, ?, ?, 'Export category', ?, ?, ?, 'B', 'OPEN', 'admin@masangroup.com')
    `);
    for (let index = 1; index <= 12; index += 1) {
      insertFinding.run(
        ticketInfo.lastInsertRowid,
        roundInfo.lastInsertRowid,
        `NC-${String(index).padStart(2, '0')}`,
        `Finding ${index}`,
        `Action ${index}`,
        `2026-08-${String(index).padStart(2, '0')}`
      );
    }
    const template = db.prepare(`
      INSERT INTO report_templates (template_name, report_type, template_body, active)
      VALUES ('Export Template', 'INTERNAL', 'Kết quả {{evaluation_result}}\nTicket {{ticket_code}}\n{{doc4_sections_json}}', 1)
    `).run();
    const ticket = db.prepare('SELECT * FROM evaluation_tickets WHERE id = ?').get(ticketInfo.lastInsertRowid);
    const reportTemplate = db.prepare('SELECT * FROM report_templates WHERE id = ?').get(template.lastInsertRowid);

    const xlsxExport = exportReportXlsx(db, { ticket, template: reportTemplate, exportedBy: 'admin@masangroup.com' });
    const htmlExport = exportReportHtml(db, { ticket, template: reportTemplate, exportedBy: 'admin@masangroup.com' });
    const pdfExport = exportReportPdf(db, { ticket, template: reportTemplate, exportedBy: 'admin@masangroup.com' });

    const rows = db.prepare('SELECT * FROM report_exports WHERE ticket_id = ? ORDER BY id').all(ticket.id);
    assert.deepEqual(rows.map((row) => row.file_format), ['XLSX', 'HTML', 'PDF']);
    assert.ok(rows.every((row) => row.ticket_id === ticket.id));
    assert.ok(rows.every((row) => row.report_template_id === reportTemplate.id));
    assert.ok(rows.every((row) => !path.isAbsolute(row.file_path)));
    assert.ok(Buffer.isBuffer(xlsxExport.buffer));
    assert.ok(Buffer.isBuffer(htmlExport.buffer));
    assert.ok(Buffer.isBuffer(pdfExport.buffer));
    assert.equal(xlsxExport.file_path, xlsxExport.file_name);
    assert.equal(htmlExport.file_path, htmlExport.file_name);
    assert.equal(pdfExport.file_path, pdfExport.file_name);
    const html = htmlExport.buffer.toString('utf8');
    assert.ok(html.includes('KẾT QUẢ ĐÁNH GIÁ NHÀ CUNG CẤP'));
    assert.ok(html.includes('Nguyen Van A - QA Lead'));
    assert.ok(html.includes('Tran Thi B - NCC'));
    assert.ok(html.includes('Export supplier introduction for reports'));
    assert.ok(html.includes('&#10003;'));
    assert.equal(pdfExport.buffer.subarray(0, 4).toString('utf8'), '%PDF');

    const wb = XLSX.read(xlsxExport.buffer, { type: 'buffer', cellStyles: true });
    assert.ok(wb.SheetNames.includes('1. Nhap data'));
    assert.ok(wb.SheetNames.includes('2. Ket qua'));
    const inputRows = XLSX.utils.sheet_to_json(wb.Sheets['1. Nhap data'], { header: 1 });
    assert.deepEqual(inputRows[0], ['Column', 'DOC-4 label', 'Value']);
    assert.ok(inputRows.some((row) => row[0] === 'AM' && row[1] === 'Phương thức đánh giá'));
    const resultSheet = wb.Sheets['2. Ket qua'];
    assert.deepEqual((resultSheet['!cols'] || []).map((col) => col.wch), [28, 58, 40]);
    assert.ok((resultSheet['!merges'] || []).some((merge) => merge.s.r === 0 && merge.s.c === 0 && merge.e.c === 2));
    assert.equal(resultSheet['!margins'].left, 0.25);
    assert.equal(resultSheet['!margins'].right, 0.25);
    const resultRows = XLSX.utils.sheet_to_json(resultSheet, { header: 1 });
    assert.ok(resultRows.some((row) => row[0] === 'Nguyen Van A - QA Lead' && row[1] === 'x' && row[2] === 'x'));
    assert.ok(resultRows.some((row) => row[0] === 'Tran Thi B - NCC' && (row[1] || '') === '' && row[2] === 'x'));

    const workingTemplate = db.prepare("SELECT * FROM report_templates WHERE report_type = 'WORKING_MINUTES' AND active = 1").get();
    const workingXlsxExport = exportReportXlsx(db, {
      ticket,
      template: workingTemplate,
      reportType: 'WORKING_MINUTES',
      exportedBy: 'admin@masangroup.com',
      legacyCompatibility: true,
    });
    assert.equal(workingXlsxExport.round_no, 1);
    assert.equal(workingXlsxExport.report_type, 'WORKING_MINUTES');
    const workingWb = XLSX.read(workingXlsxExport.buffer, { type: 'buffer' });
    assert.deepEqual(workingWb.SheetNames, ['1. Biên bản làm việc với NCC']);
    const workingSheet = workingWb.Sheets['1. Biên bản làm việc với NCC'];
    assert.equal(workingSheet.G4.v, 'TICKET-EXP-R1');
    assert.equal(workingSheet.P4.v, '15/07/2026');
    assert.equal(workingSheet.C12.v, 'Export Supplier - NCC-EXP');
    assert.equal(workingSheet.C25.v, 'Nguyen Van A - QA Lead');
    assert.equal(workingSheet.L25.v, '√');
    assert.equal(workingSheet.O25.v, '√');
    assert.equal(workingSheet.C31.v, 'Le Van G - QA');
    assert.equal(workingSheet.L31.v, '√');
    assert.equal(workingSheet.O31.v, '√');
    assert.equal(workingSheet.B34.v, 'Export supplier introduction for reports');
    assert.equal(workingSheet.C49.v, 'NC-12 - Export category');
    assert.equal(workingSheet.D49.v, 'Finding 12');
    assert.match(workingSheet.B50.v, /Đánh giá viên:/);
    assert.doesNotMatch(workingSheet.B50.v, /admin@masangroup\.com|\badmin\b/);
    const workingRows = XLSX.utils.sheet_to_json(workingSheet, { header: 1 });
    const workingText = workingRows.flat().filter(Boolean).join(' ');

    const appInfo = await startApp(evaluationsRouter);
    server = appInfo.server;
    const token = signToken({ email: 'admin@masangroup.com', isAdmin: true, role: 'Admin' }, 3600);
    const directRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-EXP/reports/export-print`, {
      method: 'POST',
      headers: {
        Cookie: `qlcl_token=${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ report_type: 'INTERNAL', round_no: 1 }),
    });
    assert.equal(directRes.status, 200);
    assert.match(directRes.headers.get('content-type') || '', /text\/html/);
    assert.match(directRes.headers.get('content-disposition') || '', /attachment/);
    assert.match(directRes.headers.get('content-disposition') || '', /TICKET-EXP-R1/);
    const directExportId = Number(directRes.headers.get('x-export-id'));
    assert.ok(directExportId > 0);
    assert.match(await directRes.text(), /Export Supplier/);
    const directRecord = db.prepare('SELECT * FROM report_exports WHERE id = ?').get(directExportId);
    assert.equal(directRecord.exported_by, 'admin@masangroup.com');
    assert.equal(path.isAbsolute(directRecord.file_path), false);
    assert.equal(fs.existsSync(path.join(require('../server/services/reporting').EXPORT_DIR, directRecord.file_path)), false);
    assert.match(workingText, /Biên bản làm việc với NCC/);
    assert.doesNotMatch(workingText, /Điểm lần|Điểm cuối|Tỷ lệ|Classification|92|Đạt mức cao|Kết luận/);


  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
    for (const modulePath of ['../server/db', '../server/middleware/auth', '../server/routes/evaluations']) {
      delete require.cache[require.resolve(modulePath)];
    }
    if (oldDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = oldDbPath;
    if (oldJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldJwtSecret;
    fs.rmSync(dbPath, { force: true });
  }
});
