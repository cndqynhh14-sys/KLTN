const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { canonicalTokenFactory } = require('./helpers/canonicalAuth');
const { upsertCanonicalUser } = require('./helpers/canonicalUser');

function freshModules(dbPath) {
  process.env.DB_PATH = dbPath;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  for (const modulePath of [
    '../server/db',
    '../server/middleware/auth',
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

const REQUIRED_ATTENDEES = [
  { name: 'Nguyen Van A - QA', opening: true, closing: true },
];
const REQUIRED_SUPPLIER_INTRODUCTION = 'Supplier introduction for assessment reports';

function insertCanonicalQuestionSet(db, templateId, rows) {
  const versionId = Number(db.prepare(`INSERT INTO question_template_versions
    (template_id, version_no, status, checksum, lock_version, created_by)
    VALUES (?, 1, 'DRAFT', ?, 1, 'fixture')`).run(templateId, 'c'.repeat(64)).lastInsertRowid);
  const insert = db.prepare(`INSERT INTO question_items
    (question_template_version_id, facility_type, supplier_scale, question_code,
     question_text, category, order_index, is_critical_clause, active)
    VALUES (?, 'CHUNG', 'LARGE', ?, ?, ?, ?, ?, 1)`);
  const ids = rows.map((row) => Number(insert.run(
    versionId, row.code, row.text, row.category, row.order, row.critical ? 1 : 0
  ).lastInsertRowid));
  db.prepare(`INSERT INTO question_template_variants
    (question_template_version_id, facility_type, supplier_scale, active)
    VALUES (?, 'CHUNG', 'LARGE', 1)`).run(versionId);
  db.prepare("UPDATE question_template_versions SET status='PUBLISHED' WHERE id=?").run(versionId);
  db.prepare(`INSERT INTO question_template_assignments
    (template_id, question_template_version_id, facility_type, supplier_scale,
     effective_from, is_default, active, created_by)
    VALUES (?, ?, 'CHUNG', 'LARGE', '1970-01-01', 1, 1, 'fixture')`).run(templateId, versionId);
  return { ids, versionId };
}

test('ticket creation snapshots selected supplier fields while keeping editable evaluation fields', async () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-ticket-test-${Date.now()}-${Math.random()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const oldJwtSecret = process.env.JWT_SECRET;
  const { db, signToken, evaluationsRouter } = freshModules(dbPath);
  let server;

  try {
    upsertCanonicalUser(db, { email: 'admin@masangroup.com', role: 'Admin', isAdmin: true });
    const supplierInfo = db.prepare(`
      INSERT INTO supplier_master (
        supplier_code, supplier_name, tax_code, address, region, province, business_type,
        contact_name, contact_email, contact_phone,
        status, source_type, created_by
      )
      VALUES (
        'NCC-AUTO', 'Auto Supplier', 'TAX-1', 'Supplier HQ',
        'MB', 'Thành phố Hà Nội', 'Tự sản xuất',
        'Nguyen Van A', 'supplier@example.com', '0900000000',
        'ACTIVE', 'MANUAL', 'admin@masangroup.com'
      )
    `).run();

    const appInfo = await startApp(evaluationsRouter);
    server = appInfo.server;
    const token = signToken({ email: 'admin@masangroup.com', isAdmin: true, role: 'Admin' }, 3600);
    const tokenClaims = jwt.decode(token);
    assert.equal(tokenClaims.sub, 'admin@masangroup.com');
    assert.equal(typeof tokenClaims.sid, 'string');
    assert.equal(Number.isInteger(tokenClaims.av), true);
    for (const forbiddenClaim of ['email', 'isAdmin', 'role', 'displayName', 'permissions']) {
      assert.equal(Object.hasOwn(tokenClaims, forbiddenClaim), false, `JWT must not contain ${forbiddenClaim}`);
    }

    const invalidMasterDataRes = await fetch(`${appInfo.baseUrl}/evaluations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `qlcl_token=${token}`,
      },
      body: JSON.stringify({
        supplier_id: supplierInfo.lastInsertRowid,
        evaluation_type: 'Đánh giá định kỳ',
        template: 'BM04',
        facility_type: 'CHUNG',
        supplier_scale: 'LARGE',
        evaluation_method: 'Online',
        planned_date: '2026-07-01',
        region: 'MB',
        province: 'Thành phố Hồ Chí Minh',
        business_type: 'Sản xuất',
        mch2: 'Thực phẩm công nghệ',
        mch3: 'Thực phẩm khô',
      }),
    });
    const invalidMasterDataJson = await invalidMasterDataRes.json();
    assert.equal(invalidMasterDataRes.status, 400, JSON.stringify(invalidMasterDataJson));
    assert.equal(invalidMasterDataJson.error, 'validation_failed');
    assert.deepEqual(invalidMasterDataJson.errors, ['province_invalid', 'business_type_invalid']);

    const res = await fetch(`${appInfo.baseUrl}/evaluations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `qlcl_token=${token}`,
      },
      body: JSON.stringify({
        supplier_id: supplierInfo.lastInsertRowid,
        evaluation_type: 'Đánh giá định kỳ',
        template: 'BM04',
        facility_type: 'CHUNG',
        supplier_scale: 'LARGE',
        evaluation_method: 'Online',
        planned_date: '2026-07-01',
        qa_lead_id: 'admin@masangroup.com',
        qa_support_ids: ['support-a@masangroup.com'],
        evaluation_department: 'QA Fresh',
        actual_evaluation_date: '2026-07-02',
        production_address: 'Plant A',
        evaluation_address: 'Audit Site A',
        linked_facility_code: 'LF-1',
        linked_facility_name: 'Linked Facility',
        linked_facility_address: 'Linked Address',
        linked_facility_type: 'Gia công',
        cmc_owner: 'CMC Owner',
        cmc_head: 'CMC Head',
        business_license_file: 'license.pdf',
        attp_certificate_type: 'HACCP',
        attp_certificate_file: 'attp.pdf',
        mch2: 'Thực phẩm công nghệ',
        mch3: 'Thực phẩm khô',
        product_group: 'Food',
        product_name: 'Product A',
      }),
    });
    const json = await res.json();
    assert.equal(res.status, 201, JSON.stringify(json));

    assert.equal(json.ticket.supplier.name, 'Auto Supplier');
    assert.equal(json.ticket.supplier.production_address, 'Plant A');
    assert.equal(json.ticket.supplier.evaluation_address, 'Audit Site A');
    assert.equal(json.ticket.supplier.linked_facility_name, 'Linked Facility');
    assert.equal(json.ticket.supplier.region, 'MB');
    assert.equal(json.ticket.supplier.province, 'Thành phố Hà Nội');
    assert.equal(json.ticket.supplier.business_type, 'Tự sản xuất');
    assert.equal(json.ticket.supplier.cmc_owner, 'CMC Owner');
    assert.equal(json.ticket.supplier.attp_certificate_type, 'HACCP');
    assert.equal(json.ticket.facility_type, 'CHUNG');
    assert.equal(json.ticket.evaluation_method, 'Online');
    assert.equal(json.ticket.qa_lead_id, 'admin@masangroup.com');
    assert.equal(json.ticket.participant_source, 'CANONICAL');
    assert.equal(json.ticket.participants.length, 4);
    assert.deepEqual(new Set(json.ticket.participants.map((item) => item.participant_role)),
      new Set(['OWNER', 'QA_LEAD', 'QA_SUPPORT', 'EVALUATOR']));
    assert.equal(json.ticket.evaluation_department, 'QA Fresh');
    assert.equal(json.ticket.dates.actual, '2026-07-02');
    assert.ok(json.ticket.allowed_actions.includes('view'));
    assert.ok(json.ticket.allowed_actions.includes('edit'));
    assert.ok(json.ticket.allowed_actions.includes('score'));
    assert.ok(json.ticket.allowed_actions.includes('delete'));
    assert.equal(json.ticket.allowed_actions.includes('end'), false);
    assert.equal(json.ticket.allowed_actions.includes('round2_start'), false);

    const row = db.prepare('SELECT * FROM evaluation_tickets WHERE id = ?').get(json.ticket.id);
    assert.equal(row.supplier_id, supplierInfo.lastInsertRowid);
    assert.ok(row.question_template_version_id > 0);
    assert.equal(json.ticket.question_template_version_id, row.question_template_version_id);
    assert.equal(json.ticket.question_template_version_status, 'PUBLISHED');
    assert.equal(row.snapshot_linked_facility_address, 'Linked Address');
    assert.equal(row.business_license_file, 'license.pdf');
    assert.equal(row.attp_certificate_file, 'attp.pdf');
    assert.ok(!db.pragma("table_info('evaluation_tickets')").some((column) => column.name === 'qa_support_ids'));
    assert.ok(row.snapshot_locked_at);
    assert.equal(
      row.snapshot_locked_at,
      db.prepare('SELECT started_at FROM evaluation_rounds WHERE ticket_id=? AND round_no=1').pluck().get(row.id),
    );
    assert.equal(db.prepare(`SELECT COUNT(*) FROM evaluation_participants
      WHERE ticket_id=? AND participant_role IN ('OWNER','QA_LEAD','QA_SUPPORT','EVALUATOR')`).pluck().get(row.id), 4);
    assert.equal(db.prepare(`SELECT COUNT(*) FROM evaluation_participants
      WHERE round_id=(SELECT id FROM evaluation_rounds WHERE ticket_id=? AND round_no=1)
        AND participant_role='EVALUATOR'`).pluck().get(row.id), 1);

    const beforeUpdateCount = db.prepare('SELECT COUNT(*) AS n FROM evaluation_tickets').get().n;
    const updateRes = await fetch(`${appInfo.baseUrl}/evaluations/${encodeURIComponent(json.ticket.ticket_code)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `qlcl_token=${token}`,
      },
      body: JSON.stringify({ planned_date: '2026-07-16' }),
    });
    const updateJson = await updateRes.json();
    assert.equal(updateRes.status, 200, JSON.stringify(updateJson));
    assert.equal(updateJson.ticket.ticket_code, json.ticket.ticket_code);
    assert.equal(updateJson.ticket.id, json.ticket.id);
    assert.equal(updateJson.ticket.dates.planned, '2026-07-16');

    const afterUpdateCount = db.prepare('SELECT COUNT(*) AS n FROM evaluation_tickets').get().n;
    assert.equal(afterUpdateCount, beforeUpdateCount);
    const updatedRow = db.prepare('SELECT ticket_code, planned_date FROM evaluation_tickets WHERE id = ?').get(json.ticket.id);
    assert.deepEqual(updatedRow, { ticket_code: json.ticket.ticket_code, planned_date: '2026-07-16' });

    const roundRes = await fetch(`${appInfo.baseUrl}/evaluations/${encodeURIComponent(json.ticket.ticket_code)}/rounds/1`, {
      headers: { Cookie: `qlcl_token=${token}` },
    });
    const roundJson = await roundRes.json();
    assert.equal(roundRes.status, 200, JSON.stringify(roundJson));
    assert.ok(roundJson.ticket.allowed_actions.includes('score'));
    assert.equal(roundJson.questions.length, 63);
    assert.ok(roundJson.questions.every((question) => question.template_code === 'BM04'));
    assert.ok(roundJson.questions.every((question) => question.facility_type === 'CHUNG'));
    assert.ok(roundJson.questions.every((question) => question.supplier_scale === 'LARGE'));
    assert.ok(roundJson.questions.every((question) => question.question_item_id > 0));
    assert.equal(roundJson.round.participant_source, 'CANONICAL');
    assert.equal(roundJson.round.participants.some((item) => item.participant_role === 'EVALUATOR'), true);
    assert.ok(roundJson.canonical_answers && typeof roundJson.canonical_answers === 'object');
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

test('scoring draft save promotes a draft ticket to processing once', async () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-scoring-draft-${Date.now()}-${Math.random()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const oldJwtSecret = process.env.JWT_SECRET;
  const { db, signToken, evaluationsRouter } = freshModules(dbPath);
  let server;
  const draftStatus = 'Kh\u1edfi t\u1ea1o';
  const processingStatus = '\u0110ang x\u1eed l\u00fd';

  try {
    upsertCanonicalUser(db, { email: 'admin@masangroup.com', role: 'Admin', isAdmin: true });
    const supplierInfo = db.prepare(`
      INSERT INTO supplier_master (supplier_code, supplier_name, status, source_type)
      VALUES ('NCC-DRAFT', 'Draft Supplier', 'ACTIVE', 'MANUAL')
    `).run();
    const template = db.prepare("SELECT id FROM question_templates WHERE template_code = 'BM04'").get();
    const ticketInfo = db.prepare(`
      INSERT INTO evaluation_tickets (
        ticket_code, supplier_id, supplier_code, supplier_name, evaluation_type, template_id,
        facility_type, supplier_scale, planned_date, current_status, current_round_no,
        assigned_specialist_id, created_by
      )
      VALUES (
        'TICKET-DRAFT', @supplier_id, 'NCC-DRAFT', 'Draft Supplier', 'Dinh ky', @template_id,
        'CHUNG', 'LARGE', '2026-07-01', @current_status, 1,
        'admin@masangroup.com', 'admin@masangroup.com'
      )
    `).run({ supplier_id: supplierInfo.lastInsertRowid, template_id: template.id, current_status: draftStatus });
    db.prepare('INSERT INTO evaluation_rounds (ticket_id, round_no, status) VALUES (?, 1, ?)').run(ticketInfo.lastInsertRowid, draftStatus);
    const question = db.prepare(`
      SELECT q.id, q.id AS question_item_id
      FROM question_items q
      JOIN question_template_versions qv ON qv.id=q.question_template_version_id
      WHERE qv.template_id = ? AND qv.version_no=1
        AND q.facility_type = 'CHUNG' AND q.supplier_scale = 'LARGE'
      ORDER BY q.order_index, q.question_code
      LIMIT 1
    `).get(template.id);

    const appInfo = await startApp(evaluationsRouter);
    server = appInfo.server;
    const token = signToken({ email: 'admin@masangroup.com', isAdmin: true, role: 'Admin' }, 3600);

    const saveRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-DRAFT/rounds/1/answers`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({
        canonical_answers: { [question.question_item_id]: { score: 'A', note: '' } },
        attendees: [
          { name: 'Nguyen Van A - QA Lead', opening: true, closing: true },
          { name: 'Tran Thi B - NCC', opening: true, closing: false },
        ],
        supplier_introduction: REQUIRED_SUPPLIER_INTRODUCTION,
      }),
    });
    const saveJson = await saveRes.json();
    assert.equal(saveRes.status, 200, JSON.stringify(saveJson));
    assert.equal(saveJson.ticket.workflow_status, processingStatus);
    assert.equal(saveJson.answers[String(question.id)].score, 'A');
    assert.equal(saveJson.canonical_answers[String(question.question_item_id)].score, 'A');
    assert.deepEqual(saveJson.round.attendees, [
      { name: 'Nguyen Van A - QA Lead', opening: true, closing: true },
      { name: 'Tran Thi B - NCC', opening: true, closing: false },
    ]);
    assert.equal(saveJson.round.participants.filter((item) => item.participant_role === 'ATTENDEE').length, 2);
    assert.equal(saveJson.ticket.supplier_introduction, REQUIRED_SUPPLIER_INTRODUCTION);
    assert.equal(
      db.prepare('SELECT supplier_introduction FROM evaluation_tickets WHERE id = ?').get(ticketInfo.lastInsertRowid).supplier_introduction,
      REQUIRED_SUPPLIER_INTRODUCTION
    );
    assert.ok(!db.pragma("table_info('evaluation_rounds')").some((column) => column.name === 'attendees_json'));
    assert.equal(db.prepare(`SELECT COUNT(*) FROM evaluation_participants
      WHERE round_id=(SELECT id FROM evaluation_rounds WHERE ticket_id=? AND round_no=1)
        AND participant_role='ATTENDEE'`).pluck().get(ticketInfo.lastInsertRowid), 2);
    assert.equal(db.prepare('SELECT current_status FROM evaluation_tickets WHERE ticket_code = ?').get('TICKET-DRAFT').current_status, processingStatus);
    assert.equal(db.prepare('SELECT status FROM evaluation_rounds WHERE ticket_id = ? AND round_no = 1').get(ticketInfo.lastInsertRowid).status, processingStatus);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM workflow_history WHERE ticket_id = ? AND action = ?').get(ticketInfo.lastInsertRowid, 'SCORING_DRAFT_SAVE').count, 1);

    const secondSaveRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-DRAFT/rounds/1/answers`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({ answers: { [question.id]: { score: 'A', note: 'still ok' } } }),
    });
    assert.equal(secondSaveRes.status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM workflow_history WHERE ticket_id = ? AND action = ?').get(ticketInfo.lastInsertRowid, 'SCORING_DRAFT_SAVE').count, 1);

    const roundRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-DRAFT/rounds/1`, {
      headers: { Cookie: `qlcl_token=${token}` },
    });
    const roundJson = await roundRes.json();
    assert.equal(roundRes.status, 200, JSON.stringify(roundJson));
    assert.deepEqual(roundJson.round.attendees, saveJson.round.attendees);
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

test('round 2 inherits A/NA answers as readonly and rejects bypass changes', async () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-round2-test-${Date.now()}-${Math.random()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const oldJwtSecret = process.env.JWT_SECRET;
  const { db, signToken, evaluationsRouter } = freshModules(dbPath);
  let server;

  try {
    upsertCanonicalUser(db, { email: 'admin@masangroup.com', role: 'Admin', isAdmin: true });
    const supplierInfo = db.prepare(`
      INSERT INTO supplier_master (supplier_code, supplier_name, status, source_type)
      VALUES ('NCC-R2', 'Round 2 Supplier', 'ACTIVE', 'MANUAL')
    `).run();
    const template = db.prepare("SELECT id FROM question_templates WHERE template_code = 'BM04'").get();
    const ticketInfo = db.prepare(`
      INSERT INTO evaluation_tickets (
        ticket_code, supplier_id, supplier_code, supplier_name, evaluation_type, template_id,
        facility_type, supplier_scale, planned_date, current_status, current_round_no,
        assigned_specialist_id, created_by
      )
      VALUES (
        'TICKET-R2', @supplier_id, 'NCC-R2', 'Round 2 Supplier', 'Đánh giá định kỳ', @template_id,
        'CHUNG', 'LARGE', '2026-07-01', 'Chờ khắc phục', 1,
        'admin@masangroup.com', 'admin@masangroup.com'
      )
    `).run({ supplier_id: supplierInfo.lastInsertRowid, template_id: template.id });
    const round1 = db.prepare('INSERT INTO evaluation_rounds (ticket_id, round_no, status, locked_at, locked_by) VALUES (?, 1, ?, datetime(\'now\'), ?)').run(ticketInfo.lastInsertRowid, 'Hoàn thành', 'admin@masangroup.com');
    const questions = db.prepare(`
      SELECT q.id, q.question_code
      FROM question_items q
      JOIN question_template_versions qv ON qv.id=q.question_template_version_id
      WHERE qv.template_id = ? AND qv.version_no=1
        AND q.facility_type = 'CHUNG' AND q.supplier_scale = 'LARGE'
      ORDER BY q.order_index, q.question_code
      LIMIT 3
    `).all(template.id);
    db.prepare(`
      INSERT INTO evaluation_answers (round_id, question_item_id, score, comment, calculated_score, answered_by)
      VALUES (?, ?, ?, ?, ?, 'admin@masangroup.com')
    `).run(round1.lastInsertRowid, questions[0].id, 'A', '', 100);
    const inheritedAnswer = db.prepare('SELECT id FROM evaluation_answers WHERE round_id = ? AND question_item_id = ?').get(round1.lastInsertRowid, questions[0].id);
    const inheritedAttachment = db.prepare(`
      INSERT INTO evaluation_attachments (answer_id, ticket_id, file_name, file_path, storage_key, mime_type, size_bytes, uploaded_by)
      VALUES (?, ?, 'round1-evidence.pdf', '/tmp/round1-evidence.pdf', 'ROUND1:A:evidence', 'application/pdf', 321, 'admin@masangroup.com')
    `).run(inheritedAnswer.id, ticketInfo.lastInsertRowid);
    db.prepare(`
      INSERT INTO evaluation_answers (round_id, question_item_id, score, comment, calculated_score, answered_by)
      VALUES (?, ?, ?, ?, ?, 'admin@masangroup.com')
    `).run(round1.lastInsertRowid, questions[1].id, 'NA', 'Không áp dụng', null);
    db.prepare(`
      INSERT INTO evaluation_answers (round_id, question_item_id, score, comment, calculated_score, answered_by)
      VALUES (?, ?, ?, ?, ?, 'admin@masangroup.com')
    `).run(round1.lastInsertRowid, questions[2].id, 'B', 'Cần cải thiện', 75);
    db.prepare(`
      INSERT INTO evaluation_nonconformities (
        ticket_id, round_id, evaluation_answer_id, clause_code, category, nonconformity_content,
        remediation_content, due_date, severity, status, created_by
      )
      VALUES (?, ?, ?, 'R2-B', 'Test', 'Cần cải thiện', 'Khắc phục', '2026-07-15', 'B', 'OPEN', 'admin@masangroup.com')
    `).run(ticketInfo.lastInsertRowid, round1.lastInsertRowid,
      db.prepare('SELECT id FROM evaluation_answers WHERE round_id=? AND question_item_id=?')
        .pluck().get(round1.lastInsertRowid, questions[2].id));

    const appInfo = await startApp(evaluationsRouter);
    server = appInfo.server;
    const token = signToken({ email: 'admin@masangroup.com', isAdmin: true, role: 'Admin' }, 3600);

    const detailBeforeRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-R2`, {
      headers: { Cookie: `qlcl_token=${token}` },
    });
    const detailBeforeJson = await detailBeforeRes.json();
    assert.equal(detailBeforeRes.status, 200, JSON.stringify(detailBeforeJson));
    assert.equal(detailBeforeJson.ticket.round_2_eligible, true);
    assert.equal(detailBeforeJson.ticket.round_2_block_reason, '');
    assert.equal(detailBeforeJson.ticket.allowed_actions.includes('score'), false);
    assert.equal(detailBeforeJson.ticket.allowed_actions.includes('round2_start'), true);
    assert.equal(detailBeforeJson.ticket.allowed_actions.includes('end'), false);

    const openRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-R2/round-2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({}),
    });
    const openJson = await openRes.json();
    assert.equal(openRes.status, 201, JSON.stringify(openJson));
    assert.equal(openJson.answers[String(questions[0].id)].score, 'A');
    assert.equal(openJson.answers[String(questions[0].id)].readonly, true);
    assert.equal(openJson.answers[String(questions[0].id)].attachments.length, 1);
    assert.equal(openJson.answers[String(questions[0].id)].attachments[0].file_name, 'round1-evidence.pdf');
    assert.match(openJson.answers[String(questions[0].id)].attachments[0].storage_key, /^INHERITED:/);
    assert.equal(openJson.answers[String(questions[1].id)].score, 'NA');
    assert.equal(openJson.answers[String(questions[1].id)].inherited, true);
    assert.equal(openJson.answers[String(questions[2].id)].score, '');
    assert.equal(openJson.round.source_assessment_id, round1.lastInsertRowid);
    assert.equal(openJson.round.source_assessment_code, 'TICKET-R2-R1');
    assert.equal(openJson.round.source_round_no, 1);
    const detailAfterOpenRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-R2`, {
      headers: { Cookie: `qlcl_token=${token}` },
    });
    const detailAfterOpenJson = await detailAfterOpenRes.json();
    assert.equal(detailAfterOpenRes.status, 200, JSON.stringify(detailAfterOpenJson));
    assert.equal(detailAfterOpenJson.ticket.allowed_actions.includes('score'), true);
    assert.equal(detailAfterOpenJson.ticket.allowed_actions.includes('round2_start'), false);
    const originalAttachment = db.prepare('SELECT * FROM evaluation_attachments WHERE id = ?').get(inheritedAttachment.lastInsertRowid);
    assert.equal(originalAttachment.storage_key, 'ROUND1:A:evidence');
    const round2Row = db.prepare('SELECT source_round_id FROM evaluation_rounds WHERE id = ?').get(openJson.round.id);
    assert.equal(round2Row.source_round_id, round1.lastInsertRowid);
    const afterOpenTicket = db.prepare('SELECT current_round_no, completed_round, score_percent FROM evaluation_tickets WHERE id = ?').get(ticketInfo.lastInsertRowid);
    assert.equal(afterOpenTicket.current_round_no, 2);
    assert.equal(afterOpenTicket.completed_round, 1);
    const openHistory = db.prepare('SELECT * FROM workflow_history WHERE ticket_id = ? AND action = ?').get(ticketInfo.lastInsertRowid, 'ROUND_2_OPEN');
    assert.equal(openHistory.actor_user_id, 'admin@masangroup.com');
    const openAudit = JSON.parse(openHistory.comment);
    assert.equal(openAudit.created_by, 'admin@masangroup.com');
    assert.equal(openAudit.source_assessment_id, round1.lastInsertRowid);
    assert.equal(openAudit.source_assessment_code, 'TICKET-R2-R1');
    assert.equal(openAudit.target_assessment_id, openJson.round.id);
    assert.equal(openAudit.target_assessment_code, 'TICKET-R2-R2');

    const duplicateRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-R2/round-2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({}),
    });
    const duplicateJson = await duplicateRes.json();
    assert.equal(duplicateRes.status, 409, JSON.stringify(duplicateJson));
    assert.equal(duplicateJson.error, 'round_2_exists');

    const bypassRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-R2/rounds/2/answers`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({
        answers: {
          [questions[0].id]: { score: 'D', note: 'Attempt to change inherited A' },
        },
      }),
    });
    const bypassJson = await bypassRes.json();
    assert.equal(bypassRes.status, 400, JSON.stringify(bypassJson));
    assert.equal(bypassJson.error, 'inherited_answer_readonly');

    const uploadForm = new FormData();
    uploadForm.append('question_id', String(questions[0].id));
    uploadForm.append('file', new Blob(['new evidence'], { type: 'application/pdf' }), 'new-evidence.pdf');
    const uploadReadonlyRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-R2/rounds/2/attachments`, {
      method: 'POST',
      headers: { Cookie: `qlcl_token=${token}` },
      body: uploadForm,
    });
    const uploadReadonlyJson = await uploadReadonlyRes.json();
    assert.equal(uploadReadonlyRes.status, 400, JSON.stringify(uploadReadonlyJson));
    assert.equal(uploadReadonlyJson.error, 'inherited_answer_readonly');

    const editableRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-R2/rounds/2/answers`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({
        answers: {
          [questions[2].id]: { score: 'A', note: '' },
        },
      }),
    });
    const editableJson = await editableRes.json();
    assert.equal(editableRes.status, 200, JSON.stringify(editableJson));
    assert.equal(editableJson.answers[String(questions[2].id)].score, 'A');
    const round1B = db.prepare('SELECT score, comment FROM evaluation_answers WHERE round_id = ? AND question_item_id = ?').get(round1.lastInsertRowid, questions[2].id);
    assert.equal(round1B.score, 'B');
    assert.equal(round1B.comment, 'Cần cải thiện');
    const detailRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-R2`, {
      headers: { Cookie: `qlcl_token=${token}` },
    });
    const detailJson = await detailRes.json();
    assert.equal(detailRes.status, 200, JSON.stringify(detailJson));
    assert.deepEqual(detailJson.assessments.map((row) => row.assessment_code), ['TICKET-R2-R1', 'TICKET-R2-R2']);
    assert.equal(detailJson.assessments[0].round_no, 1);
    assert.equal(detailJson.assessments[1].round_no, 2);
    assert.equal(detailJson.assessments[1].source_assessment_id, round1.lastInsertRowid);
    assert.equal(detailJson.assessments[1].source_assessment_code, 'TICKET-R2-R1');
    assert.equal(detailJson.assessments[1].source_round_no, 1);
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

