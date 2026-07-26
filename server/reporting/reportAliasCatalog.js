'use strict';

const LEGACY_ALIAS_VERSION = 'REPORT_LEGACY_ALIAS_V1';
const LEGACY_ALIAS_APPROVAL = 'APV-REPORT-001+REPORT-002:APPROVED';

const CANONICAL_CODES = Object.freeze([
  'WORKING_MINUTES',
  'ROUND1_RESULT',
  'ROUND2_RESULT',
]);

const ALIASES = Object.freeze({
  WORKING_MINUTES: 'WORKING_MINUTES',
  NCC_WORKING_MINUTES: 'WORKING_MINUTES',
  BIEN_BAN_LAM_VIEC: 'WORKING_MINUTES',
  BIEN_BAN_LAM_VIEC_VOI_NCC: 'WORKING_MINUTES',
  BAO_CAO_GUI_NCC: 'ROUND1_RESULT',
  ROUND1_RESULT: 'ROUND1_RESULT',
  RESULT_ROUND_1: 'ROUND1_RESULT',
  KET_QUA_DANH_GIA_LAN_1: 'ROUND1_RESULT',
  KET_QUA_DANH_GIA_LAN1: 'ROUND1_RESULT',
  ROUND2_RESULT: 'ROUND2_RESULT',
  RESULT_ROUND_2: 'ROUND2_RESULT',
  KET_QUA_DANH_GIA_LAN_2: 'ROUND2_RESULT',
  KET_QUA_DANH_GIA_LAN2: 'ROUND2_RESULT',
  BAO_CAO_NOI_BO: 'ROUND2_RESULT',
});

const LEGACY_DEFINITIONS = Object.freeze({
  NCC: Object.freeze({
    proposed_canonical_code: 'WORKING_MINUTES',
    ambiguity: false,
    reason: 'legacy_mapping_approval_pending',
  }),
  INTERNAL: Object.freeze({
    proposed_by_round: Object.freeze({ 1: 'ROUND1_RESULT', 2: 'ROUND2_RESULT' }),
    ambiguity: true,
    reason: 'legacy_mapping_round_ambiguous',
  }),
});

function normalizeAliasKey(value) {
  return String(value || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

function approvalEnabled(env = process.env) {
  return String(env.REPORT_LEGACY_ALIAS_APPROVAL || '') === LEGACY_ALIAS_APPROVAL;
}

function deprecationFor(legacySource, legacy, approved) {
  return {
    status: approved ? 'APPROVED_COMPATIBILITY' : 'PENDING_APPROVAL',
    decision_ids: ['APV-REPORT-001', 'REPORT-002'],
    new_creation_allowed: false,
    proposed_replacement: legacy.proposed_canonical_code
      || 'ROUND1_RESULT|ROUND2_RESULT_BY_ROUND',
    reason: legacy.reason,
  };
}

function resolveReportAlias(value, { roundNo = null, env = process.env } = {}) {
  const raw = String(value || '').trim();
  const key = normalizeAliasKey(raw);
  if (!key) return {
    input_code: raw,
    canonical_code: null,
    legacy_source: null,
    mapping_version: LEGACY_ALIAS_VERSION,
    deprecation: null,
    known: false,
  };

  const legacy = LEGACY_DEFINITIONS[key];
  if (legacy) {
    const approved = approvalEnabled(env);
    const selectedRound = Number(roundNo || 0);
    const canonicalCode = approved
      ? (legacy.proposed_canonical_code || legacy.proposed_by_round?.[selectedRound] || null)
      : null;
    return {
      input_code: raw,
      canonical_code: canonicalCode,
      legacy_source: key,
      mapping_version: LEGACY_ALIAS_VERSION,
      deprecation: deprecationFor(key, legacy, approved),
      known: true,
      ambiguous: !canonicalCode && !!legacy.ambiguity,
      approval_confirmed: approved,
    };
  }

  const canonicalCode = ALIASES[key] || null;
  const isCanonicalInput = CANONICAL_CODES.includes(key);
  return {
    input_code: raw,
    canonical_code: canonicalCode,
    legacy_source: canonicalCode && !isCanonicalInput ? key : null,
    mapping_version: LEGACY_ALIAS_VERSION,
    deprecation: canonicalCode && !isCanonicalInput ? {
      status: 'DEPRECATED_ALIAS',
      new_creation_allowed: false,
      proposed_replacement: canonicalCode,
      reason: 'use_canonical_report_code',
    } : null,
    known: !!canonicalCode,
    ambiguous: false,
    approval_confirmed: true,
  };
}

module.exports = {
  ALIASES,
  CANONICAL_CODES,
  LEGACY_ALIAS_APPROVAL,
  LEGACY_ALIAS_VERSION,
  LEGACY_DEFINITIONS,
  approvalEnabled,
  normalizeAliasKey,
  resolveReportAlias,
};
