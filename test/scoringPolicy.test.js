'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const express = require('express');
const cookieParser = require('cookie-parser');
const { canonicalTokenFactory } = require('./helpers/canonicalAuth');
const { migrateDatabase } = require('../server/database/migrationRunner');

const legacy = require('../server/domain/evaluationRules');
const {
  GOLDEN_V1_DEFINITION,
  buildComplianceOverview,
  calculateWithPolicy,
  classifyWithPolicy,
  definitionChecksum,
  formulaChecksum,
  validateScoringPolicyDefinition,
} = require('../server/scoring/scoringPolicyEngine');

const questions = [
  { id: 'legal-1', section: 'Hồ sơ pháp lý', categoryCode: 'LEGAL_RECORDS', clause: 'normal', critical: false },
  { id: 'legal-2', section: 'Hồ sơ pháp lý', categoryCode: 'LEGAL_RECORDS', clause: 'exclusion', critical: false },
  { id: 'quality-1', section: 'Kiểm soát chất lượng', categoryCode: 'QUALITY_CONTROL', clause: 'normal', critical: true },
  { id: 'trace-1', section: 'Truy xuất nguồn gốc', categoryCode: 'TRACEABILITY', clause: 'normal', critical: true },
];

function answers(overrides = {}) {
  return {
    'legal-1': { score: 'A' },
    'legal-2': { score: 'A' },
    'quality-1': { score: 'A' },
    'trace-1': { score: 'A' },
    ...overrides,
  };
}

test('golden scoring policy v1 preserves every legacy boundary exactly', () => {
  const boundaries = [59.999, 60, 75, 75.000001, 90, 90.000001];
  assert.deepEqual(
    boundaries.map((score) => classifyWithPolicy(GOLDEN_V1_DEFINITION, score, false)),
    boundaries.map((score) => legacy.classifyScore(score, false)),
  );
  assert.equal(formulaChecksum(GOLDEN_V1_DEFINITION).length, 64);
});

test('golden scoring policy v1 recalculates synthetic fixtures without conclusion changes', () => {
  const fixtures = [
    answers(),
    answers({ 'quality-1': { score: 'B' } }),
    answers({ 'trace-1': { score: 'C' } }),
    answers({ 'legal-2': { score: 'D' } }),
    answers({ 'quality-1': { score: 'NA' } }),
  ];
  fixtures.forEach((fixture) => {
    const before = legacy.calculateScoring(questions, fixture);
    const after = calculateWithPolicy(GOLDEN_V1_DEFINITION, questions, fixture);
    assert.equal(after.average, before.average);
    assert.equal(after.finalScore, before.finalScore);
    assert.equal(after.grade, before.grade);
    assert.equal(after.label, before.label);
    assert.equal(after.passed, before.passed);
    assert.equal(after.reason, before.reason);
  });
});

test('overview configuration changes layout without changing formula checksum or score', () => {
  const changed = structuredClone(GOLDEN_V1_DEFINITION);
  changed.compliance_overview.title = 'Synthetic overview title';
  changed.compliance_overview.totals_label = 'Synthetic total';
  changed.compliance_overview.grade_columns = ['D', 'C', 'B', 'A', 'NA'];
  assert.equal(formulaChecksum(changed), formulaChecksum(GOLDEN_V1_DEFINITION));
  assert.equal(
    calculateWithPolicy(changed, questions, answers()).finalScore,
    calculateWithPolicy(GOLDEN_V1_DEFINITION, questions, answers()).finalScore,
  );
  const overview = buildComplianceOverview(changed, { categoryRows: [] });
  assert.equal(overview.columns.find((column) => column.key === 'total').label, 'Synthetic total');
});

test('policy validation rejects score-band gaps and overlaps', () => {
  const overlap = structuredClone(GOLDEN_V1_DEFINITION);
  overlap.bands[1].min = 59;
  assert.throws(() => validateScoringPolicyDefinition(overlap), /scoring_policy_band_overlap/);

  const gap = structuredClone(GOLDEN_V1_DEFINITION);
  gap.bands[1].min = 61;
  assert.throws(() => validateScoringPolicyDefinition(gap), /scoring_policy_band_gap/);
});

