'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const { upsertCanonicalUser } = require('./helpers/canonicalUser');

function freshDb(dbPath) {
  process.env.DB_PATH = dbPath;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'run21-synthetic-secret';
  delete require.cache[require.resolve('../server/db')];
  return require('../server/db').db;
}

function restoreDb(oldDbPath) {
  delete require.cache[require.resolve('../server/db')];
  delete require.cache[require.resolve('../server/config/paths')];
  if (oldDbPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = oldDbPath;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function externalReferences(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellFormula: true });
  const refs = [];
  for (const sheetName of workbook.SheetNames) {
    for (const [address, cell] of Object.entries(workbook.Sheets[sheetName])) {
      if (!address.startsWith('!') && cell?.f && /\[[0-9]+\][^!]+!/.test(String(cell.f))) {
        refs.push(`${sheetName}!${address}`);
      }
    }
  }
  return { workbook, refs };
}

function createTicket(db, suffix = 'PRIMARY', { withRound = true } = {}) {
  const actor = `run21-${suffix.toLowerCase()}@synthetic.invalid`;
  const actorIdentity = upsertCanonicalUser(db, {
    email: actor, roleCode: 'SYS_ADMIN', displayName: 'RUN-21 Synthetic QA', createdBy: 'RUN-21',
  });
  const supplier = db.prepare(`
    INSERT INTO supplier_master (supplier_code, supplier_name, status, source_type)
    VALUES (?, 'RUN-21 Synthetic Supplier', 'ACTIVE', 'MANUAL')
  `).run(`RUN21-NCC-${suffix}`);
  const questionVersion = db.prepare(`
    SELECT v.id, v.template_id
    FROM question_template_versions v
    JOIN question_templates t ON t.id=v.template_id
    WHERE t.template_code='BM01' AND v.status='PUBLISHED'
    ORDER BY v.version_no DESC LIMIT 1
  `).get();
  const ticketInfo = db.prepare(`
    INSERT INTO evaluation_tickets (
      ticket_code, supplier_id, supplier_code, supplier_name, evaluation_type,
      template_id, question_template_version_id, facility_type, supplier_scale,
      snapshot_product_name, business_type, snapshot_evaluation_address, actual_evaluation_date,
      current_status, current_round_no, completed_round, score_percent,
      grade_code, result_label, created_by
    ) VALUES (?, ?, ?, 'RUN-21 Synthetic Supplier', 'Periodic', ?, ?, 'ALL',
      'LARGE', 'Synthetic product', 'Manufacturer', 'Synthetic facility',
      '2026-07-15', 'Completed', 1, ?, 100, 'A', 'Pass', ?)
  `).run(
    `RUN21-${suffix}`,
    supplier.lastInsertRowid,
    `RUN21-NCC-${suffix}`,
    questionVersion.template_id,
    questionVersion.id,
    1,
    actorIdentity.user_id
  );
  let roundId = null;
  if (withRound) {
    roundId = Number(db.prepare(`
      INSERT INTO evaluation_rounds (
        ticket_id, round_no, assessment_code, assessment_date,
        status, completed_at, locked_at, total_score, final_result, classification,
        scoring_result_checksum
      ) VALUES (?, 1, ?, '2026-07-15', 'Completed', '2026-07-15',
        '2026-07-15', 100, 'Pass', 'A', NULL)
    `).run(
      ticketInfo.lastInsertRowid,
      `RUN21-${suffix}-R1`,
    ).lastInsertRowid);
    db.prepare(`INSERT INTO evaluation_participants
      (round_id, user_id, display_name, participant_role, opening_meeting,
       closing_meeting, assigned_by)
      VALUES (?, ?, 'RUN-21 Synthetic QA', 'ATTENDEE', 1, 1, ?)`)
      .run(roundId, actorIdentity.user_id, actorIdentity.user_id);
    db.prepare(`INSERT INTO evaluation_participants
      (round_id, user_id, display_name, participant_role, assigned_by)
      VALUES (?, ?, 'RUN-21 Synthetic QA', 'EVALUATOR', ?)`)
      .run(roundId, actorIdentity.user_id, actorIdentity.user_id);
  }
  return {
    actor,
    roundId,
    ticket: db.prepare('SELECT * FROM evaluation_tickets WHERE id=?').get(ticketInfo.lastInsertRowid),
  };
}

