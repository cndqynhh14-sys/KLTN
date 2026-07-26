'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PERMISSIONS } = require('../server/authorization/permissionCatalog');
const actions = require('../public/js/action-registry');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const dom = fs.readFileSync(path.join(root, 'public', 'js', 'dom.js'), 'utf8');
const actionDoc = fs.readFileSync(path.join(root, 'docs', 'action-registry.md'), 'utf8');

function staticButtons(markup) {
  return [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)].map((match) => ({
    attrs: match[1],
    text: match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
  }));
}

function attr(attrs, name) {
  return (attrs.match(new RegExp(`\\b${name}="([^"]+)"`)) || [])[1] || '';
}

test('action registry is complete, unique and uses resource.verb identities', () => {
  assert.equal(actions.ACTION_VERSION, 13);
  assert.deepEqual(actions.validateRegistry(), []);
  const required = [
    'action_id', 'label', 'short_label', 'icon', 'variant', 'placement',
    'permission', 'entity', 'allowed_statuses', 'preconditions', 'confirm',
    'reason', 'idempotency', 'success', 'event',
  ];
  const ids = [];
  const knownPermissions = new Set(Object.values(PERMISSIONS));
  for (const item of actions.ACTION_REGISTRY) {
    ids.push(item.action_id);
    assert.match(item.action_id, /^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/);
    for (const field of required) assert.ok(Object.hasOwn(item, field), `${item.action_id}.${field}`);
    if (item.permission) assert.ok(knownPermissions.has(item.permission), `${item.action_id}:${item.permission}`);
    assert.notEqual(item.label, item.permission);
  }
  assert.equal(new Set(ids).size, ids.length);

  const entities = new Set(actions.ACTION_REGISTRY.map((item) => item.entity));
  for (const entity of ['EVALUATION', 'APPROVAL', 'REPORT', 'SUPPLIER',
    'AUTHORIZATION', 'PERSONNEL_IMPORT', 'QUESTION_TEMPLATE', 'REPORT_TEMPLATE', 'SCORING_POLICY', 'AUDIT']) {
    assert.ok(entities.has(entity), entity);
  }
});

test('collapsible navigation groups use a catalogued non-mutating action', () => {
  const action = actions.getAction('navigation.group_toggle');
  assert.equal(action.entity, 'NAVIGATION');
  assert.equal(action.mutation, false);
  assert.equal(action.permission, null);
});

test('every static button has a type and a catalogued action identity', () => {
  assert.doesNotMatch(html, /\bonclick\s*=/i);
  const catalogIds = new Set(actions.ACTION_REGISTRY.map((item) => item.action_id));
  const uncovered = [];
  for (const button of staticButtons(html)) {
    assert.ok(attr(button.attrs, 'type'), `button type: ${button.text || button.attrs}`);
    const id = attr(button.attrs, 'id');
    const actionId = attr(button.attrs, 'data-action-id')
      || (attr(button.attrs, 'data-route-tab') ? 'navigation.open' : '')
      || (attr(button.attrs, 'data-authz-tab') ? 'authorization.tab_open' : '')
      || (/\bdata-multiselect-clear\b/.test(button.attrs) ? 'form.clear_selection' : '')
      || actions.STATIC_ACTION_BINDINGS[id]
      || '';
    if (!actionId || !catalogIds.has(actionId)) uncovered.push({ id, actionId, text: button.text });
  }
  assert.deepEqual(uncovered, []);
});

test('availability distinguishes hidden permission failures from disabled preconditions', () => {
  assert.deepEqual(actions.resolveActionState('evaluation.edit', {
    capabilities: [], resource: { allowed_actions: [], disabled_reasons: { edit: 'forbidden_permission' } },
  }), { state: 'hidden', reason: 'forbidden_permission' });

  assert.deepEqual(actions.resolveActionState('evaluation.edit', {
    capabilities: ['EVALUATION.CREATE'],
    resource: { allowed_actions: [], disabled_reasons: { edit: 'forbidden_scope' } },
  }), { state: 'disabled', reason: 'forbidden_scope' });

  assert.deepEqual(actions.resolveActionState('evaluation.edit', {
    capabilities: ['EVALUATION.CREATE'],
    resource: { allowed_actions: ['edit'], disabled_reasons: {} },
  }), { state: 'enabled', reason: '' });

  assert.deepEqual(actions.resolveActionState('evaluation.edit', {
    capabilities: ['EVALUATION.CREATE'],
    resource: { status: 'Khởi tạo', allowed_actions: ['edit'], disabled_reasons: {} },
  }), { state: 'enabled', reason: '' });
});

