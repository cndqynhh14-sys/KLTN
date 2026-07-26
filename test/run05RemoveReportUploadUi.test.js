const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const navigation = require('../public/js/navigation-manifest');
const actions = require('../public/js/action-registry');

test('RUN-05 removes the full-report upload entry point from report UI on every viewport', () => {
  assert.doesNotMatch(html, /Tải báo cáo lên/i);
  assert.doesNotMatch(html, /btn-open-upload-full|upload-modal|form-upload|btn-submit-upload/);
  assert.doesNotMatch(app, /btn-open-upload-full|upload-modal|form-upload|upload\.submit|uploads\/full-report/);
});

test('RUN-05 leaves no navigation or action-registry orphan', () => {
  assert.equal(navigation.NAVIGATION_MANIFEST.some((item) => item.id === 'upload-report'), false);
  assert.equal(actions.getAction('upload.open'), null);
  assert.equal(actions.getAction('upload.submit'), null);
  assert.equal(Object.values(actions.STATIC_ACTION_BINDINGS).includes('upload.open'), false);
  assert.equal(Object.values(actions.STATIC_ACTION_BINDINGS).includes('upload.submit'), false);
});

test('RUN-05 preserves report export actions while retiring the generic legacy upload router', () => {
  for (const actionId of ['report.print', 'report.export_excel', 'report.export_pdf']) {
    assert.ok(actions.getAction(actionId), actionId);
  }
  assert.equal(fs.existsSync(path.join(ROOT, 'server', 'routes', 'uploads.js')), false);
  assert.match(fs.readFileSync(path.join(ROOT, 'server', 'routes', 'reportExports.js'), 'utf8'), /router\.(?:get|post)/);
});
