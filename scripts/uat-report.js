const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const runsDir = path.join(root, 'artifacts', 'uat-runs');
const argIndex = process.argv.indexOf('--run-id');
const requested = argIndex >= 0 ? process.argv[argIndex + 1] : process.env.UAT_RUN_ID;
const candidates = fs.existsSync(runsDir)
  ? fs.readdirSync(runsDir, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name)
  : [];
const runId = requested || candidates.sort((a, b) => fs.statSync(path.join(runsDir, b)).mtimeMs - fs.statSync(path.join(runsDir, a)).mtimeMs)[0];
if (!runId || !/^[A-Za-z0-9._:-]+$/.test(runId)) {
  process.stderr.write('No valid UAT run found. Pass --run-id <id>.\n');
  process.exit(2);
}
const dir = path.join(runsDir, runId);
for (const file of ['report.html', 'report.json', 'report.junit.xml', 'report.md']) {
  const target = path.join(dir, file);
  process.stdout.write(`${file}: ${fs.existsSync(target) ? target : 'MISSING'}\n`);
}
