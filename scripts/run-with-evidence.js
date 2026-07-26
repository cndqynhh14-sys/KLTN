#!/usr/bin/env node

const path = require('node:path');
const {
  bundleRun,
  runEvidence,
  verifyRun,
} = require('./lib/evidenceProtocol');

function usage() {
  return [
    'Usage:',
    '  node scripts/run-with-evidence.js baseline [options]',
    '  node scripts/run-with-evidence.js run [options] -- <command> [args...]',
    '  node scripts/run-with-evidence.js test [options] [-- <command> [args...]]',
    '  node scripts/run-with-evidence.js verify --run-id <uuid>',
    '  node scripts/run-with-evidence.js bundle --run-id <uuid>',
    '',
    'Options: --work-item, --timeout-ms, --decision, --blocker, --rollback, --run-id',
  ].join('\n');
}

function parseArguments(argv) {
  const action = argv[0];
  const separator = argv.indexOf('--');
  const optionArgs = separator >= 0 ? argv.slice(1, separator) : argv.slice(1);
  const command = separator >= 0 ? argv.slice(separator + 1) : [];
  const options = {};
  const names = {
    '--work-item': 'workItem',
    '--timeout-ms': 'timeoutMs',
    '--decision': 'decision',
    '--blocker': 'blocker',
    '--rollback': 'rollback',
    '--run-id': 'runId',
  };
  for (let index = 0; index < optionArgs.length; index += 1) {
    const name = names[optionArgs[index]];
    if (!name || optionArgs[index + 1] == null) throw new Error(`invalid_option:${optionArgs[index]}`);
    options[name] = optionArgs[index + 1];
    index += 1;
  }
  if (options.timeoutMs != null) {
    options.timeoutMs = Number(options.timeoutMs);
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('invalid_timeout_ms');
  }
  return { action, command, options };
}

async function main(argv = process.argv.slice(2)) {
  const root = path.resolve(__dirname, '..');
  const { action, command, options } = parseArguments(argv);
  options.root = root;

  if (action === 'baseline') {
    const result = await runEvidence({ ...options, command: [] });
    process.stdout.write(`${JSON.stringify({ run_id: result.runId, run_dir: result.runDir, exit_code: result.exitCode })}\n`);
    return result.exitCode;
  }
  if (action === 'run') {
    if (!command.length) throw new Error('command_required');
    const result = await runEvidence({ ...options, command });
    process.stdout.write(`${JSON.stringify({ run_id: result.runId, run_dir: result.runDir, exit_code: result.exitCode })}\n`);
    return result.exitCode;
  }
  if (action === 'test') {
    const actualCommand = command.length ? command : [process.execPath, '--test'];
    const commandForRecord = command.length ? command : ['npm', 'test'];
    const result = await runEvidence({ ...options, command: actualCommand, commandForRecord });
    process.stdout.write(`${JSON.stringify({ run_id: result.runId, run_dir: result.runDir, exit_code: result.exitCode })}\n`);
    return result.exitCode;
  }
  if (action === 'verify') {
    if (!options.runId) throw new Error('run_id_required');
    process.stdout.write(`${JSON.stringify(verifyRun(options))}\n`);
    return 0;
  }
  if (action === 'bundle') {
    if (!options.runId) throw new Error('run_id_required');
    process.stdout.write(`${JSON.stringify(bundleRun(options))}\n`);
    return 0;
  }
  throw new Error(`unknown_action:${action || ''}\n${usage()}`);
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    const result = error.result ? { error: error.message, verification: error.result } : { error: error.message };
    process.stderr.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArguments, usage };