test('nonconformities are generated from B/C/D answers and keep correction fields', async () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-nc-test-${Date.now()}-${Math.random()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const oldJwtSecret = process.env.JWT_SECRET;
  const { db, signToken, evaluationsRouter } = freshModules(dbPath);
  let server;

  try {
    upsertCanonicalUser(db, { email: 'admin@masangroup.com', role: 'Admin', isAdmin: true });
    const supplierInfo = db.prepare(`
      INSERT INTO supplier_master (supplier_code, supplier_name, status, source_type)
      VALUES ('NCC-NC', 'Nonconformity Supplier', 'ACTIVE', 'MANUAL')
    `).run();
    const template = db.prepare("SELECT id FROM question_templates WHERE template_code = 'BM04'").get();
    const ticketInfo = db.prepare(`
      INSERT INTO evaluation_tickets (
        ticket_code, supplier_id, supplier_code, supplier_name, evaluation_type, template_id,
        facility_type, supplier_scale, planned_date, current_status, current_round_no,
        assigned_specialist_id, created_by
      )
      VALUES (
        'TICKET-NC', @supplier_id, 'NCC-NC', 'Nonconformity Supplier', 'Dinh ky', @template_id,
        'CHUNG', 'LARGE', '2026-07-01', 'Dang xu ly', 1,
        'admin@masangroup.com', 'admin@masangroup.com'
      )
    `).run({ supplier_id: supplierInfo.lastInsertRowid, template_id: template.id });
    db.prepare('INSERT INTO evaluation_rounds (ticket_id, round_no, status) VALUES (?, 1, ?)').run(ticketInfo.lastInsertRowid, 'Khoi tao');
    const questions = db.prepare(`
      SELECT q.id, q.question_code, q.category
      FROM question_items q
      JOIN question_template_versions qv ON qv.id=q.question_template_version_id
      WHERE qv.template_id = ? AND qv.version_no=1
        AND q.facility_type = 'CHUNG' AND q.supplier_scale = 'LARGE'
      ORDER BY q.order_index, q.question_code
      LIMIT 2
    `).all(template.id);
    assert.equal(questions.length, 2);

    const appInfo = await startApp(evaluationsRouter);
    server = appInfo.server;
    const token = signToken({ email: 'admin@masangroup.com', isAdmin: true, role: 'Admin' }, 3600);

    const createRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-NC/rounds/1/answers`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({
        answers: {
          [questions[0].id]: { score: 'B', note: 'Label evidence is incomplete' },
          [questions[1].id]: { score: 'A', note: '' },
        },
      }),
    });
    const createJson = await createRes.json();
    assert.equal(createRes.status, 200, JSON.stringify(createJson));
    assert.equal(createJson.nonconformities.length, 1);
    assert.equal(createJson.nonconformities[0].clause_code, questions[0].question_code);
    assert.equal(createJson.nonconformities[0].category, questions[0].category);
    assert.equal(createJson.nonconformities[0].severity, 'B');
    assert.equal(createJson.nonconformities[0].nonconformity, 'Label evidence is incomplete');
    assert.equal(createJson.nonconformities[0].nonconformity_content, 'Label evidence is incomplete');
    assert.equal(createJson.nonconformities[0].due_date, '2026-07-08');
    assert.equal(createJson.nonconformities[0].status, 'OPEN');
    const canonicalCreated = db.prepare(`SELECT evaluation_answer_id, nonconformity_content
      FROM evaluation_nonconformities WHERE id=?`).get(createJson.nonconformities[0].id);
    assert.ok(canonicalCreated.evaluation_answer_id > 0);
    assert.equal(canonicalCreated.nonconformity_content, 'Label evidence is incomplete');

    const ncId = createJson.nonconformities[0].id;
    const invalidUpdateRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-NC/nonconformities/${ncId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({
        remediation: 'Upload corrected label evidence',
        due_date: '2026-08-01',
        status: 'IN_PROGRESS',
      }),
    });
    const invalidUpdateJson = await invalidUpdateRes.json();
    assert.equal(invalidUpdateRes.status, 400, JSON.stringify(invalidUpdateJson));
    assert.equal(invalidUpdateJson.error, 'invalid_remediation');

    const updateRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-NC/nonconformities/${ncId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({
        remediation: 'Bổ sung hồ sơ',
        due_date: '2026-08-01',
        status: 'IN_PROGRESS',
      }),
    });
    const updateJson = await updateRes.json();
    assert.equal(updateRes.status, 200, JSON.stringify(updateJson));
    assert.equal(updateJson.item.remediation, 'Bổ sung hồ sơ');
    assert.equal(updateJson.item.due_date, '2026-08-01');
    assert.equal(updateJson.item.status, 'IN_PROGRESS');
    assert.equal(updateJson.item.remediation_content, updateJson.item.remediation);
    assert.equal(db.prepare(`SELECT remediation_content FROM evaluation_nonconformities WHERE id=?`)
      .pluck().get(ncId), 'Bổ sung hồ sơ');

    const resaveRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-NC/rounds/1/answers`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({
        answers: {
          [questions[0].id]: { score: 'B', note: 'Updated nonconformity description' },
          [questions[1].id]: { score: 'A', note: '' },
        },
      }),
    });
    const resaveJson = await resaveRes.json();
    assert.equal(resaveRes.status, 200, JSON.stringify(resaveJson));
    assert.equal(resaveJson.nonconformities[0].due_date, '2026-08-01');
    assert.equal(db.prepare(`SELECT nonconformity_content FROM evaluation_nonconformities WHERE id=?`)
      .pluck().get(ncId), 'Updated nonconformity description');

    const detailRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-NC`, {
      headers: { Cookie: `qlcl_token=${token}` },
    });
    const detailJson = await detailRes.json();
    assert.equal(detailRes.status, 200, JSON.stringify(detailJson));
    assert.equal(detailJson.nonconformities.length, 1);
    assert.equal(detailJson.nonconformities[0].remediation, 'Bổ sung hồ sơ');

    const clearRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-NC/rounds/1/answers`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({
        answers: {
          [questions[0].id]: { score: 'A', note: '' },
          [questions[1].id]: { score: 'A', note: '' },
        },
      }),
    });
    const clearJson = await clearRes.json();
    assert.equal(clearRes.status, 200, JSON.stringify(clearJson));
    assert.equal(clearJson.nonconformities.length, 0);
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

