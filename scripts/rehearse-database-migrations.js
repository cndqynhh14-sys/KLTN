'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { createRehearsalDatabase, isInside, THROUGH_ID } = require('./create-rehearsal-database');
const { migrateDatabase, migrationStatus } = require('../server/database/migrationRunner');
const { runParity: runStage4cParity } = require('./check-stage4c-parity');
const { runParity: runStage5Parity } = require('./check-stage5-parity');
const { LegacyReportArtifactReconciler } = require('../server/reporting/artifacts/LegacyReportArtifactReconciler');
const { AuthorizationService } = require('../server/services/AuthorizationService');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'migrations');
const DEFAULT_OUTPUT = path.join(ROOT, 'artifacts', 'migration-rehearsal', 'latest');

function parseArgs(argv) {
  const valueAfter = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : null;
  };
  return {
    outputDir: path.resolve(valueAfter('--output-dir') || DEFAULT_OUTPUT),
    withUat: argv.includes('--with-uat'),
  };
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function scalar(db, sql, ...params) {
  return Number(db.prepare(sql).pluck().get(...params) || 0);
}

function databaseChecks(db) {
  return {
    integrity_check: db.pragma('integrity_check', { simple: true }),
    foreign_key_violations: db.pragma('foreign_key_check').length,
  };
}

function schemaSummary(db) {
  const tables = db.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map((row) => row.name);
  const columns = Object.fromEntries(tables.map((table) => [
    table,
    db.pragma(`table_info('${table.replaceAll("'", "''")}')`).map((row) => row.name),
  ]));
  const canonical = JSON.stringify({ tables, columns });
  return {
    table_count: tables.length,
    sha256: crypto.createHash('sha256').update(canonical).digest('hex'),
    selected_columns: {
      users: columns.users || [],
      question_items: columns.question_items || [],
      evaluation_answers: columns.evaluation_answers || [],
      evaluation_nonconformities: columns.evaluation_nonconformities || [],
    },
  };
}

function representativeCounts(db) {
  const names = [
    'users', 'user_roles', 'auth_sessions', 'supplier_master', 'question_templates',
    'question_template_versions', 'question_items', 'evaluation_tickets',
    'evaluation_rounds', 'evaluation_answers', 'evaluation_nonconformities', 'report_exports',
  ];
  return Object.fromEntries(names.map((table) => [table, scalar(db, `SELECT COUNT(*) FROM ${table}`)]));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function requestHealth(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1_000 }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('timeout', () => request.destroy(new Error('health_timeout')));
    request.once('error', reject);
  });
}

function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function startAndProbe({ dbPath, runtimeDir, sequence }) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      ADMIN_EMAILS: '',
      APP_ENV: 'rehearsal',
      ATTACHMENT_DIR: path.join(runtimeDir, 'attachments'),
      DATA_DIR: runtimeDir,
      DB_PATH: dbPath,
      EMAIL_MODE: 'console',
      HOST: '0.0.0.0',
      JWT_SECRET: 'synthetic-rehearsal-placeholder-only',
      NODE_ENV: 'test',
      PORT: String(port),
      REPORT_EXPORT_DIR: path.join(runtimeDir, 'report-exports'),
      SCREEN_OTP_ENABLED: 'false',
      USE_IN_MEMORY_OTP: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
  const startupTimeoutMs = Number(process.env.MIGRATION_REHEARSAL_STARTUP_TIMEOUT_MS || 60_000);
  const deadline = Date.now() + startupTimeoutMs;
  let status = null;
  try {
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        status = await requestHealth(port);
        if (status === 200) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (status !== 200) throw new Error(`startup_health_failed_${sequence}:${child.exitCode ?? 'running'}:${stderr ? 'stderr-present' : 'no-stderr'}`);
    return { sequence, health_status: status, host: '0.0.0.0', port_source: 'process.env.PORT' };
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await waitForExit(child);
  }
}

function runUat() {
  const command = process.platform === 'win32' && process.env.npm_execpath
    ? [process.execPath, process.env.npm_execpath]
    : [process.platform === 'win32' ? 'npm.cmd' : 'npm'];
  const child = spawnSync(command[0], [...command.slice(1), 'run', 'test:webapp'], {
    cwd: ROOT,
    env: {
      ...process.env,
      JWT_SECRET: 'synthetic-rehearsal-placeholder-only',
      EMAIL_MODE: 'console',
      USE_IN_MEMORY_OTP: 'true',
    },
    encoding: 'utf8',
    timeout: 180_000,
    windowsHide: true,
  });
  const combined = `${child.stdout || ''}\n${child.stderr || ''}`;
  const runId = combined.match(/UAT_RUN_ID=([a-f0-9-]+)/i)?.[1] || null;
  return {
    status: child.status === 0 ? 'PASS' : 'FAIL',
    run_id: runId,
    scenario: 'smoke',
    synthetic: true,
    exit_code: child.status,
    launch_error_code: child.error?.code || null,
  };
}

