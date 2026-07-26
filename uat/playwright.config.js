const { defineConfig } = require('@playwright/test');
const { loadUatConfig } = require('./helpers/runtimeConfig');

const uat = loadUatConfig();

module.exports = defineConfig({
  testDir: './scenarios',
  timeout: 45_000,
  expect: { timeout: 12_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  outputDir: process.env.UAT_PLAYWRIGHT_TEMP_DIR,
  reporter: [
    ['./reporters/SafeEvidenceReporter.js', { outputDir: uat.outputDir }],
  ],
  use: {
    baseURL: uat.baseUrl,
    browserName: 'chromium',
    channel: process.env.UAT_BROWSER_CHANNEL || undefined,
    viewport: { width: 1366, height: 900 },
    acceptDownloads: false,
    screenshot: 'off',
    trace: 'off',
    video: 'off',
  },
});
