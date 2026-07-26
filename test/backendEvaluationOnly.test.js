'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

function runtimeRequireGraph(entryRelativePath) {
  const visited = new Set();
  const visit = (absolutePath) => {
    const normalized = path.normalize(absolutePath);
    if (visited.has(normalized) || !fs.existsSync(normalized)) return;
    visited.add(normalized);
    const source = fs.readFileSync(normalized, 'utf8');
    for (const match of source.matchAll(/require\(['"](\.{1,2}\/[^'"]+)['"]\)/g)) {
      const candidate = path.resolve(path.dirname(normalized), match[1]);
      const resolved = fs.existsSync(candidate) && fs.statSync(candidate).isFile()
        ? candidate
        : fs.existsSync(`${candidate}.js`) ? `${candidate}.js` : null;
      if (resolved) visit(resolved);
    }
  };
  visit(path.join(root, entryRelativePath));
  return [...visited].map((file) => path.relative(root, file).replace(/\\/g, '/'));
}

test('backend entrypoint does not load or mount the input-dossier runtime', () => {
  const server = read('server/index.js');
  assert.doesNotMatch(server, /routes\/inputDossiers|inputDossiersRouter|\/api\/input-dossiers/);
  assert.doesNotMatch(server, /routes\/masterData|masterDataRouter|\/api\/master-data/);
  assert.doesNotMatch(server, /routes\/uploads|uploadsRouter|\/api\/uploads/);
  assert.match(server, /BASE \+ '\/api'[\s\S]*status\(404\)\.json\(\{ error: 'not_found' \}\)/);
});

test('input-dossier implementation source has been removed from the repository', () => {
  const graph = runtimeRequireGraph('server/index.js');
  const forbidden = [
    'server/routes/inputDossiers.js',
    'server/routes/masterData.js',
    'server/repositories/InputDossierRepository.js',
    'server/repositories/MerchandiseHierarchyRepository.js',
    'server/repositories/dashboard/nccDocsAggregateRepository.js',
    'server/services/inputDossierImporter.js',
    'server/services/InputDossierNotificationService.js',
    'server/services/InputDossierWorkspaceProvider.js',
    'server/services/LegacyInputDossierPolicyService.js',
    'server/services/MerchandiseHierarchyService.js',
    'server/services/dashboard/nccDocsAggregateService.js',
    'server/routes/uploads.js',
    'server/services/xlsxImporter.js',
    'server/services/fullReportImporter.js',
    'server/services/DashboardService.js',
    'server/repositories/DashboardRepository.js',
  ];
  forbidden.forEach((file) => {
    assert.equal(fs.existsSync(path.join(root, file)), false, file);
    assert.equal(graph.includes(file), false, file);
  });
  assert.ok(graph.includes('server/routes/evaluations.js'));
  assert.ok(graph.includes('server/services/EvaluationWorkspaceProvider.js'));
});

test('workspace and dashboard composition is evaluation-only', () => {
  const workspaceRoute = read('server/routes/workspace.js');
  const workspaceService = read('server/services/WorkspaceService.js');
  const dashboardRoute = read('server/routes/dashboard.js');
  const statistics = read('server/services/dashboard/statisticalDashboardService.js');

  assert.doesNotMatch(workspaceRoute, /InputDossier|INPUT_DOSSIER/);
  assert.doesNotMatch(workspaceService, /INPUT_DOSSIER/);
  assert.doesNotMatch(dashboardRoute, /NccDocs|ncc-docs|services\/DashboardService|new DashboardService|DashboardRepository/);
  assert.doesNotMatch(statistics, /nccDocs|input_dossiers|Hồ sơ đầu vào/);
});

test('notification runtime is evaluation-only', () => {
  const notifications = read('server/services/NotificationService.js');
  const notificationRepository = read('server/repositories/NotificationRepository.js');

  assert.doesNotMatch(notifications, /INPUT_DOSSIER|inputDossier|dossier_id/);
  assert.doesNotMatch(notificationRepository, /inputDossier|input_dossiers/);
});