test('round completion requires remediation and due date for nonconformities', async () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-nc-required-${Date.now()}-${Math.random()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const oldJwtSecret = process.env.JWT_SECRET;
  const { db, signToken, evaluationsRouter } = freshModules(dbPath);
  let server;

  try {
    upsertCanonicalUser(db, { email: 'admin@masangroup.com', role: 'Admin', isAdmin: true });
    const supplierInfo = db.prepare(`
      INSERT INTO supplier_master (supplier_code, supplier_name, status, source_type)
      VALUES ('NCC-NC-REQ', 'Required NC Supplier', 'ACTIVE', 'MANUAL')
    `).run();
    const template = db.prepare("SELECT id FROM question_templates WHERE template_code = 'BM04'").get();
    const ticketInfo = db.prepare(`
      INSERT INTO evaluation_tickets (
        ticket_code, supplier_id, supplier_code, supplier_name, evaluation_type, template_id,
        facility_type, supplier_scale, planned_date, current_status, current_round_no,
        assigned_specialist_id, created_by
      )
      VALUES (
        'TICKET-NC-REQ', @supplier_id, 'NCC-NC-REQ', 'Required NC Supplier', 'Dinh ky', @template_id,
        'CHUNG', 'LARGE', '2026-07-01', 'Dang xu ly', 1,
        'admin@masangroup.com', 'admin@masangroup.com'
      )
    `).run({ supplier_id: supplierInfo.lastInsertRowid, template_id: template.id });
    db.prepare('INSERT INTO evaluation_rounds (ticket_id, round_no, status) VALUES (?, 1, ?)').run(ticketInfo.lastInsertRowid, 'Dang xu ly');
    const questions = db.prepare(`
      SELECT q.id, q.question_code, q.category, q.allowed_scores, q.requires_attachment
      FROM question_items q
      JOIN question_template_versions qv ON qv.id=q.question_template_version_id
      WHERE qv.template_id = ? AND qv.version_no=1
        AND q.facility_type = 'CHUNG' AND q.supplier_scale = 'LARGE'
      ORDER BY q.order_index, q.question_code
    `).all(template.id);
    assert.ok(questions.length > 0);
    const nonconformingQuestion = questions.find((question) => String(question.allowed_scores || '').split('/').includes('B'));
    assert.ok(nonconformingQuestion);
    const answers = Object.fromEntries(questions.map((question) => {
      const allowed = String(question.allowed_scores || 'A/B/C/D/NA').split('/').filter(Boolean);
      const score = question.id === nonconformingQuestion.id ? 'B' : (allowed.includes('A') ? 'A' : 'NA');
      const answer = {
        score,
        note: ['B', 'C', 'D', 'NA'].includes(score) ? (score === 'B' ? 'Missing label evidence' : 'Not applicable') : '',
      };
      if (question.requires_attachment) answer.attachments = [{ file_name: 'evidence.pdf' }];
      return [question.id, answer];
    }));

    const appInfo = await startApp(evaluationsRouter);
    server = appInfo.server;
    const token = signToken({ email: 'admin@masangroup.com', isAdmin: true, role: 'Admin' }, 3600);

    const draftRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-NC-REQ/rounds/1/answers`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({ answers }),
    });
    const draftJson = await draftRes.json();
    assert.equal(draftRes.status, 200, JSON.stringify(draftJson));
    assert.equal(draftJson.nonconformities.length, 1);
    assert.equal(draftJson.nonconformities[0].due_date, '2026-07-08');
    const round = db.prepare('SELECT id FROM evaluation_rounds WHERE ticket_id = ? AND round_no = 1').get(ticketInfo.lastInsertRowid);
    questions.filter((question) => question.requires_attachment).forEach((question) => {
      const answer = db.prepare('SELECT id FROM evaluation_answers WHERE round_id = ? AND question_item_id = ?').get(round.id, question.id);
      db.prepare(`
        INSERT INTO evaluation_attachments (answer_id, ticket_id, file_name, uploaded_by)
        VALUES (?, ?, ?, 'admin@masangroup.com')
      `).run(answer.id, ticketInfo.lastInsertRowid, `evidence-${question.id}.pdf`);
    });

    const missingAttendeesRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-NC-REQ/rounds/1/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({ answers }),
    });
    const missingAttendeesJson = await missingAttendeesRes.json();
    assert.equal(missingAttendeesRes.status, 400, JSON.stringify(missingAttendeesJson));
    assert.equal(missingAttendeesJson.error, 'attendees_required');
    assert.equal(db.prepare('SELECT locked_at FROM evaluation_rounds WHERE id = ?').get(round.id).locked_at, null);

    const missingSupplierIntroRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-NC-REQ/rounds/1/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({ answers, attendees: REQUIRED_ATTENDEES }),
    });
    const missingSupplierIntroJson = await missingSupplierIntroRes.json();
    assert.equal(missingSupplierIntroRes.status, 400, JSON.stringify(missingSupplierIntroJson));
    assert.equal(missingSupplierIntroJson.error, 'supplier_introduction_required');
    assert.equal(db.prepare('SELECT locked_at FROM evaluation_rounds WHERE id = ?').get(round.id).locked_at, null);

    const blockedCompleteRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-NC-REQ/rounds/1/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({ answers, attendees: REQUIRED_ATTENDEES, supplier_introduction: REQUIRED_SUPPLIER_INTRODUCTION }),
    });
    const blockedCompleteJson = await blockedCompleteRes.json();
    assert.equal(blockedCompleteRes.status, 400, JSON.stringify(blockedCompleteJson));
    assert.equal(blockedCompleteJson.error, 'missing_corrective_requirements');
    assert.equal(blockedCompleteJson.items.length, 1);

    const blockedLeadRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-NC-REQ/submit-to-lead`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({ comment: '' }),
    });
    const blockedLeadJson = await blockedLeadRes.json();
    assert.equal(blockedLeadRes.status, 400, JSON.stringify(blockedLeadJson));
    assert.equal(blockedLeadJson.error, 'missing_corrective_requirements');

    const ncId = draftJson.nonconformities[0].id;
    const updateRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-NC-REQ/nonconformities/${ncId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({
        remediation: 'Gửi hình ảnh khắc phục',
        due_date: '2026-08-01',
        status: 'IN_PROGRESS',
      }),
    });
    const updateJson = await updateRes.json();
    assert.equal(updateRes.status, 200, JSON.stringify(updateJson));
    assert.equal(updateJson.ticket.reassessment_due_date, null);

    const completeRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-NC-REQ/rounds/1/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({ answers, attendees: REQUIRED_ATTENDEES, supplier_introduction: REQUIRED_SUPPLIER_INTRODUCTION, final_action: 'WAITING_CORRECTION' }),
    });
    const completeJson = await completeRes.json();
    assert.equal(completeRes.status, 200, JSON.stringify(completeJson));
    assert.equal(completeJson.ticket.workflow_status, 'Ch\u1edd kh\u1eafc ph\u1ee5c');
    assert.equal(completeJson.ticket.reassessment_due_date, '2026-08-01');
    assert.equal(completeJson.round.locked, true);
    assert.equal(completeJson.ticket.allowed_actions.includes('score'), false);
    const persistedRoundRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-NC-REQ/rounds/1`, {
      headers: { Cookie: `qlcl_token=${token}` },
    });
    const persistedRoundJson = await persistedRoundRes.json();
    assert.equal(persistedRoundRes.status, 200, JSON.stringify(persistedRoundJson));
    assert.equal(persistedRoundJson.round.locked, true);
    assert.equal(persistedRoundJson.ticket.allowed_actions.includes('score'), false);
    const expectedAssessmentDate = new Date().toISOString().slice(0, 10);
    const storedAssessmentDates = db.prepare(`
      SELECT t.actual_evaluation_date, r.assessment_date
      FROM evaluation_tickets t
      JOIN evaluation_rounds r ON r.ticket_id = t.id AND r.round_no = 1
      WHERE t.id = ?
    `).get(ticketInfo.lastInsertRowid);
    assert.equal(storedAssessmentDates.actual_evaluation_date, expectedAssessmentDate);
    assert.equal(storedAssessmentDates.assessment_date, expectedAssessmentDate);
    assert.equal(completeJson.nonconformities[0].remediation, 'Gửi hình ảnh khắc phục');
    assert.equal(completeJson.nonconformities[0].due_date, '2026-08-01');
    const laterUpdateRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-NC-REQ/nonconformities/${ncId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({
        remediation: 'Gửi hình ảnh khắc phục',
        due_date: '2026-08-15',
        status: 'IN_PROGRESS',
      }),
    });
    const laterUpdateJson = await laterUpdateRes.json();
    assert.equal(laterUpdateRes.status, 423, JSON.stringify(laterUpdateJson));
    assert.equal(laterUpdateJson.error, 'correction_fields_locked');
    db.prepare('UPDATE evaluation_tickets SET current_status = ? WHERE id = ?').run('Đang xử lý', ticketInfo.lastInsertRowid);
    db.prepare('UPDATE evaluation_rounds SET correction_locked = 0 WHERE id = ?').run(round.id);
    const reopenedUpdateRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-NC-REQ/nonconformities/${ncId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({
        remediation: 'Bổ sung hồ sơ',
        due_date: '2026-08-15',
        status: 'IN_PROGRESS',
      }),
    });
    const reopenedUpdateJson = await reopenedUpdateRes.json();
    assert.equal(reopenedUpdateRes.status, 200, JSON.stringify(reopenedUpdateJson));
    assert.equal(reopenedUpdateJson.item.due_date, '2026-08-15');
    const history = db.prepare('SELECT * FROM workflow_history WHERE ticket_id = ? AND action = ?').get(ticketInfo.lastInsertRowid, 'ROUND_1_END');
    assert.equal(history.to_status, 'Ch\u1edd kh\u1eafc ph\u1ee5c');
    const lockHistory = db.prepare('SELECT * FROM workflow_history WHERE ticket_id = ? AND action = ?').get(ticketInfo.lastInsertRowid, 'CORRECTION_FIELDS_LOCK');
    assert.equal(JSON.parse(lockHistory.comment).assessment_id, round.id);
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

test('submit to lead requires locked scoring and rejects clean passing assessments', async () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-submit-lead-${Date.now()}-${Math.random()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const oldJwtSecret = process.env.JWT_SECRET;
  const { db, signToken, evaluationsRouter } = freshModules(dbPath);
  let server;

  try {
    upsertCanonicalUser(db, { email: 'admin@masangroup.com', role: 'Admin', isAdmin: true });
    const supplierInfo = db.prepare(`
      INSERT INTO supplier_master (supplier_code, supplier_name, status, source_type)
      VALUES ('NCC-LEAD', 'Lead Supplier', 'ACTIVE', 'MANUAL')
    `).run();
    const template = db.prepare("SELECT id FROM question_templates WHERE template_code = 'BM04'").get();
    const ticketInfo = db.prepare(`
      INSERT INTO evaluation_tickets (
        ticket_code, supplier_id, supplier_code, supplier_name, evaluation_type, template_id,
        facility_type, supplier_scale, planned_date, current_status, current_round_no,
        assigned_specialist_id, created_by
      )
      VALUES (
        'TICKET-LEAD', @supplier_id, 'NCC-LEAD', 'Lead Supplier', 'Dinh ky', @template_id,
        'CHUNG', 'LARGE', '2026-07-01', @current_status, 1,
        'admin@masangroup.com', 'admin@masangroup.com'
      )
    `).run({ supplier_id: supplierInfo.lastInsertRowid, template_id: template.id, current_status: '\u0110ang x\u1eed l\u00fd' });
    db.prepare('INSERT INTO evaluation_rounds (ticket_id, round_no, status) VALUES (?, 1, ?)').run(ticketInfo.lastInsertRowid, '\u0110ang x\u1eed l\u00fd');
    const questions = db.prepare(`
      SELECT q.id, q.allowed_scores, q.requires_attachment, q.is_critical_clause
      FROM question_items q
      JOIN question_template_versions qv ON qv.id=q.question_template_version_id
      WHERE qv.template_id = ? AND qv.version_no=1
        AND q.facility_type = 'CHUNG' AND q.supplier_scale = 'LARGE'
      ORDER BY q.order_index, q.question_code
    `).all(template.id);
    const answers = Object.fromEntries(questions.map((question) => {
      const allowed = String(question.allowed_scores || 'A/B/C/D/NA').split('/').filter(Boolean);
      const score = allowed.includes('A') ? 'A' : 'NA';
      const answer = { score, note: score === 'NA' ? 'Not applicable' : '' };
      if (question.requires_attachment) answer.attachments = [{ file_name: 'evidence.pdf' }];
      return [question.id, answer];
    }));

    const appInfo = await startApp(evaluationsRouter);
    server = appInfo.server;
    const token = signToken({ email: 'admin@masangroup.com', isAdmin: true, role: 'Admin' }, 3600);

    const unlockedSubmitRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-LEAD/submit-to-lead`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({ comment: '' }),
    });
    const unlockedSubmitJson = await unlockedSubmitRes.json();
    assert.equal(unlockedSubmitRes.status, 400, JSON.stringify(unlockedSubmitJson));
    assert.equal(unlockedSubmitJson.error, 'scoring_not_completed');

    const draftRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-LEAD/rounds/1/answers`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({ answers }),
    });
    assert.equal(draftRes.status, 200, await draftRes.text());
    const round = db.prepare('SELECT id FROM evaluation_rounds WHERE ticket_id = ? AND round_no = 1').get(ticketInfo.lastInsertRowid);
    questions.filter((question) => question.requires_attachment).forEach((question) => {
      const answer = db.prepare('SELECT id FROM evaluation_answers WHERE round_id = ? AND question_item_id = ?').get(round.id, question.id);
      db.prepare(`
        INSERT INTO evaluation_attachments (answer_id, ticket_id, file_name, uploaded_by)
        VALUES (?, ?, ?, 'admin@masangroup.com')
      `).run(answer.id, ticketInfo.lastInsertRowid, `evidence-${question.id}.pdf`);
    });

    const completeRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-LEAD/rounds/1/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({ answers, attendees: REQUIRED_ATTENDEES, supplier_introduction: REQUIRED_SUPPLIER_INTRODUCTION }),
    });
    const completeJson = await completeRes.json();
    assert.equal(completeRes.status, 200, JSON.stringify(completeJson));
    assert.equal(completeJson.round.locked, true);
    assert.equal(completeJson.ticket.workflow_status, '\u0110ang x\u1eed l\u00fd');

    const submitRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-LEAD/submit-to-lead`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({ comment: '' }),
    });
    const submitJson = await submitRes.json();
    assert.equal(submitRes.status, 400, JSON.stringify(submitJson));
    assert.equal(submitJson.error, 'lead_submission_not_eligible');
    assert.equal(submitJson.score_below_threshold, false);
    assert.equal(submitJson.failed_critical_count, 0);
    db.prepare("UPDATE evaluation_tickets SET current_status = 'Hoàn thành' WHERE id = ?").run(ticketInfo.lastInsertRowid);
    const terminalSubmitRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-LEAD/submit-to-lead`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({ comment: '' }),
    });
    const terminalSubmitJson = await terminalSubmitRes.json();
    assert.equal(terminalSubmitRes.status, 409, JSON.stringify(terminalSubmitJson));
    assert.equal(terminalSubmitJson.error, 'invalid_workflow_status');
    const history = db.prepare('SELECT * FROM workflow_history WHERE ticket_id = ? AND action = ?').get(ticketInfo.lastInsertRowid, 'EVALUATION_RESULT_SUBMIT');
    assert.equal(history, undefined);
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

test('correction extension records required fields, due-date history, and workflow history', async () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-extension-${Date.now()}-${Math.random()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const oldJwtSecret = process.env.JWT_SECRET;
  const { db, signToken, evaluationsRouter } = freshModules(dbPath);
  let server;

  try {
    upsertCanonicalUser(db, { email: 'admin@masangroup.com', role: 'Admin', isAdmin: true });
    const supplierInfo = db.prepare(`
      INSERT INTO supplier_master (supplier_code, supplier_name, status, source_type)
      VALUES ('NCC-EXT', 'Extension Supplier', 'ACTIVE', 'MANUAL')
    `).run();
    const template = db.prepare("SELECT id FROM question_templates WHERE template_code = 'BM04'").get();
    const ticketInfo = db.prepare(`
      INSERT INTO evaluation_tickets (
        ticket_code, supplier_id, supplier_code, supplier_name, evaluation_type, template_id,
        facility_type, supplier_scale, planned_date, current_status, current_round_no,
        completed_round, score_percent, grade_code, result_label, scoring_locked,
        assigned_specialist_id, created_by
      )
      VALUES (
        'TICKET-EXT', @supplier_id, 'NCC-EXT', 'Extension Supplier', 'Dinh ky', @template_id,
        'CHUNG', 'LARGE', '2026-07-01', 'Đang đánh giá lần 2', 2,
        2, 45, 'D', 'Khong dat', 1,
        'admin@masangroup.com', 'admin@masangroup.com'
      )
    `).run({ supplier_id: supplierInfo.lastInsertRowid, template_id: template.id });
    const round2 = db.prepare('INSERT INTO evaluation_rounds (ticket_id, round_no, status, locked_at, locked_by) VALUES (?, 2, ?, datetime(\'now\'), ?)').run(ticketInfo.lastInsertRowid, 'Hoan thanh', 'admin@masangroup.com');
    const question = db.prepare(`
      SELECT q.id, q.question_code, q.category
      FROM question_items q
      JOIN question_template_versions qv ON qv.id=q.question_template_version_id
      WHERE qv.template_id = ? AND qv.version_no=1
        AND q.facility_type = 'CHUNG' AND q.supplier_scale = 'LARGE'
      ORDER BY q.order_index, q.question_code
      LIMIT 1
    `).get(template.id);
    const extensionAnswer = db.prepare(`INSERT INTO evaluation_answers
      (round_id, question_item_id, score, comment, calculated_score, answered_by)
      VALUES (?, ?, 'D', 'Still open', 0, 'admin@masangroup.com')`)
      .run(round2.lastInsertRowid, question.id);
    db.prepare(`
      INSERT INTO evaluation_nonconformities (
        ticket_id, round_id, evaluation_answer_id, clause_code, category, nonconformity_content,
        remediation_content, due_date, severity, status, created_by
      )
      VALUES (?, ?, ?, ?, ?, 'Still open', 'Fix remaining issue', '2026-08-01', 'D', 'OPEN', 'admin@masangroup.com')
    `).run(ticketInfo.lastInsertRowid, round2.lastInsertRowid, extensionAnswer.lastInsertRowid,
      question.question_code, question.category);

    const appInfo = await startApp(evaluationsRouter);
    server = appInfo.server;
    const token = signToken({ email: 'admin@masangroup.com', isAdmin: true, role: 'Admin' }, 3600);

    const missingReasonRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-EXT/extensions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({ new_due_date: '2026-09-01' }),
    });
    assert.equal(missingReasonRes.status, 400);
    assert.equal((await missingReasonRes.json()).error, 'extension_reason_required');

    const missingDateRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-EXT/extensions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({ reason: 'Need more supplier time' }),
    });
    assert.equal(missingDateRes.status, 400);
    assert.equal((await missingDateRes.json()).error, 'extension_due_date_required');

    const invalidDateRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-EXT/extensions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({ reason: 'Need more supplier time', new_due_date: '2026-02-31' }),
    });
    assert.equal(invalidDateRes.status, 400);
    assert.equal((await invalidDateRes.json()).error, 'extension_due_date_invalid');

    const firstRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-EXT/extensions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({ reason: 'Supplier needs one more month', new_due_date: '2026-09-01' }),
    });
    const firstJson = await firstRes.json();
    assert.equal(firstRes.status, 201, JSON.stringify(firstJson));
    assert.equal(firstJson.item.extension_no, 1);
    assert.equal(firstJson.item.old_due_date, '2026-08-01');
    assert.equal(firstJson.item.new_due_date, '2026-09-01');
    assert.equal(firstJson.ticket.workflow_status, 'Gia hạn');
    assert.equal(firstJson.nonconformities[0].due_date, '2026-09-01');

    const secondRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-EXT/extensions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({ reason: 'Supplier plant shutdown', new_due_date: '2026-10-01' }),
    });
    const secondJson = await secondRes.json();
    assert.equal(secondRes.status, 201, JSON.stringify(secondJson));
    assert.equal(secondJson.item.extension_no, 2);
    assert.equal(secondJson.item.old_due_date, '2026-09-01');
    assert.equal(secondJson.correction_extensions.length, 2);

    const detailRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-EXT`, {
      headers: { Cookie: `qlcl_token=${token}` },
    });
    const detailJson = await detailRes.json();
    assert.equal(detailRes.status, 200, JSON.stringify(detailJson));
    assert.equal(detailJson.correction_extensions.length, 2);
    const historyRows = db.prepare('SELECT * FROM workflow_history WHERE ticket_id = ? AND action = ? ORDER BY id').all(ticketInfo.lastInsertRowid, 'CORRECTION_EXTENSION');
    assert.equal(historyRows.length, 2);
    assert.equal(historyRows[0].to_status, 'Gia hạn');
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

