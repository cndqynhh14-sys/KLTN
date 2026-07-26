class AppShell {
  constructor(page) {
    this.page = page;
    this.main = page.locator('#main');
    this.sidebar = page.locator('#sidebar');
    this.userEmail = page.locator('#user-email');
  }

  async waitForSession(email) {
    await this.main.waitFor({ state: 'visible' });
    await this.sidebar.waitFor({ state: 'visible' });
    await this.userEmail.waitFor({ state: 'visible' });
    await this.userEmail.filter({ hasText: email }).waitFor({ state: 'visible' });
  }

  async openSidebarRoute(navigationId, viewTestId) {
    await this.page.locator(`#desktop-navigation [data-navigation-id="${navigationId}"]`).click();
    await this.page.getByTestId(viewTestId).waitFor({ state: 'visible' });
  }

  async openReports() {
    await this.openSidebarRoute('nav-evaluations', 'evaluations-view');
    await this.page.locator('#module-navigation [data-route-tab="reports"]').click();
    await this.page.getByTestId('reports-view').waitFor({ state: 'visible' });
  }

  async openAdminUsers() {
    await this.openSidebarRoute('nav-admin', 'admin-view');
    await this.page.locator('#admin-dashboard [data-admin-route="admin-users"]').click();
    await this.page.locator('#admin-users-tbody').waitFor({ state: 'visible' });
  }

  async openSystemLogs() {
    await this.openSidebarRoute('nav-admin', 'admin-view');
    await this.page.locator('#admin-dashboard [data-admin-route="admin-system-logs"]').click();
    await this.page.getByTestId('system-logs-view').waitFor({ state: 'visible' });
    await this.page.locator('#system-log-loading').waitFor({ state: 'hidden' });
  }
}

module.exports = { AppShell };
