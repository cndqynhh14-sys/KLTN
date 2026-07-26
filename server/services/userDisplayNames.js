function normalizeUserValue(value) {
  return String(value == null ? '' : value).trim();
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeUserValue(value));
}

function parseUserValues(value) {
  if (Array.isArray(value)) return value.map(normalizeUserValue).filter(Boolean);
  const text = normalizeUserValue(value);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map(normalizeUserValue).filter(Boolean);
  } catch {}
  return text.split(',').map(normalizeUserValue).filter(Boolean);
}

function uniqueTextList(values) {
  const seen = new Set();
  return (values || []).flatMap(parseUserValues).filter((value) => {
    const key = value.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function userDisplayNameMap(db, values) {
  const emails = uniqueTextList(values)
    .filter(isEmail)
    .map((value) => value.toLowerCase());
  if (!emails.length) return new Map();
  const placeholders = emails.map(() => '?').join(',');
  const rows = db.prepare(`SELECT lower(email) AS email, display_name FROM users WHERE lower(email) IN (${placeholders})`).all(...emails);
  return new Map(rows.map((row) => [row.email, normalizeUserValue(row.display_name)]));
}

function displayNameForValue(value, displayNames) {
  const text = normalizeUserValue(value);
  if (!text) return '';
  if (!isEmail(text)) return text;
  return displayNames?.get(text.toLowerCase()) || text;
}

function displayNamesForValues(values, displayNames) {
  return parseUserValues(values).map((value) => displayNameForValue(value, displayNames)).filter(Boolean);
}

function collectUserValuesFromRecords(records, fields) {
  return (records || []).flatMap((record) => fields.map((field) => record?.[field]));
}

function withUserDisplayNames(record, fields, displayNames) {
  if (!record) return record;
  const mapped = { ...record };
  fields.forEach((field) => {
    mapped[`${field}_display_name`] = displayNameForValue(record[field], displayNames);
  });
  return mapped;
}

module.exports = {
  collectUserValuesFromRecords,
  displayNameForValue,
  displayNamesForValues,
  parseUserValues,
  userDisplayNameMap,
  withUserDisplayNames,
};