test('round 2 can be locked then optionally submitted to lead approval', async () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-round2-lead-${Date.now()}-${Math.random()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const oldJwtSecret = process.env.JWT_SECRET;
  const { db, signToken, evaluationsRouter } = freshModules(dbPath);
  let server;

  try {
    upsertCanonicalUser(db, { email: 'admin@masangroup.com', role: 'Admin', isAdmin: true });
    const supplierInfo = db.prepare(`
      INSERT INTO supplier_master (supplier_code, supplier_name, status, source_type)
      VALUES ('NCC-R2-LEAD', 'Round 2 Lead Supplier', 'ACTIVE', 'MANUAL')
    `).run();
    const templateInfo = db.prepare(`
      INSERT INTO question_templates (template_code, template_name, active)
      VALUES ('R25', 'Prompt 25 Test', 1)
    `).run();
    const canonicalQuestions = insertCanonicalQuestionSet(db, templateInfo.lastInsertRowid, [
      { code: 'R25-01', text: 'Requirement one', category: 'Quality', order: 1 },
      { code: 'R25-02', text: 'Requirement two', category: 'Quality', order: 2, critical: true },
      { code: 'R25-03', text: 'Requirement three', category: 'Quality', order: 3 },
      { code: 'R25-04', text: 'Requirement four', category: 'Quality', order: 4 },
    ]);
    const [q1, q2, q3, q4] = canonicalQuestions.ids;
    const ticketInfo = db.prepare(`
      INSERT INTO evaluation_tickets (
        ticket_code, supplier_id, supplier_code, supplier_name, evaluation_type, template_id,
        facility_type, supplier_scale, planned_date, current_status,
        current_round_no, completed_round, score_percent, grade_code, result_label,
        assigned_specialist_id, created_by
      )
      VALUES (
        'TICKET-R2-LEAD', @supplier_id, 'NCC-R2-LEAD', 'Round 2 Lead Supplier', 'Dinh ky', @template_id,
        'CHUNG', 'LARGE', '2026-07-01', @status,
        2, 2, 72, 'C', 'Dat co dieu kien',
        'admin@masangroup.com', 'admin@masangroup.com'
      )
    `).run({
      supplier_id: supplierInfo.lastInsertRowid,
      template_id: templateInfo.lastInsertRowid,
      status: '\u0110ang \u0111\u00e1nh gi\u00e1 l\u1ea7n 2',
    });
    db.prepare('INSERT INTO evaluation_rounds (ticket_id, round_no, status, locked_at, locked_by) VALUES (?, 1, ?, datetime(\'now\'), ?)').run(ticketInfo.lastInsertRowid, 'Hoan thanh', 'admin@masangroup.com');
    db.prepare('INSERT INTO evaluation_rounds (ticket_id, round_no, status) VALUES (?, 2, ?)').run(ticketInfo.lastInsertRowid, '\u0110ang x\u1eed l\u00fd');

    const appInfo = await startApp(evaluationsRouter);
    server = appInfo.server;
    const token = signToken({ email: 'admin@masangroup.com', isAdmin: true, role: 'Admin' }, 3600);
    const cleanPassAnswers = {
      [q1]: { score: 'A', note: '' },
      [q2]: { score: 'A', note: '' },
      [q3]: { score: 'A', note: '' },
      [q4]: { score: 'A', note: '' },
    };
    const blockedCompleteRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-R2-LEAD/rounds/2/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({ answers: cleanPassAnswers, attendees: REQUIRED_ATTENDEES, supplier_introduction: REQUIRED_SUPPLIER_INTRODUCTION, final_action: 'SUBMIT_LEAD' }),
    });
    const blockedCompleteJson = await blockedCompleteRes.json();
    assert.equal(blockedCompleteRes.status, 400, JSON.stringify(blockedCompleteJson));
    assert.equal(blockedCompleteJson.error, 'lead_submission_not_eligible');
    assert.equal(blockedCompleteJson.failed_critical_count, 0);

    const criticalBAnswers = {
      [q1]: { score: 'A', note: '' },
      [q2]: { score: 'B', note: 'Round 2 finding remains open' },
      [q3]: { score: 'A', note: '' },
      [q4]: { score: 'A', note: '' },
    };

    const blockedCriticalBCompleteRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-R2-LEAD/rounds/2/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({ answers: criticalBAnswers, attendees: REQUIRED_ATTENDEES, supplier_introduction: REQUIRED_SUPPLIER_INTRODUCTION, final_action: 'SUBMIT_LEAD' }),
    });
    const blockedCriticalBCompleteJson = await blockedCriticalBCompleteRes.json();
    assert.equal(blockedCriticalBCompleteRes.status, 400, JSON.stringify(blockedCriticalBCompleteJson));
    assert.equal(blockedCriticalBCompleteJson.error, 'lead_submission_not_eligible');
    assert.equal(blockedCriticalBCompleteJson.score_below_threshold, false);
    assert.equal(blockedCriticalBCompleteJson.failed_critical_count, 0);

    const answers = {
      [q1]: { score: 'A', note: '' },
      [q2]: { score: 'D', note: 'Round 2 critical clause remains failed at D' },
      [q3]: { score: 'A', note: '' },
      [q4]: { score: 'A', note: '' },
    };

    const completeForLeadRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-R2-LEAD/rounds/2/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({ answers, attendees: REQUIRED_ATTENDEES, supplier_introduction: REQUIRED_SUPPLIER_INTRODUCTION, final_action: 'SUBMIT_LEAD' }),
    });
    const completeForLeadJson = await completeForLeadRes.json();
    assert.equal(completeForLeadRes.status, 200, JSON.stringify(completeForLeadJson));
    assert.equal(completeForLeadJson.round.locked, true);
    assert.equal(completeForLeadJson.ticket.workflow_status, '\u0110ang \u0111\u00e1nh gi\u00e1 l\u1ea7n 2');
    assert.equal(completeForLeadJson.result.finalScore, 75);
    assert.equal(completeForLeadJson.result.lead_submission_eligible, true);
    assert.equal(completeForLeadJson.ticket.allowed_actions.includes('submit_lead'), true);
    assert.equal(completeForLeadJson.nonconformities.length, 1);
    assert.equal(completeForLeadJson.nonconformities[0].remediation, null);
    assert.equal(completeForLeadJson.nonconformities[0].due_date, null);

    const submitRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-R2-LEAD/submit-to-lead`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({ comment: '' }),
    });
    const submitJson = await submitRes.json();
    assert.equal(submitRes.status, 201, JSON.stringify(submitJson));
    assert.equal(submitJson.ticket.workflow_status, 'Ch\u1edd duy\u1ec7t (Lead)');
    assert.ok(submitJson.approval_tasks.some((task) => task.approval_level === 'LEAD' && task.status === 'PENDING'));
    const history = db.prepare('SELECT * FROM workflow_history WHERE ticket_id = ? AND action = ?').get(ticketInfo.lastInsertRowid, 'EVALUATION_RESULT_SUBMIT');
    assert.equal(history.from_status, '\u0110ang \u0111\u00e1nh gi\u00e1 l\u1ea7n 2');
    assert.equal(history.to_status, 'Ch\u1edd duy\u1ec7t (Lead)');
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

test('round 1 approval with nonconformities enters correction state before final completion', async () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-workflow-test-${Date.now()}-${Math.random()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const oldJwtSecret = process.env.JWT_SECRET;
  const { db, signToken, evaluationsRouter } = freshModules(dbPath);
  let server;

  try {
    upsertCanonicalUser(db, { email: 'admin@masangroup.com', role: 'Admin', isAdmin: true });
    const supplierInfo = db.prepare(`
      INSERT INTO supplier_master (supplier_code, supplier_name, status, source_type)
      VALUES ('NCC-WF', 'Workflow Supplier', 'ACTIVE', 'MANUAL')
    `).run();
    const template = db.prepare("SELECT id FROM question_templates WHERE template_code = 'BM04'").get();
    const questions = db.prepare(`
      SELECT q.id, q.question_code, q.category
      FROM question_items q
      JOIN question_template_versions qv ON qv.id=q.question_template_version_id
      WHERE qv.template_id = ? AND qv.version_no=1
        AND q.facility_type = 'CHUNG' AND q.supplier_scale = 'LARGE'
      ORDER BY q.order_index, q.question_code
      LIMIT 2
    `).all(template.id);
    assert.equal(questions.length, 2);

    const ticketInfo = db.prepare(`
      INSERT INTO evaluation_tickets (
        ticket_code, supplier_id, supplier_code, supplier_name, evaluation_type, template_id,
        facility_type, supplier_scale, planned_date, current_status, current_round_no,
        completed_round, score_percent, grade_code, result_label, scoring_locked,
        assigned_specialist_id, created_by
      )
      VALUES (
        'TICKET-WF', @supplier_id, 'NCC-WF', 'Workflow Supplier', 'Dinh ky', @template_id,
        'CHUNG', 'LARGE', '2026-07-01', 'Chờ duyệt (TBP)', 1,
        1, 72, 'B', 'Dat co dieu kien', 1,
        'admin@masangroup.com', 'admin@masangroup.com'
      )
    `).run({ supplier_id: supplierInfo.lastInsertRowid, template_id: template.id });
    const round1 = db.prepare(`
      INSERT INTO evaluation_rounds (ticket_id, round_no, status, locked_at, locked_by, total_score, final_result, classification)
      VALUES (?, 1, 'Hoàn thành', datetime('now'), 'admin@masangroup.com', 72, 'Dat co dieu kien', 'B')
    `).run(ticketInfo.lastInsertRowid);
    db.prepare(`
      INSERT INTO evaluation_answers (round_id, question_item_id, score, comment, calculated_score, answered_by)
      VALUES (?, ?, 'B', 'Needs correction', 75, 'admin@masangroup.com')
    `).run(round1.lastInsertRowid, questions[0].id);
    db.prepare(`
      INSERT INTO evaluation_answers (round_id, question_item_id, score, comment, calculated_score, answered_by)
      VALUES (?, ?, 'A', '', 100, 'admin@masangroup.com')
    `).run(round1.lastInsertRowid, questions[1].id);
    db.prepare(`
      INSERT INTO evaluation_nonconformities (
        ticket_id, round_id, evaluation_answer_id, clause_code, category, nonconformity_content, severity, status, created_by
      )
      VALUES (?, ?, ?, ?, ?, 'Needs correction', 'B', 'OPEN', 'admin@masangroup.com')
    `).run(ticketInfo.lastInsertRowid, round1.lastInsertRowid,
      db.prepare('SELECT id FROM evaluation_answers WHERE round_id=? AND question_item_id=?')
        .pluck().get(round1.lastInsertRowid, questions[0].id),
      questions[0].question_code, questions[0].category);
    db.prepare(`
      INSERT INTO approval_tasks (ticket_id, approval_level, assigned_role, status, comment)
      VALUES (?, 'TBP', 'TBP', 'PENDING', ?)
    `).run(ticketInfo.lastInsertRowid, JSON.stringify({ type: 'LEAD_APPROVED' }));

    const appInfo = await startApp(evaluationsRouter);
    server = appInfo.server;
    const token = signToken({ email: 'admin@masangroup.com', isAdmin: true, role: 'Admin' }, 3600);

    const approveRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-WF/tbp-approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({ comment: 'Approved for correction' }),
    });
    const approveJson = await approveRes.json();
    assert.equal(approveRes.status, 200, JSON.stringify(approveJson));
    assert.equal(approveJson.ticket.workflow_status, 'Chờ khắc phục');
    assert.ok(approveJson.workflow_history.some((row) => row.action === 'TBP_APPROVE' && row.to_status === 'Chờ khắc phục'));

    const editRound1Res = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-WF/rounds/1/answers`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({ answers: { [questions[0].id]: { score: 'A', note: '' } } }),
    });
    const editRound1Json = await editRound1Res.json();
    assert.equal(editRound1Res.status, 403, JSON.stringify(editRound1Json));
    assert.equal(editRound1Json.error, 'round_locked');

    const round2Res = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-WF/round-2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({}),
    });
    const round2Json = await round2Res.json();
    assert.equal(round2Res.status, 201, JSON.stringify(round2Json));
    assert.equal(round2Json.ticket.workflow_status, 'Đang đánh giá lần 2');
    assert.equal(round2Json.answers[String(questions[1].id)].score, 'A');
    assert.equal(round2Json.answers[String(questions[1].id)].readonly, true);

    const finalTicketInfo = db.prepare(`
      INSERT INTO evaluation_tickets (
        ticket_code, supplier_id, supplier_code, supplier_name, evaluation_type, template_id,
        facility_type, supplier_scale, planned_date, current_status, current_round_no,
        completed_round, score_percent, grade_code, result_label, scoring_locked,
        assigned_specialist_id, created_by
      )
      VALUES (
        'TICKET-WF-FINAL', @supplier_id, 'NCC-WF', 'Workflow Supplier', 'Dinh ky', @template_id,
        'CHUNG', 'LARGE', '2026-07-01', 'Chờ duyệt (TBP)', 2,
        2, 82, 'B', 'Dat', 1,
        'admin@masangroup.com', 'admin@masangroup.com'
      )
    `).run({ supplier_id: supplierInfo.lastInsertRowid, template_id: template.id });
    db.prepare(`
      INSERT INTO approval_tasks (ticket_id, approval_level, assigned_role, status, comment)
      VALUES (?, 'TBP', 'TBP', 'PENDING', ?)
    `).run(finalTicketInfo.lastInsertRowid, JSON.stringify({ type: 'LEAD_APPROVED' }));

    const finalRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-WF-FINAL/tbp-approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({ comment: 'Final approval' }),
    });
    const finalJson = await finalRes.json();
    assert.equal(finalRes.status, 200, JSON.stringify(finalJson));
    assert.equal(finalJson.ticket.workflow_status, 'Hoàn thành');
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

