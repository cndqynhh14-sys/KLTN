const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const {
  REQUIRED_RUN_FILES,
  exitCodeForResult,
  sanitizeCommand,
  sha256,
} = require('../scripts/lib/evidenceProtocol');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'scripts', 'run-with-evidence.js');

function tempEvidenceRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-evidence-test-'));
}

function cliEnv(evidenceRoot, extra = {}) {
  return {
    ...process.env,
    EVIDENCE_ROOT: evidenceRoot,
    NODE_ENV: 'test',
    ...extra,
  };
}

function runCli(args, evidenceRoot, extraEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    env: cliEnv(evidenceRoot, extraEnv),
    encoding: 'utf8',
    windowsHide: true,
  });
}

function runCliAsync(args, evidenceRoot, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: root,
      env: cliEnv(evidenceRoot, extraEnv),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

function resultLine(result) {
  const lines = String(result.stdout || '').split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed.run_id) return parsed;
    } catch {}
  }
  throw new Error(`run result not found in stdout: ${result.stdout}`);
}

function runFiles(evidenceRoot, runId) {
  const runDir = path.join(evidenceRoot, runId);
  return {
    runDir,
    run: JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')),
    stdout: fs.readFileSync(path.join(runDir, 'stdout.ndjson'), 'utf8'),
    stderr: fs.readFileSync(path.join(runDir, 'stderr.ndjson'), 'utf8'),
    summary: fs.readFileSync(path.join(runDir, 'summary.md'), 'utf8'),
    checksums: fs.readFileSync(path.join(runDir, 'checksums.sha256'), 'utf8'),
  };
}