function markdown(report) {
  const row = (label, value) => `| ${label} | ${value} |`;
  return [
    '# Migration rehearsal report',
    '',
    `Generated: ${report.generated_at}`,
    '',
    '| Check | Result |',
    '|---|---|',
    row('Overall', report.status),
    row('Source schema', `synthetic through ${report.source.schema_through}`),
    row('Backup SHA-256', `\`${report.backup.sha256}\``),
    row('Applied migrations', report.migration.applied_ids.join(', ')),
    row('Migration retry', `${report.migration.retry_pending_count} pending`),
    row('Stage 4C parity', report.parity.stage4c.status),
    row('Stage 4D provenance', report.parity.stage4d.status),
    row('Stage 5 parity', report.parity.stage5.status),
    row('Integrity check', report.database.integrity_check),
    row('Foreign-key violations', report.database.foreign_key_violations),
    row('Startup health', report.startup.map((item) => item.health_status).join(', ')),
    row('Canonical auth smoke', report.authentication.canonical_session_resolved ? 'PASS' : 'FAIL'),
    row('Backup restore', report.restore.sha256_matches_backup ? 'PASS' : 'FAIL'),
    row('Synthetic UAT', report.uat.status),
    '',
    '## Safety boundary',
    '',
    '- The rehearsal uses deterministic synthetic identities and business rows only.',
    '- Database, WAL, SHM, report bytes, cookies, OTPs and tokens are not published as artifacts.',
    '- Legacy report rows are classified but never deleted automatically.',
    '- This is a staging-equivalent migration proof, not evidence of a Railway deployment.',
    '',
  ].join('\n');
}

