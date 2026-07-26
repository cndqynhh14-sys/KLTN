'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'artifacts', 'release', 'run23');
const REPORT = path.join(OUT, 'test-report.json');
const node = process.execPath;
const npmCli = process.env.RUN23_NPM_CLI || process.env.npm_execpath
  || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const npmArgs = (args) => [npmCli, ...args];
const commandIds = [
  'node20_npm_ci', 'npm_test', 'build', 'test_webapp', 'uat_smoke', 'uat_full',
  'migrations', 'a11y', 'security', 'nfr', 'lint', 'coverage', 'npm_audit', 'release_verify',
];
const commands = commandIds.map((id) => ({ id, status: 'BLOCKED', reason: 'not_run', exit_code: null, duration_ms: 0 }));

function record(item) {
  const index = commands.findIndex((entry) => entry.id === item.id);
  if (index >= 0) commands[index] = item;
  else commands.push(item);
}

function writeReport() {
  const status = commands.every((item) => item.status === 'PASS') ? 'GO' : 'NO-GO';
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(REPORT, `${JSON.stringify({
    schema_version: 1,
    generated_at: new Date().toISOString(),
    gate: 'RUN-23',
    runtime: process.version,
    status,
    commands,
  }, null, 2)}\n`, 'utf8');
}

function execute(id, executable, args, { timeout = 600000, blockedWhen = null } = {}) {
  if (blockedWhen) {
    const item = { id, status: 'BLOCKED', reason: blockedWhen, exit_code: null, duration_ms: 0 };
    record(item);
    process.stdout.write(`[RUN-23] ${id}: BLOCKED (${blockedWhen})\n`);
    writeReport();
    return item;
  }
  process.stdout.write(`[RUN-23] ${id}: ${executable} ${args.join(' ')}\n`);
  const started = process.hrtime.bigint();
  const result = spawnSync(executable, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true, timeout });
  const duration = Number((Number(process.hrtime.bigint() - started) / 1e6).toFixed(3));
  const timedOut = result.error?.code === 'ETIMEDOUT';
  const item = {
    id,
    status: timedOut ? 'BLOCKED' : (result.status === 0 ? 'PASS' : 'FAIL'),
    reason: timedOut ? 'command_timeout_or_registry_unavailable' : (result.status === 0 ? null : 'command_failed'),
    exit_code: result.status,
    duration_ms: duration,
  };
  record(item);
  process.stdout.write(`[RUN-23] ${id}: ${item.status} (${duration} ms)\n`);
  writeReport();
  return item;
}

function prepare(...args) {
  const result = spawnSync(node, ['scripts/prepare-release.js', ...args], { cwd: ROOT, stdio: 'inherit', windowsHide: true, timeout: 180000 });
  if (result.status !== 0) throw new Error('release_prepare_failed');
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const major = Number(process.versions.node.split('.')[0]);
  execute('node20_npm_ci', node, npmArgs(['ci']), { timeout: 300000, blockedWhen: major === 20 ? null : `requires_node_20_current_${process.version}` });
  execute('migrations', node, ['scripts/release-migration-rehearsal.js']);
  execute('nfr', node, npmArgs(['run', 'test:nfr']));
  prepare('--reset-report', '--pre-verify');
  // prepare reset the report; restore the already measured command records.
  writeReport();
  prepare('--pre-verify');

  execute('npm_test', node, npmArgs(['test']));
  execute('build', node, npmArgs(['run', 'build']));
  execute('test_webapp', node, npmArgs(['run', 'test:webapp']));
  execute('uat_smoke', node, npmArgs(['run', 'uat:smoke']));
  execute('uat_full', node, npmArgs(['run', 'uat:full']));
  execute('a11y', node, npmArgs(['run', 'test:a11y']));
  const securityTests = execute('security', node, npmArgs(['run', 'test:security']));
  if (securityTests.status === 'PASS') {
    const scan = spawnSync(node, ['scripts/security-scan.js'], { cwd: ROOT, stdio: 'inherit', windowsHide: true, timeout: 180000 });
    if (scan.status !== 0) {
      securityTests.status = 'FAIL';
      securityTests.reason = 'source_history_artifact_scan_failed';
      writeReport();
    }
  }
  execute('lint', node, npmArgs(['run', 'lint']));
  execute('coverage', node, npmArgs(['run', 'test:coverage']));
  execute('npm_audit', node, npmArgs(['audit', '--json', '--audit-level=high']), { timeout: 60000 });

  prepare('--pre-verify');
  execute('release_verify', node, npmArgs(['run', 'release:verify']));
  prepare();
  const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'release-manifest.json'), 'utf8'));
  const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  report.status = manifest.go_no_go.status;
  report.generated_at = new Date().toISOString();
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`[RUN-23] FINAL: ${manifest.go_no_go.status}; blockers=${manifest.go_no_go.blockers.length}\n`);
  if (manifest.go_no_go.status !== 'GO') process.exitCode = 1;
}

try { main(); } catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