test('baseline creates a UUID run with complete allowlisted metadata and verifiable files', (t) => {
  const evidenceRoot = tempEvidenceRoot();
  t.after(() => fs.rmSync(evidenceRoot, { recursive: true, force: true }));
  const result = runCli(['baseline', '--work-item', 'RUN-03 baseline'], evidenceRoot, {
    SHOULD_NOT_BE_CAPTURED: 'environment-secret-marker',
  });
  assert.equal(result.status, 0, result.stderr);
  const output = resultLine(result);
  assert.match(output.run_id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
  const files = runFiles(evidenceRoot, output.run_id);

  assert.equal(files.run.schema_version, 1);
  assert.equal(files.run.status, 'baseline');
  assert.equal(files.run.work_item, 'RUN-03 baseline');
  assert.equal(files.run.result.exit_code, 0);
  assert.equal(Array.isArray(files.run.changed_files), true);
  assert.equal(JSON.stringify(files.run).includes('[CIRCULAR]'), false);
  assert.deepEqual(Object.keys(files.run.environment).sort(), ['ci', 'github_actions', 'node_env', 'runner_os', 'service_name']);
  assert.equal(JSON.stringify(files.run).includes('environment-secret-marker'), false);
  for (const filename of [...REQUIRED_RUN_FILES, 'checksums.sha256']) {
    assert.equal(fs.existsSync(path.join(files.runDir, filename)), true, filename);
  }
  assert.match(files.summary, /cd <repository-root>/);
  assert.match(files.summary, /baseline metadata only/);

  const verify = runCli(['verify', '--run-id', output.run_id], evidenceRoot);
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(JSON.parse(verify.stdout).verified, true);
});

test('nonzero child exit is preserved and stdout/stderr secrets are redacted', (t) => {
  const evidenceRoot = tempEvidenceRoot();
  t.after(() => fs.rmSync(evidenceRoot, { recursive: true, force: true }));
  const secret = 'SYNTHETIC-EVIDENCE-SECRET-7f31';
  const code = [
    "console.log('token=' + process.env.SYNTH_SECRET)",
    "console.log(JSON.stringify({ password: process.env.SYNTH_SECRET, nested: { file: { content: process.env.SYNTH_SECRET } } }))",
    "console.error('Bearer ' + process.env.SYNTH_SECRET)",
    'process.exit(7)',
  ].join(';');
  const result = runCli([
    'run', '--work-item', 'nonzero-redaction', '--', process.execPath, '-e', code,
  ], evidenceRoot, { SYNTH_SECRET: secret, EVIDENCE_SECRET_MARKERS: secret });
  assert.equal(result.status, 7, result.stderr);
  const output = resultLine(result);
  assert.equal(output.exit_code, 7);
  const files = runFiles(evidenceRoot, output.run_id);
  const allEvidence = `${result.stdout}\n${result.stderr}\n${files.stdout}\n${files.stderr}\n${JSON.stringify(files.run)}\n${files.summary}`;
  assert.equal(allEvidence.includes(secret), false);
  assert.equal(files.run.result.exit_code, 7);
  assert.equal(files.run.status, 'failed');
  assert.match(allEvidence, /\[REDACTED\]/);
  for (const line of `${files.stdout}${files.stderr}`.split(/\r?\n/).filter(Boolean)) JSON.parse(line);

  const verify = runCli(['verify', '--run-id', output.run_id], evidenceRoot, { EVIDENCE_SECRET_MARKERS: secret });
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(JSON.parse(verify.stdout).verified, true);
  assert.deepEqual(sanitizeCommand(['tool', '--token', secret, '--safe=value']), ['tool', '--token', '[REDACTED]', '--safe=value']);
});

test('concurrent runs use isolated directories and preserve their own output', async (t) => {
  const evidenceRoot = tempEvidenceRoot();
  t.after(() => fs.rmSync(evidenceRoot, { recursive: true, force: true }));
  const childCode = "setTimeout(() => console.log(process.argv[1]), Number(process.argv[2]))";
  const [first, second] = await Promise.all([
    runCliAsync(['run', '--work-item', 'concurrent-a', '--', process.execPath, '-e', childCode, 'evidence-A', '40'], evidenceRoot),
    runCliAsync(['run', '--work-item', 'concurrent-b', '--', process.execPath, '-e', childCode, 'evidence-B', '5'], evidenceRoot),
  ]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const firstResult = resultLine(first);
  const secondResult = resultLine(second);
  assert.notEqual(firstResult.run_id, secondResult.run_id);
  const firstFiles = runFiles(evidenceRoot, firstResult.run_id);
  const secondFiles = runFiles(evidenceRoot, secondResult.run_id);
  assert.match(firstFiles.stdout, /evidence-A/);
  assert.doesNotMatch(firstFiles.stdout, /evidence-B/);
  assert.match(secondFiles.stdout, /evidence-B/);
  assert.doesNotMatch(secondFiles.stdout, /evidence-A/);
});

test('timeout returns 124 and interrupt signal mapping is stable', (t) => {
  const evidenceRoot = tempEvidenceRoot();
  t.after(() => fs.rmSync(evidenceRoot, { recursive: true, force: true }));
  const result = runCli([
    'run', '--work-item', 'timeout', '--timeout-ms', '100', '--', process.execPath, '-e', 'setInterval(() => {}, 1000)',
  ], evidenceRoot);
  assert.equal(result.status, 124, result.stderr);
  const output = resultLine(result);
  const files = runFiles(evidenceRoot, output.run_id);
  assert.equal(files.run.status, 'timed_out');
  assert.equal(files.run.result.timed_out, true);
  assert.equal(files.run.result.exit_code, 124);
  assert.equal(exitCodeForResult(null, 'SIGINT', false), 130);
  assert.equal(exitCodeForResult(null, 'SIGTERM', false), 143);
  assert.equal(exitCodeForResult(null, 'SIGKILL', false), 137);
});

test('test summary, bundle checksum and tamper detection are reproducible', (t) => {
  const evidenceRoot = tempEvidenceRoot();
  t.after(() => fs.rmSync(evidenceRoot, { recursive: true, force: true }));
  const tap = "console.log('# tests 2');console.log('# pass 2');console.log('# fail 0');console.log('# skipped 0');";
  const result = runCli(['run', '--work-item', 'summary-bundle', '--', process.execPath, '-e', tap], evidenceRoot);
  assert.equal(result.status, 0, result.stderr);
  const output = resultLine(result);
  const files = runFiles(evidenceRoot, output.run_id);
  assert.deepEqual(files.run.test_summary, { tests: 2, pass: 2, fail: 0, skipped: 0, cancelled: null });
  assert.match(files.summary, /Tests: 2; pass 2; fail 0; skip 0/);
  assert.equal(files.summary.includes(files.run.command.display), true);

  const bundle = runCli(['bundle', '--run-id', output.run_id], evidenceRoot);
  assert.equal(bundle.status, 0, bundle.stderr);
  const bundleResult = JSON.parse(bundle.stdout);
  const archive = fs.readFileSync(bundleResult.bundle_path);
  assert.equal(bundleResult.bundle_sha256, sha256(archive));
  const sidecar = fs.readFileSync(`${bundleResult.bundle_path}.sha256`, 'utf8');
  assert.match(sidecar, new RegExp(`^${bundleResult.bundle_sha256}  `));

  fs.appendFileSync(path.join(files.runDir, 'summary.md'), '\ntampered\n', 'utf8');
  const verify = runCli(['verify', '--run-id', output.run_id], evidenceRoot);
  assert.equal(verify.status, 1);
  const failure = JSON.parse(verify.stderr);
  assert.deepEqual(failure.verification.checksum_failures, ['summary.md']);
});
