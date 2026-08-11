const path = require('node:path');
const fs = require('node:fs');
const XLSX = require('xlsx');
const { test, expect } = require('../fixtures/uatTest');
const { LoginPage } = require('../pages/LoginPage');
const { AppShell } = require('../pages/AppShell');

const PERSONNEL_HEADERS = [
  'email', 'display_name', 'active', 'role_codes', 'valid_from', 'valid_until',
  'scope_type', 'scope_value', 'scope_effect',
];

const ADMIN_ROUTE_MATRIX = [
  { route: '/admin', module: null, ready: '#admin-dashboard' },
  { route: '/admin/users', module: 'authorization', pane: 'users', ready: '[data-testid="authorization-admin"]' },
  { route: '/admin/roles', module: 'authorization', pane: 'roles', ready: '[data-testid="authorization-admin"]' },
  { route: '/admin/personnel-import', module: 'personnel-import', ready: '[data-personnel-import-workflow]' },
  { route: '/admin/data-scopes', module: 'authorization', pane: 'scopes', ready: '[data-testid="authorization-admin"]' },
  { route: '/admin/approval-assignments', module: 'authorization', pane: 'approvals', ready: '[data-testid="authorization-admin"]' },
  { route: '/admin/question-templates', module: 'question-templates', ready: '#question-management-workspace-root' },
  { route: '/admin/report-templates', module: 'report-templates', ready: '#report-template-workspace' },
  { route: '/admin/scoring-policies', module: 'scoring-policies', ready: '#scoring-policy-workspace' },
  { route: '/admin/system-logs', module: 'system-logs', ready: '[data-testid="system-logs-view"]' },
];

function personnelImportWorkbook(rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['Hướng dẫn', 'Dữ liệu synthetic dành riêng cho UAT PROMPT-07.'],
  ]), 'Huong_dan');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    PERSONNEL_HEADERS,
    ...rows.map((row) => PERSONNEL_HEADERS.map((header) => row[header] ?? '')),
  ]), 'Nhan_su');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true });
}

