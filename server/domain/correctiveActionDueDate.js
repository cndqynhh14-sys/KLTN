const { isValidISODate } = require('./dateValidation');

function addCalendarDaysISO(value, days) {
  const text = String(value || '').trim();
  const amount = Number(days);
  if (!isValidISODate(text) || !Number.isInteger(amount)) return null;
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function calendarDateInTimeZone(now = new Date(), timeZone = 'Asia/Ho_Chi_Minh') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function defaultCorrectionDueDate({ ticket = null, round = null } = {}) {
  const evaluationDate = [
    round?.assessment_date,
    ticket?.actual_evaluation_date,
  ].map((value) => String(value || '').slice(0, 10)).find(isValidISODate);
  return evaluationDate ? addCalendarDaysISO(evaluationDate, 7) : null;
}

module.exports = {
  addCalendarDaysISO,
  calendarDateInTimeZone,
  defaultCorrectionDueDate,
};
