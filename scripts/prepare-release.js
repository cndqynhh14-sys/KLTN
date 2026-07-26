'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadMigrations } = require('../server/database/migrationRunner');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'artifacts', 'release', 'run23');
const REPORT_PATH = path.join(OUT, 'test-report.json');
const NPM_CLI = process.env.RUN23_NPM_CLI || process.env.npm_execpath
  || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const COMMAND_IDS = [
  'node20_npm_ci', 'npm_test', 'build', 'test_webapp', 'uat_smoke', 'uat_full',
  'migrations', 'a11y', 'security', 'nfr', 'lint', 'coverage', 'npm_audit', 'release_verify',
];

function run(command, args, options = {}) {
  return spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, ...options });
}

function git(args) {
  const result = run('git', args);
  return result.status === 0 ? String(result.stdout).trim() : '';
}

function gitStatusLines() {
  const result = run('git', ['status', '--porcelain=v1', '--untracked-files=all']);
  return result.status === 0 ? String(result.stdout).replace(/\r/g, '').split('\n').filter(Boolean) : [];
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function parseDecisions() {
  const source = fs.readFileSync(path.join(ROOT, 'docs', 'decisions', 'decision-register.md'), 'utf8');
  return source.split(/\r?\n/).filter((line) => /^\|\s*[A-Z][A-Z0-9-]+\s*\|/.test(line)).map((line) => {
    const columns = line.split('|').slice(1, -1).map((item) => item.trim().replace(/`/g, ''));
    return { id: columns[0], topic: columns[1], status: columns[3] };
  }).filter((item) => item.id !== 'ID');
}

function createSbom(lock) {
  const components = Object.entries(lock.packages || {}).filter(([key, value]) => key.startsWith('node_modules/') && value.version).map(([key, value]) => {
    const name = key.replace(/^.*node_modules\//, '');
    return {
      type: 'library',
      'bom-ref': `pkg:npm/${encodeURIComponent(name)}@${value.version}`,
      name,
      version: value.version,
      purl: `pkg:npm/${encodeURIComponent(name)}@${value.version}`,
      properties: [
        { name: 'qlcl:development-only', value: String(!!value.dev) },
        { name: 'qlcl:optional', value: String(!!value.optional) },
      ],
      ...(value.license ? { licenses: [{ license: { id: String(value.license) } }] } : {}),
    };
  });
  return {
    bomFormat: 'CycloneDX', specVersion: '1.5', serialNumber: `urn:uuid:${crypto.randomUUID()}`, version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      component: { type: 'application', name: lock.name, version: lock.version, 'bom-ref': `pkg:npm/${lock.name}@${lock.version}` },
      tools: { components: [{ type: 'application', name: 'qlcl-release-artifact-generator', version: '1' }] },
    },
    components,
  };
}

function initialReport() {
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    gate: 'RUN-23',
    status: 'NO-GO',
    commands: COMMAND_IDS.map((id) => ({ id, status: 'BLOCKED', reason: 'not_run' })),
  };
}

function packageArchive() {
  for (const file of fs.readdirSync(OUT).filter((name) => name.endsWith('.tgz'))) fs.rmSync(path.join(OUT, file), { force: true });
  const packed = run(process.execPath, [NPM_CLI, 'pack', '--ignore-scripts', '--json', '--pack-destination', OUT], { timeout: 120000 });
  if (packed.status !== 0) throw new Error(`release_pack_failed:${String(packed.error?.message || packed.stderr || packed.stdout).trim()}`);
  const parsed = JSON.parse(String(packed.stdout));
  const item = parsed[0];
  const archivePath = path.join(OUT, item.filename);
  const files = (item.files || []).map((entry) => entry.path).sort();
  const forbidden = files.filter((entry) => /(^|\/)(?:\.env(?:\.|$)|\.git(?:\/|$)|node_modules(?:\/|$)|logs?(?:\/|$)|uploads?(?:\/|$)|backups?(?:\/|$)|data\/.*\.(?:db|db-wal|db-shm)|.*\.(?:db|db-wal|db-shm|log))$/i.test(entry)
    || /(?:^|\/)data\/(?:report-exports|evaluation-attachments)(?:\/|$)/i.test(entry));
  return {
    file: item.filename,
    sha256: sha256File(archivePath),
    size_bytes: fs.statSync(archivePath).size,
    file_count: files.length,
    files,
    forbidden_entries: forbidden,
  };
}

function featureFlags() {
  const specs = [
    ['question_version_publish', 'QUESTION_VERSION_PUBLISH_ENABLED', (value) => value === '1'],
    ['report_durable_exports', 'REPORT_DURABLE_EXPORTS_ENABLED', (value) => value === '1'],
    ['report_object_storage', 'REPORT_OBJECT_STORAGE_ENABLED', (value) => value === '1'],
    ['screen_otp', 'SCREEN_OTP_ENABLED', (value) => value === 'true'],
    ['scoring_policy_publish', 'SCORING_POLICY_PUBLISH_ACK', (value) => value === 'SCORE-001:APPROVED'],
    ['legacy_report_alias', 'REPORT_LEGACY_ALIAS_APPROVAL', (value) => value === 'APV-REPORT-001+REPORT-002:APPROVED'],
  ];
  return specs.map(([id, env, enabled]) => ({ id, environment_key: env, enabled: enabled(String(process.env[env] || '')), value_recorded: false }));
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  if (process.argv.includes('--reset-report') || !fs.existsSync(REPORT_PATH)) fs.writeFileSync(REPORT_PATH, `${JSON.stringify(initialReport(), null, 2)}\n`, 'utf8');
  const lock = readJson(path.join(ROOT, 'package-lock.json'));
  const sbom = createSbom(lock);
  fs.writeFileSync(path.join(OUT, 'sbom.cdx.json'), `${JSON.stringify(sbom, null, 2)}\n`, 'utf8');
  const packageInfo = packageArchive();
  const statusLines = gitStatusLines();
  const relevantDirty = statusLines.filter((line) => !line.slice(3).replace(/\\/g, '/').startsWith('artifacts/release/run23/'));
  const decisions = parseDecisions();
  const findings = readJson(path.join(ROOT, 'config', 'release-findings.json'), { findings: [] }).findings || [];
  const report = readJson(REPORT_PATH, initialReport());
  const migrationReport = readJson(path.join(OUT, 'migration-rehearsal.json'));
  const nfr = readJson(path.join(OUT, 'nfr-report.json'));
  const security = readJson(path.join(OUT, 'security-scan.json'));
  const signoffSource = fs.existsSync(path.join(ROOT, 'docs', 'release', 'uat-signoff.md'))
    ? fs.readFileSync(path.join(ROOT, 'docs', 'release', 'uat-signoff.md'), 'utf8') : '';
  const blockers = [];
  if (Number(process.versions.node.split('.')[0]) !== 20) blockers.push({ code: 'node20_not_verified', owner: 'IT Ops', expiry: null });
  if (relevantDirty.length) blockers.push({ code: 'release_candidate_uncommitted', owner: 'Release Manager', expiry: null, count: relevantDirty.length });
  const accepted = new Set(['APPROVED', 'IMPLEMENTED', 'IMPLEMENTED-COMPAT', 'IMPLEMENTED-RUN21']);
  for (const decision of decisions.filter((item) => !accepted.has(item.status))) blockers.push({ code: 'decision_not_closed', decision_id: decision.id, status: decision.status, owner: 'Decision owner', expiry: null });
  for (const finding of findings.filter((item) => ['CRITICAL', 'HIGH'].includes(item.severity) && item.status !== 'CLOSED')) {
    blockers.push({ code: 'open_security_finding', finding_id: finding.id, severity: finding.severity, owner: finding.owner, expiry: finding.expiry || null });
  }
  if (!signoffSource || /\|\s*(?:PENDING|NO-GO)\s*\|/i.test(signoffSource)) blockers.push({ code: 'uat_signoff_incomplete', owner: 'QLCL/Product/Security/IT Ops', expiry: null });
  const ignoreVerify = process.argv.includes('--pre-verify');
  for (const item of report.commands.filter((entry) => !(ignoreVerify && entry.id === 'release_verify') && entry.status !== 'PASS')) blockers.push({ code: 'release_command_not_passed', command_id: item.id, status: item.status, owner: 'Engineering', expiry: null });
  if (migrationReport?.status !== 'PASS') blockers.push({ code: 'migration_rehearsal_not_passed', owner: 'IT Ops', expiry: null });
  if (nfr?.status !== 'PASS') blockers.push({ code: 'nfr_not_passed', owner: 'Engineering', expiry: null });
  if (!security || security.secret_findings?.length || security.package_forbidden_entries?.length) blockers.push({ code: 'security_scan_not_passed', owner: 'Security', expiry: null });
  if (packageInfo.forbidden_entries.length) blockers.push({ code: 'release_package_forbidden_entry', owner: 'Release Manager', expiry: null });

  const manifest = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    application: { name: lock.name, version: lock.version },
    app_commit: git(['rev-parse', 'HEAD']),
    branch: git(['branch', '--show-current']),
    runtime: { node: process.version, npm: String(run(process.execPath, [NPM_CLI, '--version']).stdout).trim(), required_node: '20.x' },
    working_tree: { dirty: relevantDirty.length > 0, changed_paths: relevantDirty.map((line) => line.slice(3).replace(/\\/g, '/')) },
    migrations: loadMigrations(path.join(ROOT, 'migrations')).map((item) => ({ id: item.id, name: item.name, file: item.fileName, sha256: item.checksum })),
    feature_flags: featureFlags(),
    decisions,
    findings,
    package: packageInfo,
    machine_reports: ['test-report.json', 'migration-rehearsal.json', 'nfr-report.json', 'security-scan.json', 'sbom.cdx.json'],
    go_no_go: { status: blockers.length ? 'NO-GO' : 'GO', blockers },
  };
  fs.writeFileSync(path.join(OUT, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ output_dir: OUT, status: manifest.go_no_go.status, blockers: blockers.length, package: packageInfo.file }, null, 2)}\n`);
}

main();
