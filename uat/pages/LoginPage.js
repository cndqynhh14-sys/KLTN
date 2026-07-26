class LoginPage {
  constructor(page) {
    this.page = page;
    this.view = page.getByTestId('login-view');
    this.email = page.getByTestId('login-email');
    this.requestOtpButton = page.locator('[data-action-id="auth.request_otp"]');
    this.otpView = page.getByTestId('otp-view');
    this.screenOtpCallout = page.locator('#screen-otp-callout');
    this.copyScreenOtpButton = page.locator('#btn-copy-screen-otp');
    this.otpInput = page.getByTestId('otp-code');
    this.verifyButton = page.locator('[data-action-id="auth.verify_otp"]');
  }

  async open(baseUrl) {
    await this.page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await this.view.waitFor({ state: 'visible' });
  }

  async requestOtp(email) {
    await this.email.fill(email);
    await this.requestOtpButton.click();
  }

  async loginWithLocalScreenOtp(email) {
    await this.requestOtp(email);
    await this.otpView.waitFor({ state: 'visible' });
    await this.screenOtpCallout.waitFor({ state: 'visible' });
    // Exercise the explicit Copy action without reading the OTP into UAT output or trace.
    await this.copyScreenOtpButton.click();
    await this.page.locator('#otp-msg').filter({ hasText: 'Đã sao chép' }).waitFor({ state: 'visible' });
    await this.otpInput.focus();
    await this.page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
    await this.verifyButton.click();
  }
}

module.exports = { LoginPage };