test('row partition puts every eligible action in the single overflow menu', () => {
  const descriptors = ['evaluation.view', 'evaluation.score', 'evaluation.history', 'evaluation.delete']
    .map((id) => ({ ...actions.getAction(id) }));
  const three = actions.partitionRowActions(descriptors.slice(0, 3));
  assert.deepEqual(three.direct, []);
  assert.deepEqual(three.overflow.map((item) => item.action_id), [
    'evaluation.view', 'evaluation.score', 'evaluation.history',
  ]);
  const partition = actions.partitionRowActions(descriptors);
  assert.deepEqual(partition.direct, []);
  assert.equal(partition.overflow.length, 4);
  assert.equal(partition.overflow.at(-1).variant, 'danger');
});

test('destructive and mutation actions declare confirm, idempotency, success and audit event', () => {
  const mutations = actions.ACTION_REGISTRY.filter((item) => item.mutation);
  assert.ok(mutations.length > 0);
  for (const item of mutations) {
    assert.equal(item.idempotency.required, true, `${item.action_id}:idempotency`);
    assert.ok(item.success.message, `${item.action_id}:success`);
    assert.ok(item.event, `${item.action_id}:event`);
    if (item.variant === 'danger') {
      assert.equal(item.confirm.required, true, `${item.action_id}:confirm`);
      assert.equal(item.confirm.include_object, true, `${item.action_id}:object`);
      assert.ok(item.confirm.consequence, `${item.action_id}:consequence`);
    }
  }
});

test('reusable action regions and executor own loading, focus and backend action checks', () => {
  for (const helper of ['PageActionBar', 'FormActionBar', 'RowActionGroup', 'EmptyStateAction', 'ActionMenu', 'executeAction']) {
    assert.match(app, new RegExp(`function ${helper}\\(`), helper);
  }
  assert.match(app, /aria-busy/);
  assert.match(app, /allowed_actions/);
  assert.match(app, /disabled_reasons/);
  assert.match(app, /request_id/);
  assert.match(app, /role:\s*'menu'/);
  assert.match(app, /role:\s*'menuitem'/);
  assert.match(app, /setAttribute\('aria-haspopup', 'menu'\)/);
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) assert.match(app, new RegExp(key));
  assert.doesNotMatch(app, /function canApprove\(/);
  assert.doesNotMatch(app, /\.onclick\s*=/);
  assert.match(dom, /String\(tag\)\.toLowerCase\(\) === 'button'.*setAttribute\('type', 'button'\)/);
});

test('every table action column is an ellipsis-only menu surface', () => {
  const actionHeaders = [...html.matchAll(/<th\b([^>]*)>\s*Thao tác\s*<\/th>/gi)];
  assert.ok(actionHeaders.length >= 9, 'expected system-wide action-column inventory');
  for (const [, attrs] of actionHeaders) {
    assert.match(attrs, /class="[^"]*table-action-cell[^"]*"/i);
  }
  assert.doesNotMatch(html, /<th\b[^>]*>\s*<\/th>/i, 'unnamed action headers must be explicit');
  assert.doesNotMatch(app, /data-attendee-delete|question-row-actions|text:\s*'Mở lần đánh giá'/);
  assert.match(app, /menuActions\.length \? 'Mở danh sách thao tác'/);
  assert.match(app, /item\.disabled\s*=\s*!!action\.disabled/);
});

test('evaluation ticket mapping preserves the backend action envelope used for row visibility', () => {
  const mapper = app.match(/function mapTicketFromApi\(ticket\) \{[\s\S]*?function mapQuestionFromApi/);
  assert.ok(mapper, 'mapTicketFromApi must remain discoverable');
  assert.match(mapper[0], /allowed_actions:\s*ticket\.allowed_actions\s*\|\|\s*\[\]/);
  assert.match(mapper[0], /disabled_reasons:\s*ticket\.disabled_reasons\s*\|\|\s*\{\}/);
  assert.match(mapper[0], /evaluation_workspace_visible:\s*ticket\.evaluation_workspace_visible\s*!==\s*false/);
  assert.match(app, /function ownsWorkflowRecord\(row\) \{\s*return row\?\.evaluation_workspace_visible\s*!==\s*false\s*&&\s*resourceCan\(row, 'view'\);\s*\}/);
});

test('generated action documentation stays synchronized with the catalog', () => {
  assert.match(actionDoc, new RegExp(`version ${actions.ACTION_VERSION}\\)`));
  for (const item of actions.ACTION_REGISTRY) assert.match(actionDoc, new RegExp(`\\| ${item.action_id.replace('.', '\\.') } \\|`));
});
