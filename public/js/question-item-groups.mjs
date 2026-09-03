const BUSINESS_FIELDS = Object.freeze([
  'category_code', 'category', 'question_code', 'clause_code', 'question_text',
  'is_elimination_clause', 'is_critical_clause', 'requires_attachment',
  'allowed_scores', 'active',
]);

const SCOPE_PLACEMENT_FIELDS = Object.freeze(['question_code', 'clause_code', 'category_code', 'category']);
const FINGERPRINT_FIELDS = Object.freeze(BUSINESS_FIELDS.filter((field) => !SCOPE_PLACEMENT_FIELDS.includes(field)));
export const SHARED_QUESTION_EDIT_FIELDS = Object.freeze([...BUSINESS_FIELDS]);
const SCALE_ORDER = Object.freeze({ ALL: 0, LARGE: 1, SMALL: 2 });
const SCALE_LABELS = Object.freeze({ ALL: 'Tất cả quy mô', LARGE: 'Lớn', SMALL: 'Nhỏ' });

function text(value) { return String(value ?? '').trim(); }
function code(value) { return text(value).toUpperCase(); }
function flag(value) { return Number(Boolean(Number(value))); }

function fieldValue(item, field) {
  if (['is_elimination_clause', 'is_critical_clause', 'requires_attachment', 'active'].includes(field)) return flag(item?.[field]);
  if (field === 'question_code') return code(item?.question_code);
  return text(item?.[field]);
}

function businessFingerprint(item) {
  return JSON.stringify(FINGERPRINT_FIELDS.map((field) => fieldValue(item, field)));
}

function versionIdentity(item) { return text(item?.question_template_version_id || item?.version_id || 'UNVERSIONED'); }
function criterionIdentity(item) {
  const clauseCode = code(item?.clause_code);
  return clauseCode ? `CLAUSE:${clauseCode}` : `QUESTION:${code(item?.question_code)}`;
}

function scopeSort(left, right) {
  const leftFacility = code(left.facility_type);
  const rightFacility = code(right.facility_type);
  if (leftFacility === 'ALL' && rightFacility !== 'ALL') return -1;
  if (rightFacility === 'ALL' && leftFacility !== 'ALL') return 1;
  const facilityOrder = leftFacility.localeCompare(rightFacility, 'vi');
  if (facilityOrder) return facilityOrder;
  const leftScale = code(left.supplier_scale);
  const rightScale = code(right.supplier_scale);
  return (SCALE_ORDER[leftScale] ?? 99) - (SCALE_ORDER[rightScale] ?? 99) || leftScale.localeCompare(rightScale, 'vi');
}

export function groupQuestionItems(items = []) {
  const byFingerprint = new Map();
  const fingerprintsByIdentity = new Map();
  (Array.isArray(items) ? items : []).forEach((item) => {
    const version = versionIdentity(item);
    const identity = criterionIdentity(item);
    const fingerprint = businessFingerprint(item);
    const identityKey = `${version}|${identity}`;
    const key = `${identityKey}|${fingerprint}`;
    if (!byFingerprint.has(key)) byFingerprint.set(key, { key, members: [] });
    byFingerprint.get(key).members.push(item);
    if (!fingerprintsByIdentity.has(identityKey)) fingerprintsByIdentity.set(identityKey, new Set());
    fingerprintsByIdentity.get(identityKey).add(fingerprint);
  });
  return [...byFingerprint.values()].map((entry) => {
    const members = entry.members.slice().sort(scopeSort);
    const representative = members[0];
    const orders = [...new Set(members.map((item) => Number(item.order_index)))];
    const version = versionIdentity(representative);
    const identity = criterionIdentity(representative);
    const questionCodes = [...new Set(members.map((item) => code(item.question_code)).filter(Boolean))].sort((left, right) => left.localeCompare(right, 'vi', { numeric: true }));
    const categories = [...new Set(members.map((item) => text(item.category)).filter(Boolean))].sort((left, right) => left.localeCompare(right, 'vi'));
    const categoryCodes = [...new Set(members.map((item) => code(item.category_code)).filter(Boolean))].sort((left, right) => left.localeCompare(right, 'vi'));
    const scopes = [];
    const seenScopes = new Set();
    members.forEach((item) => {
      const facilityType = code(item.facility_type);
      const supplierScale = code(item.supplier_scale);
      const scopeKey = `${facilityType}|${supplierScale}`;
      if (seenScopes.has(scopeKey)) return;
      seenScopes.add(scopeKey);
      scopes.push({ facility_type: facilityType, supplier_scale: supplierScale });
    });
    scopes.sort(scopeSort);
    return {
      ...representative, key: entry.key, representative, members,
      member_ids: members.map((item) => String(item.id)), scopes, physical_count: members.length,
      question_codes: questionCodes, display_question_code: questionCodes.join(' / '),
      has_question_code_variance: questionCodes.length > 1, categories, category_codes: categoryCodes,
      display_category: categories.length > 1 ? 'Theo phạm vi' : (categories[0] || 'Chưa phân nhóm'),
      has_category_variance: categories.length > 1 || categoryCodes.length > 1,
      common_order_index: orders.length === 1 ? orders[0] : null,
      min_order_index: Math.min(...orders),
      has_scope_variance: (fingerprintsByIdentity.get(`${version}|${identity}`)?.size || 0) > 1,
    };
  }).sort((left, right) => Number(left.min_order_index) - Number(right.min_order_index)
    || code(left.question_code).localeCompare(code(right.question_code), 'vi') || left.key.localeCompare(right.key, 'vi'));
}