test('rejection comments are required and persisted to approval task, workflow history, and detail', async () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-reject-test-${Date.now()}-${Math.random()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const oldJwtSecret = process.env.JWT_SECRET;
  const { db, signToken, evaluationsRouter } = freshModules(dbPath);
  let server;

  try {
    upsertCanonicalUser(db, { email: 'admin@masangroup.com', role: 'Admin', isAdmin: true });
    const supplierInfo = db.prepare(`
      INSERT INTO supplier_master (supplier_code, supplier_name, status, source_type)
      VALUES ('NCC-REJ', 'Rejected Supplier', 'ACTIVE', 'MANUAL')
    `).run();
    const template = db.prepare("SELECT id FROM question_templates WHERE template_code = 'BM04'").get();
    const ticketInfo = db.prepare(`
      INSERT INTO evaluation_tickets (
        ticket_code, supplier_id, supplier_code, supplier_name, evaluation_type, template_id,
        facility_type, supplier_scale, planned_date, current_status, current_round_no,
        completed_round, score_percent, grade_code, result_label, scoring_locked,
        assigned_specialist_id, created_by
      )
      VALUES (
        'TICKET-REJECT', @supplier_id, 'NCC-REJ', 'Rejected Supplier', 'Dinh ky', @template_id,
        'CHUNG', 'LARGE', '2026-07-01', 'Chờ duyệt (Lead)', 1,
        1, 84, 'B', 'Dat', 1,
        'admin@masangroup.com', 'admin@masangroup.com'
      )
    `).run({ supplier_id: supplierInfo.lastInsertRowid, template_id: template.id });
    db.prepare(`
      INSERT INTO approval_tasks (ticket_id, approval_level, assigned_role, status, comment)
      VALUES (?, 'LEAD', 'Lead miền', 'PENDING', ?)
    `).run(ticketInfo.lastInsertRowid, JSON.stringify({ type: 'EVALUATION_RESULT', comment: 'Please review' }));

    const appInfo = await startApp(evaluationsRouter);
    server = appInfo.server;
    const token = signToken({ email: 'admin@masangroup.com', isAdmin: true, role: 'Admin' }, 3600);

    const missingRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-REJECT/lead-reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({ comment: '   ' }),
    });
    const missingJson = await missingRes.json();
    assert.equal(missingRes.status, 400, JSON.stringify(missingJson));
    assert.equal(missingJson.error, 'reject_comment_required');

    const comment = 'Need supplier evidence before approval';
    const rejectRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-REJECT/lead-reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({ comment }),
    });
    const rejectJson = await rejectRes.json();
    assert.equal(rejectRes.status, 200, JSON.stringify(rejectJson));
    assert.equal(rejectJson.workflow_history[0].comment, comment);

    const task = db.prepare('SELECT * FROM approval_tasks WHERE ticket_id = ? AND approval_level = ?').get(ticketInfo.lastInsertRowid, 'LEAD');
    assert.equal(task.status, 'REJECTED');
    assert.equal(JSON.parse(task.comment).approver_comment, comment);
    const history = db.prepare('SELECT * FROM workflow_history WHERE ticket_id = ? AND action = ?').get(ticketInfo.lastInsertRowid, 'LEAD_REJECT');
    assert.equal(history.comment, comment);

    const detailRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-REJECT`, {
      headers: { Cookie: `qlcl_token=${token}` },
    });
    const detailJson = await detailRes.json();
    assert.equal(detailRes.status, 200, JSON.stringify(detailJson));
    assert.equal(detailJson.rejection_history.length, 1);
    assert.equal(detailJson.rejection_history[0].comment, comment);
    assert.equal(detailJson.approval_tasks[0].payload.approver_comment, comment);
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

test('soft delete requires reason, enforces permissions, hides default list, and supports admin audit filter', async () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-delete-test-${Date.now()}-${Math.random()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const oldJwtSecret = process.env.JWT_SECRET;
  const { db, signToken, evaluationsRouter } = freshModules(dbPath);
  let server;

  try {
    upsertCanonicalUser(db, { email: 'admin@masangroup.com', role: 'Admin', isAdmin: true });
    upsertCanonicalUser(db, { email: 'lead@masangroup.com', role: 'Lead miền', isAdmin: false });
    const supplierInfo = db.prepare(`
      INSERT INTO supplier_master (supplier_code, supplier_name, status, source_type)
      VALUES ('NCC-DEL', 'Delete Supplier', 'ACTIVE', 'MANUAL')
    `).run();
    const template = db.prepare("SELECT id FROM question_templates WHERE template_code = 'BM04'").get();
    db.prepare(`
      INSERT INTO evaluation_tickets (
        ticket_code, supplier_id, supplier_code, supplier_name, evaluation_type, template_id,
        facility_type, supplier_scale, planned_date, current_status, current_round_no,
        assigned_specialist_id, created_by
      )
      VALUES (
        'TICKET-DELETE', @supplier_id, 'NCC-DEL', 'Delete Supplier', 'Dinh ky', @template_id,
        'CHUNG', 'LARGE', '2026-07-01', 'Khởi tạo', 1,
        'admin@masangroup.com', 'admin@masangroup.com'
      )
    `).run({ supplier_id: supplierInfo.lastInsertRowid, template_id: template.id });

    const appInfo = await startApp(evaluationsRouter);
    server = appInfo.server;
    const adminToken = signToken({ email: 'admin@masangroup.com', isAdmin: true, role: 'Admin' }, 3600);
    const leadToken = signToken({ email: 'lead@masangroup.com', isAdmin: false, role: 'Lead miền' }, 3600);

    const missingReasonRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-DELETE`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${adminToken}` },
      body: JSON.stringify({ reason: '   ' }),
    });
    const missingReasonJson = await missingReasonRes.json();
    assert.equal(missingReasonRes.status, 400, JSON.stringify(missingReasonJson));
    assert.equal(missingReasonJson.error, 'delete_reason_required');

    const forbiddenRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-DELETE`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${leadToken}` },
      body: JSON.stringify({ reason: 'No access' }),
    });
    const forbiddenJson = await forbiddenRes.json();
    assert.equal(forbiddenRes.status, 403, JSON.stringify(forbiddenJson));

    const deleteRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-DELETE`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${adminToken}` },
      body: JSON.stringify({ reason: 'Duplicate ticket' }),
    });
    const deleteJson = await deleteRes.json();
    assert.equal(deleteRes.status, 200, JSON.stringify(deleteJson));
    assert.equal(deleteJson.soft_deleted, true);

    const deletedRow = db.prepare('SELECT is_deleted, deleted_reason, deleted_by FROM evaluation_tickets WHERE ticket_code = ?').get('TICKET-DELETE');
    assert.equal(deletedRow.is_deleted, 1);
    assert.equal(deletedRow.deleted_reason, 'Duplicate ticket');
    assert.equal(deletedRow.deleted_by, 'admin@masangroup.com');
    const history = db.prepare('SELECT * FROM workflow_history WHERE action = ? AND ticket_id = (SELECT id FROM evaluation_tickets WHERE ticket_code = ?)').get('TICKET_SOFT_DELETE', 'TICKET-DELETE');
    assert.equal(history.comment, 'Duplicate ticket');

    const defaultListRes = await fetch(`${appInfo.baseUrl}/evaluations`, {
      headers: { Cookie: `qlcl_token=${adminToken}` },
    });
    const defaultListJson = await defaultListRes.json();
    assert.equal(defaultListRes.status, 200, JSON.stringify(defaultListJson));
    assert.equal(defaultListJson.tickets.some((ticket) => ticket.ticket_code === 'TICKET-DELETE'), false);

    const nonAdminAuditRes = await fetch(`${appInfo.baseUrl}/evaluations?include_deleted=1`, {
      headers: { Cookie: `qlcl_token=${leadToken}` },
    });
    const nonAdminAuditJson = await nonAdminAuditRes.json();
    assert.equal(nonAdminAuditRes.status, 403, JSON.stringify(nonAdminAuditJson));

    const auditRes = await fetch(`${appInfo.baseUrl}/evaluations?include_deleted=1`, {
      headers: { Cookie: `qlcl_token=${adminToken}` },
    });
    const auditJson = await auditRes.json();
    assert.equal(auditRes.status, 200, JSON.stringify(auditJson));
    const auditTicket = auditJson.tickets.find((ticket) => ticket.ticket_code === 'TICKET-DELETE');
    assert.ok(auditTicket);
    assert.equal(auditTicket.is_deleted, true);
    assert.equal(auditTicket.deleted_reason, 'Duplicate ticket');
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

test('specialists only access evaluation tickets they both created and are assigned to perform', async () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-owner-visibility-${Date.now()}-${Math.random()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const oldJwtSecret = process.env.JWT_SECRET;
  const { db, signToken, evaluationsRouter } = freshModules(dbPath);
  let server;

  try {
    upsertCanonicalUser(db, { email: 'owner@masangroup.com', role: 'Chuyên viên', isAdmin: false });
    upsertCanonicalUser(db, { email: 'other@masangroup.com', role: 'Chuyên viên', isAdmin: false });
    upsertCanonicalUser(db, { email: 'admin@masangroup.com', role: 'Admin', isAdmin: true });
    const supplier = db.prepare(`
      INSERT INTO supplier_master (supplier_code, supplier_name, status, source_type)
      VALUES ('NCC-OWN', 'Owner Supplier', 'ACTIVE', 'MANUAL')
    `).run();
    const template = db.prepare("SELECT id FROM question_templates WHERE template_code = 'BM04'").get();
    const insertTicket = db.prepare(`
      INSERT INTO evaluation_tickets (
        ticket_code, supplier_id, supplier_code, supplier_name, evaluation_type, template_id,
        facility_type, supplier_scale, planned_date, current_status, current_round_no,
        assigned_specialist_id, created_by
      )
      VALUES (
        @ticket_code, @supplier_id, @supplier_code, @supplier_name, 'Dinh ky', @template_id,
        'CHUNG', 'LARGE', '2026-07-01', 'Khởi tạo', 1,
        @assigned_specialist_id, @created_by
      )
    `);
    insertTicket.run({
      ticket_code: 'TICKET-OWNER',
      supplier_id: supplier.lastInsertRowid,
      supplier_code: 'NCC-OWN',
      supplier_name: 'Owner Supplier',
      template_id: template.id,
      assigned_specialist_id: 'owner@masangroup.com',
      created_by: 'owner@masangroup.com',
    });
    insertTicket.run({
      ticket_code: 'TICKET-OTHER',
      supplier_id: supplier.lastInsertRowid,
      supplier_code: 'NCC-OTHER',
      supplier_name: 'Other Supplier',
      template_id: template.id,
      assigned_specialist_id: 'other@masangroup.com',
      created_by: 'other@masangroup.com',
    });
    insertTicket.run({
      ticket_code: 'TICKET-REASSIGNED',
      supplier_id: supplier.lastInsertRowid,
      supplier_code: 'NCC-REASSIGNED',
      supplier_name: 'Reassigned Supplier',
      template_id: template.id,
      assigned_specialist_id: 'other@masangroup.com',
      created_by: 'owner@masangroup.com',
    });

    const appInfo = await startApp(evaluationsRouter);
    server = appInfo.server;
    const ownerToken = signToken({ email: 'owner@masangroup.com', isAdmin: false, role: 'Chuyên viên' }, 3600);
    const otherToken = signToken({ email: 'other@masangroup.com', isAdmin: false, role: 'Chuyên viên' }, 3600);
    const adminToken = signToken({ email: 'admin@masangroup.com', isAdmin: true, role: 'Admin' }, 3600);

    const listRes = await fetch(`${appInfo.baseUrl}/evaluations`, {
      headers: { Cookie: `qlcl_token=${ownerToken}` },
    });
    const listJson = await listRes.json();
    assert.equal(listRes.status, 200, JSON.stringify(listJson));
    assert.deepEqual(listJson.tickets.map((ticket) => ticket.ticket_code), ['TICKET-OWNER']);
    assert.equal(listJson.total, 1);

    const otherListRes = await fetch(`${appInfo.baseUrl}/evaluations?q=Other&page=1&page_size=1`, {
      headers: { Cookie: `qlcl_token=${otherToken}` },
    });
    const otherListJson = await otherListRes.json();
    assert.equal(otherListRes.status, 200, JSON.stringify(otherListJson));
    assert.equal(otherListJson.total, 1);
    assert.equal(otherListJson.page, 1);
    assert.equal(otherListJson.page_size, 1);
    assert.deepEqual(otherListJson.tickets.map((ticket) => ticket.ticket_code), ['TICKET-OTHER']);

    const searchOtherRes = await fetch(`${appInfo.baseUrl}/evaluations?q=Other`, {
      headers: { Cookie: `qlcl_token=${ownerToken}` },
    });
    const searchOtherJson = await searchOtherRes.json();
    assert.equal(searchOtherRes.status, 200, JSON.stringify(searchOtherJson));
    assert.equal(searchOtherJson.total, 0);

    const searchReassignedRes = await fetch(`${appInfo.baseUrl}/evaluations?q=Reassigned`, {
      headers: { Cookie: `qlcl_token=${ownerToken}` },
    });
    const searchReassignedJson = await searchReassignedRes.json();
    assert.equal(searchReassignedRes.status, 200, JSON.stringify(searchReassignedJson));
    assert.equal(searchReassignedJson.total, 0);

    const bootstrapRes = await fetch(`${appInfo.baseUrl}/evaluations/bootstrap`, {
      headers: { Cookie: `qlcl_token=${ownerToken}` },
    });
    const bootstrapJson = await bootstrapRes.json();
    assert.equal(bootstrapRes.status, 200, JSON.stringify(bootstrapJson));
    assert.deepEqual(bootstrapJson.tickets.map((ticket) => ticket.ticket_code), ['TICKET-OWNER']);

    const ownDetailRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-OWNER`, {
      headers: { Cookie: `qlcl_token=${ownerToken}` },
    });
    assert.equal(ownDetailRes.status, 200, await ownDetailRes.text());

    const otherDetailRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-OTHER`, {
      headers: { Cookie: `qlcl_token=${ownerToken}` },
    });
    const otherDetailJson = await otherDetailRes.json();
    assert.equal(otherDetailRes.status, 403, JSON.stringify(otherDetailJson));

    const reassignedCreatorDetailRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-REASSIGNED`, {
      headers: { Cookie: `qlcl_token=${ownerToken}` },
    });
    assert.equal(reassignedCreatorDetailRes.status, 403, await reassignedCreatorDetailRes.text());

    const reassignedOwnerDetailRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-REASSIGNED`, {
      headers: { Cookie: `qlcl_token=${otherToken}` },
    });
    const reassignedOwnerDetailJson = await reassignedOwnerDetailRes.json();
    assert.equal(reassignedOwnerDetailRes.status, 403, JSON.stringify(reassignedOwnerDetailJson));

    const editOtherRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-OTHER`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${ownerToken}` },
      body: JSON.stringify({ planned_date: '2026-07-02' }),
    });
    const editOtherJson = await editOtherRes.json();
    assert.equal(editOtherRes.status, 403, JSON.stringify(editOtherJson));

    const exportOtherRes = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-OTHER/reports/export-print`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${ownerToken}` },
      body: JSON.stringify({ report_type: 'ROUND1_RESULT', round_no: 1 }),
    });
    const exportOtherJson = await exportOtherRes.json();
    assert.equal(exportOtherRes.status, 403, JSON.stringify(exportOtherJson));

    const summaryOtherRes = await fetch(`${appInfo.baseUrl}/evaluations/export-summary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${otherToken}` },
      body: JSON.stringify({ filters: { q: 'Other' } }),
    });
    assert.equal(summaryOtherRes.status, 200, await summaryOtherRes.text());
    assert.equal(summaryOtherRes.headers.get('x-export-row-count'), '1');

    const summaryCreatorRes = await fetch(`${appInfo.baseUrl}/evaluations/export-summary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${ownerToken}` },
      body: JSON.stringify({ filters: { q: 'Reassigned' } }),
    });
    const summaryCreatorJson = await summaryCreatorRes.json();
    assert.equal(summaryCreatorRes.status, 404, JSON.stringify(summaryCreatorJson));
    assert.equal(summaryCreatorJson.error, 'no_matching_evaluations');

    const adminListRes = await fetch(`${appInfo.baseUrl}/evaluations`, {
      headers: { Cookie: `qlcl_token=${adminToken}` },
    });
    const adminListJson = await adminListRes.json();
    assert.equal(adminListRes.status, 200, JSON.stringify(adminListJson));
    const adminCodes = adminListJson.tickets.map((ticket) => ticket.ticket_code);
    assert.ok(adminCodes.includes('TICKET-OWNER'));
    assert.ok(adminCodes.includes('TICKET-OTHER'));
    assert.ok(adminCodes.includes('TICKET-REASSIGNED'));
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

test('approval bootstrap only returns records pending the current approver role', async () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-approval-visibility-${Date.now()}-${Math.random()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const oldJwtSecret = process.env.JWT_SECRET;
  const { db, signToken, evaluationsRouter } = freshModules(dbPath);
  let server;

  try {
    upsertCanonicalUser(db, { email: 'lead@masangroup.com', role: 'Lead miền', isAdmin: false });
    upsertCanonicalUser(db, { email: 'tbp@masangroup.com', role: 'TBP', isAdmin: false });
    upsertCanonicalUser(db, { email: 'gdk@masangroup.com', role: 'GĐK', isAdmin: false });
    upsertCanonicalUser(db, { email: 'specialist@masangroup.com', role: 'Chuyên viên', isAdmin: false });
    upsertCanonicalUser(db, { email: 'admin@masangroup.com', role: 'Admin', isAdmin: true });
    const supplier = db.prepare(`
      INSERT INTO supplier_master (supplier_code, supplier_name, status, source_type)
      VALUES ('NCC-APR', 'Approval Supplier', 'ACTIVE', 'MANUAL')
    `).run();
    const template = db.prepare("SELECT id FROM question_templates WHERE template_code = 'BM04'").get();
    const insertTicket = db.prepare(`
      INSERT INTO evaluation_tickets (
        ticket_code, supplier_id, supplier_code, supplier_name, evaluation_type, template_id,
        facility_type, supplier_scale, planned_date, current_status, current_round_no,
        assigned_specialist_id, created_by
      )
      VALUES (
        @ticket_code, @supplier_id, @supplier_code, @supplier_name, 'Dinh ky', @template_id,
        'CHUNG', 'LARGE', '2026-08-01', @current_status, 1,
        'specialist@masangroup.com', 'specialist@masangroup.com'
      )
    `);
    const taskRows = [
      ['TICKET-APP-LEAD', 'Lead Approval Supplier', 'Chờ duyệt (Lead)', 'LEAD', 'Lead miền', 'PENDING'],
      ['TICKET-APP-TBP', 'TBP Approval Supplier', 'Chờ duyệt (TBP)', 'TBP', 'TBP', 'PENDING'],
      ['TICKET-APP-GDK', 'GDK Approval Supplier', 'Chờ duyệt (GĐK)', 'GDK', 'GĐK', 'PENDING'],
      ['TICKET-APP-CLOSED', 'Closed Approval Supplier', 'Chờ duyệt (Lead)', 'LEAD', 'Lead miền', 'APPROVED'],
    ];
    for (const [ticketCode, supplierName, currentStatus, approvalLevel, assignedRole, taskStatus] of taskRows) {
      const info = insertTicket.run({
        ticket_code: ticketCode,
        supplier_id: supplier.lastInsertRowid,
        supplier_code: `NCC-${approvalLevel}`,
        supplier_name: supplierName,
        template_id: template.id,
        current_status: currentStatus,
      });
      db.prepare(`
        INSERT INTO approval_tasks (ticket_id, approval_level, assigned_role, status, comment)
        VALUES (?, ?, ?, ?, ?)
      `).run(info.lastInsertRowid, approvalLevel, assignedRole, taskStatus, `${approvalLevel} task`);
    }

    const appInfo = await startApp(evaluationsRouter);
    server = appInfo.server;
    const leadToken = signToken({ email: 'lead@masangroup.com', isAdmin: false, role: 'Lead miền' }, 3600);
    const tbpToken = signToken({ email: 'tbp@masangroup.com', isAdmin: false, role: 'TBP' }, 3600);
    const gdkToken = signToken({ email: 'gdk@masangroup.com', isAdmin: false, role: 'GĐK' }, 3600);
    const adminToken = signToken({ email: 'admin@masangroup.com', isAdmin: true, role: 'Admin' }, 3600);

    async function bootstrapCodes(token) {
      const res = await fetch(`${appInfo.baseUrl}/evaluations/bootstrap`, {
        headers: { Cookie: `qlcl_token=${token}` },
      });
      const json = await res.json();
      assert.equal(res.status, 200, JSON.stringify(json));
      return json.tickets.map((ticket) => ticket.ticket_code);
    }

    async function workspaceTotal(token) {
      const res = await fetch(`${appInfo.baseUrl}/evaluations`, {
        headers: { Cookie: `qlcl_token=${token}` },
      });
      const json = await res.json();
      assert.equal(res.status, 200, JSON.stringify(json));
      return json.total;
    }

    const leadCodes = await bootstrapCodes(leadToken);
    assert.ok(leadCodes.includes('TICKET-APP-LEAD'));
    assert.equal(leadCodes.includes('TICKET-APP-TBP'), false);
    assert.equal(leadCodes.includes('TICKET-APP-GDK'), false);
    assert.equal(leadCodes.includes('TICKET-APP-CLOSED'), false);
    assert.equal(await workspaceTotal(leadToken), 0);

    const tbpCodes = await bootstrapCodes(tbpToken);
    assert.ok(tbpCodes.includes('TICKET-APP-TBP'));
    assert.equal(tbpCodes.includes('TICKET-APP-LEAD'), false);
    assert.equal(tbpCodes.includes('TICKET-APP-GDK'), false);
    assert.equal(await workspaceTotal(tbpToken), 0);

    const gdkCodes = await bootstrapCodes(gdkToken);
    assert.ok(gdkCodes.includes('TICKET-APP-GDK'));
    assert.equal(gdkCodes.includes('TICKET-APP-LEAD'), false);
    assert.equal(gdkCodes.includes('TICKET-APP-TBP'), false);
    assert.equal(await workspaceTotal(gdkToken), 0);

    const adminCodes = await bootstrapCodes(adminToken);
    assert.ok(adminCodes.includes('TICKET-APP-LEAD'));
    assert.ok(adminCodes.includes('TICKET-APP-TBP'));
    assert.ok(adminCodes.includes('TICKET-APP-GDK'));
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

test('round 2 completion updates corrected result fields and next evaluation planning', async () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-correction-test-${Date.now()}-${Math.random()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const oldJwtSecret = process.env.JWT_SECRET;
  const { db, signToken, evaluationsRouter } = freshModules(dbPath);
  let server;

  try {
    upsertCanonicalUser(db, { email: 'admin@masangroup.com', role: 'Admin', isAdmin: true });
    const supplierInfo = db.prepare(`
      INSERT INTO supplier_master (supplier_code, supplier_name, status, source_type)
      VALUES ('NCC-CORR', 'Correction Supplier', 'ACTIVE', 'MANUAL')
    `).run();
    const templateInfo = db.prepare(`
      INSERT INTO question_templates (template_code, template_name, active)
      VALUES ('R14', 'Prompt 14 Test', 1)
    `).run();
    const [q1, q2] = insertCanonicalQuestionSet(db, templateInfo.lastInsertRowid, [
      { code: 'R14-01', text: 'Requirement one', category: 'Legal', order: 1 },
      { code: 'R14-02', text: 'Requirement two', category: 'Quality', order: 2 },
    ]).ids;
    const ticketInfo = db.prepare(`
      INSERT INTO evaluation_tickets (
        ticket_code, supplier_id, supplier_code, supplier_name, evaluation_type, template_id,
        facility_type, supplier_scale, planned_date, actual_evaluation_date, current_status,
        current_round_no, completed_round, score_percent, grade_code, result_label,
        assigned_specialist_id, created_by
      )
      VALUES (
        'TICKET-CORR', @supplier_id, 'NCC-CORR', 'Correction Supplier', 'Dinh ky', @template_id,
        'CHUNG', 'LARGE', '2026-07-01', '2026-07-02', 'Đang đánh giá lần 2',
        2, 2, 72, 'C', 'Dat co dieu kien',
        'admin@masangroup.com', 'admin@masangroup.com'
      )
    `).run({ supplier_id: supplierInfo.lastInsertRowid, template_id: templateInfo.lastInsertRowid });
    db.prepare(`
      INSERT INTO evaluation_rounds (ticket_id, round_no, status, completed_at, locked_at, locked_by, total_score, final_result, classification)
      VALUES (?, 1, 'Hoàn thành', '2026-07-02', '2026-07-02', 'admin@masangroup.com', 72, 'Đạt mức cơ bản, đánh giá lại sau 6 tháng', 'C')
    `).run(ticketInfo.lastInsertRowid);
    db.prepare('INSERT INTO evaluation_rounds (ticket_id, round_no, status) VALUES (?, 2, ?)').run(ticketInfo.lastInsertRowid, 'Đang xử lý');

    const appInfo = await startApp(evaluationsRouter);
    server = appInfo.server;
    const token = signToken({ email: 'admin@masangroup.com', isAdmin: true, role: 'Admin' }, 3600);

    const res = await fetch(`${appInfo.baseUrl}/evaluations/TICKET-CORR/rounds/2/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `qlcl_token=${token}` },
      body: JSON.stringify({
        attendees: REQUIRED_ATTENDEES,
        supplier_introduction: REQUIRED_SUPPLIER_INTRODUCTION,
        answers: {
          [q1]: { score: 'A', note: '' },
          [q2]: { score: 'B', note: 'Round 2 finding remains open' },
        },
      }),
    });
    const json = await res.json();
    assert.equal(res.status, 200, JSON.stringify(json));
    assert.equal(json.result.grade, 'B');
    assert.match(json.result.label, /1 n/);
    assert.equal(json.nonconformities.length, 1);
    assert.equal(json.nonconformities[0].remediation, null);
    assert.equal(json.nonconformities[0].due_date, null);
    assert.equal(json.ticket.round_1_score_percent, 72);
    assert.equal(json.ticket.round_1_grade_code, 'C');
    assert.equal(json.ticket.display_score_percent, 87.5);
    assert.equal(json.ticket.display_grade_code, 'B');

    const row = db.prepare('SELECT * FROM evaluation_tickets WHERE ticket_code = ?').get('TICKET-CORR');
    assert.equal(row.score_percent, 72);
    assert.equal(row.grade_code, 'C');
    assert.equal(row.corrected_score_percent, 87.5);
    assert.equal(row.corrected_grade_code, 'B');
    assert.match(row.corrected_result_label, /1 n/);
    assert.equal(row.final_conclusion, 'Đạt');
    assert.equal(row.current_status, 'Ho\u00e0n th\u00e0nh');
    assert.match(row.correction_date, /^\d{4}-\d{2}-\d{2}$/);
    const expectedYear = String(Number(row.correction_date.slice(0, 4)) + 1) + row.correction_date.slice(4);
    assert.equal(row.next_evaluation_date, expectedYear);
    const history = db.prepare('SELECT * FROM workflow_history WHERE ticket_id = ? AND action = ?').get(ticketInfo.lastInsertRowid, 'ROUND_2_END');
    assert.equal(history.to_status, 'Ho\u00e0n th\u00e0nh');
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

