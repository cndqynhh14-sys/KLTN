const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const express = require('express');
const cookieParser = require('cookie-parser');
const { canonicalTokenFactory } = require('./helpers/canonicalAuth');
const { upsertCanonicalUser } = require('./helpers/canonicalUser');

function freshDb(dbPath) {
  process.env.DB_PATH = dbPath;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'run17-test-secret';
  delete require.cache[require.resolve('../server/db')];
  return require('../server/db').db;
}

function syntheticContext(definitionCode, roundNo) {
  return {
    context_schema_version: 1,
    definition_code: definitionCode,
    ticket: {
      id: 1701,
      code: 'RUN17-SYNTHETIC',
      question_template_version_id: 81,
    },
    round: {
      id: 91,
      round_no: roundNo,
      status: 'COMPLETED',
      locked_at: '2026-07-14T08:00:00.000Z',
      completed_at: '2026-07-14T08:00:00.000Z',
    },
    scoring: {
      compatibility_marker: 'LEGACY_SCORING_V1_UNVERSIONED',
      scoring_policy_version_id: null,
    },
    doc4: {
      related_information: {
        report_no: `RUN17-SYNTHETIC-R${roundNo}`,
        evaluation_date: '2026-07-14',
        evaluators: 'Synthetic QA',
        supplier_name: 'Synthetic Supplier',
        supplier_code: 'SYN-NCC-17',
        evaluation_address: 'Synthetic facility',
      },
      scope: {
        product: 'Synthetic product',
        business_type: 'Manufacturer',
        evaluation_type: 'Periodic',
        question_template_version_id: 81,
      },
      participants: {
        rows: [{ name: 'Synthetic QA', opening: true, closing: true }],
      },
      supplier_introduction: { content: 'Synthetic supplier introduction' },
      compliance_summary: [{
        category: 'Legal', counts: { A: 1, B: 0, C: 0, D: 0, NA: 0 }, percentage: 100,
      }],
      nonconformity_summary: [{
        clause: 'SYN-1', category: 'Legal', score: 'B', description: 'Synthetic finding',
        corrective_action: 'Synthetic action', due_date: '2026-08-01', status: 'OPEN',
      }],
      result_summary: {
        final_score_percent: '100.0%', final_result_label: 'Pass', final_conclusion: 'Pass',
      },
      signatures: {
        evaluator: 'Synthetic QA', supplier_representative: 'Synthetic NCC', approved_by: 'Synthetic Approver',
      },
    },
    corrective_action_rows: [{
      issue_description: 'Synthetic finding', required_action: 'Synthetic action', status: 'OPEN',
    }],
    approval_history_rows: [{ action: 'APPROVED', actor_role: 'TBP', created_at: '2026-07-14' }],
  };
}

function startApp(router) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/report-templates', router);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test('RUN-17 canonical catalog and migration do not auto-map INTERNAL/NCC legacy candidates', () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-run17-schema-${Date.now()}-${Math.random()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const db = freshDb(dbPath);
  try {
    const { CANONICAL_DEFINITION_CODES, LEGACY_REPORT_CANDIDATES } = require('../server/reporting/definitionCatalog');
    assert.deepEqual(CANONICAL_DEFINITION_CODES, ['WORKING_MINUTES', 'ROUND1_RESULT', 'ROUND2_RESULT']);
    assert.deepEqual(LEGACY_REPORT_CANDIDATES, ['INTERNAL', 'NCC']);

    const definitions = db.prepare('SELECT definition_code FROM report_definitions ORDER BY definition_code').all();
    assert.deepEqual(definitions.map((row) => row.definition_code), [
      'ROUND1_RESULT', 'ROUND2_RESULT', 'WORKING_MINUTES',
    ]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM report_definitions WHERE definition_code IN ('INTERNAL','NCC')").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM report_template_versions WHERE status='PUBLISHED'").get().n, 3);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM report_template_assignments WHERE active=1 AND is_default=1').get().n, 3);

    const exportColumns = db.prepare("PRAGMA table_info('report_exports')").all().map((row) => row.name);
    for (const column of [
      'report_template_version_id', 'definition_code', 'context_checksum',
      'component_checksum', 'scoring_compatibility_marker',
    ]) assert.ok(exportColumns.includes(column), `missing report_exports.${column}`);
  } finally {
    db.close();
    delete require.cache[require.resolve('../server/db')];
    if (oldDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = oldDbPath;
    fs.rmSync(dbPath, { force: true });
  }
});