test('dynamic compliance overview uses one policy view model and warns on chart fallback', () => {
  const policy = structuredClone(GOLDEN_V1_DEFINITION);
  policy.categories = Array.from({ length: 9 }, (_, index) => ({
    code: `CATEGORY_${index + 1}`,
    label: `Category ${index + 1}`,
    order: index + 1,
  }));
  const rows = policy.categories.map((category, index) => ({
    category_code: category.code,
    category_label: category.label,
    counts: { A: index + 1, B: 0, C: 0, D: 0, NA: 0 },
    percentage: 100,
  }));
  const view = buildComplianceOverview(policy, { categoryRows: rows, result: { grade: 'A', label: 'Pass', passed: true } });
  assert.equal(view.rows.length, 9);
  assert.equal(view.chart.type, 'bar_table');
  assert.deepEqual(view.warnings, ['compliance_chart_axis_limit_exceeded']);
  assert.deepEqual(view.columns.map((column) => column.key), ['category_label', 'counts.A', 'counts.B', 'counts.C', 'counts.D', 'counts.NA', 'total', 'percentage']);
});

test('compliance overview preserves every unmapped category row for reconciliation', () => {
  const view = buildComplianceOverview(GOLDEN_V1_DEFINITION, {
    categoryRows: [
      { category_code: null, category_label: 'Synthetic unmapped 1', counts: { A: 1 } },
      { category_code: null, category_label: 'Synthetic unmapped 2', counts: { B: 1 } },
    ],
  });
  assert.deepEqual(
    view.rows.filter((row) => row.reconciliation_status === 'UNMAPPED').map((row) => row.category_label),
    ['Synthetic unmapped 1', 'Synthetic unmapped 2'],
  );
  assert.deepEqual(view.warnings, ['compliance_category_unmapped']);
});

test('report component registry makes HTML/PDF source and XLSX consume the same policy overview model', () => {
  const { buildSemanticModel } = require('../server/reporting/componentRegistry');
  const { renderHtml } = require('../server/reporting/htmlRenderer');
  const { semanticRows } = require('../server/reporting/xlsxAdapter');
  const view = buildComplianceOverview(GOLDEN_V1_DEFINITION, {
    categoryRows: [{
      category_code: 'LEGAL_RECORDS',
      category_label: 'Hồ sơ pháp lý',
      counts: { A: 2, B: 1, C: 0, D: 0, NA: 1 },
      percentage: 91.67,
    }],
    result: { grade: 'B', label: 'Đạt mức khá', passed: true },
  });
  const semantic = buildSemanticModel({
    schema_version: 1,
    components: [{
      id: 'compliance',
      type: 'compliance_overview',
      title: 'Renderer-owned title must not win',
      binding: 'doc4.compliance_summary',
      columns: [{ label: 'Renderer-owned label must not win', key: 'category' }],
    }],
  }, {
    definition_code: 'ROUND1_RESULT',
    doc4: { compliance_summary: [] },
    compliance_overview: view,
  });
  const section = semantic.sections[0];
  assert.equal(section.title, GOLDEN_V1_DEFINITION.compliance_overview.title);
  assert.deepEqual(section.columns, view.columns);
  assert.match(renderHtml({ semantic }), /Hồ sơ pháp lý/);
  assert.ok(semanticRows(semantic).some((row) => (
    JSON.stringify(row) === JSON.stringify(view.columns.map((column) => column.label))
  )));
});

