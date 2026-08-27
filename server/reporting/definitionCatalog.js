'use strict';

const CANONICAL_DEFINITION_CODES = Object.freeze([
  'WORKING_MINUTES',
  'ROUND1_RESULT',
  'ROUND2_RESULT',
]);
const LEGACY_REPORT_CANDIDATES = Object.freeze(['INTERNAL', 'NCC']);

function error(code, status = 400, details = {}) {
  return Object.assign(new Error(code), { code, status, details });
}

const SCORE_BINDINGS = new Set([
  'doc4.compliance_summary',
  'doc4.result_summary.final_score_percent',
  'doc4.result_summary.final_result_label',
  'doc4.result_summary.final_conclusion',
]);

function componentBindings(component) {
  return [
    component?.binding,
    component?.subtitle_binding,
    ...(component?.fields || []).map((field) => field.binding),
    ...(component?.meta_fields || []).map((field) => field.binding),
  ].filter(Boolean);
}

function validateDefinitionTreePolicy(definition, tree) {
  if (definition.showScores !== false) return tree;
  const unsafe = (tree.components || []).find((component) => (
    component.type === 'compliance_overview'
      || componentBindings(component).some((binding) => SCORE_BINDINGS.has(binding))
  ));
  if (unsafe) {
    throw error('report_score_exposure_forbidden', 400, {
      definition_code: definition.code,
      component_id: unsafe.id,
    });
  }
  return tree;
}

const headerMetaFields = Object.freeze([
  { label: 'Số', binding: 'doc4.related_information.report_no' },
  { label: 'Ngày đánh giá', binding: 'doc4.related_information.evaluation_date', format: 'date_ddmmyyyy' },
]);

const metadataFields = Object.freeze([
  { label: 'Nhà cung cấp', binding: 'doc4.related_information.supplier_name' },
  { label: 'Mã nhà cung cấp', binding: 'doc4.related_information.supplier_code' },
  { label: 'Địa điểm đánh giá', binding: 'doc4.related_information.evaluation_address' },
  { label: 'Đánh giá viên', binding: 'doc4.related_information.evaluators' },
]);

const scopeFields = Object.freeze([
  { label: 'Sản phẩm', binding: 'doc4.scope.product' },
  { label: 'Loại hình', binding: 'doc4.scope.business_type' },
  { label: 'Loại đánh giá', binding: 'doc4.scope.evaluation_type' },
]);

const participantColumns = Object.freeze([
  { label: 'Tên/Chức danh', key: 'name', width: '56%', align: 'left' },
  { label: 'Họp khai mạc', key: 'opening', width: '22%', align: 'center' },
  { label: 'Họp bế mạc', key: 'closing', width: '22%', align: 'center' },
]);

const nonconformityColumns = Object.freeze([
  { label: 'Điều khoản', key: 'clause', width: '11%', align: 'center' },
  { label: 'Hạng mục', key: 'category', width: '15%' },
  { label: 'Điểm', key: 'score', width: '8%', align: 'center' },
  { label: 'Mô tả', key: 'description', width: '26%' },
  { label: 'Khắc phục', key: 'corrective_action', width: '25%' },
  { label: 'Hạn', key: 'due_date', width: '15%', align: 'center', format: 'date_ddmmyyyy' },
]);

const reportStyles = Object.freeze({
  page_orientation: 'portrait',
  font_scale: 1,
  report_profile: 'wincommerce_supplier_assessment',
});

const signatureFields = Object.freeze([
  { label: 'ĐÁNH GIÁ VIÊN', binding: 'doc4.signatures.evaluator' },
  { label: 'ĐẠI DIỆN NCC', binding: 'doc4.signatures.supplier_representative' },
]);

const resultComponents = (title) => ({
  schema_version: 1,
  components: [
    { id: 'header', type: 'header', title, meta_fields: headerMetaFields },
    { id: 'metadata', type: 'metadata_grid', title: 'Thông tin nhà cung cấp', fields: metadataFields, layout: 'stacked' },
    { id: 'scope', type: 'scope_summary', title: 'Phạm vi đánh giá', fields: scopeFields, layout: 'stacked' },
    { id: 'participants', type: 'participants_table', title: 'Thành phần tham dự', binding: 'doc4.participants.rows', columns: participantColumns },
    { id: 'supplier-introduction', type: 'supplier_introduction', title: 'Giới thiệu nhà cung cấp', binding: 'doc4.supplier_introduction.content' },
    { id: 'compliance', type: 'compliance_overview', title: 'Tổng hợp tuân thủ', binding: 'doc4.compliance_summary', columns: [
      { label: 'Hạng mục', key: 'category' }, { label: 'A', key: 'counts.A' },
      { label: 'B', key: 'counts.B' }, { label: 'C', key: 'counts.C' },
      { label: 'D', key: 'counts.D' }, { label: 'NA', key: 'counts.NA' },
      { label: '%', key: 'percentage' },
    ] },
    { id: 'result', type: 'metadata_grid', title: 'Kết quả', layout: 'stacked', fields: [
      { label: 'Điểm cuối', binding: 'doc4.result_summary.final_score_percent' },
      { label: 'Kết quả', binding: 'doc4.result_summary.final_result_label' },
      { label: 'Kết luận', binding: 'doc4.result_summary.final_conclusion' },
    ] },
    { id: 'nonconformities', type: 'nonconformity_table', title: 'Điểm không phù hợp', binding: 'doc4.nonconformity_summary', columns: nonconformityColumns },
    { id: 'signatures', type: 'signature_block', title: '', fields: signatureFields, display_mode: 'manual_blank', show_title: false },
  ],
  styles: reportStyles,
});

