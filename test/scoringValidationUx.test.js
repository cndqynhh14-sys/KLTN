const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('scoring validation UX highlights and navigates to actionable fields', () => {
  const app = read('public/app.js');
  const html = read('public/index.html');

  assert.match(app, /collectScoringValidationIssues/);
  assert.match(app, /participantValidationIssue/);
  assert.match(app, /supplierIntroductionValidationIssue/);
  assert.match(app, /leadSubmissionValidationIssue/);
  assert.match(app, /leadSubmissionEligibility/);
  assert.match(app, /q\.critical && score === 'D'/);
  assert.match(app, /ticket\.scoringLocked && result/);
  assert.match(app, /attendees_required/);
  assert.match(app, /supplier_introduction_required/);
  assert.match(app, /lead_submission_not_eligible/);
  assert.match(app, /showScoringValidationIssue\(validationIssues\[0\]\)/);
  assert.match(app, /scrollToScoringValidationIssue/);
  assert.match(app, /data-scoring-question-row/);
  assert.match(app, /attendees-tbody/);
  assert.match(app, /supplier-introduction-input/);
  assert.match(app, /data-nc-remediation/);
  assert.match(app, /data-nc-due-date/);
  assert.match(app, /validation-row/);
  assert.match(app, /validation-inline/);
  assert.match(html, /\.validation-row td/);
  assert.match(html, /\.validation-error/);
  assert.match(html, /id="supplier-introduction-input"/);
});
