'use strict';

const crypto = require('node:crypto');
const { ReportOrchestrator } = require('./ReportOrchestrator');
const { CANONICAL_DEFINITION_CODES, getDefinition } = require('./definitionCatalog');
const { getContext } = require('../observability/context');
const { durableExportsEnabled } = require('./artifacts/config');
const { ReportExportJobService } = require('./artifacts/ReportExportJobService');
const { resolveReportAlias } = require('./reportAliasCatalog');
const { reportError } = require('./reportUtils');

function isCanonicalDefinition(value) {
  return CANONICAL_DEFINITION_CODES.includes(String(value || '').trim().toUpperCase());
}

function safeExportName(ticketCode, definitionCode, format) {
  const safeCode = String(ticketCode || 'report').replace(/[^\w.\-]+/g, '_');
  const safeDefinition = String(definitionCode).replace(/[^\w.\-]+/g, '_');
  return `${safeCode}-${safeDefinition}-${Date.now()}.${String(format).toLowerCase()}`;
}

function contentDisposition(fileName) {
  const asciiName = String(fileName || 'report')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_');
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function recordCanonicalExport(db, { ticket, rendered, fileName, exportedBy, legacySource = null, legacyAliasVersion = null }) {
  const info = db.prepare(`
    INSERT INTO report_exports (
      ticket_id, round_id, report_template_id, report_type, file_format,
      export_scope, file_path, exported_by, report_template_version_id,
      definition_code, context_checksum, component_checksum,
      scoring_compatibility_marker, legacy_source, legacy_alias_version
    ) VALUES (?, ?, NULL, ?, ?, 'TICKET', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ticket.id,
    rendered.context.round.id || null,
    rendered.definition_code,
    rendered.format,
    fileName,
    exportedBy || null,
    rendered.template_version_id,
    rendered.definition_code,
    rendered.context_checksum,
    rendered.component_checksum,
    rendered.scoring_compatibility_marker,
    legacySource || null,
    legacySource ? legacyAliasVersion : null
  );
  return Number(info.lastInsertRowid);
}

function exportCanonicalReport(db, {
  ticket,
  definitionCode,
  format,
  roundNo = null,
  exportedBy = null,
  at = null,
  idempotencyKey = null,
  requestId = null,
  correlationId = null,
  env = process.env,
  legacySource = null,
  legacyAliasVersion = null,
}) {
  const alias = resolveReportAlias(definitionCode, { roundNo, env });
  if (!alias.canonical_code) {
    throw reportError(alias.legacy_source ? 'report_legacy_mapping_pending' : 'report_definition_not_found', 404, {
      legacy_source: alias.legacy_source,
      deprecation: alias.deprecation,
    });
  }
  const definition = getDefinition(alias.canonical_code);
  const finalLegacySource = legacySource || alias.legacy_source || null;
  const finalLegacyAliasVersion = finalLegacySource ? (legacyAliasVersion || alias.mapping_version) : null;
  if (durableExportsEnabled(env)) {
    const requestContext = getContext();
    const finalRequestId = requestId || requestContext.request_id || null;
    const service = new ReportExportJobService({ db, env });
    return service.requestExport({
      ticket,
      definitionCode: definition.code,
      format,
      roundNo: roundNo || definition.defaultRoundNo,
      requestedBy: exportedBy,
      idempotencyKey: idempotencyKey || (finalRequestId ? `request:${finalRequestId}` : `generated:${crypto.randomUUID()}`),
      requestId: finalRequestId,
      correlationId: correlationId || requestContext.correlation_id || finalRequestId,
      at,
      legacySource: finalLegacySource,
      legacyAliasVersion: finalLegacyAliasVersion,
    });
  }
  const rendered = new ReportOrchestrator({ db }).renderProduction({
    definitionCode: definition.code,
    ticket,
    roundNo: roundNo || definition.defaultRoundNo,
    format,
    at,
  });
  const fileName = safeExportName(
    rendered.context.doc4?.related_information?.report_no || ticket.ticket_code,
    definition.code,
    rendered.format
  );
  const id = recordCanonicalExport(db, {
    ticket, rendered, fileName, exportedBy,
    legacySource: finalLegacySource, legacyAliasVersion: finalLegacyAliasVersion,
  });
  return {
    id,
    round_id: rendered.context.round.id || null,
    round_no: rendered.context.round.round_no,
    report_type: definition.code,
    definition_code: definition.code,
    canonical_code: definition.code,
    legacy_source: finalLegacySource,
    legacy_alias_version: finalLegacyAliasVersion,
    report_template_version_id: rendered.template_version_id,
    template_version_no: rendered.template_version_no,
    context_checksum: rendered.context_checksum,
    component_checksum: rendered.component_checksum,
    semantic_checksum: rendered.semantic_checksum,
    scoring_compatibility_marker: rendered.scoring_compatibility_marker,
    file_format: rendered.format,
    file_name: fileName,
    file_path: fileName,
    storage_key: fileName,
    content_type: rendered.content_type,
    content_disposition: contentDisposition(fileName),
    buffer: rendered.buffer,
  };
}

module.exports = { exportCanonicalReport, isCanonicalDefinition };