export function filterQuestionGroups(groups = [], filters = {}) {
  const search = text(filters.search).toLocaleLowerCase('vi');
  const category = text(filters.category);
  const active = text(filters.active);
  return groups.filter((group) => {
    if (search && !`${(group.question_codes || []).join(' ')} ${group.clause_code || ''} ${group.question_text || ''}`.toLocaleLowerCase('vi').includes(search)) return false;
    if (category && !(group.categories || [text(group.category)]).includes(category)) return false;
    if (active !== '' && String(flag(group.active)) !== active) return false;
    return true;
  });
}

function defaultFacilityLabel(facilityType) {
  if (facilityType === 'ALL') return 'Tất cả loại cơ sở';
  return text(facilityType).toLocaleLowerCase('vi').replaceAll('_', ' ').replace(/^./u, (letter) => letter.toLocaleUpperCase('vi'));
}

export function summarizeQuestionScopes(scopes = [], { facilityLabels = new Map() } = {}) {
  const byFacility = new Map();
  scopes.forEach((scope) => {
    const facilityType = code(scope?.facility_type);
    const supplierScale = code(scope?.supplier_scale);
    if (!facilityType || !supplierScale) return;
    if (!byFacility.has(facilityType)) byFacility.set(facilityType, new Set());
    byFacility.get(facilityType).add(supplierScale);
  });
  return [...byFacility.entries()].map(([facilityType, scales]) => {
    const orderedScales = [...scales].sort((left, right) => (SCALE_ORDER[left] ?? 99) - (SCALE_ORDER[right] ?? 99));
    const facilityLabel = facilityLabels.get(facilityType) || defaultFacilityLabel(facilityType);
    return { facility_type: facilityType, facility_label: facilityLabel, supplier_scales: orderedScales, label: `${facilityLabel}: ${orderedScales.map((scale) => SCALE_LABELS[scale] || scale).join(', ')}` };
  }).sort((left, right) => left.facility_type === 'ALL' ? -1 : right.facility_type === 'ALL' ? 1 : left.facility_label.localeCompare(right.facility_label, 'vi'));
}

export function buildSharedQuestionUpdates(group, changes = {}) {
  const safeChanges = {};
  SHARED_QUESTION_EDIT_FIELDS.forEach((field) => {
    if (field === 'question_code' && group?.has_question_code_variance) return;
    if (['category_code', 'category'].includes(field) && group?.has_category_variance) return;
    if (Object.prototype.hasOwnProperty.call(changes || {}, field)) safeChanges[field] = changes[field];
  });
  return (group?.members || []).map((item) => ({ id: item.id, ...safeChanges }));
}
