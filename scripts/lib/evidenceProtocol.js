const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn, spawnSync } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { redact, sanitizeString } = require('../../server/observability/redact');

const REQUIRED_RUN_FILES = Object.freeze([
  'run.json',
  'stdout.ndjson',
  'stderr.ndjson',
  'summary.md',
]);
const CHECKSUM_FILE = 'checksums.sha256';
const SENSITIVE_OPTION = /^--?(?:otp|code|dev-?code|screen-?code|token|jwt|cookie|authorization|password|secret|smtp|redis|db-?url)$/i;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? String(result.stdout || '').trim() : null;
}

function dirtyFiles(root) {
  const result = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  const output = result.status === 0 ? String(result.stdout || '') : '';
  if (!output) return [];
  const entries = output.split('\0').filter(Boolean);
  const files = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const status = entry.slice(0, 2);
    const filename = entry.slice(3);
    if (filename) files.push(filename);
    if ((status[0] === 'R' || status[0] === 'C') && entries[index + 1]) {
      files.push(entries[index + 1]);
      index += 1;
    }
  }
  return [...new Set(files)].sort();
}

function npmVersion() {
  const match = String(process.env.npm_config_user_agent || '').match(/\bnpm\/([^\s]+)/);
  if (match) return match[1];
  const executable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  return result.status === 0 ? String(result.stdout || '').trim() : 'unknown';
}

function allowlistedEnvironment() {
  return {
    ci: process.env.CI === 'true' || process.env.CI === '1',
    github_actions: process.env.GITHUB_ACTIONS === 'true',
    runner_os: process.env.RUNNER_OS || null,
    node_env: process.env.NODE_ENV || null,
    service_name: process.env.SERVICE_NAME || 'qlcl',
  };
}

function sanitizeCommand(command) {
  const output = [];
  let redactNext = false;
  for (const rawPart of command || []) {
    const part = String(rawPart);
    if (redactNext) {
      output.push('[REDACTED]');
      redactNext = false;
      continue;
    }
    if (SENSITIVE_OPTION.test(part)) {
      output.push(part);
      redactNext = true;
      continue;
    }
    output.push(sanitizeString(part, 2048));
  }
  return output;
}

function formatCommand(command) {
  return sanitizeCommand(command).map((part) => {
    if (/^[A-Za-z0-9_./:\\=@+-]+$/.test(part)) return part;
    return JSON.stringify(part);
  }).join(' ');
}

function outputEvent(stream, sequence, line) {
  const trimmed = String(line).replace(/\r$/, '');
  let data;
  try {
    data = JSON.parse(trimmed);
  } catch {
    data = undefined;
  }
  return redact({
    timestamp: new Date().toISOString(),
    stream,
    sequence,
    ...(data === undefined ? { message: trimmed } : { data }),
  });
}

function createLineCapture(streamName, artifactStream, terminalStream, collectedLines) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let sequence = 0;

  function emit(line) {
    if (line === '') return;
    sequence += 1;
    const event = outputEvent(streamName, sequence, line);
    const serialized = JSON.stringify(event);
    artifactStream.write(`${serialized}\n`);
    const display = Object.prototype.hasOwnProperty.call(event, 'message')
      ? event.message
      : JSON.stringify(event.data);
    terminalStream.write(`${display}\n`);
    collectedLines.push(display);
  }

  function consume(chunk) {
    pending += decoder.write(chunk);
    const parts = pending.split(/\r\n|\n|\r/);
    pending = parts.pop() || '';
    for (const part of parts) emit(part);
  }

  function end() {
    pending += decoder.end();
    if (pending) emit(pending);
    pending = '';
  }

  return { consume, end };
}

function parseTestSummary(lines) {
  const text = (lines || []).join('\n');
  function number(label) {
    const matches = [...text.matchAll(new RegExp(`(?:^|\\n)(?:#\\s*|ℹ\\s*)${label}\\s+(\\d+)`, 'g'))];
    return matches.length ? Number(matches[matches.length - 1][1]) : null;
  }
  return {
    tests: number('tests'),
    pass: number('pass'),
    fail: number('fail'),
    skipped: number('skipped'),
    cancelled: number('cancelled'),
  };
}

function exitCodeForResult(code, signal, timedOut) {
  if (timedOut) return 124;
  if (Number.isInteger(code)) return code;
  return ({ SIGINT: 130, SIGTERM: 143, SIGKILL: 137 })[signal] || 1;
}

function statusForResult(exitCode, timedOut, signal) {
  if (timedOut) return 'timed_out';
  if (signal) return 'interrupted';
  return exitCode === 0 ? 'passed' : 'failed';
}

