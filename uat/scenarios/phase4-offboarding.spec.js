const { test, expect } = require('../fixtures/uatTest');
const { LoginPage } = require('../pages/LoginPage');
const { AppShell } = require('../pages/AppShell');

test.describe('@phase4 offboarding integration', () => {
  test('deactivate action loads workload, transfers it, deactivates the user, and refreshes the row', async ({ page, uat }) => {
    test.skip(uat.config.mode !== 'local', 'Phase 4 mutations run only against the temporary local database.');
    test.setTimeout(90_000);

    const login = new LoginPage(page);
    const app = new AppShell(page);
    const suffix = uat.config.runId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase();
    const targetEmail = `phase4.target.${suffix}@example.test`;
    const recipientEmail = `phase4.recipient.${suffix}@example.test`;
    const responseErrors = [];
    const pageErrors = [];

    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('response', (response) => {
      if (response.status() === 401 && response.url().endsWith('/qlcl/api/auth/me')) return;
      if (response.status() >= 400) responseErrors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    });

    await login.open(uat.config.baseUrl);
    await login.loginWithLocalScreenOtp(uat.config.adminEmail);
    await app.waitForSession(uat.config.adminEmail);

    const setup = await page.evaluate(async ({ targetEmail, recipientEmail, suffix }) => {
      const post = async (url, body) => {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
      };
      const target = await post('/qlcl/api/admin/users', {
        email: targetEmail,
        display_name: 'Phase 4 Target',
        role: 'Chuyên viên',
        reason: 'Create the synthetic Phase 4 offboarding target',
      });
      const recipient = await post('/qlcl/api/admin/users', {
        email: recipientEmail,
        display_name: 'Phase 4 Recipient',
        role: 'Chuyên viên',
        reason: 'Create the synthetic Phase 4 transfer recipient',
      });
      const ticket = await post('/qlcl/api/evaluations', {
        supplier_code: `PHASE4-${suffix.toUpperCase()}`,
        supplier_name: 'Phase 4 Synthetic Supplier',
        tax_code: `P4TAX-${suffix.toUpperCase()}`,
        address: 'Synthetic supplier address',
        region: 'MB',
        province: 'Tỉnh Tuyên Quang',
        business_type: 'Tự sản xuất',
        snapshot_evaluation_address: 'Synthetic evaluation address',
        contact_name: 'Phase 4 Contact',
        email: 'phase4-supplier@example.test',
        phone: '0900000000',
        snapshot_product_name: 'Phase 4 synthetic product',
        cmc_owner: 'Phase 4 CMC owner',
        cmc_head: 'Phase 4 CMC head',
        evaluation_type: 'Dinh ky',
        template: 'BM03',
        facility_type: 'CO_SO_NUOI_TRONG',
        supplier_scale: 'LARGE',
        planned_date: '2026-08-20',
        mch2: 'Thực phẩm công nghệ',
        mch3: 'Thực phẩm khô',
        assigned_specialist_id: targetEmail,
      });
      return { target, recipient, ticket };
    }, { targetEmail, recipientEmail, suffix });

    expect(setup.target.status).toBe(200);
    expect(setup.recipient.status).toBe(200);
    expect(setup.ticket.status).toBe(201);
    const targetUserId = setup.target.body.user_id;
    const recipientUserId = setup.recipient.body.user_id;
    expect(targetUserId).toBeTruthy();
    expect(recipientUserId).toBeTruthy();

    await page.evaluate(() => { window.location.hash = '/admin/users'; });
    await expect(page.getByTestId('authorization-admin')).toBeVisible();
    const targetRow = page.locator('#admin-users-tbody tr').filter({ hasText: targetEmail });
    await expect(targetRow).toHaveCount(1);
    await expect(targetRow).toContainText('Đang hoạt động');

    const workloadResponsePromise = page.waitForResponse((response) => response.request().method() === 'GET'
      && response.url().endsWith(`/qlcl/api/admin/users/${targetUserId}/workload`));
    await targetRow.getByRole('button', { name: 'Mở danh sách thao tác' }).click({ force: true });
    const deactivateAction = page.locator('[role="menuitem"][data-action-id="authorization.user_deactivate"]');
    await expect(deactivateAction).toBeVisible();
    await deactivateAction.click({ force: true });

    const workloadResponse = await workloadResponsePromise;
    expect(workloadResponse.status()).toBe(200);
    const workload = await workloadResponse.json();
    expect(workload.summary).toEqual({
      total: 1,
      evaluation_tickets: 1,
      evaluation_approval_tasks: 0,
      approval_stage_assignments: 0,
    });
    expect(workload.eligible_recipients.some((user) => user.user_id === recipientUserId)).toBeTruthy();

    await expect(page.locator('#user-offboard-modal')).toBeVisible();
    await expect(page.locator('#user-offboard-summary')).toContainText('Có 1 công việc cần bàn giao');
    await expect(page.locator('#user-offboard-summary')).toContainText('1 phiếu đánh giá');
    await expect(page.locator('#user-offboard-recipient-field')).toBeVisible();
    await expect(page.locator(`#user-offboard-recipient option[value="${recipientUserId}"]`)).toContainText(recipientEmail);
    await page.locator('#user-offboard-recipient').selectOption(recipientUserId);
    await page.locator('#user-offboard-reason').fill('Employee offboarding with an approved Phase 4 handover');
    await expect(page.locator('#user-offboard-submit')).toBeEnabled();

    const offboardRequestPromise = page.waitForRequest((request) => request.method() === 'POST'
      && request.url().endsWith(`/qlcl/api/admin/users/${targetUserId}/offboard`));
    const offboardResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST'
      && response.url().endsWith(`/qlcl/api/admin/users/${targetUserId}/offboard`));
    await page.locator('#user-offboard-submit').click();
    const offboardRequest = await offboardRequestPromise;
    const offboardResponse = await offboardResponsePromise;
    expect(offboardRequest.headers()['idempotency-key']).toMatch(/^offboard-ui-/);
    expect(offboardRequest.postDataJSON()).toEqual({
      reason: 'Employee offboarding with an approved Phase 4 handover',
      transfer_to_user_id: recipientUserId,
    });
    expect(offboardResponse.status()).toBe(200);
    const offboard = await offboardResponse.json();
    expect(offboard.ok).toBe(true);
    expect(offboard.transferred_count).toBe(1);
    expect(offboard.user).toMatchObject({ user_id: targetUserId, active: false });
    expect(offboard.items[0].after.ticket.assigned_specialist_user_id).toBe(recipientUserId);

    await expect(page.locator('#user-offboard-modal')).toBeHidden();
    await expect(targetRow).toContainText('Đã khóa');
    await targetRow.getByRole('button', { name: 'Mở danh sách thao tác' }).click({ force: true });
    await expect(page.locator('[role="menuitem"][data-action-id="authorization.user_reactivate"]')).toBeVisible();

    const workloadAfter = await page.evaluate(async (targetUserId) => {
      const response = await fetch(`/qlcl/api/admin/users/${targetUserId}/workload`);
      return { status: response.status, body: await response.json() };
    }, targetUserId);
    expect(workloadAfter.status).toBe(200);
    expect(workloadAfter.body.summary.total).toBe(0);
    expect(pageErrors).toEqual([]);
    expect(responseErrors).toEqual([]);
  });
});
