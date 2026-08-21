'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const GUIDES = Object.freeze({
  'role-permission-management': 'docs/user-guide/role-permission-management.md',
  'question-template-management': 'docs/user-guide/question-template-management.md',
  'question-template-import': 'docs/user-guide/question-template-import.md',
  'report-template-management': 'docs/user-guide/report-template-management.md',
  'replace-current-report': 'docs/user-guide/replace-current-report.md',
  'compliance-overview-and-scoring-policy': 'docs/user-guide/compliance-overview-and-scoring-policy.md',
  'report-troubleshooting': 'docs/user-guide/report-troubleshooting.md',
  'configuration-rollback': 'docs/admin-runbook/configuration-rollback.md',
});

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function explicitAnchors(source) {
  return new Set([...source.matchAll(/<a\s+id="([a-z0-9-]+)"\s*><\/a>/g)].map((match) => match[1]));
}

test('RUN-22 publishes every requested Vietnamese operating guide with the shared workflow contract', () => {
  for (const relative of Object.values(GUIDES)) {
    assert.equal(fs.existsSync(path.join(ROOT, relative)), true, relative);
    const source = read(relative);
    assert.match(source, /[ăâđêôơưĂÂĐÊÔƠƯ]/, `${relative} is not Vietnamese`);
    for (const anchor of ['prerequisites', 'permissions', 'steps', 'expected-result', 'rollback', 'escalation']) {
      assert.ok(explicitAnchors(source).has(anchor), `${relative} missing #${anchor}`);
    }
    assert.match(source, /request_id/, `${relative} must preserve an escalation request_id`);
  }
});

test('RUN-22 guide coverage explains authorization, versioned question/report operations and scoring separation', () => {
  const authorization = read(GUIDES['role-permission-management']);
  for (const term of ['user', 'role', 'permission', 'scope', 'approval assignment', 'effective rights', 'Clone vai trò', 'valid_from', 'valid_to', 'thu hồi phiên', 'DENY', 'SYSTEM.ADMIN']) {
    assert.match(authorization, new RegExp(term, 'i'), term);
  }
  const questions = `${read(GUIDES['question-template-management'])}\n${read(GUIDES['question-template-import'])}`;
  for (const term of ['Draft', 'Clone', 'preview', 'diff', 'commit', 'Review', 'Published', 'pin', 'rollback', 'không publish']) {
    assert.match(questions, new RegExp(term, 'i'), term);
  }
  const reports = `${read(GUIDES['report-template-management'])}\n${read(GUIDES['replace-current-report'])}`;
  for (const term of ['definition package', 'binding', 'component', 'HTML', 'PDF', 'XLSX', 'default', 'smoke', 'provenance', 'history']) {
    assert.match(reports, new RegExp(term, 'i'), term);
  }
  const scoring = read(GUIDES['compliance-overview-and-scoring-policy']);
  assert.match(scoring, /đổi (biểu đồ|chart)[\s\S]*không đổi[^\n]*(công thức|policy)/i);
  assert.match(scoring, /điểm C[\s\S]*(impact|tác động)[\s\S]*(phê duyệt|approval)/i);
});

test('RUN-22 troubleshooting uses Symptoms to Escalation and every internal Markdown link resolves to an explicit anchor', () => {
  const troubleshooting = read(GUIDES['report-troubleshooting']);
  for (const label of ['Symptoms', 'Cause', 'Check', 'Resolution', 'Escalation']) {
    assert.match(troubleshooting, new RegExp(`\\*\\*${label}\\*\\*`), label);
  }
  for (const relative of [...Object.values(GUIDES), 'docs/user-guide/README.md']) {
    const source = read(relative);
    for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+\.md)(?:#([a-z0-9-]+))?\)/g)) {
      const target = path.resolve(path.dirname(path.join(ROOT, relative)), match[1]);
      assert.equal(fs.existsSync(target), true, `${relative} -> ${match[1]}`);
      if (match[2]) {
        assert.ok(explicitAnchors(fs.readFileSync(target, 'utf8')).has(match[2]), `${relative} -> #${match[2]}`);
      }
    }
  }
});

test('RUN-22 quick starts stay within two printed pages per role and documentation contains no PII or secret evidence', () => {
  const index = read('docs/user-guide/README.md');
  const anchors = explicitAnchors(index);
  for (const role of ['admin', 'designer', 'publisher', 'auditor']) {
    const start = index.indexOf(`<a id="quick-start-${role}"></a>`);
    assert.ok(start >= 0 && anchors.has(`quick-start-${role}`));
    const next = index.indexOf('<a id="quick-start-', start + 1);
    const words = index.slice(start, next < 0 ? index.length : next).trim().split(/\s+/).length;
    assert.ok(words <= 700, `${role} quick start is ${words} words`);
  }
  const all = Object.values(GUIDES).map(read).join('\n') + index;
  assert.doesNotMatch(all, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|Authorization:\s*Bearer|(?:password|secret|token)\s*[:=]\s*\S+/i);
  for (const email of all.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []) {
    assert.match(email, /\.invalid$/i, `real-looking email in guide: ${email}`);
  }
  for (const image of all.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
    assert.ok(image[1].trim(), 'image missing alt text');
    assert.match(image[2], /synthetic|fixture/i, 'only synthetic fixture images are allowed');
  }
});

test('RUN-22 contextual UI links target allowlisted guides and valid anchors', () => {
  const html = read('public/index.html');
  const expected = [
    ['role-permission-management', 'quick-start-admin'],
    ['question-template-management', 'quick-start-designer'],
    ['question-template-import', 'download-sample'],
    ['report-template-management', 'quick-start-designer'],
    ['compliance-overview-and-scoring-policy', 'layout-vs-score'],
    ['report-troubleshooting', 'error-codes'],
    ['configuration-rollback', 'report-template'],
  ];
  for (const [slug, anchor] of expected) {
    assert.match(html, new RegExp(`/qlcl/help/${slug}#${anchor}`), `${slug}#${anchor}`);
    assert.ok(explicitAnchors(read(GUIDES[slug])).has(anchor), `${GUIDES[slug]} missing #${anchor}`);
  }
  assert.match(html, /class="[^"]*context-help-link[^"]*"/);
  assert.match(html, /id="report-template-error-help"[^>]*data-error-code/);
  assert.match(html, /id="question-download-template"[\s\S]{0,500}question-template-import#download-sample/);
  assert.match(html, /id="report-template-publish"[^>]*(?:aria-describedby|data-tooltip)/);
  assert.match(html, /id="question-publish"[^>]*(?:aria-describedby|data-tooltip)/);
  assert.match(html, /id="report-template-version-select"[^>]*data-tooltip/);
  assert.match(html, /id="question-version-status-chip"[^>]*data-tooltip/);
});

test('RUN-22 authenticated help renderer owns the same allowlist and escapes unsafe Markdown', () => {
  const help = require('../server/routes/help');
  assert.deepEqual(
    Object.keys(help.GUIDE_FILES).sort(),
    Object.keys(GUIDES).sort()
  );
  assert.match(help.renderGuide('# Test\n\n<a id="safe-anchor"></a>\nHello **world**.'), /id="safe-anchor"/);
  assert.doesNotMatch(help.renderGuide('# Test\n<script>alert(1)<\/script>'), /<script>/);
  const route = read('server/routes/help.js');
  assert.match(route, /requireAuth/);
  const server = read('server/index.js');
  assert.match(server, /BASE \+ '\/help'/);
});

