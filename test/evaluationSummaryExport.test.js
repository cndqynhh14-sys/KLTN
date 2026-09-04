const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { canonicalTokenFactory } = require('./helpers/canonicalAuth');
const { upsertCanonicalUser } = require('./helpers/canonicalUser');
const XLSX = require('xlsx');

const SUMMARY_HEADERS = [
  'STT',
  'Năm',
  'Tháng đánh giá ',
  'Ngành hàng MCH2',
  'Ngành hàng MCH3',
  'CMC phụ trách ngành hàng',
  'CMC Trưởng phòng ngành hàng',
  'Khu vực',
  'Tỉnh',
  'Loại hình đánh giá',
  'Loại hình kinh doanh',
  'Mã NCC',
  'Tên NCC chính',
  'Địa chỉ đánh giá NCC',
  'Địa chỉ đánh giá đơn vị liên kết/gia công',
  'Người liên hệ',
  'Số điện thoại liên hệ',
  'Email',
  'Sản phẩm đánh giá (nếu đánh giá nhiêu sản phẩm thì liệt kê danh sách vào biên bản đánh giá)',
  'QA lead đánh giá',
  'QA hỗ trợ',
  'Bộ phận đánh giá',
  'Ngày ĐG thực tế\n(MM/DD/YY)',
  'Điểm đánh giá lần 1 (%)',
  'Kết luận lần 1',
  'Lỗi vi phạm điều khoản pháp lý',
  'Nội dung lỗi vi phạm điều khoản pháp lý',
  'Lỗi kiểm soát chất lượng',
  'Nội dung lỗi kiểm soát chất lượng',
  'Lỗi truy xuất nguồn gốc SP',
  'Nội dung lỗi truy xuất nguồn gốc SP',
  'Lỗi an toàn vệ sinh thực phẩm',
  'Nội dung lỗi an toàn vệ sinh thực phẩm',
  'Điểm đánh giá sau khắc phục (%)',
  'Kết luận sau khắc phục',
  'Lý do điều chỉnh kết quả điểm',
  'Ngày khắc phục (nếu có sự điều chỉnh về kết quả điểm)\n(mm/dd/yy)',
  'Kế hoạch đánh giá tiếp theo\n(mm/dd/yy)',
  'Kết luận',
  'Ghi chú',
  'Đạt',
  'Không đạt',
  'Chờ kết luận',
  'Map1',
];

function createSummaryTemplate(filePath) {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([
    ['THÔNG TIN CHUNG'],
    ['Tăng dần'],
    SUMMARY_HEADERS,
    new Array(SUMMARY_HEADERS.length).fill(''),
    ['sample row that should be removed'],
  ]);
  worksheet['!autofilter'] = { ref: 'A3:AR3' };
  worksheet['!ref'] = 'A1:AR5';
  XLSX.utils.book_append_sheet(workbook, worksheet, 'file chi tiết KQ đánh giá');
  XLSX.writeFile(workbook, filePath);
}

