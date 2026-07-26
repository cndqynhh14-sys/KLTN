'use strict';

const { SCORING_COMPATIBILITY_MARKER } = require('./dataContract');

function buildSyntheticReportContext({ definition, roundNo }) {
  const selectedRound = Number(roundNo || definition.defaultRoundNo);
  const supplierName = 'Nhà cung cấp mẫu RUN-20';
  return {
    context_schema_version: 1,
    definition_code: definition.code,
    ticket: { id: 20001, code: `RUN20-SYNTHETIC-R${selectedRound}`, question_template_version_id: 14001 },
    round: {
      id: 20010 + selectedRound,
      round_no: selectedRound,
      status: 'COMPLETED',
      locked_at: '2026-07-15T08:00:00.000Z',
      completed_at: '2026-07-15T08:00:00.000Z',
    },
    scoring: {
      compatibility_marker: SCORING_COMPATIBILITY_MARKER,
      scoring_policy_version_id: null,
      source: 'RUN-20 deterministic synthetic preview',
    },
    compliance_overview: null,
    doc4: {
      related_information: {
        report_no: `RUN20-SYNTHETIC-R${selectedRound}`,
        evaluation_date: '2026-07-15',
        evaluators: 'Chuyên viên QA mẫu',
        supplier_name: supplierName,
        supplier_code: 'RUN20-NCC',
        evaluation_address: 'Cơ sở tổng hợp mẫu',
      },
      scope: {
        product: 'Sản phẩm mẫu', business_type: 'Nhà sản xuất', evaluation_type: 'Định kỳ',
        question_template_version_id: 14001,
      },
      participants: { rows: [{ name: 'Chuyên viên QA mẫu', opening: true, closing: true }] },
      supplier_introduction: { content: `${supplierName} — dữ liệu tổng hợp, không phải dữ liệu khách hàng.` },
      compliance_summary: [
        { category: 'Hồ sơ pháp lý', counts: { A: 4, B: 1, C: 0, D: 0, NA: 0 }, percentage: 95 },
        { category: 'Kiểm soát chất lượng', counts: { A: 5, B: 1, C: 0, D: 0, NA: 0 }, percentage: 92 },
      ],
      result_summary: { final_score_percent: '93.5%', final_result_label: 'Đạt mức cao', final_conclusion: 'Đạt' },
      nonconformity_summary: [{
        clause: 'RUN20-1', category: 'Hồ sơ pháp lý', score: 'B',
        description: 'Phát hiện tổng hợp để kiểm tra bố cục.', corrective_action: 'Cập nhật hồ sơ mẫu.',
        due_date: '2026-08-15', status: 'OPEN',
      }],
      signatures: { evaluator: 'Chuyên viên QA mẫu', supplier_representative: 'Đại diện NCC mẫu', approved_by: 'Người duyệt mẫu' },
    },
    corrective_action_rows: [{ issue_description: 'Phát hiện tổng hợp', required_action: 'Cập nhật hồ sơ mẫu', status: 'OPEN' }],
    approval_history_rows: [{ created_at: '2026-07-15', actor_role: 'TBP', action: 'APPROVED' }],
  };
}

function previewWarnings(semantic) {
  const warnings = [];
  const emptySections = semantic.sections.filter((section) => {
    if (Array.isArray(section.data)) return section.data.length === 0;
    return section.data == null || section.data === '';
  });
  if (emptySections.length) warnings.push({ code: 'MISSING_VARIABLES', component_ids: emptySections.map((section) => section.id) });
  const estimatedRows = semantic.sections.reduce((total, section) => total + (Array.isArray(section.data) ? section.data.length : 1), 0);
  if (estimatedRows > 42) warnings.push({ code: 'PAGE_OVERFLOW_RISK', estimated_rows: estimatedRows });
  semantic.sections.forEach((section) => (section.warnings || []).forEach((message) => warnings.push({ code: 'COMPONENT_WARNING', component_id: section.id, message })));
  return warnings;
}

module.exports = { buildSyntheticReportContext, previewWarnings };
