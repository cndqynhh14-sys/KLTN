'use strict';

// This catalog mirrors the approval levels already enforced by PolicyService
// and workflowHistory. It is display metadata only: it must never drive a new
// transition or make an authorization decision.
const APPROVAL_STAGE_CATALOG = Object.freeze({
  LEAD: Object.freeze({ code: 'LEAD', title: 'Lead miền', sequence: 1 }),
  TBP: Object.freeze({ code: 'TBP', title: 'TBP', sequence: 2 }),
  GDK: Object.freeze({ code: 'GDK', title: 'GĐK', sequence: 3 }),
});

function approvalStage(level) {
  return APPROVAL_STAGE_CATALOG[String(level || '').trim().toUpperCase()] || null;
}

function approvalStageTitle(level) {
  return approvalStage(level)?.title || String(level || '').trim();
}

module.exports = { APPROVAL_STAGE_CATALOG, approvalStage, approvalStageTitle };
