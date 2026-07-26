'use strict';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const CANONICAL_PERSONNEL_HEADERS = Object.freeze([
  'email',
  'display_name',
  'active',
  'role_codes',
  'valid_from',
  'valid_until',
  'scope_type',
  'scope_value',
  'scope_effect',
]);

const PERSONNEL_IMPORT_SHEETS = Object.freeze({
  guide: 'Huong_dan',
  data: 'Nhan_su',
});

module.exports = {
  CANONICAL_PERSONNEL_HEADERS,
  PERSONNEL_IMPORT_SHEETS,
  XLSX_MIME,
};
