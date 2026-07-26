const { normalizeComparableText } = require('./month');

const EVALUATION_VIOLATION_GROUPS = Object.freeze([
  {
    code: 'LEGAL',
    label: 'Lỗi vi phạm điều khoản pháp lý',
    aliases: ['legal', 'phap ly', 'ho so phap ly', 'dieu khoan phap ly'],
    codePrefixes: ['LEGAL'],
    note: null,
  },
  {
    code: 'QUALITY_CONTROL',
    label: 'Lỗi kiểm soát chất lượng',
    aliases: ['quality', 'quality control', 'kiem soat chat luong', 'chat luong san pham'],
    codePrefixes: ['QUALITY', 'QC'],
    note: null,
  },
  {
    code: 'TRACEABILITY',
    label: 'Lỗi truy xuất nguồn gốc SP',
    aliases: ['traceability', 'trace', 'truy xuat', 'truy xuat nguon goc'],
    codePrefixes: ['TRACE', 'TRACEABILITY'],
    note: null,
  },
  {
    code: 'FOOD_SAFETY',
    label: 'Lỗi an toàn vệ sinh thực phẩm',
    aliases: ['food safety', 'attp', 'atvstp', 'an toan ve sinh', 've sinh thuc pham', 'an toan thuc pham', 'kiem soat atvstp'],
    codePrefixes: ['FOOD', 'ATTP', 'ATVSTP', 'FS'],
    note: null,
  },
]);

const GROUP_BY_CODE = new Map(EVALUATION_VIOLATION_GROUPS.map((group) => [group.code, group]));

function normalizeCodePrefix(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]+.*/, '');
}

function resolveViolationGroup(source) {
  const directCode = String(source?.code || '').trim().toUpperCase();
  if (GROUP_BY_CODE.has(directCode)) return GROUP_BY_CODE.get(directCode);

  const prefix = normalizeCodePrefix(source?.clause_code || source?.question_code);
  for (const group of EVALUATION_VIOLATION_GROUPS) {
    if (group.codePrefixes.includes(prefix)) return group;
  }

  const haystack = normalizeComparableText([
    source?.label,
    source?.category,
    source?.question_text,
    source?.nonconformity,
  ].filter(Boolean).join(' '));

  if (!haystack) return null;

  for (const group of EVALUATION_VIOLATION_GROUPS) {
    if (group.aliases.some((alias) => haystack.includes(alias))) return group;
  }
  return null;
}

module.exports = {
  EVALUATION_VIOLATION_GROUPS,
  resolveViolationGroup,
};
