'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('personnel drawer saves canonical roles and scopes through one atomic user authorization flow', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');
  const drawer = html.match(/<aside id="authz-user-detail"[\s\S]*?<\/aside>/)?.[0] || '';

  assert.match(drawer, /id="authz-user-role-list"/);
  assert.match(drawer, /id="authz-user-account-status"/);
  assert.match(drawer, /id="authz-user-effective"/);
  assert.match(drawer, /id="authz-user-safety"/);
  assert.match(drawer, /id="authz-save-user-roles"[^>]*>Lưu thay đổi</);
  assert.equal((drawer.match(/>Lưu thay đổi</g) || []).length, 1);
  assert.match(app, /authzRoleDrafts\.push\(\{ roleCode: role\.roleCode, validFrom: null, validUntil: null \}\)/);
  assert.match(app, /data-authz-drawer-scope-type/);
  assert.match(app, /Thêm phạm vi/);
  assert.match(app, /thao tác hiện đang áp dụng/);
  assert.match(app, /expectedAuthzVersion:\s*authzUserDetail\?\.user\?\.authzVersion/);
  assert.match(app, /roles:\s*authzRoleDrafts,\s*scopes:\s*authzScopeDrafts/);
  assert.match(app, /authorization\/users\/\$\{encodeURIComponent\(authzSelectedUser\)\}\/authorization/);
  assert.doesNotMatch(drawer, /authz v|Nguồn tạo quyền|authz-effective-columns/);
  assert.doesNotMatch(app, /u\.role\s*\|\||u\.is_admin/);
});

test('role drawer keeps four-state permission semantics behind one configuration save', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');

  for (const effect of ['NONE', 'ALLOW', 'DENY', 'ALLOW_DENY']) assert.match(app, new RegExp(`value: '${effect}'`));
  assert.match(app, /function permissionEffectsForValue\(value\)/);
  assert.match(app, /value === 'ALLOW_DENY'[\s\S]*?\['ALLOW', 'DENY'\]/);
  assert.match(app, /data-authz-permission-primary/);
  assert.match(app, /data-authz-permission-code/);
  assert.match(app, /permissions:\s*permissionAssignmentsFromForm\(\)/);
  assert.match(app, /roles\/\$\{encodeURIComponent\(authzSelectedRole\)\}\/configuration/);
  assert.equal((html.match(/id="authz-save-role"/g) || []).length, 1);
  assert.equal((html.match(/id="authz-save-permissions"/g) || []).length, 1, 'compatibility control remains unique and hidden');
});

test('approver workspace is evaluation-only and keeps UUID as the technical identity', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');
  const pane = html.slice(html.indexOf('id="authz-pane-approvals"'), html.indexOf('id="authz-pane-history"'));

  assert.match(pane, /<option value="EVALUATION">Phiếu đánh giá<\/option>/);
  assert.doesNotMatch(pane, /INPUT_DOSSIER|Hồ sơ đầu vào/);
  assert.match(pane, /Tìm theo quy trình, bước, người phê duyệt/);
  assert.match(pane, /Nghiệp vụ[\s\S]*Bước phê duyệt[\s\S]*Phân cho[\s\S]*Dữ liệu áp dụng[\s\S]*Giá trị phạm vi/);
  assert.match(pane, /id="authz-approval-advanced"/);
  assert.doesNotMatch(pane.match(/id="authz-approval-advanced"[^>]*>/)?.[0] || '', /open/);
  assert.match(app, /value:\s*authzUserKey\(user\),\s*label:/);
  assert.match(app, /function approvalAssignedUser\(assignment\)/);
  assert.match(app, /assignment\.assignedPrincipalId/);
  assert.match(app, /filter\(\(item\) => item\.workflowType === 'EVALUATION'\)/);
  assert.match(app, /const current = authzAssignments\.find[\s\S]*?selectApprovalAssignment\(current\)/);
});

test('logical question grouping preserves physical scopes and scoring identity', async () => {
  const helper = await import(pathToFileURL(path.join(root, 'public/js/question-item-groups.mjs')).href);
  const base = {
    question_template_version_id: 7, question_code: '1.1', clause_code: null,
    category_code: 'LEGAL', category: 'Pháp lý', question_text: 'Giấy phép kinh doanh',
    allowed_scores: 'A/D/NA', weight: 1, is_elimination_clause: 1,
    is_critical_clause: 0, requires_attachment: 0, active: 1, variant_code: 'V1', order_index: 1,
  };
  const grouped = helper.groupQuestionItems([
    { ...base, id: 1, facility_type: 'FACTORY', supplier_scale: 'LARGE' },
    { ...base, id: 2, facility_type: 'FACTORY', supplier_scale: 'SMALL' },
    { ...base, id: 3, facility_type: 'STORE', supplier_scale: 'LARGE', weight: 2 },
  ]);

  assert.equal(grouped.length, 2);
  assert.deepEqual(grouped[0].member_ids, ['1', '2']);
  assert.equal(grouped[0].scopes.length, 2);
  assert.deepEqual(helper.buildSharedQuestionUpdates(grouped[0], {
    question_text: 'Nội dung chung đã sửa', facility_type: 'ALL', order_index: 99,
  }), [
    { id: 1, question_text: 'Nội dung chung đã sửa' },
    { id: 2, question_text: 'Nội dung chung đã sửa' },
  ]);
});

test('report lifecycle and navigation keep TARGET boundaries while adopting SOURCE presentation', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');
  const navigation = read('public/js/navigation-manifest.js');

  assert.match(html, /id="report-template-readonly"[\s\S]*?Tạo bản nháp để chỉnh sửa/);
  assert.match(html, /data-report-template-tab="(?:structure|data|presentation|preview|validation|versions|scope)"/);
  assert.match(app, /reportTemplateEditable/);
  assert.match(app, /reportTemplateComponentTypeLabel/);
  assert.doesNotMatch(html, /id="report-template-legacy"/);
  assert.doesNotMatch(navigation, /\/admin\/(?:thresholds|upload-history)/i);
  assert.doesNotMatch(navigation, /INPUT_DOSSIER|UPLOAD\.MANAGE/);
});