test('evaluation-only runtime keeps only upload boundaries owned by retained modules', () => {
  const evaluations = read('server/routes/evaluations.js');
  const suppliers = read('server/routes/suppliers.js');
  const questions = read('server/routes/questionTemplates.js');
  const authorization = read('server/routes/authorizationAdmin.js');

  assert.match(evaluations, /\/rounds\/:roundNo\/attachments/);
  assert.match(suppliers, /\/import-excel/);
  assert.match(questions, /\/imports\/preview/);
  assert.match(authorization, /personnel-import\/batches\/preview/);
});

test('active policy, authorization and audit catalogs expose no input-dossier behavior', () => {
  const policyCatalog = read('server/authorization/policyCatalog.js');
  const policyService = read('server/services/PolicyService.js');
  const authorizationAdmin = read('server/services/AuthorizationAdminService.js');
  const compatibilityMap = read('server/audit/compatibilityMap.js');
  const auditMiddleware = read('server/middleware/audit.js');
  const accessLog = read('server/observability/accessLog.js');

  assert.doesNotMatch(policyCatalog, /INPUT_DOSSIER|input_dossiers/);
  assert.doesNotMatch(policyService, /INPUT_APPROVAL|resourceType === 'INPUT_DOSSIER'/);
  assert.doesNotMatch(authorizationAdmin, /workflowType: 'INPUT_DOSSIER'|INPUT_DOSSIER\.(?:READ|WRITE|APPROVE)/);
  assert.doesNotMatch(compatibilityMap, /INPUT_DOSSIER/);
  assert.doesNotMatch(auditMiddleware, /input-dossiers|dossier\.(?:created|updated|review|cancelled)/);
  assert.doesNotMatch(accessLog, /INPUT_DOSSIER/);
});

test('normal database startup leaves schema authority to numbered migrations', () => {
  const database = read('server/db.js');
  const activeStatements = database.slice(database.indexOf('const stmts = {'));

  assert.doesNotMatch(database, /function runCompatibilityAdapter/);
  assert.doesNotMatch(database, /runCompatibilityAdapter\(/);
  assert.doesNotMatch(database, /runBatchSql\(baselineSql\)/);
  assert.match(database, /migrateDatabase\(db,/);
  assert.match(database, /runStartupDataSeeds\(\)/);
  assert.doesNotMatch(activeStatements, /input_dossier/);
});

test('active source has no input-dossier permission or database compatibility constants', () => {
  assert.doesNotMatch(read('server/authorization/permissionCatalog.js'), /INPUT_DOSSIER/);
  assert.doesNotMatch(read('server/db.js'), /InputDossier|input_dossier/);
});

test('database runtime has no legacy upload, summary-dashboard or threshold statements', () => {
  const database = read('server/db.js');
  const activeStatements = database.slice(database.indexOf('const stmts = {'));
  const adminRoute = read('server/routes/admin.js');
  const defaults = read('database/seeds/defaults.sql');

  assert.doesNotMatch(activeStatements, /insertUploadLog|insertNccDoc|insertNccEval|listUploads|deleteUpload/);
  assert.doesNotMatch(activeStatements, /monthly_overview|ncc_documents_summary|lab_tests_summary|qc_warehouse_summary/);
  assert.doesNotMatch(activeStatements, /getThreshold|listThresholds/);
  assert.doesNotMatch(adminRoute, /router\.get\('\/thresholds'/);
  assert.doesNotMatch(defaults, /ncc_docs\.overall|qc_warehouse\.overall|lab_tests\.overall|kph_incidents\.overall/);
  assert.doesNotMatch(adminRoute, /'ncc_documents'|'upload_log'/);
  assert.match(adminRoute, /'evaluation_rounds'/);
  assert.match(adminRoute, /'schema_migrations'/);
});
