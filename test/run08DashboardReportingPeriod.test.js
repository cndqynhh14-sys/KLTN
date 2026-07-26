'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('RUN-08 reporting period helpers normalize labels, URL state and navigation', () => {
  const reportingPeriod = require('../public/js/reporting-period');
  const periods = reportingPeriod.normalizePeriods([
    { value: '2026-07', has_data: true, is_current: true, updated_at: '2026-07-16T02:30:00.000Z' },
    { value: '2026-06', has_data: true, is_current: false, updated_at: '2026-06-30T10:00:00.000Z' },
  ]);

  assert.equal(reportingPeriod.isValidPeriod('2026-07'), true);
  assert.equal(reportingPeriod.isValidPeriod('2026-7'), false);
  assert.equal(reportingPeriod.labelForPeriod('2026-07'), 'Tháng 07/2026');
  assert.equal(reportingPeriod.periodFromRoute('/dashboard?period=2026-06'), '2026-06');
  assert.equal(reportingPeriod.periodFromRoute('/dashboard?period=2026-6'), '');
  assert.equal(reportingPeriod.routeWithPeriod('/dashboard/ncc-evaluations?foo=1', '2026-06'), '/dashboard/ncc-evaluations?foo=1&period=2026-06');
  assert.deepEqual(reportingPeriod.adjacentPeriods(periods, '2026-06'), { previous: '', next: '2026-07' });
  assert.deepEqual(reportingPeriod.adjacentPeriods(periods, '2026-07'), { previous: '2026-06', next: '' });
  assert.equal(reportingPeriod.selectInitialPeriod({
    urlPeriod: '2026-06',
    sessionPeriod: '2026-07',
    currentPeriod: '2026-07',
    periods,
  }).value, '2026-06');
  assert.equal(reportingPeriod.selectInitialPeriod({
    urlPeriod: '', sessionPeriod: '', currentPeriod: '2026-07', periods: [
      { value: '2026-12', has_data: true },
      { value: '2026-06', has_data: true },
      { value: '2026-07', has_data: false },
    ],
  }).value, '2026-06');
});

test('RUN-08 period controls and dashboard loaders expose the approved UX contract', () => {
  const html = read('public/index.html');
  const app = read('public/app.js');
  const state = read('public/js/state.js');
  const dashboardRoutes = read('server/routes/dashboard.js');

  assert.match(html, /id="period-controls"[\s\S]*Kỳ báo cáo[\s\S]*id="period-previous"[\s\S]*id="month-picker"[\s\S]*id="period-next"[\s\S]*id="period-current"/);
  assert.doesNotMatch(html, /id="crumb-month"/);
  assert.doesNotMatch(html, /id="period-updated"/);
  assert.doesNotMatch(html.match(/id="period-controls"[\s\S]*?<\/span>/)?.[0] || '', /Tất cả dữ liệu/i);
  assert.match(app, /periodFromRoute\(routePathFromHash\(\)\)/);
  assert.match(app, /routeWithPeriod/);
  assert.match(app, /sessionStorage/);
  assert.match(app, /dashboardRequestId/);
  assert.match(app, /\/dashboard\/statistics\?period=/);
  assert.match(app, /\/dashboard\/ncc-evaluations\?month=/);
  assert.doesNotMatch(app, /\/dashboard\/timeseries\?month=/);
  assert.match(state, /dashboardRequestId:\s*0/);
  assert.match(dashboardRoutes, /router\.get\('\/ncc-evaluations'[\s\S]*req\.query\.month/);
  assert.doesNotMatch(dashboardRoutes, /router\.get\('\/(?:timeseries|ncc-docs|lab-tests|kph-incidents|qc-warehouse|hotspots)'/);
});