function migrationApiEvidence(files) {
  return {
    migration_files: files.filter((file) => file.startsWith('migrations/') || file.startsWith('server/database/')),
    api_files: files.filter((file) => file.startsWith('server/routes/') || file === 'server/index.js' || file === 'public/js/api.js'),
  };
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(redact(value), null, 2)}\n`, 'utf8');
}

function writeChecksums(runDir) {
  const lines = REQUIRED_RUN_FILES.map((filename) => {
    const data = fs.readFileSync(path.join(runDir, filename));
    return `${sha256(data)}  ${filename}`;
  });
  fs.writeFileSync(path.join(runDir, CHECKSUM_FILE), `${lines.join('\n')}\n`, 'utf8');
  return lines;
}

function summaryMarkdown(record) {
  const test = record.test_summary || {};
  const command = record.command && record.command.display ? record.command.display : '(baseline metadata only)';
  const changed = record.changed_files.length ? record.changed_files.map((file) => `- \`${file}\``).join('\n') : '- None';
  return `# Development evidence ${record.run_id}\n\n` +
    `- Work item: ${record.work_item}\n` +
    `- Status: ${record.status}\n` +
    `- Branch: ${record.git.branch || 'unknown'}\n` +
    `- Commit before: ${record.git.commit_before || 'unknown'}\n` +
    `- Commit after: ${record.git.commit_after || 'unknown'}\n` +
    `- Started: ${record.timing.started_at}\n` +
    `- Duration: ${record.timing.duration_ms} ms\n` +
    `- Process exit status: ${record.result.exit_code}\n` +
    `- Tests: ${test.tests ?? 'n/a'}; pass ${test.pass ?? 'n/a'}; fail ${test.fail ?? 'n/a'}; skip ${test.skipped ?? 'n/a'}\n\n` +
    `## Re-run\n\n\`\`\`powershell\ncd <repository-root>\n${command}\n\`\`\`\n\n` +
    `## Changed files\n\n${changed}\n\n` +
    `## Decision / blocker / rollback\n\n` +
    `- Decision: ${record.decision || 'None recorded'}\n` +
    `- Blocker: ${record.blocker || 'None'}\n` +
    `- Rollback: ${record.rollback || 'Not specified'}\n\n` +
    `This summary contains reproducible facts only. It intentionally excludes chain-of-thought, secrets, database contents and real uploaded artifacts.\n`;
}

function initialRecord(options, root, runId, commandForRecord) {
  const dirtyBefore = dirtyFiles(root);
  const started = new Date();
  return {
    schema_version: 1,
    run_id: runId,
    work_item: sanitizeString(options.workItem || process.env.EVIDENCE_WORK_ITEM || 'UNSPECIFIED', 256),
    repository_root: root,
    git: {
      branch: git(root, ['branch', '--show-current']) || 'detached',
      commit_before: git(root, ['rev-parse', 'HEAD']),
      commit_after: null,
      dirty_files_before: dirtyBefore,
      dirty_files_after: [],
    },
    runtime: {
      node: process.version,
      npm: npmVersion(),
      platform: process.platform,
      arch: process.arch,
      os_release: os.release(),
    },
    environment: allowlistedEnvironment(),
    command: commandForRecord.length ? {
      executable: sanitizeCommand(commandForRecord)[0],
      args: sanitizeCommand(commandForRecord).slice(1),
      display: formatCommand(commandForRecord),
    } : null,
    timing: {
      started_at: started.toISOString(),
      finished_at: null,
      duration_ms: 0,
      timeout_ms: options.timeoutMs || null,
    },
    result: {
      exit_code: null,
      signal: null,
      timed_out: false,
      interrupted: false,
    },
    status: 'running',
    test_summary: null,
    changed_files: [],
    migration_api: { migration_files: [], api_files: [] },
    decision: options.decision ? sanitizeString(options.decision, 1024) : null,
    blocker: options.blocker ? sanitizeString(options.blocker, 1024) : null,
    rollback: options.rollback ? sanitizeString(options.rollback, 1024) : null,
  };
}

function finalizeRecord(record, root, startedNs, exitCode, signal, timedOut, stdoutLines) {
  record.git.commit_after = git(root, ['rev-parse', 'HEAD']);
  record.git.dirty_files_after = dirtyFiles(root);
  record.changed_files = [...record.git.dirty_files_after];
  record.migration_api = migrationApiEvidence(record.changed_files);
  record.timing.finished_at = new Date().toISOString();
  record.timing.duration_ms = Number((Number(process.hrtime.bigint() - startedNs) / 1e6).toFixed(3));
  record.result.exit_code = exitCode;
  record.result.signal = signal || null;
  record.result.timed_out = timedOut;
  record.result.interrupted = !!signal;
  record.status = statusForResult(exitCode, timedOut, signal);
  record.test_summary = parseTestSummary(stdoutLines);
  return record;
}

