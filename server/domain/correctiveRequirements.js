const CORRECTIVE_REQUIREMENT_NAME_MAX_LENGTH = 120;

function displayCorrectiveRequirementName(value) {
  return String(value || '')
    .normalize('NFC')
    .trim()
    .replace(/\s+/gu, ' ');
}

function normalizeCorrectiveRequirementName(value) {
  return displayCorrectiveRequirementName(value)
    .normalize('NFKC')
    .toLocaleLowerCase('vi-VN');
}

function validateCorrectiveRequirementName(value) {
  const name = displayCorrectiveRequirementName(value);
  if (!name) return { ok: false, code: 'corrective_requirement_name_required' };
  if (name.length > CORRECTIVE_REQUIREMENT_NAME_MAX_LENGTH) {
    return { ok: false, code: 'corrective_requirement_name_too_long' };
  }
  return { ok: true, name, normalizedName: normalizeCorrectiveRequirementName(name) };
}

module.exports = {
  CORRECTIVE_REQUIREMENT_NAME_MAX_LENGTH,
  displayCorrectiveRequirementName,
  normalizeCorrectiveRequirementName,
  validateCorrectiveRequirementName,
};
