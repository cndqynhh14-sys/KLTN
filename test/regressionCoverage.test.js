const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function readTests() {
  return fs.readdirSync(path.join(root, 'test'))
    .filter((file) => file.endsWith('.test.js'))
    .map((file) => read(path.join('test', file)))
    .join('\n');
}

test('PROMPT-16 regression suite covers high-impact implementation gaps', () => {
  const tests = readTests();
  const requiredPatterns = [
    /criteria workbook import maps DOC-3 markers and is idempotent/,
    /canonical criteria variants cover all DOC-3 BM facility and scale combinations/,
    /ticket creation snapshots selected supplier fields while keeping editable evaluation fields/,
    /round 2 inherits A\/NA answers as readonly and rejects bypass changes/,
    /round 1 approval with nonconformities enters correction state before final completion/,
    /rejection comments are required and persisted to approval task, workflow history, and detail/,
    /DOC-4 report context includes input columns, sections, category percentages, and planning dates/,
    /report exports create streamable XLSX, HTML, and PDF artifacts with metadata records/,
    /centralized result helpers normalize labels and plan next evaluation dates/,
    /database migrations are idempotent and preserve legacy rows/,
  ];

  for (const pattern of requiredPatterns) {
    assert.match(tests, pattern);
  }
});

test('implementation verification checklist documents automated and manual regression gates', () => {
  const checklist = read('docs/implementation_verification_checklist.md');
  const requiredText = [
    'npm test',
    'node --check public\\app.js',
    'Criteria import and variant filtering',
    'Supplier and ticket data',
    'Round 2 lock',
    'Correction workflow',
    'Rejection history',
    'Report context and export',
    'Scoring thresholds',
    'Migrations',
    '#/suppliers',
    '#/evaluations',
    '#/approvals',
    '#/reports',
    'Chờ khắc phục',
  ];

  for (const text of requiredText) {
    assert.ok(checklist.includes(text), `Missing checklist item: ${text}`);
  }
});