async function runRehearsal({ outputDir, withUat = false }) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'qlcl-stage5-rehearsal-'));
  const sourceDbPath = path.join(workspace, `source-through-${THROUGH_ID}.db`);
  const backupPath = path.join(workspace, `backup-through-${THROUGH_ID}.db`);
  const rehearsalDbPath = path.join(workspace, 'rehearsal.db');
  const restoredPath = path.join(workspace, 'restored.db');
  try {
    const source = createRehearsalDatabase({ dbPath: sourceDbPath, workspace, migrationsDir: MIGRATIONS_DIR });
    const sourceDb = new Database(sourceDbPath, { readonly: true, fileMustExist: true });
    let before;
    try {
      before = { schema: schemaSummary(sourceDb), counts: representativeCounts(sourceDb), ...databaseChecks(sourceDb) };
      await sourceDb.backup(backupPath);
    } finally {
      sourceDb.close();
    }
    const backupSha = sha256File(backupPath);
    const backupDb = new Database(backupPath, { readonly: true, fileMustExist: true });
    let backupChecks;
    try { backupChecks = databaseChecks(backupDb); } finally { backupDb.close(); }
    fs.copyFileSync(backupPath, rehearsalDbPath, fs.constants.COPYFILE_EXCL);

    const db = new Database(rehearsalDbPath);
    db.pragma('foreign_keys = ON');
    let migrated;
    let retry;
    let after;
    let parity;
    let authentication;
    try {
      migrated = migrateDatabase(db, { migrationsDir: MIGRATIONS_DIR, appVersion: 'stage5-rehearsal' });
      retry = migrateDatabase(db, { migrationsDir: MIGRATIONS_DIR, appVersion: 'stage5-rehearsal-retry' });
      const stage4d = new LegacyReportArtifactReconciler({ db, legacyRoot: source.legacyRoot }).stage4dReport();
      parity = { stage4c: runStage4cParity(db), stage4d, stage5: runStage5Parity(db) };
      const oldSessions = source.fixture.sessions.map((item) => db.prepare(`SELECT revoked_at, revoke_reason
        FROM auth_sessions WHERE session_id=?`).get(item.sessionId));
      const authz = new AuthorizationService(db);
      const canonical = authz.createSession(source.fixture.users.admin, { ttlSeconds: 300 });
      const identity = authz.resolveSession(canonical.sessionId, source.fixture.users.admin, canonical.authzVersion);
      authentication = {
        pre_cutover_session_revoked: oldSessions.every((row) => row?.revoked_at && row.revoke_reason === 'RBAC_CANONICAL_CUTOVER'),
        canonical_session_resolved: identity.roleCodes.includes('SYS_ADMIN'),
        token_claims_source: 'session_id_and_authz_version',
      };
      after = { schema: schemaSummary(db), counts: representativeCounts(db), ...databaseChecks(db) };
      db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }

    const runtimeDir = path.join(workspace, 'runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });
    const startup = [
      await startAndProbe({ dbPath: rehearsalDbPath, runtimeDir, sequence: 1 }),
      await startAndProbe({ dbPath: rehearsalDbPath, runtimeDir, sequence: 2 }),
    ];

    fs.copyFileSync(backupPath, restoredPath, fs.constants.COPYFILE_EXCL);
    const restoredDb = new Database(restoredPath, { readonly: true, fileMustExist: true });
    let restore;
    try {
      const status = migrationStatus(restoredDb, { migrationsDir: MIGRATIONS_DIR });
      const applied = status.filter((item) => item.state === 'applied');
      restore = {
        sha256_matches_backup: sha256File(restoredPath) === backupSha,
        integrity_check: restoredDb.pragma('integrity_check', { simple: true }),
        foreign_key_violations: restoredDb.pragma('foreign_key_check').length,
        last_migration_id: applied.at(-1)?.id || null,
        representative_counts_match: JSON.stringify(representativeCounts(restoredDb)) === JSON.stringify(before.counts),
      };
    } finally {
      restoredDb.close();
    }

    const uat = withUat ? runUat() : { status: 'NOT_RUN', run_id: null, scenario: 'smoke', synthetic: true };
    const appliedIds = migrated.results.filter((item) => item.state === 'applied').map((item) => item.id);
    const retryPending = retry.results.filter((item) => item.state !== 'already-applied').length;
    const hardPass = backupChecks.integrity_check === 'ok'
      && backupChecks.foreign_key_violations === 0
      && JSON.stringify(appliedIds) === JSON.stringify(['0030', '0031', '0032', '0033', '0034', '0035', '0036', '0037', '0038', '0039'])
      && retryPending === 0
      && parity.stage4c.status === 'PASS'
      && parity.stage4d.status !== 'FAILED'
      && parity.stage5.status !== 'FAIL'
      && after.integrity_check === 'ok'
      && after.foreign_key_violations === 0
      && startup.every((item) => item.health_status === 200)
      && authentication.pre_cutover_session_revoked
      && authentication.canonical_session_resolved
      && restore.sha256_matches_backup
      && restore.integrity_check === 'ok'
      && restore.foreign_key_violations === 0
      && restore.last_migration_id === THROUGH_ID
      && restore.representative_counts_match
      && (!withUat || uat.status === 'PASS');
    const report = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      status: hardPass ? 'PASS' : 'FAIL',
      source: { synthetic: true, schema_through: THROUGH_ID, migration_count: source.migrationIds.length },
      before,
      backup: { sha256: backupSha, ...backupChecks },
      migration: { applied_ids: appliedIds, retry_pending_count: retryPending },
      after,
      parity,
      database: { integrity_check: after.integrity_check, foreign_key_violations: after.foreign_key_violations },
      startup,
      authentication,
      restore,
      uat,
      artifact_policy: { database_files_published: false, synthetic_only: true, redacted_report_only: true },
      limitations: [
        'This run proves the repository migration path on representative synthetic data, not a Railway deployment.',
        'Legacy report provenance remains non-destructive; unresolved real files require a separately approved decision.',
      ],
    };
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(outputDir, 'report.md'), markdown(report), 'utf8');
    return report;
  } finally {
    if (!isInside(os.tmpdir(), workspace)) throw new Error('unsafe_rehearsal_cleanup_path');
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

async function main() {
  const report = await runRehearsal(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({
    status: report.status,
    report_dir: parseArgs(process.argv.slice(2)).outputDir,
    backup_sha256: report.backup.sha256,
    applied_migrations: report.migration.applied_ids,
    integrity_check: report.database.integrity_check,
    foreign_key_violations: report.database.foreign_key_violations,
    startup_health: report.startup.map((item) => item.health_status),
    uat: report.uat,
  }, null, 2)}\n`);
  if (report.status !== 'PASS') process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  databaseChecks,
  markdown,
  parseArgs,
  representativeCounts,
  runRehearsal,
  schemaSummary,
  sha256File,
};
