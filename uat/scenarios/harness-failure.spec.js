const { test, expect } = require('../fixtures/uatTest');
const { LoginPage } = require('../pages/LoginPage');

test.describe('@evidence-failure controlled harness evidence', () => {
  test('captures a masked screenshot, safe trace and request IDs on failure', async ({ page, uat }) => {
    test.skip(process.env.UAT_EXPECT_FAILURE !== 'true', 'Only run explicitly to verify failure evidence.');
    const login = new LoginPage(page);
    await login.open(uat.config.baseUrl);
    await expect(login.view).toBeVisible();
    await login.requestOtp(uat.config.adminEmail);
    await login.otpView.waitFor({ state: 'visible' });
    expect('controlled-failure').toBe('expected-pass');
  });
});
