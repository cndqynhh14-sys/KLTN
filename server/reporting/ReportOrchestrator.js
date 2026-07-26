'use strict';

const ReportTemplateVersionRepository = require('./ReportTemplateVersionRepository');
const { getDefinition } = require('./definitionCatalog');
const { buildPinnedReportContext } = require('./contextBuilder');
const { validateReportContext } = require('./dataContract');
const { buildSemanticModel, validateComponentTree } = require('./componentRegistry');
const { renderHtml } = require('./htmlRenderer');
const { renderPdf } = require('./pdfAdapter');
const { renderXlsx } = require('./xlsxAdapter');
const { checksum, parseJson, reportError } = require('./reportUtils');

const FORMATS = Object.freeze(['HTML', 'PDF', 'XLSX']);
const CONTENT_TYPES = Object.freeze({
  HTML: 'text/html; charset=utf-8',
  PDF: 'application/pdf',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
});

class ReportOrchestrator {
  constructor({ db, repository = null, contextBuilder = buildPinnedReportContext, adapters = {} }) {
    this.db = db;
    this.repository = repository || new ReportTemplateVersionRepository(db);
    this.contextBuilder = contextBuilder;
    this.adapters = {
      HTML: adapters.HTML || (({ html }) => Buffer.from(html, 'utf8')),
      PDF: adapters.PDF || (({ html }) => renderPdf(html)),
      XLSX: adapters.XLSX || (({ semantic }) => renderXlsx(semantic)),
    };
  }

  renderVersion({ version, ticket, roundNo, format = 'HTML' }) {
    const finalFormat = String(format || '').trim().toUpperCase();
    if (!FORMATS.includes(finalFormat)) throw reportError('report_format_not_supported');
    const definition = getDefinition(version.definition_code);
    const selectedRound = definition.validateRound(roundNo);
    const tree = definition.validateTree(validateComponentTree(parseJson(version.definition_json)));
    const context = validateReportContext(this.contextBuilder({
      db: this.db,
      ticket,
      definition,
      roundNo: selectedRound,
      templateVersion: version,
    }));
    if (context.definition_code !== definition.code) throw reportError('report_context_definition_mismatch', 422);
    if (Number(context.round.round_no) !== selectedRound) throw reportError('report_context_round_mismatch', 422);
    definition.validateRoundRecord(context.round);
    const semantic = buildSemanticModel(tree, context);
    const html = renderHtml({ semantic, title: version.version_name });
    const buffer = this.adapters[finalFormat]({ html, semantic, context, version, definition });
    if (!Buffer.isBuffer(buffer)) throw reportError('report_adapter_invalid', 500, { format: finalFormat });
    return {
      definition_code: definition.code,
      template_version_id: version.id,
      template_version_no: version.version_no,
      template_checksum: version.checksum || checksum(tree),
      component_checksum: checksum(tree),
      semantic_checksum: semantic.checksum,
      context_checksum: checksum(context),
      scoring_compatibility_marker: context.scoring.compatibility_marker,
      scoring_policy_version_id: context.scoring.scoring_policy_version_id,
      scoring_policy_checksum: context.scoring.scoring_policy_checksum || null,
      scoring_formula_checksum: context.scoring.formula_checksum || null,
      format: finalFormat,
      content_type: CONTENT_TYPES[finalFormat],
      buffer,
      context,
      semantic,
    };
  }

  previewVersion({ versionId, ticket, roundNo, format = 'HTML' }) {
    const version = this.repository.requireVersion(versionId);
    return this.renderVersion({ version, ticket, roundNo, format });
  }

  renderProduction({ definitionCode, ticket, roundNo, format = 'HTML', at = null }) {
    const definition = getDefinition(definitionCode);
    const version = this.repository.resolvePublished({ definitionCode: definition.code, at });
    if (!version) throw reportError('published_report_template_not_found', 404);
    return this.renderVersion({ version, ticket, roundNo, format });
  }
}

module.exports = { CONTENT_TYPES, FORMATS, ReportOrchestrator };