function freshModules(dbPath, templatePath, exportDir) {
  process.env.DB_PATH = dbPath;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  process.env.EVALUATION_SUMMARY_TEMPLATE_PATH = templatePath;
  process.env.REPORT_EXPORT_DIR = exportDir;
  for (const modulePath of [
    '../server/config/paths',
    '../server/db',
    '../server/middleware/auth',
    '../server/services/evaluationSummaryExport',
    '../server/routes/evaluations',
  ]) {
    delete require.cache[require.resolve(modulePath)];
  }
  const dbModule = require('../server/db');
  const auth = require('../server/middleware/auth');
  const evaluationsRouter = require('../server/routes/evaluations');
  return { ...dbModule, ...auth, signToken: canonicalTokenFactory(dbModule, auth), evaluationsRouter };
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

test('evaluation summary route exports filtered rows using template columns and rejects empty exports', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-summary-export-'));
  const dbPath = path.join(tempDir, 'qlcl.db');
  const templatePath = path.join(tempDir, 'summary-template.xlsx');
  const exportDir = path.join(tempDir, 'exports');
  createSummaryTemplate(templatePath);

  const oldDbPath = process.env.DB_PATH;
  const oldJwtSecret = process.env.JWT_SECRET;
  const oldTemplatePath = process.env.EVALUATION_SUMMARY_TEMPLATE_PATH;
  const oldReportExportDir = process.env.REPORT_EXPORT_DIR;
  const { db, signToken, evaluationsRouter } = freshModules(dbPath, templatePath, exportDir);
  let server;

  try {
    upsertCanonicalUser(db, { email: 'admin@masangroup.com', role: 'Admin', isAdmin: true });
    upsertCanonicalUser(db, { email: 'qa.lead@masangroup.com', role: 'Chuyên viên' });
    const supplier = db.prepare(`
      INSERT INTO supplier_master (
        supplier_code, supplier_name, address, region, province, business_type,
        contact_name, contact_email, contact_phone, status, source_type
      )
      VALUES (
        'NCC-SUM', 'Summary Supplier', 'HQ Address', 'MN', 'TPHCM', 'Sản xuất',
        'Supplier Contact', 'contact@example.com', '0900000000', 'ACTIVE', 'MANUAL'
      )
    `).run();
    const otherSupplier = db.prepare(`
      INSERT INTO supplier_master (supplier_code, supplier_name, status, source_type)
      VALUES ('NCC-OTHER', 'Other Supplier', 'ACTIVE', 'MANUAL')
    `).run();
    const template = db.prepare(`
      INSERT INTO question_templates (template_code, template_name, active)
      VALUES ('SUMT', 'Summary Template', 1)
    `).run();
    const version = db.prepare(`INSERT INTO question_template_versions
      (template_id, version_no, status, checksum, lock_version, created_by)
      VALUES (?, 1, 'DRAFT', ?, 1, 'fixture')`).run(template.lastInsertRowid, 'e'.repeat(64));
    const insertQuestion = db.prepare(`
      INSERT INTO question_items (
        question_template_version_id, facility_type, supplier_scale, question_code, question_text, category, order_index, active
      )
      VALUES (?, 'CHUNG', 'LARGE', ?, ?, ?, ?, 1)
    `);
    const legalQuestion = insertQuestion.run(version.lastInsertRowid, 'LEGAL-01', 'Legal document complete', 'Hồ sơ pháp lý', 1).lastInsertRowid;
    const qualityQuestion = insertQuestion.run(version.lastInsertRowid, 'QUALITY-01', 'Quality control records', 'Kiểm soát chất lượng', 2).lastInsertRowid;
    db.prepare("UPDATE question_template_versions SET status='PUBLISHED' WHERE id=?").run(version.lastInsertRowid);

    const ticket = db.prepare(`
      INSERT INTO evaluation_tickets (
        ticket_code, supplier_id, supplier_code, supplier_name, snapshot_evaluation_address, snapshot_linked_facility_address,
        region, province, business_type, cmc_owner, cmc_head, contact_name, contact_email, contact_phone,
        mch2, mch3, product_group, snapshot_product_name, evaluation_type, template_id,
        question_template_version_id, facility_type, supplier_scale,
        evaluation_method, evaluation_department,
        planned_date, actual_evaluation_date, current_status, current_round_no, completed_round,
        score_percent, grade_code, result_label, corrected_score_percent, corrected_grade_code,
        corrected_result_label, correction_date, next_evaluation_date, final_conclusion, specialist_proposal,
        result_reason, assigned_specialist_id, created_by, created_at
      )
      VALUES (
        'TICKET-SUM', @supplier_id, 'NCC-SUM', 'Summary Supplier', 'Ticket Audit Site', 'Ticket Linked Site',
        'MN', 'TPHCM', 'Sản xuất', 'CMC Owner', 'CMC Head', 'Supplier Contact', 'contact@example.com', '0900000000',
        'Thực phẩm tươi sống, chế biến', 'Rau củ', 'Rau', 'Cà rốt', 'Đánh giá định kỳ', @template_id, @version_id, 'CHUNG', 'LARGE',
        'Onsite', 'QA NCC',
        '2026-04-19', '2026-04-20', 'Hoàn thành', 2, 2,
        72.5, 'C', 'Đạt mức cơ bản và tái đánh giá sau 6 tháng', 87.5, 'B',
        'Đạt mức trung bình và tái đánh giá sau 1 năm', '2026-05-01', '2027-04-20', 'Đạt', 'Approve supplier',
        'Supplier corrected findings',
        (SELECT user_id FROM users WHERE email='qa.lead@masangroup.com'),
        (SELECT user_id FROM users WHERE email='qa.lead@masangroup.com'), '2026-04-18 08:00:00'
      )
    `).run({
      supplier_id: supplier.lastInsertRowid,
      template_id: template.lastInsertRowid,
      version_id: version.lastInsertRowid,
    });
    const insertTicketParticipant = db.prepare(`INSERT INTO evaluation_participants
      (ticket_id, user_id, display_name, participant_role, assigned_by)
      VALUES (?, ?, ?, ?, (SELECT user_id FROM users WHERE email='qa.lead@masangroup.com'))`);
    insertTicketParticipant.run(ticket.lastInsertRowid, null, 'Evaluator A', 'EVALUATOR');
    insertTicketParticipant.run(ticket.lastInsertRowid,
      db.prepare("SELECT user_id FROM users WHERE email='qa.lead@masangroup.com'").pluck().get(), 'QA Lead', 'QA_LEAD');
    insertTicketParticipant.run(ticket.lastInsertRowid, null, 'qa.support@masangroup.com', 'QA_SUPPORT');
    const otherTicket = db.prepare(`
      INSERT INTO evaluation_tickets (
        ticket_code, supplier_id, supplier_code, supplier_name, evaluation_type, template_id,
        question_template_version_id,
        facility_type, supplier_scale, mch2, mch3, planned_date, current_status,
        current_round_no, completed_round, created_by
      )
      VALUES (
        'TICKET-OTHER', @supplier_id, 'NCC-OTHER', 'Other Supplier', 'Đánh giá định kỳ', @template_id, @version_id,
        'CHUNG', 'LARGE', 'Thực phẩm công nghệ', 'Bánh kẹo', '2026-04-20', 'Hoàn thành',
        1, 1, (SELECT user_id FROM users WHERE email='admin@masangroup.com')
      )
    `).run({ supplier_id: otherSupplier.lastInsertRowid, template_id: template.lastInsertRowid, version_id: version.lastInsertRowid });

    const round1 = db.prepare(`
      INSERT INTO evaluation_rounds (ticket_id, round_no, assessment_code, assessment_date, status, total_score, final_result, classification)
      VALUES (?, 1, 'TICKET-SUM-R1', '2026-04-20', 'Hoàn thành', 72.5, 'Đạt mức cơ bản và tái đánh giá sau 6 tháng', 'C')
    `).run(ticket.lastInsertRowid);
    const round2 = db.prepare(`
      INSERT INTO evaluation_rounds (ticket_id, round_no, assessment_code, assessment_date, status, total_score, final_result, classification)
      VALUES (?, 2, 'TICKET-SUM-R2', '2026-05-01', 'Hoàn thành', 87.5, 'Đạt mức trung bình và tái đánh giá sau 1 năm', 'B')
    `).run(ticket.lastInsertRowid);
    db.prepare(`
      INSERT INTO evaluation_rounds (ticket_id, round_no, status)
      VALUES (?, 1, 'Hoàn thành')
    `).run(otherTicket.lastInsertRowid);
    const insertAnswer = db.prepare(`INSERT INTO evaluation_answers
      (round_id, question_item_id, score, comment, calculated_score, answered_by)
      VALUES (?, ?, ?, 'Summary finding', 75, (SELECT user_id FROM users WHERE email='admin@masangroup.com'))`);
    const legalAnswer = insertAnswer.run(round1.lastInsertRowid, legalQuestion, 'B').lastInsertRowid;
    const qualityAnswer = insertAnswer.run(round1.lastInsertRowid, qualityQuestion, 'C').lastInsertRowid;
    const round2Answer = insertAnswer.run(round2.lastInsertRowid, qualityQuestion, 'B').lastInsertRowid;
    db.prepare(`
      INSERT INTO evaluation_nonconformities (
        ticket_id, round_id, evaluation_answer_id, clause_code, category, nonconformity_content, severity, status, created_by
      )
      VALUES (?, ?, ?, 'LEGAL-01', 'Hồ sơ pháp lý', 'Missing business license appendix', 'B', 'OPEN', (SELECT user_id FROM users WHERE email='admin@masangroup.com'))
    `).run(ticket.lastInsertRowid, round1.lastInsertRowid, legalAnswer);
    db.prepare(`
      INSERT INTO evaluation_nonconformities (
        ticket_id, round_id, evaluation_answer_id, clause_code, category, nonconformity_content, severity, status, created_by
      )
      VALUES (?, ?, ?, 'QUALITY-01', 'Kiểm soát chất lượng', 'Quality control checklist incomplete', 'C', 'OPEN', (SELECT user_id FROM users WHERE email='admin@masangroup.com'))
    `).run(ticket.lastInsertRowid, round1.lastInsertRowid, qualityAnswer);
    db.prepare(`
      INSERT INTO evaluation_nonconformities (
        ticket_id, round_id, evaluation_answer_id, clause_code, category, nonconformity_content, severity, status, created_by
      )
      VALUES (?, ?, ?, 'R2-ONLY', 'Kiểm soát chất lượng', 'Round 2 issue must not appear', 'B', 'OPEN', (SELECT user_id FROM users WHERE email='admin@masangroup.com'))
    `).run(ticket.lastInsertRowid, round2.lastInsertRowid, round2Answer);

    const appInfo = await startApp(evaluationsRouter);
    server = appInfo.server;
    const token = signToken({ email: 'admin@masangroup.com', isAdmin: true, role: 'Admin' }, 3600);
    const res = await fetch(`${appInfo.baseUrl}/evaluations/export-summary`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `qlcl_token=${token}`,
      },
      body: JSON.stringify({
        filters: {
          q: 'NCC-SUM',
          dateType: 'planned_at',
          from: '2026-04-01',
          to: '2026-04-30',
          type: 'Đánh giá định kỳ',
          status: 'Hoàn thành',
          mch2: 'Thực phẩm tươi sống, chế biến',
          mch3: 'Rau củ',
        },
        sort: { field: 'supplier_name', dir: 'asc' },
      }),
    });
    const buffer = Buffer.from(await res.arrayBuffer());
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') || '', /B%C3%A1o%20c%C3%A1o%20%C4%91%C3%A1nh%20gi%C3%A1%20NCC\.xlsx/);
    assert.equal(res.headers.get('x-export-row-count'), '1');

    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const worksheet = workbook.Sheets['file chi tiết KQ đánh giá'];
    assert.ok(worksheet);
    assert.equal(worksheet['!ref'], 'A1:AR4');
    assert.equal(worksheet.A4.v, 1);
    assert.equal(worksheet.B4.v, 2026);
    assert.equal(worksheet.C4.v, 'Tháng 04');
    assert.equal(worksheet.D4.v, 'Thực phẩm tươi sống, chế biến');
    assert.equal(worksheet.E4.v, 'Rau củ');
    assert.equal(worksheet.L4.v, 'NCC-SUM');
    assert.equal(worksheet.M4.v, 'Summary Supplier');
    assert.equal(worksheet.N4.v, 'Ticket Audit Site');
    assert.equal(worksheet.O4.v, 'Ticket Linked Site');
    assert.equal(worksheet.S4.v, 'Cà rốt');
    assert.equal(worksheet.T4.v, 'QA Lead');
    assert.equal(worksheet.U4.v, 'qa.support@masangroup.com');
    assert.equal(worksheet.X4.v, 0.725);
    assert.equal(worksheet.Y4.v, 'Đạt mức cơ bản và tái đánh giá sau 6 tháng');
    assert.equal(worksheet.Z4.v, 'Hồ sơ pháp lý');
    assert.equal(worksheet.AA4.v, 'Missing business license appendix');
    assert.equal(worksheet.AB4.v, 'Kiểm soát chất lượng');
    assert.equal(worksheet.AC4.v, 'Quality control checklist incomplete');
    assert.equal(worksheet.AH4.v, 0.875);
    assert.equal(worksheet.AI4.v, 'Đạt mức trung bình và tái đánh giá sau 1 năm');
    assert.equal(worksheet.AJ4.v, 'Supplier corrected findings');
    assert.equal(worksheet.AM4.v, 'Đạt');
    assert.equal(worksheet.AN4.v, 'Approve supplier');
    assert.equal(worksheet.AO4.v, 1);
    assert.equal(worksheet.AP4.v, 0);
    assert.equal(worksheet.AQ4.v, 0);
    assert.equal(worksheet.AR4.v, 'NCC-SUMRau củ');
    const exportedText = XLSX.utils.sheet_to_csv(worksheet);
    assert.doesNotMatch(exportedText, /Other Supplier|sample row that should be removed|Round 2 issue must not appear/);

    const specialistToken = signToken({ email: 'qa.lead@masangroup.com', isAdmin: false, role: 'Chuyên viên' }, 3600);
    const specialistRes = await fetch(`${appInfo.baseUrl}/evaluations/export-summary`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `qlcl_token=${specialistToken}`,
      },
      body: JSON.stringify({
        filters: {
          dateType: 'planned_at',
          from: '2026-04-01',
          to: '2026-04-30',
        },
        sort: { field: 'supplier_name', dir: 'asc' },
      }),
    });
    assert.equal(specialistRes.status, 200);
    assert.equal(specialistRes.headers.get('x-export-row-count'), '1');
    const specialistWorkbook = XLSX.read(Buffer.from(await specialistRes.arrayBuffer()), { type: 'buffer' });
    const specialistText = XLSX.utils.sheet_to_csv(specialistWorkbook.Sheets['file chi tiết KQ đánh giá']);
    assert.match(specialistText, /Summary Supplier/);
    assert.doesNotMatch(specialistText, /Other Supplier/);

    const noData = await fetch(`${appInfo.baseUrl}/evaluations/export-summary`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `qlcl_token=${token}`,
      },
      body: JSON.stringify({ filters: { mch3: 'Không tồn tại' } }),
    });
    assert.equal(noData.status, 404);
    assert.deepEqual(await noData.json(), { error: 'no_matching_evaluations' });
    assert.equal(fs.readdirSync(exportDir).filter((name) => name.endsWith('.xlsx')).length, 0);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
    delete require.cache[require.resolve('../server/db')];
    delete require.cache[require.resolve('../server/config/paths')];
    delete require.cache[require.resolve('../server/services/evaluationSummaryExport')];
    if (oldDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = oldDbPath;
    if (oldJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldJwtSecret;
    if (oldTemplatePath === undefined) delete process.env.EVALUATION_SUMMARY_TEMPLATE_PATH;
    else process.env.EVALUATION_SUMMARY_TEMPLATE_PATH = oldTemplatePath;
    if (oldReportExportDir === undefined) delete process.env.REPORT_EXPORT_DIR;
    else process.env.REPORT_EXPORT_DIR = oldReportExportDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
