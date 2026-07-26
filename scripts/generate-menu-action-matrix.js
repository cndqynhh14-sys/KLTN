'use strict';

const fs = require('node:fs');
const path = require('node:path');
const navigation = require('../public/js/navigation-manifest');
const { PERMISSIONS } = require('../server/authorization/permissionCatalog');

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function generateMenuActionMatrix(options = {}) {
  const root = path.resolve(options.root || path.join(__dirname, '..'));
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const contractTest = fs.readFileSync(path.join(root, 'test', 'navigationManifest.test.js'), 'utf8');
  const views = new Set([...html.matchAll(/\bid=["'](view-[^"']+)["']/g)].map((match) => match[1]));
  const loaderBlock = (app.match(/const ROUTE_LOADERS = Object\.freeze\(\{([\s\S]*?)\}\);/) || [])[1] || '';
  const loaderIds = new Set([...loaderBlock.matchAll(/["']([^"']+)["']\s*:/g)].map((match) => match[1]));
  const knownPermissions = new Set(Object.values(PERMISSIONS));
  const enabledRoutes = navigation.NAVIGATION_MANIFEST
    .filter((item) => item.route && navigation.isFeatureEnabled(item));
  const enabledOrphanRoutes = enabledRoutes
    .filter((item) => !item.view || !views.has(item.view) || !loaderIds.has(item.id))
    .map((item) => item.id);
  const manifestViews = new Set(enabledRoutes.map((item) => item.view));
  const viewExclusions = new Set(['view-login', 'view-otp', 'view-route-denied']);
  const enabledOrphanViews = [...views]
    .filter((view) => !manifestViews.has(view) && !viewExclusions.has(view));
  const unknownPermissions = navigation.NAVIGATION_MANIFEST.flatMap((item) => item.permissions)
    .filter((permission, index, values) => !knownPermissions.has(permission) && values.indexOf(permission) === index);
  const contractCoversManifest = /for \(const item of navigation\.NAVIGATION_MANIFEST\)/.test(contractTest)
    && /validateManifest\(\)/.test(contractTest);
  const contractGaps = contractCoversManifest ? [] : enabledRoutes.map((item) => item.id);
  const featureOff = navigation.NAVIGATION_MANIFEST.filter((item) => item.route && !navigation.isFeatureEnabled(item));

  const lines = [
    '# Menu and action matrix',
    '',
    `Generated from \`public/js/navigation-manifest.js\`. Navigation manifest version: \`${navigation.NAVIGATION_VERSION}\`.`,
    '',
    '| ID | Parent | Route | View | Label | Permissions | Feature | Mobile | Sidebar | Sidebar active | Contextual |',
    '|---|---|---|---|---|---|---|---:|---:|---|---:|',
  ];
  for (const item of navigation.NAVIGATION_MANIFEST) {
    lines.push(`| \`${item.id}\` | ${item.parent ? `\`${item.parent}\`` : '—'} | ${item.route ? `\`${item.route}\`` : '—'} | ${item.view ? `\`${item.view}\`` : '—'} | ${item.label} | ${item.permissions.length ? item.permissions.map((permission) => `\`${permission}\``).join('<br>') : '—'} | ${item.feature_flag ? `\`${item.feature_flag}\` (${navigation.isFeatureEnabled(item) ? 'ON' : 'OFF'})` : 'ON'} | ${Number.isFinite(item.mobile_priority) ? item.mobile_priority : '—'} | ${item.sidebar ? 'yes' : 'no'} | ${item.sidebar_active ? `\`${item.sidebar_active}\`` : '—'} | ${item.contextual ? 'yes' : 'no'} |`);
  }
  lines.push('', '## Contextual actions', '', '| ID | Placement | Required permission |', '|---|---|---|');
  for (const item of navigation.NAVIGATION_MANIFEST.filter((candidate) => candidate.contextual)) {
    lines.push(`| \`${item.id}\` | \`${item.parent}\` | ${item.permissions.map((permission) => `\`${permission}\``).join('<br>')} |`);
  }
  lines.push(
    '',
    '## Orphan report',
    '',
    `- Enabled orphan routes: \`${enabledOrphanRoutes.length}\`${enabledOrphanRoutes.length ? ` — ${sorted(enabledOrphanRoutes).map((id) => `\`${id}\``).join(', ')}` : ''}`,
    `- Enabled orphan views: \`${enabledOrphanViews.length}\`${enabledOrphanViews.length ? ` — ${sorted(enabledOrphanViews).map((id) => `\`${id}\``).join(', ')}` : ''}`,
    `- Unknown permissions: \`${unknownPermissions.length}\`${unknownPermissions.length ? ` — ${sorted(unknownPermissions).map((id) => `\`${id}\``).join(', ')}` : ''}`,
    `- Manifest contract test gaps: \`${contractGaps.length}\`${contractGaps.length ? ` — ${sorted(contractGaps).map((id) => `\`${id}\``).join(', ')}` : ''}`,
    `- Feature-OFF routes: \`${featureOff.length}\`${featureOff.length ? ` — ${featureOff.map((item) => `\`${item.route}\` (\`${item.feature_flag}\`)`).join(', ')}` : ''}`,
    '',
    'The generator fails the RUN-11 contract test when an enabled route has no loader/view, a rendered view has no route, a permission is unknown, or the manifest-wide contract test is removed.',
    '',
  );
  return lines.join('\n');
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const output = path.join(root, 'docs', 'menu-action-matrix.md');
  fs.writeFileSync(output, generateMenuActionMatrix({ root }), 'utf8');
  process.stdout.write(`${output}\n`);
}

module.exports = { generateMenuActionMatrix };
