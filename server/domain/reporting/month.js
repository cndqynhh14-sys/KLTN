const REPORTING_TIMEZONE = 'Asia/Ho_Chi_Minh';

function invalidMonthError() {
  const error = new Error('Query parameter month must use YYYY-MM.');
  error.status = 400;
  error.code = 'INVALID_MONTH';
  error.publicMessage = 'Query parameter month must use YYYY-MM.';
  return error;
}

function parseReportingMonth(value) {
  const month = String(value || '').trim();
  const match = month.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  if (!match) throw invalidMonthError();
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  const nextYear = monthNumber === 12 ? year + 1 : year;
  const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1;
  return {
    month,
    monthStart: `${year}-${String(monthNumber).padStart(2, '0')}-01`,
    nextMonthStart: `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`,
    timezone: REPORTING_TIMEZONE,
  };
}

function safeRatio(numerator, denominator) {
  const n = Number(numerator || 0);
  const d = Number(denominator || 0);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return 0;
  return Math.round((n / d) * 10000) / 10000;
}

function normalizeNullableText(value) {
  const text = String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
  return text || null;
}

function normalizeComparableText(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ');
}

function compareNullableText(a, b) {
  const aText = normalizeNullableText(a);
  const bText = normalizeNullableText(b);
  if (!aText && !bText) return 0;
  if (!aText) return 1;
  if (!bText) return -1;
  return aText.localeCompare(bText, 'vi');
}

module.exports = {
  REPORTING_TIMEZONE,
  compareNullableText,
  normalizeComparableText,
  normalizeNullableText,
  parseReportingMonth,
  safeRatio,
};