function evidenceRoot(root) {
  return path.resolve(process.env.EVIDENCE_ROOT || path.join(root, 'artifacts', 'dev-runs'));
}

function writeCiOutputs(runId, runDir) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;
  fs.appendFileSync(outputFile, `run_id=${runId}\nrun_dir=${runDir.replaceAll('\\', '/')}\n`, 'utf8');
}

function normalizeSpawnCommand(command) {
  if (process.platform === 'win32' && /^npm(?:\.cmd)?$/i.test(command[0]) && process.env.npm_execpath) {
    return [process.execPath, process.env.npm_execpath, ...command.slice(1)];
  }
  return command;
}

async function runEvidence(options) {
  const root = path.resolve(options.root || path.join(__dirname, '..', '..'));
  const runId = crypto.randomUUID();
  const runDir = path.join(evidenceRoot(root), runId);
  fs.mkdirSync(runDir, { recursive: true });
  const stdoutPath = path.join(runDir, 'stdout.ndjson');
  const stderrPath = path.join(runDir, 'stderr.ndjson');
  const stdoutArtifact = fs.createWriteStream(stdoutPath, { flags: 'wx' });
  const stderrArtifact = fs.createWriteStream(stderrPath, { flags: 'wx' });
  const commandForRecord = options.commandForRecord || options.command || [];
  const record = initialRecord(options, root, runId, commandForRecord);
  const startedNs = process.hrtime.bigint();
  const stdoutLines = [];
  const stderrLines = [];

  if (!options.command || options.command.length === 0) {
    stdoutArtifact.end();
    stderrArtifact.end();
    await Promise.all([new Promise((resolve) => stdoutArtifact.on('close', resolve)), new Promise((resolve) => stderrArtifact.on('close', resolve))]);
    finalizeRecord(record, root, startedNs, 0, null, false, stdoutLines);
    record.status = 'baseline';
  } else {
    const spawnCommand = normalizeSpawnCommand(options.command);
    const child = spawn(spawnCommand[0], spawnCommand.slice(1), {
      cwd: root,
      env: { ...process.env },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutCapture = createLineCapture('stdout', stdoutArtifact, process.stdout, stdoutLines);
    const stderrCapture = createLineCapture('stderr', stderrArtifact, process.stderr, stderrLines);
    child.stdout.on('data', stdoutCapture.consume);
    child.stderr.on('data', stderrCapture.consume);

    let timedOut = false;
    let spawnError = null;
    let timeoutHandle = null;
    let forceHandle = null;
    const forwardSignal = (signal) => {
      if (child.exitCode == null && child.signalCode == null) child.kill(signal);
    };
    const onSigint = () => forwardSignal('SIGINT');
    const onSigterm = () => forwardSignal('SIGTERM');
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);

    child.once('error', (error) => {
      spawnError = error;
      stderrCapture.consume(Buffer.from(`command_start_failed: ${error.message}\n`));
    });
    if (options.timeoutMs) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        forwardSignal('SIGTERM');
        forceHandle = setTimeout(() => forwardSignal('SIGKILL'), 2000);
        forceHandle.unref();
      }, options.timeoutMs);
      timeoutHandle.unref();
    }

    const result = await new Promise((resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (forceHandle) clearTimeout(forceHandle);
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    stdoutCapture.end();
    stderrCapture.end();
    stdoutArtifact.end();
    stderrArtifact.end();
    await Promise.all([new Promise((resolve) => stdoutArtifact.on('close', resolve)), new Promise((resolve) => stderrArtifact.on('close', resolve))]);
    const exitCode = spawnError ? 127 : exitCodeForResult(result.code, result.signal, timedOut);
    finalizeRecord(record, root, startedNs, exitCode, result.signal, timedOut, stdoutLines);
  }

  writeJson(path.join(runDir, 'run.json'), record);
  fs.writeFileSync(path.join(runDir, 'summary.md'), summaryMarkdown(record), 'utf8');
  writeChecksums(runDir);
  writeCiOutputs(runId, runDir);
  return { exitCode: record.result.exit_code, record, runDir, runId };
}

function parseChecksums(content) {
  const entries = new Map();
  for (const line of String(content).split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/);
    if (!match) throw new Error(`invalid_checksum_line:${line}`);
    entries.set(match[2], match[1]);
  }
  return entries;
}

