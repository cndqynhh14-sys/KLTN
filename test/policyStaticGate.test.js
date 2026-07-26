'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const productionFiles = [
  ...fs.readdirSync(path.join(root, 'server', 'routes')).map((name) => path.join(root, 'server', 'routes', name)),
  ...fs.readdirSync(path.join(root, 'server', 'services')).filter((name) => name.endsWith('.js')).map((name) => path.join(root, 'server', 'services', name)),
  ...fs.readdirSync(path.join(root, 'server', 'repositories')).filter((name) => name.endsWith('.js')).map((name) => path.join(root, 'server', 'repositories', name)),
  path.join(root, 'public', 'app.js'),
];

const forbidden = [
  /(?:req\.user|user|state)\.(?:role|isAdmin)\s*(?:===|!==)/,
  /\[[^\]]*ROLES\.[^\]]*\]\.includes\((?:req\.user|user)\.role\)/,
  /\bisRole\s*\(/,
  /\brequire(?:Role|Admin|Internal)\b/,
];

test('production policy consumers do not infer authorization from display roles', () => {
  const violations = [];
  for (const file of productionFiles) {
    const source = fs.readFileSync(file, 'utf8');
    source.split(/\r?\n/).forEach((line, index) => {
      if (forbidden.some((pattern) => pattern.test(line))) {
        violations.push(`${path.relative(root, file)}:${index + 1}:${line.trim()}`);
      }
    });
  }
  assert.deepEqual(violations, [], `display-role policy violations:\n${violations.join('\n')}`);
});

test('frontend capability and allowed-action contracts are present', () => {
  const source = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert.match(source, /function hasCapability\(/);
  assert.match(source, /allowed_actions/);
  assert.doesNotMatch(source, /function isRole\(/);
});

test('every non-auth route module declares policy middleware', () => {
  const missing = [];
  const routeDir = path.join(root, 'server', 'routes');
  for (const name of fs.readdirSync(routeDir).filter((item) => item.endsWith('.js') && item !== 'auth.js')) {
    const source = fs.readFileSync(path.join(routeDir, name), 'utf8');
    if (!/requirePermission\(|requireAnyPermission\(|requireApproval\(/.test(source)) missing.push(name);
  }
  assert.deepEqual(missing, []);
});

test('policy middleware exposes stable metadata and safe errors', () => {
  const { requirePermission, requireAnyPermission, requireApproval, policyErrorResponse } = require('../server/middleware/policy');
  assert.deepEqual(requirePermission('EVALUATION.READ').policy, {
    type: 'permission', permissionCode: 'EVALUATION.READ',
  });
  assert.deepEqual(requireApproval('evaluation', 'tbp').policy, {
    type: 'approval', workflowType: 'EVALUATION', level: 'TBP',
  });
  assert.deepEqual(requireAnyPermission(['EVALUATION.READ', 'SUPPLIER.READ']).policy, {
    type: 'permission_any', permissionCodes: ['EVALUATION.READ', 'SUPPLIER.READ'],
  });
  let status;
  let body;
  const res = {
    status(value) { status = value; return this; },
    json(value) { body = value; return value; },
  };
  policyErrorResponse(res, { code: 'forbidden_scope', status: 403, stack: 'must-not-leak' }, { requestId: 'req-test' });
  assert.equal(status, 403);
  assert.deepEqual(body, { error: 'forbidden_scope', request_id: 'req-test' });
});