test.describe('@smoke QLCL foundation', () => {
  test('login surface is reachable and carries UAT request context', async ({ page, uat }) => {
    const login = new LoginPage(page);
    await login.open(uat.config.baseUrl);
    await expect(page).toHaveTitle(/QLCL/);
    await expect(login.email).toBeVisible();

    const health = await page.request.get(`${uat.config.origin}/qlcl/api/health`, {
      headers: { 'X-UAT-Run-Id': uat.config.runId },
    });
    expect(health.ok()).toBeTruthy();
    expect(health.headers()['x-request-id']).toBeTruthy();
  });

  test('local synthetic admin authenticates and opens current core routes', async ({ page, uat }) => {
    test.skip(uat.config.mode !== 'local', 'Mutation-free remote modes only verify the login surface in RUN-04.');
    test.setTimeout(90_000);
    const login = new LoginPage(page);
    const app = new AppShell(page);
    await login.open(uat.config.baseUrl);
    await login.loginWithLocalScreenOtp(uat.config.adminEmail);
    await expect(page.locator('#degraded-auth-banner')).toBeVisible();
    await app.waitForSession(uat.config.adminEmail);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await app.waitForSession(uat.config.adminEmail);
    await expect(page.locator('#degraded-auth-banner')).toBeVisible();

    for (const endpoint of [
      '/qlcl/api/input-dossiers',
      '/qlcl/api/master-data/merchandise-hierarchy',
      '/qlcl/api/dashboard/ncc-docs?month=2026-06',
      '/qlcl/api/uploads',
      '/qlcl/api/admin/thresholds',
    ]) {
      const response = await page.request.get(endpoint);
      expect(response.status(), endpoint).toBe(404);
    }
    const removedUploadPost = await page.request.post('/qlcl/api/uploads/ncc-docs');
    expect(removedUploadPost.status()).toBe(404);

    await app.openSidebarRoute('nav-overview', 'overview-view');
    await expect(page.locator('#desktop-navigation [data-route-tab="overview"]')).toHaveCount(1);
    await expect(page.locator('#desktop-navigation [data-route-tab="ncc-docs"], #desktop-navigation [data-route-tab="ncc-eval"], #desktop-navigation [data-route-tab="qc-warehouse"], #desktop-navigation [data-route-tab="lab"], #desktop-navigation [data-route-tab="kph"]')).toHaveCount(0);
    await page.locator('#desktop-navigation [data-navigation-id="nav-evaluations"]').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('evaluations-view')).toBeVisible();
    await expect(page.locator('#breadcrumb-items')).toContainText('Phiếu đánh giá');

    const run06Fixture = await page.evaluate(async (runId) => {
      const suffix = runId.slice(0, 8).toUpperCase();
      const createEvaluation = async (payload) => {
        const response = await fetch('/qlcl/api/evaluations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        return { status: response.status, body: await response.json(), requestId: response.headers.get('x-request-id') };
      };
      const prior = await createEvaluation({
        supplier_code: `RUN06-${suffix}-A`, supplier_name: 'RUN-06 Synthetic Supplier A',
        tax_code: `TAX-${suffix}`, address: 'Synthetic supplier address',
        region: 'MB', province: 'Tỉnh Tuyên Quang', business_type: 'Tự sản xuất',
        snapshot_evaluation_address: 'Synthetic evaluation address',
        contact_name: 'Synthetic Contact', email: 'synthetic-supplier@example.test', phone: '0900000000',
        snapshot_product_name: 'Synthetic product',
        cmc_owner: 'RUN-06 CMC owner', cmc_head: 'RUN-06 CMC head',
        evaluation_type: 'Dinh ky', template: 'BM03', facility_type: 'CO_SO_NUOI_TRONG',
        supplier_scale: 'LARGE', planned_date: '2026-06-01', actual_evaluation_date: '2026-06-02',
        mch2: 'Thực phẩm công nghệ', mch3: 'Thực phẩm khô',
      });
      const noHistory = await createEvaluation({
        supplier_code: `RUN06-${suffix}-B`, supplier_name: 'RUN-06 Synthetic Supplier B',
        tax_code: `TAX-${suffix}-B`, address: 'Synthetic supplier address B',
        region: 'MB', province: 'Tỉnh Tuyên Quang', business_type: 'Tự sản xuất',
        contact_name: 'Synthetic Contact B', email: 'synthetic-supplier-b@example.test', phone: '0900000001',
        snapshot_evaluation_address: 'Synthetic evaluation address B',
        snapshot_product_name: 'Synthetic product B',
        cmc_owner: 'RUN-06 CMC owner', cmc_head: 'RUN-06 CMC head',
        evaluation_type: 'Dinh ky', template: 'BM04', facility_type: 'CHUNG',
        supplier_scale: 'SMALL', planned_date: '2026-07-01',
        mch2: 'Thực phẩm công nghệ', mch3: 'Thực phẩm khô',
      });
      return { prior, noHistory };
    }, uat.config.runId);
    expect(run06Fixture.prior.status).toBe(201);
    expect(run06Fixture.noHistory.status).toBe(201);
    expect(run06Fixture.prior.requestId).toBeTruthy();

    await page.evaluate(() => { window.location.hash = '/dashboard'; });
    await expect(page.locator('#view-overview')).toBeVisible();
    await page.locator('#month-picker').selectOption('2026-06');
    await expect(page.locator('#month-picker')).toHaveValue('2026-06');
    await expect(page.locator('#crumb-month')).toHaveCount(0);
    await expect(page.locator('#period-updated')).toHaveCount(0);
    await expect(page.locator('.statistics-titlebar')).toHaveCount(0);
    await expect(page.locator('#dashboard-statistics-tabs')).toHaveCount(0);
    await expect(page.locator('#module-navigation')).toBeHidden();
    await expect(page.locator('#module-navigation [data-route-tab]')).toHaveCount(0);
    await expect(page.locator('#statistics-kpi-cards .statistics-kpi-card')).toHaveCount(4);
    await expect(page.locator('#statistics-overview-charts')).toBeVisible();
    await expect(page.locator('#statistics-detail-charts')).toBeHidden();
    await expect(page).toHaveURL(/#\/dashboard\?periodType=MONTH&periodValue=2026-06$/);
    await page.evaluate(() => { window.location.hash = '/dashboard/ncc-evaluations?month=2026-06'; });
    await expect(page.locator('#view-overview')).toBeVisible();
    await expect(page.locator('#desktop-navigation [data-route-tab="overview"]')).toHaveClass(/active/);
    await expect(page.locator('#month-picker')).toHaveValue('2026-06');
    await expect(page).toHaveURL(/#\/dashboard\?periodType=MONTH&periodValue=2026-06$/);
    await page.locator('#dashboard-mode-detail').click();
    await expect(page.locator('#statistics-overview-charts')).toBeHidden();
    await expect(page.locator('#statistics-detail-charts')).toBeVisible();
    await expect(page.locator('#month-picker')).toHaveValue('2026-06');
    await expect(page).toHaveURL(/#\/dashboard\?periodType=MONTH&periodValue=2026-06$/);
    await page.locator('#dashboard-mode-overview').click();
    const currentDashboardPeriod = await page.evaluate(() => {
      const parts = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit' }).split('/');
      return `${parts[1]}-${parts[0]}`;
    });
    if (currentDashboardPeriod !== '2026-06') {
      await page.locator('#month-picker').selectOption(currentDashboardPeriod);
      await expect(page.locator('#month-picker')).toHaveValue(currentDashboardPeriod);
      await page.locator('#month-picker').selectOption('2026-06');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#mobile-period-controls')).toBeVisible();
    await expect(page.locator('#mobile-month-picker')).toHaveValue('2026-06');
    await expect(page.locator('.statistics-titlebar, #dashboard-statistics-tabs')).toHaveCount(0);
    const mobilePeriodTargets = await page.locator('#mobile-period-previous, #mobile-period-next, #mobile-month-picker').evaluateAll((nodes) => (
      nodes.map((node) => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }))
    ));
    expect(mobilePeriodTargets.every((target) => target.width >= 44 && target.height >= 44)).toBeTruthy();
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.evaluate(() => { window.location.hash = '/evaluations/new'; });
    await expect(page.locator('#view-evaluation-new')).toBeVisible();
    await page.locator('#new-eval-type').selectOption({ label: 'Đánh giá định kỳ' });
    const supplierLookup = page.locator('#new-supplier-select');
    const activeSupplierLookupResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname.endsWith('/qlcl/api/suppliers')
        && url.searchParams.get('q') === run06Fixture.prior.body.ticket.supplier.code;
    });
    await supplierLookup.fill(run06Fixture.prior.body.ticket.supplier.code);
    const supplierLookupResponse = await activeSupplierLookupResponse;
    expect(new URL(supplierLookupResponse.url()).searchParams.get('status')).toBe('ACTIVE');
    const priorOption = page.locator(`#new-supplier-options option[value^="${run06Fixture.prior.body.ticket.supplier.code}"]`).first();
    await expect(priorOption).toHaveCount(1);
    const priorLabel = await priorOption.getAttribute('value');
    await supplierLookup.fill(priorLabel);
    await supplierLookup.dispatchEvent('change');
    await expect(page.locator('#new-template')).toHaveValue('BM03');
    await expect(page.locator('#new-facility-type')).toHaveValue('CO_SO_NUOI_TRONG');
    await expect(page.locator('#new-supplier-scale')).toHaveValue('LARGE');

    await page.locator('#new-supplier-scale').selectOption('SMALL');
    await page.locator('#new-eval-type').selectOption({ label: 'Đánh giá đột xuất' });
    await expect(page.locator('#new-supplier-scale')).toHaveValue('SMALL');

    await supplierLookup.fill(run06Fixture.noHistory.body.ticket.supplier.code);
    const noHistoryOption = page.locator(`#new-supplier-options option[value^="${run06Fixture.noHistory.body.ticket.supplier.code}"]`).first();
    await expect(noHistoryOption).toHaveCount(1);
    const noHistoryLabel = await noHistoryOption.getAttribute('value');
    await supplierLookup.fill(noHistoryLabel);
    await supplierLookup.dispatchEvent('change');
    await expect(page.locator('#new-template')).toHaveValue('');
    await expect(page.locator('#new-facility-type')).toHaveValue('');
    await expect(page.locator('#new-supplier-scale')).toHaveValue('SMALL');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#new-template')).toBeVisible();
    await expect(page.locator('#new-facility-type')).toBeVisible();
    await expect(page.locator('#new-supplier-scale')).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.locator('#btn-form-reset').click();
    await expect(page.locator('#evaluation-score-after-save')).toBeHidden();
    await page.locator('#new-eval-type').selectOption({ label: 'Đánh giá định kỳ' });
    await supplierLookup.fill(run06Fixture.prior.body.ticket.supplier.code);
    const savedSupplierOption = page.locator(`#new-supplier-options option[value^="${run06Fixture.prior.body.ticket.supplier.code}"]`).first();
    await expect(savedSupplierOption).toHaveCount(1);
    const savedSupplierLabel = await savedSupplierOption.getAttribute('value');
    await supplierLookup.fill(savedSupplierLabel);
    await supplierLookup.dispatchEvent('change');
    await expect(page.locator('#new-template')).toHaveValue('BM03');
    await expect(page.locator('#new-production-address')).toHaveCount(0);
    await expect(page.locator('#new-evaluation-address')).toHaveValue('');
    await expect(page.locator('#new-mch2')).toHaveValue('');
    await expect(page.locator('#new-products')).toHaveValue('');
    await page.locator('#new-evaluation-address').fill('Synthetic evaluation address');
    await page.locator('#new-cmc-owner').fill('RUN-06 CMC owner');
    await page.locator('#new-cmc-head').fill('RUN-06 CMC head');
    await page.locator('#new-mch2').selectOption({ label: 'Thực phẩm công nghệ' });
    await page.locator('#new-mch3').selectOption({ label: 'Thực phẩm khô' });
    await page.locator('#new-products').fill('Synthetic product');
    await page.locator('#new-planned-date').fill('2026-08-01');
    await expect(page.locator('#new-method')).toHaveCount(0);

    const failEvaluationSave = async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'synthetic_save_failure' }) });
        return;
      }
      await route.continue();
    };
    await page.route('**/qlcl/api/evaluations', failEvaluationSave);
    await page.locator('#btn-save-evaluation').click();
    await expect(page.locator('#evaluation-form-msg')).toContainText('Không lưu được phiếu');
    await expect(page.locator('#evaluation-score-after-save')).toBeHidden();
    await page.unroute('**/qlcl/api/evaluations', failEvaluationSave);

    await page.evaluate(() => {
      const form = document.querySelector('#evaluation-form');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await expect(page.locator('#evaluation-form-msg')).toContainText('Đã thêm phiếu');
    await expect(page.locator('#evaluation-score-after-save')).toBeVisible();
    const savedScoreTarget = await page.locator('#btn-score-saved-evaluation').evaluate((button) => ({
      id: button.dataset.ticketId,
      code: button.dataset.ticketCode,
    }));
    expect(Number(savedScoreTarget.id)).toBeGreaterThan(0);
    expect(savedScoreTarget.code).toBeTruthy();
    const duplicateProbe = await page.request.get(`/qlcl/api/evaluations?q=${encodeURIComponent(savedScoreTarget.code)}`);
    expect(duplicateProbe.status()).toBe(200);
    const duplicateJson = await duplicateProbe.json();
    expect(duplicateJson.total).toBe(1);

    await page.locator('#btn-score-saved-evaluation').click();
    await expect(page.locator('#view-scoring')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/evaluations/scoring\\?ticket=${encodeURIComponent(savedScoreTarget.code)}$`));
    await expect(page.locator('#scoring-ticket-select')).toHaveValue(savedScoreTarget.code);

    // RUN-10 workspace boundary: an approval-queue record may remain in the
    // bootstrap payload, but #/evaluations only renders the assigned row.
    const run10Bootstrap = async (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        tickets: [
          {
            id: 91001, ticket_code: 'RUN10-OWNED', supplier: { code: 'RUN10-NCC-A', name: 'RUN-10 Assigned Supplier' },
            evaluation_type: 'Dinh ky', merchandising: { mch2: 'Synthetic MCH2', mch3: 'Synthetic MCH3' },
            workflow_status: 'Khởi tạo', dates: { created: '2026-07-16', planned: '2026-07-20' },
            allowed_actions: ['view'], disabled_reasons: {}, evaluation_workspace_visible: true,
          },
          {
            id: 91002, ticket_code: 'RUN10-FOREIGN', supplier: { code: 'RUN10-NCC-B', name: 'RUN-10 Foreign Supplier' },
            evaluation_type: 'Dinh ky', merchandising: { mch2: 'Synthetic MCH2', mch3: 'Synthetic MCH3' },
            workflow_status: 'Chờ duyệt Lead', dates: { created: '2026-07-16', planned: '2026-07-20' },
            allowed_actions: ['view', 'approve_lead'], disabled_reasons: {}, evaluation_workspace_visible: false,
          },
        ],
        questions: [],
        answers: {},
      }),
    });
    await page.route('**/qlcl/api/evaluations/bootstrap', run10Bootstrap);
    await page.evaluate(() => { window.location.hash = '/evaluations'; });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('evaluations-view')).toBeVisible();
    await expect(page.locator('#eval-tbody')).toContainText('RUN10-OWNED');
    await expect(page.locator('#eval-tbody')).not.toContainText('RUN10-FOREIGN');
    await page.unroute('**/qlcl/api/evaluations/bootstrap', run10Bootstrap);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await app.waitForSession(uat.config.adminEmail);

    await app.openSidebarRoute('nav-suppliers', 'suppliers-view');
    await expect(page.locator('#btn-import-suppliers')).toHaveText('Tải danh sách NCC');
    await page.locator('#btn-import-suppliers').click();
    await expect(page.locator('#supplier-import-modal')).toBeVisible();
    const templateProbe = await page.evaluate(async () => {
      const response = await fetch('/qlcl/api/suppliers/import-template');
      const bytes = await response.arrayBuffer();
      return { status: response.status, contentType: response.headers.get('content-type'), byteLength: bytes.byteLength };
    });
    expect(templateProbe.status).toBe(200);
    expect(templateProbe.contentType).toContain('spreadsheetml');
    expect(templateProbe.byteLength).toBeGreaterThan(1000);
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#btn-download-supplier-template').click();
    const templateDownload = await downloadPromise;
    expect(templateDownload.suggestedFilename()).toBe('mau-import-danh-sach-ncc.xlsx');
    await page.locator('#btn-cancel-supplier-import').click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#supplier-mobile-list')).toBeVisible();
    expect(await page.locator('#supplier-mobile-list .supplier-card').count()).toBeGreaterThan(0);
    await page.setViewportSize({ width: 1440, height: 900 });

    await app.openReports();
    await expect(page.locator('#view-reports')).toBeVisible();
    await expect(page.locator('#btn-open-upload-full, #upload-modal')).toHaveCount(0);
    await expect(page.getByText('Tải báo cáo lên', { exact: true })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#view-reports')).toBeVisible();
    await expect(page.locator('#btn-open-upload-full, #upload-modal')).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 900 });
    await app.openAdminUsers();

    const questionVersionSmoke = await page.evaluate(async () => {
      const templatesResponse = await fetch('/qlcl/api/question-templates');
      const templates = await templatesResponse.json();
      const template = templates.items.find((item) => item.template_code === 'BM04');
      const versionsResponse = await fetch(`/qlcl/api/question-templates/${template.id}/versions`);
      const versions = await versionsResponse.json();
      const published = versions.items.find((item) => item.version_no === 1 && item.status === 'PUBLISHED');
      const detailResponse = await fetch(`/qlcl/api/question-templates/${template.id}/versions/${published.id}`);
      const detail = await detailResponse.json();
      const validationResponse = await fetch(`/qlcl/api/question-templates/${template.id}/versions/${published.id}/validate`);
      const validation = await validationResponse.json();
      return {
        templateStatus: templatesResponse.status,
        versionsStatus: versionsResponse.status,
        detailStatus: detailResponse.status,
        validationStatus: validationResponse.status,
        requestId: detailResponse.headers.get('x-request-id'),
        checksum: published.checksum,
        itemCount: detail.item.items.length,
        validationErrors: validation.item.error_count,
      };
    });
    expect(questionVersionSmoke.templateStatus).toBe(200);
    expect(questionVersionSmoke.versionsStatus).toBe(200);
    expect(questionVersionSmoke.detailStatus).toBe(200);
    expect(questionVersionSmoke.validationStatus).toBe(200);
    expect(questionVersionSmoke.requestId).toBeTruthy();
    expect(questionVersionSmoke.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(questionVersionSmoke.itemCount).toBeGreaterThan(0);
    expect(questionVersionSmoke.validationErrors).toBe(0);

    const reportVersionSmoke = await page.evaluate(async () => {
      const definitionsResponse = await fetch('/qlcl/api/report-templates/definitions');
      const definitions = await definitionsResponse.json();
      const versionsResponse = await fetch('/qlcl/api/report-templates/definitions/ROUND1_RESULT/versions');
      const versions = await versionsResponse.json();
      const migrationResponse = await fetch('/qlcl/api/report-templates/legacy-migration');
      const migration = await migrationResponse.json();
      const published = versions.items.find((item) => item.status === 'PUBLISHED' && item.is_default);
      return {
        definitionsStatus: definitionsResponse.status,
        versionsStatus: versionsResponse.status,
        migrationStatus: migrationResponse.status,
        requestId: versionsResponse.headers.get('x-request-id'),
        codes: definitions.items.map((item) => item.definition_code).sort(),
        legacy: definitions.legacy.items.map((item) => ({
          source: item.legacy_source,
          canonical: item.canonical_code,
          create: item.deprecation?.new_creation_allowed,
        })),
        migrationCounts: migration.report.counts,
        publishedChecksum: published && published.checksum,
      };
    });
    expect(reportVersionSmoke.definitionsStatus).toBe(200);
    expect(reportVersionSmoke.versionsStatus).toBe(200);
    expect(reportVersionSmoke.migrationStatus).toBe(200);
    expect(reportVersionSmoke.requestId).toBeTruthy();
    expect(reportVersionSmoke.codes).toEqual(['ROUND1_RESULT', 'ROUND2_RESULT', 'WORKING_MINUTES']);
    expect(reportVersionSmoke.legacy).toEqual([
      { source: 'INTERNAL', canonical: null, create: false },
      { source: 'NCC', canonical: null, create: false },
    ]);
    expect(reportVersionSmoke.migrationCounts).toEqual({ mapped: 0, skipped: 1, conflict: 0, missing: 0, ambiguous: 1 });
    expect(reportVersionSmoke.publishedChecksum).toMatch(/^[a-f0-9]{64}$/);

    await expect(page.locator('#eval-page-meta')).not.toHaveText('');
    await expect(page.locator('#supplier-page-meta')).not.toHaveText('');
    await expect(page.locator('#report-tbody')).toHaveCount(1);
    await expect(page.locator('#admin-users-tbody')).toContainText(uat.config.adminEmail);
    await page.setViewportSize({ width: 1440, height: 1024 });
    await expect(page.getByTestId('authorization-admin')).toBeVisible();
    await expect(page.locator('#view-admin .admin-page-header')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Module quản trị' })).toBeVisible();
    await expect(page.locator('#authz-pane-users .admin-master-detail')).toBeVisible();
    const desktopAdminWidth = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(desktopAdminWidth.scroll).toBeLessThanOrEqual(desktopAdminWidth.client + 1);
    await expect(page.locator('a[href="/qlcl/help/role-permission-management#quick-start-admin"]')).toBeVisible();
    await page.locator('[data-authz-tab="users"]').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('[data-authz-tab="roles"]')).toBeFocused();
    const adminFocusVisible = await page.locator('[data-authz-tab="roles"]').evaluate((node) => {
      const style = getComputedStyle(node);
      return style.outlineStyle !== 'none' || style.boxShadow !== 'none';
    });
    expect(adminFocusVisible).toBeTruthy();
    await expect(page.locator('#authz-role-list')).toContainText('SYS_ADMIN');
    await page.locator('[data-authz-tab="permissions"]').click();
    await expect(page.locator('#authz-permission-matrix')).toContainText('SYSTEM.ADMIN');
    await page.locator('[data-authz-tab="users"]').click();

    await page.evaluate(() => { window.location.hash = '/admin/question-templates'; });
    await expect(page.locator('#question-management-workspace-root')).toBeVisible();
    await expect(page.locator('a[href="/qlcl/help/question-template-management#quick-start-designer"]')).toBeVisible();
    await expect(page.locator('#question-workspace-version-select')).toBeVisible();
    await expect(page.locator('#question-workspace-version-select option')).toHaveCount(1);
    await expect(page.locator('#question-workspace-version-select')).toContainText('PUBLISHED');
    await expect(page.locator('#question-published-readonly')).toBeVisible();
    await expect(page.locator('#question-version-clone')).toBeVisible();
    await expect(page.locator('#question-preview')).toBeVisible();
    await expect(page.locator('#question-validate')).toBeVisible();
    await expect(page.locator('#question-save-draft')).toBeHidden();
    await expect(page.locator('#question-submit-review')).toBeHidden();
    await expect(page.locator('#question-publish')).toBeHidden();
    await page.locator('#question-tab-questions').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#question-pane-questions')).toBeVisible();
    await expect(page.locator('#question-add-item')).toBeHidden();
    const readonlyActionMenus = page.locator('#question-version-tbody [aria-label="Không có thao tác khả dụng"]');
    expect(await readonlyActionMenus.count()).toBeGreaterThan(0);
    await expect(readonlyActionMenus.first()).toBeDisabled();
    await expect(page).toHaveURL(/admin\/question-templates\?.*template=.*version=.*tab=questions/);
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#question-tab-variants')).toBeFocused();
    await expect(page.locator('#question-pane-variants')).toBeVisible();
    await page.goBack();
    await expect(page.locator('#question-pane-questions')).toBeVisible();
    await expect(page).toHaveURL(/tab=questions/);

    await page.locator('#question-preview').click();
    await expect(page.locator('#question-preview-dialog')).toBeVisible();
    await expect(page.locator('#question-preview-meta')).toContainText('PUBLISHED');
    await expect(page.locator('#question-preview-tbody tr').first()).toBeVisible();
    await page.locator('#question-preview-close').click();
    await expect(page.locator('#question-preview-dialog')).toBeHidden();
    await page.locator('#question-validate').click();
    await expect(page.locator('#question-validation-summary')).toContainText('Kiểm tra hợp lệ');

    const publishedOptionValue = await page.locator('#question-workspace-version-select option').filter({ hasText: 'PUBLISHED' }).first().getAttribute('value');
    await page.locator('#question-version-clone').click();
    await expect(page.locator('#question-version-status-chip')).toHaveText('DRAFT');
    await expect(page.locator('#question-workspace-version-select option')).toHaveCount(2);
    await page.locator('#question-add-item').click();
    await expect(page.locator('#question-editor-drawer')).toBeVisible();
    const syntheticQuestionMarker = ` [UAT ${uat.config.runId.slice(0, 8)}]`;
    await page.locator('#question-editor-category').fill('UAT synthetic');
    await page.locator('#question-editor-code').fill(`UAT_${uat.config.runId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase()}`);
    await page.locator('#question-editor-text').fill(`Câu hỏi synthetic cho PROMPT-09${syntheticQuestionMarker}`);
    const questionSaveResponse = page.waitForResponse((response) => response.request().method() === 'PATCH'
      && /\/qlcl\/api\/question-templates\/\d+\/versions\/\d+\/items$/.test(new URL(response.url()).pathname));
    await page.locator('#question-editor-save').click();
    const questionSaveResult = await questionSaveResponse;
    const questionSaveBody = await questionSaveResult.json();
    expect(questionSaveResult.status(), JSON.stringify(questionSaveBody)).toBe(200);
    await expect(page.locator('#question-editor-drawer')).toBeHidden();
    await expect(page.locator('#question-version-tbody')).toContainText(syntheticQuestionMarker.trim());
    await page.locator('#question-tab-versions').click();
    await page.locator('#question-version-note').fill(`UAT PROMPT-09 ${uat.config.runId}`);
    await page.locator('#question-save-draft').click();
    await expect(page.locator('#question-workspace-live')).toContainText('Đã lưu ghi chú');
    await page.locator('#question-validate').click();
    await expect(page.locator('#question-validation-summary')).toContainText('Kiểm tra hợp lệ');
    await page.locator('#question-submit-review').click();
    await expect(page.locator('#confirm-modal')).toBeVisible();
    await page.locator('#confirm-accept').click();
    await expect(page.locator('#question-version-status-chip')).toHaveText('IN_REVIEW');
    await expect(page.locator('#question-save-draft')).toBeHidden();
    await expect(page.locator('#question-publish')).toBeDisabled();
    await expect(page.locator('#question-publish')).toHaveAttribute('data-disabled-reason', /Publish đang bị tắt/);
    await page.locator('#question-workspace-version-select').selectOption(publishedOptionValue);
    await expect(page.locator('#question-version-status-chip')).toHaveText('PUBLISHED');
    await page.locator('#question-tab-questions').click();
    await page.locator('#question-management-workspace-root').scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: path.join(uat.trace.scenarioDir, 'business-config-question-desktop-1440x1024.png'),
      animations: 'disabled',
    });

    await page.evaluate(() => { window.location.hash = '/admin/report-templates'; });
    await expect(page.locator('#report-template-tbody')).toBeVisible();
    await expect(page.locator('a[href="/qlcl/help/report-template-management#quick-start-designer"]')).toBeVisible();
    await expect(page.locator('#report-template-version-select')).toBeVisible();
    await expect(page.locator('#report-template-version-select')).toContainText('PUBLISHED');
    await expect(page.locator('#report-template-component-tree')).toBeVisible();
    await expect(page.locator('#report-template-readonly')).toBeVisible();
    await expect(page.locator('#report-template-save-draft')).toBeDisabled();
    const saveDraftReasonIds = (await page.locator('#report-template-save-draft').getAttribute('aria-describedby') || '').trim().split(/\s+/).filter(Boolean);
    expect(saveDraftReasonIds.length).toBeGreaterThan(0);
    for (const id of saveDraftReasonIds) await expect(page.locator(`#${id}`)).toBeVisible();
    await expect(page.locator('#report-template-create-draft')).toBeVisible();
    await expect(page.locator('#report-template-legacy summary')).toContainText('không tạo mới');
    await page.locator('#report-template-tab-preview').click();
    await expect(page.locator('#report-template-a4-preview')).toHaveAttribute('srcdoc', /data-report-definition="/);
    await expect(page.locator('#report-template-preview-provenance')).toContainText('data contract v1');
    await expect(page.locator('#report-template-error-help')).toBeHidden();
    await page.locator('#report-template-tab-structure').click();
    const publishedReportVersionValue = await page.locator('#report-template-version-select option:checked').getAttribute('value');
    await page.locator('#report-template-create-draft').click();
    await expect(page.locator('#report-template-version-select option:checked')).toContainText('DRAFT');
    const draftReportVersionValue = await page.locator('#report-template-version-select').inputValue();
    await expect(page.locator('#report-template-component-title')).toBeEnabled();
    const currentReportTitle = await page.locator('#report-template-component-title').inputValue();
    await page.locator('#report-template-component-title').fill(`${currentReportTitle} · PROMPT-10 synthetic`);
    await page.locator('#report-template-save-draft').click();
    await expect(page.locator('#report-template-live')).toContainText('Đã lưu Draft');
    await page.locator('#report-template-validate').click();
    await expect(page.locator('#report-template-validation-result')).toContainText('Hợp lệ');
    await page.locator('#report-template-tab-preview').click();
    await page.locator('#report-template-preview-refresh').click();
    await expect(page.locator('#report-template-preview-provenance')).toContainText(`#${draftReportVersionValue}`);
    await expect(page.locator('#report-template-preview-provenance')).toContainText('synthetic');
    await page.locator('#report-template-submit-review').click();
    await expect(page.locator('#confirm-modal')).toBeVisible();
    await page.locator('#confirm-accept').click();
    await expect(page.locator('#report-template-version-select option:checked')).toContainText('IN_REVIEW');
    await expect(page.locator('#report-template-readonly-message')).toContainText('đang Review');
    await expect(page.locator('#report-template-save-draft')).toBeDisabled();
    await page.locator('#report-template-tab-preview').click();
    await page.locator('#report-template-preview-refresh').click();
    await expect(page.locator('#report-template-preview-provenance')).toContainText(`#${draftReportVersionValue}`);
    await page.locator('#report-template-version-select').selectOption(publishedReportVersionValue);
    await expect(page.locator('#report-template-version-select option:checked')).toContainText('PUBLISHED');
    await expect(page.locator('#report-template-readonly-message')).toContainText('Published/Retired');
    await page.locator('#report-template-editor').scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(uat.trace.scenarioDir, 'business-config-report-desktop-1440x1024.png'),
      animations: 'disabled',
    });
    const contextualHelpSmoke = await page.evaluate(async () => {
      const slugs = [
        'role-permission-management',
        'question-template-management',
        'report-template-management',
      ];
      return Promise.all(slugs.map(async (slug) => {
        const response = await fetch(`/qlcl/help/${slug}`);
        const body = await response.text();
        return {
          slug,
          status: response.status,
          requestId: response.headers.get('x-request-id'),
          hasGuide: body.includes('guide-content'),
          hasScript: body.includes('<script>'),
        };
      }));
    });
    expect(contextualHelpSmoke).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: 'role-permission-management', status: 200, hasGuide: true, hasScript: false }),
      expect.objectContaining({ slug: 'question-template-management', status: 200, hasGuide: true, hasScript: false }),
      expect.objectContaining({ slug: 'report-template-management', status: 200, hasGuide: true, hasScript: false }),
    ]));
    expect(contextualHelpSmoke.every((item) => item.requestId)).toBeTruthy();
    await page.locator('#report-template-tab-structure').click();
    await page.locator('#report-template-tab-structure').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#report-template-tab-data')).toBeFocused();
    await expect(page).toHaveURL(/admin\/report-templates\?.*definition=.*version=.*tab=data/);
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#report-template-tab-presentation')).toBeFocused();

    await page.evaluate(() => { window.location.hash = '/admin/scoring-policies'; });
    await expect(page.locator('#scoring-policy-workspace')).toBeVisible();
    await expect(page.locator('#scoring-policy-version-select')).toBeVisible();
    await expect(page.locator('#scoring-policy-status')).toContainText('PUBLISHED');
    await expect(page.locator('#scoring-policy-lifecycle > li')).toHaveCount(5);
    await expect(page.locator('[data-scoring-policy-tab]')).toHaveCount(7);
    await expect(page.locator('#scoring-policy-readonly')).toBeVisible();
    await expect(page.locator('#scoring-policy-save-draft')).toBeDisabled();
    await expect(page.locator('#scoring-policy-submit-review')).toBeDisabled();
    await expect(page.locator('#scoring-policy-publish')).toBeDisabled();
    await expect(page.locator('#scoring-policy-publish')).toHaveAttribute('data-disabled-reason', /Publish|publish/);
    await expect(page.locator('#scoring-policy-simulate')).toBeEnabled();
    await expect(page.locator('#scoring-policy-impact')).toBeEnabled();
    await page.locator('#scoring-policy-simulate').click();
    await expect(page.locator('#scoring-policy-pane-simulation')).toBeVisible();
    await expect(page.locator('#scoring-policy-simulation-tbody tr')).toHaveCount(6);
    await expect(page).toHaveURL(/admin\/scoring-policies\?.*policy=.*version=.*tab=simulation/);
    await page.locator('#scoring-policy-impact').click();
    await expect(page.locator('#scoring-policy-pane-impact')).toBeVisible();
    await expect(page.locator('#scoring-policy-impact-tbody tr')).toHaveCount(6);
    await expect(page.locator('#scoring-policy-impact-result')).toContainText('Published');
    await page.locator('#scoring-policy-tab-impact').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#scoring-policy-tab-versions')).toBeFocused();
    await expect(page).toHaveURL(/tab=versions/);
    await page.goBack();
    await expect(page.locator('#scoring-policy-pane-impact')).toBeVisible();
    await expect(page).toHaveURL(/tab=impact/);

    await page.locator('#scoring-policy-create-draft').click();
    await expect(page.locator('#scoring-policy-status')).toContainText('DRAFT');
    await page.locator('#scoring-policy-overview-title').fill(`Tổng hợp tuân thủ · PROMPT-11 ${uat.config.runId.slice(0, 8)}`);
    await expect(page.locator('#scoring-policy-submit-review')).toBeDisabled();
    await page.locator('#scoring-policy-save-draft').click();
    await expect(page.locator('#scoring-policy-live')).toContainText('Đã lưu Draft');
    await page.locator('#scoring-policy-validate').click();
    await expect(page.locator('#scoring-policy-live')).toContainText('Hợp lệ');
    await page.locator('#scoring-policy-simulate').click();
    await expect(page.locator('#scoring-policy-simulation-tbody tr')).toHaveCount(6);
    await page.locator('#scoring-policy-impact').click();
    await expect(page.locator('#scoring-policy-impact-tbody tr')).toHaveCount(6);
    await expect(page.locator('#scoring-policy-submit-review')).toBeEnabled();
    await page.locator('#scoring-policy-submit-review').click();
    await expect(page.locator('#confirm-modal')).toBeVisible();
    await page.locator('#confirm-accept').click();
    await expect(page.locator('#scoring-policy-status')).toContainText('IN_REVIEW');
    await expect(page.locator('#scoring-policy-publish')).toBeDisabled();
    await page.locator('#scoring-policy-workspace').scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(uat.trace.scenarioDir, 'scoring-policy-desktop-1440x1024.png'),
      animations: 'disabled',
    });
    const desktopActionAudit = await page.evaluate(() => {
      const visible = [...document.querySelectorAll('button')].filter((button) => {
        const style = getComputedStyle(button);
        return style.display !== 'none' && style.visibility !== 'hidden' && button.getClientRects().length > 0;
      });
      return {
        missingType: visible.filter((button) => !button.getAttribute('type')).length,
        missingAction: visible.filter((button) => !window.QLCL_ACTIONS.getAction(button.dataset.actionId)).map((button) => button.id || button.textContent.trim()).slice(0, 5),
        undersized: visible.filter((button) => button.getBoundingClientRect().height < 40).map((button) => button.id || button.textContent.trim()).slice(0, 5),
        rowOverflow: [...document.querySelectorAll('.icon-actions')].filter((group) => group.querySelectorAll('.icon-btn:not(.more-action)').length > 3).length,
        multiPrimary: [...document.querySelectorAll('.form-actions')].filter((group) => [...group.querySelectorAll('.btn-primary')].filter((button) => getComputedStyle(button).display !== 'none').length > 1).length,
      };
    });
    expect(desktopActionAudit).toEqual({ missingType: 0, missingAction: [], undersized: [], rowOverflow: 0, multiPrimary: 0 });

    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reducedMotionDurations = await page.locator('#desktop-navigation [data-route-tab="admin-question-templates"]').evaluate((node) => {
      const seconds = (value) => value.endsWith('ms') ? Number.parseFloat(value) / 1000 : Number.parseFloat(value);
      const style = getComputedStyle(node);
      return [...style.transitionDuration.split(','), ...style.animationDuration.split(',')]
        .map((value) => seconds(value.trim()));
    });
    expect(Math.max(...reducedMotionDurations)).toBeLessThanOrEqual(0.001);
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    await app.openSystemLogs();
    await expect(page.locator('#system-log-filter-form')).toBeVisible();
    await page.locator('#system-log-event').fill('audit.read');
    // The initial list request audits itself just after the default "to" snapshot.
    // Advance the smoke window so the next filtered request can observe that event.
    const nextMinute = new Date(Date.now() + 60000);
    const localTimestamp = [
      nextMinute.getFullYear(),
      String(nextMinute.getMonth() + 1).padStart(2, '0'),
      String(nextMinute.getDate()).padStart(2, '0'),
    ].join('-') + `T${String(nextMinute.getHours()).padStart(2, '0')}:${String(nextMinute.getMinutes()).padStart(2, '0')}`;
    await page.locator('#system-log-to').fill(localTimestamp);
    await page.locator('#system-log-filter-form').getByRole('button', { name: 'Áp dụng bộ lọc', exact: true }).click();
    await expect(page.locator('#system-log-tbody')).toContainText('audit.read');
    const detailButton = page.getByRole('button', { name: 'Xem chi tiết audit.read', exact: true });
    await detailButton.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#system-log-drawer')).toBeVisible();
    await expect(page.locator('#system-log-timeline')).toContainText('Request ID');
    await page.keyboard.press('Escape');
    await expect(page.locator('#system-log-drawer')).toBeHidden();
    await expect(detailButton).toBeFocused();

    let detailRequestCount = 0;
    const countDetailRequests = (request) => {
      if (/\/qlcl\/api\/admin\/audit-events\/\d+$/.test(request.url())) detailRequestCount += 1;
    };
    page.on('request', countDetailRequests);
    await detailButton.evaluate((button) => { button.click(); button.click(); });
    await expect(page.locator('#system-log-drawer')).toBeVisible();
    await expect(page.locator('#system-log-drawer-loading')).toBeHidden();
    expect(detailRequestCount).toBe(1);
    page.off('request', countDetailRequests);
    await page.keyboard.press('Escape');
    await expect(page.locator('#system-log-drawer')).toBeHidden();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId('system-logs-view')).toBeVisible();
    await expect(page.locator('#system-log-filter-form')).toBeVisible();
    await expect(page.locator('#system-log-tbody')).toContainText('audit.read');
    await page.locator('#mobile-more-trigger').click();
    const businessConfigToggle = page.locator('#mobile-more-navigation [data-navigation-group-toggle="admin-business-config"]');
    if (await businessConfigToggle.getAttribute('aria-expanded') !== 'true') {
      await businessConfigToggle.evaluate((button) => button.click());
    }
    await expect(businessConfigToggle).toHaveAttribute('aria-expanded', 'true');
    await page.locator('#mobile-more-navigation [data-route-tab="admin-question-templates"]').evaluate((button) => button.click());
    await expect(page.locator('#question-workspace-version-select')).toBeVisible();
    await page.locator('#question-workspace-version-select').selectOption(publishedOptionValue);
    await expect(page.locator('#question-version-status-chip')).toHaveText('PUBLISHED');
    await expect(page.locator('#question-published-readonly')).toBeVisible();
    await page.locator('#question-tab-questions').click();
    await page.locator('#question-import-panel > summary').click();
    await expect(page.locator('#question-import-wizard')).toBeVisible();
    await expect(page.locator('#question-workspace-import-preview')).toBeDisabled();
    const mobileQuestionImportTargets = await page.locator('#question-version-clone, #question-download-template, #question-workspace-import-preview').evaluateAll((buttons) => (
      buttons.map((button) => ({
        width: button.getBoundingClientRect().width,
        height: button.getBoundingClientRect().height,
        display: getComputedStyle(button).display,
        className: button.className,
        disabled: button.disabled,
        actionHidden: button.dataset.actionHidden || '',
        disabledReason: button.dataset.disabledReason || '',
        resourceAction: button.dataset.resourceAction || '',
      }))
    ));
    expect(mobileQuestionImportTargets.every((target) => target.width >= 44 && target.height >= 44), JSON.stringify(mobileQuestionImportTargets)).toBeTruthy();
    await page.locator('#question-version-clone').scrollIntoViewIfNeeded();
    const mobilePrimaryActionVisible = await page.locator('#question-version-clone').evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return target === button || button.contains(target);
    });
    expect(mobilePrimaryActionVisible, 'Question clone action must remain visible above mobile navigation.').toBeTruthy();
    await page.locator('#question-tab-questions').click();
    await page.locator('.question-version-toolbar').scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(uat.trace.scenarioDir, 'business-config-question-mobile-390x844.png'),
      animations: 'disabled',
    });
    await page.locator('#mobile-more-trigger').click();
    await page.locator('#mobile-more-navigation [data-route-tab="admin-report-templates"]').evaluate((button) => button.click());
    await expect(page.locator('#report-template-tbody')).toBeVisible();
    await expect(page.locator('#report-template-version-select')).toBeVisible();
    await page.locator('#report-template-tab-presentation').click();
    await expect(page.locator('#report-template-properties')).toBeVisible();
    const mobileReportTargets = await page.locator('#report-template-create-draft, #report-template-preview-refresh, #report-template-export-package').evaluateAll((buttons) => (
      buttons.filter((button) => getComputedStyle(button).display !== 'none').map((button) => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height }))
    ));
    expect(mobileReportTargets.every((target) => target.width >= 44 && target.height >= 44)).toBeTruthy();
    await page.locator('.report-template-version-toolbar').scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(uat.trace.scenarioDir, 'business-config-report-mobile-390x844.png'),
      animations: 'disabled',
    });
    await page.locator('#mobile-more-trigger').click();
    await page.locator('#mobile-more-navigation [data-route-tab="admin-scoring-policies"]').evaluate((button) => button.click());
    await expect(page.locator('#scoring-policy-workspace')).toBeVisible();
    await expect(page.locator('#scoring-policy-readonly')).toBeVisible();
    await page.locator('#scoring-policy-tab-grade-scale').click();
    await expect(page.locator('#scoring-policy-pane-grade-scale')).toBeVisible();
    const mobileScoringTargets = await page.locator('#scoring-policy-create-draft, #scoring-policy-simulate, #scoring-policy-impact, #scoring-policy-validate').evaluateAll((buttons) => (
      buttons.filter((button) => getComputedStyle(button).display !== 'none').map((button) => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height }))
    ));
    expect(mobileScoringTargets.every((target) => target.width >= 44 && target.height >= 44)).toBeTruthy();
    const mobileScoringWidth = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(mobileScoringWidth.scroll).toBeLessThanOrEqual(mobileScoringWidth.client + 1);
    await page.locator('#scoring-policy-workspace').scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(uat.trace.scenarioDir, 'scoring-policy-mobile-390x844.png'),
      animations: 'disabled',
    });
    await page.locator('#mobile-more-trigger').click();
    const peopleAccessToggle = page.locator('#mobile-more-navigation [data-navigation-group-toggle="admin-people-access"]');
    await expect(peopleAccessToggle).toHaveAttribute('aria-expanded', 'false');
    await peopleAccessToggle.click();
    await expect(peopleAccessToggle).toHaveAttribute('aria-expanded', 'true');
    await page.locator('#mobile-more-navigation [data-route-tab="admin-users"]').click();
    await expect(page.getByTestId('authorization-admin')).toBeVisible();
    await page.locator('[data-authz-tab="roles"]').click();
    await expect(page.locator('#authz-role-list')).toContainText('SYS_ADMIN');
    await expect(page.locator('#authz-role-form')).toBeVisible();
    const mobileAdminWidth = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(mobileAdminWidth.scroll).toBeLessThanOrEqual(mobileAdminWidth.client + 1);

    const mobileActionAudit = await page.evaluate(() => {
      const visible = [...document.querySelectorAll('button')].filter((button) => {
        const style = getComputedStyle(button);
        return style.display !== 'none' && style.visibility !== 'hidden' && button.getClientRects().length > 0;
      });
      return {
        missingAction: visible.filter((button) => !window.QLCL_ACTIONS.getAction(button.dataset.actionId)).map((button) => button.id || button.textContent.trim()).slice(0, 5),
        undersized: visible.filter((button) => {
          const rect = button.getBoundingClientRect();
          return rect.height < 44 || rect.width < 44;
        }).map((button) => button.id || button.textContent.trim()).slice(0, 5),
      };
    });
    expect(mobileActionAudit).toEqual({ missingAction: [], undersized: [] });

    const primaryRoutes = page.locator('#mobile-primary-navigation [data-route-tab]');
    await expect(primaryRoutes).toHaveCount(4);
    await page.locator('#mobile-more-trigger').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#mobile-more-sheet')).toBeVisible();
    await expect(page.locator('#mobile-more-navigation [data-route-tab="overview"]')).toHaveCount(1);
    await expect(page.locator('#mobile-more-navigation [data-route-tab="ncc-docs"], #mobile-more-navigation [data-route-tab="ncc-eval"], #mobile-more-navigation [data-route-tab="qc-warehouse"], #mobile-more-navigation [data-route-tab="lab"], #mobile-more-navigation [data-route-tab="kph"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('#mobile-more-sheet')).toBeHidden();

    // RUN-09 frontend boundary: replace only the session identity with each
    // deterministic approver role, then reload an admin URL. The protected
    // route loader must not start before authorization resolves.
    let authorizationCatalogRequests = 0;
    let reportTemplateRequests = 0;
    page.on('request', (request) => {
      if (request.url().includes('/admin/authorization/catalog')) authorizationCatalogRequests += 1;
      if (request.url().includes('/api/report-templates')) reportTemplateRequests += 1;
    });
    const approverIdentities = [
      {
        role: 'Lead miền', roleCode: 'REGIONAL_LEAD_APPROVER', displayName: 'UAT Lead miền',
        capabilities: ['DASHBOARD.READ', 'SUPPLIER.READ', 'EVALUATION.READ', 'REPORT.READ', 'REPORT.EXPORT', 'EVALUATION.APPROVE_LEAD'],
      },
      {
        role: 'TBP', roleCode: 'DEPARTMENT_HEAD_APPROVER', displayName: 'UAT TBP',
        capabilities: ['DASHBOARD.READ', 'SUPPLIER.READ', 'EVALUATION.READ', 'REPORT.READ', 'REPORT.EXPORT', 'EVALUATION.APPROVE_TBP'],
      },
      {
        role: 'GĐK', roleCode: 'BLOCK_DIRECTOR_APPROVER', displayName: 'UAT GĐK',
        capabilities: ['DASHBOARD.READ', 'SUPPLIER.READ', 'EVALUATION.READ', 'REPORT.READ', 'REPORT.EXPORT', 'EVALUATION.APPROVE_GDK'],
      },
    ];
    let activeApprover = approverIdentities[0];
    await page.route('**/qlcl/api/auth/me', async (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        email: uat.config.adminEmail,
        isAdmin: false,
        role: activeApprover.role,
        displayName: activeApprover.displayName,
        role_codes: [activeApprover.roleCode],
        role_labels: [activeApprover.role],
        capabilities: activeApprover.capabilities,
        authz_version: 1,
        policy_version: 1,
        navigation_version: 2,
        action_version: 4,
        needsAcknowledge: false,
        rulesVersion: 1,
        authDeliveryMode: 'screen',
        degradedAuth: true,
      }),
    }));
    // Rehydrate the first approver on a business route before attempting an
    // admin deep link; otherwise the already-loaded SYS_ADMIN session can
    // start the old route loader in the instant before reload.
    await page.evaluate(() => { window.location.hash = '/dashboard'; });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#view-overview')).toBeVisible();
    await page.waitForLoadState('networkidle');
    authorizationCatalogRequests = 0;
    reportTemplateRequests = 0;
    for (const identity of approverIdentities) {
      activeApprover = identity;
      await page.evaluate(() => { window.location.hash = '/admin/report-templates'; });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('route-denied-view')).toBeVisible();
      await expect(page.locator('[data-navigation-id="nav-admin"]')).toHaveCount(0);
      await expect(page.locator('#mobile-more-navigation [data-route-tab="admin"]')).toHaveCount(0);
    }
    expect(authorizationCatalogRequests).toBe(0);
    expect(reportTemplateRequests).toBe(0);
  });

  test('local synthetic admin route matrix stays responsive and accessible', async ({ page, uat }, testInfo) => {
    test.skip(uat.config.mode !== 'local', 'Administration design QA uses only the temporary local database.');
    test.setTimeout(180_000);
    const login = new LoginPage(page);
    const app = new AppShell(page);
    const consoleErrors = [];
    const networkErrors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    page.on('requestfailed', (request) => {
      if (/^https?:/i.test(request.url())) networkErrors.push(`${request.method()} ${request.url()}`);
    });
    page.on('response', (response) => {
      if (response.status() >= 500) networkErrors.push(`${response.status()} ${response.url()}`);
    });

    await login.open(uat.config.baseUrl);
    await login.loginWithLocalScreenOtp(uat.config.adminEmail);
    await app.waitForSession(uat.config.adminEmail);

    const viewports = [
      { name: 'desktop-1440x1024', width: 1440, height: 1024 },
      { name: 'mobile-390x844', width: 390, height: 844 },
    ];

    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const entry of ADMIN_ROUTE_MATRIX) {
        await page.evaluate((route) => { window.location.hash = route; }, entry.route);
        await expect(page.getByTestId('admin-view')).toBeVisible();
        await expect(page.locator(entry.ready)).toBeVisible();
        if (entry.module) {
          await expect(page.locator(`#view-admin > [data-admin-module="${entry.module}"]`)).toBeVisible();
        }
        if (entry.pane) {
          await expect(page.locator(`[data-authz-tab="${entry.pane}"]`)).toHaveAttribute('aria-selected', 'true');
        }
        await page.evaluate(() => window.scrollTo(0, 0));

        const slug = entry.route.slice(1).replaceAll('/', '-');
        const screenshotName = `admin-route-matrix-${viewport.name}-${slug}.png`;
        const screenshotPath = path.join(uat.trace.scenarioDir, screenshotName);
        fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
        await page.screenshot({ path: screenshotPath, animations: 'disabled' });
        await testInfo.attach(screenshotName.replace(/\.png$/, ''), { path: screenshotPath, contentType: 'image/png' });

        const layoutAudit = await page.evaluate(({ module, mobile }) => {
          const documentElement = document.documentElement;
          const visible = (node) => Boolean(node && node.getClientRects().length
            && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden');
          const panel = module
            ? document.querySelector(`#view-admin > [data-admin-module="${module}"]`)
            : document.querySelector('#admin-dashboard');
          const moduleNav = document.querySelector('#admin-module-nav');
          const panelRect = visible(panel) ? panel.getBoundingClientRect() : null;
          const navRect = visible(moduleNav) ? moduleNav.getBoundingClientRect() : null;
          const controls = panel ? [...panel.querySelectorAll('input:not([type="hidden"]):not([aria-hidden="true"]), select, textarea')] : [];
          const missingLabels = controls.filter((control) => visible(control) && !(
            control.getAttribute('aria-label')
            || control.getAttribute('aria-labelledby')
            || (control.id && document.querySelector(`label[for="${CSS.escape(control.id)}"]`))
            || control.closest('label')
          )).map((control) => control.id || control.name || control.tagName).slice(0, 5);
          const unsafeTables = panel ? [...panel.querySelectorAll('table')].filter((table) => {
            if (!visible(table) || table.scrollWidth <= table.clientWidth + 1) return false;
            const firstRow = table.querySelector('tr');
            if (firstRow && getComputedStyle(firstRow).display !== 'table-row') return false;
            const scroller = table.closest('.table-scroll');
            if (!scroller) return true;
            const overflow = getComputedStyle(scroller).overflowX;
            return overflow !== 'auto' && overflow !== 'scroll';
          }).length : 0;
          const overflowElements = [...document.querySelectorAll('body *')]
            .filter((node) => visible(node))
            .map((node) => {
              const rect = node.getBoundingClientRect();
              return {
                tag: node.tagName,
                id: node.id || '',
                className: typeof node.className === 'string' ? node.className : '',
                left: Math.round(rect.left * 10) / 10,
                right: Math.round(rect.right * 10) / 10,
                width: Math.round(rect.width * 10) / 10,
              };
            })
            .filter((item) => item.left < -1 || item.right > documentElement.clientWidth + 1)
            .slice(0, 8);
          return {
            noDocumentOverflow: documentElement.scrollWidth <= documentElement.clientWidth + 1,
            documentWidth: documentElement.scrollWidth,
            clientWidth: documentElement.clientWidth,
            overflowElements,
            missingLabels,
            unsafeTables,
            moduleNavVisible: visible(moduleNav),
            menuOverlapsContent: Boolean(navRect && panelRect
              && navRect.right > panelRect.left + 1
              && navRect.left < panelRect.right - 1
              && navRect.bottom > panelRect.top + 1
              && navRect.top < panelRect.bottom - 1),
            mobile,
          };
        }, { module: entry.module, mobile: viewport.width < 768 });
        expect(
          layoutAudit.noDocumentOverflow,
          `${entry.route} ${viewport.name} must not overflow horizontally: ${JSON.stringify(layoutAudit)}`,
        ).toBeTruthy();
        expect(layoutAudit.missingLabels, `${entry.route} ${viewport.name} form labels`).toEqual([]);
        expect(layoutAudit.unsafeTables, `${entry.route} ${viewport.name} table strategy`).toBe(0);
        expect(layoutAudit.menuOverlapsContent, `${entry.route} ${viewport.name} menu overlap`).toBeFalsy();
        if (layoutAudit.mobile) expect(layoutAudit.moduleNavVisible, `${entry.route} mobile admin rail`).toBeFalsy();

        const primary = page.locator(`#view-admin ${entry.module ? `> [data-admin-module="${entry.module}"] ` : ''}.btn-primary:visible`).first();
        if (await primary.count()) {
          await primary.evaluate((button) => button.scrollIntoView({ block: 'center', inline: 'nearest' }));
          const primaryReachable = await primary.evaluate((button) => {
            const rect = button.getBoundingClientRect();
            if (rect.width < 1 || rect.height < 1) return false;
            const x = Math.min(innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
            const y = Math.min(innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
            const target = document.elementFromPoint(x, y);
            return target === button || button.contains(target);
          });
          expect(primaryReachable, `${entry.route} ${viewport.name} primary action`).toBeTruthy();
        }

        const focusTarget = page.locator(`#view-admin ${entry.module ? `> [data-admin-module="${entry.module}"] ` : ''}button:visible`).first();
        if (await focusTarget.count()) {
          await focusTarget.focus();
          const beforeTab = await focusTarget.evaluate((node) => node.id || node.dataset.actionId || node.textContent.trim());
          await page.keyboard.press('Tab');
          const afterTab = await page.evaluate(() => {
            const node = document.activeElement;
            return node && node !== document.body && node.getClientRects().length
              ? (node.id || node.dataset.actionId || node.textContent.trim()) : '';
          });
          expect(afterTab, `${entry.route} ${viewport.name} focus order after ${beforeTab}`).not.toBe('');
        }
      }
    }

    const unexpectedConsoleErrors = consoleErrors.filter((message) => !(
      /status of 401 \(Unauthorized\)/.test(message)
      || /server responded with a status of 401 \(Unauthorized\)/.test(message)
    ));
    const unexpectedNetworkErrors = networkErrors.filter((message) => !/\/qlcl\/winmart-logo\.png$/.test(message));
    expect(unexpectedConsoleErrors).toEqual([]);
    expect(unexpectedNetworkErrors).toEqual([]);
  });

  test('local synthetic personnel import maps roles, retries a stale commit and stays guarded', async ({ page, uat }, testInfo) => {
    test.skip(uat.config.mode !== 'local', 'Personnel import mutations run only against the temporary local database.');
    test.setTimeout(90_000);
    const login = new LoginPage(page);
    const app = new AppShell(page);
    const consoleErrors = [];
    const networkErrors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    page.on('requestfailed', (request) => {
      if (/^https?:/i.test(request.url())) networkErrors.push(`${request.method()} ${request.url()}`);
    });
    page.on('response', (response) => {
      if (response.status() >= 500) networkErrors.push(`${response.status()} ${response.url()}`);
    });

    await login.open(uat.config.baseUrl);
    await login.loginWithLocalScreenOtp(uat.config.adminEmail);
    await app.waitForSession(uat.config.adminEmail);
    await page.evaluate(() => { window.location.hash = '/admin/personnel-import'; });
    await expect(page.getByTestId('admin-view')).toBeVisible();
    await expect(page.locator('[data-personnel-import-workflow]')).toBeVisible();
    await expect(page).toHaveURL(/#\/admin\/personnel-import$/);

    for (const [buttonId, suffix] of [
      ['personnel-import-download-template', '/personnel-import/template.xlsx'],
      ['personnel-import-open-example', '/personnel-import/example.xlsx'],
    ]) {
      const responsePromise = page.waitForResponse((response) => response.request().method() === 'GET'
        && response.url().endsWith(suffix));
      const downloadPromise = page.waitForEvent('download');
      await page.locator(`#${buttonId}`).click();
      expect((await responsePromise).status()).toBe(200);
      expect((await downloadPromise).suggestedFilename()).toMatch(/^personnel-import-(template|example)\.xlsx$/);
    }

    const fileInput = page.locator('#personnel-import-file');
    await fileInput.setInputFiles({ name: 'personnel.csv', mimeType: 'text/csv', buffer: Buffer.from('email\ninvalid@example.test') });
    await expect(page.locator('#personnel-import-state')).toContainText('File không đúng định dạng XLSX');
    await expect(page.locator('#personnel-import-file-status')).toHaveText('Có lỗi');

    const missingAndDuplicate = personnelImportWorkbook([
      { email: '', display_name: 'Synthetic missing email', active: 'TRUE', role_codes: 'AUDITOR' },
      { email: 'duplicate-person@example.test', display_name: 'Synthetic duplicate A', active: 'TRUE', role_codes: 'AUDITOR' },
      { email: 'duplicate-person@example.test', display_name: 'Synthetic duplicate B', active: 'TRUE', role_codes: 'AUDITOR' },
    ]);
    let previewResponse = page.waitForResponse((response) => response.request().method() === 'POST'
      && response.url().endsWith('/personnel-import/batches/preview'));
    await fileInput.setInputFiles({
      name: 'personnel-import-invalid-rows.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: missingAndDuplicate,
    });
    expect((await previewResponse).status()).toBe(201);
    await expect(page.locator('[data-personnel-step="columns"]')).toBeVisible();
    const emailMapping = page.locator('[data-personnel-field="email"]');
    await emailMapping.selectOption('');
    await expect(page.locator('#personnel-import-next')).toBeDisabled();
    await expect(page.locator('#personnel-import-action-message')).toContainText('mapping cột Email');
    await emailMapping.selectOption('email');
    await page.locator('#personnel-import-next').click();
    await expect(page.locator('[data-personnel-step="roles"]')).toBeVisible();
    let validateResponse = page.waitForResponse((response) => response.request().method() === 'POST'
      && response.url().includes('/personnel-import/batches/') && response.url().endsWith('/validate'));
    await page.locator('#personnel-import-validate').click();
    expect((await validateResponse).status()).toBe(200);
    await expect(page.locator('[data-personnel-step="review"]')).toBeVisible();
    await expect(page.locator('#personnel-import-preview-tbody')).toContainText('Email không hợp lệ');
    await expect(page.locator('#personnel-import-preview-tbody')).toContainText('Email bị trùng trong file');
    await expect(page.locator('#personnel-import-commit')).toBeDisabled();

    const unknownRole = personnelImportWorkbook([
      { email: 'unknown-role-person@example.test', display_name: 'Synthetic role mapping', active: 'TRUE', role_codes: 'SOURCE_ROLE_UNKNOWN' },
    ]);
    previewResponse = page.waitForResponse((response) => response.request().method() === 'POST'
      && response.url().endsWith('/personnel-import/batches/preview'));
    await fileInput.setInputFiles({
      name: 'personnel-import-unknown-role.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: unknownRole,
    });
    expect((await previewResponse).status()).toBe(201);
    await page.locator('#personnel-import-next').click();
    const unknownRoleRow = page.locator('#personnel-import-role-mapping .personnel-import-role-row').filter({ hasText: 'SOURCE_ROLE_UNKNOWN' });
    await expect(unknownRoleRow).toHaveCount(1);
    await expect(unknownRoleRow.locator('select')).toHaveValue('');
    await expect(page.locator('#personnel-import-validate')).toBeDisabled();
    await unknownRoleRow.locator('select').selectOption('AUDITOR');
    await expect(page.locator('#personnel-import-validate')).toBeEnabled();

    const examplePath = path.resolve(__dirname, '..', '..', 'database', 'templates', 'personnel-import-example.xlsx');
    previewResponse = page.waitForResponse((response) => response.request().method() === 'POST'
      && response.url().endsWith('/personnel-import/batches/preview'));
    await fileInput.setInputFiles(examplePath);
    expect((await previewResponse).status()).toBe(201);
    await expect(page.locator('#personnel-import-file-status')).toHaveText('Đã phân tích');
    await expect(page.locator('#personnel-import-file-detail')).toContainText('2 dòng dữ liệu');
    await page.locator('#personnel-import-next').click();
    await expect(page.locator('[data-personnel-step="roles"]')).toBeVisible();
    await expect(page.locator('#personnel-import-validate')).toBeEnabled();
    await expect(page.locator('#personnel-import-preview-tbody tr')).toHaveCount(2);
    await expect(page.locator('#personnel-import-metric-total')).toHaveText('2');
    await expect(page.locator('#toast-root')).toBeEmpty();

    await page.setViewportSize({ width: 1440, height: 1024 });
    await page.evaluate(() => window.scrollTo(0, 0));
    const desktopWidth = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(desktopWidth.scroll).toBeLessThanOrEqual(desktopWidth.client + 1);
    const desktopScreenshot = path.join(uat.trace.scenarioDir, 'personnel-import-desktop-1440x1024.png');
    await page.screenshot({ path: desktopScreenshot, animations: 'disabled' });
    await testInfo.attach('personnel-import-desktop-1440x1024', { path: desktopScreenshot, contentType: 'image/png' });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page.locator('#admin-module-nav')).toBeHidden();
    await expect(page.locator('[data-personnel-step="roles"]')).toBeVisible();
    const mobileWidth = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(mobileWidth.scroll).toBeLessThanOrEqual(mobileWidth.client + 1);
    const mobileActions = await page.locator('#personnel-import-cancel, #personnel-import-back, #personnel-import-validate').evaluateAll((buttons) => (
      buttons.filter((button) => getComputedStyle(button).display !== 'none').map((button) => ({
        id: button.id,
        width: button.getBoundingClientRect().width,
        height: button.getBoundingClientRect().height,
      }))
    ));
    expect(
      mobileActions.every((target) => target.width >= 44 && target.height >= 44),
      `Mobile personnel-import targets: ${JSON.stringify(mobileActions)}`,
    ).toBeTruthy();
    const mobileScreenshot = path.join(uat.trace.scenarioDir, 'personnel-import-mobile-390x844.png');
    await page.screenshot({ path: mobileScreenshot, animations: 'disabled' });
    await testInfo.attach('personnel-import-mobile-390x844', { path: mobileScreenshot, contentType: 'image/png' });
    await page.locator('#personnel-import-validate').scrollIntoViewIfNeeded();
    const mobilePrimaryActionVisible = await page.locator('#personnel-import-validate').evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return target === button || button.contains(target);
    });
    expect(mobilePrimaryActionVisible, 'Mobile personnel-import primary action must remain reachable').toBeTruthy();

    await page.setViewportSize({ width: 1440, height: 1024 });
    validateResponse = page.waitForResponse((response) => response.request().method() === 'POST'
      && response.url().includes('/personnel-import/batches/') && response.url().endsWith('/validate'));
    await page.locator('#personnel-import-validate').click();
    expect((await validateResponse).status()).toBe(200);
    await expect(page.locator('[data-personnel-step="review"]')).toBeVisible();
    await expect(page.locator('#personnel-import-metric-valid')).toHaveText('2');
    await expect(page.locator('#personnel-import-metric-error')).toHaveText('0');
    await page.locator('#personnel-import-reason').fill('Import synthetic personnel rows for PROMPT-07 UAT');
    const confirmationField = page.locator('#personnel-import-confirmation-field');
    if (await confirmationField.isVisible()) {
      const confirmation = await page.locator('#personnel-import-confirmation').getAttribute('placeholder');
      expect(confirmation).toMatch(/^COMMIT PERSONNEL IMPORT pib_/);
      await page.locator('#personnel-import-confirmation').fill(confirmation);
    }
    await expect(page.locator('#personnel-import-commit')).toBeEnabled();

    const commitRequests = [];
    const commitPattern = '**/qlcl/api/admin/authorization/personnel-import/batches/*/commit';
    await page.route(commitPattern, async (route) => {
      const request = route.request();
      commitRequests.push({
        idempotencyKey: request.headers()['idempotency-key'],
        checksum: JSON.parse(request.postData() || '{}').expectedBatchChecksum,
      });
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'personnel_import_batch_checksum_mismatch' }),
      });
    }, { times: 1 });
    let commitResponse = page.waitForResponse((response) => response.request().method() === 'POST'
      && response.url().endsWith('/commit'));
    await page.locator('#personnel-import-commit').click();
    expect((await commitResponse).status()).toBe(409);
    await expect(page.locator('#personnel-import-state')).toContainText('Checksum batch đã thay đổi');
    await expect(page.locator('#personnel-import-commit')).toBeEnabled();

    const realCommitRequest = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/commit'));
    commitResponse = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/commit'));
    await page.locator('#personnel-import-commit').click();
    const secondRequest = await realCommitRequest;
    expect((await commitResponse).status()).toBe(200);
    commitRequests.push({
      idempotencyKey: secondRequest.headers()['idempotency-key'],
      checksum: JSON.parse(secondRequest.postData() || '{}').expectedBatchChecksum,
    });
    expect(commitRequests).toHaveLength(2);
    expect(commitRequests[1]).toEqual(commitRequests[0]);
    await expect(page.locator('#personnel-import-success')).toBeVisible();
    await expect(page.locator('#personnel-import-success-summary')).toContainText('2 tạo mới');
    await page.locator('#personnel-import-return-users').click();
    await expect(page).toHaveURL(/#\/admin\/users$/);
    await expect(page.getByTestId('authorization-admin')).toBeVisible();

    const scoringManagerRole = `UAT_SCORING_MANAGER_${uat.config.runId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase()}`;
    const managerSetup = await page.evaluate(async ({ managerEmail, scoringManagerRole }) => {
      const userResponse = await fetch('/qlcl/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: managerEmail,
          display_name: 'UAT Scoring Manage-only User',
          role: 'Chuyên viên',
          reason: 'Create a synthetic manage-only user for scoring policy UAT',
        }),
      });
      await userResponse.text();
      const roleResponse = await fetch('/qlcl/api/admin/authorization/roles', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roleCode: scoringManagerRole,
          displayLabel: 'UAT Scoring Policy Manager',
          reason: 'Create synthetic scoring manager role for PROMPT-11 UAT',
        }),
      });
      await roleResponse.text();
      const permissionResponse = await fetch(`/qlcl/api/admin/authorization/roles/${scoringManagerRole}/permissions`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          permissions: [{ permissionCode: 'SCORING_POLICY.MANAGE', effect: 'ALLOW' }],
          reason: 'Grant only scoring management for PROMPT-11 synthetic UAT',
          confirmation: `PUBLISH ROLE ${scoringManagerRole}`,
        }),
      });
      await permissionResponse.text();
      const assignmentResponse = await fetch(`/qlcl/api/admin/authorization/users/${encodeURIComponent(managerEmail)}/roles`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roles: [{ roleCode: scoringManagerRole }],
          reason: 'Assign manage-only scoring role for PROMPT-11 synthetic UAT',
          confirmation: `ASSIGN ROLES ${managerEmail}`,
        }),
      });
      await assignmentResponse.text();
      return {
        user: userResponse.status,
        role: roleResponse.status,
        permissions: permissionResponse.status,
        assignment: assignmentResponse.status,
      };
    }, { managerEmail: uat.config.managerEmail, scoringManagerRole });
    expect(managerSetup).toEqual({ user: 200, role: 201, permissions: 200, assignment: 200 });

    await page.locator('#btn-logout').click();
    await expect(login.view).toBeVisible();
    await login.loginWithLocalScreenOtp(uat.config.managerEmail);
    await app.waitForSession(uat.config.managerEmail);
    await page.evaluate(() => { window.location.hash = '/admin/scoring-policies'; });
    await expect(page.locator('#scoring-policy-workspace')).toBeVisible();
    await expect(page.locator('#scoring-policy-simulate')).toBeEnabled();
    await expect(page.locator('#scoring-policy-impact')).toBeEnabled();
    await expect(page.locator('#scoring-policy-publish')).toBeHidden();
    await page.locator('#scoring-policy-simulate').click();
    await expect(page.locator('#scoring-policy-pane-simulation')).toBeVisible();
    await expect(page.locator('#scoring-policy-simulation-tbody tr')).toHaveCount(6);
    const forbiddenQuestionPublishStatus = await page.evaluate(async () => {
      // Authorization runs before resource lookup. Fixed synthetic identifiers
      // keep this denial check independent from QUESTION_TEMPLATE.READ.
      const response = await fetch('/qlcl/api/question-templates/1/versions/1/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expected_lock_version: 1 }),
      });
      await response.text();
      return response.status;
    });
    expect(forbiddenQuestionPublishStatus).toBe(403);
    let importApiRequests = 0;
    page.on('request', (request) => {
      if (request.url().includes('/admin/authorization/personnel-import/')) importApiRequests += 1;
    });
    await page.evaluate(() => { window.location.hash = '/admin/personnel-import'; });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await app.waitForSession(uat.config.managerEmail);
    await expect(page.getByTestId('route-denied-view')).toBeVisible();
    expect(importApiRequests).toBe(0);
    const unexpectedConsoleErrors = consoleErrors.filter((message) => !/status of (401|403|409) \((Unauthorized|Forbidden|Conflict)\)/.test(message));
    expect(unexpectedConsoleErrors).toEqual([]);
    const unexpectedNetworkErrors = networkErrors.filter((message) => !/\/qlcl\/winmart-logo\.png$/.test(message));
    expect(unexpectedNetworkErrors).toEqual([]);
  });

  test('local synthetic authorization workspace composes roles and blocks self escalation', async ({ page, uat }) => {
    test.skip(uat.config.mode !== 'local', 'Authorization mutations run only against the temporary local database.');
    test.setTimeout(90_000);
    const login = new LoginPage(page);
    const app = new AppShell(page);
    const suffix = uat.config.runId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase();
    const baseRole = `UAT_${suffix}_BASE`;
    const cloneRole = `UAT_${suffix}_CLONE`;
    const managerRole = `UAT_${suffix}_MANAGER`;
    const targetEmail = `uat.target.${suffix.toLowerCase()}@example.test`;

    await login.open(uat.config.baseUrl);
    await login.loginWithLocalScreenOtp(uat.config.adminEmail);
    await app.waitForSession(uat.config.adminEmail);

    const userSetup = await page.evaluate(async ({ targetEmail, managerEmail }) => {
      const create = async (email, displayName) => {
        const response = await fetch('/qlcl/api/admin/users', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email,
            display_name: displayName,
            role: 'Chuyên viên',
            reason: 'Create a synthetic account for authorization workspace UAT',
          }),
        });
        const status = response.status;
        await response.text();
        return status;
      };
      return {
        target: await create(targetEmail, 'UAT Authorization Target'),
        manager: await create(managerEmail, 'UAT Authorization Manager'),
      };
    }, { targetEmail, managerEmail: uat.config.managerEmail });
    expect(userSetup).toEqual({ target: 200, manager: 200 });

    await page.evaluate(() => { window.location.hash = '/admin/roles'; });
    await expect(page.getByTestId('authorization-admin')).toBeVisible();
    await expect(page.locator('[data-authz-tab="roles"]')).toHaveAttribute('aria-selected', 'true');

    await page.locator('#authz-new-role').click();
    await page.locator('#authz-role-code').fill(baseRole);
    await page.locator('#authz-role-label').fill('UAT Base Role');
    await page.locator('#authz-role-reason').fill('Create a synthetic empty role for authorization UAT');
    const createResponse = page.waitForResponse((response) => response.request().method() === 'POST'
      && response.url().endsWith('/qlcl/api/admin/authorization/roles'));
    await page.locator('#authz-save-role').click();
    expect((await createResponse).status()).toBe(201);
    await expect(page.locator('#authz-role-list')).toContainText(baseRole);

    const readOnlyRole = page.locator('[data-action-id="authorization.role_select"]').filter({ hasText: 'READ_ONLY_VIEWER' });
    await expect(readOnlyRole).toHaveCount(1);
    await readOnlyRole.click();
    await page.locator('#authz-clone-role').click();
    await page.locator('#authz-role-code').fill(cloneRole);
    await page.locator('#authz-role-label').fill('UAT Cloned Viewer');
    await page.locator('#authz-role-reason').fill('Clone the read-only role for deterministic authorization UAT');
    const cloneResponse = page.waitForResponse((response) => response.request().method() === 'POST'
      && response.url().endsWith('/qlcl/api/admin/authorization/roles'));
    await page.locator('#authz-save-role').click();
    expect((await cloneResponse).status()).toBe(201);
    await expect(page.locator('#authz-role-list')).toContainText(cloneRole);
    await expect(page.locator('#authz-role-code')).toHaveValue(cloneRole);
    await expect(page.locator('#authz-role-label')).toHaveValue('UAT Cloned Viewer');

    await page.locator('#authz-role-label').fill('Unsaved synthetic role draft');
    await page.locator('#desktop-navigation [data-navigation-id="nav-overview"]').click();
    await expect(page.locator('#confirm-modal')).toBeVisible();
    await page.locator('#confirm-cancel').click();
    await expect(page).toHaveURL(/#\/admin\/roles$/);
    await expect(page.getByTestId('authorization-admin')).toBeVisible();
    await expect(page.locator('#authz-role-label')).toHaveValue('Unsaved synthetic role draft');
    await page.locator('#desktop-navigation [data-navigation-id="nav-overview"]').click();
    await expect(page.locator('#confirm-modal')).toBeVisible();
    await page.locator('#confirm-accept').click();
    await expect(page.locator('#view-overview')).toBeVisible();
    await page.evaluate(() => { window.location.hash = '/admin/roles'; });
    await expect(page.getByTestId('authorization-admin')).toBeVisible();
    const clonedRoleAfterDiscard = page.locator('[data-action-id="authorization.role_select"]').filter({ hasText: cloneRole });
    await clonedRoleAfterDiscard.click();

    await page.locator('[data-authz-tab="permissions"]').click();
    await page.locator('#authz-permission-search').fill('REPORT.READ');
    await expect(page.locator('[data-authz-permission-code="REPORT.READ"]')).toBeVisible();
    await page.locator('[data-authz-permission-code="REPORT.READ"]').selectOption('ALLOW_DENY');
    await expect(page.locator('#authz-after-summary')).toContainText('DENY_WINS');
    await page.locator('#authz-permission-reason').fill('Publish a synthetic allow and deny pair to verify deterministic conflict resolution');
    const permissionResponse = page.waitForResponse((response) => response.request().method() === 'PUT'
      && response.url().endsWith(`/qlcl/api/admin/authorization/roles/${cloneRole}/permissions`));
    await page.locator('#authz-save-permissions').click();
    expect((await permissionResponse).status()).toBe(200);
    await expect(page.getByText('Đã publish ma trận quyền.', { exact: true })).toBeVisible();
    await expect(page.locator('[data-authz-permission-code="REPORT.READ"]')).toHaveValue('ALLOW_DENY');

    await page.locator('[data-authz-tab="users"]').click();
    await page.locator('#authz-user-search').fill(targetEmail);
    const targetRow = page.locator(`[data-authz-user-email="${targetEmail}"]`);
    await expect(targetRow).toHaveCount(1);
    const targetDetailResponse = page.waitForResponse((response) => response.request().method() === 'GET'
      && response.url().includes(`/qlcl/api/admin/authorization/users/${encodeURIComponent(targetEmail)}`));
    await targetRow.focus();
    await targetRow.press('Enter');
    expect((await targetDetailResponse).status()).toBe(200);
    await expect(page.locator('#authz-user-detail-sub')).toContainText(targetEmail);
    await page.locator(`[data-authz-user-role="${baseRole}"]`).check();
    await page.locator(`[data-authz-user-role="${cloneRole}"]`).check();
    await page.locator(`[data-authz-role-until="${cloneRole}"]`).fill('2027-12-31T23:00');
    await page.locator('#authz-user-role-reason').fill('Assign multiple synthetic roles with an explicit validity window');
    await page.locator('#authz-user-role-confirm').fill(`ASSIGN ROLES ${targetEmail}`);
    const assignmentResponse = page.waitForResponse((response) => response.request().method() === 'PUT'
      && response.url().includes(`/qlcl/api/admin/authorization/users/${encodeURIComponent(targetEmail)}/roles`));
    await page.locator('#authz-save-user-roles').click();
    expect((await assignmentResponse).status()).toBe(200);
    await expect(page.locator('#authz-user-effective')).toContainText('REPORT.READ');
    await expect(page.locator('#authz-user-effective')).toContainText('DENY_WINS');
    await page.locator('#authz-user-advanced-filters > summary').click();
    await page.locator('#authz-user-health-filter').selectOption('conflict');
    await expect(targetRow).toHaveCount(1);

    await page.locator('[data-authz-tab="roles"]').click();
    const cloneRoleCard = page.locator('[data-action-id="authorization.role_select"]').filter({ hasText: cloneRole });
    await cloneRoleCard.click();
    await expect(page.locator('#authz-delete-role')).toBeDisabled();
    await expect(page.locator('#authz-role-delete-reason')).toContainText('lượt gán người dùng (kể cả lịch sử)');

    const managerSetup = await page.evaluate(async ({ managerEmail, managerRole }) => {
      const request = async (path, method, body) => {
        const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const status = response.status;
        await response.text();
        return status;
      };
      const createStatus = await request('/qlcl/api/admin/authorization/roles', 'POST', {
        roleCode: managerRole, displayLabel: 'UAT Authorization Manager',
        reason: 'Create a synthetic manager role for self escalation UAT',
      });
      const permissionStatus = await request(`/qlcl/api/admin/authorization/roles/${managerRole}/permissions`, 'PUT', {
        permissions: [{ permissionCode: 'USER.MANAGE', effect: 'ALLOW' }],
        reason: 'Grant synthetic authorization management for self escalation UAT',
        confirmation: `PUBLISH ROLE ${managerRole}`,
      });
      const assignmentStatus = await request(`/qlcl/api/admin/authorization/users/${encodeURIComponent(managerEmail)}/roles`, 'PUT', {
        roles: [{ roleCode: managerRole, validFrom: null, validUntil: null }],
        reason: 'Assign the synthetic manager role for self escalation UAT',
        confirmation: `ASSIGN ROLES ${managerEmail}`,
      });
      return { createStatus, permissionStatus, assignmentStatus };
    }, { managerEmail: uat.config.managerEmail, managerRole });
    expect(managerSetup).toEqual({ createStatus: 201, permissionStatus: 200, assignmentStatus: 200 });

    await page.locator('#btn-logout').click();
    await expect(login.view).toBeVisible();
    await login.loginWithLocalScreenOtp(uat.config.managerEmail);
    await app.waitForSession(uat.config.managerEmail);
    await page.evaluate(() => { window.location.hash = '/admin/users'; });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await app.waitForSession(uat.config.managerEmail);
    await expect(page.getByTestId('authorization-admin')).toBeVisible();
    await page.locator('#authz-user-search').fill(uat.config.managerEmail);
    const managerRow = page.locator(`[data-authz-user-email="${uat.config.managerEmail}"]`);
    const managerDetailResponse = page.waitForResponse((response) => response.request().method() === 'GET'
      && response.url().includes(`/qlcl/api/admin/authorization/users/${encodeURIComponent(uat.config.managerEmail)}`));
    await managerRow.focus();
    await managerRow.press('Enter');
    expect((await managerDetailResponse).status()).toBe(200);
    await expect(page.locator('#authz-user-detail-title')).toHaveText('UAT Authorization Manager');
    await page.locator('[data-authz-user-role="SYS_ADMIN"]').check();
    await page.locator('#authz-user-role-reason').fill('Attempt prohibited synthetic self escalation to system administrator');
    await page.locator('#authz-user-role-confirm').fill(`ASSIGN ROLES ${uat.config.managerEmail}`);
    const selfEscalationResponse = page.waitForResponse((response) => response.request().method() === 'PUT'
      && response.url().includes(`/qlcl/api/admin/authorization/users/${encodeURIComponent(uat.config.managerEmail)}/roles`));
    await page.locator('#authz-save-user-roles').click();
    expect((await selfEscalationResponse).status()).toBe(409);
    await expect(page.locator('[data-authz-state-message]')).toContainText('Không thể tự mở rộng quyền');
  });
});
