const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const runsDir = path.join(root, 'artifacts', 'uat-runs');
const runIdIndex = process.argv.indexOf('--run-id');
const runId = runIdIndex >= 0 ? process.argv[runIdIndex + 1] : process.env.UAT_RUN_ID;

function fail(message) {
  process.stderr.write(`UAT evidence verification failed: ${message}\n`);
  process.exit(1);
}

if (!runId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(runId)) fail('pass a valid --run-id.');
const runDir = path.join(runsDir, runId);
if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) fail('run directory does not exist.');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const target = path.join(dir, item.name);
    return item.isDirectory() ? walk(target) : [target];
  });
}

const required = ['run-meta.json', 'report.html', 'report.json', 'report.junit.xml', 'report.md'];
for (const file of required) {
  if (!fs.existsSync(path.join(runDir, file))) fail(`missing ${file}.`);
}

const report = JSON.parse(fs.readFileSync(path.join(runDir, 'report.json'), 'utf8'));
if (report.run_id !== runId) fail('report run_id mismatch.');
if (report.policy.response_bodies_stored !== false || report.policy.cookies_stored !== false || report.policy.native_playwright_trace_stored !== false) {
  fail('unsafe report policy.');
}

const files = walk(runDir);
if (files.some((file) => /(?:trace\.zip|storage[-_.]?state|cookies?\.json|har\.zip)$/i.test(path.basename(file)))) {
  fail('forbidden native trace, storage state, cookie or HAR artifact found.');
}

const traces = files.filter((file) => path.basename(file) === 'safe-trace.ndjson');
if (!traces.length) fail('no safe trace found.');
let requestContextCount = 0;
for (const tracePath of traces) {
  const lines = fs.readFileSync(tracePath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) fail(`empty trace: ${path.relative(runDir, tracePath)}.`);
  for (const line of lines) {
    const entry = JSON.parse(line);
    if (entry.request_id && entry.correlation_id) requestContextCount += 1;
    if ('request_body' in entry || 'response_body' in entry || 'headers' in entry || 'cookie' in entry) {
      fail(`unsafe trace field in ${path.relative(runDir, tracePath)}.`);
    }
  }
}
if (!requestContextCount) fail('no response-to-trace request/correlation ID evidence.');

if (report.status !== 'passed') {
  if (!files.some((file) => path.basename(file) === 'failure-masked.png')) fail('failed run has no masked screenshot.');
  const failedTrace = traces.some((tracePath) => fs.readFileSync(tracePath, 'utf8').includes('"status":"failed"'));
  if (!failedTrace) fail('failed run has no failed safe-trace event.');
}

const textExtensions = new Set(['.json', '.ndjson', '.md', '.xml', '.html']);
const patterns = [
  { name: 'authorization', regex: /\bBearer\s+(?!\[REDACTED\])\S+/i },
  { name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/ },
  { name: 'sensitive assignment', regex: /\b(?:devCode|screenCode|password|secret|authorization|set-cookie|cookie|token)\s*["']?\s*[:=]\s*["']?(?!\[REDACTED)/i },
  { name: 'OTP UI disclosure', regex: /(?:Mã dev|mã tạm|dev OTP)\s*[:=]/i },
];
const markers = String(process.env.UAT_SECRET_MARKERS || '').split(',').map((item) => item.trim()).filter(Boolean);
for (const file of files) {
  if (!textExtensions.has(path.extname(file).toLowerCase()) || path.basename(file) === 'checksums.sha256') continue;
  const content = fs.readFileSync(file, 'utf8');
  for (const pattern of patterns) if (pattern.regex.test(content)) fail(`${pattern.name} found in ${path.relative(runDir, file)}.`);
  for (const marker of markers) if (content.includes(marker)) fail(`explicit secret marker found in ${path.relative(runDir, file)}.`);
}

const checksumLines = files
  .filter((file) => path.basename(file) !== 'checksums.sha256')
  .sort()
  .map((file) => `${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}  ${path.relative(runDir, file).replace(/\\/g, '/')}`);
fs.writeFileSync(path.join(runDir, 'checksums.sha256'), `${checksumLines.join('\n')}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ verified: true, run_id: runId, files: checksumLines.length, traces: traces.length, request_context_events: requestContextCount })}\n`);
