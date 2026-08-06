const { REPORTING_TIMEZONE } = require('./month');

const PERIOD_TYPES = Object.freeze(['MONTH', 'QUARTER', 'YEAR']);

function invalidPeriodError() {
  const error = new Error('Invalid dashboard reporting period.');
  error.status = 400;
  error.code = 'INVALID_DASHBOARD_PERIOD';
  error.publicMessage = 'Kỳ báo cáo không hợp lệ.';
  return error;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function dateRange(year, startMonth, monthCount) {
  const start = `${year}-${pad(startMonth)}-01`;
  const nextIndex = (year * 12) + (startMonth - 1) + monthCount;
  const nextYear = Math.floor(nextIndex / 12);
  const nextMonth = (nextIndex % 12) + 1;
  return { start, nextStart: `${nextYear}-${pad(nextMonth)}-01` };
}

function parseDashboardPeriod(typeValue, valueInput) {
  const type = String(typeValue || 'MONTH').trim().toUpperCase();
  const value = String(valueInput || '').trim().toUpperCase();
  if (!PERIOD_TYPES.includes(type)) throw invalidPeriodError();
  let year;
  let range;
  let label;
  if (type === 'MONTH') {
    const match = value.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
    if (!match) throw invalidPeriodError();
    year = Number(match[1]);
    const month = Number(match[2]);
    range = dateRange(year, month, 1);
    label = `Tháng ${pad(month)}/${year}`;
  } else if (type === 'QUARTER') {
    const match = value.match(/^(\d{4})-Q([1-4])$/);
    if (!match) throw invalidPeriodError();
    year = Number(match[1]);
    const quarter = Number(match[2]);
    range = dateRange(year, ((quarter - 1) * 3) + 1, 3);
    label = `Quý ${['I', 'II', 'III', 'IV'][quarter - 1]}/${year}`;
  } else {
    const match = value.match(/^(\d{4})$/);
    if (!match) throw invalidPeriodError();
    year = Number(match[1]);
    range = dateRange(year, 1, 12);
    label = `Năm ${year}`;
  }
  return {
    type,
    value,
    label,
    periodStart: range.start,
    periodEndExclusive: range.nextStart,
    timezone: REPORTING_TIMEZONE,
  };
}

function offsetPeriod(period, offset) {
  if (period.type === 'MONTH') {
    const [year, month] = period.value.split('-').map(Number);
    const index = (year * 12) + (month - 1) + offset;
    return parseDashboardPeriod('MONTH', `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`);
  }
  if (period.type === 'QUARTER') {
    const match = period.value.match(/^(\d{4})-Q([1-4])$/);
    const index = (Number(match[1]) * 4) + Number(match[2]) - 1 + offset;
    return parseDashboardPeriod('QUARTER', `${Math.floor(index / 4)}-Q${(index % 4) + 1}`);
  }
  return parseDashboardPeriod('YEAR', String(Number(period.value) + offset));
}

function periodWindow(period, count = 6) {
  return Array.from({ length: count }, (_, index) => offsetPeriod(period, index - count + 1));
}

module.exports = {
  PERIOD_TYPES,
  offsetPeriod,
  parseDashboardPeriod,
  periodWindow,
};