test('RUN-17 Draft preview, publish, parity, immutability and rollback use one versioned component tree', () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-run17-engine-${Date.now()}-${Math.random()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const db = freshDb(dbPath);
  try {
    upsertCanonicalUser(db, { email: 'run17-agent@synthetic.invalid', role: 'Admin', isAdmin: true });
    upsertCanonicalUser(db, { email: 'run17-publisher@synthetic.invalid', role: 'Admin', isAdmin: true });
    const ReportTemplateVersionRepository = require('../server/reporting/ReportTemplateVersionRepository');
    const { ReportOrchestrator } = require('../server/reporting/ReportOrchestrator');
    const repository = new ReportTemplateVersionRepository(db);
    const contextBuilder = ({ definition, roundNo }) => syntheticContext(definition.code, roundNo);
    const orchestrator = new ReportOrchestrator({ db, repository, contextBuilder });

    const publishedV1 = repository.resolvePublished({ definitionCode: 'ROUND1_RESULT', at: '2026-07-14' });
    assert.equal(publishedV1.status, 'PUBLISHED');
    const productionV1 = orchestrator.renderProduction({
      definitionCode: 'ROUND1_RESULT', ticket: { id: 1701 }, roundNo: 1, format: 'HTML', at: '2026-07-14',
    });

    const draft = repository.createDraft({
      definitionCode: 'ROUND1_RESULT', sourceVersionId: publishedV1.id,
      name: 'Round 1 synthetic v2', note: 'RUN-17 test', actor: 'run17-agent@synthetic.invalid',
    });
    const draftDefinition = JSON.parse(draft.definition_json);
    draftDefinition.components.splice(1, 0, {
      id: 'draft-watermark', type: 'text_block', text: 'DRAFT WATERMARK RUN-17',
    });
    const changedDraft = repository.updateDraft({
      versionId: draft.id,
      expectedLockVersion: draft.lock_version,
      definition: draftDefinition,
      actor: 'run17-agent@synthetic.invalid',
    });
    const draftPreview = orchestrator.previewVersion({
      versionId: changedDraft.id, ticket: { id: 1701 }, roundNo: 1, format: 'HTML',
    });
    assert.match(draftPreview.buffer.toString('utf8'), /DRAFT WATERMARK RUN-17/);
    assert.doesNotMatch(productionV1.buffer.toString('utf8'), /DRAFT WATERMARK RUN-17/);

    for (const format of ['HTML', 'PDF', 'XLSX']) {
      const rendered = orchestrator.previewVersion({
        versionId: changedDraft.id, ticket: { id: 1701 }, roundNo: 1, format,
      });
      assert.equal(rendered.template_version_id, changedDraft.id);
      assert.equal(rendered.context.ticket.question_template_version_id, 81);
      assert.equal(rendered.context.scoring.compatibility_marker, 'LEGACY_SCORING_V1_UNVERSIONED');
      assert.equal(rendered.semantic_checksum, draftPreview.semantic_checksum);
      assert.equal(rendered.context_checksum, draftPreview.context_checksum);
      assert.ok(Buffer.isBuffer(rendered.buffer));
      if (format === 'PDF') assert.equal(rendered.buffer.subarray(0, 4).toString('utf8'), '%PDF');
      if (format === 'XLSX') {
        const workbook = XLSX.read(rendered.buffer, { type: 'buffer' });
        assert.ok(workbook.SheetNames.includes('Report'));
        assert.ok(XLSX.utils.sheet_to_json(workbook.Sheets.Report, { header: 1 }).flat().includes('DRAFT WATERMARK RUN-17'));
      }
    }

    const submitted = repository.submit({
      versionId: changedDraft.id,
      expectedLockVersion: changedDraft.lock_version,
      actor: 'run17-agent@synthetic.invalid',
    });
    const publishedV2 = repository.publish({
      versionId: submitted.id,
      expectedLockVersion: submitted.lock_version,
      actor: 'run17-publisher@synthetic.invalid',
    });
    const productionV2 = orchestrator.renderProduction({
      definitionCode: 'ROUND1_RESULT', ticket: { id: 1701 }, roundNo: 1, format: 'HTML', at: '2026-07-14',
    });
    assert.equal(productionV2.template_version_id, publishedV2.id);
    assert.match(productionV2.buffer.toString('utf8'), /DRAFT WATERMARK RUN-17/);
    assert.throws(() => repository.updateDraft({
      versionId: publishedV2.id,
      expectedLockVersion: publishedV2.lock_version,
      definition: draftDefinition,
      actor: 'run17-agent@synthetic.invalid',
    }), (error) => error.code === 'report_template_version_not_draft');
    assert.throws(() => db.prepare('UPDATE report_template_versions SET version_name=? WHERE id=?')
      .run('Database bypass attempt', publishedV2.id), /published_report_template_immutable/);

    const rolledBack = repository.rollback({
      versionId: publishedV1.id,
      expectedLockVersion: repository.getVersion(publishedV1.id).lock_version,
      actor: 'run17-publisher@synthetic.invalid',
    });
    assert.equal(rolledBack.id, publishedV1.id);
    const productionAfterRollback = orchestrator.renderProduction({
      definitionCode: 'ROUND1_RESULT', ticket: { id: 1701 }, roundNo: 1, format: 'HTML', at: '2026-07-14',
    });
    assert.equal(productionAfterRollback.template_version_id, publishedV1.id);
    assert.doesNotMatch(productionAfterRollback.buffer.toString('utf8'), /DRAFT WATERMARK RUN-17/);

    db.prepare(`
      UPDATE report_template_assignments SET active=0, is_default=0
      WHERE definition_code='WORKING_MINUTES'
    `).run();
    assert.throws(() => orchestrator.renderProduction({
      definitionCode: 'WORKING_MINUTES', ticket: { id: 1701 }, roundNo: 1, format: 'HTML', at: '2026-07-14',
    }), (error) => error.code === 'published_report_template_not_found');
  } finally {
    db.close();
    delete require.cache[require.resolve('../server/db')];
    if (oldDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = oldDbPath;
    fs.rmSync(dbPath, { force: true });
  }
});

test('RUN-17 rejects unsafe components, unknown bindings, wrong rounds and missing production assignments', () => {
  const { validateComponentTree } = require('../server/reporting/componentRegistry');
  const { validateReportContext } = require('../server/reporting/dataContract');
  const { getDefinition } = require('../server/reporting/definitionCatalog');

  assert.throws(() => validateComponentTree({
    schema_version: 1,
    components: [{ id: 'unsafe', type: 'text_block', text: '<script>alert(1)</script>' }],
  }), (error) => error.code === 'unsafe_report_template');
  assert.throws(() => validateComponentTree({
    schema_version: 1,
    components: [{ id: 'unknown-binding', type: 'text_block', binding: 'doc4.secret.value' }],
  }), (error) => error.code === 'report_binding_not_allowed');
  assert.throws(() => validateComponentTree({
    schema_version: 1,
    components: [{ id: 'unknown-property', type: 'text_block', text: 'safe', unregistered: true }],
  }), (error) => error.code === 'report_component_properties_invalid');
  assert.throws(() => getDefinition('ROUND1_RESULT').validateRound(2), (error) => error.code === 'report_round_not_allowed');
  assert.throws(() => validateReportContext({ ...syntheticContext('ROUND1_RESULT', 1), scoring: null }),
    (error) => error.code === 'report_context_invalid');
  const incomplete = syntheticContext('ROUND1_RESULT', 1);
  delete incomplete.doc4.signatures;
  assert.throws(() => validateReportContext(incomplete), (error) => (
    error.code === 'report_context_invalid' && error.details.fields.includes('doc4.signatures')
  ));
});

test('RUN-19 canonical export pins template, question, and scoring policy versions in the export record', () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-run17-export-${Date.now()}-${Math.random()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const db = freshDb(dbPath);
  try {
    const actor = 'run17-exporter@synthetic.invalid';
    upsertCanonicalUser(db, {
      email: actor, role: 'Admin', isAdmin: true, displayName: 'RUN-17 Synthetic Exporter',
    });
    const supplier = db.prepare(`
      INSERT INTO supplier_master (supplier_code, supplier_name, status, source_type)
      VALUES ('RUN17-NCC', 'RUN-17 Synthetic Supplier', 'ACTIVE', 'MANUAL')
    `).run();
    const questionVersion = db.prepare(`
      SELECT v.id, v.template_id
      FROM question_template_versions v
      JOIN question_templates t ON t.id=v.template_id
      WHERE t.template_code='BM01' AND v.status='PUBLISHED'
      ORDER BY v.version_no DESC LIMIT 1
    `).get();
    assert.ok(questionVersion);
    const ticketInfo = db.prepare(`
      INSERT INTO evaluation_tickets (
        ticket_code, supplier_id, supplier_code, supplier_name, evaluation_type,
        template_id, question_template_version_id, facility_type, supplier_scale,
        planned_date, actual_evaluation_date, current_status, current_round_no,
        completed_round, score_percent, grade_code, result_label, created_by
      ) VALUES (
        'RUN17-EXPORT-001', ?, 'RUN17-NCC', 'RUN-17 Synthetic Supplier', 'Periodic',
        ?, ?, 'ALL', 'LARGE', '2026-07-14', '2026-07-14', 'Completed', 1,
        1, 100, 'A', 'Pass', ?
      )
    `).run(supplier.lastInsertRowid, questionVersion.template_id, questionVersion.id, actor);
    const round = db.prepare(`
      INSERT INTO evaluation_rounds (
        ticket_id, round_no, assessment_code, assessment_date,
        status, completed_at, total_score, final_result, classification
      ) VALUES (?, 1, 'RUN17-EXPORT-001-R1', '2026-07-14', 'Completed', '2026-07-14', 100, 'Pass', 'A')
    `).run(ticketInfo.lastInsertRowid);
    const ticket = db.prepare('SELECT * FROM evaluation_tickets WHERE id=?').get(ticketInfo.lastInsertRowid);
    const { exportCanonicalReport } = require('../server/reporting/canonicalReportExports');
    const exported = exportCanonicalReport(db, {
      ticket,
      definitionCode: 'ROUND1_RESULT',
      format: 'HTML',
      roundNo: 1,
      exportedBy: actor,
      at: '2026-07-14',
    });
    const row = db.prepare('SELECT * FROM report_exports WHERE id=?').get(exported.id);
    assert.equal(row.round_id, Number(round.lastInsertRowid));
    assert.equal(row.definition_code, 'ROUND1_RESULT');
    assert.equal(row.report_template_version_id, exported.report_template_version_id);
    assert.match(row.context_checksum, /^[a-f0-9]{64}$/);
    assert.match(row.component_checksum, /^[a-f0-9]{64}$/);
    assert.equal(row.scoring_compatibility_marker, null);
    assert.ok(row.scoring_policy_version_id);
    assert.match(row.scoring_policy_checksum, /^[a-f0-9]{64}$/);
    assert.equal(exported.context_checksum, row.context_checksum);
    assert.match(exported.buffer.toString('utf8'), /RUN-17 Synthetic Supplier/);
    assert.match(exported.buffer.toString('utf8'), /KẾT QUẢ ĐÁNH GIÁ NHÀ CUNG CẤP LẦN 1/);

    const facadeExport = require('../server/services/reporting').exportReportHtml(db, {
      ticket,
      reportType: 'ROUND1_RESULT',
      roundNo: 1,
      exportedBy: actor,
    });
    const facadeRow = db.prepare('SELECT * FROM report_exports WHERE id=?').get(facadeExport.id);
    assert.equal(facadeRow.report_template_id, null);
    assert.equal(facadeRow.report_template_version_id, exported.report_template_version_id);
    assert.equal(facadeRow.context_checksum, facadeExport.context_checksum);
  } finally {
    db.close();
    delete require.cache[require.resolve('../server/db')];
    if (oldDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = oldDbPath;
    fs.rmSync(dbPath, { force: true });
  }
});

test('RUN-17 version API denies unauthenticated/unprivileged mutations and enforces Published immutability', async () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-run17-api-${Date.now()}-${Math.random()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const db = freshDb(dbPath);
  let server;
  try {
    for (const [email, isAdmin, role] of [
      ['run17-admin@synthetic.invalid', 1, 'Admin'],
      ['run17-viewer@synthetic.invalid', 0, 'NCC'],
    ]) {
      upsertCanonicalUser(db, { email, role, isAdmin: Boolean(isAdmin) });
    }
    for (const modulePath of ['../server/middleware/auth', '../server/routes/reportTemplates']) {
      delete require.cache[require.resolve(modulePath)];
    }
    const auth = require('../server/middleware/auth');
    const signToken = canonicalTokenFactory(require('../server/db'), auth);
    const router = require('../server/routes/reportTemplates');
    const adminToken = signToken({ email: 'run17-admin@synthetic.invalid' }, 3600);
    const viewerToken = signToken({ email: 'run17-viewer@synthetic.invalid' }, 3600);
    const app = await startApp(router);
    server = app.server;

    assert.equal((await fetch(`${app.baseUrl}/report-templates/definitions`)).status, 401);
    const definitions = await fetch(`${app.baseUrl}/report-templates/definitions`, {
      headers: { Cookie: `qlcl_token=${adminToken}` },
    });
    assert.equal(definitions.status, 200);
    assert.equal((await definitions.json()).items.length, 3);

    const denied = await fetch(`${app.baseUrl}/report-templates/definitions/ROUND1_RESULT/versions`, {
      method: 'POST',
      headers: { Cookie: `qlcl_token=${viewerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version_name: 'Denied Draft' }),
    });
    assert.equal(denied.status, 403);

    const created = await fetch(`${app.baseUrl}/report-templates/definitions/ROUND1_RESULT/versions`, {
      method: 'POST',
      headers: { Cookie: `qlcl_token=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version_name: 'RUN-17 API Draft' }),
    });
    assert.equal(created.status, 201);
    const draft = (await created.json()).item;
    assert.equal(draft.status, 'DRAFT');

    const published = db.prepare(`
      SELECT * FROM report_template_versions
      WHERE definition_code='ROUND1_RESULT' AND status='PUBLISHED'
      ORDER BY version_no LIMIT 1
    `).get();
    const immutable = await fetch(`${app.baseUrl}/report-templates/versions/${published.id}`, {
      method: 'PUT',
      headers: { Cookie: `qlcl_token=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ lock_version: published.lock_version, definition: JSON.parse(published.definition_json) }),
    });
    assert.equal(immutable.status, 409);
    assert.equal((await immutable.json()).error, 'report_template_version_not_draft');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
    for (const modulePath of ['../server/db', '../server/middleware/auth', '../server/routes/reportTemplates']) {
      delete require.cache[require.resolve(modulePath)];
    }
    if (oldDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = oldDbPath;
    fs.rmSync(dbPath, { force: true });
  }
});