const definitions = Object.freeze({
  WORKING_MINUTES: Object.freeze({
    code: 'WORKING_MINUTES',
    label: 'Biên bản làm việc với NCC',
    description: 'Biên bản làm việc và nội dung cần khắc phục của vòng đánh giá thứ nhất.',
    allowedRounds: Object.freeze([1]),
    defaultRoundNo: 1,
    showScores: false,
    componentTree: Object.freeze({
      schema_version: 1,
      components: Object.freeze([
        { id: 'header', type: 'header', title: 'BIÊN BẢN LÀM VIỆC VỚI NHÀ CUNG CẤP', meta_fields: headerMetaFields },
        { id: 'metadata', type: 'metadata_grid', title: 'Thông tin nhà cung cấp', fields: metadataFields, layout: 'stacked' },
        { id: 'scope', type: 'scope_summary', title: 'Phạm vi đánh giá', fields: scopeFields, layout: 'stacked' },
        { id: 'participants', type: 'participants_table', title: 'Thành phần tham dự', binding: 'doc4.participants.rows', columns: participantColumns },
        { id: 'supplier-introduction', type: 'supplier_introduction', title: 'Giới thiệu nhà cung cấp', binding: 'doc4.supplier_introduction.content' },
        { id: 'nonconformities', type: 'nonconformity_table', title: 'Nội dung không phù hợp', binding: 'doc4.nonconformity_summary', columns: nonconformityColumns },
        { id: 'signatures', type: 'signature_block', title: '', fields: signatureFields, display_mode: 'manual_blank', show_title: false },
      ]),
      styles: reportStyles,
    }),
  }),
  ROUND1_RESULT: Object.freeze({
    code: 'ROUND1_RESULT', label: 'Kết quả đánh giá lần 1',
    description: 'Kết quả đánh giá và tuân thủ của vòng thứ nhất.',
    allowedRounds: Object.freeze([1]), defaultRoundNo: 1, showScores: true,
    componentTree: Object.freeze(resultComponents('KẾT QUẢ ĐÁNH GIÁ NHÀ CUNG CẤP LẦN 1')),
  }),
  ROUND2_RESULT: Object.freeze({
    code: 'ROUND2_RESULT', label: 'Kết quả đánh giá lần 2',
    description: 'Kết quả tái đánh giá sau khắc phục ở vòng thứ hai.',
    allowedRounds: Object.freeze([2]), defaultRoundNo: 2, showScores: true,
    componentTree: Object.freeze(resultComponents('KẾT QUẢ ĐÁNH GIÁ NHÀ CUNG CẤP LẦN 2')),
  }),
});

function getDefinition(code) {
  const definition = definitions[String(code || '').trim().toUpperCase()];
  if (!definition) throw error('report_definition_not_found', 404);
  return {
    ...definition,
    validateRound(roundNo) {
      const selected = Number(roundNo || definition.defaultRoundNo);
      if (!definition.allowedRounds.includes(selected)) {
        throw error('report_round_not_allowed', 400, {
          definition_code: definition.code,
          requested_round_no: selected,
          allowed_rounds: definition.allowedRounds,
        });
      }
      return selected;
    },
    validateRoundRecord(round) {
      if (!round?.id) {
        throw error('round_not_found', 404, {
          definition_code: definition.code,
          required_round_no: definition.defaultRoundNo,
        });
      }
      if (definition.code === 'ROUND2_RESULT' && !round.completed_at && !round.locked_at) {
        throw error('report_round_not_ready', 409, {
          definition_code: definition.code,
          required_round_no: 2,
        });
      }
      return round;
    },
    validateTree(tree) {
      return validateDefinitionTreePolicy(definition, tree);
    },
  };
}

function listDefinitions() {
  return CANONICAL_DEFINITION_CODES.map(getDefinition);
}

module.exports = {
  CANONICAL_DEFINITION_CODES,
  LEGACY_REPORT_CANDIDATES,
  getDefinition,
  listDefinitions,
  validateDefinitionTreePolicy,
};
