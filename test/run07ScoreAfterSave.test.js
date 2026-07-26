'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const actions = require('../public/js/action-registry');
const { PolicyService } = require('../server/services/PolicyService');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('RUN-07 score button is hidden until a saved evaluation is eligible', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');
  const state = read('public/js/state.js');

  assert.match(html, /id="evaluation-score-after-save"[^>]*class="[^"]*hidden/);
  assert.match(html, /id="btn-score-saved-evaluation"[^>]*>Chấm điểm<\/button>/);
  assert.equal(actions.STATIC_ACTION_BINDINGS['btn-score-saved-evaluation'], 'evaluation.score');
  assert.match(state, /evaluationSaveInFlight:\s*false/);
  assert.match(state, /savedEvaluationForScoring:\s*null/);
  assert.match(app, /function showSavedEvaluationScoreAction\(saved\)/);
  assert.match(app, /Number\.isSafeInteger\(Number\(saved\?\.id\)\)/);
  assert.match(app, /resourceCan\(saved, 'score'\)/);
});

test('RUN-07 save success exposes only the exact backend-confirmed ticket', () => {
  const app = read('public/app.js');
  const save = app.match(/async function saveEvaluationAction\(e\) \{[\s\S]*?\n  \}/)?.[0] || '';
  const open = app.match(/function openSavedEvaluationScoring\(\) \{[\s\S]*?\n  \}/)?.[0] || '';

  assert.match(save, /const wasEditing = Boolean\(state\.editingTicketCode\)/);
  assert.match(save, /const saved = mapTicketFromApi\(r\.data\.ticket\)/);
  assert.match(save, /if \(!wasEditing\) showSavedEvaluationScoreAction\(saved\)/);
  assert.match(open, /Number\(row\.id\) === Number\(saved\.id\)/);
  assert.match(open, /row\.code === saved\.code/);
  assert.match(open, /resourceCan\(ticket, 'score'\)/);
  assert.match(open, /openScoringForTicket\(ticket\.code\)/);
  assert.match(app, /\/evaluations\/scoring\?ticket=/);
});

test('RUN-07 save failure, missing identity and repeated submit cannot expose or duplicate scoring action', () => {
  const app = read('public/app.js');
  const save = app.match(/async function saveEvaluationAction\(e\) \{[\s\S]*?\n  \}/)?.[0] || '';

  assert.match(save, /if \(state\.evaluationSaveInFlight\) return/);
  assert.match(save, /clearSavedEvaluationScoreAction\(\)/);
  assert.match(save, /state\.evaluationSaveInFlight = true/);
  assert.match(save, /finally\s*\{\s*state\.evaluationSaveInFlight = false/);
  assert.match(save, /if \(!r\.ok\)[\s\S]*?return/);
  assert.match(app, /if \(!hasSavedEvaluationIdentity\(saved\) \|\| !resourceCan\(saved, 'score'\)\)/);
  assert.match(app, /scoreAfterSave\.classList\.add\('hidden'\)/);
});

test('RUN-07 backend action envelope with create but without score permission omits score', () => {
  const authorizationService = {
    effectivePermissions: () => ({ permissions: ['EVALUATION.READ', 'EVALUATION.CREATE'] }),
    isInScope: () => true,
  };
  const policy = new PolicyService(authorizationService, {});
  const envelope = policy.actionEnvelope('EVALUATION', {
    id: 77,
    ticket_code: 'RUN07-NO-SCORE',
    current_status: 'Khởi tạo',
    created_by: 'creator@example.invalid',
  }, { email: 'creator@example.invalid' });

  assert.ok(envelope.allowed_actions.includes('edit'));
  assert.equal(envelope.allowed_actions.includes('score'), false);
  assert.equal(envelope.disabled_reasons.score, 'forbidden_permission');
});
