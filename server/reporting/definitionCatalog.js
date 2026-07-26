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

const metadataFields = Object.freeze([
  { label: 'Số báo cáo', binding: 'doc4.related_information.report_no' },
  { label: 'Ngày đánh giá', binding: 'doc4.related_information.evaluation_date' },
  { label: 'Nhà cung cấp', binding: 'doc4.related_information.supplier_name' },
  { label: 'Mã nhà cung cấp', binding: 'doc4.related_information.supplier_code' },
  { label: 'Địa điểm đánh giá', binding: 'doc4.related_information.evaluation_address' },
  { label: 'Đánh giá viên', binding: 'doc4.related_information.evaluators' },
]);

const scopeFields = Object.freeze([
  { label: 'Sản phẩm', binding: 'doc4.scope.product' },
  { label: 'Loại hình', binding: 'doc4.scope.business_type' },
  { label: 'Loại đánh giá', binding: 'doc4.scope.evaluation_type' },
  { label: 'Phiên bản bộ câu hỏi', binding: 'doc4.scope.question_template_version_id' },
]);

const participantColumns = Object.freeze([
  { label: 'Tên/Chức danh', key: 'name' },
  { label: 'Họp khai mạc', key: 'opening' },
  { label: 'Họp bế mạc', key: 'closing' },
]);

const nonconformityColumns = Object.freeze([
  { label: 'Điều khoản', key: 'clause' },
  { label: 'Hạng mục', key: 'category' },
  { label: 'Điểm', key: 'score' },
  { label: 'Mô tả', key: 'description' },
  { label: 'Khắc phục', key: 'corrective_action' },
  { label: 'Hạn', key: 'due_date' },
  { label: 'Trạng thái', key: 'status' },
]);

const resultComponents = (title) => ({
  schema_version: 1,
  components: [
    { id: 'header', type: 'header', title, subtitle_binding: 'doc4.related_information.report_no' },
    { id: 'metadata', type: 'metadata_grid', title: 'Thông tin báo cáo', fields: metadataFields },
    { id: 'scope', type: 'scope_summary', title: 'Phạm vi đánh giá', fields: scopeFields },
    { id: 'participants', type: 'participants_table', title: 'Thành phần tham dự', binding: 'doc4.participants.rows', columns: participantColumns },
    { id: 'supplier-introduction', type: 'supplier_introduction', title: 'Giới thiệu nhà cung cấp', binding: 'doc4.supplier_introduction.content' },
    { id: 'compliance', type: 'compliance_overview', title: 'Tổng hợp tuân thủ', binding: 'doc4.compliance_summary', columns: [
      { label: 'Hạng mục', key: 'category' }, { label: 'A', key: 'counts.A' },
      { label: 'B', key: 'counts.B' }, { label: 'C', key: 'counts.C' },
      { label: 'D', key: 'counts.D' }, { label: 'NA', key: 'counts.NA' },
      { label: '%', key: 'percentage' },
    ] },
    { id: 'result', type: 'metadata_grid', title: 'Kết quả', fields: [
      { label: 'Điểm cuối', binding: 'doc4.result_summary.final_score_percent' },
      { label: 'Kết quả', binding: 'doc4.result_summary.final_result_label' },
      { label: 'Kết luận', binding: 'doc4.result_summary.final_conclusion' },
    ] },
    { id: 'nonconformities', type: 'nonconformity_table', title: 'Điểm không phù hợp', binding: 'doc4.nonconformity_summary', columns: nonconformityColumns },
    { id: 'corrective-actions', type: 'corrective_action_table', title: 'Hành động khắc phục', binding: 'corrective_action_rows', columns: [
      { label: 'Vấn đề', key: 'issue_description' }, { label: 'Hành động', key: 'required_action' },
      { label: 'Trạng thái', key: 'status' },
    ] },
    { id: 'approval-history', type: 'approval_history', title: 'Lịch sử phê duyệt', binding: 'approval_history_rows', columns: [
      { label: 'Thời gian', key: 'created_at' }, { label: 'Vai trò', key: 'actor_role' }, { label: 'Hành động', key: 'action' },
    ] },
    { id: 'signatures', type: 'signature_block', title: 'Chữ ký', fields: [
      { label: 'Đánh giá viên', binding: 'doc4.signatures.evaluator' },
      { label: 'Đại diện NCC', binding: 'doc4.signatures.supplier_representative' },
      { label: 'Người duyệt', binding: 'doc4.signatures.approved_by' },
    ] },
  ],
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
        { id: 'header', type: 'header', title: 'BIÊN BẢN LÀM VIỆC VỚI NHÀ CUNG CẤP', subtitle_binding: 'doc4.related_information.report_no' },
        { id: 'metadata', type: 'metadata_grid', title: 'Thông tin báo cáo', fields: metadataFields },
        { id: 'scope', type: 'scope_summary', title: 'Phạm vi đánh giá', fields: scopeFields },
        { id: 'participants', type: 'participants_table', title: 'Thành phần tham dự', binding: 'doc4.participants.rows', columns: participantColumns },
        { id: 'supplier-introduction', type: 'supplier_introduction', title: 'Giới thiệu nhà cung cấp', binding: 'doc4.supplier_introduction.content' },
        { id: 'nonconformities', type: 'nonconformity_table', title: 'Nội dung không phù hợp', binding: 'doc4.nonconformity_summary', columns: nonconformityColumns },
        { id: 'signatures', type: 'signature_block', title: 'Chữ ký', fields: [
          { label: 'Đánh giá viên', binding: 'doc4.signatures.evaluator' },
          { label: 'Đại diện NCC', binding: 'doc4.signatures.supplier_representative' },
        ] },
      ]),
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
