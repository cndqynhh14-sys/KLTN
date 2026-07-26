'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const routeDir = path.join(root, 'server', 'routes');
const outputIndex = process.argv.indexOf('--output');
const outputPath = outputIndex >= 0 && process.argv[outputIndex + 1]
  ? path.resolve(process.argv[outputIndex + 1])
  : null;

function lineNumber(source, index) {
  return source.slice(0, index).split(/\r?\n/).length;
}

function unique(values) {
  return [...new Set(values)].sort();
}

function matches(source, pattern, group = 1) {
  return unique([...source.matchAll(pattern)].map((match) => match[group]).filter(Boolean));
}

function routeInventory(file) {
  const source = fs.readFileSync(file, 'utf8');
  const relative = path.relative(root, file).replaceAll('\\', '/');
  const modulePermissions = matches(source, /router\.use\([^;]*?requirePermission\(PERMISSIONS\.([A-Z0-9_]+)/gs);
  const routes = [];
  const declaration = /router\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2/g;
  for (const match of source.matchAll(declaration)) {
    const nextRoute = source.indexOf('\nrouter.', match.index + match[0].length);
    const snippet = source.slice(match.index, nextRoute < 0 ? source.length : nextRoute);
    const explicitPermissions = matches(snippet, /requirePermission\(PERMISSIONS\.([A-Z0-9_]+)/g);
    const approvals = [...snippet.matchAll(/requireApproval\(\s*['"]([^'"]+)['"]\s*,\s*(?:['"]([^'"]+)['"]|\()/g)]
      .map((item) => `${item[1].toUpperCase()}:${item[2] ? item[2].toUpperCase() : 'DYNAMIC'}`);
    routes.push({
      method: match[1].toUpperCase(),
      path: match[3],
      line: lineNumber(source, match.index),
      permissions: unique([...modulePermissions, ...explicitPermissions]),
      approvals: unique(approvals),
      resource_recheck: /policyService\.(?:assert|decision)|visible[A-Z]|assertVisible|resourceContext/.test(snippet),
      allowed_actions_response: /allowed_actions|actionEnvelope/.test(snippet),
    });
  }
  return {
    module: path.basename(file, '.js'),
    file: relative,
    module_permissions: modulePermissions,
    routes,
  };
}

const modules = fs.readdirSync(routeDir)
  .filter((name) => name.endsWith('.js'))
  .sort()
  .map((name) => routeInventory(path.join(routeDir, name)));
const productionSources = [
  ...modules.map((item) => path.join(root, item.file)),
  ...['services', 'repositories'].flatMap((folder) => fs.readdirSync(path.join(root, 'server', folder))
    .filter((name) => name.endsWith('.js')).map((name) => path.join(root, 'server', folder, name))),
  path.join(root, 'public', 'app.js'),
];
const forbidden = [
  /(?:req\.user|user|state)\.(?:role|isAdmin)\s*(?:===|!==)/g,
  /\bisRole\s*\(/g,
  /\brequire(?:Role|Admin|Internal)\b/g,
];
const directDisplayRolePolicyReferences = [];
for (const file of productionSources) {
  const source = fs.readFileSync(file, 'utf8');
  source.split(/\r?\n/).forEach((line, index) => {
    if (forbidden.some((pattern) => { pattern.lastIndex = 0; return pattern.test(line); })) {
      directDisplayRolePolicyReferences.push({ file: path.relative(root, file).replaceAll('\\', '/'), line: index + 1 });
    }
  });
}
const frontend = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const result = {
  schema_version: 1,
  generated_from_code: true,
  route_count: modules.reduce((sum, item) => sum + item.routes.length, 0),
  modules,
  direct_display_role_policy_references: directDisplayRolePolicyReferences,
  frontend: {
    capability_codes: matches(frontend, /hasCapability\(['"]([A-Z0-9_.]+)['"]\)/g),
    consumes_allowed_actions: /allowed_actions/.test(frontend),
    stale_session_handler: /qlcl:session-stale/.test(frontend),
    forbidden_action_handler: /qlcl:action-forbidden/.test(frontend),
  },
};
const json = `${JSON.stringify(result, null, 2)}\n`;
if (outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, json, 'utf8');
} else {
  process.stdout.write(json);
}
