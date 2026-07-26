const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const express = require('express');
const cookieParser = require('cookie-parser');

const root = path.resolve(__dirname, '..');
const outputDir = path.join(root, 'artifacts', 'baseline');
const qaDir = path.join(outputDir, '.qa');
fs.mkdirSync(outputDir, { recursive: true });
fs.mkdirSync(qaDir, { recursive: true });

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function writeJson(name, value) {
  fs.writeFileSync(path.join(outputDir, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function lineNumber(source, index) {
  return source.slice(0, index).split('\n').length;
}

function command(commandName, args = []) {
  return execFileSync(commandName, args, { cwd: root, encoding: 'utf8' }).trim();
}

function walkFiles(dir, options = {}) {
  const files = [];
  const skipNames = new Set(options.skipNames || []);
  if (!fs.existsSync(dir)) return files;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (skipNames.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  return files;
}

function summarizeFiles(files) {
  let bytes = 0;
  for (const file of files) {
    try { bytes += fs.statSync(file).size; } catch {}
  }
  return { count: files.length, bytes };
}

function gitLines(args) {
  const gitBin = process.env.GIT_BIN || 'git';
  const result = command(gitBin, args);
  return result ? result.split(/\r?\n/) : [];
}

function environmentEvidence() {
  const gitStatus = gitLines(['status', '--short', '--branch']);
  return {
    captured_at: new Date().toISOString(),
    branch: command(process.env.GIT_BIN || 'git', ['branch', '--show-current']),
    commit_sha: command(process.env.GIT_BIN || 'git', ['rev-parse', 'HEAD']),
    git_status: gitStatus,
    worktree_clean_before_run00_outputs: gitStatus.length === 1 && /^## /.test(gitStatus[0]),
    runtime: {
      node: process.version,
      npm: process.env.RUN00_NPM_VERSION || 'not-captured',
      platform: process.platform,
      os_type: os.type(),
      os_release: os.release(),
      architecture: os.arch(),
    },
  };
}

function packageSafetyEvidence() {
  const tracked = gitLines(['ls-files']);
  const files = walkFiles(root, { skipNames: ['node_modules', '.git', '.run00-node20', '.run00-npm-cache'] });
  const normalize = (file) => path.relative(root, file).replace(/\\/g, '/');
  const categories = {
    env_files: files.filter((file) => /^\.env(?:\.|$)/.test(path.basename(file))),
    database_files: files.filter((file) => /\.(?:db|sqlite|sqlite3)$/i.test(file)),
    wal_shm_files: files.filter((file) => /-(?:wal|shm)$/i.test(file)),
    backup_files: files.filter((file) => /\.(?:bak|backup)$/i.test(file) || /[\\/](?:backup|backups)[\\/]/i.test(file)),
    log_files: files.filter((file) => /\.log$/i.test(file) || /[\\/]logs?[\\/]/i.test(file)),
    upload_files: files.filter((file) => /[\\/]uploads?[\\/]/i.test(file) || /[\\/]data[\\/]evaluation-attachments[\\/]/i.test(file)),
    report_artifacts: files.filter((file) => /[\\/]data[\\/]report-exports[\\/]/i.test(file)),
  };
  const unsafeTracked = tracked.filter((file) => (
    /(^|\/)(?:\.env($|\.)|node_modules\/|uploads?\/|logs?\/|backups?\/|data\/(?:report-exports|evaluation-attachments)\/)/i.test(file)
      || /\.(?:db|sqlite|sqlite3|db-wal|db-shm|wal|shm|log|bak|backup)$/i.test(file)
  ));
  const evidence = {
    policy: 'Counts and sizes only. No env values, database contents, upload names, log contents, OTP, or PII were read.',
    git_directory: summarizeFiles(walkFiles(path.join(root, '.git'))),
    node_modules: summarizeFiles(walkFiles(path.join(root, 'node_modules'))),
    categories: {},
    tracked_unsafe_category_summary: {
      env_or_example: unsafeTracked.filter((file) => /(^|\/)\.env(?:\.|$)/i.test(file)).length,
      evaluation_attachments: unsafeTracked.filter((file) => /(^|\/)data\/evaluation-attachments\//i.test(file)).length,
      other: unsafeTracked.filter((file) => !/(^|\/)(?:\.env(?:\.|$)|data\/evaluation-attachments\/)/i.test(file)).length,
    },
    tracked_env_example_is_documentation_only: unsafeTracked.includes('.env.example'),
  };
  for (const [name, categoryFiles] of Object.entries(categories)) {
    evidence.categories[name] = {
      ...summarizeFiles(categoryFiles),
      paths_redacted: categoryFiles.length > 0,
      tracked_count: categoryFiles.filter((file) => tracked.includes(normalize(file))).length,
    };
  }
  return evidence;
}

function migrationEvidence(packageSafety) {
  const schema = read('migrations/0001_current_schema.sql');
  const dbBootstrap = read('server/db.js');
  const tables = Array.from(schema.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-zA-Z0-9_]+)/g), (match) => match[1]);
  const ensureFunctions = Array.from(dbBootstrap.matchAll(/function\s+(ensure[A-Za-z0-9_]+)\s*\(/g), (match) => match[1]);
  return {
    source_of_truth: 'migrations/0001_current_schema.sql',
    schema_sha256: sha256(schema),
    bootstrap_file: 'server/db.js',
    bootstrap_sha256: sha256(dbBootstrap),
    schema_table_count: tables.length,
    schema_tables: tables,
    boot_sequence: Array.from(dbBootstrap.matchAll(/^\s+(ensure[A-Za-z0-9_]+)\([^;]*\);/gm), (match) => match[1]),
    ad_hoc_ensure_functions: ensureFunctions,
    uses_pragma_user_version: /PRAGMA\s+user_version/i.test(`${schema}\n${dbBootstrap}`),
    has_migration_ledger_table: /CREATE TABLE[^;]*(?:schema_migrations|migrations)/i.test(schema),
    migration_model: 'idempotent schema bootstrap plus imperative ensure*/ALTER/rebuild functions on process start',
    real_database_files_present: packageSafety.categories.database_files.count,
    real_database_contents_read: false,
    automated_evidence: 'test/migrations.test.js exercises idempotence and preservation on a synthetic legacy database',
  };
}

function routeInventory() {
  const indexSource = read('server/index.js');
  const mountByVariable = {};
  for (const match of indexSource.matchAll(/app\.use\(BASE \+ '([^']+)',\s*([A-Za-z0-9_]+)\)/g)) {
    mountByVariable[match[2]] = `/qlcl${match[1]}`;
  }
  const routerVariableByFile = {
    auth: 'authRouter', dashboard: 'dashboardRouter', admin: 'adminRouter',
    evaluations: 'evaluationsRouter', suppliers: 'suppliersRouter', questionTemplates: 'questionTemplatesRouter',
    reportTemplates: 'reportTemplatesRouter', reportExports: 'reportExportsRouter',
  };
  const routesDir = path.join(root, 'server', 'routes');
  const routeFiles = fs.readdirSync(routesDir).filter((name) => name.endsWith('.js')).sort();
  const routes = [];
  const modulePolicies = [];
  for (const fileName of routeFiles) {
    const moduleName = path.basename(fileName, '.js');
    const relativeFile = `server/routes/${fileName}`;
    const source = read(relativeFile);
    const lines = source.split(/\r?\n/);
    const moduleGuards = Array.from(source.matchAll(/router\.use\(([^)]*)\)/g), (match) => match[1].split(',').map((item) => item.trim()).filter(Boolean));
    modulePolicies.push({ module: moduleName, file: relativeFile, guards: moduleGuards.flat() });
    for (let i = 0; i < lines.length; i += 1) {
      const start = lines[i].match(/router\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]\s*,(.*)$/);
      if (!start) continue;
      let end = i + 1;
      while (end < lines.length && !/^\s*router\.(?:get|post|put|patch|delete)\(/.test(lines[end]) && !/^\s*module\.exports/.test(lines[end])) end += 1;
      const block = lines.slice(i, end).join('\n');
      const explicitGuards = ['requireAuth', 'requireInternal', 'requireAdmin', 'requireRole', 'canEditEvaluation']
        .filter((guard) => start[3].includes(guard));
      const scopeChecks = ['visibleTicketOrResponse', 'canAccessEvaluationTicket']
        .filter((guard) => block.includes(guard));
      const method = start[1].toUpperCase();
      const routePath = start[2];
      const mount = mountByVariable[routerVariableByFile[moduleName]] || null;
      const action = method === 'GET' ? 'read' : (method === 'POST' ? 'create-or-command' : (method === 'DELETE' ? 'delete-or-deactivate' : 'update'));
      routes.push({
        module: moduleName,
        file: relativeFile,
        line: i + 1,
        method,
        route_path: routePath,
        endpoint: mount ? `${mount}${routePath === '/' ? '' : routePath}` : routePath,
        action,
        module_guards: moduleGuards.flat(),
        explicit_guards: explicitGuards,
        scope_checks: scopeChecks,
        machine_readable_policy_metadata: false,
      });
    }
  }
  const appSource = read('public/app.js');
  const frontendGuardNames = Array.from(new Set(Array.from(appSource.matchAll(/function\s+((?:can|is)[A-Z][A-Za-z0-9_]*)\s*\(/g), (match) => match[1]))).sort();
  const frontendGuardCalls = [];
  appSource.split(/\r?\n/).forEach((line, index) => {
    const names = frontendGuardNames.filter((name) => line.includes(`${name}(`));
    if (names.length) frontendGuardCalls.push({ file: 'public/app.js', line: index + 1, guards: names });
  });
  return {
    generated_from: routeFiles.map((name) => `server/routes/${name}`).concat(['server/index.js', 'public/app.js', 'server/domain/roles.js']),
    roles: Array.from(read('server/domain/roles.js').matchAll(/^\s+([A-Z_]+):\s*'([^']+)'/gm), (match) => ({ key: match[1], value: match[2] })),
    route_count: routes.length,
    module_policies: modulePolicies,
    routes,
    frontend_guard_functions: frontendGuardNames,
    frontend_guard_call_sites: frontendGuardCalls,
    caveat: 'Scope checks are static call-site evidence; absence of a keyword is not proof of authorization.',
  };
}

function navigationEvidence() {
  const html = read('public/index.html');
  const app = read('public/app.js');
  const routesBlock = app.match(/const ROUTES = \{([\s\S]*?)\n\s*\};/)?.[1] || '';
  const routes = Array.from(routesBlock.matchAll(/(?:'([^']+)'|([A-Za-z0-9_-]+)):\s*'([^']+)'/g), (match) => ({ tab: match[1] || match[2], route: match[3] }));
  const dataTabs = Array.from(new Set(Array.from(html.matchAll(/data-tab="([^"]+)"/g), (match) => match[1]))).sort();
  const routeTabs = Array.from(new Set(Array.from(html.matchAll(/data-route-tab="([^"]+)"/g), (match) => match[1]))).sort();
  const buttons = [];
  for (const match of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    const attrs = match[1];
    const id = attrs.match(/\bid="([^"]+)"/)?.[1] || null;
    const label = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    const declarative = /data-(?:tab|route-tab|admin-route|eval-sort|action)=|onclick=/.test(attrs);
    const submit = /type="submit"/.test(attrs);
    const referencedById = id ? app.includes(`$('${id}')`) || app.includes(`getElementById('${id}')`) || app.includes(`#${id}`) : false;
    const orphanCandidate = !declarative && !submit && !referencedById;
    buttons.push({ line: lineNumber(html, match.index), id, label, declarative, submit, referenced_by_id: referencedById, orphan_candidate: orphanCandidate });
  }
  const duplicateIds = [];
  const ids = Array.from(html.matchAll(/\bid="([^"]+)"/g), (match) => match[1]);
  for (const id of new Set(ids)) if (ids.filter((value) => value === id).length > 1) duplicateIds.push(id);
  return {
    generated_from: ['public/index.html', 'public/app.js'],
    desktop_sidebar_tabs: dataTabs,
    route_tabs: routeTabs,
    route_map: routes,
    mobile_primary_tabs: Array.from(app.match(/const MOBILE_PRIMARY_TABS = \[([^\]]+)\]/)?.[1]?.matchAll(/'([^']+)'/g) || [], (match) => match[1]),
    module_tabs: Array.from(app.match(/const ASSESSMENT_MODULE_TABS = \[([^\]]+)\]/)?.[1]?.matchAll(/'([^']+)'/g) || [], (match) => match[1]),
    button_count: buttons.length,
    buttons,
    orphan_candidates: buttons.filter((button) => button.orphan_candidate),
    duplicate_dom_ids: duplicateIds,
    viewport_modes: { desktop_sidebar: true, mobile_bottom_nav: true, breakpoint_px: 768 },
    caveat: 'Orphan status is a static candidate when no ID reference, declarative route/action, inline handler, or submit contract is visible.',
  };
}

function observabilityOtpEvidence() {
  const serverFiles = walkFiles(path.join(root, 'server')).filter((file) => file.endsWith('.js'));
  const logCalls = [];
  const accessActions = new Set();
  let requestIdReferences = 0;
  let redactionReferences = 0;
  for (const file of serverFiles) {
    const relative = path.relative(root, file).replace(/\\/g, '/');
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/logger\.(debug|info|warn|error)\s*\(/g)) logCalls.push({ file: relative, line: lineNumber(source, match.index), level: match[1] });
    for (const match of source.matchAll(/action:\s*(?:'([^']+)'|"([^"]+)")/g)) accessActions.add(match[1] || match[2]);
    requestIdReferences += (source.match(/x-request-id|requestId|correlationId/gi) || []).length;
    redactionReferences += (source.match(/\bredact(?:ion|ed)?\b|maskSensitive|sanitizeLog/gi) || []).length;
  }
  const auth = read('server/routes/auth.js');
  const otp = read('server/services/otp.js');
  const frontend = read('public/app.js');
  return {
    logging: {
      sink: 'process.stdout for debug/info; process.stderr for warn/error',
      format: 'timestamp level joined arbitrary parts; objects JSON.stringify without field policy',
      call_count: logCalls.length,
      calls: logCalls,
      access_log_sink: 'SQLite access_log via server/db.js::logAccess',
      access_actions: Array.from(accessActions).sort(),
      workflow_history_sinks: ['workflow_history', 'supplier_master_history'],
      workflow_payload_fields: ['comment', 'payload_json', 'previous_value', 'new_value'],
      sensitive_payload_risk_fields: ['email', 'ip', 'ua', 'contact_email', 'comment', 'payload_json', 'details'],
      request_id_reference_count: requestIdReferences,
      redaction_policy_reference_count: redactionReferences,
    },
    otp: {
      flags: Array.from(new Set(Array.from(`${auth}\n${otp}`.matchAll(/process\.env\.([A-Z0-9_]+)/g), (match) => match[1]).filter((name) => /OTP|REDIS|NODE_ENV/.test(name)))).sort(),
      default_ttl_seconds: 300,
      default_max_attempts: 5,
      production_storage: 'Redis key prefix qlcl:otp:, JSON payload contains email/code/attempts/createdAt',
      test_storage: 'in-memory Map only when USE_IN_MEMORY_OTP=true and NODE_ENV!=production',
      api_endpoints: ['/qlcl/api/auth/request-otp', '/qlcl/api/auth/verify-otp'],
      evidence_fields: ['sessionId', 'emailDelivery', 'devCode when exposure flags are enabled'],
      ui_evidence: {
        displays_dev_code: frontend.includes('r.data.devCode'),
        auto_fills_dev_code: frontend.includes("$('otp').value = r.data.devCode"),
      },
      leakage_gap: /SHOW_TEST_OTP/.test(auth) && !/NODE_ENV\s*!==\s*'production'/.test(auth.match(/function shouldExposeOtpForHostedTest[\s\S]*?\n\}/)?.[0] || ''),
      secret_or_otp_values_in_evidence: false,
    },
  };
}

function questionReportMchEvidence(routeEvidence) {
  const reporting = read('server/services/reporting.js');
  const app = read('public/app.js');
  const merchandising = require('../server/domain/merchandising');
  const reportTypes = Array.from(reporting.match(/const REPORT_TYPE_CODES = Object\.freeze\(\[([\s\S]*?)\]\);/)?.[1]?.matchAll(/'([^']+)'/g) || [], (match) => match[1]);
  const frontendHtml = read('public/index.html');
  const operationalFilterMarkup = frontendHtml.match(/<select\s+id="report-type-filter"[^>]*>([\s\S]*?)<\/select>/)?.[1] || '';
  const templateEditorMarkup = frontendHtml.match(/<select\s+id="rt-type"[^>]*>([\s\S]*?)<\/select>/)?.[1] || '';
  const reportTypeOptionPattern = /<option value="(WORKING_MINUTES|ROUND1_RESULT|ROUND2_RESULT|INTERNAL|NCC)">/g;
  const frontendReportTypes = Array.from(new Set(Array.from(operationalFilterMarkup.matchAll(reportTypeOptionPattern), (match) => match[1])));
  const frontendTemplateEditorTypes = Array.from(new Set(Array.from(templateEditorMarkup.matchAll(reportTypeOptionPattern), (match) => match[1])));
  const mchEntries = Object.entries(merchandising.MCH3_BY_MCH2).flatMap(([mch2, values]) => values.map((mch3) => ({ mch2, mch3 })));
  const nameCounts = new Map();
  mchEntries.forEach(({ mch3 }) => nameCounts.set(mch3, (nameCounts.get(mch3) || 0) + 1));
  return {
    question_lifecycle_routes: routeEvidence.routes.filter((route) => route.module === 'questionTemplates'),
    report_template_lifecycle_routes: routeEvidence.routes.filter((route) => route.module === 'reportTemplates'),
    report_export_routes: routeEvidence.routes.filter((route) => route.module === 'reportExports' || (route.module === 'evaluations' && route.route_path.includes('reports'))),
    report_types_backend: reportTypes,
    report_types_frontend_filter: frontendReportTypes,
    report_types_frontend_template_editor: frontendTemplateEditorTypes,
    backend_types_absent_from_frontend_filter: reportTypes.filter((type) => !frontendReportTypes.includes(type)),
    legacy_aliases: {
      BAO_CAO_GUI_NCC: 'ROUND1_RESULT',
      BAO_CAO_NOI_BO: 'ROUND2_RESULT',
    },
    export_storage_contract: {
      record: 'file_path is the relative generated file name',
      persisted_bytes: false,
      history_download: 'rejects non-absolute file_path with 410 export_not_stored',
    },
    mch: {
      backend_source: 'server/domain/merchandising.js',
      backend_sha256: sha256(read('server/domain/merchandising.js')),
      frontend_source: 'public/app.js duplicate constant',
      frontend_sha256: sha256(app),
      entry_count: mchEntries.length,
      entries: mchEntries,
      duplicate_mch3_names: Array.from(nameCounts.entries()).filter(([, count]) => count > 1).map(([name, count]) => ({ name, count })),
    },
  };
}

async function startAuditApp() {
  const evaluationsRouter = require('../server/routes/evaluations');
  const reportTemplatesRouter = require('../server/routes/reportTemplates');
  const reportExportsRouter = require('../server/routes/reportExports');
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/evaluations', evaluationsRouter);
  app.use('/report-templates', reportTemplatesRouter);
  app.use('/report-exports', reportExportsRouter);
  app.use((error, req, res, next) => {
    res.status(error.status || 500).json({ error: error.code || 'internal_error' });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

function insertSyntheticFixtures(db) {
  const actor = 'run00-admin@example.invalid';
  db.prepare(`
    INSERT INTO users (email, is_admin, role, is_active, display_name)
    VALUES (?, 1, 'Admin', 1, 'RUN00 Synthetic Admin')
    ON CONFLICT(email) DO UPDATE SET is_admin=1, role='Admin', is_active=1, display_name='RUN00 Synthetic Admin'
  `).run(actor);
  const supplier = db.prepare(`
    INSERT INTO supplier_master (supplier_code, supplier_name, status, source_type)
    VALUES ('RUN00-NCC', 'RUN00 Synthetic Supplier', 'ACTIVE', 'MANUAL')
  `).run();
  const template = db.prepare("SELECT id FROM question_templates WHERE template_code='BM01'").get();
  const insertTicket = db.prepare(`
    INSERT INTO evaluation_tickets (
      ticket_code, supplier_id, supplier_code, supplier_name, evaluation_type, template_id,
      facility_type, supplier_scale, planned_date, actual_evaluation_date, current_status,
      current_round_no, completed_round, score_percent, grade_code, result_label,
      supplier_introduction, assigned_specialist_id, created_by, updated_at
    ) VALUES (
      @ticket_code, @supplier_id, 'RUN00-NCC', @supplier_name, 'Synthetic baseline', @template_id,
      'CHUNG', 'LARGE', '2026-07-01', @actual_date, @status,
      @current_round_no, @completed_round, @score_percent, @grade_code, @result_label,
      @supplier_introduction, @actor, @actor, @updated_at
    )
  `);
  const missingRound = insertTicket.run({
    ticket_code: 'RUN00-MISSING-ROUND', supplier_id: supplier.lastInsertRowid, supplier_name: 'RUN00 Missing Round', template_id: template.id,
    actual_date: null, status: 'Khởi tạo', current_round_no: 1, completed_round: 1, score_percent: null, grade_code: null,
    result_label: null, supplier_introduction: null, actor, updated_at: '2026-07-01 01:00:00',
  });
  const missingData = insertTicket.run({
    ticket_code: 'RUN00-MISSING-DATA', supplier_id: supplier.lastInsertRowid, supplier_name: 'RUN00 Missing Data', template_id: template.id,
    actual_date: null, status: 'Đang xử lý', current_round_no: 1, completed_round: 1, score_percent: 75, grade_code: 'B',
    result_label: 'Synthetic partial', supplier_introduction: null, actor, updated_at: '2026-07-01 02:00:00',
  });
  const complete = insertTicket.run({
    ticket_code: 'RUN00-COMPLETE', supplier_id: supplier.lastInsertRowid, supplier_name: 'RUN00 Complete', template_id: template.id,
    actual_date: '2026-07-02', status: 'Hoàn thành', current_round_no: 2, completed_round: 2, score_percent: 92, grade_code: 'A',
    result_label: 'Synthetic pass', supplier_introduction: 'Synthetic supplier introduction; contains no PII.', actor, updated_at: '2026-07-01 03:00:00',
  });
  const insertRound = db.prepare(`
    INSERT INTO evaluation_rounds (
      ticket_id, round_no, assessment_code, assessment_date, evaluator_id, attendees_json,
      status, completed_at, total_score, final_result, classification, locked_at, locked_by
    ) VALUES (?, ?, ?, ?, ?, ?, 'Hoàn thành', ?, ?, ?, ?, ?, ?)
  `);
  insertRound.run(missingData.lastInsertRowid, 1, 'RUN00-MISSING-DATA-R1', '2026-07-01', actor, '[]', '2026-07-01', 75, 'Synthetic partial', 'B', '2026-07-01', actor);
  insertRound.run(complete.lastInsertRowid, 1, 'RUN00-COMPLETE-R1', '2026-07-02', actor, JSON.stringify([{ name: 'Synthetic QA', opening: true, closing: true }]), '2026-07-02', 75, 'Synthetic partial', 'B', '2026-07-02', actor);
  insertRound.run(complete.lastInsertRowid, 2, 'RUN00-COMPLETE-R2', '2026-07-03', actor, JSON.stringify([{ name: 'Synthetic QA', opening: true, closing: true }]), '2026-07-03', 92, 'Synthetic pass', 'A', '2026-07-03', actor);
  return {
    actor,
    tickets: {
      complete: { id: Number(complete.lastInsertRowid), code: 'RUN00-COMPLETE', rounds: [1, 2], missing_data: false },
      missing_data: { id: Number(missingData.lastInsertRowid), code: 'RUN00-MISSING-DATA', rounds: [1], missing_data: true },
      missing_round: { id: Number(missingRound.lastInsertRowid), code: 'RUN00-MISSING-ROUND', rounds: [], missing_data: false },
    },
  };
}

async function responseEvidence(response, base) {
  const buffer = Buffer.from(await response.arrayBuffer());
  let error = null;
  if (!response.ok && /json/i.test(response.headers.get('content-type') || '')) {
    try { error = JSON.parse(buffer.toString('utf8')).error || null; } catch {}
  }
  return {
    ...base,
    status: response.status,
    error,
    request_id: response.headers.get('x-request-id'),
    artifact_sha256: response.ok ? sha256(buffer) : null,
    bytes: buffer.length,
    content_type: response.headers.get('content-type'),
    export_id: Number(response.headers.get('x-export-id')) || null,
    buffer,
  };
}

async function runReportMatrix() {
  const runtimeDir = path.join(outputDir, '.runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  const dbPath = path.join(runtimeDir, 'run00-synthetic.db');
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(`${dbPath}${suffix}`, { force: true }); } catch {}
  }
  process.env.DB_PATH = dbPath;
  process.env.DATA_DIR = runtimeDir;
  process.env.REPORT_EXPORT_DIR = path.join(runtimeDir, 'report-exports');
  process.env.ATTACHMENT_DIR = path.join(runtimeDir, 'attachments');
  process.env.JWT_SECRET = 'run00-synthetic-jwt-secret';
  process.env.NODE_ENV = 'test';
  process.env.USE_IN_MEMORY_OTP = 'true';
  const { db } = require('../server/db');
  const fixtures = insertSyntheticFixtures(db);
  const { signToken } = require('../server/middleware/auth');
  const token = signToken({ email: fixtures.actor, isAdmin: true, role: 'Admin', displayName: 'RUN00 Synthetic Admin' }, 3600);
  const headers = { Cookie: `qlcl_token=${token}`, 'Content-Type': 'application/json' };
  const { server, origin } = await startAuditApp();
  const matrix = [];
  const negativeCases = [];
  const reportTypes = ['INTERNAL', 'NCC', 'WORKING_MINUTES', 'ROUND1_RESULT', 'ROUND2_RESULT'];
  const formats = [
    { format: 'HTML', suffix: 'export-print', extension: 'html' },
    { format: 'PDF', suffix: 'export-pdf', extension: 'pdf' },
    { format: 'XLSX', suffix: 'export-excel', extension: 'xlsx' },
  ];
  try {
    for (const reportType of reportTypes) {
      const roundNo = reportType === 'ROUND2_RESULT' || reportType === 'INTERNAL' ? 2 : 1;
      const template = db.prepare('SELECT * FROM report_templates WHERE report_type=? AND active=1 ORDER BY id LIMIT 1').get(reportType);
      const previewEndpoint = `/report-templates/${template.id}/preview`;
      const preview = await responseEvidence(await fetch(`${origin}${previewEndpoint}`, { headers: { Cookie: `qlcl_token=${token}` } }), {
        id: template.id, operation: 'preview', download_mode: 'preview', report_type: reportType,
        ticket: 'latest-visible-global', round: null, endpoint: previewEndpoint,
      });
      matrix.push(Object.fromEntries(Object.entries(preview).filter(([key]) => key !== 'buffer')));
      for (const descriptor of formats) {
        const endpoint = `/evaluations/${fixtures.tickets.complete.code}/reports/${descriptor.suffix}`;
        const immediate = await responseEvidence(await fetch(`${origin}${endpoint}`, {
          method: 'POST', headers, body: JSON.stringify({ report_type: reportType, round_no: roundNo }),
        }), {
          id: null, operation: descriptor.format, download_mode: 'immediate', report_type: reportType,
          ticket: fixtures.tickets.complete.code, round: roundNo, endpoint,
        });
        immediate.id = immediate.export_id;
        matrix.push(Object.fromEntries(Object.entries(immediate).filter(([key]) => key !== 'buffer')));
        if (immediate.status === 200 && ['PDF', 'XLSX'].includes(descriptor.format)) {
          fs.writeFileSync(path.join(qaDir, `${reportType}.${descriptor.extension}`), immediate.buffer);
        }
        if (immediate.export_id) {
          const historyEndpoint = `/report-exports/${immediate.export_id}/download`;
          const history = await responseEvidence(await fetch(`${origin}${historyEndpoint}`, { headers: { Cookie: `qlcl_token=${token}` } }), {
            id: immediate.export_id, operation: descriptor.format, download_mode: 'history', report_type: reportType,
            ticket: fixtures.tickets.complete.code, round: roundNo, endpoint: historyEndpoint,
          });
          matrix.push(Object.fromEntries(Object.entries(history).filter(([key]) => key !== 'buffer')));
        }
      }
    }
    for (const [fixtureName, fixture] of Object.entries(fixtures.tickets)) {
      if (fixtureName === 'complete') continue;
      for (const reportType of reportTypes) {
        const roundNo = reportType === 'ROUND2_RESULT' || reportType === 'INTERNAL' ? 2 : 1;
        const endpoint = `/evaluations/${fixture.code}/reports/export-print`;
        const result = await responseEvidence(await fetch(`${origin}${endpoint}`, {
          method: 'POST', headers, body: JSON.stringify({ report_type: reportType, round_no: roundNo }),
        }), {
          id: null, fixture: fixtureName, operation: 'HTML', download_mode: 'immediate', report_type: reportType,
          ticket: fixture.code, round: roundNo, endpoint,
        });
        result.id = result.export_id;
        negativeCases.push(Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'buffer')));
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
    db.close();
  }
  const exportRecords = matrix.filter((item) => item.download_mode === 'immediate' && item.export_id).length;
  const historyFailures = matrix.filter((item) => item.download_mode === 'history' && item.status !== 200).length;
  writeJson('synthetic-fixtures.json', {
    fixture_policy: 'Synthetic identifiers and content only; no production database was queried.',
    report_types: reportTypes,
    fixtures: fixtures.tickets,
  });
  writeJson('report-execution-matrix.json', {
    generated_at: new Date().toISOString(),
    fixture: fixtures.tickets.complete.code,
    rows: matrix,
    summary: {
      preview_count: matrix.filter((item) => item.operation === 'preview').length,
      immediate_export_count: exportRecords,
      immediate_success_count: matrix.filter((item) => item.download_mode === 'immediate' && item.status === 200).length,
      history_attempt_count: matrix.filter((item) => item.download_mode === 'history').length,
      history_failure_count: historyFailures,
      request_id_present_count: matrix.filter((item) => item.request_id).length,
    },
    negative_fixture_rows: negativeCases,
    user_reported_two_failures: {
      identified: false,
      blocker: 'No issue ID, screenshot, report label, ticket, round, timestamp, endpoint, or user-provided reproduction identifies the two user-reported reports.',
      do_not_infer: ['INTERNAL', 'NCC'],
    },
  });
}

async function main() {
  const environment = environmentEvidence();
  const packageSafety = packageSafetyEvidence();
  const authorization = routeInventory();
  const navigation = navigationEvidence();
  const observabilityOtp = observabilityOtpEvidence();
  writeJson('environment.json', environment);
  writeJson('package-safety-inventory.json', packageSafety);
  writeJson('migration-state.json', migrationEvidence(packageSafety));
  writeJson('authorization-inventory.json', authorization);
  writeJson('navigation-action-inventory.json', navigation);
  writeJson('observability-otp-inventory.json', observabilityOtp);
  writeJson('question-report-mch-inventory.json', questionReportMchEvidence(authorization));
  await runReportMatrix();
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