test('version lifecycle enforces four-eyes, Decision ID, pinning, rollback, and immutable history', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrateDatabase(db, { migrationsDir: path.resolve(__dirname, '..', 'migrations'), appVersion: 'RUN-19-TEST' });
  const ScoringPolicyRepository = require('../server/scoring/ScoringPolicyRepository');
  const disabled = new ScoringPolicyRepository(db, { env: {} });
  const enabled = new ScoringPolicyRepository(db, { env: { SCORING_POLICY_PUBLISH_ACK: 'SCORE-001:APPROVED' } });
  try {
    const v1 = disabled.listVersions('LEGACY_RULES')[0];
    assert.equal(v1.status, 'PUBLISHED');
    assert.equal(v1.checksum, definitionChecksum(GOLDEN_V1_DEFINITION));
    assert.equal(v1.formula_checksum, formulaChecksum(GOLDEN_V1_DEFINITION));
    const draft = disabled.createDraft({ policyCode: 'LEGACY_RULES', sourceVersionId: v1.id, actor: 'maker@synthetic.invalid' });
    const candidate = structuredClone(disabled.definition(draft));
    candidate.compliance_overview.title = 'RUN-19 synthetic overview';
    const updated = disabled.updateDraft({
      versionId: draft.id,
      expectedLockVersion: draft.lock_version,
      definition: candidate,
      actor: 'maker@synthetic.invalid',
    });
    assert.equal(updated.formula_checksum, v1.formula_checksum);
    const impact = disabled.simulate({
      versionId: updated.id,
      fixtures: [59.999, 60, 75, 75.000001, 90, 90.000001].map((score) => ({ score })),
    });
    assert.equal(impact.changed_fixture_count, 0);
    assert.equal(impact.changed_band_count, 0);
    assert.deepEqual(impact.items.map((item) => item.band_after), [
      'FAIL', 'BASIC_PASS', 'BASIC_PASS', 'GOOD_PASS', 'GOOD_PASS', 'HIGH_PASS',
    ]);
    const submitted = disabled.submit({
      versionId: updated.id,
      expectedLockVersion: updated.lock_version,
      actor: 'maker@synthetic.invalid',
    });
    assert.throws(() => disabled.publish({
      versionId: submitted.id,
      expectedLockVersion: submitted.lock_version,
      decisionId: 'SCORE-001',
      actor: 'checker@synthetic.invalid',
    }), /scoring_policy_publish_disabled/);
    assert.throws(() => enabled.publish({
      versionId: submitted.id,
      expectedLockVersion: submitted.lock_version,
      decisionId: 'SCORE-001',
      actor: 'maker@synthetic.invalid',
    }), /scoring_policy_four_eyes_required/);
    const published = enabled.publish({
      versionId: submitted.id,
      expectedLockVersion: submitted.lock_version,
      decisionId: 'SCORE-001',
      actor: 'checker@synthetic.invalid',
    });
    assert.equal(published.status, 'PUBLISHED');
    candidate.compliance_overview.title = 'Forbidden published mutation';
    assert.throws(() => db.prepare('UPDATE scoring_policy_versions SET definition_json=? WHERE id=?')
      .run(stableClone(candidate), published.id), /published_scoring_policy_immutable/);

    const supplierId = db.prepare("INSERT INTO supplier_master (supplier_code,supplier_name,status,source_type) VALUES ('RUN19-NCC','Synthetic NCC','ACTIVE','MANUAL')").run().lastInsertRowid;
    const templateId = db.prepare("INSERT INTO question_templates (template_code,template_name) VALUES ('RUN19','Synthetic questions')").run().lastInsertRowid;
    const ticket = db.prepare(`
      INSERT INTO evaluation_tickets (
        ticket_code, supplier_id, evaluation_type, template_id, facility_type,
        supplier_scale, current_status, created_by
      ) VALUES ('RUN19-TICKET-1', ?, 'Periodic', ?, 'ALL', 'LARGE', 'Draft', NULL)
    `).run(supplierId, templateId);
    assert.equal(
      db.prepare('SELECT scoring_policy_version_id FROM evaluation_tickets WHERE id=?').get(ticket.lastInsertRowid).scoring_policy_version_id,
      published.id,
      'every ticket insertion seam must pin the effective Published policy'
    );
    assert.equal(enabled.pinTicket(ticket.lastInsertRowid).id, published.id);

    const retiredV1 = enabled.requireVersion(v1.id);
    assert.equal(retiredV1.status, 'RETIRED');
    const rolledBack = enabled.rollback({
      versionId: retiredV1.id,
      expectedLockVersion: retiredV1.lock_version,
      decisionId: 'SCORE-001-ROLLBACK',
      actor: 'checker@synthetic.invalid',
    });
    assert.equal(rolledBack.id, v1.id);
    assert.equal(db.prepare('SELECT scoring_policy_version_id FROM evaluation_tickets WHERE id=?').get(ticket.lastInsertRowid).scoring_policy_version_id, published.id);
  } finally {
    db.close();
  }
});

function stableClone(value) {
  return JSON.stringify(value);
}