function syntheticContext(definitionCode, roundNo, { ready = true, roundId = 21001 } = {}) {
  return {
    context_schema_version: 1,
    definition_code: definitionCode,
    ticket: { id: 21001, code: 'RUN21-MATRIX', question_template_version_id: 81 },
    round: {
      id: roundId,
      round_no: roundNo,
      status: ready ? 'COMPLETED' : 'DRAFT',
      locked_at: ready ? '2026-07-15T08:00:00.000Z' : null,
      completed_at: ready ? '2026-07-15T08:00:00.000Z' : null,
    },
    scoring: { compatibility_marker: 'LEGACY_SCORING_V1_UNVERSIONED', scoring_policy_version_id: null },
    compliance_overview: null,
    doc4: {
      related_information: {
        report_no: `RUN21-MATRIX-R${roundNo}`, evaluation_date: '2026-07-15',
        evaluators: 'RUN-21 Synthetic QA', supplier_name: 'RUN-21 Synthetic Supplier',
        supplier_code: 'RUN21-NCC', evaluation_address: 'Synthetic facility',
      },
      scope: {
        product: 'Synthetic product', business_type: 'Manufacturer',
        evaluation_type: 'Periodic', question_template_version_id: 81,
      },
      participants: { rows: [{ name: 'RUN-21 Synthetic QA', opening: true, closing: true }] },
      supplier_introduction: { content: 'RUN-21 synthetic content' },
      compliance_summary: [{ category: 'LEGAL', counts: { A: 1, B: 0, C: 0, D: 0, NA: 0 }, percentage: 100 }],
      nonconformity_summary: [],
      result_summary: {
        final_score_percent: 'RUN21-SECRET-SCORE',
        final_result_label: 'Pass',
        final_conclusion: `Round ${roundNo} conclusion`,
      },
      signatures: { evaluator: 'RUN-21 Synthetic QA', supplier_representative: 'Synthetic NCC', approved_by: 'Synthetic Approver' },
    },
    corrective_action_rows: [],
    approval_history_rows: [],
  };
}

test('RUN-21 owns every alias in one versioned adapter and keeps INTERNAL/NCC unmapped without approval', () => {
  const {
    LEGACY_ALIAS_APPROVAL,
    LEGACY_ALIAS_VERSION,
    resolveReportAlias,
  } = require('../server/reporting/reportAliasCatalog');
  assert.equal(resolveReportAlias('WORKING_MINUTES').canonical_code, 'WORKING_MINUTES');
  assert.equal(resolveReportAlias('BAO_CAO_GUI_NCC').canonical_code, 'ROUND1_RESULT');
  assert.equal(resolveReportAlias('Báo cáo gửi NCC').canonical_code, 'ROUND1_RESULT');
  assert.equal(resolveReportAlias('BAO_CAO_NOI_BO').canonical_code, 'ROUND2_RESULT');
  const nccPending = resolveReportAlias('NCC', { env: {} });
  assert.equal(nccPending.canonical_code, null);
  assert.equal(nccPending.legacy_source, 'NCC');
  assert.equal(nccPending.mapping_version, LEGACY_ALIAS_VERSION);
  assert.equal(nccPending.deprecation.new_creation_allowed, false);
  const internalPending = resolveReportAlias('INTERNAL', { env: {}, roundNo: 1 });
  assert.equal(internalPending.canonical_code, null);
  assert.equal(internalPending.ambiguous, true);
  const approvedEnv = { REPORT_LEGACY_ALIAS_APPROVAL: LEGACY_ALIAS_APPROVAL };
  assert.equal(resolveReportAlias('NCC', { env: approvedEnv }).canonical_code, 'WORKING_MINUTES');
  assert.equal(resolveReportAlias('INTERNAL', { env: approvedEnv, roundNo: 1 }).canonical_code, 'ROUND1_RESULT');
  assert.equal(resolveReportAlias('INTERNAL', { env: approvedEnv, roundNo: 2 }).canonical_code, 'ROUND2_RESULT');
  assert.equal(resolveReportAlias('INTERNAL', { env: approvedEnv }).canonical_code, null);

  const reportingSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'reporting.js'), 'utf8');
  for (const alias of ['BAO_CAO_GUI_NCC', 'BAO_CAO_NOI_BO', 'NCC_WORKING_MINUTES']) {
    assert.doesNotMatch(reportingSource, new RegExp(alias), `${alias} escaped the central adapter`);
  }
});

