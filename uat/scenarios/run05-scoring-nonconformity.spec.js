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
    return {
      status: response.status,
      body: await response.json().catch(() => ({})),
      requestId: response.headers.get('x-request-id'),
    };
  }, { apiPath: path, requestOptions: options });
}

test.describe('@smoke RUN-05 scoring nonconformity rendering', () => {
  test('creates a ticket, records a D finding, recalculates to A, and completes with the persisted result', async ({ page, uat }) => {
    test.skip(uat.config.mode !== 'local', 'RUN-05 mutation UAT only runs against the isolated local database.');
    test.setTimeout(90_000);

    const login = new LoginPage(page);
    const app = new AppShell(page);
    await login.open(uat.config.baseUrl);
    await login.loginWithLocalScreenOtp(uat.config.adminEmail);
    await app.waitForSession(uat.config.adminEmail);

    const browserErrors = [];
    page.on('pageerror', (error) => browserErrors.push(`pageerror:${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(`console:${message.text()}`);
    });

    const suffix = uat.config.runId.slice(0, 8).toUpperCase();
    const supplier = await browserApi(page, '/suppliers', {
      method: 'POST',
      body: {
        supplier_code: `RUN05-${suffix}`,
        supplier_name: 'RUN-05 Synthetic Supplier',
        tax_code: `RUN05TAX${suffix.replace(/[^0-9]/g, '').padEnd(4, '0').slice(0, 4)}`,
        address: 'Synthetic headquarters',
        production_address: 'Synthetic production site',
        evaluation_address: 'Synthetic evaluation site',
        region: 'MB',
        province: 'Tỉnh Tuyên Quang',
        business_type: 'Tự sản xuất',
        contact_name: 'RUN-05 QA',
        contact_email: 'run05@example.test',
        contact_phone: '0900000000',
        mch2: 'Homeline',
        mch3: 'Đồ chơi/Giải trí thể thao',
        product_name: 'RUN-05 synthetic product',
      },
    });
    expect(supplier.status).toBe(201);
    expect(supplier.requestId).toBeTruthy();

    const variants = await browserApi(page, '/question-templates/variants');
    expect(variants.status).toBe(200);
    const variant = variants.body.items.find((item) => item.template_code === 'BM01' && item.supplier_scale === 'LARGE');
    expect(variant).toBeTruthy();
    const created = await browserApi(page, '/evaluations', {
      method: 'POST',
      body: {
        supplier_id: supplier.body.item.id,
        evaluation_type: 'Đánh giá định kỳ',
        template: 'BM01',
        facility_type: variant.facility_type,
        supplier_scale: variant.supplier_scale,
        evaluation_method: 'Trực tiếp',
        planned_date: '2026-08-01',
        actual_evaluation_date: '2026-08-03',
        snapshot_evaluation_address: 'Synthetic evaluation site',
        cmc_owner: 'RUN-05 CMC owner',
        cmc_head: 'RUN-05 CMC head',
        mch2: 'Homeline',
        mch3: 'Đồ chơi/Giải trí thể thao',
        snapshot_product_name: 'RUN-05 synthetic product',
      },
    });
    expect(created.status).toBe(201);
    expect(created.requestId).toBeTruthy();
    const ticketCode = created.body.ticket.ticket_code;

    await page.reload({ waitUntil: 'domcontentloaded' });
    await app.waitForSession(uat.config.adminEmail);
    await page.evaluate((code) => {
      window.location.hash = `/evaluations/scoring?ticket=${encodeURIComponent(code)}`;
    }, ticketCode);
    await expect(page.locator('#view-scoring')).toBeVisible();
    await expect(page.locator('#scoring-ticket-select')).toHaveValue(ticketCode);
    await expect(page.locator('[data-question-id]').first()).toBeVisible();

    const dQuestionId = await page.evaluate(() => {
      const controls = Array.from(document.querySelectorAll('[data-question-id]'));
      controls.forEach((control) => { control.value = 'A'; });
      const dControl = controls.find((control) => Array.from(control.options).some((option) => option.value === 'D'));
      if (!dControl) throw new Error('RUN-05 synthetic fixture has no D option');
      dControl.value = 'D';
      const note = document.querySelector(`[data-note-id="${CSS.escape(dControl.dataset.questionId)}"]`);
      note.value = 'RUN-05 synthetic D finding';
      dControl.dispatchEvent(new Event('change', { bubbles: true }));
      return dControl.dataset.questionId;
    });

    await expect(page.locator('#nonconformity-count')).toHaveText('1 điều khoản');
    await expect(page.locator('#nonconformity-tbody tr')).toHaveCount(1);
    await expect(page.locator('#nonconformity-tbody')).toContainText('RUN-05 synthetic D finding');
    const remediation = page.locator('[data-nc-draft-remediation]');
    const dueDate = page.locator('[data-nc-draft-due-date]');
    await expect(remediation).toBeEditable();
    await expect(dueDate).toBeEditable();
    await expect(dueDate).toHaveAttribute('min', '2026-08-03');
    await expect(dueDate).toHaveValue('2026-08-10');

    await remediation.selectOption({ index: 1 });
    const remediationValue = await remediation.inputValue();
    await dueDate.fill('2026-08-15');
    await dueDate.dispatchEvent('change');

    const saveResponse = page.waitForResponse((response) => (
      response.request().method() === 'PUT'
      && response.url().includes(`/evaluations/${ticketCode}/rounds/1/answers`)
    ));
    await page.locator('#btn-save-scoring-draft').click();
    expect((await saveResponse).status()).toBe(200);
    await expect(page.locator('#scoring-msg')).toContainText('Đã lưu tạm');
    await expect(page.locator('#nonconformity-tbody tr')).toHaveCount(1);
    await expect(page.locator('[data-nc-remediation]')).toHaveValue(remediationValue);
    await expect(page.locator('[data-nc-due-date]')).toHaveValue('2026-08-15');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await app.waitForSession(uat.config.adminEmail);
    await expect(page.locator('[data-question-id]').first()).toBeVisible();
    await expect(page.locator('#nonconformity-count')).toHaveText('1 điều khoản');
    await expect(page.locator('#nonconformity-tbody tr')).toHaveCount(1);
    await expect(page.locator('[data-nc-remediation]')).toHaveValue(remediationValue);
    await expect(page.locator('[data-nc-due-date]')).toHaveValue('2026-08-15');

    await page.locator(`[data-question-id="${dQuestionId}"]`).selectOption('A');
    await expect(page.locator('#nonconformity-count')).toHaveText('0 điều khoản');
    await expect(page.locator('#nonconformity-tbody tr')).toHaveCount(0);
    const clearResponse = page.waitForResponse((response) => (
      response.request().method() === 'PUT'
      && response.url().includes(`/evaluations/${ticketCode}/rounds/1/answers`)
    ));
    await page.locator('#btn-save-scoring-draft').click();
    expect((await clearResponse).status()).toBe(200);
    await expect(page.locator('#scoring-msg')).toContainText('Đã lưu tạm');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await app.waitForSession(uat.config.adminEmail);
    await expect(page.locator('#nonconformity-count')).toHaveText('0 điều khoản');
    await expect(page.locator('#nonconformity-tbody tr')).toHaveCount(0);

    await page.locator('#btn-add-attendee').click();
    await page.locator('[data-attendee-index="0"]').fill('RUN-05 synthetic QA attendee');
    await page.locator('[data-attendee-opening="0"]').check();
    await page.locator('[data-attendee-closing="0"]').check();
    await page.locator('#supplier-introduction-input').fill('RUN-05 synthetic supplier introduction.');
    const completeResponse = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && response.url().includes(`/evaluations/${ticketCode}/rounds/1/complete`)
    ));
    await page.locator('#btn-complete-scoring').click();
    expect((await completeResponse).status()).toBe(200);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await app.waitForSession(uat.config.adminEmail);
    await expect(page.locator('#score-overall')).toHaveText('100.0%');
    await expect(page.locator('#score-classification')).toContainText('Đạt');
    await expect(page.locator('#btn-save-scoring-draft')).toBeHidden();
    await expect(page.locator('#btn-complete-scoring')).toBeHidden();
    await expect(page.locator('[data-question-id]').first()).toBeDisabled();

    await expect(page.locator('#btn-end-evaluation')).toBeVisible();
    const endResponse = page.waitForResponse((response) => (
      response.request().method() === 'PATCH'
      && response.url().includes(`/evaluations/${ticketCode}`)
    ));
    await page.locator('#btn-end-evaluation').click();
    await expect(page.locator('#confirm-modal')).toBeVisible();
    await page.locator('#confirm-accept').click();
    expect((await endResponse).status()).toBe(200);
    await expect(page.locator('#scoring-status')).toContainText('Hoàn thành');
    expect(browserErrors).toEqual([]);

    uat.trace.record('run05.synthetic.completed', {
      ticket_code: ticketCode,
      persisted_nonconformity_count: 1,
      cleared_nonconformity_count: 0,
      final_score: '100.0%',
      final_status: 'Hoàn thành',
    });
  });
});
