const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { canonicalTokenFactory } = require('./helpers/canonicalAuth');
const { upsertCanonicalUser } = require('./helpers/canonicalUser');

const ROOT = path.resolve(__dirname, '..');

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function isoDate(offsetDays) {
  const value = new Date();
  value.setUTCHours(12, 0, 0, 0);
  value.setUTCDate(value.getUTCDate() + offsetDays);
  return value.toISOString().slice(0, 10);
}

function clearWorkspaceModules() {
  for (const relativePath of [
    '../server/db',
    '../server/middleware/auth',
    '../server/services/AuthorizationService',
    '../server/services/PolicyService',
    '../server/services/ApprovalAssignmentService',
    '../server/services/WorkspaceService',
    '../server/services/EvaluationWorkspaceProvider',
    '../server/routes/evaluations',
    '../server/routes/workspace',
  ]) {
    try {
      delete require.cache[require.resolve(relativePath)];
    } catch (_error) {
      // A missing RUN-12 module is the expected state of the first red run.
    }
  }
}

function freshWorkspace(dbPath) {
  process.env.DB_PATH = dbPath;
  process.env.JWT_SECRET = 'run-12-test-secret';
  clearWorkspaceModules();
  const dbModule = require('../server/db');
  const auth = require('../server/middleware/auth');
  const workspaceRouter = require('../server/routes/workspace');
  const evaluationsRouter = require('../server/routes/evaluations');
  return { ...dbModule, ...auth, signToken: canonicalTokenFactory(dbModule, auth), workspaceRouter, evaluationsRouter };
}