test('RUN-21 migration dry-run is idempotent and sends ambiguity to review without rewriting history', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-run21-alias-'));
  const dbPath = path.join(root, 'run21.db');
  const oldDbPath = process.env.DB_PATH;
  const db = freshDb(dbPath);
  try {
    const { LEGACY_ALIAS_APPROVAL } = require('../server/reporting/reportAliasCatalog');
    const { LegacyReportTemplateMigration } = require('../server/reporting/LegacyReportTemplateMigration');
    const pending = new LegacyReportTemplateMigration({ db, env: {} });
    const first = pending.dryRun();
    const second = pending.dryRun();
    assert.deepEqual(second, first);
    assert.deepEqual(first.counts, { mapped: 0, skipped: 1, conflict: 0, missing: 0, ambiguous: 1 });
    assert.equal(first.review_queue_count, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM report_legacy_template_links').get().n, 0);
    assert.throws(() => pending.applyApproved(), (error) => error.code === 'report_legacy_mapping_pending');

    const approved = new LegacyReportTemplateMigration({
      db,
      env: { REPORT_LEGACY_ALIAS_APPROVAL: LEGACY_ALIAS_APPROVAL },
    });
    assert.deepEqual(approved.dryRun().counts, { mapped: 1, skipped: 0, conflict: 0, missing: 0, ambiguous: 1 });
    const applied = approved.applyApproved();
    assert.equal(applied.inserted, 1);
    assert.equal(approved.applyApproved().inserted, 0);
    const link = db.prepare('SELECT * FROM report_legacy_template_links').get();
    assert.equal(link.legacy_source, 'NCC');
    assert.equal(link.canonical_definition_code, 'WORKING_MINUTES');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM report_legacy_migration_review WHERE status='PENDING'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM report_templates WHERE report_type IN ('INTERNAL','NCC')").get().n, 2);
  } finally {
    db.close();
    restoreDb(oldDbPath);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RUN-21 exact NCC and WORKING_MINUTES XLSX cases contain values and no external workbook formulas', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-run21-xlsx-'));
  const dbPath = path.join(root, 'run21.db');
  const oldDbPath = process.env.DB_PATH;
  const db = freshDb(dbPath);
  try {
    const { actor, ticket } = createTicket(db);
    const { buildReportContext, exportReportXlsx } = require('../server/services/reporting');
    assert.throws(
      () => buildReportContext(db, ticket, { reportType: 'INTERNAL', roundNo: 2 }),
      (error) => error.code === 'round_not_found',
      'An explicit legacy round must never fall back to another round'
    );
    const outputs = ['NCC', 'WORKING_MINUTES'].map((reportType) => exportReportXlsx(db, {
      ticket,
      reportType,
      roundNo: 1,
      exportedBy: actor,
      legacyCompatibility: true,
    }));
    const outputHashes = Object.fromEntries(outputs.map((output) => [output.report_type, sha256(output.buffer)]));
    assert.equal(new Set(Object.values(outputHashes)).size, 1, 'Both exact cases must share the corrected renderer bytes');
    if (process.env.RUN21_RECONCILIATION_OUTPUT === '1') {
      process.stdout.write(`RUN21_RECONCILIATION ${JSON.stringify({ artifact_sha256: outputHashes })}\n`);
    }
    for (const output of outputs) {
      const { workbook, refs } = externalReferences(output.buffer);
      assert.deepEqual(refs, [], output.report_type);
      const sheet = workbook.SheetNames
        .map((name) => workbook.Sheets[name])
        .find((candidate) => candidate?.P4?.v === '15/07/2026' && candidate?.C8?.v === 'RUN-21 Synthetic QA');
      assert.ok(sheet);
      assert.equal(sheet.P4.v, '15/07/2026');
      assert.equal(sheet.C8.v, 'RUN-21 Synthetic QA');
      assert.match(sha256(output.buffer), /^[a-f0-9]{64}$/);
    }
    const nccRow = db.prepare('SELECT * FROM report_exports WHERE id=?').get(outputs[0].id);
    assert.equal(nccRow.legacy_source, 'NCC');
    assert.equal(nccRow.definition_code, null);
    assert.equal(outputs[0].canonical_code, null);
    assert.equal(outputs[1].canonical_code, 'WORKING_MINUTES');
  } finally {
    db.close();
    restoreDb(oldDbPath);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RUN-21 canonical format matrix pins rounds, preserves semantic parity, and blocks score leakage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-run21-matrix-'));
  const dbPath = path.join(root, 'run21.db');
  const oldDbPath = process.env.DB_PATH;
  const db = freshDb(dbPath);
  try {
    const ReportTemplateVersionRepository = require('../server/reporting/ReportTemplateVersionRepository');
    const { ReportOrchestrator } = require('../server/reporting/ReportOrchestrator');
    const repository = new ReportTemplateVersionRepository(db);
    for (const [definitionCode, roundNo] of [
      ['WORKING_MINUTES', 1], ['ROUND1_RESULT', 1], ['ROUND2_RESULT', 2],
    ]) {
      const orchestrator = new ReportOrchestrator({
        db,
        repository,
        contextBuilder: ({ definition }) => syntheticContext(definition.code, roundNo),
      });
      const rendered = ['HTML', 'PDF', 'XLSX'].map((format) => orchestrator.renderProduction({
        definitionCode, ticket: { id: 21001 }, roundNo, format, at: '2026-07-15',
      }));
      assert.equal(new Set(rendered.map((item) => item.semantic_checksum)).size, 1);
      assert.equal(new Set(rendered.map((item) => item.context_checksum)).size, 1);
      assert.equal(rendered[0].context.round.round_no, roundNo);
      assert.equal(rendered[0].semantic.sections[0].data.title, rendered[1].semantic.sections[0].data.title);
      if (definitionCode === 'WORKING_MINUTES') {
        assert.doesNotMatch(JSON.stringify(rendered[0].semantic), /RUN21-SECRET-SCORE|compliance_overview|result_summary/);
      }
    }
    const orchestrator = new ReportOrchestrator({
      db,
      repository,
      contextBuilder: ({ definition, roundNo }) => syntheticContext(definition.code, roundNo),
    });
    for (const format of ['HTML', 'PDF', 'XLSX']) {
      assert.throws(() => orchestrator.renderProduction({
        definitionCode: 'ROUND1_RESULT', ticket: { id: 21001 }, roundNo: 2, format, at: '2026-07-15',
      }), (error) => error.code === 'report_round_not_allowed');
      assert.throws(() => orchestrator.renderProduction({
        definitionCode: 'ROUND2_RESULT', ticket: { id: 21001 }, roundNo: 1, format, at: '2026-07-15',
      }), (error) => error.code === 'report_round_not_allowed');
    }
    const notReady = new ReportOrchestrator({
      db,
      repository,
      contextBuilder: ({ definition, roundNo }) => syntheticContext(definition.code, roundNo, { ready: false }),
    });
    for (const format of ['HTML', 'PDF', 'XLSX']) {
      assert.throws(() => notReady.renderProduction({
        definitionCode: 'ROUND2_RESULT', ticket: { id: 21001 }, roundNo: 2, format, at: '2026-07-15',
      }), (error) => error.code === 'report_round_not_ready');
    }
    for (const [definitionCode, roundNo] of [
      ['WORKING_MINUTES', 1], ['ROUND1_RESULT', 1], ['ROUND2_RESULT', 2],
    ]) {
      const missing = new ReportOrchestrator({
        db,
        repository,
        contextBuilder: ({ definition }) => syntheticContext(definition.code, roundNo, { roundId: null }),
      });
      for (const format of ['HTML', 'PDF', 'XLSX']) {
        assert.throws(() => missing.renderProduction({
          definitionCode, ticket: { id: 21001 }, roundNo, format, at: '2026-07-15',
        }), (error) => error.code === 'report_context_invalid' || error.code === 'round_not_found');
      }
    }

    const working = repository.resolvePublished({ definitionCode: 'WORKING_MINUTES', at: '2026-07-15' });
    const draft = repository.createDraft({ definitionCode: 'WORKING_MINUTES', sourceVersionId: working.id, name: 'RUN-21 score leak guard' });
    const tree = JSON.parse(draft.definition_json);
    tree.components.push({
      id: 'forbidden-result', type: 'metadata_grid', title: 'Forbidden',
      fields: [{ label: 'Score', binding: 'doc4.result_summary.final_score_percent' }],
    });
    assert.throws(() => repository.updateDraft({
      versionId: draft.id, expectedLockVersion: draft.lock_version, definition: tree,
    }), (error) => error.code === 'report_score_exposure_forbidden');
  } finally {
    db.close();
    restoreDb(oldDbPath);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RUN-21 durable corrected artifact survives restart and missing round creates no false COMPLETED job', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-run21-artifact-'));
  const dbPath = path.join(root, 'run21.db');
  const oldDbPath = process.env.DB_PATH;
  const db = freshDb(dbPath);
  try {
    const { actor, ticket } = createTicket(db, 'DURABLE');
    const { ticket: missingRoundTicket } = createTicket(db, 'NO-ROUND', { withRound: false });
    const { LocalArtifactStorage } = require('../server/reporting/artifacts/LocalArtifactStorage');
    const { ReportExportJobService } = require('../server/reporting/artifacts/ReportExportJobService');
    const { LEGACY_ALIAS_VERSION } = require('../server/reporting/reportAliasCatalog');
    const storage = new LocalArtifactStorage({ root: path.join(root, 'artifacts') });
    const request = {
      ticket, definitionCode: 'WORKING_MINUTES', format: 'XLSX', roundNo: 1,
      requestedBy: actor, idempotencyKey: 'run21-working-minutes-0001',
      legacySource: 'BIEN_BAN_LAM_VIEC', legacyAliasVersion: LEGACY_ALIAS_VERSION,
      at: '2026-07-15',
    };
    const first = new ReportExportJobService({ db, storage, executionMode: 'inline' }).requestExport(request);
    const afterRestart = new ReportExportJobService({ db, storage, executionMode: 'inline' }).requestExport(request);
    assert.equal(afterRestart.artifact_id, first.artifact_id);
    assert.deepEqual(afterRestart.buffer, first.buffer);
    assert.equal(afterRestart.sha256, sha256(first.buffer));
    assert.equal(afterRestart.legacy_source, 'BIEN_BAN_LAM_VIEC');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM report_export_jobs WHERE status='COMPLETED'").get().n, 1);

    assert.throws(() => new ReportExportJobService({ db, storage, executionMode: 'inline' }).requestExport({
      ...request,
      ticket: missingRoundTicket,
      requestedBy: missingRoundTicket.created_by,
      idempotencyKey: 'run21-missing-round-0001',
      legacySource: null,
      legacyAliasVersion: null,
    }), (error) => error.code === 'round_not_found');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM report_export_jobs WHERE status='COMPLETED'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM report_export_jobs WHERE ticket_id=?").get(missingRoundTicket.id).n, 0);

    const { businessErrorPayload } = require('../server/reporting/reportBusinessErrors');
    assert.deepEqual(businessErrorPayload('round_not_found').allowed_next_actions, ['complete_required_round']);
    assert.deepEqual(businessErrorPayload('artifact_missing').allowed_next_actions, ['run_legacy_artifact_reconciliation']);
  } finally {
    db.close();
    restoreDb(oldDbPath);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