test('scoring policy API denies anonymous/unprivileged access and exposes Draft lifecycle only to its permissions', async () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-run19-api-${process.pid}-${Date.now()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const oldSecret = process.env.JWT_SECRET;
  const oldAck = process.env.SCORING_POLICY_PUBLISH_ACK;
  process.env.DB_PATH = dbPath;
  process.env.JWT_SECRET = 'run19-synthetic-secret';
  delete process.env.SCORING_POLICY_PUBLISH_ACK;
  for (const modulePath of ['../server/db', '../server/middleware/auth', '../server/routes/scoringPolicies']) {
    delete require.cache[require.resolve(modulePath)];
  }
  const db = require('../server/db').db;
  let server;
  try {
    for (const [email, isAdmin, role] of [
      ['run19-admin@synthetic.invalid', 1, 'Admin'],
      ['prompt11-manager@synthetic.invalid', 0, 'NCC'],
      ['prompt11-publisher@synthetic.invalid', 0, 'NCC'],
      ['run19-viewer@synthetic.invalid', 0, 'NCC'],
    ]) {
      db.prepare(`
        INSERT INTO users (email, is_admin, role, is_active, created_by)
        VALUES (?, ?, ?, 1, 'RUN-19')
      `).run(email, isAdmin, role);
    }
    for (const [roleCode, permissionCodes] of [
      ['PROMPT11_MANAGER', ['SCORING_POLICY.MANAGE']],
      ['PROMPT11_PUBLISHER', ['SCORING_POLICY.MANAGE', 'SCORING_POLICY.PUBLISH']],
    ]) {
      const roleId = db.prepare(`INSERT INTO roles (role_code, display_label, role_kind)
        VALUES (?, ?, 'FUNCTIONAL')`).run(roleCode, `Synthetic ${roleCode}`).lastInsertRowid;
      for (const permissionCode of permissionCodes) {
        db.prepare(`INSERT INTO role_permissions (role_id, permission_code, effect)
          VALUES (?, ?, 'ALLOW')`).run(roleId, permissionCode);
      }
      const email = roleCode === 'PROMPT11_MANAGER'
        ? 'prompt11-manager@synthetic.invalid'
        : 'prompt11-publisher@synthetic.invalid';
      db.prepare(`INSERT INTO user_roles (user_id, role_id, source) VALUES (?, ?, 'MANUAL')`).run(email, roleId);
    }
    const auth = require('../server/middleware/auth');
    const signToken = canonicalTokenFactory(require('../server/db'), auth);
    const router = require('../server/routes/scoringPolicies');
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/scoring-policies', router);
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}/scoring-policies`;
    const adminToken = signToken({ email: 'run19-admin@synthetic.invalid' }, 3600);
    const managerToken = signToken({ email: 'prompt11-manager@synthetic.invalid' }, 3600);
    const publisherToken = signToken({ email: 'prompt11-publisher@synthetic.invalid' }, 3600);
    const viewerToken = signToken({ email: 'run19-viewer@synthetic.invalid' }, 3600);
    assert.equal((await fetch(baseUrl)).status, 401);
    assert.equal((await fetch(baseUrl, { headers: { Cookie: `qlcl_token=${viewerToken}` } })).status, 403);
    const listed = await fetch(baseUrl, { headers: { Cookie: `qlcl_token=${adminToken}` } });
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).items[0].policy_code, 'LEGACY_RULES');
    const created = await fetch(`${baseUrl}/LEGACY_RULES/versions`, {
      method: 'POST',
      headers: { Cookie: `qlcl_token=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version_note: 'RUN-19 API synthetic Draft' }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.equal(createdBody.item.status, 'DRAFT');
    assert.ok(createdBody.item.allowed_actions.includes('scoring_policy.save_draft'));
    assert.ok(createdBody.item.allowed_actions.includes('scoring_policy.submit_review'));
    assert.equal(createdBody.item.disabled_reasons['scoring_policy.publish'], 'scoring_policy_publish_disabled');
    const published = db.prepare("SELECT * FROM scoring_policy_versions WHERE status='PUBLISHED' ORDER BY version_no LIMIT 1").get();
    const immutable = await fetch(`${baseUrl}/versions/${published.id}`, {
      method: 'PUT',
      headers: { Cookie: `qlcl_token=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ lock_version: published.lock_version, definition: JSON.parse(published.definition_json) }),
    });
    assert.equal(immutable.status, 409);
    assert.equal((await immutable.json()).error, 'scoring_policy_version_not_draft');

    const managerHeaders = { Cookie: `qlcl_token=${managerToken}`, 'Content-Type': 'application/json' };
    const publisherHeaders = { Cookie: `qlcl_token=${publisherToken}`, 'Content-Type': 'application/json' };
    const managerList = await fetch(baseUrl, { headers: managerHeaders });
    assert.equal(managerList.status, 200, 'manage-only account can open the workspace');
    const managerDraftResponse = await fetch(`${baseUrl}/LEGACY_RULES/versions`, {
      method: 'POST', headers: managerHeaders,
      body: JSON.stringify({ source_version_id: published.id, version_note: 'PROMPT-11 manage-only synthetic Draft' }),
    });
    assert.equal(managerDraftResponse.status, 201);
    const managerDraft = (await managerDraftResponse.json()).item;
    assert.ok(managerDraft.allowed_actions.includes('scoring_policy.simulate'));
    assert.ok(managerDraft.allowed_actions.includes('scoring_policy.impact'));
    assert.equal(managerDraft.disabled_reasons['scoring_policy.publish'], 'forbidden_permission');
    const invalidDefinition = structuredClone(managerDraft.definition);
    invalidDefinition.bands[1].min = 59;
    const invalidUpdate = await fetch(`${baseUrl}/versions/${managerDraft.id}`, {
      method: 'PUT', headers: managerHeaders,
      body: JSON.stringify({ lock_version: managerDraft.lock_version, definition: invalidDefinition }),
    });
    assert.equal(invalidUpdate.status, 400);
    assert.deepEqual(await invalidUpdate.json(), {
      error: 'scoring_policy_band_overlap', field_path: 'bands[1]',
    });
    const fixtures = [59.999, 60, 75, 75.000001, 90, 90.000001]
      .map((score, index) => ({ id: `prompt11-boundary-${index + 1}`, score }));
    for (const action of ['validate', 'simulate', 'impact']) {
      const response = await fetch(`${baseUrl}/versions/${managerDraft.id}/${action}`, {
        method: 'POST', headers: managerHeaders,
        body: JSON.stringify(action === 'validate' ? {} : { fixtures }),
      });
      assert.equal(response.status, 200, `${action} is available to manage-only account`);
    }
    const submittedResponse = await fetch(`${baseUrl}/versions/${managerDraft.id}/submit`, {
      method: 'POST', headers: managerHeaders,
      body: JSON.stringify({ lock_version: managerDraft.lock_version }),
    });
    assert.equal(submittedResponse.status, 200);
    const submitted = (await submittedResponse.json()).item;
    const managerPublish = await fetch(`${baseUrl}/versions/${submitted.id}/publish`, {
      method: 'POST', headers: managerHeaders,
      body: JSON.stringify({ lock_version: submitted.lock_version, decision_id: 'PROMPT11-MANAGER-DENIED' }),
    });
    assert.equal(managerPublish.status, 403, 'manage-only account cannot publish');

    process.env.SCORING_POLICY_PUBLISH_ACK = 'SCORE-001:APPROVED';
    const publisherDetailResponse = await fetch(`${baseUrl}/versions/${submitted.id}`, { headers: publisherHeaders });
    assert.equal(publisherDetailResponse.status, 200);
    const publisherDetail = (await publisherDetailResponse.json()).item;
    assert.ok(publisherDetail.allowed_actions.includes('scoring_policy.publish'));
    const publisherPublish = await fetch(`${baseUrl}/versions/${submitted.id}/publish`, {
      method: 'POST', headers: publisherHeaders,
      body: JSON.stringify({ lock_version: publisherDetail.lock_version, decision_id: 'PROMPT11-PUBLISH' }),
    });
    assert.equal(publisherPublish.status, 200, 'publish-capable checker can publish after four-eyes submit');
    assert.equal((await publisherPublish.json()).item.status, 'PUBLISHED');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
    for (const modulePath of ['../server/db', '../server/middleware/auth', '../server/routes/scoringPolicies']) {
      delete require.cache[require.resolve(modulePath)];
    }
    if (oldDbPath === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = oldDbPath;
    if (oldSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = oldSecret;
    if (oldAck === undefined) delete process.env.SCORING_POLICY_PUBLISH_ACK; else process.env.SCORING_POLICY_PUBLISH_ACK = oldAck;
    fs.rmSync(dbPath, { force: true });
  }
});