test('ticket legal documents upload, validate type, and expose download links', async () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-ticket-files-${Date.now()}-${Math.random()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const oldJwtSecret = process.env.JWT_SECRET;
  const { db, signToken, evaluationsRouter } = freshModules(dbPath);
  let server;

  try {
    upsertCanonicalUser(db, { email: 'admin@masangroup.com', role: 'Admin', isAdmin: true });

    const appInfo = await startApp(evaluationsRouter);
    server = appInfo.server;
    const token = signToken({ email: 'admin@masangroup.com', isAdmin: true, role: 'Admin' }, 3600);

    const baseFields = {
      supplier_code: 'NCC-FILE',
      supplier_name: 'File Supplier',
      tax_code: 'NCC-FILE-TAX',
      address: 'File Supplier HQ',
      region: 'MB',
      province: 'Thành phố Hà Nội',
      business_type: 'Tự sản xuất',
      contact_name: 'File Contact',
      contact_email: 'file-contact@example.test',
      contact_phone: '0900000019',
      evaluation_type: 'Dinh ky',
      template: 'BM04',
      facility_type: 'CHUNG',
      supplier_scale: 'LARGE',
      planned_date: '2026-07-15',
      cmc_owner: 'CMC Owner',
      cmc_head: 'CMC Head',
      mch2: 'Th\u1ef1c ph\u1ea9m c\u00f4ng ngh\u1ec7',
      mch3: 'Th\u1ef1c ph\u1ea9m kh\u00f4',
      product_name: 'File product',
      snapshot_evaluation_address: 'File audit address',
    };

    const invalidForm = new FormData();
    Object.entries(baseFields).forEach(([key, value]) => invalidForm.append(key, value));
    invalidForm.append('business_license_file', new Blob(['nope'], { type: 'text/plain' }), 'license.exe');
    const invalidRes = await fetch(`${appInfo.baseUrl}/evaluations`, {
      method: 'POST',
      headers: { Cookie: `qlcl_token=${token}` },
      body: invalidForm,
    });
    const invalidJson = await invalidRes.json();
    assert.equal(invalidRes.status, 400, JSON.stringify(invalidJson));
    assert.equal(invalidJson.error, 'file_type_not_allowed');

    const form = new FormData();
    Object.entries(baseFields).forEach(([key, value]) => form.append(key, value));
    form.append('business_license_file', new Blob(['license-pdf'], { type: 'application/pdf' }), 'license.pdf');
    form.append('attp_certificate_file', new Blob(['attp-png'], { type: 'image/png' }), 'attp.png');

    const res = await fetch(`${appInfo.baseUrl}/evaluations`, {
      method: 'POST',
      headers: { Cookie: `qlcl_token=${token}` },
      body: form,
    });
    const json = await res.json();
    assert.equal(res.status, 201, JSON.stringify(json));
    assert.equal(json.ticket.supplier.business_license_file, 'license.pdf');
    assert.equal(json.ticket.supplier.attp_certificate_file, 'attp.png');

    const detailRes = await fetch(`${appInfo.baseUrl}/evaluations/${encodeURIComponent(json.ticket.ticket_code)}`, {
      headers: { Cookie: `qlcl_token=${token}` },
    });
    const detailJson = await detailRes.json();
    assert.equal(detailRes.status, 200, JSON.stringify(detailJson));
    assert.equal(detailJson.legal_attachments.business_license.file_name, 'license.pdf');
    assert.equal(detailJson.legal_attachments.business_license.kind, 'business_license');
    assert.equal(detailJson.legal_attachments.attp_certificate.file_name, 'attp.png');
    assert.equal(detailJson.legal_attachments.attp_certificate.kind, 'attp_certificate');
    assert.match(detailJson.legal_attachments.business_license.download_url, /\/attachments\/\d+\/download$/);

    const downloadRes = await fetch(`${appInfo.baseUrl}/evaluations/attachments/${detailJson.legal_attachments.business_license.id}/download`, {
      headers: { Cookie: `qlcl_token=${token}` },
    });
    assert.equal(downloadRes.status, 200);
    assert.equal(await downloadRes.text(), 'license-pdf');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    try {
      const rows = db.prepare('SELECT file_path FROM evaluation_attachments WHERE file_path IS NOT NULL').all();
      rows.forEach((row) => fs.rmSync(row.file_path, { force: true }));
    } catch {}
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
