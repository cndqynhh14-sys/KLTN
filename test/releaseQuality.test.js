'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'src', 'tailwind.css'), 'utf8');

test('RUN-23 a11y critical controls retain keyboard names, focus, reflow and target-size contracts', () => {
  assert.doesNotMatch(html, /<button(?![^>]*\btype=)[^>]*>/i);
  assert.doesNotMatch(html, /onclick\s*=/i);
  for (const id of ['question-publish', 'report-template-publish', 'report-template-rollback']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /aria-describedby="question-publish-impact"/);
  assert.match(html, /aria-describedby="report-template-publish-impact"/);
  assert.match(html, /context-help-link/);
  assert.match(css, /\.context-help-link[^}]*min-height:\s*40px/);
  assert.match(css, /@media\s*\(max-width:\s*560px\)[\s\S]*\.context-help-link[^}]*min-height:\s*44px/);
  assert.match(css, /focus-visible/);
  assert.match(css, /@media\s*\(max-width:\s*900px\)/);
});

test('RUN-23 security source keeps backend policy boundaries and production UAT mutations fail closed', () => {
  const policy = fs.readFileSync(path.join(ROOT, 'test', 'policyStaticGate.test.js'), 'utf8');
  const uatHarness = fs.readFileSync(path.join(ROOT, 'test', 'uatHarness.test.js'), 'utf8');
  const reportSecurity = fs.readFileSync(path.join(ROOT, 'server', 'reporting', 'artifacts', 'artifactSecurity.js'), 'utf8');
  const questionImport = fs.readFileSync(path.join(ROOT, 'server', 'services', 'QuestionImportService.js'), 'utf8');
  assert.match(policy, /every non-auth route module declares policy middleware/);
  assert.match(uatHarness, /production-readonly blocks every non-auth mutation/);
  assert.match(reportSecurity, /report_storage_key_invalid/);
  assert.match(reportSecurity, /report_artifact_checksum_mismatch/);
  assert.match(questionImport, /external[_ ]links?|formula/i);
});

