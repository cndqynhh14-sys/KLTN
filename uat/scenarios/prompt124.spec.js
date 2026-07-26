const { test, expect } = require('../fixtures/uatTest');
const { LoginPage } = require('../pages/LoginPage');
const { AppShell } = require('../pages/AppShell');

async function browserApi(page, path, options = {}) {
  return page.evaluate(async ({ apiPath, requestOptions }) => {
    const response = await fetch(`/qlcl/api${apiPath}`, {
      ...requestOptions,
      headers: requestOptions.body ? { 'Content-Type': 'application/json', ...(requestOptions.headers || {}) } : requestOptions.headers,
      body: requestOptions.body ? JSON.stringify(requestOptions.body) : undefined,
    });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, body, requestId: response.headers.get('x-request-id') };
  }, { apiPath: path, requestOptions: options });
}

test.describe('@prompt124 evaluation scoring regression', () => {
  test('ticket-scoped criteria, scoring controls, actions and module navigation stay coherent', async ({ page, uat }) => {
    test.setTimeout(90_000);
    test.skip(uat.config.mode !== 'local', 'PROMPT-124 mutation UAT only runs against an isolated local database.');
    const login = new LoginPage(page);
    const app = new AppShell(page);
    await login.open(uat.config.baseUrl);
    await login.loginWithLocalScreenOtp(uat.config.adminEmail);
    await app.waitForSession(uat.config.adminEmail);

    const suffix = uat.config.runId.slice(0, 8);
    const supplier = await browserApi(page, '/suppliers', {
      method: 'POST',
      body: {
        supplier_code: `P124-${suffix}`,
        supplier_name: 'PROMPT-124 Synthetic Supplier',
        tax_code: `031${suffix.replace(/[^0-9]/g, '').padEnd(7, '0').slice(0, 7)}`,
        address: 'Synthetic HQ',
        production_address: 'Synthetic factory',
        evaluation_address: 'Synthetic audit site',
        region: 'MB',
        province: 'Tỉnh Tuyên Quang',
        business_type: 'Tự sản xuất',
        contact_name: 'Synthetic QA',
        contact_email: 'synthetic.prompt124@example.test',
        contact_phone: '0900000000',
        mch2: 'Homeline',
        mch3: 'Đồ chơi/Giải trí thể thao',
        product_name: 'Synthetic product',
      },
    });
    expect(supplier.status).toBe(201);
    expect(supplier.requestId).toBeTruthy();

    const variants = await browserApi(page, '/question-templates/variants');
    expect(variants.status).toBe(200);
    const variantFor = (templateCode) => variants.body.items.find((item) => item.template_code === templateCode && item.supplier_scale === 'LARGE');
    const createTicket = async (templateCode) => {
      const variant = variantFor(templateCode);
      expect(variant).toBeTruthy();
      const response = await browserApi(page, '/evaluations', {
        method: 'POST',
        body: {
          supplier_id: supplier.body.item.id,
          evaluation_type: 'Đánh giá định kỳ',
          template: templateCode,
          facility_type: variant.facility_type,
          supplier_scale: variant.supplier_scale,
          evaluation_method: 'Trực tiếp',
          planned_date: '2026-07-20',
        },
      });
      expect(response.status).toBe(201);
      expect(response.requestId).toBeTruthy();
      return response.body.ticket.ticket_code;
    };
    const ticketA = await createTicket('BM01');
    const ticketB = await createTicket('BM04');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await app.waitForSession(uat.config.adminEmail);

    const openScoring = async (ticketCode) => {
      await page.evaluate((code) => { window.location.hash = `/evaluations/scoring?ticket=${encodeURIComponent(code)}`; }, ticketCode);
      await expect(page.locator('#view-scoring')).toBeVisible();
      await expect(page.locator('#scoring-ticket-select')).toHaveValue(ticketCode);
      await expect(page.locator('[data-scoring-question-row]').first()).toBeVisible();
      return page.locator('[data-scoring-question-row]').count();
    };

    const countA = await openScoring(ticketA);
    const navLabels = await page.locator('#module-navigation [data-route-tab]').allTextContents();
    expect(navLabels.map((label) => label.trim())).toEqual(['Phiếu đánh giá', 'Tạo phiếu đánh giá', 'Chấm điểm', 'Báo cáo']);
    expect(await openScoring(ticketB)).toBeGreaterThan(0);
    expect(await openScoring(ticketA)).toBe(countA);

    await page.locator('[data-question-id]').first().selectOption('A');
    await page.locator('#btn-save-scoring-draft').click();
    await expect(page.locator('#scoring-msg')).toContainText('Đã lưu tạm');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await app.waitForSession(uat.config.adminEmail);
    await expect(page).toHaveURL(new RegExp(`evaluations/scoring\\?ticket=${ticketA}`));
    await expect(page.locator('[data-scoring-question-row]').first()).toBeVisible();
    await expect(page.locator('[data-question-id]').first()).toHaveValue('A');

    await page.locator('#btn-add-attendee').click();
    await page.locator('[data-attendee-index="0"]').fill('Synthetic QA attendee');
    await page.locator('[data-attendee-opening="0"]').check();
    await page.locator('[data-attendee-closing="0"]').check();
    await page.locator('#supplier-introduction-input').fill('Synthetic supplier introduction for PROMPT-124 UAT.');
    await page.evaluate(() => {
      document.querySelectorAll('[data-question-id]').forEach((control) => { control.value = 'A'; });
    });
    const completeResponse = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().includes(`/evaluations/${ticketA}/rounds/1/complete`));
    await page.evaluate(() => {
      window.setTimeout(() => document.querySelector('#btn-complete-scoring')?.click(), 0);
    });
    expect((await completeResponse).status()).toBe(200);

    // Reload the public seam after completion so this assertion also proves the
    // locked round and its action envelope survive a fresh application state.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await app.waitForSession(uat.config.adminEmail);
    await expect(page.locator('[data-scoring-question-row]').first()).toBeVisible();
    await expect(page.locator('#btn-save-scoring-draft')).toBeHidden();
    await expect(page.locator('#btn-complete-scoring')).toBeHidden();
    await expect(page.locator('[data-question-id]').first()).toBeDisabled();

    await expect(page.locator('#btn-end-evaluation')).toBeVisible();
    const endResponse = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().includes(`/evaluations/${ticketA}`));
    await page.evaluate(() => {
      window.setTimeout(() => document.querySelector('#btn-end-evaluation')?.click(), 0);
    });
    await expect(page.locator('#confirm-modal')).toBeVisible();
    await page.locator('#confirm-accept').click();
    expect((await endResponse).status()).toBe(200);
    await expect(page.locator('#scoring-status')).toContainText('Hoàn thành');

    await page.evaluate(() => { window.location.hash = '/evaluations'; });
    await expect(page.locator('#view-evaluations')).toBeVisible();
    const completedRow = page.locator('#eval-tbody tr').filter({ hasText: ticketA }).first();
    const draftRow = page.locator('#eval-tbody tr').filter({ hasText: ticketB }).first();
    await expect(completedRow).toContainText('Hoàn thành');
    await expect(completedRow.locator('.icon-actions button')).toHaveCount(2);
    await expect(completedRow.locator('.more-action')).toHaveCount(0);
    await expect(draftRow.locator('.icon-actions button')).toHaveCount(3);
    await expect(draftRow.locator('.more-action')).toHaveCount(1);

    await page.evaluate((code) => { window.location.hash = `/scoring?ticket=${encodeURIComponent(code)}`; }, ticketB);
    await expect(page).toHaveURL(new RegExp(`evaluations/scoring\\?ticket=${ticketB}`));
    await expect(page.locator('#scoring-ticket-select')).toHaveValue(ticketB);

    await page.evaluate(() => { window.location.hash = '/reports'; });
    await expect(page.locator('#view-reports')).toBeVisible();
    await expect(page.locator('#module-navigation [data-route-tab="reports"]')).toHaveClass(/active/);
    await expect(page.locator('#desktop-navigation [data-navigation-id="nav-evaluations"]')).toHaveClass(/active/);

    // Rehydrate the same rows under a second, deterministic read-only identity.
    // Backend negative authorization is covered by the HTTP integration suite;
    // this browser seam verifies that no mutation action leaks into the UI.
    const readOnlyEmail = 'readonly.prompt124@example.invalid';
    await page.route('**/qlcl/api/auth/me', async (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        email: readOnlyEmail,
        displayName: 'PROMPT-124 Read Only',
        role: 'ChuyÃªn viÃªn',
        isAdmin: false,
        capabilities: ['EVALUATION.READ', 'REPORT.READ'],
        role_codes: ['PROMPT124_READ_ONLY'],
        authz_version: 124,
        navigation_version: 3,
        action_version: 5,
        degradedAuth: false,
      }),
    }));
    await page.evaluate(() => { window.location.hash = '/evaluations'; });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await app.waitForSession(readOnlyEmail);
    await expect(page.locator('#view-evaluations')).toBeVisible();
    for (const code of [ticketA, ticketB]) {
      const row = page.locator('#eval-tbody tr').filter({ hasText: code }).first();
      await expect(row.locator('.icon-actions .icon-btn:not(.more-action)')).toHaveCount(2);
      await expect(row.locator('.more-action')).toHaveCount(0);
      await expect(row.getByRole('button', { name: 'Cháº¥m Ä‘iá»ƒm phiáº¿u' })).toHaveCount(0);
      await expect(row.getByRole('button', { name: 'Chá»‰nh sá»­a phiáº¿u' })).toHaveCount(0);
      await expect(row.getByRole('button', { name: 'XÃ³a phiáº¿u nhÃ¡p' })).toHaveCount(0);
    }
  });
});
