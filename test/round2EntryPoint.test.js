const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');

test('round 2 entry point is centralized on scoring screen', () => {
  const app = fs.readFileSync(path.join(repoRoot, 'public', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');

  assert.match(html, /id="btn-start-round2"/);
  assert.match(app, /bindRegisteredAction\(\$\('btn-start-round2'\), 'evaluation\.round2_start', \(\) => startRound2\(\)/);
  assert.doesNotMatch(app, /round2Btn/);
  assert.match(app, /typeof code !== 'string'/);
  assert.match(app, /err\.message === 'round_2_exists'/);
  assert.match(app, /openAssessmentRound\(ticket\.code, 2\)/);
  assert.match(app, /round_2_exists:\s*true/);
  assert.match(app, /Number\(roundNo\)\s*===\s*1\s*&&\s*ticket\.round_2_eligible\s*&&\s*!ticket\.round_2_exists/);
  assert.doesNotMatch(app, /Mở đánh giá lần 2/);
});
