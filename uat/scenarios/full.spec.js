const { test, expect } = require('../fixtures/uatTest');
const { LoginPage } = require('../pages/LoginPage');
const { AppShell } = require('../pages/AppShell');

test.describe('@full RUN-23 integrated release rehearsal', () => {
  test('synthetic admin traces guarded modules, immutable versions and package-critical regressions', async ({ page, uat }) => {
    test.skip(uat.config.mode !== 'local', 'Full mutation rehearsal is local/staging only.');
    const login = new LoginPage(page);
    const app = new AppShell(page);
    await login.open(uat.config.baseUrl);
    await login.loginWithLocalScreenOtp(uat.config.adminEmail);
    await app.waitForSession(uat.config.adminEmail);

    const matrix = await page.evaluate(async () => {
      const requests = [
        ['/qlcl/api/admin/authorization/catalog', 'authorization'],
        ['/qlcl/api/admin/audit-events?limit=10', 'audit'],
        ['/qlcl/api/master-data/merchandise-hierarchy', 'mch'],
        ['/qlcl/api/question-templates', 'questions'],
        ['/qlcl/api/report-templates/definitions', 'reports'],
        ['/qlcl/api/scoring-policies', 'scoring'],
      ];
      return Promise.all(requests.map(async ([url, id]) => {
        const response = await fetch(url);
        const body = await response.json();
        return { id, status: response.status, requestId: response.headers.get('x-request-id'), body };
      }));
    });
    expect(matrix.every((item) => item.status === 200 && item.requestId)).toBeTruthy();
    const mch = matrix.find((item) => item.id === 'mch').body.items;
    expect(mch.find((item) => String(item.mch3_id) === '20305').mch3_name).toBe('Điện gia dụng');
    expect(mch.find((item) => String(item.mch3_id) === '30101').mch3_name).toBe('Điện gia dụng');
    expect(matrix.find((item) => item.id === 'reports').body.items.map((item) => item.definition_code).sort()).toEqual([
      'ROUND1_RESULT', 'ROUND2_RESULT', 'WORKING_MINUTES',
    ]);

    await page.evaluate(() => { window.location.hash = '/admin/question-templates'; });
    await expect(page.locator('#question-management-workspace-root')).toBeVisible();
    await expect(page.locator('#question-published-readonly')).toBeVisible();
    await page.evaluate(() => { window.location.hash = '/admin/report-templates'; });
    await expect(page.locator('#report-template-workspace')).toBeVisible();
    await expect(page.locator('#report-template-readonly')).toBeVisible();
    await page.waitForLoadState('networkidle');

    const forbiddenRequests = [];
    page.on('request', (request) => {
      if (/\/qlcl\/api\/(?:admin\/authorization|report-templates)/.test(request.url())) forbiddenRequests.push(new URL(request.url()).pathname);
    });
    await page.route('**/qlcl/api/auth/me', async (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        email: 'readonly.run23@example.invalid',
        display_name: 'RUN-23 READ ONLY',
        role: 'Chuyên viên',
        isAdmin: false,
        capabilities: ['DASHBOARD.READ'],
        role_codes: ['READ_ONLY_VIEWER'],
        authz_version: 23,
        navigation_version: 2,
        action_version: 3,
      }),
    }));
    forbiddenRequests.length = 0;
    await page.evaluate(() => { window.location.hash = '/admin/report-templates'; });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('route-denied-view')).toBeVisible();
    expect(forbiddenRequests).toEqual([]);
  });
});