function secretFindings(text, markers = []) {
  const findings = [];
  const rules = [
    ['bearer', /\bBearer\s+(?!\[REDACTED\])[^\s"']+/i],
    ['jwt', /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/],
    ['sensitive_assignment', /(?<![A-Za-z0-9_])["']?(?:otp|code|dev[_-]?code|screen[_-]?code|token|jwt|cookie|authorization|password|secret|smtp_pass|redis_url|db_url)["']?\s*[:=]\s*["']?(?!\[REDACTED\]|null\b|false\b|true\b|unknown\b)[^\s,"';}]+/i],
  ];
  for (const [name, pattern] of rules) if (pattern.test(text)) findings.push(name);
  for (const marker of markers.filter(Boolean)) if (text.includes(marker)) findings.push('explicit_marker');
  return [...new Set(findings)];
}

function verifyRun(options) {
  const root = path.resolve(options.root || path.join(__dirname, '..', '..'));
  const runDir = path.join(evidenceRoot(root), options.runId);
  if (!fs.existsSync(runDir)) throw new Error(`run_not_found:${options.runId}`);
  const expected = parseChecksums(fs.readFileSync(path.join(runDir, CHECKSUM_FILE), 'utf8'));
  const checksumFailures = [];
  for (const filename of REQUIRED_RUN_FILES) {
    const actual = sha256(fs.readFileSync(path.join(runDir, filename)));
    if (expected.get(filename) !== actual) checksumFailures.push(filename);
  }

  const ndjsonFailures = [];
  for (const filename of ['stdout.ndjson', 'stderr.ndjson']) {
    const lines = fs.readFileSync(path.join(runDir, filename), 'utf8').split(/\r?\n/).filter(Boolean);
    lines.forEach((line, index) => {
      try { JSON.parse(line); } catch { ndjsonFailures.push(`${filename}:${index + 1}`); }
    });
  }

  const markers = String(process.env.EVIDENCE_SECRET_MARKERS || '').split(',').filter(Boolean);
  const scanText = REQUIRED_RUN_FILES.map((filename) => fs.readFileSync(path.join(runDir, filename), 'utf8')).join('\n');
  const findings = secretFindings(scanText, markers);
  const result = {
    run_id: options.runId,
    verified: checksumFailures.length === 0 && ndjsonFailures.length === 0 && findings.length === 0,
    checksum_failures: checksumFailures,
    ndjson_failures: ndjsonFailures,
    secret_findings: findings,
  };
  if (!result.verified) {
    const error = new Error('evidence_verification_failed');
    error.result = result;
    throw error;
  }
  return result;
}

function writeTarString(buffer, offset, length, value) {
  buffer.write(String(value).slice(0, length), offset, length, 'utf8');
}

function tarHeader(name, size, mtimeSeconds) {
  const header = Buffer.alloc(512, 0);
  writeTarString(header, 0, 100, name);
  writeTarString(header, 100, 8, '0000644\0');
  writeTarString(header, 108, 8, '0000000\0');
  writeTarString(header, 116, 8, '0000000\0');
  writeTarString(header, 124, 12, `${size.toString(8).padStart(11, '0')}\0`);
  writeTarString(header, 136, 12, `${mtimeSeconds.toString(8).padStart(11, '0')}\0`);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeTarString(header, 257, 6, 'ustar\0');
  writeTarString(header, 263, 2, '00');
  const checksum = header.reduce((total, byte) => total + byte, 0);
  writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return header;
}

function createTarGz(entries) {
  const parts = [];
  for (const entry of entries) {
    const content = fs.readFileSync(entry.path);
    const mtime = Math.floor(fs.statSync(entry.path).mtimeMs / 1000);
    parts.push(tarHeader(entry.name, content.length, mtime), content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts), { level: 9 });
}

function bundleRun(options) {
  const verification = verifyRun(options);
  const root = path.resolve(options.root || path.join(__dirname, '..', '..'));
  const rootDir = evidenceRoot(root);
  const runDir = path.join(rootDir, options.runId);
  const bundleDir = path.join(rootDir, 'bundles');
  fs.mkdirSync(bundleDir, { recursive: true });
  const filenames = [...REQUIRED_RUN_FILES, CHECKSUM_FILE];
  const archive = createTarGz(filenames.map((filename) => ({
    path: path.join(runDir, filename),
    name: `${options.runId}/${filename}`,
  })));
  const bundlePath = path.join(bundleDir, `${options.runId}.tar.gz`);
  fs.writeFileSync(bundlePath, archive);
  const digest = sha256(archive);
  fs.writeFileSync(`${bundlePath}.sha256`, `${digest}  ${path.basename(bundlePath)}\n`, 'utf8');
  return { ...verification, bundle_path: bundlePath, bundle_sha256: digest };
}

module.exports = {
  CHECKSUM_FILE,
  REQUIRED_RUN_FILES,
  allowlistedEnvironment,
  bundleRun,
  createTarGz,
  dirtyFiles,
  evidenceRoot,
  exitCodeForResult,
  formatCommand,
  migrationApiEvidence,
  outputEvent,
  parseTestSummary,
  runEvidence,
  sanitizeCommand,
  secretFindings,
  sha256,
  verifyRun,
  writeChecksums,
};