function startApp({ workspaceRouter, evaluationsRouter }) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/workspace', workspaceRouter);
  app.use('/evaluations', evaluationsRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function addUser(db, email, role, isAdmin = false) {
  return upsertCanonicalUser(db, {
    email, role, isAdmin, displayName: `RUN-12 ${role}`, createdBy: 'run-12-test',
  });
}

function seedEvaluation(db, {
  code,
  supplierId,
  templateId,
  specialist,
  status = 'Khởi tạo',
  plannedDate = null,
}) {
  const specialistUserId = db.prepare('SELECT user_id FROM users WHERE email=?').pluck().get(specialist);
  const info = db.prepare(`
    INSERT INTO evaluation_tickets (
      ticket_code, supplier_id, supplier_code, supplier_name, evaluation_type,
      template_id, question_template_version_id, facility_type, supplier_scale, planned_date, current_status,
      assigned_specialist_id, created_by, updated_at
    ) VALUES (?, ?, 'NCC-RUN12', 'Nhà cung cấp RUN-12', 'Đánh giá định kỳ',
      ?, (SELECT id FROM question_template_versions WHERE template_id=? AND status='PUBLISHED'
          ORDER BY version_no DESC LIMIT 1), 'CHUNG', 'LARGE', ?, ?, ?, ?, datetime('now'))
  `).run(code, supplierId, templateId, templateId, plannedDate, status, specialistUserId, specialistUserId);
  return Number(info.lastInsertRowid);
}

test('RUN-12 exposes an evaluation-only Workspace route and the required compact UI', () => {
  for (const relativePath of [
    'server/services/WorkspaceService.js',
    'server/services/EvaluationWorkspaceProvider.js',
    'server/routes/workspace.js',
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, relativePath)), true, `${relativePath} must exist`);
  }

  const navigation = source('public/js/navigation-manifest.js');
  assert.match(navigation, /id:\s*['"]workspace['"]/);
  assert.match(navigation, /route:\s*['"]\/workspace['"]/);
  assert.match(navigation, /label:\s*['"]Không gian làm việc['"]/);
  assert.match(navigation, /route:\s*['"]\/dashboard['"]/);
  assert.match(navigation, /label:\s*['"]Báo cáo thống kê['"]/);

  const server = source('server/index.js');
  assert.match(server, /\/api\/workspace/);
  const html = source('public/index.html');
  for (const marker of [
    'view-workspace',
    'workspace-summary-need-action',
    'workspace-summary-overdue',
    'workspace-summary-due-soon',
    'workspace-summary-handled',
    'Việc cần làm',
    'Đã xử lý gần đây',
    'Mã / Nhà cung cấp',
    'Trạng thái',
    'Hạn xử lý',
    'Hành động',
  ]) {
    assert.match(html, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  const app = source('public/app.js');
  assert.match(app, /async function loadWorkspace/);
  assert.match(app, /api\(['"]\/workspace/);
  assert.match(app, /Mở xử lý/);
  assert.match(app, /['"]workspace['"]:\s*loadWorkspace/);
});

test('WorkspaceService calculates summaries from the same filtered actionable dataset and de-duplicates recent entities', async () => {
  const { WorkspaceService } = require('../server/services/WorkspaceService');
  const provider = {
    async pending() {
      return [
        {
          module: 'EVALUATION', work_group_key: 'EVALUATION:1', entity_id: 1,
          entity_code: 'DG-1', supplier_name: 'Alpha', task_type: 'SCORE',
          task_label: 'Bắt đầu đánh giá', status: 'Khởi tạo', due_date: isoDate(-2),
          overdue_days: 2, priority: 'HIGH', action_id: 'score', action_label: 'Mở xử lý',
          route: '/qlcl/#/evaluations/scoring?ticket=DG-1',
        },
      ];
    },
    async recent() {
      return [
        { module: 'EVALUATION', work_group_key: 'EVALUATION:9', entity_id: 9, acted_at: '2026-07-16T09:00:00.000Z' },
        { module: 'EVALUATION', work_group_key: 'EVALUATION:9', entity_id: 9, acted_at: '2026-07-15T09:00:00.000Z' },
        { module: 'EVALUATION', work_group_key: 'EVALUATION:7', entity_id: 7, acted_at: '2026-07-13T09:00:00.000Z' },
      ];
    },
  };
  const service = new WorkspaceService({ providers: [provider], clock: () => new Date(`${isoDate(0)}T12:00:00.000Z`) });

  const all = await service.getWorkspace({ user: { email: 'qa@example.invalid' }, query: {} });
  assert.deepEqual(all.summary, {
    need_action: 1,
    overdue: 1,
    due_soon: 0,
    handled_recent: 2,
  });
  assert.equal(all.items.length, 1);
  assert.equal(all.recent.length, 2);
  assert.deepEqual(Object.keys(all.pagination).sort(), ['page', 'page_size', 'total', 'total_pages']);
  assert.ok(Array.isArray(all.available_filters.modules));

  const filtered = await service.getWorkspace({
    user: { email: 'qa@example.invalid' },
    query: { module: 'EVALUATION', due: 'overdue', q: 'alpha' },
  });
  assert.equal(filtered.items.length, 1);
  assert.equal(filtered.summary.need_action, 1);
  assert.equal(filtered.summary.overdue, 1);
  assert.equal(filtered.summary.due_soon, 0);
});

test('RUN-12 synthetic UAT gives every role only authorized evaluation work', async () => {
  const dbPath = path.join(os.tmpdir(), `qlcl-run12-${Date.now()}-${Math.random()}.db`);
  const oldDbPath = process.env.DB_PATH;
  const oldSecret = process.env.JWT_SECRET;
  const { db, signToken, workspaceRouter, evaluationsRouter } = freshWorkspace(dbPath);
  let server;

  try {
    const users = {
      specialist: ['run12-specialist@example.invalid', 'Chuyên viên', false],
      other: ['run12-other@example.invalid', 'Chuyên viên', false],
      lead: ['run12-lead@example.invalid', 'Lead miền', false],
      tbp: ['run12-tbp@example.invalid', 'TBP', false],
      gdk: ['run12-gdk@example.invalid', 'GĐK', false],
      admin: ['run12-admin@example.invalid', 'Admin', true],
    };
    Object.values(users).forEach(([email, role, isAdmin]) => addUser(db, email, role, isAdmin));

    const tokens = Object.fromEntries(Object.entries(users).map(([key, [email, role, isAdmin]]) => [
      key,
      signToken({ email, role, isAdmin }, 3600),
    ]));

    const supplier = db.prepare(`
      INSERT INTO supplier_master (supplier_code, supplier_name, status, source_type, created_by)
      VALUES ('NCC-RUN12', 'Nhà cung cấp RUN-12', 'ACTIVE', 'MANUAL',
        (SELECT user_id FROM users WHERE email='run12-admin@example.invalid'))
    `).run();
    const template = db.prepare('SELECT id FROM question_templates ORDER BY id LIMIT 1').get();
    assert.ok(template?.id);

    const ownEvaluationId = seedEvaluation(db, {
      code: 'DG-R12-OWN', supplierId: supplier.lastInsertRowid, templateId: template.id,
      specialist: users.specialist[0], plannedDate: isoDate(-2),
    });
    const endEvaluationId = seedEvaluation(db, {
      code: 'DG-R12-END', supplierId: supplier.lastInsertRowid, templateId: template.id,
      specialist: users.specialist[0], status: 'Đang xử lý', plannedDate: isoDate(5),
    });
    db.prepare(`
      UPDATE evaluation_tickets SET scoring_locked=1, completed_round=1,
        score_percent=85, result_label='Đạt', final_conclusion='Đạt'
      WHERE id=?
    `).run(endEvaluationId);
    const submitEvaluationId = seedEvaluation(db, {
      code: 'DG-R12-SUBMIT', supplierId: supplier.lastInsertRowid, templateId: template.id,
      specialist: users.specialist[0], status: 'Đang xử lý', plannedDate: isoDate(6),
    });
    db.prepare(`
      UPDATE evaluation_tickets SET scoring_locked=1, completed_round=1,
        score_percent=50, result_label='Không đạt', final_conclusion='Không đạt'
      WHERE id=?
    `).run(submitEvaluationId);
    const round2StartEvaluationId = seedEvaluation(db, {
      code: 'DG-R12-R2-START', supplierId: supplier.lastInsertRowid, templateId: template.id,
      specialist: users.specialist[0], status: 'Chờ khắc phục', plannedDate: isoDate(-20),
    });
    db.prepare('UPDATE evaluation_tickets SET scoring_locked=1, completed_round=1 WHERE id=?').run(round2StartEvaluationId);
    db.prepare(`
      INSERT INTO evaluation_rounds (ticket_id, round_no, status, locked_at, locked_by)
      VALUES (?, 1, 'COMPLETED', datetime('now'), ?)
    `).run(round2StartEvaluationId, db.prepare('SELECT user_id FROM users WHERE email=?').pluck().get(users.specialist[0]));
    const round2EvaluationId = seedEvaluation(db, {
      code: 'DG-R12-R2', supplierId: supplier.lastInsertRowid, templateId: template.id,
      specialist: users.specialist[0], status: 'Đang đánh giá lần 2', plannedDate: isoDate(-20),
    });
    db.prepare('UPDATE evaluation_tickets SET current_round_no=2, completed_round=1 WHERE id=?').run(round2EvaluationId);
    const round1Info = db.prepare(`
      INSERT INTO evaluation_rounds (ticket_id, round_no, status, locked_at, locked_by)
      VALUES (?, 1, 'COMPLETED', datetime('now'), ?)
    `).run(round2EvaluationId, db.prepare('SELECT user_id FROM users WHERE email=?').pluck().get(users.specialist[0]));
    db.prepare(`
      INSERT INTO evaluation_rounds (ticket_id, round_no, status)
      VALUES (?, 2, 'PROCESSING')
    `).run(round2EvaluationId);
    const questionItemId = db.prepare(`SELECT qi.id FROM evaluation_tickets t
      JOIN question_items qi ON qi.question_template_version_id=t.question_template_version_id
      WHERE t.id=?
      ORDER BY qi.order_index LIMIT 1`).pluck().get(round2EvaluationId);
    const answerId = db.prepare(`INSERT INTO evaluation_answers
      (round_id, question_item_id, score, comment, answered_by)
      VALUES (?, ?, 'C', 'Điểm cần khắc phục', ?)`)
      .run(round1Info.lastInsertRowid, questionItemId,
        db.prepare('SELECT user_id FROM users WHERE email=?').pluck().get(users.specialist[0])).lastInsertRowid;
    db.prepare(`
      INSERT INTO evaluation_nonconformities (
        ticket_id, round_id, evaluation_answer_id, nonconformity_content, remediation_content, due_date, severity, status, created_by
      ) VALUES (?, ?, ?, 'Điểm cần khắc phục', 'Bổ sung bằng chứng', ?, 'C', 'OPEN', ?)
    `).run(round2EvaluationId, round1Info.lastInsertRowid, answerId, isoDate(4),
      db.prepare('SELECT user_id FROM users WHERE email=?').pluck().get(users.specialist[0]));
    seedEvaluation(db, {
      code: 'DG-R12-HIDDEN', supplierId: supplier.lastInsertRowid, templateId: template.id,
      specialist: users.other[0], plannedDate: isoDate(2),
    });
    const leadEvaluationId = seedEvaluation(db, {
      code: 'DG-R12-LEAD', supplierId: supplier.lastInsertRowid, templateId: template.id,
      specialist: users.specialist[0], status: 'Chờ duyệt (Lead)', plannedDate: isoDate(-10),
    });
    db.prepare(`
      INSERT INTO approval_tasks (ticket_id, approval_level, assigned_role, assigned_user_id, status, comment)
      VALUES (?, 'LEAD', 'Lead miền', ?, 'PENDING', 'NHẬN XÉT NHẠY CẢM KHÔNG ĐƯỢC RÒ RỈ')
    `).run(leadEvaluationId, db.prepare('SELECT user_id FROM users WHERE email=?').pluck().get(users.lead[0]));
    const tbpEvaluationId = seedEvaluation(db, {
      code: 'DG-R12-TBP', supplierId: supplier.lastInsertRowid, templateId: template.id,
      specialist: users.specialist[0], status: 'Chờ duyệt (TBP)', plannedDate: isoDate(-10),
    });
    db.prepare(`
      INSERT INTO approval_tasks (ticket_id, approval_level, assigned_role, assigned_user_id, status)
      VALUES (?, 'TBP', 'TBP', ?, 'PENDING')
    `).run(tbpEvaluationId, db.prepare('SELECT user_id FROM users WHERE email=?').pluck().get(users.tbp[0]));
    const gdkEvaluationId = seedEvaluation(db, {
      code: 'DG-R12-GDK', supplierId: supplier.lastInsertRowid, templateId: template.id,
      specialist: users.specialist[0], status: 'Chờ duyệt (GĐK)', plannedDate: isoDate(-10),
    });
    db.prepare(`
      INSERT INTO approval_tasks (ticket_id, approval_level, assigned_role, assigned_user_id, status)
      VALUES (?, 'GDK', 'GĐK', ?, 'PENDING')
    `).run(gdkEvaluationId, db.prepare('SELECT user_id FROM users WHERE email=?').pluck().get(users.gdk[0]));

    const completedEvaluationId = seedEvaluation(db, {
      code: 'DG-R12-DONE', supplierId: supplier.lastInsertRowid, templateId: template.id,
      specialist: users.specialist[0], status: 'Hoàn thành', plannedDate: isoDate(-3),
    });
    db.prepare(`
      INSERT INTO workflow_history (
        ticket_id, actor_user_id, actor_role, action, from_status, to_status, comment, created_at
      ) VALUES (?, ?, 'Chuyên viên', 'END', 'Đang xử lý', 'Hoàn thành',
        'LỊCH SỬ NHẠY CẢM KHÔNG ĐƯỢC RÒ RỈ', datetime('now'))
    `).run(completedEvaluationId, db.prepare('SELECT user_id FROM users WHERE email=?').pluck().get(users.specialist[0]));

    const appInfo = await startApp({ workspaceRouter, evaluationsRouter });
    server = appInfo.server;
    const getWorkspace = async (token, query = '') => {
      const response = await fetch(`${appInfo.baseUrl}/workspace${query}`, {
        headers: { Cookie: `qlcl_token=${token}` },
      });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      return body;
    };

    const specialist = await getWorkspace(tokens.specialist);
    const specialistCodes = specialist.items.map((item) => item.entity_code);
    assert.ok(specialistCodes.includes('DG-R12-OWN'));
    assert.equal(specialistCodes.includes('DG-R12-HIDDEN'), false);
    assert.equal(specialistCodes.includes('DG-R12-LEAD'), false, 'waiting approval is not a specialist task');
    assert.equal(specialist.items.find((item) => item.entity_code === 'DG-R12-END').action_id, 'end');
    assert.equal(specialist.items.find((item) => item.entity_code === 'DG-R12-SUBMIT').action_id, 'submit_lead');
    assert.equal(specialist.items.find((item) => item.entity_code === 'DG-R12-R2-START').action_id, 'round2_start');
    const round2Work = specialist.items.find((item) => item.entity_code === 'DG-R12-R2');
    assert.equal(round2Work.action_id, 'score');
    assert.equal(round2Work.due_date, isoDate(4));
    assert.equal(specialist.summary.overdue, 1);
    assert.ok(specialist.recent.some((item) => item.entity_code === 'DG-R12-DONE'));

    const lead = await getWorkspace(tokens.lead);
    assert.deepEqual(lead.items.map((item) => item.entity_code), ['DG-R12-LEAD']);
    assert.equal(lead.items[0].action_id, 'approve_lead');
    assert.match(lead.items[0].route, /workflow=EVALUATION&task=/);
    assert.ok(lead.items.every((item) => item.module === 'EVALUATION'));
    assert.equal(lead.summary.overdue, 0, 'approval tasks without due_at are not overdue');

    const tbp = await getWorkspace(tokens.tbp);
    assert.ok(tbp.items.some((item) => item.entity_code === 'DG-R12-TBP' && item.action_id === 'approve_tbp'));
    assert.ok(tbp.items.every((item) => item.module === 'EVALUATION'));
    assert.equal(tbp.items.some((item) => item.entity_code === 'DG-R12-GDK'), false);

    const gdk = await getWorkspace(tokens.gdk);
    assert.ok(gdk.items.some((item) => item.entity_code === 'DG-R12-GDK' && item.action_id === 'approve_gdk'));
    assert.equal(gdk.items.some((item) => item.entity_code === 'DG-R12-TBP'), false);

    const admin = await getWorkspace(tokens.admin);
    assert.ok(admin.items.some((item) => item.entity_code === 'DG-R12-OWN'));
    assert.ok(admin.items.some((item) => item.entity_code === 'DG-R12-GDK'));
    assert.ok(admin.items.every((item) => item.action_id && item.route));

    const serialized = JSON.stringify({ specialist, lead, tbp, gdk, admin });
    for (const secret of ['NHẬN XÉT NHẠY CẢM', 'LỊCH SỬ NHẠY CẢM']) {
      assert.equal(serialized.includes(secret), false);
    }
    for (const protectedUrl of ['/evaluations/DG-R12-HIDDEN']) {
      const response = await fetch(appInfo.baseUrl + protectedUrl, {
        headers: { Cookie: `qlcl_token=${tokens.specialist}` },
      });
      assert.notEqual(response.status, 200, `${protectedUrl} must recheck direct API authorization`);
    }
    assert.equal(specialist.items.filter((item) => item.module === 'EVALUATION' && item.entity_id === ownEvaluationId).length, 1);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.close();
    process.env.DB_PATH = oldDbPath;
    process.env.JWT_SECRET = oldSecret;
    clearWorkspaceModules();
    try { fs.unlinkSync(dbPath); } catch (_error) { /* ignore */ }
  }
});
