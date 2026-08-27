'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

function extractFunction(name) {
  const match = app.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`));
  assert.ok(match, `Missing production function ${name}`);
  return match[0];
}

test('scoring segmented choices expose the exact values for normal, critical and exclusion clauses', () => {
  const source = extractFunction('scoringChoicesForQuestion');
  const factory = new Function(`${source}\nreturn scoringChoicesForQuestion;`);
  const choices = factory();
  assert.deepEqual(choices({ clause: 'normal', critical: false }), ['A', 'B', 'C', 'D', 'NA']);
  assert.deepEqual(choices({ clause: 'normal', critical: true }), ['A', 'B', 'C', 'D', 'NA']);
  assert.deepEqual(choices({ clause: 'exclusion', critical: false }), ['A', 'D', 'NA']);
});

test('scoring UI renders a single-choice radiogroup while preserving the existing score value/change pipeline', () => {
  assert.doesNotMatch(app, /className: 'input score-select'/);
  assert.match(app, /role: 'radiogroup'/);
  assert.match(app, /role: 'radio'/);
  assert.match(app, /const selected = answer\.score === value/);
  assert.match(app, /'data-score-value': r\.id/);
  assert.match(app, /scoreValue\.dispatchEvent\(new Event\('change', \{ bubbles: true \}\)\)/);
  assert.match(app, /document\.querySelectorAll\('\[data-score-value\]'\)/);
});

test('scoring table fits all six columns without horizontal overflow and keeps score choices on one line', () => {
  assert.match(html, /id="scoring-assessment-table"/);
  assert.match(html, /class="table-scroll scoring-assessment-scroll"/);
  assert.match(html, /scoring-col-question/);
  assert.match(html, /scoring-col-score/);
  assert.match(html, /\.scoring-assessment-scroll\s*\{[^}]*overflow-x:\s*visible/);
  assert.match(html, /#scoring-assessment-table\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*table-layout:\s*fixed/);
  assert.doesNotMatch(html, /#scoring-assessment-table\s*\{[^}]*min-width:\s*1260px/);
  assert.match(html, /\.score-segmented\s*\{[^}]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\) minmax\(0, 1\.2fr\)[^}]*overflow:\s*visible/);
  assert.match(html, /\.score-segmented\.exclusion\s*\{[^}]*repeat\(2, minmax\(0, 1fr\)\) minmax\(0, 1\.2fr\)/);
  assert.match(html, /#scoring-assessment-table td:nth-child\(2\)\s*\{[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/);
  assert.match(html, /<th>Điều khoản<\/th><th>Câu hỏi<\/th><th>Loại điều khoản<\/th><th>Điểm<\/th><th>Ý kiến \/ Ghi chú<\/th><th>Trạng thái<\/th>/);
});

test('round-two inherited answers keep readonly controls without exposing technical readonly wording', () => {
  assert.match(app, /text: 'Kế thừa từ lần 1'/);
  assert.doesNotMatch(app, /Kế thừa từ lần 1 - chỉ đọc/);
  assert.match(app, /choice\.disabled = !editableRound \|\| answerReadonly/);
  assert.match(app, /note\.disabled = !editableRound \|\| answerReadonly/);
});
