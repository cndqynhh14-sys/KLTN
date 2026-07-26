function isValidISODate(value) {
  const m = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]);
}

function assertValidDateField(value, code, required = false) {
  const text = String(value || '').trim();
  if (!text) {
    if (required) throw Object.assign(new Error(code), { status: 400, code: 'validation_failed', errors: [code] });
    return null;
  }
  if (!isValidISODate(text)) throw Object.assign(new Error(code), { status: 400, code: 'validation_failed', errors: [code] });
  return text;
}

module.exports = {
  assertValidDateField,
  isValidISODate,
};
