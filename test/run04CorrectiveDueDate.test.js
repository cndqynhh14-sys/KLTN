const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  addCalendarDaysISO,
  calendarDateInTimeZone,
  defaultCorrectionDueDate,
} = require('../server/domain/correctiveActionDueDate');

const ROOT = path.resolve(__dirname, '..');

test('RUN-04 computes seven calendar days without timezone drift', () => {
  assert.equal(addCalendarDaysISO('2026-07-28', 7), '2026-08-04');
  assert.equal(addCalendarDaysISO('2026-12-28', 7), '2027-01-04');
  assert.equal(addCalendarDaysISO('2024-02-23', 7), '2024-03-01');
  assert.equal(addCalendarDaysISO('2026-02-29', 7), null);
  assert.equal(
    calendarDateInTimeZone(new Date('2026-07-15T18:30:00.000Z'), 'Asia/Ho_Chi_Minh'),
    '2026-07-16',
  );
});

test('RUN-04 selects the recorded evaluation date before planned date', () => {
  assert.equal(defaultCorrectionDueDate({
    round: { assessment_date: '2026-07-10' },
    ticket: { actual_evaluation_date: '2026-07-09', planned_date: '2026-07-08' },
    fallbackDate: '2026-07-07',
  }), '2026-07-17');
  assert.equal(defaultCorrectionDueDate({
    ticket: { actual_evaluation_date: '2026-07-09', planned_date: '2026-07-08' },
    fallbackDate: '2026-07-07',
  }), '2026-07-16');
  assert.equal(defaultCorrectionDueDate({
    ticket: { planned_date: '2026-07-08' },
    fallbackDate: '2026-07-07',
  }), '2026-07-15');
});

test('RUN-04 scoring UI shows the default while keeping manual draft values', () => {
  const source = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.match(source, /function defaultCorrectionDueDateForTicket\(ticket\)/);
  assert.match(source, /_due_date_is_default:/);
  assert.match(source, /data-nc-default-due-date/);
  assert.match(source, /data-nc-due-date-dirty/);
});
