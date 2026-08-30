// QLCL dashboard — vanilla JS SPA. XSS-safe DOM construction (no innerHTML với
// user data). Design tokens + semantic classes defined in index.html <style>;
// JS chỉ compose class names + build DOM tree.

import { actionRequestHeaders, api, withActionRequestContext } from './js/api.js';
import { $, el } from './js/dom.js';
import { UI_TEXT, apiErrorMessage, reportTypeText, statusText } from './js/i18n.js';
import { state } from './js/state.js';
import { buildSharedQuestionUpdates, filterQuestionGroups, groupQuestionItems, summarizeQuestionScopes } from './js/question-item-groups.mjs';
import { EVALUATION_STATUS_TABS, evaluationStatusCounts, evaluationStatusMeta, filterEvaluationsByStatus, getEvaluationWorkflowSteps } from './js/evaluation-status.mjs';

(function () {
  'use strict';

  const NAVIGATION = window.QLCL_NAVIGATION;
  if (!NAVIGATION) throw new Error('navigation_manifest_unavailable');
  const manifestErrors = NAVIGATION.validateManifest();
  if (manifestErrors.length) throw new Error('navigation_manifest_invalid');
  const NAVIGATION_MANIFEST = NAVIGATION.NAVIGATION_MANIFEST;
  const ACTIONS = window.QLCL_ACTIONS;
  if (!ACTIONS) throw new Error('action_registry_unavailable');
  const actionRegistryErrors = ACTIONS.validateRegistry();
  if (actionRegistryErrors.length) throw new Error('action_registry_invalid');
  const BUSINESS_CONFIG = window.QLCL_BUSINESS_CONFIG;
  if (!BUSINESS_CONFIG) throw new Error('business_configuration_workspace_unavailable');
  const EVALUATION_ACTION_POLICY = window.QLCL_EVALUATION_ACTION_POLICY;
  if (!EVALUATION_ACTION_POLICY) throw new Error('evaluation_action_policy_unavailable');
  const REPORTING_PERIOD = window.QLCL_REPORTING_PERIOD;
  if (!REPORTING_PERIOD) throw new Error('reporting_period_unavailable');
  const NAVIGATION_BY_ID = new Map(NAVIGATION_MANIFEST.map((item) => [item.id, item]));
  const FEATURE_FLAGS = Object.freeze({
    ...NAVIGATION.DEFAULT_FEATURE_FLAGS,
    ...(window.QLCL_FEATURE_FLAGS || {}),
  });
  const routeItems = NAVIGATION_MANIFEST.filter((item) => item.route && NAVIGATION.isFeatureEnabled(item, FEATURE_FLAGS));
  const TABS = routeItems.map((item) => item.id);
  const DASHBOARD_TABS = routeItems
    .filter((item) => item.permissions.includes('DASHBOARD.READ') && item.route.startsWith('/dashboard'))
    .map((item) => item.id);
  const GLOBAL_PERIOD_TABS = DASHBOARD_TABS;
  const MOBILE_BREAKPOINT = 768;
  const MOBILE_CARD_PAGE_SIZE = 8;
  const ROUTE_BY_ID = Object.freeze(Object.fromEntries(routeItems.map((item) => [item.id, item.route])));
  const VIEW_IDS = Object.freeze(Object.fromEntries(routeItems.map((item) => [item.id, item.view])));
  const mobileNavigationGroupState = new Map();

  const EVAL_PAGE_SIZE = 15;
  const SUPPLIER_PAGE_SIZE = 15;
  const LEGAL_FILE_EXTENSIONS = ['pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png'];
  let correctiveRequirementItems = [
    { id: null, name: 'Bổ sung hồ sơ', normalized_name: 'bổ sung hồ sơ' },
    { id: null, name: 'Gửi hình ảnh khắc phục', normalized_name: 'gửi hình ảnh khắc phục' },
  ];
  let activeCorrectiveRequirementInput = null;
  let correctiveRequirementCreateTarget = null;
  const REGION_OPTIONS = ['MB', 'MN'];
  const PROVINCES_BY_REGION = {
    MB: [
      'Tỉnh Tuyên Quang',
      'Tỉnh Lào Cai',
      'Tỉnh Thái Nguyên',
      'Tỉnh Phú Thọ',
      'Tỉnh Bắc Ninh',
      'Tỉnh Hưng Yên',
      'Thành phố Hải Phòng',
      'Tỉnh Ninh Bình',
      'Thành phố Hà Nội',
      'Tỉnh Lai Châu',
      'Tỉnh Điện Biên',
      'Tỉnh Sơn La',
      'Tỉnh Lạng Sơn',
      'Tỉnh Quảng Ninh',
      'Tỉnh Thanh Hóa',
      'Tỉnh Nghệ An',
      'Tỉnh Hà Tĩnh',
      'Tỉnh Cao Bằng',
    ],
    MN: [
      'Tỉnh Quảng Trị',
      'Thành phố Đà Nẵng',
      'Tỉnh Quảng Ngãi',
      'Tỉnh Gia Lai',
      'Tỉnh Khánh Hòa',
      'Tỉnh Lâm Đồng',
      'Tỉnh Đắk Lắk',
      'Thành phố Hồ Chí Minh',
      'Tỉnh Đồng Nai',
      'Tỉnh Tây Ninh',
      'Thành phố Cần Thơ',
      'Tỉnh Vĩnh Long',
      'Tỉnh Đồng Tháp',
      'Tỉnh Cà Mau',
      'Tỉnh An Giang',
      'Thành phố Huế',
    ],
  };
  const BUSINESS_TYPE_OPTIONS = ['Tự sản xuất', 'Kinh doanh', 'Sản xuất và kinh doanh'];
  // Compatibility catalog retained for supplier/evaluation behavior.
  const LEGACY_EVALUATION_MCH_CATEGORIES = {
    'D\u1ec7t may': ['B\u00f4ng v\u1ea3i s\u1ee3i', 'Th\u1eddi trang'],
    'H\u00f3a m\u1ef9 ph\u1ea9m': ['Gi\u1ea5y v\u00e0 b\u00f4ng', 'H\u00f3a ph\u1ea9m', 'M\u1ef9 ph\u1ea9m, ch\u0103m s\u00f3c c\u00e1 nh\u00e2n'],
    Homeline: ['\u0110\u1ed3 ch\u01a1i/Gi\u1ea3i tr\u00ed th\u1ec3 thao', '\u0110\u1ed3 d\u00f9ng d\u00e2n d\u1ee5ng/Trang tr\u00ed', 'V\u0103n ph\u00f2ng ph\u1ea9m'],
    'Th\u1ef1c ph\u1ea9m c\u00f4ng ngh\u1ec7': ['B\u00e1nh k\u1eb9o', 'B\u01a1, s\u1eefa, tr\u1ee9ng', '\u0110\u1ed3 u\u1ed1ng, thu\u1ed1c l\u00e1', '\u0110\u00f4ng l\u1ea1nh', 'Th\u1ecbt ngu\u1ed9i, x\u00fac x\u00edch, h\u00e0ng chua', 'Th\u1ef1c ph\u1ea9m kh\u00f4'],
    'Th\u1ef1c ph\u1ea9m t\u01b0\u01a1i s\u1ed1ng, ch\u1ebf bi\u1ebfn': ['B\u00e1nh m\u00ec', 'Rau c\u1ee7', 'Th\u1ecbt', 'Th\u1ee9c \u0103n n\u1ea5u s\u1eb5n', 'Th\u1ee7y h\u1ea3i s\u1ea3n', 'Tr\u00e1i c\u00e2y'],
  };
  const MCH2_VALUES = Object.keys(LEGACY_EVALUATION_MCH_CATEGORIES);
  function normalizedMasterText(value) {
    return String(value || '')
      .trim()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .toUpperCase();
  }
  const FACILITY_BY_TEMPLATE = {
    BM01: ['Cơ sở trồng trọt', 'Cơ sở sơ chế - đóng gói, kinh doanh'],
    BM02: ['Cơ sở giết mổ và cơ sở giết mổ có sơ chế, pha lóc', 'Cơ sở pha lóc, sơ chế, kinh doanh'],
    BM03: ['Cơ sở nuôi trồng', 'Cơ sở sơ chế, sản xuất', 'Cơ sở kinh doanh thủy sản'],
    BM04: ['Cơ sở thực phẩm sơ chế - chế biến'],
  };

  const FALLBACK_CRITERIA_VARIANTS = [
    { template_code: 'BM01', facility_type: 'CO_SO_TRONG_TROT', facility_label: 'Cơ sở trồng trọt', supplier_scale: 'LARGE' },
    { template_code: 'BM01', facility_type: 'CO_SO_TRONG_TROT', facility_label: 'Cơ sở trồng trọt', supplier_scale: 'SMALL' },
    { template_code: 'BM01', facility_type: 'CO_SO_SO_CHE', facility_label: 'Cơ sở sơ chế', supplier_scale: 'LARGE' },
    { template_code: 'BM01', facility_type: 'CO_SO_SO_CHE', facility_label: 'Cơ sở sơ chế', supplier_scale: 'SMALL' },
    { template_code: 'BM02', facility_type: 'GIET_MO_SO_CHE', facility_label: 'Giết mổ + sơ chế', supplier_scale: 'LARGE' },
    { template_code: 'BM02', facility_type: 'GIET_MO_SO_CHE', facility_label: 'Giết mổ + sơ chế', supplier_scale: 'SMALL' },
    { template_code: 'BM02', facility_type: 'CO_SO_PHA_LOC', facility_label: 'Cơ sở pha lóc', supplier_scale: 'LARGE' },
    { template_code: 'BM02', facility_type: 'CO_SO_PHA_LOC', facility_label: 'Cơ sở pha lóc', supplier_scale: 'SMALL' },
    { template_code: 'BM03', facility_type: 'CO_SO_NUOI_TRONG', facility_label: 'Cơ sở nuôi trồng', supplier_scale: 'LARGE' },
    { template_code: 'BM03', facility_type: 'CO_SO_NUOI_TRONG', facility_label: 'Cơ sở nuôi trồng', supplier_scale: 'SMALL' },
    { template_code: 'BM03', facility_type: 'SO_CHE_SAN_XUAT', facility_label: 'Sơ chế, sản xuất', supplier_scale: 'LARGE' },
    { template_code: 'BM03', facility_type: 'SO_CHE_SAN_XUAT', facility_label: 'Sơ chế, sản xuất', supplier_scale: 'SMALL' },
    { template_code: 'BM03', facility_type: 'KINH_DOANH_THUY_SAN', facility_label: 'Kinh doanh thủy sản', supplier_scale: 'LARGE' },
    { template_code: 'BM03', facility_type: 'KINH_DOANH_THUY_SAN', facility_label: 'Kinh doanh thủy sản', supplier_scale: 'SMALL' },
    { template_code: 'BM04', facility_type: 'CHUNG', facility_label: 'Chung', supplier_scale: 'LARGE' },
    { template_code: 'BM04', facility_type: 'CHUNG', facility_label: 'Chung', supplier_scale: 'SMALL' },
  ];

  const demoEvaluations = [];
  const REPORT_TYPES = [
    {
      code: 'WORKING_MINUTES',
      label: 'Biên bản làm việc với NCC',
      roundNo: 1,
      minCompletedRound: 1,
      note: 'Dùng dữ liệu đánh giá lần 1; không hiển thị điểm số, thang điểm, tỷ lệ và phân hạng.',
    },
    {
      code: 'ROUND1_RESULT',
      label: 'Kết quả đánh giá lần 1',
      roundNo: 1,
      minCompletedRound: 1,
      note: 'Dùng dữ liệu đánh giá lần 1, bao gồm điểm số, tỷ lệ, phân hạng và kết luận lần 1.',
    },
    {
      code: 'ROUND2_RESULT',
      label: 'Kết quả đánh giá lần 2',
      roundNo: 2,
      minCompletedRound: 2,
      note: 'Dùng dữ liệu đánh giá lần 2, bao gồm điểm số, tỷ lệ, phân hạng và kết luận cuối cùng.',
    },
  ];

  const SCORE_VALUES = { A: 100, B: 75, C: 25, D: 0 };
  const questionBank = [];
  const answersByTicket = {};
  let supplierLookupTimer = null;
  let scoringValidationTarget = null;
  let activeActionMenu = null;
  let activeActionMenuButton = null;
  let actionTooltipEl = null;
  let actionLayerListenersReady = false;

  function hasCapability(permission) { return (state.capabilities || []).includes(permission); }
  function canManageSystem() { return hasCapability('SYSTEM.ADMIN'); }
  function canReadAudit() { return hasCapability('AUDIT.READ'); }
  function canExportAudit() { return hasCapability('AUDIT.EXPORT'); }
  function canEditWorkflow() { return hasCapability('EVALUATION.CREATE') || hasCapability('EVALUATION.SCORE'); }
  function canManageSuppliers() { return hasCapability('SUPPLIER.WRITE'); }
  function isInternalUser() { return hasCapability('SUPPLIER.READ'); }
  function resourceCan(row, action) { return Array.isArray(row?.allowed_actions) && row.allowed_actions.includes(action); }
  function ownsWorkflowRecord(row) {
    return row?.evaluation_workspace_visible !== false && resourceCan(row, 'view');
  }
  function canEditWorkflowRecord(row) { return resourceCan(row, 'edit') || resourceCan(row, 'score'); }
  function approvalRoleFromLevel(level) {
    const key = String(level || '').trim().toUpperCase();
    if (key === 'LEAD') return 'Lead miền';
    if (key === 'TBP') return 'TBP';
    if (key === 'GDK') return 'GĐK';
    return '';
  }
  function approvalRoleForRecord(row) {
    const pending = row && row.pendingApproval;
    if (pending && String(pending.status || 'PENDING').toUpperCase() === 'PENDING') {
      return pending.assigned_role || approvalRoleFromLevel(pending.approval_level);
    }
    const status = String(row && row.status || '');
    if (!status.startsWith('Chờ duyệt')) return '';
    if (status.includes('Lead')) return 'Lead miền';
    if (status.includes('TBP')) return 'TBP';
    return 'GĐK';
  }
  function canSeeApprovalRecord(row) {
    if (!row) return false;
    return ['approve_lead', 'approve_tbp', 'approve_gdk'].some((action) => resourceCan(row, action));
  }
  function mapAssessmentApprovalRecord(row) {
    return {
      ...row,
      approvalType: 'assessment',
      approvalTypeLabel: 'Đánh giá NCC',
      code: row.code,
      supplier_name: row.supplier_name,
      role: approvalRoleForRecord(row),
      resultText: row.result == null ? '—' : row.result.toFixed(1) + '%',
    };
  }
  function approvalDetail(row) {
    return openTicketDetail(row.code);
  }

  function isoToVNDate(value) {
    const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : (value || '');
  }
  function dateInputValue(value) {
    const raw = String(value || '').trim();
    const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) return raw;
    const vn = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    return vn ? `${vn[3]}-${vn[2]}-${vn[1]}` : '';
  }
  function isValidISODate(value) {
    const m = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return false;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]);
  }
  function addCalendarDaysISODate(value, days) {
    const text = String(value || '').trim();
    const amount = Number(days);
    if (!isValidISODate(text) || !Number.isInteger(amount)) return '';
    const [year, month, day] = text.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    date.setUTCDate(date.getUTCDate() + amount);
    return date.toISOString().slice(0, 10);
  }
  function localTodayISODate() {
    const now = new Date();
    return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  }
  function parseDateValue(value) {
    const iso = dateInputValue(value);
    if (!isValidISODate(iso)) return null;
    const [year, month, day] = iso.split('-').map(Number);
    return new Date(year, month - 1, day);
  }
  function todayDateValue() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  function daysBetweenDates(a, b) {
    return Math.round((a.getTime() - b.getTime()) / 86400000);
  }
  function reassessmentStatus(ticket) {
    if (!ticket || ticket.status !== 'Chờ khắc phục' || !ticket.reassessment_due_date_iso) {
      return { applies: false, due: false, overdue: false, days: null, label: '—', severity: 'gray' };
    }
    const dueDate = parseDateValue(ticket.reassessment_due_date_iso);
    if (!dueDate) return { applies: false, due: false, overdue: false, days: null, label: '—', severity: 'gray' };
    const diff = daysBetweenDates(dueDate, todayDateValue());
    if (diff > 0) return { applies: true, due: false, overdue: false, days: diff, label: 'Còn ' + diff + ' ngày', severity: 'green' };
    if (diff === 0) return { applies: true, due: true, overdue: false, days: 0, label: 'Đến hạn hôm nay', severity: 'amber' };
    return { applies: true, due: true, overdue: true, days: Math.abs(diff), label: 'Quá hạn ' + Math.abs(diff) + ' ngày', severity: 'red' };
  }
  function reassessmentBadge(ticket) {
    const status = reassessmentStatus(ticket);
    return el('span', { className: 'tag sev-' + status.severity, text: status.label });
  }
  function userDisplay(record, field) {
    if (!record) return '';
    return record[field + '_display_name'] || record[field] || '';
  }
  function userDisplayValue(value, displayName) {
    return displayName || value || '';
  }
  function qaSupportDisplay(ticket) {
    return (ticket.participants || [])
      .filter((participant) => participant.participant_role === 'QA_SUPPORT')
      .map((participant) => participant.display_name || participant.user_id)
      .filter(Boolean)
      .join(', ');
  }
  function mapTicketFromApi(ticket) {
    const displayScore = ticket.display_score_percent ?? ticket.score_percent;
    const round1Score = ticket.round_1_score_percent ?? ticket.score_percent;
    const participants = Array.isArray(ticket.participants) ? ticket.participants : [];
    const participantForRole = (role) => participants.find((row) => row.participant_role === role);
    const evaluator = participantForRole('EVALUATOR');
    const qaLead = participantForRole('QA_LEAD');
    return {
      code: ticket.ticket_code,
      id: ticket.id,
      source_kind: ticket.source_kind || 'NATIVE',
      is_historical: !!ticket.is_historical,
      read_only: !!ticket.read_only,
      historical_source_stt: ticket.historical_source_stt || null,
      supplier_id: ticket.supplier_id,
      supplier_code: ticket.supplier && ticket.supplier.code,
      supplier_name: ticket.supplier && ticket.supplier.name,
      tax_code: ticket.supplier && ticket.supplier.tax_code,
      address: ticket.supplier && ticket.supplier.address,
      production_address: ticket.supplier && ticket.supplier.production_address,
      evaluation_address: ticket.supplier && (ticket.supplier.snapshot_evaluation_address || ticket.supplier.evaluation_address),
      snapshot_evaluation_address: ticket.supplier && (ticket.supplier.snapshot_evaluation_address || ticket.supplier.evaluation_address),
      linked_facility_code: ticket.supplier && ticket.supplier.linked_facility_code,
      linked_facility_name: ticket.supplier && (ticket.supplier.snapshot_linked_facility_name || ticket.supplier.linked_facility_name),
      linked_facility_address: ticket.supplier && (ticket.supplier.snapshot_linked_facility_address || ticket.supplier.linked_facility_address),
      snapshot_linked_facility_name: ticket.supplier && (ticket.supplier.snapshot_linked_facility_name || ticket.supplier.linked_facility_name),
      snapshot_linked_facility_address: ticket.supplier && (ticket.supplier.snapshot_linked_facility_address || ticket.supplier.linked_facility_address),
      linked_facility_type: ticket.supplier && ticket.supplier.linked_facility_type,
      region: ticket.supplier && ticket.supplier.region,
      province: ticket.supplier && ticket.supplier.province,
      business_type: ticket.supplier && ticket.supplier.business_type,
      cmc_owner: ticket.supplier && ticket.supplier.cmc_owner,
      cmc_head: ticket.supplier && ticket.supplier.cmc_head,
      business_license_file: ticket.supplier && ticket.supplier.business_license_file,
      attp_certificate_type: ticket.supplier && ticket.supplier.attp_certificate_type,
      attp_certificate_file: ticket.supplier && ticket.supplier.attp_certificate_file,
      contact_name: ticket.supplier && ticket.supplier.contact_name,
      contact_email: ticket.supplier && ticket.supplier.contact_email,
      contact_phone: ticket.supplier && ticket.supplier.contact_phone,
      evaluation_type: ticket.evaluation_type,
      mch2: ticket.merchandising && ticket.merchandising.mch2,
      mch3: ticket.merchandising && ticket.merchandising.mch3,
      product_group: ticket.product_group || ticket.template_code,
      snapshot_product_name: ticket.snapshot_product_name || ticket.product_name || '',
      product_name: ticket.snapshot_product_name || ticket.product_name || '',
      facility_type: ticket.facility_type || '',
      supplier_scale: ticket.supplier_scale || '',
      evaluation_method: ticket.evaluation_method || '',
      participants,
      participant_source: ticket.participant_source || 'NONE',
      participant_mismatch: !!ticket.participant_mismatch,
      evaluator_name: evaluator?.display_name || evaluator?.user_id || '',
      qa_lead: qaLead?.display_name || qaLead?.user_id || '',
      qa_support: qaSupportDisplay(ticket),
      evaluation_department: ticket.evaluation_department || '',
      template_code: ticket.template_code || '',
      question_template_version_id: ticket.question_template_version_id || null,
      question_template_version_no: ticket.question_template_version_no || null,
      question_template_version_status: ticket.question_template_version_status || '',
      question_template_version_checksum: ticket.question_template_version_checksum || '',
      created_iso: dateInputValue(ticket.dates && ticket.dates.created),
      planned_iso: dateInputValue(ticket.dates && ticket.dates.planned),
      actual_evaluation_date_iso: dateInputValue(ticket.dates && ticket.dates.actual),
      correction_date_iso: dateInputValue(ticket.dates && ticket.dates.correction),
      next_evaluation_date_iso: dateInputValue(ticket.dates && ticket.dates.next_evaluation),
      reassessment_due_date_iso: dateInputValue(ticket.reassessment_due_date || (ticket.dates && ticket.dates.reassessment_due)),
      created_at: isoToVNDate(ticket.dates && ticket.dates.created),
      planned_at: isoToVNDate(ticket.dates && ticket.dates.planned),
      actual_evaluation_date: isoToVNDate(ticket.dates && ticket.dates.actual),
      correction_date: isoToVNDate(ticket.dates && ticket.dates.correction),
      next_evaluation_date: isoToVNDate(ticket.dates && ticket.dates.next_evaluation),
      reassessment_due_date: isoToVNDate(ticket.reassessment_due_date || (ticket.dates && ticket.dates.reassessment_due)),
      assignee: userDisplayValue(ticket.assignee_name, ticket.assignee_display_name),
      status: ticket.workflow_status,
      result: displayScore == null ? null : Number(displayScore),
      grade: ticket.display_grade_code || ticket.grade_code || '—',
      result_label: ticket.display_result_label || ticket.result_label || '',
      round_1_score_percent: round1Score == null ? null : Number(round1Score),
      round_1_grade_code: ticket.round_1_grade_code || ticket.grade_code || '',
      round_1_result_label: ticket.round_1_result_label || ticket.result_label || '',
      score_percent: ticket.score_percent,
      result_reason: ticket.result_reason || '',
      corrected_score_percent: ticket.corrected_score_percent,
      corrected_grade_code: ticket.corrected_grade_code || '',
      corrected_result_label: ticket.corrected_result_label || '',
      final_conclusion: ticket.final_conclusion || '',
      specialist_proposal: ticket.specialist_proposal || '',
      supplier_introduction: ticket.supplier_introduction || '',
      scoringLocked: !!ticket.scoring_locked,
      completed_round: ticket.completed_round || 1,
      current_round_no: ticket.current_round_no || ticket.completed_round || 1,
      round_2_exists: !!ticket.round_2_exists,
      round_2_eligible: !!ticket.round_2_eligible,
      round_2_block_reason: ticket.round_2_block_reason || '',
      created_by: ticket.created_by || '',
      updated_by: ticket.updated_by || '',
      created_by_display_name: userDisplayValue(ticket.created_by, ticket.created_by_display_name),
      updated_by_display_name: userDisplayValue(ticket.updated_by, ticket.updated_by_display_name),
      pendingApproval: ticket.pending_approval || null,
      allowed_actions: ticket.allowed_actions || [],
      disabled_reasons: ticket.disabled_reasons || {},
      evaluation_workspace_visible: ticket.evaluation_workspace_visible !== false,
    };
  }
  function mapQuestionFromApi(question) {
    return {
      id: String(question.question_item_id || question.question_id || question.id),
      db_id: question.db_id || question.id,
      question_item_id: question.question_item_id || null,
      template_id: question.template_id,
      template_code: question.template_code || '',
      question_template_version_id: question.question_template_version_id || null,
      question_template_version_no: question.question_template_version_no || null,
      question_template_version_checksum: question.question_template_version_checksum || '',
      facility_type: question.facility_type || 'ALL',
      supplier_scale: question.supplier_scale || 'ALL',
      question_code: question.question_code || question.question_id || '',
      section: question.section_name || question.category || '',
      question: question.text || question.question_text || '',
      clause: question.clause_type || (question.is_elimination_clause ? 'exclusion' : 'normal'),
      critical: !!(question.is_critical || question.is_critical_clause),
      requiresAttachment: !!question.requires_attachment,
      allowedScores: String(question.allowed_scores || (question.is_elimination_clause ? 'A/D/NA' : 'A/B/C/D/NA')).split('/').filter(Boolean),
      order_index: question.order_index || 0,
      active: question.active !== false,
    };
  }
  function applyWorkflowPayload(payload) {
    demoEvaluations.splice(0, demoEvaluations.length, ...(payload.tickets || []).map(mapTicketFromApi));
    questionBank.splice(0, questionBank.length, ...(payload.questions || []).map(mapQuestionFromApi));
    state.roundLoaded = {};
    state.roundQuestions = {};
    state.roundAttendees = {};
    state.scoringDraftCorrectiveRequirements = {};
    Object.keys(answersByTicket).forEach((key) => delete answersByTicket[key]);
    Object.assign(answersByTicket, payload.answers || {});
  }
  function criteriaVariants() {
    return state.criteriaVariants.length ? state.criteriaVariants : FALLBACK_CRITERIA_VARIANTS;
  }
  function variantsForTemplate(templateCode) {
    const seen = new Set();
    return criteriaVariants()
      .filter((variant) => variant.template_code === templateCode)
      .filter((variant) => {
        if (seen.has(variant.facility_type)) return false;
        seen.add(variant.facility_type);
        return true;
      });
  }
  async function loadCriteriaVariants() {
    const r = await api('/question-templates/variants');
    if (r.ok && Array.isArray(r.data.items)) state.criteriaVariants = r.data.items;
  }

  function notificationCountText(value) {
    const count = Math.max(0, Number(value || 0));
    return count > 99 ? '99+' : String(count);
  }

  function updateNotificationBadges() {
    const count = Math.max(0, Number(state.notificationUnreadCount || 0));
    ['notification-unread-badge', 'mobile-notification-unread-badge'].forEach((id) => {
      const badge = $(id);
      if (!badge) return;
      badge.textContent = notificationCountText(count);
      badge.classList.toggle('hidden', count === 0);
    });
  }

  function notificationTime(value) {
    if (!value) return '';
    const parsed = new Date(String(value).replace(' ', 'T') + (String(value).includes('Z') ? '' : 'Z'));
    if (Number.isNaN(parsed.getTime())) return String(value);
    return new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' }).format(parsed);
  }

  function isEvaluationNotification(item) {
    const payload = item?.payload || {};
    const entityType = String(payload.entity_type || '').trim().toUpperCase();
    if (entityType) return entityType === 'EVALUATION' || entityType === 'EVALUATION_TICKET';
    return true;
  }

  function renderNotifications() {
    const list = $('notification-list');
    if (!list) return;
    list.textContent = '';
    document.querySelectorAll('[data-notification-filter]').forEach((button) => {
      const selected = button.dataset.notificationFilter === state.notificationFilter;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
    if (state.notificationLoading) {
      list.appendChild(el('div', { className: 'notification-empty', text: 'Đang tải thông báo…' }));
      return;
    }
    if (!state.notifications.length) {
      const emptyText = state.notificationFilter === 'unread' ? 'Không có thông báo chưa đọc.'
        : state.notificationFilter === 'action' ? 'Không có thông báo cần xử lý.' : 'Chưa có thông báo.';
      list.appendChild(el('div', { className: 'notification-empty', text: emptyText }));
      return;
    }
    state.notifications.forEach((item) => {
      const card = el('article', { className: 'notification-item' + (item.is_read ? '' : ' unread') });
      card.appendChild(el('h3', { className: 'notification-item-title', text: item.title || 'Thông báo' }));
      card.appendChild(el('div', {
        className: 'notification-item-identity mono',
        text: [item.ticket_code, item.supplier_name].filter(Boolean).join(' · ') || 'Hệ thống QLCL',
      }));
      card.appendChild(el('div', { className: 'notification-item-summary', text: item.message || '' }));
      const meta = el('div', { className: 'notification-item-meta' });
      meta.appendChild(el('span', { className: 'notification-severity ' + String(item.severity || '').toLowerCase(), attrs: { 'aria-hidden': 'true' } }));
      meta.appendChild(el('span', { text: String(item.severity || 'MEDIUM').toUpperCase() }));
      meta.appendChild(el('span', { text: '·' }));
      meta.appendChild(el('time', { text: notificationTime(item.created_at) }));
      meta.appendChild(el('span', { text: item.is_read ? 'Đã đọc' : 'Chưa đọc' }));
      card.appendChild(meta);
      const actions = el('div', { className: 'notification-item-actions' });
      if (item.action_label && item.deep_link) {
        const primary = el('button', { className: 'btn-primary', text: item.action_label, attrs: { type: 'button', 'data-notification-open': String(item.id) } });
        primary.addEventListener('click', () => openNotificationTarget(item));
        actions.appendChild(primary);
      } else actions.appendChild(el('span'));
      if (!item.is_read) {
        const read = el('button', { className: 'notification-read-one', text: 'Đánh dấu đã đọc', attrs: { type: 'button' } });
        read.addEventListener('click', () => markNotificationRead(item.id));
        actions.appendChild(read);
      }
      card.appendChild(actions);
      list.appendChild(card);
    });
  }

  async function loadNotifications(filter = state.notificationFilter) {
    if (!state.email) return;
    state.notificationFilter = ['all', 'unread', 'action'].includes(filter) ? filter : 'all';
    state.notificationLoading = true;
    renderNotifications();
    const r = await api('/notifications?filter=' + encodeURIComponent(state.notificationFilter) + '&limit=100');
    state.notificationLoading = false;
    if (!r.ok) {
      state.notifications = [];
      renderNotifications();
      return;
    }
    state.notifications = (Array.isArray(r.data.items) ? r.data.items : []).filter(isEvaluationNotification);
    state.notificationUnreadCount = state.notifications.filter((item) => !item.is_read).length;
    updateNotificationBadges();
    renderNotifications();
  }

  function openNotificationPanel() {
    const panel = $('notification-panel');
    if (!panel) return;
    panel.classList.remove('hidden');
    document.body.classList.add('modal-open');
    loadNotifications();
    window.setTimeout(() => $('notification-close')?.focus(), 0);
  }

  function closeNotificationPanel() {
    $('notification-panel')?.classList.add('hidden');
    document.body.classList.remove('modal-open');
  }

  async function markNotificationRead(id, options = {}) {
    const r = await api('/notifications/' + encodeURIComponent(id) + '/read', { method: 'PATCH', body: {} });
    if (!r.ok) return false;
    const item = state.notifications.find((row) => String(row.id) === String(id));
    if (item && !item.is_read) {
      item.is_read = true;
      state.notificationUnreadCount = Math.max(0, state.notificationUnreadCount - 1);
    }
    updateNotificationBadges();
    if (!options.deferRender) {
      if (state.notificationFilter === 'unread') state.notifications = state.notifications.filter((row) => String(row.id) !== String(id));
      renderNotifications();
    }
    return true;
  }

  async function markAllNotificationsRead() {
    const r = await api('/notifications/read-all', { method: 'POST', body: {} });
    if (!r.ok) return showToast('Không thể đánh dấu tất cả thông báo.', 'err');
    state.notificationUnreadCount = 0;
    state.notifications.forEach((item) => { item.is_read = true; });
    if (state.notificationFilter === 'unread') state.notifications = [];
    updateNotificationBadges();
    renderNotifications();
  }

  async function openNotificationTarget(item) {
    await markNotificationRead(item.id, { deferRender: true });
    closeNotificationPanel();
    const payload = item.payload || {};
    const code = item.ticket_code || payload.ticket_code;
    const requiresAction = Boolean(item.requires_action || payload.requires_action);
    state.notificationDeepLinkKey = '';
    if (requiresAction) {
      state.approvalSearch = code || '';
      if ($('approval-search')) $('approval-search').value = state.approvalSearch;
      window.location.hash = '/approvals' + (code ? '?ticket=' + encodeURIComponent(code) : '');
      await loadWorkflowData(true);
      return;
    }
    window.location.hash = '/evaluations' + (code ? '?ticket=' + encodeURIComponent(code) : '');
    await loadWorkflowData(true);
  }

  async function loadWorkflowData(force) {
    if (state.workflowLoading || (state.workflowLoaded && !force)) return;
    state.workflowLoading = true;
    state.workflowError = '';
    loadWorkflowTab();
    const [r, , correctiveRequirements] = await Promise.all([
      api('/evaluations/bootstrap'),
      loadCriteriaVariants().catch(() => null),
      api('/evaluations/corrective-requirements').catch(() => null),
    ]);
    state.workflowLoading = false;
    if (!r.ok) {
      state.workflowError = UI_TEXT.workflow.loadFailed;
      loadWorkflowTab();
      return;
    }
    applyWorkflowPayload(r.data || {});
    if (correctiveRequirements?.ok && Array.isArray(correctiveRequirements.data?.items)) {
      correctiveRequirementItems = correctiveRequirements.data.items;
    }
    state.workflowLoaded = true;
    loadWorkflowTab();
    loadNotifications();
    openRecordDeepLink();
  }
  async function persistAnswers(code) {
    const ticket = demoEvaluations.find((row) => row.code === code);
    const roundNo = ticket ? (ticket.current_round_no || ticket.completed_round || 1) : 1;
    const r = await api('/evaluations/' + encodeURIComponent(code) + '/rounds/' + roundNo + '/answers', {
      method: 'PUT',
      body: {
        canonical_answers: answersByTicket[code] || {},
        attendees: state.roundAttendees[roundStateKey(code, roundNo)] || [],
        supplier_introduction: ticket ? (ticket.supplier_introduction || '') : '',
      },
    });
    if (!r.ok) throw new Error((r.data && r.data.error) || 'answers_update_failed');
    if (r.data && (r.data.canonical_answers || r.data.answers)) {
      answersByTicket[code] = r.data.canonical_answers || r.data.answers;
    }
    if (r.data && r.data.round) {
      state.roundAttendees[roundStateKey(code, roundNo)] = normalizeAttendees(r.data.round.attendees || []);
    }
    if (r.data && r.data.ticket) {
      const updated = mapTicketFromApi(r.data.ticket);
      const index = demoEvaluations.findIndex((row) => row.code === updated.code);
      if (index >= 0) Object.assign(demoEvaluations[index], updated);
      if (ticket) ticket.supplier_introduction = updated.supplier_introduction || '';
    }
    if (ticket && Array.isArray(r.data && r.data.nonconformities)) {
      ticket.nonconformities = r.data.nonconformities;
      await applyDraftNonconformityRequirements(ticket);
    }
  }

  async function loadRoundData(ticket, force) {
    if (!ticket) return null;
    const roundNo = ticket.current_round_no || ticket.completed_round || 1;
    const key = ticket.code + ':' + roundNo;
    if (state.roundLoaded[key] && !force) return answersByTicket[ticket.code] || {};
    const detailRequest = force || !Array.isArray(ticket.workflow_history)
      ? api('/evaluations/' + encodeURIComponent(ticket.code))
      : Promise.resolve(null);
    const [r, detail] = await Promise.all([
      api('/evaluations/' + encodeURIComponent(ticket.code) + '/rounds/' + roundNo),
      detailRequest,
    ]);
    if (!r.ok) throw new Error((r.data && r.data.error) || 'round_load_failed');
    if (detail?.ok) {
      Object.assign(ticket, mapTicketFromApi(detail.data.ticket));
      ticket.workflow_history = detail.data.workflow_history || [];
      ticket.approval_tasks = detail.data.approval_tasks || [];
    }
    state.roundQuestions[key] = (r.data.questions || []).map(mapQuestionFromApi);
    answersByTicket[ticket.code] = r.data.canonical_answers || r.data.answers || {};
    if (r.data.round) {
      ticket.scoringLocked = !!r.data.round.locked;
      ticket.roundStatus = r.data.round.status;
      ticket.result = r.data.round.total_score == null ? ticket.result : Number(r.data.round.total_score);
      ticket.grade = r.data.round.classification || ticket.grade;
      ticket.result_label = r.data.round.final_result || ticket.result_label;
      state.roundAttendees[key] = normalizeAttendees(r.data.round.attendees || []);
    }
    ticket.nonconformities = r.data.nonconformities || [];
    if (r.data.ticket) {
      const updated = mapTicketFromApi(r.data.ticket);
      const index = demoEvaluations.findIndex((row) => row.code === updated.code);
      if (index >= 0) Object.assign(demoEvaluations[index], updated, { scoringLocked: ticket.scoringLocked, nonconformities: ticket.nonconformities });
    }
    state.roundLoaded[key] = true;
    return answersByTicket[ticket.code];
  }

  async function uploadScoringAttachment(ticket, questionId, file) {
    const roundNo = ticket.current_round_no || ticket.completed_round || 1;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('question_item_id', questionId);
    const r = await api('/evaluations/' + encodeURIComponent(ticket.code) + '/rounds/' + roundNo + '/attachments', { method: 'POST', body: fd });
    if (!r.ok) throw new Error((r.data && r.data.error) || 'attachment_upload_failed');
    const answers = ensureAnswers(ticket.code, questionsForTicket(ticket));
    answers[questionId] = answers[questionId] || { score: '', note: '' };
    answers[questionId].answer_id = r.data.answer_id;
    answers[questionId].attachments = answers[questionId].attachments || [];
    answers[questionId].attachments.unshift(r.data.attachment);
  }

  function supplierQueryString() {
    const params = new URLSearchParams();
    params.set('page', String(state.supplierPage));
    params.set('page_size', String(SUPPLIER_PAGE_SIZE));
    if (state.supplierSearch) params.set('q', state.supplierSearch);
    if (state.supplierFilters.status) params.set('status', state.supplierFilters.status);
    return params.toString();
  }

  async function loadSuppliers() {
    state.supplierLoading = true;
    state.supplierError = '';
    renderSuppliers();
    const r = await api('/suppliers?' + supplierQueryString());
    state.supplierLoading = false;
    if (!r.ok) {
      state.supplierError = UI_TEXT.suppliers.loadFailed;
      state.suppliers = [];
      state.supplierTotal = 0;
      renderSuppliers();
      return;
    }
    state.suppliers = r.data.items || [];
    state.supplierTotal = r.data.total || 0;
    state.supplierPage = r.data.page || state.supplierPage;
    renderSuppliers();
  }

  function supplierStatusTag(status) {
    const s = String(status || 'ACTIVE').toUpperCase();
    const sev = s === 'ACTIVE' ? 'green' : s === 'SUSPENDED' ? 'amber' : 'gray';
    return el('span', { className: 'tag sev-' + sev, text: statusText(s) });
  }
  function supplierValue(value) {
    return value == null || value === '' ? '—' : String(value);
  }
  function appendSupplierCardField(cardGrid, label, value) {
    const item = el('div', { className: 'supplier-card-field' });
    item.appendChild(el('div', { className: 'k', text: label }));
    item.appendChild(el('div', { className: 'v', text: supplierValue(value) }));
    cardGrid.appendChild(item);
  }
  function appendSupplierMobileState(list, message) {
    const card = el('div', { className: 'supplier-card' });
    card.appendChild(el('div', { className: 'muted', text: message }));
    list.appendChild(card);
  }
  function renderSupplierActions(row) {
    const descriptors = [
      actionDescriptor('supplier.view', () => openSupplierDetail(row), row),
      actionDescriptor('supplier.edit', () => openSupplierModal(row.id), row),
      actionDescriptor('supplier.history', () => openSupplierHistory(row), row),
    ].filter(Boolean);
    const wrap = RowActionGroup(descriptors);
    wrap.classList.add('supplier-action-icons');
    return wrap;
  }
  function appendSupplierMobileCard(list, row, indexLabel) {
    const card = el('article', { className: 'supplier-card' });
    const head = el('div', { className: 'supplier-card-head' });
    const title = el('div', { className: 'supplier-card-title' });
    title.appendChild(el('div', { className: 'supplier-card-code', text: `${indexLabel} · ${supplierValue(row.supplier_code)}` }));
    title.appendChild(el('div', { className: 'supplier-card-name', text: supplierValue(row.supplier_name) }));
    head.appendChild(title);
    head.appendChild(supplierStatusTag(row.status));
    card.appendChild(head);

    const grid = el('div', { className: 'supplier-card-grid' });
    appendSupplierCardField(grid, 'MST', row.tax_code);
    appendSupplierCardField(grid, 'Địa chỉ', row.address);
    appendSupplierCardField(grid, 'Loại hình', row.business_type);
    card.appendChild(grid);

    if (isInternalUser()) {
      const actions = el('div', { className: 'supplier-card-actions' });
      actions.appendChild(renderSupplierActions(row));
      card.appendChild(actions);
    }
    list.appendChild(card);
  }

  const SUPPLIER_REQUIRED_FIELD_SPECS = [
    { id: 'supplier-code', key: 'supplier_code', label: 'Mã NCC', always: true },
    { id: 'supplier-name', key: 'supplier_name', label: 'Tên NCC', always: true },
    { id: 'supplier-tax-code', key: 'tax_code', label: 'Mã số thuế', manualCreate: true },
    { id: 'supplier-address', key: 'address', label: 'Địa chỉ', manualCreate: true },
    { id: 'supplier-region', key: 'region', label: 'Khu vực', manualCreate: true },
    { id: 'supplier-province', key: 'province', label: 'Tỉnh', manualCreate: true },
    { id: 'supplier-business-type', key: 'business_type', label: 'Loại hình kinh doanh', manualCreate: true },
    { id: 'supplier-contact-name', key: 'contact_name', label: 'Người liên hệ', manualCreate: true },
    { id: 'supplier-contact-email', key: 'contact_email', label: 'Email liên hệ', manualCreate: true },
    { id: 'supplier-contact-phone', key: 'contact_phone', label: 'SĐT liên hệ', manualCreate: true },
  ];
  const SUPPLIER_FIELD_BY_KEY = SUPPLIER_REQUIRED_FIELD_SPECS.reduce((acc, spec) => {
    acc[spec.key] = spec;
    return acc;
  }, {});

  function supplierFormPayload() {
    return {
      supplier_code: $('supplier-code').value.trim(),
      supplier_name: $('supplier-name').value.trim(),
      tax_code: $('supplier-tax-code').value.trim(),
      address: $('supplier-address').value.trim(),
      region: $('supplier-region').value.trim(),
      province: $('supplier-province').value.trim(),
      business_type: $('supplier-business-type').value.trim(),
      contact_name: $('supplier-contact-name').value.trim(),
      contact_email: $('supplier-contact-email').value.trim(),
      contact_phone: $('supplier-contact-phone').value.trim(),
      status: $('supplier-status').value,
    };
  }
  function setSupplierFieldError(id, message) {
    const field = $(id);
    if (field) field.classList.toggle('invalid', !!message);
    const err = document.querySelector('[data-supplier-error-for="' + id + '"]');
    if (err) err.textContent = message || '';
  }
  function supplierRequiredFieldSpecs() {
    return SUPPLIER_REQUIRED_FIELD_SPECS;
  }
  function validateSupplierRequiredFields() {
    const activeIds = new Set();
    let ok = true;
    supplierRequiredFieldSpecs().forEach((spec) => {
      activeIds.add(spec.id);
      const field = $(spec.id);
      const valid = !!String((field && field.value) || '').trim();
      setSupplierFieldError(spec.id, valid ? '' : `Vui lòng nhập ${spec.label}.`);
      if (!valid) ok = false;
    });
    SUPPLIER_REQUIRED_FIELD_SPECS.forEach((spec) => {
      if (!activeIds.has(spec.id)) setSupplierFieldError(spec.id, '');
    });
    const region = $('supplier-region') ? $('supplier-region').value.trim() : '';
    const province = $('supplier-province') ? $('supplier-province').value.trim() : '';
    const businessType = $('supplier-business-type') ? $('supplier-business-type').value.trim() : '';
    if (region && !isValidRegionValue(region)) {
      setSupplierFieldError('supplier-region', 'Khu vực không hợp lệ.');
      ok = false;
    }
    if (province && !isValidProvinceValue(region, province)) {
      setSupplierFieldError('supplier-province', 'Tỉnh không thuộc khu vực đã chọn.');
      ok = false;
    }
    if (businessType && !isValidBusinessTypeValue(businessType)) {
      setSupplierFieldError('supplier-business-type', 'Loại hình kinh doanh không hợp lệ.');
      ok = false;
    }
    const contactEmail = $('supplier-contact-email') ? $('supplier-contact-email').value.trim() : '';
    if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
      setSupplierFieldError('supplier-contact-email', 'Email liên hệ không hợp lệ.');
      ok = false;
    }
    const contactPhone = $('supplier-contact-phone') ? $('supplier-contact-phone').value.trim() : '';
    if (contactPhone && !/^[0-9+\-\s.]{8,20}$/.test(contactPhone)) {
      setSupplierFieldError('supplier-contact-phone', 'Số điện thoại không hợp lệ.');
      ok = false;
    }
    return ok;
  }
  function clearSupplierFormErrors() {
    SUPPLIER_REQUIRED_FIELD_SPECS.forEach((spec) => setSupplierFieldError(spec.id, ''));
  }
  function applySupplierServerErrors(errors) {
    clearSupplierFormErrors();
    let highlighted = false;
    Object.entries(errors || {}).forEach(([key, value]) => {
      const spec = SUPPLIER_FIELD_BY_KEY[key];
      if (!spec) return;
      const message = value === 'invalid'
        ? (key === 'contact_email' ? 'Email liên hệ không hợp lệ.' : `${spec.label} không hợp lệ.`)
        : `Vui lòng nhập ${spec.label}.`;
      setSupplierFieldError(spec.id, message);
      highlighted = true;
    });
    return highlighted;
  }

  function fillSupplierForm(row) {
    $('supplier-code').value = row?.supplier_code || '';
    $('supplier-name').value = row?.supplier_name || '';
    $('supplier-tax-code').value = row?.tax_code || '';
    $('supplier-address').value = row?.address || '';
    setMasterDataControlValues('supplier', row?.region, row?.province, row?.business_type);
    $('supplier-contact-name').value = row?.contact_name || '';
    $('supplier-contact-email').value = row?.contact_email || '';
    $('supplier-contact-phone').value = row?.contact_phone || '';
    $('supplier-status').value = row?.status || 'ACTIVE';
  }

  async function openSupplierModal(id) {
    if (!canManageSuppliers()) return;
    state.editingSupplierId = id || null;
    fillSupplierForm(null);
    setMsg('supplier-form-msg', '');
    clearSupplierFormErrors();
    $('supplier-modal-title').textContent = id ? 'Cập nhật NCC' : 'Thêm NCC thủ công';
    if (id) {
      const r = await api('/suppliers/' + encodeURIComponent(id));
      if (!r.ok) {
        showToast(UI_TEXT.suppliers.detailLoadFailed, 'err');
        return;
      }
      fillSupplierForm(r.data.item);
    }
    $('supplier-modal').classList.remove('hidden');
  }

  const SUPPLIER_EMPTY_TEXT = '-';
  const SUPPLIER_DETAIL_SECTIONS = [
    {
      title: 'Thông tin nhà cung cấp',
      fields: [
        ['supplier_code', 'Mã nhà cung cấp'],
        ['supplier_name', 'Tên NCC'],
        ['tax_code', 'Mã số thuế'],
        ['address', 'Địa chỉ'],
        ['region', 'Khu vực'],
        ['province', 'Tỉnh'],
        ['business_type', 'Loại hình kinh doanh'],
        ['status', 'Trạng thái'],
      ],
    },
    {
      title: 'Thông tin liên hệ',
      fields: [
        ['contact_name', 'Người liên hệ'],
        ['contact_email', 'Email liên hệ'],
        ['contact_phone', 'SĐT liên hệ'],
      ],
    },
  ];

  function supplierReadOnlyValue(item, key) {
    if (!item) return SUPPLIER_EMPTY_TEXT;
    if (key === 'status') return statusText(item.status) || SUPPLIER_EMPTY_TEXT;
    if (key === 'created_by') return userDisplayValue(item.created_by, item.created_by_display_name) || SUPPLIER_EMPTY_TEXT;
    if (key === 'updated_by') return userDisplayValue(item.updated_by, item.updated_by_display_name) || SUPPLIER_EMPTY_TEXT;
    const value = item[key];
    return value == null || value === '' ? SUPPLIER_EMPTY_TEXT : String(value);
  }

  function appendSupplierDetailField(grid, label, value) {
    const field = el('div', { className: 'supplier-detail-field' });
    field.appendChild(el('div', { className: 'supplier-detail-label', text: label }));
    field.appendChild(el('div', { className: 'supplier-detail-value', text: value || SUPPLIER_EMPTY_TEXT }));
    grid.appendChild(field);
  }

  function renderSupplierDetail(item) {
    const body = $('supplier-detail-body');
    if (!body) return;
    body.textContent = '';
    SUPPLIER_DETAIL_SECTIONS.forEach((section) => {
      const sectionEl = el('section', { className: 'detail-section supplier-detail-section' });
      sectionEl.appendChild(el('h4', { className: 'detail-section-title', text: section.title }));
      const grid = el('div', { className: 'supplier-detail-grid' });
      section.fields.forEach(([key, label]) => appendSupplierDetailField(grid, label, supplierReadOnlyValue(item, key)));
      sectionEl.appendChild(grid);
      body.appendChild(sectionEl);
    });
  }

  function supplierLookupKey(rowOrKey) {
    if (rowOrKey && typeof rowOrKey === 'object') return rowOrKey.supplier_code || rowOrKey.id || '';
    return rowOrKey || '';
  }

  async function openSupplierDetail(rowOrKey) {
    const key = supplierLookupKey(rowOrKey);
    if (!key) return;
    const r = await api('/suppliers/' + encodeURIComponent(key));
    if (!r.ok) {
      showToast(UI_TEXT.suppliers.detailLoadFailed, 'err');
      return;
    }
    renderSupplierDetail(r.data.item);
    if ($('supplier-detail-title')) $('supplier-detail-title').textContent = 'Chi tiết NCC';
    $('supplier-detail-modal').classList.remove('hidden');
  }

  function supplierHistoryValue(value) {
    return value == null || value === '' ? SUPPLIER_EMPTY_TEXT : String(value);
  }

  function renderSupplierHistoryRows(rows) {
    const tbody = $('supplier-history-tbody');
    if (!tbody) return;
    tbody.textContent = '';
    if (!rows || !rows.length) {
      const tr = el('tr');
      tr.appendChild(el('td', { className: 'muted', attrs: { colspan: '6' }, text: 'Chưa có lịch sử thay đổi' }));
      tbody.appendChild(tr);
      return;
    }
    rows.forEach((history) => {
      const tr = el('tr');
      tr.appendChild(el('td', { className: 'mono muted', text: supplierHistoryValue(history.created_at) }));
      tr.appendChild(el('td', { text: userDisplay(history, 'actor_user_id') || SUPPLIER_EMPTY_TEXT }));
      tr.appendChild(el('td', { className: 'mono', text: supplierHistoryValue(history.action) }));
      tr.appendChild(el('td', { text: supplierHistoryValue(history.comment || history.field_name) }));
      tr.appendChild(el('td', { text: supplierHistoryValue(history.previous_value) }));
      tr.appendChild(el('td', { text: supplierHistoryValue(history.new_value) }));
      tbody.appendChild(tr);
    });
  }

  async function openSupplierHistory(rowOrKey) {
    const key = supplierLookupKey(rowOrKey);
    if (!key) return;
    const r = await api('/suppliers/' + encodeURIComponent(key) + '/history');
    if (!r.ok) {
      showToast('Không tải được lịch sử NCC.', 'err');
      return;
    }
    renderSupplierHistoryRows(r.data.items || []);
    if ($('supplier-history-title')) $('supplier-history-title').textContent = 'Lịch sử NCC';
    $('supplier-history-modal').classList.remove('hidden');
  }

  function renderSuppliers() {
    const tbody = $('supplier-tbody');
    if (!tbody) return;
    const mobileList = $('supplier-mobile-list');
    tbody.textContent = '';
    if (mobileList) mobileList.textContent = '';
    const totalPages = Math.max(1, Math.ceil((state.supplierTotal || 0) / SUPPLIER_PAGE_SIZE));
    const showSupplierActions = isInternalUser();
    if (state.supplierLoading || state.supplierError) {
      const message = state.supplierLoading ? UI_TEXT.suppliers.loading : state.supplierError;
      const tr = el('tr');
      tr.appendChild(el('td', { className: 'muted', attrs: { colspan: showSupplierActions ? '10' : '9' }, text: message }));
      tbody.appendChild(tr);
      if (mobileList) appendSupplierMobileState(mobileList, message);
    } else if (state.suppliers.length === 0) {
      const filterText = filterSummary([
        state.supplierSearch && '"' + state.supplierSearch + '"',
        state.supplierFilters && statusText(state.supplierFilters.status),
      ]);
      const message = filterText
        ? 'Không có kết quả cho ' + filterText + '. Xóa bộ lọc để xem lại toàn bộ danh mục NCC.'
        : UI_TEXT.suppliers.emptyFiltered;
      const tr = el('tr');
      tr.appendChild(el('td', { className: 'muted', attrs: { colspan: showSupplierActions ? '10' : '9' }, text: message }));
      tbody.appendChild(tr);
      if (mobileList) appendSupplierMobileState(mobileList, message);
    } else {
      const start = (state.supplierPage - 1) * SUPPLIER_PAGE_SIZE;
      state.suppliers.forEach((row, i) => {
        const indexLabel = String(start + i + 1).padStart(2, '0');
        const tr = el('tr');
        tr.appendChild(el('td', { className: 'muted mono', text: indexLabel }));
        tr.appendChild(el('td', { className: 'mono label', attrs: { title: row.supplier_code || '' }, text: row.supplier_code || '' }));
        tr.appendChild(el('td', { className: 'label', attrs: { title: row.supplier_name || '' }, text: row.supplier_name || '' }));
        tr.appendChild(el('td', { className: 'mono', text: row.tax_code || '—' }));
        tr.appendChild(el('td', { attrs: { title: row.address || '' }, text: row.address || '—' }));
        tr.appendChild(el('td', { text: row.region || '—' }));
        tr.appendChild(el('td', { attrs: { title: row.province || '' }, text: row.province || '—' }));
        tr.appendChild(el('td', { attrs: { title: row.business_type || '' }, text: row.business_type || '—' }));
        const statusTd = el('td'); statusTd.appendChild(supplierStatusTag(row.status)); tr.appendChild(statusTd);
        if (showSupplierActions) {
          const actionTd = el('td', { className: 'table-action-cell supplier-action-cell' });
          actionTd.appendChild(renderSupplierActions(row));
          tr.appendChild(actionTd);
        }
        tbody.appendChild(tr);
        if (mobileList) appendSupplierMobileCard(mobileList, row, indexLabel);
      });
    }
    $('supplier-page-meta').textContent = state.supplierTotal === 0 ? '0 NCC' : `${Math.min((state.supplierPage - 1) * SUPPLIER_PAGE_SIZE + 1, state.supplierTotal)}-${Math.min(state.supplierPage * SUPPLIER_PAGE_SIZE, state.supplierTotal)} / ${state.supplierTotal} NCC`;
    $('supplier-page-label').textContent = `${state.supplierPage} / ${totalPages}`;
    $('supplier-prev-page').disabled = state.supplierPage <= 1 || state.supplierLoading;
    $('supplier-next-page').disabled = state.supplierPage >= totalPages || state.supplierLoading;
    $('supplier-prev-page').textContent = isMobileViewport() ? 'Trang trước' : 'Trang trước';
    $('supplier-next-page').textContent = isMobileViewport() ? 'Tải thêm NCC' : 'Trang sau';
    const adminEls = document.querySelectorAll('[data-admin-only]');
    Array.from(adminEls).forEach((node) => node.classList.toggle('hidden', !canManageSystem()));
    const supplierManagerEls = document.querySelectorAll('[data-supplier-manager-only]');
    Array.from(supplierManagerEls).forEach((node) => node.classList.toggle('hidden', !canManageSuppliers()));
    const actionHead = $('supplier-action-head');
    if (actionHead) actionHead.classList.toggle('hidden', !showSupplierActions);
    requestTableLabelHydration();
  }

  // ============ DOM helpers ============
  function renderOptions(sel, placeholder, values) {
    if (!sel) return;
    const selected = sel.value;
    sel.textContent = '';
    sel.appendChild(el('option', { attrs: { value: '' }, text: placeholder }));
    values.forEach((value) => sel.appendChild(el('option', { attrs: { value }, text: value })));
    if (selected && values.includes(selected)) sel.value = selected;
  }
  function isValidRegionValue(value) {
    const text = String(value || '').trim();
    return !text || REGION_OPTIONS.includes(text);
  }
  function isValidBusinessTypeValue(value) {
    const text = String(value || '').trim();
    return !text || BUSINESS_TYPE_OPTIONS.includes(text);
  }
  function isValidProvinceValue(region, province) {
    const provinceText = String(province || '').trim();
    if (!provinceText) return true;
    return (PROVINCES_BY_REGION[String(region || '').trim()] || []).includes(provinceText);
  }
  function refreshProvinceOptions(prefix, reset) {
    const region = $(prefix + '-region');
    const province = $(prefix + '-province');
    if (!province) return;
    const selected = reset ? '' : province.value;
    const values = PROVINCES_BY_REGION[region ? region.value : ''] || [];
    province.textContent = '';
    province.appendChild(el('option', { attrs: { value: '' }, text: values.length ? 'Chọn tỉnh/thành' : 'Chọn khu vực trước' }));
    values.forEach((value) => province.appendChild(el('option', { attrs: { value }, text: value })));
    province.disabled = values.length === 0;
    province.value = selected && values.includes(selected) ? selected : '';
  }
  function setMasterDataControlValues(prefix, regionValue, provinceValue, businessTypeValue) {
    const region = $(prefix + '-region');
    const businessType = $(prefix + '-business-type');
    const cleanRegion = String(regionValue || '').trim();
    const cleanBusinessType = String(businessTypeValue || '').trim();
    if (region) region.value = REGION_OPTIONS.includes(cleanRegion) ? cleanRegion : '';
    refreshProvinceOptions(prefix);
    const province = $(prefix + '-province');
    const cleanProvince = String(provinceValue || '').trim();
    if (province) province.value = isValidProvinceValue(region ? region.value : '', cleanProvince) ? cleanProvince : '';
    if (businessType) businessType.value = BUSINESS_TYPE_OPTIONS.includes(cleanBusinessType) ? cleanBusinessType : '';
  }
  function initMasterDataSelects() {
    renderOptions($('new-region'), 'Chọn khu vực', REGION_OPTIONS);
    renderOptions($('supplier-region'), 'Chọn khu vực', REGION_OPTIONS);
    renderOptions($('new-business-type'), 'Chọn loại hình kinh doanh', BUSINESS_TYPE_OPTIONS);
    renderOptions($('supplier-business-type'), 'Chọn loại hình kinh doanh', BUSINESS_TYPE_OPTIONS);
    refreshProvinceOptions('new');
    refreshProvinceOptions('supplier');
  }
  function resetNewSupplierSelect() {
    const input = $('new-supplier-select');
    const options = $('new-supplier-options');
    if (input) input.value = '';
    if (options) options.textContent = '';
    state.supplierLookupItems = [];
  }
  function renderMch2Options(sel, placeholder) {
    renderOptions(sel, placeholder || 'MCH2', MCH2_VALUES);
  }
  function renderMch3Options(mch2Sel, mch3Sel, placeholder, opts) {
    if (!mch3Sel) return;
    const selected = opts && opts.reset ? '' : mch3Sel.value;
    const values = LEGACY_EVALUATION_MCH_CATEGORIES[mch2Sel ? mch2Sel.value : ''] || [];
    mch3Sel.textContent = '';
    mch3Sel.disabled = values.length === 0;
    mch3Sel.appendChild(el('option', { attrs: { value: '' }, text: values.length ? placeholder : 'Chọn MCH2 trước' }));
    values.forEach((value) => mch3Sel.appendChild(el('option', { attrs: { value }, text: value })));
    if (selected && values.includes(selected)) mch3Sel.value = selected;
  }
  function isValidMchPair(mch2, mch3) {
    return !!mch2 && !!mch3 && (LEGACY_EVALUATION_MCH_CATEGORIES[mch2] || []).includes(mch3);
  }
  function legalFileInput(name) {
    const input = $('new-' + name.replaceAll('_', '-'));
    return input && input.files && input.files[0] ? input.files[0] : null;
  }
  function isAllowedLegalFile(file) {
    if (!file) return true;
    const ext = String(file.name || '').split('.').pop().toLowerCase();
    return LEGAL_FILE_EXTENSIONS.includes(ext);
  }
  function updateLegalFileLabel(name, existingName) {
    const file = legalFileInput(name);
    const label = $('new-' + name.replaceAll('_', '-') + '-name');
    if (!label) return;
    label.textContent = file ? file.name : existingName ? 'Hien co: ' + existingName : '';
  }
  function evaluationRequestBody(form, payload) {
    const files = {
      business_license_file: legalFileInput('business_license_file'),
      attp_certificate_file: legalFileInput('attp_certificate_file'),
    };
    if (!files.business_license_file && !files.attp_certificate_file) return payload;
    const fd = new FormData();
    Object.entries(payload).forEach(([key, value]) => {
      if (value !== undefined && value !== null) fd.append(key, value);
    });
    if (files.business_license_file) fd.append('business_license_file', files.business_license_file);
    if (files.attp_certificate_file) fd.append('attp_certificate_file', files.attp_certificate_file);
    return fd;
  }
  function initMerchandisingSelects() {
    renderMch2Options($('eval-mch2-filter'), 'MCH2');
    renderMch2Options($('new-mch2'), 'Chọn MCH2');
    refreshEvalMch3Filter();
    refreshMch3Options();
  }
  function setMsg(id, text, kind) {
    const e = $(id);
    if (!e) return;
    e.textContent = text || '';
    e.className = 'auth-msg ' + (kind === 'err' ? 'err' : kind === 'ok' ? 'ok' : '');
    if (text && kind === 'ok') showToast(text, 'ok');
  }

  function showToast(message, kind) {
    const root = $('toast-root');
    if (!root || !message) return;
    const toast = el('div', { className: 'toast ' + (kind === 'err' ? 'err' : 'ok'), text: message });
    root.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  window.addEventListener('qlcl:session-stale', () => {
    showToast('Phiên đăng nhập đã thay đổi hoặc hết hạn. Vui lòng đăng nhập lại.', 'err');
    Object.assign(state, { view: 'login', email: null, roleCodes: [], capabilities: [] });
    setView('login');
  });
  window.addEventListener('qlcl:action-forbidden', () => {
    showToast('Bạn không còn quyền thực hiện thao tác này. Dữ liệu đã được giữ nguyên.', 'err');
  });

  function setButtonLoading(button, label) {
    if (!button) return () => {};
    const original = button.textContent;
    const originalMinWidth = button.style.minWidth;
    const measuredWidth = Math.ceil(button.getBoundingClientRect().width);
    button.dataset.originalLabel = original;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    if (measuredWidth) button.style.minWidth = `${measuredWidth}px`;
    button.classList.add('is-loading');
    if (label) button.textContent = label;
    return (finalLabel) => {
      button.classList.remove('is-loading');
      button.removeAttribute('aria-busy');
      button.style.minWidth = originalMinWidth;
      if (finalLabel) {
        button.textContent = finalLabel;
        setTimeout(() => {
          button.textContent = button.dataset.originalLabel || original;
          button.disabled = false;
          delete button.dataset.originalLabel;
        }, 1200);
      } else {
        button.textContent = button.dataset.originalLabel || original;
        button.disabled = false;
        delete button.dataset.originalLabel;
      }
    };
  }

  function actionContext(resource, extra = {}) {
    return {
      capabilities: state.capabilities || [],
      resource: resource || null,
      status: resource?.status || resource?.current_status || '',
      ...extra,
    };
  }

  function actionReasonText(reason) {
    const labels = {
      forbidden_permission: 'Bạn không có quyền thực hiện thao tác này.',
      forbidden_scope: 'Dữ liệu nằm ngoài phạm vi được cấp quyền.',
      invalid_status: 'Trạng thái hiện tại chưa cho phép thao tác này.',
      action_unavailable: 'Thao tác chưa khả dụng với dữ liệu hiện tại.',
      question_version_publish_disabled: 'Publish đang bị tắt bởi feature gate của hệ thống.',
      question_version_not_draft: 'Chỉ phiên bản Draft mới cho phép thao tác này.',
      scoring_policy_version_not_draft: 'Chỉ phiên bản Draft mới cho phép lưu hoặc gửi duyệt.',
      scoring_policy_version_not_in_review: 'Chỉ phiên bản đang Review mới có thể Publish.',
      scoring_policy_rollback_target_invalid: 'Chỉ phiên bản Published hoặc Retired mới có thể Rollback.',
      scoring_policy_publish_disabled: 'Publish chính sách tính điểm đang bị tắt bởi feature gate của hệ thống.',
      scoring_policy_checks_required: 'Cần lưu Draft và hoàn tất Kiểm tra, Mô phỏng, Tác động trước khi gửi duyệt.',
      precondition_scoring_locked: 'Cần hoàn tất chấm điểm trước.',
      precondition_no_pending_approval: 'Phiếu đang có yêu cầu phê duyệt chờ xử lý.',
      first_item: 'Dòng này đã ở vị trí đầu tiên.',
    };
    return labels[reason] || String(reason || 'Thao tác chưa khả dụng.').replaceAll('_', ' ');
  }

  let disabledReasonSequence = 0;
  function setDisabledReason(control, reason) {
    if (!control) return;
    const previousId = control.dataset.disabledReasonId || '';
    const message = reason ? actionReasonText(reason) : '';
    if (message) {
      control.title = message;
      control.dataset.disabledReason = message;
    } else {
      control.removeAttribute('title');
      delete control.dataset.disabledReason;
    }

    const bar = control.closest('.admin-sticky-action-bar');
    const hint = bar?.querySelector('.admin-disabled-reason');
    if (!hint) return;
    if (!hint.id) hint.id = `admin-disabled-reason-${++disabledReasonSequence}`;
    const describedBy = new Set((control.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
    if (previousId) describedBy.delete(previousId);
    if (message) {
      describedBy.add(hint.id);
      control.dataset.disabledReasonId = hint.id;
    } else {
      delete control.dataset.disabledReasonId;
    }
    if (describedBy.size) control.setAttribute('aria-describedby', [...describedBy].join(' '));
    else control.removeAttribute('aria-describedby');

    const reasons = [...bar.querySelectorAll(':disabled[data-disabled-reason]')]
      .map((node) => node.dataset.disabledReason)
      .filter((value, index, values) => value && values.indexOf(value) === index);
    hint.textContent = reasons.join(' · ');
  }

  async function executeAction(actionId, options = {}) {
    const catalog = ACTIONS.getAction(actionId);
    if (!catalog) throw new Error(`action_not_catalogued:${actionId}`);
    const trigger = options.trigger || document.activeElement;
    if (trigger?.getAttribute('aria-busy') === 'true') return { ok: false, ignored: 'in_flight' };
    const availability = ACTIONS.resolveActionState(actionId, options.context || actionContext(options.resource));
    if (availability.state !== 'enabled') {
      const message = actionReasonText(availability.reason);
      if (availability.state === 'disabled') {
        if (trigger) trigger.title = message;
        showToast(message, 'err');
      }
      return { ok: false, ignored: availability.reason };
    }
    if (catalog.confirm.required && options.confirm !== false) {
      const objectIdentity = options.objectIdentity || catalog.entity;
      const accepted = await confirmAction({
        title: catalog.label,
        message: `${objectIdentity}: ${catalog.confirm.consequence}`,
        confirmLabel: catalog.short_label,
        destructive: catalog.variant === 'danger',
      });
      if (!accepted) {
        trigger?.focus();
        return { ok: false, cancelled: true };
      }
    }
    const stopLoading = trigger ? setButtonLoading(trigger, options.loadingLabel || '') : () => {};
    try {
      const result = await withActionRequestContext({ actionId, mutation: catalog.mutation }, async () => options.run?.());
      if (result && result.ok === false) {
        const requestId = result.requestId || result.data?.request_id;
        const suffix = requestId ? ` (request_id: ${requestId})` : '';
        showToast(`${apiErrorMessage(result.data?.error || result.data?.error_code)}${suffix}`, 'err');
        return result;
      }
      if (catalog.success.message && options.announceSuccess !== false) showToast(catalog.success.message, 'ok');
      return result === undefined ? { ok: true } : result;
    } catch (error) {
      const requestId = error?.request_id || error?.requestId;
      const suffix = requestId ? ` (request_id: ${requestId})` : '';
      showToast(`${error?.message || 'Không thể hoàn tất thao tác.'}${suffix}`, 'err');
      return { ok: false, error };
    } finally {
      stopLoading();
      if (options.returnFocus !== false && trigger?.isConnected) trigger.focus();
    }
  }

  function confirmAction(options) {
    return new Promise((resolve) => {
      const modal = $('confirm-modal');
      const title = $('confirm-title');
      const message = $('confirm-message');
      const cancel = $('confirm-cancel');
      const accept = $('confirm-accept');
      const reasonField = $('confirm-reason-field');
      const reason = $('confirm-reason');
      const reasonError = $('confirm-reason-error');
      const reasonRequired = options.reasonRequired === true;
      if (!modal || !title || !message || !cancel || !accept || (reasonRequired && (!reasonField || !reason || !reasonError))) {
        resolve(false);
        return;
      }
      title.textContent = options.title || 'Xác nhận thao tác';
      message.textContent = options.message || '';
      cancel.textContent = options.cancelLabel || 'Giữ nguyên';
      accept.textContent = options.confirmLabel || 'Xác nhận';
      accept.className = options.destructive ? 'btn-primary btn-danger' : 'btn-primary';
      if (reasonField && reason && reasonError) {
        reasonField.classList.toggle('hidden', !reasonRequired);
        reason.value = '';
        reason.placeholder = options.reasonPlaceholder || 'Nêu lý do cụ thể (8–500 ký tự)';
        reason.required = reasonRequired;
        reason.removeAttribute('aria-invalid');
        reasonError.textContent = '';
      }
      modal.classList.remove('hidden');
      if (reasonRequired) reason.focus();
      else accept.focus();
      const finish = (value) => {
        modal.classList.add('hidden');
        if (reasonField) reasonField.classList.add('hidden');
        accept.removeEventListener('click', onAccept);
        cancel.removeEventListener('click', onCancel);
        modal.removeEventListener('click', onBackdrop);
        document.removeEventListener('keydown', onKeydown);
        reason?.removeEventListener('input', onReasonInput);
        resolve(value);
      };
      const onReasonInput = () => {
        reason.removeAttribute('aria-invalid');
        reasonError.textContent = '';
      };
      const onAccept = () => {
        if (!reasonRequired) return finish(true);
        const value = reason.value.trim();
        if (value.length < 8 || value.length > 500) {
          reason.setAttribute('aria-invalid', 'true');
          reasonError.textContent = 'Lý do phải có từ 8 đến 500 ký tự.';
          reason.focus();
          return;
        }
        finish(value);
      };
      const onCancel = () => finish(false);
      const onBackdrop = (event) => { if (event.target === modal) finish(false); };
      const onKeydown = (event) => { if (event.key === 'Escape') finish(false); };
      accept.addEventListener('click', onAccept);
      cancel.addEventListener('click', onCancel);
      modal.addEventListener('click', onBackdrop);
      document.addEventListener('keydown', onKeydown);
      reason?.addEventListener('input', onReasonInput);
    });
  }

  function visibleNavigationItems() {
    return NAVIGATION.visibleNavigation(state.capabilities, FEATURE_FLAGS);
  }

  function sidebarNavigationItems() {
    return NAVIGATION.sidebarNavigation(state.capabilities, FEATURE_FLAGS);
  }

  function navigationItem(id) {
    return NAVIGATION_BY_ID.get(id) || null;
  }

  function adminRouteConfig(id) {
    const item = navigationItem(id);
    return item?.admin_module ? { module: item.admin_module, pane: item.admin_pane } : null;
  }

  function navigationItemAllowed(id) {
    return NAVIGATION.canAccessItem(navigationItem(id), state.capabilities, FEATURE_FLAGS);
  }

  function routePathFromHash() {
    const route = (window.location.hash || '').replace(/^#/, '') || '/dashboard';
    if (route.split('?')[0] !== '/dashboard/ncc-evaluations') return route;
    const legacyParams = new URLSearchParams(route.includes('?') ? route.slice(route.indexOf('?') + 1) : '');
    const params = new URLSearchParams();
    if (/^\d{4}-\d{2}$/.test(legacyParams.get('month') || '')) {
      params.set('periodType', 'MONTH');
      params.set('periodValue', legacyParams.get('month'));
    }
    const canonical = `/dashboard${params.size ? `?${params.toString()}` : ''}`;
    window.history.replaceState(null, '', `#${canonical}`);
    return canonical;
  }

  function scoringTicketFromRoute() {
    const route = routePathFromHash();
    const queryIndex = route.indexOf('?');
    if (queryIndex < 0) return '';
    const params = new URLSearchParams(route.slice(queryIndex + 1));
    return String(params.get('ticket') || '').trim();
  }

  function recordRouteParams() {
    const route = routePathFromHash();
    const queryIndex = route.indexOf('?');
    return queryIndex < 0 ? new URLSearchParams() : new URLSearchParams(route.slice(queryIndex + 1));
  }

  async function openRecordDeepLink() {
    const params = recordRouteParams();
    let code = String(params.get('ticket') || params.get('code') || '').trim();
    const taskId = String(params.get('task') || '').trim();
    if (!code && !taskId) return;
    const key = `${state.tab}:${code}:${taskId}:${params.get('reason') || ''}`;
    if (state.notificationDeepLinkKey === key) return;
    state.notificationDeepLinkKey = key;
    if (state.tab === 'approvals') {
      if (taskId) {
        const evaluation = demoEvaluations.find((row) => String(row.pendingApproval?.id || '') === taskId);
        code = evaluation?.code || code;
      }
      state.approvalSearch = code;
      if ($('approval-search')) $('approval-search').value = code;
      renderApprovals();
      return;
    }
    if (state.tab === 'evaluations') await openTicketDetail(code);
  }

  function resolveAuthorizedRoute(route = routePathFromHash()) {
    return NAVIGATION.resolveRoute(route, state.capabilities, FEATURE_FLAGS);
  }

  function syncHashForTab(tab) {
    let route = ROUTE_BY_ID[tab] || ROUTE_BY_ID.overview;
    if (tab === 'scoring' && state.scoringTicket) {
      route += '?ticket=' + encodeURIComponent(state.scoringTicket);
    }
    if (GLOBAL_PERIOD_TABS.includes(tab) && REPORTING_PERIOD.isValidPeriod(state.month)) {
      route = REPORTING_PERIOD.routeWithPeriod(route, state.month);
    }
    if (route && window.location.hash !== '#' + route) window.location.hash = route;
  }

  function navigationItemActive(item) {
    const current = navigationItem(state.tab);
    return Boolean(current && (
      current.id === item.id ||
      current.breadcrumbs.includes(item.id) ||
      current.sidebar_active === item.id
    ));
  }

  function navigationIcon(item) {
    const marks = {
      workspace: '⌂', approval: '✓', evaluation: '☑', supplier: '◇',
      analytics: '⌁', report: '▥', warehouse: '▣', lab: '⌬', incident: '!', settings: '⚙',
      users: '◎', questions: '?', template: '▧', upload: '↑', threshold: '≋', audit: '◴',
    };
    return marks[item.icon] || '•';
  }

  function routeButton(item, options = {}) {
    const attrs = {
      type: 'button',
      'data-action-id': 'navigation.open',
      'data-navigation-id': 'nav-' + item.id,
      'data-route-tab': item.id,
      'aria-label': item.label,
      title: item.description,
    };
    if (options.desktop) {
      attrs.id = 'nav-' + item.id;
      attrs['data-tab'] = item.id;
      attrs['data-label'] = item.label;
    }
    const button = el('button', { className: options.className || 'btn-ghost', attrs });
    if (options.desktop) {
      button.appendChild(el('span', { className: 'icon', text: navigationIcon(item), attrs: { 'aria-hidden': 'true' } }));
      button.appendChild(el('span', { className: 'label', text: item.label }));
    } else {
      button.textContent = options.short ? item.short_label : item.label;
    }
    button.classList.toggle('active', navigationItemActive(item));
    return button;
  }

  function renderDesktopNavigation(items) {
    const host = $('desktop-navigation');
    if (!host) return;
    host.textContent = '';
    items.filter((item) => item.kind === 'section' && !item.parent).forEach((section) => {
      const children = items.filter((item) => item.kind === 'route' && item.parent === section.id);
      if (!children.length) return;
      host.appendChild(el('div', { className: 'sb-section', text: section.label }));
      children.forEach((item) => {
        host.appendChild(routeButton(item, { desktop: true, className: 'nav-item' }));
        if (item.id === 'admin') renderDesktopAdminNavigation(host);
      });
    });
  }

  function renderDesktopAdminNavigation(host) {
    const adminItem = navigationItem('admin');
    if (!adminItem || !navigationItemActive(adminItem)) return;
    const adminGroups = NAVIGATION.groupedNavigationFor('admin', state.capabilities, FEATURE_FLAGS);
    if (!adminGroups.length) return;
    const moduleHost = el('nav', {
      className: 'admin-grouped-subnav desktop-admin-tree',
      attrs: {
        id: 'admin-module-nav',
        'data-navigation-surface': 'admin',
        'aria-label': 'Module quản trị',
      },
    });
    adminGroups.forEach(({ group, items: groupItems }, index) => {
      const expanded = navigationGroupExpanded(group, index, true);
      const navGroup = el('section', { className: 'admin-navigation-group' });
      const navControlId = `desktop-admin-navigation-group-${group.id}`;
      navGroup.appendChild(navigationGroupToggle(group, navControlId, expanded));
      const navItems = navigationGroupPanel(group, navControlId, expanded, 'admin-navigation-items');
      groupItems.forEach((item) => {
        const button = routeButton(item, { className: 'desktop-admin-route' });
        button.dataset.adminRoute = item.id;
        navItems.appendChild(button);
      });
      navGroup.appendChild(navItems);
      moduleHost.appendChild(navGroup);
    });
    host.appendChild(moduleHost);
  }

  function renderMobileNavigation(items) {
    const primaryHost = $('mobile-primary-navigation');
    const moreHost = $('mobile-more-navigation');
    if (!primaryHost || !moreHost) return;
    const primary = NAVIGATION.mobilePrimary(state.capabilities, FEATURE_FLAGS);
    const primaryIds = new Set(primary.map((item) => item.id));
    const topLevelRoutes = items.filter((item) => {
      const parent = navigationItem(item.parent);
      return item.kind === 'route' && parent?.kind === 'section';
    });
    const moreItems = topLevelRoutes.filter((item) => !primaryIds.has(item.id));
    primaryHost.textContent = '';
    primary.forEach((item) => primaryHost.appendChild(routeButton(item, { short: true })));
    if (moreItems.length) {
      primaryHost.appendChild(el('button', { text: 'Thêm', attrs: {
        type: 'button', id: 'mobile-more-trigger', 'data-mobile-more': '',
        'data-action-id': 'navigation.more',
        'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': 'mobile-more-sheet',
      } }));
    }
    moreHost.textContent = '';
    moreItems.forEach((item) => moreHost.appendChild(routeButton(item, { short: false })));
    const adminGroups = NAVIGATION.groupedNavigationFor('admin', state.capabilities, FEATURE_FLAGS);
    if (adminGroups.length && moreItems.some((item) => item.id === 'admin')) {
      const tree = el('section', { className: 'mobile-admin-tree', attrs: { 'aria-label': navigationItem('admin')?.label || 'Quản trị' } });
      tree.appendChild(el('h4', { text: navigationItem('admin')?.label || 'Quản trị' }));
      adminGroups.forEach(({ group, items: groupItems }, index) => {
        const controlId = `mobile-navigation-group-${group.id}`;
        const expanded = navigationGroupExpanded(group, index, true);
        const toggle = navigationGroupToggle(group, controlId, expanded);
        const panel = navigationGroupPanel(group, controlId, expanded, 'mobile-navigation-group-items');
        groupItems.forEach((item) => panel.appendChild(routeButton(item, { short: false })));
        tree.appendChild(toggle);
        tree.appendChild(panel);
      });
      moreHost.appendChild(tree);
    }
  }

  function navigationGroupExpanded(group, index, compact) {
    if (mobileNavigationGroupState.has(group.id)) return mobileNavigationGroupState.get(group.id);
    const current = navigationItem(state.tab);
    if (current?.breadcrumbs.includes(group.id)) return true;
    return !compact || (state.tab === 'admin' && index === 0);
  }

  function navigationGroupToggle(group, controlId, expanded) {
    const button = el('button', {
      className: 'navigation-group-toggle',
      attrs: {
        type: 'button',
        'data-action-id': 'navigation.group_toggle',
        'data-navigation-group-toggle': group.id,
        'aria-expanded': expanded ? 'true' : 'false',
        'aria-controls': controlId,
      },
    });
    button.appendChild(el('span', { text: group.label }));
    button.appendChild(el('span', {
      className: 'navigation-group-state',
      text: expanded ? 'Thu gọn' : 'Mở rộng',
      attrs: { 'aria-hidden': 'true' },
    }));
    return button;
  }

  function navigationGroupPanel(group, controlId, expanded, className) {
    return el('div', {
      className: `${className}${expanded ? '' : ' hidden'}`,
      attrs: { id: controlId, 'data-navigation-group-panel': group.id },
    });
  }

  function renderAdminNavigation() {
    const cardsHost = $('admin-dashboard');
    if (!cardsHost) return;
    const adminGroups = NAVIGATION.groupedNavigationFor('admin', state.capabilities, FEATURE_FLAGS);
    const compact = window.innerWidth < MOBILE_BREAKPOINT;
    cardsHost.textContent = '';
    adminGroups.forEach(({ group, items: groupItems }, index) => {
      const expanded = navigationGroupExpanded(group, index, compact);
      const dashboardGroup = el('section', { className: 'admin-dashboard-group' });
      const dashboardControlId = `admin-dashboard-group-${group.id}`;
      dashboardGroup.appendChild(navigationGroupToggle(group, dashboardControlId, expanded));
      const cardGrid = navigationGroupPanel(group, dashboardControlId, expanded, 'admin-card-grid');
      groupItems.forEach((item) => {
        const card = routeButton(item, { className: 'admin-card' });
        card.dataset.adminRoute = item.id;
        card.textContent = '';
        card.appendChild(el('h3', { text: item.label }));
        card.appendChild(el('p', { text: item.description }));
        card.appendChild(el('span', { className: 'go', text: 'Mở ' + item.short_label.toLowerCase() }));
        cardGrid.appendChild(card);
      });
      dashboardGroup.appendChild(cardGrid);
      cardsHost.appendChild(dashboardGroup);
    });
  }

  function renderModuleNavigation() {
    const host = $('module-navigation');
    if (!host) return;
    host.textContent = '';
    const current = navigationItem(state.tab);
    const trail = current ? [...current.breadcrumbs, current.id].map(navigationItem).filter(Boolean) : [];
    const section = trail.find((item) => item.kind === 'section');
    if (!section || section.id === 'administration') {
      host.classList.add('hidden');
      return;
    }
    const siblings = NAVIGATION.moduleNavigationFor(state.tab, state.capabilities, FEATURE_FLAGS);
    if (siblings.length < 2) {
      host.classList.add('hidden');
      return;
    }
    siblings.forEach((item) => host.appendChild(routeButton(item, { className: 'btn-ghost', short: false })));
    host.classList.remove('hidden');
  }

  function applyContextualNavigationVisibility() {
    Array.from(document.querySelectorAll('[data-route-tab]')).forEach((node) => {
      if (node.closest('[data-navigation-surface]')) return;
      node.classList.toggle('hidden', !navigationItemAllowed(node.dataset.routeTab));
    });
    Array.from(document.querySelectorAll('[data-contextual-navigation]')).forEach((node) => {
      node.classList.toggle('hidden', !navigationItemAllowed(node.dataset.contextualNavigation));
    });
  }

  function renderNavigationSurfaces() {
    const items = visibleNavigationItems();
    const sidebarItems = sidebarNavigationItems();
    renderDesktopNavigation(sidebarItems);
    renderMobileNavigation(sidebarItems);
    renderAdminNavigation();
    renderModuleNavigation();
    applyContextualNavigationVisibility();
    syncActiveNav();
  }

  function syncActiveNav() {
    Array.from(document.querySelectorAll('[data-navigation-surface] [data-route-tab]')).forEach((button) => {
      const item = navigationItem(button.dataset.routeTab);
      button.classList.toggle('active', Boolean(item && navigationItemActive(item)));
      if (button.matches('[role="tab"]')) button.setAttribute('aria-selected', navigationItemActive(item) ? 'true' : 'false');
    });
    const more = $('mobile-more-trigger');
    if (more) {
      const primaryIds = new Set(NAVIGATION.mobilePrimary(state.capabilities, FEATURE_FLAGS).map((item) => item.id));
      const current = navigationItem(state.tab);
      const inPrimary = current && (primaryIds.has(current.id) || current.breadcrumbs.some((id) => primaryIds.has(id)));
      const sheet = $('mobile-more-sheet');
      more.classList.toggle('active', Boolean(current && !inPrimary));
      more.setAttribute('aria-expanded', sheet && !sheet.classList.contains('hidden') ? 'true' : 'false');
    }
  }

  function renderBreadcrumbs() {
    const host = $('breadcrumb-items');
    if (!host) return;
    host.textContent = '';
    const crumbs = NAVIGATION.breadcrumbsFor(state.tab);
    crumbs.forEach((crumb, index) => {
      if (index) host.appendChild(el('span', { className: 'sep', text: '/' }));
      const item = navigationItem(crumb.id);
      if (index < crumbs.length - 1 && item?.route && navigationItemAllowed(item.id)) {
        host.appendChild(routeButton(item, { className: 'breadcrumb-link' }));
      } else {
        host.appendChild(el(index === crumbs.length - 1 ? 'b' : 'span', { text: crumb.label }));
      }
    });
  }

  function mobileBackTarget() {
    if (state.tab === 'overview') return '';
    const current = navigationItem(state.tab);
    if (!current) return navigationItemAllowed('overview') ? 'overview' : '';
    const parentRoute = [...current.breadcrumbs].reverse()
      .map(navigationItem)
      .find((item) => item?.route && navigationItemAllowed(item.id));
    return parentRoute?.id || (navigationItemAllowed('overview') ? 'overview' : '');
  }

  function shouldShowGlobalPeriod() {
    return GLOBAL_PERIOD_TABS.includes(state.tab);
  }

  function updateMobileChrome(v) {
    const title = $('mobile-current-title');
    const current = navigationItem(state.tab);
    if (title) title.textContent = current?.label || 'QLCL';
    const back = $('mobile-back');
    if (!back) return;
    const target = v === 'dashboard' ? mobileBackTarget() : '';
    back.classList.toggle('is-hidden', !target);
    back.disabled = !target;
    back.dataset.routeTab = target;
    back.setAttribute('aria-label', target ? 'Về ' + (navigationItem(target)?.label || 'màn hình trước') : 'Đang ở màn hình chính');
  }

  function closeMobileMore() {
    const sheet = $('mobile-more-sheet');
    if (sheet) sheet.classList.add('hidden');
    const trigger = $('mobile-more-trigger');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  }

  function openMobileMore() {
    const sheet = $('mobile-more-sheet');
    if (sheet) sheet.classList.remove('hidden');
    const trigger = $('mobile-more-trigger');
    if (trigger) trigger.setAttribute('aria-expanded', 'true');
  }

  function toggleNavigationGroup(button) {
    const groupId = String(button?.dataset.navigationGroupToggle || '');
    if (!groupId) return;
    const expanded = button.getAttribute('aria-expanded') !== 'true';
    mobileNavigationGroupState.set(groupId, expanded);
    document.querySelectorAll(`[data-navigation-group-toggle="${groupId}"]`).forEach((toggle) => {
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      const stateLabel = toggle.querySelector('.navigation-group-state');
      if (stateLabel) stateLabel.textContent = expanded ? 'Thu gọn' : 'Mở rộng';
    });
    document.querySelectorAll(`[data-navigation-group-panel="${groupId}"]`).forEach((panel) => {
      panel.classList.toggle('hidden', !expanded);
    });
  }

  function activateRouteResolution(resolution, options = {}) {
    const allowed = resolution?.status === 'allowed' && resolution.item;
    state.routeAccessStatus = allowed ? 'allowed' : (resolution?.status || 'not_found');
    if (resolution?.item) state.tab = resolution.item.id;
    if (allowed) {
      state.tab = resolution.item.id;
      if (resolution.redirected_from && resolution.canonical_route) {
        window.history.replaceState(null, '', '#' + resolution.canonical_route);
      }
      if (options.updateHash) syncHashForTab(state.tab);
    } else {
      const description = $('route-denied-description');
      if (description) {
        description.textContent = resolution?.status === 'feature_off'
          ? 'Chức năng này chưa được bật trong môi trường hiện tại.'
          : resolution?.status === 'not_found'
            ? 'Đường dẫn không tồn tại hoặc đã được thay đổi.'
            : 'Bạn không có quyền mở chức năng này.';
      }
    }
    renderNavigationSurfaces();
    setView('dashboard');
    return Boolean(allowed);
  }

  async function navigateToTab(t) {
    if (!TABS.includes(t)) return;
    const item = navigationItem(t);
    if (t !== state.tab && state.tab === 'admin-personnel-import') {
      const discardPersonnelImport = await confirmPersonnelImportRouteLeave(`#${item?.route || ''}`);
      if (!discardPersonnelImport) return;
    }
    if (t !== state.tab && item) {
      const discard = await confirmAuthzRouteLeave(`#${item.route}`);
      if (!discard) return;
    }
    if (t !== state.tab && !confirmBusinessConfigRouteLeave(item ? `#${item.route}` : '')) return;
    const resolution = item ? resolveAuthorizedRoute(item.route) : { status: 'not_found', item: null };
    closeMobileMore();
    closeMobileFilters();
    if (!activateRouteResolution(resolution, { updateHash: true })) return;
    loadTab();
  }

  function closeMobileFilters() {
    Array.from(document.querySelectorAll('.mobile-filter-open')).forEach((node) => node.classList.remove('mobile-filter-open'));
  }

  function initMobileFilters() {
    Array.from(document.querySelectorAll('.filter-grid')).forEach((grid, index) => {
      if (grid.dataset.mobileFilterReady) return;
      grid.dataset.mobileFilterReady = '1';
      grid.classList.add('mobile-filter-source');
    const trigger = el('button', { className: 'btn-ghost mobile-filter-trigger', text: 'Lọc dữ liệu', attrs: { type: 'button', 'data-action-id': 'filter.open' } });
      trigger.addEventListener('click', () => grid.classList.add('mobile-filter-open'));
      grid.parentNode.insertBefore(trigger, grid);
      const head = el('div', { className: 'mobile-filter-head' });
      head.appendChild(el('h3', { text: 'Bộ lọc' }));
    const close = el('button', { className: 'btn-ghost', text: 'Đóng', attrs: { type: 'button', 'data-action-id': 'filter.close' } });
      close.addEventListener('click', closeMobileFilters);
      head.appendChild(close);
      grid.insertBefore(head, grid.firstChild);
      Array.from(grid.querySelectorAll('button')).forEach((button) => {
        if (button === close) return;
        button.addEventListener('click', () => {
          if (isMobileViewport()) window.setTimeout(closeMobileFilters, 120);
        });
      });
      grid.id = grid.id || 'mobile-filter-panel-' + index;
      trigger.setAttribute('aria-controls', grid.id);
    });
  }

  function enhanceInputSemantics() {
    Array.from(document.querySelectorAll('label:not([for])')).forEach((label) => {
      const control = label.querySelector('input, select, textarea') || (label.parentElement && label.parentElement.querySelector('input, select, textarea'));
      if (control && control.id) label.setAttribute('for', control.id);
    });
    [
      ['new-phone', { type: 'tel', inputmode: 'tel', autocomplete: 'tel' }],
      ['supplier-contact-phone', { type: 'tel', inputmode: 'tel', autocomplete: 'tel' }],
      ['new-tax-code', { inputmode: 'numeric', autocomplete: 'off' }],
      ['supplier-tax-code', { inputmode: 'numeric', autocomplete: 'off' }],
      ['question-order', { inputmode: 'numeric' }],
    ].forEach(([id, attrs]) => {
      const node = $(id);
      if (!node) return;
      Object.keys(attrs).forEach((key) => node.setAttribute(key, attrs[key]));
    });
  }

  function setView(v) {
    state.view = v;
    const onAuth = v === 'login' || v === 'otp';
    // Sidebar + main chỉ hiện khi không ở màn login/otp (authed)
    $('sidebar').classList.toggle('hidden', onAuth);
    $('main').classList.toggle('hidden', onAuth);
    $('view-login').classList.toggle('hidden', v !== 'login');
    $('view-otp').classList.toggle('hidden', v !== 'otp');
    const onDash = v === 'dashboard';
    const routeAllowed = onDash && state.routeAccessStatus !== 'denied'
      && state.routeAccessStatus !== 'feature_off' && state.routeAccessStatus !== 'not_found';
    const activeView = routeAllowed ? navigationItem(state.tab)?.view : null;
    new Set(Object.values(VIEW_IDS)).forEach((viewId) => {
      const node = $(viewId);
      if (node) node.classList.toggle('hidden', !(onDash && activeView === viewId));
    });
    const deniedView = $('view-route-denied');
    if (deniedView) deniedView.classList.toggle('hidden', !(onDash && !routeAllowed));
    const monthControls = $('month-controls');
    if (monthControls) monthControls.classList.toggle('hidden', !routeAllowed);
    const periodControls = $('period-controls');
    if (periodControls) periodControls.classList.toggle('hidden', !(routeAllowed && shouldShowGlobalPeriod()));
    const mobilePeriodControls = $('mobile-period-controls');
    if (mobilePeriodControls) mobilePeriodControls.classList.toggle('hidden', !(routeAllowed && shouldShowGlobalPeriod()));
    if ($('main')) $('main').classList.toggle('dashboard-period-visible', Boolean(routeAllowed && shouldShowGlobalPeriod()));
    const periodNotice = $('period-notice');
    if (periodNotice && !shouldShowGlobalPeriod()) periodNotice.classList.add('hidden');
    renderBreadcrumbs();
    renderModuleNavigation(visibleNavigationItems());
    updateMobileChrome(v);
  }

  // ============ Format ============
  function fmtPercent(r) {
    if (r === null || r === undefined || Number.isNaN(r)) return '—';
    return (r * 100).toFixed(1) + '%';
  }
  function fmtInt(n) {
    if (n === null || n === undefined) return '—';
    return new Intl.NumberFormat('vi-VN').format(n);
  }
  function statusClass(status) {
    return evaluationStatusMeta(status).badgeClass;
  }
  function statusBadge(status) {
    const meta = evaluationStatusMeta(status);
    const span = el('span', { className: 'status-badge admin-status-badge ' + statusClass(status), text: meta.label });
    return span;
  }
  function labeledTd(label, opts) {
    const td = el('td', opts || {});
    td.setAttribute('data-label', label);
    return td;
  }
  function iconSvg(name) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const add = (tag, attrs) => {
      const node = document.createElementNS(ns, tag);
      Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
      svg.appendChild(node);
    };
    const paths = {
      eye: [['path', { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z' }], ['circle', { cx: '12', cy: '12', r: '3' }]],
      history: [['path', { d: 'M3 12a9 9 0 1 0 3-6.7' }], ['path', { d: 'M3 3v6h6' }], ['path', { d: 'M12 7v5l3 2' }]],
      pen: [['path', { d: 'M17 3a2.8 2.8 0 0 1 4 4L7 21l-4 1 1-4Z' }], ['path', { d: 'm15 5 4 4' }]],
      trash: [['path', { d: 'M3 6h18' }], ['path', { d: 'M8 6V4h8v2' }], ['path', { d: 'M19 6l-1 14H6L5 6' }], ['path', { d: 'M10 11v6' }], ['path', { d: 'M14 11v6' }]],
      check: [['path', { d: 'M20 6 9 17l-5-5' }]],
      clipboard: [['path', { d: 'M9 5h6' }], ['path', { d: 'M9 3h6v4H9z' }], ['path', { d: 'M5 5h3v2h8V5h3v16H5z' }], ['path', { d: 'm9 14 2 2 4-4' }]],
      flask: [['path', { d: 'M10 2v7L5 19a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 19L14 9V2' }], ['path', { d: 'M8 2h8' }], ['path', { d: 'M7 16h10' }]],
      printer: [['path', { d: 'M6 9V2h12v7' }], ['path', { d: 'M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2' }], ['path', { d: 'M6 14h12v8H6z' }]],
      spreadsheet: [['path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z' }], ['path', { d: 'M14 2v6h6' }], ['path', { d: 'M8 13h8' }], ['path', { d: 'M8 17h8' }], ['path', { d: 'M11 13v4' }]],
      send: [['path', { d: 'M22 2 11 13' }], ['path', { d: 'm22 2-7 20-4-9-9-4Z' }]],
      return: [['path', { d: 'm9 14-5-5 5-5' }], ['path', { d: 'M20 20v-7a4 4 0 0 0-4-4H4' }]],
      more: [['circle', { cx: '5', cy: '12', r: '1.5' }], ['circle', { cx: '12', cy: '12', r: '1.5' }], ['circle', { cx: '19', cy: '12', r: '1.5' }]],
      lock: [['rect', { x: '5', y: '11', width: '14', height: '10', rx: '2' }],['path', { d: 'M8 11V7a4 4 0 0 1 8 0v4' }],],
      copy: [['rect', { x: '8', y: '8', width: '12', height: '12', rx: '2' }],['path', { d: 'M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2' }],],
      download: [['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }], ['path', { d: 'M7 10l5 5 5-5' }], ['path', { d: 'M12 15V3' }]],
    };
    (paths[name] || paths.eye).forEach(([tag, attrs]) => add(tag, attrs));
    return svg;
  }

  function ensureActionLayerListeners() {
    if (actionLayerListenersReady) return;
    actionLayerListenersReady = true;
    document.addEventListener('click', (event) => {
      if (!activeActionMenu) return;
      if (activeActionMenu.contains(event.target)) return;
      if (activeActionMenuButton && activeActionMenuButton.contains(event.target)) return;
      closeActionMoreMenu();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeActionMoreMenu(true);
    });
    window.addEventListener('resize', closeActionMoreMenu);
    window.addEventListener('scroll', closeActionMoreMenu, true);
  }

  function ensureActionTooltip() {
    if (actionTooltipEl) return actionTooltipEl;
    actionTooltipEl = el('div', { className: 'global-action-tooltip', attrs: { role: 'tooltip' } });
    document.body.appendChild(actionTooltipEl);
    return actionTooltipEl;
  }

  function showActionTooltip(anchor, label) {
    if (!anchor || !label || activeActionMenu) return;
    const tooltip = ensureActionTooltip();
    tooltip.textContent = label;
    tooltip.style.left = '-9999px';
    tooltip.style.top = '-9999px';
    tooltip.classList.add('is-visible');
    const anchorRect = anchor.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const margin = 8;
    let top = anchorRect.top - tooltipRect.height - margin;
    if (top < margin) top = anchorRect.bottom + margin;
    top = Math.min(Math.max(margin, top), window.innerHeight - tooltipRect.height - margin);
    let left = anchorRect.left + (anchorRect.width / 2) - (tooltipRect.width / 2);
    if (anchorRect.right + (tooltipRect.width / 2) > window.innerWidth - margin) {
      left = anchorRect.left - tooltipRect.width - margin;
    }
    if (left < margin) left = Math.min(window.innerWidth - tooltipRect.width - margin, Math.max(margin, anchorRect.right - tooltipRect.width));
    tooltip.style.left = `${Math.max(margin, left)}px`;
    tooltip.style.top = `${top}px`;
  }

  function hideActionTooltip() {
    if (!actionTooltipEl) return;
    actionTooltipEl.classList.remove('is-visible');
  }

  function positionActionMoreMenu(menu, anchor) {
    const anchorRect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const margin = 8;
    let left = anchorRect.right - menuRect.width;
    if (left < margin) left = anchorRect.left;
    left = Math.min(Math.max(margin, left), window.innerWidth - menuRect.width - margin);
    let top = anchorRect.bottom + margin;
    if (top + menuRect.height > window.innerHeight - margin) {
      top = anchorRect.top - menuRect.height - margin;
    }
    top = Math.min(Math.max(margin, top), window.innerHeight - menuRect.height - margin);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  function closeActionMoreMenu(returnFocus = false) {
    if (activeActionMenu && activeActionMenu.parentNode) activeActionMenu.parentNode.removeChild(activeActionMenu);
    const focusTarget = activeActionMenuButton;
    if (activeActionMenuButton) {
      activeActionMenuButton.classList.remove('is-open');
      activeActionMenuButton.setAttribute('aria-expanded', 'false');
      activeActionMenuButton.removeAttribute('aria-controls');
    }
    activeActionMenu = null;
    activeActionMenuButton = null;
    if (returnFocus && focusTarget?.isConnected) focusTarget.focus();
  }

  function ActionMenu(anchor, actions) {
    hideActionTooltip();
    if (!anchor || !actions || !actions.length) return;
    if (activeActionMenuButton === anchor) {
      closeActionMoreMenu();
      return;
    }
    closeActionMoreMenu();
    ensureActionLayerListeners();
    const menuId = `action-overflow-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const menu = el('div', { className: 'action-more-menu', attrs: { id: menuId, role: 'menu', 'aria-label': 'Danh sách thao tác' } });
    actions.forEach((action) => {
      const item = el('button', {
        className: 'action-more-item' + (action.variant === 'danger' ? ' danger' : ''),
        attrs: { type: 'button', role: 'menuitem', 'data-action-id': action.action_id },
      });
      item.disabled = !!action.disabled;
      setDisabledReason(item, action.disabledReason);
      item.appendChild(iconSvg(action.icon || 'eye'));
      item.appendChild(el('span', { text: action.label }));
      item.addEventListener('click', (event) => {
        event.stopPropagation();
        closeActionMoreMenu(true);
        executeAction(action.action_id, {
          trigger: anchor,
          context: action.context,
          objectIdentity: action.objectIdentity,
          confirm: action.confirm,
          run: () => action.handler?.(event),
        });
      });
      menu.appendChild(item);
    });
    menu.addEventListener('keydown', (event) => {
      const items = Array.from(menu.querySelectorAll('[role="menuitem"]:not([disabled])'));
      if (!items.length) return;
      const currentIndex = Math.max(0, items.indexOf(document.activeElement));
      let nextIndex = null;
      if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % items.length;
      if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + items.length) % items.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = items.length - 1;
      if (nextIndex == null) return;
      event.preventDefault();
      items[nextIndex].focus();
    });
    menu.style.left = '-9999px';
    menu.style.top = '-9999px';
    document.body.appendChild(menu);
    activeActionMenu = menu;
    activeActionMenuButton = anchor;
    anchor.classList.add('is-open');
    anchor.setAttribute('aria-expanded', 'true');
    anchor.setAttribute('aria-controls', menuId);
    positionActionMoreMenu(menu, anchor);
    menu.querySelector('button:not([disabled])')?.focus();
  }

  function actionDescriptor(actionId, handler, resource = null, options = {}) {
    const catalog = ACTIONS.getAction(actionId);
    if (!catalog) throw new Error(`action_not_catalogued:${actionId}`);
    const context = options.context || actionContext(resource, options.preconditions ? { preconditions: options.preconditions } : {});
    const availability = ACTIONS.resolveActionState(actionId, context);
    if (availability.state === 'hidden') return null;
    return {
      action_id: actionId,
      key: actionId,
      label: options.label || catalog.label,
      short_label: options.shortLabel || catalog.short_label,
      icon: options.icon || catalog.icon,
      handler,
      variant: options.variant || catalog.variant,
      disabled: options.disabled ?? availability.state === 'disabled',
      disabledReason: options.disabledReason || availability.reason,
      context,
      confirm: options.confirm,
      objectIdentity: options.objectIdentity,
    };
  }

  function RowActionGroup(primaryActions, secondaryActions = []) {
    ensureActionLayerListeners();
    const wrap = el('div', { className: 'icon-actions' });
    const seen = new Set();
    const allActions = [...(primaryActions || []), ...(secondaryActions || [])].filter(Boolean).filter((action) => {
      const key = action.key || action.label;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const partition = ACTIONS.partitionRowActions(allActions);
    const menuActions = partition.overflow;
    let moreButton = null;
    moreButton = iconButton(menuActions.length ? 'Mở danh sách thao tác' : 'Không có thao tác khả dụng', 'more', (event) => {
      event.stopPropagation();
      ActionMenu(moreButton, menuActions);
    }, { more: true, actionId: 'navigation.more', disabled: !menuActions.length, disabledReason: menuActions.length ? '' : 'action_unavailable' });
    moreButton.setAttribute('aria-haspopup', 'menu');
    moreButton.setAttribute('aria-expanded', 'false');
    wrap.appendChild(moreButton);
    return wrap;
  }

  function renderActionBar(className, actions) {
    const wrap = el('div', { className });
    let primaryUsed = false;
    (actions || []).filter(Boolean).forEach((action) => {
      const isPrimary = action.variant === 'primary' && !primaryUsed;
      if (isPrimary) primaryUsed = true;
      const button = el('button', {
        className: isPrimary ? 'btn-primary' : action.variant === 'danger' ? 'btn-ghost btn-danger' : 'btn-ghost',
        text: action.label,
        attrs: { type: 'button', 'data-action-id': action.action_id },
      });
      button.disabled = !!action.disabled;
      setDisabledReason(button, action.disabledReason);
      button.addEventListener('click', () => executeAction(action.action_id, {
        trigger: button, context: action.context, objectIdentity: action.objectIdentity,
        confirm: action.confirm, run: action.handler,
      }));
      wrap.appendChild(button);
    });
    return wrap;
  }

  function PageActionBar(actions) { return renderActionBar('page-action-bar', actions); }
  function FormActionBar(actions) { return renderActionBar('form-action-bar', actions); }

  function hydrateStaticActionButtons() {
    document.querySelectorAll('button').forEach((button) => {
      button.setAttribute('type', button.getAttribute('type') || 'button');
      const actionId = button.dataset.actionId
        || ACTIONS.STATIC_ACTION_BINDINGS[button.id]
        || (button.dataset.routeTab ? 'navigation.open' : '')
        || (button.dataset.authzTab ? 'authorization.tab_open' : '')
        || (button.hasAttribute('data-multiselect-clear') ? 'form.clear_selection' : '');
      if (actionId) button.dataset.actionId = actionId;
    });
  }

  function refreshStaticActionAvailability() {
    document.querySelectorAll('button[data-action-id]').forEach((button) => {
      if (button.dataset.resourceAction === 'true') return;
      const availability = ACTIONS.resolveActionState(button.dataset.actionId, actionContext(null));
      if (availability.state === 'hidden') {
        button.classList.add('hidden');
        button.dataset.actionHidden = '1';
      } else if (button.dataset.actionHidden === '1') {
        button.classList.remove('hidden');
        delete button.dataset.actionHidden;
      }
      if (availability.state === 'disabled') {
        button.disabled = true;
        setDisabledReason(button, availability.reason);
        button.dataset.actionDisabled = '1';
      } else if (button.dataset.actionDisabled === '1') {
        button.disabled = false;
        setDisabledReason(button, '');
        delete button.dataset.actionDisabled;
      }
    });
  }

  function bindRegisteredAction(button, actionId, handler, options = {}) {
    if (!button) return;
    if (typeof actionId === 'string') button.dataset.actionId = actionId;
    button.addEventListener(options.event || 'click', (event) => {
      if (options.preventDefault) event.preventDefault();
      const resolvedActionId = typeof actionId === 'function' ? actionId() : actionId;
      button.dataset.actionId = resolvedActionId;
      const resource = typeof options.resource === 'function' ? options.resource() : options.resource;
      executeAction(resolvedActionId, {
        trigger: options.trigger || button,
        context: options.context?.() || actionContext(resource),
        objectIdentity: options.objectIdentity?.() || options.objectIdentity,
        confirm: options.confirm,
        announceSuccess: options.announceSuccess === true,
        returnFocus: options.returnFocus,
        run: () => handler(event),
      });
    });
  }

  function setRegisteredButtonAction(button, actionId, handler, options = {}) {
    if (!button) return;
    if (button._registeredActionHandler) button.removeEventListener('click', button._registeredActionHandler);
    button.dataset.actionId = actionId;
    button._registeredActionHandler = () => executeAction(actionId, {
      trigger: button,
      context: options.context || actionContext(options.resource),
      objectIdentity: options.objectIdentity,
      confirm: options.confirm,
      announceSuccess: options.announceSuccess === true,
      run: handler,
    });
    button.addEventListener('click', button._registeredActionHandler);
  }

  function iconButton(label, icon, handler, options = {}) {
    const classes = ['icon-btn'];
    if (options.danger) classes.push('danger');
    if (options.primary) classes.push('primary-action');
    if (options.more) classes.push('more-action');
    const btn = el('button', {
      className: classes.join(' '),
      attrs: { type: 'button', 'aria-label': label, 'data-action-tooltip': label,
        ...(options.actionId ? { 'data-action-id': options.actionId } : {}) },
    });
    btn.disabled = !!options.disabled;
    setDisabledReason(btn, options.disabledReason);
    btn.appendChild(iconSvg(icon));
    btn.addEventListener('mouseenter', () => showActionTooltip(btn, label));
    btn.addEventListener('focus', () => showActionTooltip(btn, label));
    btn.addEventListener('mouseleave', hideActionTooltip);
    btn.addEventListener('blur', hideActionTooltip);
    if (handler) btn.addEventListener('click', (event) => {
      hideActionTooltip();
      if (!options.actionId || options.actionId === 'navigation.more') return handler(event);
      return executeAction(options.actionId, {
        trigger: btn,
        context: options.context,
        objectIdentity: options.objectIdentity,
        confirm: options.confirm,
        run: () => handler(event),
      });
    });
    return btn;
  }

  const renderActionGroup = RowActionGroup;
  function approvalIconButton(label, icon, handler, attrs = {}, options = {}) {
    const btn = iconButton(label, icon, handler, options);
    Object.entries(attrs || {}).forEach(([key, value]) => btn.setAttribute(key, value));
    return btn;
  }
  function isMobileViewport() {
    return window.matchMedia && window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`).matches;
  }
  function debounce(fn, wait) {
    let timer = null;
    return (...args) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => fn(...args), wait);
    };
  }
  function mobileLimitKey(id) {
    return id + 'MobileLimit';
  }
  function getMobileLimit(id) {
    const key = mobileLimitKey(id);
    if (!state[key]) state[key] = MOBILE_CARD_PAGE_SIZE;
    return state[key];
  }
  function resetMobileLimit(id) {
    state[mobileLimitKey(id)] = MOBILE_CARD_PAGE_SIZE;
  }
  function ensureMobileList(id, table) {
    let list = $(id);
    if (list) return list;
    list = el('div', { className: 'mobile-row-list', attrs: { id } });
    const wrap = table && table.closest('.table-scroll');
    if (wrap && wrap.parentNode) wrap.parentNode.insertBefore(list, wrap.nextSibling);
    return list;
  }
  function appendMobileField(root, label, value) {
    const item = el('div', { className: 'mobile-card-field' });
    item.appendChild(el('div', { className: 'k', text: label }));
    item.appendChild(el('div', { className: 'v', text: value == null || value === '' ? '—' : String(value) }));
    root.appendChild(item);
  }
  function appendMobileState(list, message) {
    if (!list) return;
    list.textContent = '';
    list.appendChild(el('article', { className: 'mobile-row-card', text: message }));
  }
  function appendMobileLoadMore(list, id, total, render) {
    const visible = getMobileLimit(id);
    if (visible >= total) return;
    const button = el('button', { className: 'btn-ghost mobile-load-more', text: 'Tải thêm', attrs: { type: 'button', 'data-action-id': 'collection.load_more' } });
    button.addEventListener('click', () => {
      state[mobileLimitKey(id)] = visible + MOBILE_CARD_PAGE_SIZE;
      render();
    });
    list.appendChild(button);
  }
  function toggleMobileCard(card) {
    card.classList.toggle('expanded');
  }
  function mobileRegistryActionButton(action) {
    const button = el('button', {
      className: action.variant === 'primary' ? 'btn-primary' : action.variant === 'danger' ? 'btn-ghost btn-danger' : 'btn-ghost',
      text: action.short_label || action.label,
      attrs: { type: 'button', 'data-action-id': action.action_id },
    });
    button.disabled = !!action.disabled;
    setDisabledReason(button, action.disabledReason);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      executeAction(action.action_id, {
        trigger: button,
        context: action.context,
        objectIdentity: action.objectIdentity,
        confirm: action.confirm,
        run: action.handler,
      });
    });
    return button;
  }

  function appendMobileActionSet(root, descriptors) {
    root.appendChild(RowActionGroup((descriptors || []).filter(Boolean)));
  }
  function installSwipeReveal(card) {
    let startX = 0;
    let startY = 0;
    card.addEventListener('touchstart', (event) => {
      const touch = event.touches && event.touches[0];
      if (!touch) return;
      startX = touch.clientX;
      startY = touch.clientY;
    }, { passive: true });
    card.addEventListener('touchend', (event) => {
      const touch = event.changedTouches && event.changedTouches[0];
      if (!touch) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (Math.abs(dx) < 32 || Math.abs(dx) < Math.abs(dy)) return;
      card.classList.toggle('actions-open', dx < 0);
    }, { passive: true });
  }
  function hydrateTableLabels(root) {
    Array.from((root || document).querySelectorAll('.data-table')).forEach((table) => {
      const headers = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent.replace(/\s+/g, ' ').trim());
      if (!headers.length) return;
      Array.from(table.querySelectorAll('tbody tr')).forEach((tr) => {
        Array.from(tr.children).forEach((td, index) => {
          if (td.hasAttribute('data-label')) return;
          td.setAttribute('data-label', headers[index] || '');
        });
      });
    });
  }
  function requestTableLabelHydration() {
    window.requestAnimationFrame(() => hydrateTableLabels(document));
  }
  function setText(id, value) {
    const node = $(id);
    if (node) node.textContent = value == null ? '' : String(value);
  }
  function clearFieldErrors(form) {
    Array.from(form.querySelectorAll('.invalid')).forEach((n) => n.classList.remove('invalid'));
    Array.from(form.querySelectorAll('[data-error-for]')).forEach((n) => { n.textContent = ''; });
  }
  function setFieldError(form, name, msg) {
    const field = form.elements[name];
    if (field) field.classList.add('invalid');
    const err = form.querySelector('[data-error-for="' + name + '"]');
    if (err) err.textContent = msg;
  }
  function classifyScore(score, forcedFail) {
    if (forcedFail || score < 60) return { label: 'Không đạt', grade: 'D', passed: false };
    if (score <= 75) return { label: 'Đạt mức cơ bản, đánh giá lại sau 6 tháng', grade: 'C', passed: true };
    if (score <= 90) return { label: 'Đạt mức khá, đánh giá lại sau 1 năm', grade: 'B', passed: true };
    return { label: 'Đạt mức cao', grade: 'A', passed: true };
  }
  function roundStateKey(code, roundNo) {
    return `${code || ''}:${roundNo || 1}`;
  }
  function normalizeAttendees(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => ({
      name: String(row && (row.name || row.title) || '').trim(),
      principal_id: String(row && row.principal_id || '').trim() || null,
      user_id: String(row && row.user_id || '').trim() || null,
      opening: !!(row && (row.opening || row.opening_meeting)),
      closing: !!(row && (row.closing || row.closing_meeting)),
    })).filter((row) => row.name || row.opening || row.closing);
  }
  function normalizeSupplierIntroduction(value) {
    return String(value == null ? '' : value).trim();
  }
  function supplierIntroductionForTicket(ticket) {
    return ticket ? normalizeSupplierIntroduction(ticket.supplier_introduction) : '';
  }
  function attendeeRowsForTicket(ticket) {
    if (!ticket) return [];
    const key = roundStateKey(ticket.code, ticket.current_round_no || ticket.completed_round || 1);
    if (!state.roundAttendees[key]) state.roundAttendees[key] = [];
    return state.roundAttendees[key];
  }
  function ensureAnswers(ticketCode, questions) {
    if (!ticketCode) return {};
    if (!answersByTicket[ticketCode]) {
      answersByTicket[ticketCode] = {};
    }
    (questions || questionBank).forEach((q) => {
      if (!answersByTicket[ticketCode][q.id]) answersByTicket[ticketCode][q.id] = { score: '', note: '' };
    });
    return answersByTicket[ticketCode];
  }
  function answerComplete(answer, question) {
    if (!answer || !answer.score) return false;
    const hasComment = !['B', 'C', 'D', 'NA'].includes(answer.score) || !!String(answer.note || answer.comment || '').trim();
    const hasAttachment = !(question && question.requiresAttachment) || !!answer.attachment_id || !!answer.attachmentName || (Array.isArray(answer.attachments) && answer.attachments.length > 0);
    return hasComment && hasAttachment;
  }
  function scoringChoicesForQuestion(question) {
    return question?.clause === 'exclusion' ? ['A', 'D', 'NA'] : ['A', 'B', 'C', 'D', 'NA'];
  }
  function collectScoringValidationIssues(answers, questions) {
    const issues = [];
    (questions || questionBank).forEach((q) => {
      const a = answers[q.id] || {};
      if (!a.score) issues.push({
        type: 'question',
        field: 'score',
        questionId: q.id,
        section: q.section,
        message: `${q.section}: chưa chọn điểm cho "${q.question}".`,
      });
      const allowed = q.allowedScores && q.allowedScores.length ? q.allowedScores : (q.clause === 'exclusion' ? ['A', 'D', 'NA'] : ['A', 'B', 'C', 'D', 'NA']);
      if (a.score && !allowed.includes(a.score)) {
        issues.push({
          type: 'question',
          field: 'score',
          questionId: q.id,
          section: q.section,
          message: `${q.section}: câu hỏi "${q.question}" chỉ cho phép ${allowed.join('/')}.`,
        });
      }
      if (['B', 'C', 'D', 'NA'].includes(a.score) && !String(a.note || a.comment || '').trim()) {
        issues.push({
          type: 'question',
          field: 'note',
          questionId: q.id,
          section: q.section,
          message: `${q.section}: điểm ${a.score} cần nhập Ý kiến / Ghi chú.`,
        });
      }
      if (q.requiresAttachment && a.score && !a.attachment_id && !a.attachmentName && !(Array.isArray(a.attachments) && a.attachments.length > 0)) {
        issues.push({
          type: 'question',
          field: 'attachment',
          questionId: q.id,
          section: q.section,
          message: `${q.section}: câu hỏi "${q.question}" yêu cầu bằng chứng/attachment.`,
        });
      }
    });
    return issues;
  }
  function validateScoringAnswers(answers, questions) {
    return collectScoringValidationIssues(answers, questions).map((issue) => issue.message);
  }
  function correctiveValidationIssue(row) {
    const clause = row.clause_code || row.question_code || row.category || 'điểm không phù hợp';
    if (!String(row.remediation || '').trim()) {
      return {
        type: 'nonconformity',
        field: 'remediation',
        nonconformityId: row._validation_id || row.id,
        message: `Điểm không phù hợp ${clause}: chưa chọn Yêu cầu khắc phục.`,
      };
    }
    return {
      type: 'nonconformity',
      field: 'due_date',
      nonconformityId: row._validation_id || row.id,
      message: `Điểm không phù hợp ${clause}: chưa nhập Thời hạn khắc phục.`,
    };
  }
  function participantValidationIssue() {
    return {
      type: 'attendees',
      message: 'Vui lòng nhập Thành phần tham dự trước khi kết thúc đánh giá.',
    };
  }
  function supplierIntroductionValidationIssue() {
    return {
      type: 'supplier_introduction',
      message: 'Vui lòng nhập Giới thiệu NCC trước khi hoàn thành đánh giá.',
    };
  }
  function leadSubmissionValidationIssue() {
    return {
      type: 'lead_submission',
      message: apiErrorMessage('lead_submission_not_eligible'),
    };
  }
  function setScoringValidationIssue(issue) {
    scoringValidationTarget = issue || null;
    const msg = $('scoring-msg');
    if (msg) {
      msg.textContent = issue?.message || '';
      msg.classList.toggle('validation-error', !!issue);
    }
  }
  function clearScoringValidationIssue() {
    scoringValidationTarget = null;
    const msg = $('scoring-msg');
    if (msg) {
      if (msg.classList.contains('validation-error')) msg.textContent = '';
      msg.classList.remove('validation-error');
    }
  }
  function clearValidationDecorationsNear(node) {
    const row = node && node.closest && node.closest('tr');
    if (!row) return;
    row.classList.remove('validation-row');
    row.querySelectorAll('.invalid').forEach((item) => item.classList.remove('invalid'));
    row.querySelectorAll('.validation-inline').forEach((item) => item.remove());
  }
  function issueMatchesQuestion(issue, questionId, field) {
    return issue && issue.type === 'question' && String(issue.questionId) === String(questionId) && (!field || issue.field === field);
  }
  function issueMatchesNonconformity(issue, row, field) {
    const rowId = row?._validation_id || row?.id;
    return issue && issue.type === 'nonconformity' && String(issue.nonconformityId || '') === String(rowId || '') && (!field || issue.field === field);
  }
  function selectorValue(value) {
    const text = String(value);
    return (window.CSS && typeof window.CSS.escape === 'function')
      ? window.CSS.escape(text)
      : text.replace(/["\\]/g, '\\$&');
  }
  function scoringValidationSelector(issue) {
    if (!issue) return '';
    if (issue.type === 'question') {
      if (issue.field === 'note') return `[data-note-id="${selectorValue(issue.questionId)}"]`;
      if (issue.field === 'score') return `[data-question-id="${selectorValue(issue.questionId)}"]`;
      return `[data-scoring-question-row="${selectorValue(issue.questionId)}"]`;
    }
    if (issue.type === 'nonconformity') {
      if (issue.field === 'remediation') return `[data-nc-remediation="${selectorValue(issue.nonconformityId)}"]`;
      if (issue.field === 'due_date') return `[data-nc-due-date="${selectorValue(issue.nonconformityId)}"]`;
      return `[data-nc-row="${selectorValue(issue.nonconformityId)}"]`;
    }
    if (issue.type === 'ticket') return '#scoring-ticket-select';
    if (issue.type === 'questions') return '#scoring-tbody';
    if (issue.type === 'attendees') return '#attendees-empty, #attendees-tbody';
    if (issue.type === 'supplier_introduction') return '#supplier-introduction-input';
    if (issue.type === 'lead_submission') return '#score-overall, #scoring-msg';
    return '#scoring-msg';
  }
  function scrollToScoringValidationIssue(issue) {
    window.requestAnimationFrame(() => {
      const selector = scoringValidationSelector(issue);
      const target = selector ? document.querySelector(selector) : $('scoring-msg');
      const fallback = $('scoring-msg');
      const node = target || fallback;
      if (!node) return;
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (typeof node.focus === 'function' && !node.disabled) node.focus({ preventScroll: true });
    });
  }
  function showScoringValidationIssue(issue) {
    setScoringValidationIssue(issue);
    renderScoring();
    scrollToScoringValidationIssue(issue);
  }
  function calculateScoring(answers, questions) {
    let total = 0, denom = 0;
    const counts = { A: 0, B: 0, C: 0, D: 0 };
    const category = {};
    let exclusionD = false, criticalB = false, criticalC = false;
    const nonconformities = [];
    (questions || questionBank).forEach((q) => {
      const a = answers[q.id] || {};
      if (counts[a.score] !== undefined) counts[a.score] += 1;
      if (!category[q.section]) category[q.section] = { total: 0, denom: 0, score: null };
      if (a.score !== 'NA' && SCORE_VALUES[a.score] !== undefined) {
        total += SCORE_VALUES[a.score]; denom += 1;
        category[q.section].total += SCORE_VALUES[a.score]; category[q.section].denom += 1;
      }
      if (q.clause === 'exclusion' && a.score === 'D') exclusionD = true;
      if (q.critical && a.score === 'B') criticalB = true;
      if (q.critical && a.score === 'C') criticalC = true;
      if (['B', 'C', 'D'].includes(a.score)) nonconformities.push({ ...q, score: a.score, note: a.note || '' });
    });
    Object.keys(category).forEach((k) => { category[k].score = category[k].denom ? category[k].total / category[k].denom : null; });
    const average = denom ? total / denom : 0;
    // BRD priority: exclusion-clause D overrides every average/critical-clause penalty.
    let finalScore = exclusionD ? 0 : average;
    let reason = exclusionD ? 'Không đạt do vi phạm điều khoản loại.' : 'Tính theo điểm trung bình các điều khoản.';
    if (!exclusionD && criticalC) { finalScore = average * 0.90; reason = 'Điều khoản chính yếu C: điểm trung bình × 90%.'; }
    else if (!exclusionD && criticalB) { finalScore = average * 0.95; reason = 'Điều khoản chính yếu B: điểm trung bình × 95%.'; }
    const classified = classifyScore(finalScore, exclusionD);
    return { average, finalScore, reason, counts, category, nonconformities, ...classified };
  }
  function leadSubmissionEligibility(answers, questions, result) {
    const failedCritical = (questions || []).filter((q) => {
      const score = (answers && answers[q.id] || {}).score;
      return q.critical && score === 'D';
    });
    const finalScore = Number(result && result.finalScore);
    const scoreBelowThreshold = Number.isFinite(finalScore) && finalScore < 60;
    return {
      eligible: scoreBelowThreshold || failedCritical.length > 0,
      scoreBelowThreshold,
      failedCriticalCount: failedCritical.length,
    };
  }
  function currentMonthVN() {
    const p = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit' }).split('/');
    return p[1] + '-' + p[0];
  }
  // Format datetime từ SQLite 'YYYY-MM-DD HH:MM:SS' (UTC) sang giờ VN "HH:MM · DD/MM/YYYY"
  function fmtDatetime(s) {
    if (!s) return '—';
    // SQLite trả UTC — append 'Z' để Date parse đúng múi giờ
    const d = new Date(s.replace(' ', 'T') + 'Z');
    if (Number.isNaN(d.getTime())) return s;
    const opts = { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' };
    const parts = new Intl.DateTimeFormat('vi-VN', opts).formatToParts(d);
    const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
    return `${get('hour')}:${get('minute')} · ${get('day')}/${get('month')}/${get('year')}`;
  }
  function sevOf(r) {
    // Client-side fallback when BE severity missing — keep consistent buckets.
    if (r === null || r === undefined) return 'gray';
    return r >= 0.2 ? 'red' : r >= 0.1 ? 'amber' : 'green';
  }

  // ============ KPI card renderer (Tổng quan) ============
  function renderKpiCard(c) {
    const wrap = el('div', { className: 'kpi-card sev-' + (c.severity || 'gray') });
    if (c.key === 'reassessment') {
      wrap.setAttribute('role', 'button');
      wrap.setAttribute('tabindex', '0');
      wrap.style.cursor = 'pointer';
      const open = () => openReassessmentList('due');
      wrap.addEventListener('click', open);
      wrap.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
    }
    wrap.appendChild(el('div', { className: 'kpi-lbl', text: c.label }));
    if (c.status === 'not_ingested' || c.status === 'no_data' || c.value === null) {
      wrap.appendChild(el('div', { className: 'kpi-val gray', text: '—' }));
      const sub = el('div', { className: 'kpi-sub' });
      sub.appendChild(el('span', { text: c.status === 'not_ingested' ? UI_TEXT.emptyStates.notIngested : UI_TEXT.emptyStates.noPeriodData }));
      wrap.appendChild(sub);
      return wrap;
    }
    wrap.appendChild(el('div', { className: 'kpi-val ' + (c.severity || 'gray'), text: fmtInt(c.value) }));
    const sub = el('div', { className: 'kpi-sub' });
    if (c.key === 'reassessment') {
      sub.appendChild(el('span', { text: (c.due_today || 0) + ' đến hạn hôm nay' }));
      sub.appendChild(el('span', { className: 'dot' }));
      sub.appendChild(el('span', { text: (c.overdue || 0) + ' quá hạn' }));
    } else if (c.rate !== null && c.rate !== undefined) {
      sub.appendChild(el('span', { text: fmtPercent(c.rate) }));
      sub.appendChild(el('span', { className: 'dot' }));
    }
    if (c.key !== 'reassessment') {
      if (c.total) sub.appendChild(el('span', { text: '/ ' + fmtInt(c.total) + ' tổng' }));
      else sub.appendChild(el('span', { text: 'sự cố' }));
    }
    wrap.appendChild(sub);
    if (c.scope_label) wrap.appendChild(el('div', { className: 'kpi-sub', text: c.scope_label }));
    // Placeholder cho sparkline — populate sau khi /timeseries trả. Slot trên cùng
    // 1 row trong card, kích thước cố định để layout không jump.
    wrap.appendChild(el('div', { className: 'kpi-spark', attrs: { 'data-spark-key': c.key, style: 'height:30px;margin-top:6px' } }));
    return wrap;
  }

  function openReassessmentList(kind) {
    state.evalStatusTab = '';
    state.evalFilters = {
      ...(state.evalFilters || {}),
      status: 'Chờ khắc phục',
      reassessment: kind || 'due',
    };
    state.evalSearch = '';
    state.evalPage = 1;
    if ($('eval-search')) $('eval-search').value = '';
    if ($('eval-status-filter')) $('eval-status-filter').value = 'Chờ khắc phục';
    navigateToTab('evaluations');
  }

  // ============ Sparkline SVG inline ============
  // Simple polyline trên 0..1 cho rate, hoặc 0..max cho count. Stroke màu severity hiện tại.
  // 12 điểm dữ liệu max → khá đủ resolution cho 30px height.
  // ============ Summary mini-card (tab detail headers) ============
  function summaryCard(label, value, sev, sub) {
    const wrap = el('div', { className: 'kpi-card sev-' + (sev || 'gray') });
    wrap.appendChild(el('div', { className: 'kpi-lbl', text: label }));
    wrap.appendChild(el('div', { className: 'kpi-val ' + (sev || 'gray'), text: value }));
    if (sub) {
      const s = el('div', { className: 'kpi-sub' });
      s.appendChild(el('span', { text: sub }));
      wrap.appendChild(s);
    }
    return wrap;
  }

  // ============ Inline bar cell ============
  function barCell(rate, severity) {
    const td = el('td');
    const wrap = el('div', { className: 'bar-cell' });
    const track = el('div', { className: 'bar-track' });
    const pct = Math.max(1, Math.round((rate || 0) * 100));
    const sev = severity || sevOf(rate);
    const fill = el('div', { className: 'bar-fill sev-' + sev, attrs: { style: 'width:' + pct + '%' } });
    track.appendChild(fill);
    wrap.appendChild(track);
    wrap.appendChild(el('span', { className: 'tag sev-' + sev, text: fmtPercent(rate) }));
    td.appendChild(wrap);
    return td;
  }

  function filteredEvaluations() {
    let rows = demoEvaluations.filter(ownsWorkflowRecord);
    rows = filterEvaluationsByStatus(rows, state.evalStatusTab);
    const q = (state.evalSearch || '').trim().toLowerCase();
    const f = state.evalFilters || {};
    if (q) {
      rows = rows.filter((r) => [r.supplier_name, r.supplier_code, r.code].some((v) => String(v || '').toLowerCase().includes(q)));
    }
    if (f.type) rows = rows.filter((r) => r.evaluation_type === f.type);
    if (f.status) rows = rows.filter((r) => r.status === f.status);
    if (f.mch2) rows = rows.filter((r) => r.mch2 === f.mch2);
    if (f.mch3) rows = rows.filter((r) => r.mch3 === f.mch3);
    if (f.reassessment === 'due') rows = rows.filter((r) => {
      const s = reassessmentStatus(r);
      return s.applies && s.due;
    });
    if (f.reassessment === 'overdue') rows = rows.filter((r) => {
      const s = reassessmentStatus(r);
      return s.applies && s.overdue;
    });
    const dateField = f.dateType || 'created_at';
    const from = f.from ? parseDateValue(f.from) : null;
    const to = f.to ? parseDateValue(f.to) : null;
    if (from) rows = rows.filter((r) => parseDateValue(r[dateField]) >= from);
    if (to) rows = rows.filter((r) => parseDateValue(r[dateField]) <= to);
    const sort = state.evalSort || { field: 'created_at', dir: 'desc' };
    rows.sort((a, b) => {
      let av = a[sort.field], bv = b[sort.field];
      if (sort.field === 'created_at' || sort.field === 'planned_at') { av = parseDateValue(av); bv = parseDateValue(bv); }
      if (sort.field === 'result') { av = av == null ? -1 : av; bv = bv == null ? -1 : bv; }
      if (av < bv) return sort.dir === 'asc' ? -1 : 1;
      if (av > bv) return sort.dir === 'asc' ? 1 : -1;
      return 0;
    });
    return rows;
  }

  function filterSummary(parts) {
    return parts.map((part) => String(part || '').trim()).filter(Boolean).join(', ');
  }

  function evaluationFilterSummary() {
    const f = state.evalFilters || {};
    return filterSummary([
      state.evalSearch && '"' + state.evalSearch + '"',
      state.evalStatusTab,
      f.type,
      f.status,
      f.mch2,
      f.mch3,
      f.reassessment === 'due' ? 'đến hạn đánh giá lại' : '',
      f.reassessment === 'overdue' ? 'quá hạn đánh giá lại' : '',
      f.from ? 'từ ' + isoToVNDate(f.from) : '',
      f.to ? 'đến ' + isoToVNDate(f.to) : '',
    ]);
  }

  function hasActiveEvaluationDetailFilters() {
    const f = state.evalFilters || {};
    return Boolean(
      (f.dateType && f.dateType !== 'created_at') ||
      f.type ||
      f.status ||
      f.mch2 ||
      f.mch3 ||
      f.reassessment ||
      f.from ||
      f.to
    );
  }

  function setCollapsibleFilterOpen(toggleId, detailId, open) {
    const button = $(toggleId);
    const details = $(detailId);
    if (!button || !details) return;
    details.classList.toggle('hidden', !open);
    button.classList.toggle('active', open);
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function syncCollapsibleFilterIndicators() {
    const evalToggle = $('eval-filter-toggle');
    if (evalToggle) evalToggle.classList.toggle('is-filtered', hasActiveEvaluationDetailFilters());
  }

  function initCollapsibleFilterPanel(toggleId, detailId) {
    const button = $(toggleId);
    const details = $(detailId);
    if (!button || !details || button.dataset.filterToggleReady) return;
    button.dataset.filterToggleReady = '1';
    setCollapsibleFilterOpen(toggleId, detailId, !details.classList.contains('hidden'));
    button.addEventListener('click', () => {
      setCollapsibleFilterOpen(toggleId, detailId, details.classList.contains('hidden'));
      syncCollapsibleFilterIndicators();
    });
  }

  function EmptyStateAction(id, options) {
    const root = $(id);
    if (!root) return;
    const h3 = root.querySelector('h3');
    const p = root.querySelector('p');
    let button = root.querySelector('[data-empty-action]') || root.querySelector('button');
    if (!button) {
      button = el('button', { className: 'btn-primary', attrs: { type: 'button', 'data-empty-action': '1' } });
      root.appendChild(button);
    } else {
      button.setAttribute('data-empty-action', '1');
    }
    if (button._emptyActionHandler) button.removeEventListener('click', button._emptyActionHandler);
    const filterText = options.filterText || '';
    if (filterText) {
      if (h3) h3.textContent = 'Không có kết quả cho ' + filterText;
      if (p) p.textContent = 'Xóa bộ lọc để xem lại toàn bộ dữ liệu.';
      button.textContent = options.clearLabel || 'Xóa bộ lọc';
      button.dataset.actionId = 'filter.close';
      button._emptyActionHandler = options.onClear;
      if (button._emptyActionHandler) button.addEventListener('click', button._emptyActionHandler);
      button.className = 'btn-ghost';
      return;
    }
    if (h3) h3.textContent = options.defaultTitle;
    if (p) p.textContent = options.defaultBody;
    button.textContent = options.defaultActionLabel;
    button.dataset.actionId = options.defaultActionId || 'navigation.open';
    button._emptyActionHandler = options.onDefaultAction;
    if (button._emptyActionHandler) button.addEventListener('click', button._emptyActionHandler);
    button.className = 'btn-primary';
  }

  const updateEmptyStateAction = EmptyStateAction;

  function renderEvaluationCounts() {
    const rows = demoEvaluations.filter(ownsWorkflowRecord);
    const draft = rows.filter((r) => r.status === 'Khởi tạo').length;
    const processing = rows.filter((r) => r.status === 'Đang xử lý').length;
    const waiting = rows.filter((r) => (r.status || '').startsWith('Chờ duyệt')).length;
    if ($('eval-count-draft')) $('eval-count-draft').textContent = fmtInt(draft);
    if ($('eval-count-processing')) $('eval-count-processing').textContent = fmtInt(processing);
    if ($('eval-count-waiting')) $('eval-count-waiting').textContent = fmtInt(waiting);
  }

  function renderEvaluationStatusTabs() {
    const container = $('eval-status-tabs');
    if (!container) return;
    const counts = evaluationStatusCounts(demoEvaluations.filter(ownsWorkflowRecord));
    container.textContent = '';
    EVALUATION_STATUS_TABS.forEach((tab) => {
      const active = (state.evalStatusTab || '') === tab.value;
      const button = el('button', {
        className: 'evaluation-status-tab' + (active ? ' active' : ''),
        attrs: {
          type: 'button',
          role: 'tab',
          'aria-selected': active ? 'true' : 'false',
          'data-evaluation-status': tab.value,
        },
      });
      button.appendChild(el('span', { text: tab.label }));
      button.appendChild(el('span', { className: 'evaluation-status-tab-count', text: fmtInt(counts[tab.value] || 0) }));
      button.addEventListener('click', () => {
        state.evalStatusTab = tab.value;
        state.evalFilters = { ...(state.evalFilters || {}), status: '' };
        if ($('eval-status-filter')) $('eval-status-filter').value = '';
        state.evalPage = 1;
        resetMobileLimit('eval');
        renderEvaluations();
      });
      container.appendChild(button);
    });
  }

  function renderEvaluationMobileCards(rows) {
    const list = ensureMobileList('eval-mobile-list', $('eval-tbody') && $('eval-tbody').closest('table'));
    if (!list) return;
    list.textContent = '';
    const visibleRows = rows.slice(0, getMobileLimit('eval'));
    visibleRows.forEach((row) => {
      const card = el('article', { className: 'mobile-row-card' });
      const frame = el('div', { className: 'mobile-swipe-frame' });
      const track = el('div', { className: 'mobile-swipe-track' });
      const main = el('button', { className: 'mobile-card-main', attrs: { type: 'button', 'data-action-id': 'collection.toggle_detail' } });
      main.appendChild(el('div', { className: 'mobile-card-kicker', text: row.code }));
      main.appendChild(el('div', { className: 'mobile-card-title', text: row.supplier_name || 'Chưa có tên NCC' }));
      const meta = el('div', { className: 'mobile-card-meta' });
      meta.appendChild(statusBadge(row.status));
      meta.appendChild(el('span', { className: 'tag sev-gray', text: row.planned_at || row.created_at || 'Chưa có ngày' }));
      meta.appendChild(el('span', { className: 'tag sev-gray', text: row.grade || 'Chưa xếp hạng' }));
      main.appendChild(meta);
      main.addEventListener('click', () => toggleMobileCard(card));
      track.appendChild(main);
      const actions = el('div', { className: 'mobile-card-actions' });
      const descriptors = evaluationActionDescriptors(row);
      if (descriptors.length) appendMobileActionSet(actions, descriptors);
      else actions.appendChild(el('span', { className: 'muted', text: '-' }));
      track.appendChild(actions);
      frame.appendChild(track);
      card.appendChild(frame);
      const detail = el('div', { className: 'mobile-card-detail' });
      appendMobileField(detail, 'Loại hình', row.evaluation_type);
      appendMobileField(detail, 'MCH', [row.mch2, row.mch3].filter(Boolean).join(' / '));
      appendMobileField(detail, 'Ngày tạo', row.created_at);
      appendMobileField(detail, 'Người thực hiện', row.assignee);
      appendMobileField(detail, 'Kết quả', row.result == null ? '—' : row.result.toFixed(1) + '%');
      appendMobileField(detail, 'Kết luận', row.final_conclusion || 'Chưa xác định');
      card.appendChild(detail);
      installSwipeReveal(card);
      list.appendChild(card);
    });
    appendMobileLoadMore(list, 'eval', rows.length, renderEvaluations);
  }

  function approvalActionDescriptors(row) {
    const actions = [actionDescriptor('approval.view', () => approvalDetail(row), row, { objectIdentity: row.code })];
    const add = (actionId, handler, options = {}) => actions.push(actionDescriptor(actionId, handler, row, {
      objectIdentity: row.code,
      ...options,
    }));
    if (resourceCan(row, 'approve_lead')) {
      add('approval.reject_lead', () => applyWorkflowAction('lead-reject', row.code), { confirm: false });
      add('approval.approve_lead', () => applyWorkflowAction('lead-approve', row.code));
    } else if (resourceCan(row, 'approve_tbp')) {
      add('approval.reject_tbp', () => applyWorkflowAction('tbp-reject', row.code), { confirm: false });
      add('approval.send_gdk', () => applyWorkflowAction('tbp-send-gdk', row.code));
      add('approval.approve_tbp', () => applyWorkflowAction('tbp-approve', row.code));
    } else if (resourceCan(row, 'approve_gdk')) {
      add('approval.reject_gdk', () => applyWorkflowAction('gdk-reject', row.code), { confirm: false });
      add('approval.approve_gdk', () => applyWorkflowAction('gdk-approve', row.code));
    }
    return actions.filter(Boolean);
  }

  function renderApprovalMobileCards(rows) {
    const list = ensureMobileList('approval-mobile-list', $('approval-tbody') && $('approval-tbody').closest('table'));
    if (!list) return;
    list.textContent = '';
    rows.slice(0, getMobileLimit('approval')).forEach((row) => {
      const card = el('article', { className: 'mobile-row-card' });
      const frame = el('div', { className: 'mobile-swipe-frame' });
      const track = el('div', { className: 'mobile-swipe-track' });
      const main = el('button', { className: 'mobile-card-main', attrs: { type: 'button', 'data-action-id': 'collection.toggle_detail' } });
      main.appendChild(el('div', { className: 'mobile-card-kicker', text: row.code + ' · ' + row.approvalTypeLabel + ' · ' + row.role }));
      main.appendChild(el('div', { className: 'mobile-card-title', text: row.supplier_name || 'Chưa có tên NCC' }));
      const meta = el('div', { className: 'mobile-card-meta' });
      meta.appendChild(statusBadge(row.status));
      meta.appendChild(el('span', { className: 'tag sev-gray', text: row.resultText || (row.result == null ? 'Chưa có điểm' : row.result.toFixed(1) + '%') }));
      main.appendChild(meta);
      main.addEventListener('click', () => toggleMobileCard(card));
      track.appendChild(main);
      const actions = el('div', { className: 'mobile-card-actions' });
      appendMobileActionSet(actions, approvalActionDescriptors(row));
      track.appendChild(actions);
      frame.appendChild(track);
      card.appendChild(frame);
      const detail = el('div', { className: 'mobile-card-detail' });
      appendMobileField(detail, 'Loại phiếu', row.approvalTypeLabel);
      appendMobileField(detail, 'Vai trò', row.role);
      appendMobileField(detail, 'Trạng thái', row.status);
      appendMobileField(detail, 'Kết quả', row.resultText || (row.result == null ? '—' : row.result.toFixed(1) + '%'));
      card.appendChild(detail);
      installSwipeReveal(card);
      list.appendChild(card);
    });
    appendMobileLoadMore(list, 'approval', rows.length, renderApprovals);
  }

  function renderReportMobileCards(rows) {
    const list = ensureMobileList('report-mobile-list', $('report-tbody') && $('report-tbody').closest('table'));
    if (!list) return;
    list.textContent = '';
    rows.slice(0, getMobileLimit('report')).forEach((row) => {
      const card = el('article', { className: 'mobile-row-card' });
      const frame = el('div', { className: 'mobile-swipe-frame' });
      const track = el('div', { className: 'mobile-swipe-track' });
      const main = el('button', { className: 'mobile-card-main', attrs: { type: 'button', 'data-action-id': 'collection.toggle_detail' } });
      main.appendChild(el('div', { className: 'mobile-card-kicker', text: row.code }));
      main.appendChild(el('div', { className: 'mobile-card-title', text: row.reportType }));
      const meta = el('div', { className: 'mobile-card-meta' });
      meta.appendChild(el('span', { className: 'tag sev-green', text: 'Hoàn thành' }));
      meta.appendChild(el('span', { className: 'tag sev-gray', text: row.supplier_name || 'NCC' }));
      main.appendChild(meta);
      main.addEventListener('click', () => toggleMobileCard(card));
      track.appendChild(main);
      const actions = el('div', { className: 'mobile-card-actions' });
      appendMobileActionSet(actions, reportActionDescriptors(row).filter((action) => action.action_id !== 'report.print'));
      track.appendChild(actions);
      frame.appendChild(track);
      card.appendChild(frame);
      const detail = el('div', { className: 'mobile-card-detail' });
      appendMobileField(detail, 'NCC', row.supplier_name);
      appendMobileField(detail, 'Loại báo cáo', row.reportType);
      appendMobileField(detail, 'Ghi chú', row.reportNote);
      card.appendChild(detail);
      installSwipeReveal(card);
      list.appendChild(card);
    });
    appendMobileLoadMore(list, 'report', rows.length, renderReports);
  }

  function reportActionDescriptors(row) {
    const run = (format) => () => exportReportFormat(row.code, row.reportTypeCode, row.reportRoundNo, format);
    return [
      actionDescriptor('report.print', run('print'), row, { objectIdentity: row.code }),
      actionDescriptor('report.export_excel', run('excel'), row, { objectIdentity: row.code }),
      actionDescriptor('report.export_pdf', run('pdf'), row, { objectIdentity: row.code }),
    ].filter(Boolean);
  }

  function activeAuditTicket() {
    if (state.scoringTicket) {
      const selected = demoEvaluations.find((row) => row.code === state.scoringTicket);
      if (selected) return selected;
    }
    const priority = (row) => {
      const st = row.status || '';
      const reassessment = reassessmentStatus(row);
      if (reassessment.overdue) return 0;
      if (st === 'Chờ khắc phục') return 1;
      if (st.startsWith('Chờ duyệt')) return 2;
      if (st === 'Đang xử lý') return 3;
      if (st === 'Khởi tạo') return 4;
      if (st.includes('lần 2')) return 5;
      return 9;
    };
    return demoEvaluations.filter(ownsWorkflowRecord).sort((a, b) => priority(a) - priority(b))[0] || null;
  }

  function ticketDueInfo(ticket) {
    if (!ticket) return { label: '—', risk: '—', severity: 'gray' };
    const reassessment = reassessmentStatus(ticket);
    if (reassessment.applies) {
      return {
        label: ticket.reassessment_due_date || '—',
        risk: reassessment.label,
        severity: reassessment.severity,
      };
    }
    const planned = parseDateValue(ticket.planned_at);
    if (!planned) return { label: ticket.planned_at || '—', risk: 'Chưa có hạn', severity: 'gray' };
    const diff = daysBetweenDates(planned, todayDateValue());
    if (diff < 0 && ticket.status !== 'Hoàn thành') return { label: ticket.planned_at, risk: 'Quá hạn ' + Math.abs(diff) + ' ngày', severity: 'red' };
    if (diff === 0) return { label: ticket.planned_at, risk: 'Đến hạn hôm nay', severity: 'amber' };
    return { label: ticket.planned_at, risk: diff > 0 ? 'Còn ' + diff + ' ngày' : 'Đã đóng', severity: diff > 0 ? 'green' : 'gray' };
  }

  function scoreChip(value) {
    const score = String(value || 'NA').toUpperCase();
    return el('span', { className: 'score-pill ' + score, text: score });
  }

  function renderAuditFlow(counts) {
    const list = $('audit-flow-list');
    if (!list) return;
    list.textContent = '';
    [
      ['01. Khởi tạo', 'Phiếu mới chờ hoàn thiện thông tin', counts.draft],
      ['02. Chấm điểm', 'Chuyên viên thực hiện đánh giá', counts.processing],
      ['03. Khắc phục', 'NCC bổ sung hồ sơ hoặc hình ảnh', counts.correction],
      ['04. Phê duyệt', 'Lead/TBP/GĐK xử lý kết quả', counts.approval],
      ['05. Đánh giá lần 2', 'Đánh giá lại tiêu chí chưa đạt', counts.round2],
      ['06. Hoàn thành', 'Đã đóng phiếu và sẵn sàng báo cáo', counts.done],
    ].forEach(([title, desc, count]) => {
      const item = el('div', { className: 'flow-item' });
      item.appendChild(el('div', { className: 'flow-dot' }));
      const text = el('div');
      text.appendChild(el('div', { className: 't', text: title }));
      text.appendChild(el('div', { className: 'd', text: desc }));
      item.appendChild(text);
      item.appendChild(el('span', { className: 'tag sev-blue', text: fmtInt(count) }));
      list.appendChild(item);
    });
  }

  function renderAuditTasks(rows) {
    const tbody = $('audit-task-tbody');
    if (!tbody) return;
    tbody.textContent = '';
    if (!rows.length) {
      const tr = el('tr');
      tr.appendChild(labeledTd('Trạng thái', { className: 'muted', attrs: { colspan: '9' }, text: 'Chưa có phiếu đánh giá.' }));
      tbody.appendChild(tr);
      return;
    }
    rows.slice(0, 7).forEach((row, index) => {
      const due = ticketDueInfo(row);
      const tr = el('tr');
      tr.appendChild(labeledTd('STT', { className: 'mono muted', text: String(index + 1).padStart(2, '0') }));
      tr.appendChild(labeledTd('Mã phiếu', { className: 'mono label', text: row.code }));
      tr.appendChild(labeledTd('NCC', { text: row.supplier_name || '—' }));
      tr.appendChild(labeledTd('Vòng', { className: 'mono', text: 'Vòng ' + (row.current_round_no || row.completed_round || 1) }));
      const statusTd = labeledTd('Trạng thái');
      statusTd.appendChild(statusBadge(row.status));
      tr.appendChild(statusTd);
      tr.appendChild(labeledTd('Điểm', { className: 'mono', text: row.result == null ? '—' : row.result.toFixed(1) + '%' }));
      const dueTd = labeledTd('Hạn', { className: 'mono' });
      dueTd.appendChild(el('div', { text: due.label }));
      dueTd.appendChild(el('span', { className: 'tag sev-' + due.severity, text: due.risk }));
      tr.appendChild(dueTd);
      tr.appendChild(labeledTd('Người phụ trách', { text: row.assignee || '—' }));
      const actionTd = labeledTd('Thao tác', { className: 'table-action-cell' });
      actionTd.appendChild(RowActionGroup([
        actionDescriptor('evaluation.score', () => openScoringForTicket(row.code), row, {
          label: 'Mở chấm điểm', objectIdentity: row.code,
        }),
      ]));
      tr.appendChild(actionTd);
      tbody.appendChild(tr);
    });
  }

  function renderAuditAttention(rows) {
    const list = $('audit-attention-list');
    if (!list) return;
    list.textContent = '';
    const items = [];
    rows.forEach((row) => {
      const due = ticketDueInfo(row);
      if (due.severity === 'red') items.push([row.code, row.supplier_name, due.risk, 'red']);
      if ((row.status || '').startsWith('Chờ duyệt')) items.push([row.code, row.supplier_name, row.status, 'amber']);
      if (row.status === 'Chờ khắc phục') items.push([row.code, row.supplier_name, 'Cần theo dõi khắc phục', 'blue']);
    });
    setText('audit-alert-count', items.length + ' mục');
    (items.length ? items.slice(0, 8) : [['Không có cảnh báo', 'Các phiếu đang trong ngưỡng kiểm soát', '—', 'green']]).forEach(([code, supplier, desc, sev]) => {
      const item = el('div', { className: 'attention-item' });
      const title = el('div', { className: 't' });
      title.appendChild(el('span', { className: 'mono', text: code }));
      title.appendChild(el('span', { className: 'tag sev-' + sev, text: desc }));
      item.appendChild(title);
      item.appendChild(el('div', { className: 'd', text: supplier }));
      list.appendChild(item);
    });
  }

  function renderAuditPreview(ticket) {
    const tbody = $('audit-preview-tbody');
    if (!tbody) return;
    tbody.textContent = '';
    const questions = ticket ? questionsForTicket(ticket).slice(0, 5) : [];
    const answers = ticket ? ensureAnswers(ticket.code, questionsForTicket(ticket)) : {};
    if (!questions.length) {
      const tr = el('tr');
      tr.appendChild(labeledTd('Tiêu chí', { className: 'muted', attrs: { colspan: '5' }, text: UI_TEXT.emptyStates.criteriaPreview }));
      tbody.appendChild(tr);
    } else {
      questions.forEach((q, index) => {
        const answer = answers[q.id] || {};
        const tr = el('tr');
        tr.appendChild(labeledTd('#', { className: 'mono muted', text: String(index + 1).padStart(2, '0') }));
        tr.appendChild(labeledTd('Tiêu chí', { text: q.question }));
        tr.appendChild(labeledTd('Trọng số', { className: 'mono', text: q.weight || q.order_index || '—' }));
        const scoreTd = labeledTd('Điểm');
        scoreTd.appendChild(scoreChip(answer.score || 'NA'));
        tr.appendChild(scoreTd);
        tr.appendChild(labeledTd('Kết quả', { text: answerComplete(answer, q) ? 'Hoàn thành' : 'Cần cập nhật' }));
        tbody.appendChild(tr);
      });
    }

    const attendeeList = $('audit-attendee-list');
    if (attendeeList) {
      attendeeList.textContent = '';
      const attendees = ticket ? attendeeRowsForTicket(ticket) : [];
      (attendees.length ? attendees.slice(0, 5) : [{ name: 'Chưa có thành phần tham dự', opening: false, closing: false }]).forEach((row) => {
        const item = el('div', { className: 'attention-item' });
        item.appendChild(el('div', { className: 't', text: row.name || '—' }));
        item.appendChild(el('div', { className: 'd', text: row.opening || row.closing ? [row.opening ? 'Họp khai mạc' : '', row.closing ? 'Họp bế mạc' : ''].filter(Boolean).join(' · ') : 'Cập nhật trong phần chấm điểm' }));
        attendeeList.appendChild(item);
      });
    }

    const ncList = $('audit-nc-preview');
    if (ncList) {
      ncList.textContent = '';
      const rows = (ticket && ticket.nonconformities) || [];
      (rows.length ? rows.slice(0, 5) : [{ nonconformity: 'Chưa có điểm không phù hợp', remediation: '—', due_date: '' }]).forEach((row) => {
        const item = el('div', { className: 'attention-item' });
        item.appendChild(el('div', { className: 't', text: row.nonconformity || row.note || '—' }));
        item.appendChild(el('div', { className: 'd', text: [row.remediation || 'Chưa chọn yêu cầu', row.due_date || 'Chưa có hạn'].join(' · ') }));
        ncList.appendChild(item);
      });
    }
  }

  function renderAuditWorkspace() {
    if (!$('audit-workspace')) return;
    const counts = {
      draft: demoEvaluations.filter((r) => ownsWorkflowRecord(r) && r.status === 'Khởi tạo').length,
      processing: demoEvaluations.filter((r) => ownsWorkflowRecord(r) && r.status === 'Đang xử lý').length,
      correction: demoEvaluations.filter((r) => ownsWorkflowRecord(r) && r.status === 'Chờ khắc phục').length,
      approval: demoEvaluations.filter((r) => ownsWorkflowRecord(r) && (r.status || '').startsWith('Chờ duyệt')).length,
      round2: demoEvaluations.filter((r) => ownsWorkflowRecord(r) && ((r.status || '').includes('lần 2') || (r.current_round_no || 1) >= 2)).length,
      done: demoEvaluations.filter((r) => ownsWorkflowRecord(r) && r.status === 'Hoàn thành').length,
    };
    setText('audit-count-draft', fmtInt(counts.draft));
    setText('audit-count-processing', fmtInt(counts.processing));
    setText('audit-count-correction', fmtInt(counts.correction));
    setText('audit-count-approval', fmtInt(counts.approval));
    setText('audit-count-round2', fmtInt(counts.round2));
    setText('audit-count-done', fmtInt(counts.done));
    renderAuditFlow(counts);
    const rows = demoEvaluations.filter(ownsWorkflowRecord);
    const active = activeAuditTicket();
    if (active && !state.scoringTicket) state.scoringTicket = active.code;
    const due = ticketDueInfo(active);
    setText('audit-active-code', active ? active.code : '—');
    setText('audit-active-supplier', active ? active.supplier_name : 'Chưa chọn phiếu');
    setText('audit-active-round', active ? 'Vòng ' + (active.current_round_no || active.completed_round || 1) : '—');
    setText('audit-active-status', active ? active.status : '—');
    setText('audit-active-score', active && active.result != null ? active.result.toFixed(1) + '%' : '—');
    setText('audit-active-grade', active ? (active.grade || active.result_label || 'Chưa phân loại') : '—');
    setText('audit-active-due', due.label);
    setText('audit-active-risk', due.risk);
    renderAuditTasks(rows);
    renderAuditAttention(rows);
    renderAuditPreview(active);
    ['audit-open-scoring', 'audit-open-history'].forEach((id) => {
      const btn = $(id);
      if (btn) btn.disabled = !active;
    });
  }

  function openScoringForTicket(code) {
    const ticket = demoEvaluations.find((row) => row.code === code);
    if (!ticket) {
      if ($('eval-page-meta')) $('eval-page-meta').textContent = 'Không tìm thấy hoặc không thể truy cập phiếu đánh giá.';
      return;
    }
    if (ticket.is_historical || ticket.read_only) {
      showToast('Phiếu lịch sử chỉ được xem, không mở chấm điểm.', 'info');
      openTicketDetail(ticket.code);
      return;
    }
    state.scoringTicket = ticket.code;
    navigateToTab('scoring');
    loadRoundData(ticket, true).then(() => {
      renderScoring();
    }).catch(() => {
      if ($('scoring-msg')) $('scoring-msg').textContent = 'Không tải được dữ liệu chấm điểm của phiếu đã chọn.';
    });
  }

  function canEndEvaluation(ticket) {
    if (!ticket || !resourceCan(ticket, 'end')) return false;
    if (!ticket.scoringLocked) return false;
    if (ticket.pendingApproval) return false;
    if (['Hoàn thành', 'Hủy', 'Đã hủy', 'Tạm ngưng'].includes(ticket.status)) return false;
    return Number(ticket.result) >= 60;
  }

  function evaluationActionMap(row) {
    const status = row.status || '';
    return {
      detail: actionDescriptor('evaluation.view', () => openTicketDetail(row.code), row),
      history: actionDescriptor('evaluation.history', () => openTicketHistory(row.code), row),
      score: actionDescriptor('evaluation.score', () => openScoringForTicket(row.code), row),
      round2Start: actionDescriptor('evaluation.round2_start', () => startRound2(row.code), row),
      round2Open: status === 'Đang đánh giá lần 2' ? actionDescriptor('evaluation.score', () => openScoringForTicket(row.code), row, { label: 'Đánh giá lần 2' }) : null,
      end: actionDescriptor('evaluation.complete', () => endEvaluation(row.code), row, {
        preconditions: { scoring_locked: !!row.scoringLocked, no_pending_approval: !row.pendingApproval },
      }),
      edit: actionDescriptor('evaluation.edit', () => editEvaluationTicket(row.code), row),
      delete: actionDescriptor('evaluation.delete', () => deleteEvaluationTicket(row.code), row, { confirm: false, objectIdentity: row.code }),
    };
  }

  function evaluationActionDescriptors(row) {
    const actions = evaluationActionMap(row);
    const descriptorById = {
      'evaluation.view': actions.detail,
      'evaluation.history': actions.history,
      'evaluation.score': actions.round2Open || actions.score,
      'evaluation.round2_start': actions.round2Start,
      'evaluation.complete': actions.end,
      'evaluation.edit': actions.edit,
      'evaluation.delete': actions.delete,
    };
    return EVALUATION_ACTION_POLICY.getEligibleEvaluationActionIds(row)
      .map((actionId) => descriptorById[actionId])
      .filter((descriptor) => descriptor && !descriptor.disabled);
  }

  function renderEvaluationActions(row) {
    const descriptors = evaluationActionDescriptors(row);
    return renderActionGroup(descriptors, []);
  }

  function renderEvaluations() {
    const tbody = $('eval-tbody');
    if (!tbody) return;
    tbody.textContent = '';
    renderEvaluationStatusTabs();
    syncCollapsibleFilterIndicators();
    if (state.workflowLoading || state.workflowError) {
      const tr = el('tr');
      const message = state.workflowLoading ? 'Đang tải dữ liệu phiếu đánh giá...' : state.workflowError;
      tr.appendChild(el('td', { className: 'muted', attrs: { colspan: '12' }, text: message }));
      tbody.appendChild(tr);
      appendMobileState(ensureMobileList('eval-mobile-list', tbody.closest('table')), message);
      $('eval-empty').classList.add('hidden');
      $('eval-page-meta').textContent = state.workflowLoading ? 'Đang tải' : 'Lỗi tải dữ liệu';
      $('eval-page-label').textContent = '—';
      $('eval-prev-page').disabled = true;
      $('eval-next-page').disabled = true;
      return;
    }
    renderEvaluationCounts();
    const rows = filteredEvaluations();
    const totalPages = Math.max(1, Math.ceil(rows.length / EVAL_PAGE_SIZE));
    if (state.evalPage > totalPages) state.evalPage = totalPages;
    if (state.evalPage < 1) state.evalPage = 1;
    const start = (state.evalPage - 1) * EVAL_PAGE_SIZE;
    const pageRows = rows.slice(start, start + EVAL_PAGE_SIZE);
    pageRows.forEach((row, i) => {
      const tr = el('tr');
      tr.addEventListener('dblclick', (event) => {
        if (event.target.closest('button, a, input, select, textarea')) return;
        openScoringForTicket(row.code);
      });
      tr.appendChild(labeledTd('STT', { className: 'muted mono', text: String(start + i + 1).padStart(2, '0') }));
      tr.appendChild(labeledTd('Mã phiếu', { className: 'mono label', text: row.code }));
      tr.appendChild(labeledTd('Tên NCC', { className: 'label', text: row.supplier_name, attrs: { title: row.supplier_name || '' } }));
      tr.appendChild(labeledTd('Loại hình', { text: row.evaluation_type, attrs: { title: row.evaluation_type || '' } }));
      tr.appendChild(labeledTd('MCH3', { text: row.mch3, attrs: { title: row.mch3 || '' } }));
      tr.appendChild(labeledTd('Ngày tạo', { className: 'mono muted', text: row.created_at }));
      tr.appendChild(labeledTd('Ngày dự kiến', { className: 'mono muted', text: row.planned_at }));
      const statusTd = labeledTd('Trạng thái'); statusTd.appendChild(statusBadge(row.status)); tr.appendChild(statusTd);
      tr.appendChild(labeledTd('Kết quả', { className: 'num', text: row.result == null ? '—' : row.result.toFixed(1) + '%' }));
      tr.appendChild(labeledTd('Kết luận', { text: row.final_conclusion || 'Chưa xác định' }));
      const reassessmentTd = labeledTd('Đánh giá lại');
      reassessmentTd.appendChild(reassessmentBadge(row));
      if (row.reassessment_due_date_iso) {
        reassessmentTd.appendChild(el('div', { className: 'muted mono', text: row.reassessment_due_date }));
      }
      tr.appendChild(reassessmentTd);
      const actionTd = labeledTd('Thao tác', { className: 'table-action-cell' });
      actionTd.appendChild(renderEvaluationActions(row));
      tr.appendChild(actionTd);
      tbody.appendChild(tr);
    });
    updateEmptyStateAction('eval-empty', {
      filterText: rows.length === 0 ? evaluationFilterSummary() : '',
      defaultTitle: 'Không có phiếu phù hợp',
      defaultBody: 'Thử xóa lọc hoặc tạo phiếu mới để kiểm tra luồng danh sách.',
      defaultActionLabel: 'Tạo phiếu đánh giá',
      onDefaultAction: () => navigateToTab('evaluation-new'),
      onClear: () => $('eval-reset-filters') && $('eval-reset-filters').click(),
    });
    $('eval-empty').classList.toggle('hidden', rows.length > 0);
    renderEvaluationMobileCards(rows);
    $('eval-page-meta').textContent = rows.length === 0 ? '0 phiếu' : `${start + 1}-${Math.min(start + EVAL_PAGE_SIZE, rows.length)} / ${rows.length} phiếu`;
    $('eval-page-label').textContent = `${state.evalPage} / ${totalPages}`;
    $('eval-prev-page').disabled = state.evalPage <= 1;
    $('eval-next-page').disabled = state.evalPage >= totalPages;
    Array.from(document.querySelectorAll('[data-eval-sort]')).forEach((btn) => {
      btn.classList.remove('asc', 'desc');
      if (btn.dataset.evalSort === state.evalSort.field) btn.classList.add(state.evalSort.dir);
    });
    requestTableLabelHydration();
  }

  const EMPTY_DETAIL_TEXT = '—';

  function dash(value) {
    if (Array.isArray(value)) {
      const joined = value.map((item) => dash(item)).filter((item) => item !== EMPTY_DETAIL_TEXT).join(', ');
      return joined || EMPTY_DETAIL_TEXT;
    }
    const text = String(value ?? '').trim();
    return text || EMPTY_DETAIL_TEXT;
  }

  function joinDetailParts(parts, separator = ' · ') {
    const text = parts.map((item) => dash(item)).filter((item) => item !== EMPTY_DETAIL_TEXT).join(separator);
    return text || EMPTY_DETAIL_TEXT;
  }

  function detailSection(title, items) {
    const section = el('section', { className: 'detail-section' });
    section.appendChild(el('h4', { className: 'detail-section-title', text: title }));
    const grid = el('div', { className: 'detail-grid' });
    items.forEach(([label, value]) => {
      const item = el('div', { className: 'detail-item' });
      item.appendChild(el('div', { className: 'k', text: label }));
      const valueWrap = el('div', { className: 'v' });
      if (value instanceof Node) valueWrap.appendChild(value);
      else valueWrap.textContent = dash(value);
      item.appendChild(valueWrap);
      grid.appendChild(item);
    });
    section.appendChild(grid);
    return section;
  }

  function legalAttachmentLinks(row) {
    const wrap = el('div');
    const items = [
      ['Giay phep kinh doanh', row.legal_attachments && row.legal_attachments.business_license, row.business_license_file],
      ['Chung nhan ATTP', row.legal_attachments && row.legal_attachments.attp_certificate, row.attp_certificate_file],
    ];
    let added = false;
    items.forEach(([label, attachment, fallback]) => {
      if (!attachment && !fallback) return;
      if (added) wrap.appendChild(document.createElement('br'));
      wrap.appendChild(el('span', { text: label + ': ' }));
      if (attachment && attachment.download_url) {
        wrap.appendChild(el('a', { text: attachment.file_name || fallback || label, attrs: { href: attachment.download_url, target: '_blank', rel: 'noopener' } }));
      } else {
        wrap.appendChild(el('span', { text: fallback || EMPTY_DETAIL_TEXT }));
      }
      added = true;
    });
    return added ? wrap : null;
  }

  function workflowLine(marker, title, description) {
    const line = el('div', { className: 'workflow-step' });
    line.appendChild(el('div', { className: 'n', text: marker }));
    const text = el('div');
    text.appendChild(el('div', { className: 't', text: dash(title) }));
    text.appendChild(el('div', { className: 'd', text: dash(description) }));
    line.appendChild(text);
    return line;
  }

  function isRound2NotPassed(ticket) {
    return (ticket.completed_round || 1) >= 2 && ticket.result != null && ticket.result < 60;
  }

  function approvalCommentText(raw) {
    if (!raw) return '';
    try {
      const parsed = JSON.parse(raw);
      return parsed.approver_comment || parsed.comment || '';
    } catch {
      return raw;
    }
  }

  async function openTicketDetail(code) {
    const r = await api('/evaluations/' + encodeURIComponent(code));
    if (!r.ok) {
      showToast('Không tải được chi tiết phiếu.', 'err');
      return;
    }
    const row = mapTicketFromApi(r.data.ticket);
    row.corrective_actions = r.data.corrective_actions || [];
    row.correction_extensions = r.data.correction_extensions || [];
    row.nonconformities = r.data.nonconformities || [];
    row.category_summary = r.data.category_summary || [];
    row.attachments = r.data.attachments || [];
    row.assessments = r.data.assessments || [];
    row.legal_attachments = r.data.legal_attachments || {};
    row.approval_tasks = r.data.approval_tasks || [];
    row.workflow_history = r.data.workflow_history || [];
    row.rejection_history = r.data.rejection_history || [];

    const body = $('ticket-detail-body');
    body.textContent = '';
    if (row.is_historical) {
      body.appendChild(detailSection('Nguồn dữ liệu', [
        ['Loại phiếu', 'Phiếu lịch sử'],
        ['Chế độ', 'Chỉ đọc'],
        ['STT nguồn', row.historical_source_stt],
        ['Lưu ý', 'Nguồn lịch sử không có dữ liệu biểu mẫu và câu hỏi chi tiết.'],
      ]));
    }
    body.appendChild(detailSection('Thông tin đánh giá', [
      ['Mã phiếu', row.code],
      ['Trạng thái', row.status],
      ['Loại hình đánh giá', row.evaluation_type],
      ['Ngày đánh giá dự kiến', row.planned_at],
      ['Ngày đánh giá thực tế', row.actual_evaluation_date],
      ['Người thực hiện', row.assignee],
      ['QA lead', row.qa_lead],
      ['QA support', row.qa_support],
      ['Người tạo', row.created_by_display_name],
      ['Cập nhật bởi', row.updated_by_display_name],
      ['Ngày đánh giá tiếp theo', row.next_evaluation_date],
      ['Ngày đánh giá lại dự kiến', row.reassessment_due_date],
      ['Tình trạng đánh giá lại', reassessmentStatus(row).label],
    ]));
    body.appendChild(detailSection('Thông tin ngành hàng', [
      ['CMC phụ trách', row.cmc_owner],
      ['CMC trưởng phòng', row.cmc_head],
      ['Ngành hàng MCH2', row.mch2],
      ['Ngành hàng MCH3', row.mch3],
    ]));
    body.appendChild(detailSection('Thông tin nhà cung cấp', [
      ['Mã NCC', row.supplier_code],
      ['Tên NCC', row.supplier_name],
      ['Mã số thuế', row.tax_code],
      ['Địa chỉ', row.address],
      ['Khu vực', row.region],
      ['Tỉnh', row.province],
      ['Loại hình kinh doanh', row.business_type],
      ['Địa chỉ đánh giá NCC', row.snapshot_evaluation_address || row.evaluation_address],
    ]));
    body.appendChild(detailSection('Thông tin liên hệ NCC', [
      ['Người liên hệ', row.contact_name],
      ['Email liên hệ', row.contact_email],
      ['Số điện thoại', row.contact_phone],
    ]));
    body.appendChild(detailSection('Thông tin đơn vị liên kết/gia công', [
      ['Tên đơn vị liên kết', row.snapshot_linked_facility_name || row.linked_facility_name],
      ['Địa chỉ đánh giá đơn vị liên kết/gia công', row.snapshot_linked_facility_address || row.linked_facility_address],
    ]));
    if (!row.is_historical) {
      body.appendChild(detailSection('Xác nhận bộ tiêu chí đánh giá', [
        ['Biểu mẫu đánh giá', row.template_code],
        ['Sản phẩm dự kiến đánh giá', row.product_name],
        ['Loại cơ sở', row.facility_type],
        ['Quy mô NCC', row.supplier_scale],
      ]));
    }
    body.appendChild(detailSection('Kết quả đánh giá', [
      ['Điểm ban đầu', row.round_1_score_percent == null ? '' : row.round_1_score_percent + '%'],
      ['Xếp loại ban đầu', row.round_1_grade_code],
      ['Kết quả ban đầu', row.round_1_result_label],
      ['Điểm sau điều chỉnh', row.corrected_score_percent == null ? '' : row.corrected_score_percent + '%'],
      ['Kết quả sau điều chỉnh', joinDetailParts([row.corrected_grade_code, row.corrected_result_label])],
      ['Ngày điều chỉnh', row.correction_date],
      ['Kết luận cuối cùng', row.final_conclusion || 'Chưa xác định'],
      ['Đề xuất chuyên viên', row.specialist_proposal],
    ]));

    renderTicketDetailWorkflow(body, row);
    const editBtn = $('btn-edit-ticket');
    const canEdit = canEditWorkflowRecord(row) && ['Khởi tạo', 'Đang xử lý'].includes(row.status);
    editBtn.classList.toggle('hidden', !canEdit);
    setRegisteredButtonAction(editBtn, 'evaluation.edit', () => editEvaluationTicket(row.code), {
      resource: row, objectIdentity: row.code, announceSuccess: false,
    });
    const deleteBtn = $('btn-delete-ticket');
    const canDelete = canEditWorkflowRecord(row) && row.status === 'Khởi tạo';
    deleteBtn.classList.toggle('hidden', !canDelete);
    setRegisteredButtonAction(deleteBtn, 'evaluation.delete', () => deleteEvaluationTicket(row.code), {
      resource: row, objectIdentity: row.code, confirm: false, announceSuccess: false,
    });
    $('ticket-detail-modal').classList.remove('hidden');
  }

  async function editEvaluationTicket(code) {
    const r = await api('/evaluations/' + encodeURIComponent(code));
    if (!r.ok) {
      showToast('Không tải được phiếu để sửa.', 'err');
      return;
    }
    const row = mapTicketFromApi(r.data.ticket);
    fillEvaluationFormFromTicket(row);
    state.editingTicketCode = row.code;
    state.selectedSupplierId = row.supplier_id || null;
    $('ticket-detail-modal').classList.add('hidden');
    navigateToTab('evaluation-new');
    setMsg('evaluation-form-msg', 'Đang chỉnh sửa phiếu ' + row.code + '.', 'ok');
  }

  async function openTicketHistory(code) {
    const r = await api('/evaluations/' + encodeURIComponent(code) + '/history');
    if (!r.ok) {
      showToast('Không tải được lịch sử phiếu.', 'err');
      return;
    }
    const tbody = $('ticket-history-tbody');
    if (!tbody) return;
    tbody.textContent = '';
    const rows = r.data.history || [];
    rows.forEach((h) => {
      const tr = el('tr');
      tr.appendChild(el('td', { className: 'mono muted', text: h.created_at || '' }));
      tr.appendChild(el('td', { text: userDisplay(h, 'actor_user_id') || '' }));
      tr.appendChild(el('td', { text: h.actor_role || '' }));
      tr.appendChild(el('td', { className: 'mono', text: h.action || '' }));
      tr.appendChild(el('td', { text: h.from_status || EMPTY_DETAIL_TEXT }));
      tr.appendChild(el('td', { text: h.to_status || EMPTY_DETAIL_TEXT }));
      tr.appendChild(el('td', { text: h.comment || '' }));
      tbody.appendChild(tr);
    });
    if (!rows.length) {
      const tr = el('tr');
      tr.appendChild(el('td', { className: 'muted', attrs: { colspan: '7' }, text: 'Chưa có lịch sử xử lý.' }));
      tbody.appendChild(tr);
    }
    if ($('ticket-history-title')) $('ticket-history-title').textContent = 'Lịch sử phiếu ' + code;
    $('ticket-history-modal').classList.remove('hidden');
  }

  function assessmentAnswerForQuestion(payload, question) {
    const canonicalAnswers = payload.canonical_answers || {};
    const legacyAnswers = payload.answers || {};
    return canonicalAnswers[String(question.id)]
      || legacyAnswers[String(question.db_id || '')]
      || legacyAnswers[String(question.id)]
      || {};
  }

  function assessmentEvidenceLinks(attachments) {
    const wrap = el('div');
    const rows = Array.isArray(attachments) ? attachments : [];
    if (!rows.length) {
      wrap.textContent = EMPTY_DETAIL_TEXT;
      return wrap;
    }
    rows.forEach((attachment, index) => {
      if (index) wrap.appendChild(document.createElement('br'));
      if (attachment.download_url) {
        wrap.appendChild(el('a', {
          text: attachment.file_name || `Bằng chứng ${index + 1}`,
          attrs: { href: attachment.download_url, target: '_blank', rel: 'noopener' },
        }));
      } else {
        wrap.appendChild(el('span', { text: attachment.file_name || `Bằng chứng ${index + 1}` }));
      }
    });
    return wrap;
  }

  async function openAssessmentRoundDetail(code, roundNo) {
    const ticket = demoEvaluations.find((row) => row.code === code);
    const modal = $('assessment-detail-modal');
    const body = $('assessment-detail-body');
    if (!ticket || !modal || !body || ![1, 2].includes(Number(roundNo))) return;
    const assessment = (ticket.assessments || []).find((row) => Number(row.round_no) === Number(roundNo)) || {};
    const title = $('assessment-detail-title');
    if (title) title.textContent = `Chi tiết ${assessment.assessment_code || `${code}-R${roundNo}`}`;
    body.textContent = '';
    body.appendChild(el('div', { className: 'admin-state', attrs: { 'data-state': 'loading' }, text: 'Đang tải chi tiết lượt đánh giá...' }));
    modal.classList.remove('hidden');

    const response = await api('/evaluations/' + encodeURIComponent(code) + '/rounds/' + Number(roundNo));
    body.textContent = '';
    if (!response.ok) {
      body.appendChild(el('div', {
        className: 'admin-state admin-state--error',
        attrs: { 'data-state': 'error' },
        text: 'Không tải được chi tiết lượt đánh giá. Vui lòng kiểm tra lại quyền truy cập.',
      }));
      return;
    }

    const payload = response.data || {};
    const round = payload.round || {};
    const questions = (payload.questions || []).map(mapQuestionFromApi)
      .sort((a, b) => (a.order_index || 0) - (b.order_index || 0) || String(a.question_code).localeCompare(String(b.question_code)));
    const evaluator = userDisplay(assessment, 'evaluator_id') || round.locked_by || EMPTY_DETAIL_TEXT;
    body.appendChild(detailSection('Thông tin lượt đánh giá', [
      ['Mã assessment', assessment.assessment_code || `${code}-R${roundNo}`],
      ['Lần đánh giá', assessment.label || `Đánh giá lần ${String(roundNo).padStart(3, '0')}`],
      ['Ngày đánh giá', isoToVNDate(assessment.assessment_date || round.completed_at || round.started_at || '')],
      ['Người đánh giá', evaluator],
      ['Điểm tổng', round.total_score == null ? EMPTY_DETAIL_TEXT : `${Number(round.total_score).toFixed(1)}%`],
      ['Phân loại', round.classification || EMPTY_DETAIL_TEXT],
      ['Kết quả', round.final_result || assessment.final_conclusion || EMPTY_DETAIL_TEXT],
      ['Trạng thái', round.status || assessment.status || EMPTY_DETAIL_TEXT],
    ]));

    const section = el('section', { className: 'detail-section' });
    section.appendChild(el('h4', { className: 'detail-section-title', text: 'Chi tiết từng tiêu chí' }));
    const wrap = el('div', { className: 'table-wrap' });
    const table = el('table', { className: 'data-table assessment-answer-table' });
    const head = el('thead');
    const headRow = el('tr');
    ['Mã tiêu chí', 'Nội dung', 'Loại', 'Mức đánh giá', 'Điểm quy đổi', 'Ghi chú', 'Bằng chứng'].forEach((label) => headRow.appendChild(el('th', { text: label })));
    head.appendChild(headRow);
    table.appendChild(head);
    const tbody = el('tbody');
    questions.forEach((question) => {
      const answer = assessmentAnswerForQuestion(payload, question);
      const tr = el('tr');
      const type = question.clause === 'exclusion' ? 'Loại' : question.critical ? 'Chính yếu' : 'Thông thường';
      tr.appendChild(labeledTd('Mã tiêu chí', { className: 'mono', text: question.question_code || EMPTY_DETAIL_TEXT }));
      tr.appendChild(labeledTd('Nội dung', { text: question.question || EMPTY_DETAIL_TEXT }));
      tr.appendChild(labeledTd('Loại', { text: type }));
      tr.appendChild(labeledTd('Mức đánh giá', { className: 'mono', text: answer.score || EMPTY_DETAIL_TEXT }));
      tr.appendChild(labeledTd('Điểm quy đổi', {
        className: 'mono',
        text: answer.calculated_score == null ? EMPTY_DETAIL_TEXT : String(answer.calculated_score),
      }));
      tr.appendChild(labeledTd('Ghi chú', { text: answer.note || answer.comment || EMPTY_DETAIL_TEXT }));
      const evidenceTd = labeledTd('Bằng chứng');
      evidenceTd.appendChild(assessmentEvidenceLinks(answer.attachments));
      tr.appendChild(evidenceTd);
      tbody.appendChild(tr);
    });
    if (!questions.length) {
      const tr = el('tr');
      tr.appendChild(el('td', { className: 'muted', attrs: { colspan: '7' }, text: 'Lượt đánh giá chưa có dữ liệu tiêu chí.' }));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    section.appendChild(wrap);
    body.appendChild(section);

    const attendees = Array.isArray(round.attendees) ? round.attendees : [];
    body.appendChild(detailSection('Thành phần tham dự', [
      ['Người tham dự', attendees.map((row) => row.name).filter(Boolean).join(', ') || EMPTY_DETAIL_TEXT],
      ['Họp khai mạc', attendees.filter((row) => row.opening).map((row) => row.name).filter(Boolean).join(', ') || EMPTY_DETAIL_TEXT],
      ['Họp bế mạc', attendees.filter((row) => row.closing).map((row) => row.name).filter(Boolean).join(', ') || EMPTY_DETAIL_TEXT],
    ]));
  }

  function isReturnHistory(row) {
    const action = String(row.action || '');
    const fromStatus = String(row.from_status || '');
    const toStatus = String(row.to_status || '');
    return action.includes('REJECT') || action.includes('RETURN') || (fromStatus.includes('Chờ duyệt') && toStatus.includes('Đang xử lý'));
  }

  function renderTicketDetailWorkflow(body, row) {
    const section = el('section', { className: 'detail-section' });
    section.appendChild(el('h4', { className: 'detail-section-title', text: 'Tổng hợp đánh giá và phê duyệt' }));
    const list = el('div', { className: 'workflow-step-list' });
    list.appendChild(workflowLine('+', 'Luồng xử lý', 'CAPA, gia hạn, tạm ngưng, hủy phiếu và lịch sử phê duyệt.'));

    const assessmentRows = row.assessments || [];
    if (assessmentRows.length) {
      const wrap = el('div', { className: 'table-wrap detail-table-wrap' });
      const table = el('table', { className: 'tbl' });
      const head = el('thead');
      const headTr = el('tr');
      ['Mã assessment', 'Lần', 'Liên kết', 'Ngày đánh giá', 'Người đánh giá', 'Điểm', 'Kết luận', 'Trạng thái', 'Thao tác'].forEach((label, index) => headTr.appendChild(el('th', { className: index === 8 ? 'table-action-cell' : '', text: label })));
      head.appendChild(headTr);
      table.appendChild(head);
      const tbody = el('tbody');
      assessmentRows.forEach((item) => {
        const tr = el('tr');
        tr.appendChild(el('td', { className: 'mono', text: item.assessment_code || '' }));
        tr.appendChild(el('td', { text: item.label || ('Đánh giá lần ' + String(item.round_no || '').padStart(3, '0')) }));
        tr.appendChild(el('td', { className: 'mono muted', text: item.source_assessment_code ? ('Từ ' + item.source_assessment_code) : '-' }));
        tr.appendChild(el('td', { className: 'mono', text: isoToVNDate(item.assessment_date || '') }));
        tr.appendChild(el('td', { text: userDisplay(item, 'evaluator_id') || '' }));
        tr.appendChild(el('td', { className: 'mono', text: item.total_score == null ? EMPTY_DETAIL_TEXT : Number(item.total_score).toFixed(1) + '%' }));
        tr.appendChild(el('td', { text: item.final_conclusion || EMPTY_DETAIL_TEXT }));
        tr.appendChild(el('td', { text: item.status || '' }));
        const actionTd = el('td', { className: 'table-action-cell' });
        if (row.is_historical) {
          actionTd.appendChild(el('span', { className: 'tag sev-blue', text: 'Chỉ đọc' }));
        } else {
          actionTd.appendChild(RowActionGroup([
            actionDescriptor('evaluation.view', () => openAssessmentRoundDetail(row.code, item.round_no), row, {
              label: 'Xem chi tiết lượt đánh giá', objectIdentity: item.assessment_code || row.code,
            }),
          ]));
        }
        tr.appendChild(actionTd);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
      list.appendChild(wrap);
    }

    const summaryRows = row.category_summary || [];
    if (summaryRows.length) {
      const wrap = el('div', { className: 'table-wrap detail-table-wrap' });
      const table = el('table', { className: 'tbl' });
      const head = el('thead');
      const headTr = el('tr');
      ['Hạng mục', 'Lần đánh giá', 'Tổng', 'A', 'B', 'C', 'D', 'NA', 'TB'].forEach((label) => headTr.appendChild(el('th', { text: label })));
      head.appendChild(headTr);
      table.appendChild(head);
      const tbody = el('tbody');
      summaryRows.forEach((item) => {
        const tr = el('tr');
        tr.appendChild(el('td', { text: item.category || '' }));
        tr.appendChild(el('td', { className: 'mono', text: item.round_no || '' }));
        tr.appendChild(el('td', { className: 'mono', text: item.total || 0 }));
        tr.appendChild(el('td', { className: 'mono', text: item.a_count || 0 }));
        tr.appendChild(el('td', { className: 'mono', text: item.b_count || 0 }));
        tr.appendChild(el('td', { className: 'mono', text: item.c_count || 0 }));
        tr.appendChild(el('td', { className: 'mono', text: item.d_count || 0 }));
        tr.appendChild(el('td', { className: 'mono', text: item.na_count || 0 }));
        tr.appendChild(el('td', { className: 'mono', text: item.average_score == null ? EMPTY_DETAIL_TEXT : Number(item.average_score).toFixed(1) + '%' }));
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
      list.appendChild(wrap);
    }

    (row.nonconformities || []).forEach((item) => {
      const title = joinDetailParts([item.clause_code, item.category], ' ');
      const details = [
        'Mô tả: ' + dash(item.nonconformity),
        'Khắc phục: ' + dash(item.remediation),
        'Hạn: ' + dash(item.due_date),
        'Trạng thái: ' + dash(item.status || 'OPEN'),
      ].join(' · ');
      list.appendChild(workflowLine(item.severity || 'NC', title === EMPTY_DETAIL_TEXT ? 'Điểm không phù hợp' : title, details));
    });

    (row.corrective_actions || []).forEach((item) => {
      list.appendChild(workflowLine('CA', item.issue_description, joinDetailParts([
        item.required_action,
        item.responsible_party || 'NCC/QA',
        item.due_date,
        item.status,
      ])));
    });
    if (!(row.corrective_actions || []).length) {
      list.appendChild(workflowLine('CA', 'Chưa có yêu cầu khắc phục', 'Tạo từ các điểm không phù hợp sau đánh giá lần 1/lần 2.'));
    }

    (row.correction_extensions || []).forEach((item) => {
      list.appendChild(workflowLine('EXT ' + (item.extension_no || ''), 'Gia hạn khắc phục', joinDetailParts([
        item.created_at,
        userDisplay(item, 'created_by'),
        'Lý do: ' + dash(item.reason),
        'Hạn cũ: ' + dash(item.old_due_date),
        'Hạn mới: ' + dash(item.new_due_date),
      ])));
    });

    (row.attachments || []).forEach((item) => {
      list.appendChild(workflowLine('ATT', item.file_name || item.storage_key || 'Attachment', joinDetailParts([
        'Lần đánh giá ' + dash(item.round_no || '-'),
        item.question_code || 'ticket',
        userDisplay(item, 'uploaded_by'),
        item.uploaded_at,
      ])));
    });

    const rejectionRows = (row.rejection_history && row.rejection_history.length)
      ? row.rejection_history
      : (row.workflow_history || []).filter((h) => isReturnHistory(h) && h.comment).slice().reverse();
    rejectionRows.forEach((item, index) => {
      list.appendChild(workflowLine('!', `Ý kiến trả về #${index + 1}`, joinDetailParts([
        item.created_at,
        item.actor_role,
        userDisplay(item, 'actor_user_id'),
        item.comment,
      ])));
    });

    if (!row.is_historical) {
      const actions = el('div', { className: 'workflow-actions', attrs: { style: 'padding:12px 16px' } });
      const reportSelect = el('select', { className: 'input', attrs: { id: 'ticket-report-template-select', style: 'max-width:260px' } });
      reportSelect.appendChild(el('option', { attrs: { value: '' }, text: 'Chọn mẫu PDF' }));
      loadReportTemplatesForExport(reportSelect);
      actions.appendChild(reportSelect);
      const roundSelect = el('select', { className: 'input', attrs: { id: 'ticket-report-round-select', style: 'max-width:190px' } });
      roundSelect.appendChild(el('option', { attrs: { value: '' }, text: 'Lần mới nhất' }));
      assessmentRows.forEach((item) => {
        roundSelect.appendChild(el('option', { attrs: { value: String(item.round_no || '') }, text: item.label || ('Đánh giá lần ' + item.round_no) }));
      });
      actions.appendChild(roundSelect);
      actions.appendChild(el('span', { className: 'muted mono', attrs: { id: 'ticket-report-export-msg' }, text: '' }));
      const detailActions = [actionDescriptor('report.export_pdf', () => exportTicketPdf(row.code), row, { objectIdentity: row.code })];
      if (canEditWorkflowRecord(row) && !['Hoàn thành', 'Gia hạn', 'Tạm ngưng', 'Hủy', 'Đã hủy'].includes(row.status)) {
        detailActions.push(actionDescriptor('evaluation.cancellation_request', () => requestTicketCancellation(row.code), row, { objectIdentity: row.code }));
      }
      if (canEditWorkflowRecord(row) && isRound2NotPassed(row) && row.status !== 'Chờ duyệt (TBP)') {
        detailActions.push(actionDescriptor('evaluation.correction_extension', () => createCorrectionExtension(row.code), row, { objectIdentity: row.code }));
        detailActions.push(actionDescriptor('evaluation.suspension_request', () => submitTicketProposal(row.code, 'SUSPENSION'), row, { objectIdentity: row.code }));
      }
      actions.appendChild(FormActionBar(detailActions.filter(Boolean)));
      if ((row.approval_tasks || []).some((task) => task.status === 'PENDING')) {
        actions.appendChild(el('span', { className: 'tag sev-amber', text: 'Đang chờ phê duyệt' }));
      }
      list.appendChild(actions);
    }

    (row.approval_tasks || []).forEach((task) => {
      list.appendChild(workflowLine(task.approval_level || 'AP', joinDetailParts([task.assigned_role, task.status]), joinDetailParts([
        task.acted_at || task.created_at,
        userDisplay(task, 'acted_by'),
        approvalCommentText(task.comment),
      ])));
    });

    const historyActions = el('div', { className: 'workflow-actions', attrs: { style: 'padding:12px 16px' } });
    const historyBtn = el('button', { className: 'btn-ghost', text: 'Lịch sử xử lý', attrs: { type: 'button', 'data-action-id': 'evaluation.workflow_history' } });
    const historyWrap = el('div', { className: 'table-wrap detail-table-wrap hidden' });
    const historyTable = el('table', { className: 'tbl' });
    const thead = el('thead');
    const headTr = el('tr');
    ['Thời gian', 'Người xử lý', 'Vai trò', 'Hành động', 'Trạng thái trước', 'Trạng thái sau', 'Ý kiến'].forEach((label) => headTr.appendChild(el('th', { text: label })));
    thead.appendChild(headTr);
    historyTable.appendChild(thead);
    const tbody = el('tbody');
    (row.workflow_history || []).forEach((h) => {
      const tr = el('tr');
      tr.appendChild(el('td', { className: 'mono muted', text: h.created_at || '' }));
      tr.appendChild(el('td', { text: userDisplay(h, 'actor_user_id') || '' }));
      tr.appendChild(el('td', { text: h.actor_role || '' }));
      tr.appendChild(el('td', { className: 'mono', text: h.action || '' }));
      tr.appendChild(el('td', { text: h.from_status || EMPTY_DETAIL_TEXT }));
      tr.appendChild(el('td', { text: h.to_status || EMPTY_DETAIL_TEXT }));
      tr.appendChild(el('td', { text: h.comment || '' }));
      tbody.appendChild(tr);
    });
    if (!(row.workflow_history || []).length) {
      const tr = el('tr');
      tr.appendChild(el('td', { className: 'muted', text: 'Chưa có lịch sử xử lý.', attrs: { colspan: '7' } }));
      tbody.appendChild(tr);
    }
    historyTable.appendChild(tbody);
    historyWrap.appendChild(historyTable);
    setRegisteredButtonAction(historyBtn, 'evaluation.workflow_history', () => historyWrap.classList.toggle('hidden'), {
      resource: row, objectIdentity: row.code, announceSuccess: false,
    });
    historyActions.appendChild(historyBtn);
    list.appendChild(historyActions);
    list.appendChild(historyWrap);
    section.appendChild(list);
    body.appendChild(section);
  }

  async function loadReportTemplatesForExport(select) {
    const r = await api('/report-templates');
    const items = (r.ok && r.data.items) || [];
    items.forEach((t) => select.appendChild(el('option', { attrs: { value: String(t.id) }, text: `${reportTypeText(t.report_type)} · ${t.template_name}` })));
  }

  async function exportTicketPdf(code) {
    const select = $('ticket-report-template-select');
    const roundSelect = $('ticket-report-round-select');
    const msg = $('ticket-report-export-msg');
    if (!select || !select.value) {
      if (msg) msg.textContent = UI_TEXT.reports.chooseTemplate;
      return;
    }
    if (msg) msg.textContent = UI_TEXT.reports.exportingPdf;
    const body = {};
    if (roundSelect && roundSelect.value) body.round_no = Number(roundSelect.value);
    const r = await requestExportDownload(
      '/evaluations/' + encodeURIComponent(code) + '/reports/' + encodeURIComponent(select.value) + '/export-pdf',
      { body, accept: 'application/pdf, application/json', fallbackFileName: code + '-report.pdf' }
    );
    if (!r.ok) {
      if (msg) msg.textContent = UI_TEXT.reports.exportPdfFailed;
      return;
    }
    if (msg) msg.textContent = 'Đã tải PDF.';
  }

  async function deleteEvaluationTicket(code) {
    const confirmed = await confirmAction({
      title: 'Xóa phiếu nháp?',
      message: 'Phiếu ' + code + ' sẽ bị xóa nếu đang ở trạng thái Khởi tạo. Hành động này không thể hoàn tác.',
      cancelLabel: 'Giữ phiếu',
      confirmLabel: 'Xóa phiếu nháp',
      destructive: true,
    });
    if (!confirmed) return;
    const reason = prompt('Nhập lý do xóa phiếu ' + code + ':', '');
    if (!reason || !reason.trim()) {
      showToast('Vui lòng nhập lý do xóa.', 'err');
      return;
    }
    const r = await api('/evaluations/' + encodeURIComponent(code), { method: 'DELETE', body: { reason: reason.trim() } });
    if (!r.ok) {
      const msg = r.status === 403 ? 'Chỉ được xóa phiếu ở trạng thái Khởi tạo.' : (r.status === 400 ? 'Vui lòng nhập lý do xóa.' : 'Không xóa được phiếu.');
      showToast(msg, 'err');
      return;
    }
    const index = demoEvaluations.findIndex((row) => row.code === code);
    if (index >= 0) demoEvaluations.splice(index, 1);
    delete answersByTicket[code];
    if (state.scoringTicket === code) state.scoringTicket = '';
    $('ticket-detail-modal').classList.add('hidden');
    showToast('Đã xóa phiếu nháp ' + code + '.', 'ok');
    renderEvaluations();
    renderScoring();
    renderApprovals();
    renderReports();
  }

  async function createCorrectionExtension(code) {
    const reason = prompt('Lý do gia hạn:');
    if (!reason || !reason.trim()) return showToast(apiErrorMessage('extension_reason_required'), 'err');
    const newDueDateInput = prompt('Thời hạn khắc phục mới (DD/MM/YYYY):', '');
    if (!newDueDateInput || !newDueDateInput.trim()) return showToast(apiErrorMessage('extension_due_date_required'), 'err');
    const newDueDate = dateInputValue(newDueDateInput.trim());
    if (!newDueDate) return showToast(apiErrorMessage('extension_due_date_invalid'), 'err');
    const r = await api('/evaluations/' + encodeURIComponent(code) + '/extensions', {
      method: 'POST',
      body: { reason: reason.trim(), new_due_date: newDueDate },
    });
    if (!r.ok) {
      return showToast(apiErrorMessage(r.data && r.data.error, apiErrorMessage('extension_create_failed')), 'err');
    }
    const updated = mapTicketFromApi(r.data.ticket);
    const index = demoEvaluations.findIndex((row) => row.code === updated.code);
    if (index >= 0) demoEvaluations[index] = { ...demoEvaluations[index], ...updated };
    renderEvaluations();
    renderScoring();
    openTicketDetail(code);
  }

  async function submitTicketProposal(code, type) {
    const reason = prompt(type === 'EXTENSION' ? 'Lý do gia hạn:' : 'Lý do đề xuất tạm ngừng:');
    if (!reason) return;
    const body = { type, reason, comment: prompt('Ý kiến gửi TBP:', '') || '' };
    if (type === 'EXTENSION') {
      const proposedDueDate = prompt('Ngày gia hạn đề xuất (DD/MM/YYYY):', '');
      if (!proposedDueDate) return;
      body.proposed_due_date = dateInputValue(proposedDueDate.trim());
      if (!body.proposed_due_date) return showToast(apiErrorMessage('extension_due_date_invalid'), 'err');
    } else {
      body.business_impact = prompt('Ghi chú tác động kinh doanh:', '');
      if (!body.business_impact) return;
    }
    const r = await api('/evaluations/' + encodeURIComponent(code) + '/proposals', { method: 'POST', body });
    if (!r.ok) return showToast('Không gửi được đề xuất. Kiểm tra đánh giá lần 2 đã Không đạt và chưa có phê duyệt đang chờ.', 'err');
    const updated = mapTicketFromApi(r.data.ticket);
    const idx = demoEvaluations.findIndex((item) => item.code === updated.code);
    if (idx >= 0) demoEvaluations[idx] = updated;
    renderEvaluations();
    renderApprovals();
    openTicketDetail(code);
  }

  async function requestTicketCancellation(code) {
    const reason = prompt('Lý do hủy phiếu:');
    if (!reason) return;
    const r = await api('/evaluations/' + encodeURIComponent(code) + '/cancel-request', { method: 'POST', body: { reason } });
    if (!r.ok) return showToast('Không gửi được yêu cầu hủy.', 'err');
    const updated = mapTicketFromApi(r.data.ticket);
    const idx = demoEvaluations.findIndex((item) => item.code === updated.code);
    if (idx >= 0) demoEvaluations[idx] = updated;
    renderEvaluations();
    renderApprovals();
    openTicketDetail(code);
  }

  function saveAttendeeInputs() {
    const ticket = selectedTicket();
    if (!ticket || !resourceCan(ticket, 'score') || ticket.scoringLocked) return;
    const key = roundStateKey(ticket.code, ticket.current_round_no || ticket.completed_round || 1);
    const existingRows = state.roundAttendees[key] || [];
    const rows = [];
    Array.from(document.querySelectorAll('[data-attendee-index]')).forEach((input) => {
      const index = parseInt(input.getAttribute('data-attendee-index'), 10);
      rows[index] = rows[index] || {
        principal_id: existingRows[index]?.principal_id || null,
        user_id: existingRows[index]?.user_id || null,
      };
      rows[index].name = input.value;
    });
    Array.from(document.querySelectorAll('[data-attendee-opening]')).forEach((input) => {
      const index = parseInt(input.getAttribute('data-attendee-opening'), 10);
      rows[index] = rows[index] || {
        principal_id: existingRows[index]?.principal_id || null,
        user_id: existingRows[index]?.user_id || null,
      };
      rows[index].opening = input.checked;
    });
    Array.from(document.querySelectorAll('[data-attendee-closing]')).forEach((input) => {
      const index = parseInt(input.getAttribute('data-attendee-closing'), 10);
      rows[index] = rows[index] || {
        principal_id: existingRows[index]?.principal_id || null,
        user_id: existingRows[index]?.user_id || null,
      };
      rows[index].closing = input.checked;
    });
    state.roundAttendees[key] = normalizeAttendees(rows);
    if (scoringValidationTarget && scoringValidationTarget.type === 'attendees' && state.roundAttendees[key].length) clearScoringValidationIssue();
  }

  function saveSupplierIntroductionInput() {
    const ticket = selectedTicket();
    const input = $('supplier-introduction-input');
    if (!ticket || !input || !resourceCan(ticket, 'score') || ticket.scoringLocked) return;
    ticket.supplier_introduction = input.value;
    if (scoringValidationTarget && scoringValidationTarget.type === 'supplier_introduction' && supplierIntroductionForTicket(ticket)) {
      clearScoringValidationIssue();
    }
  }

  function renderAttendees(ticket) {
    const tbody = $('attendees-tbody');
    if (!tbody) return;
    tbody.textContent = '';
    const rows = ticket ? attendeeRowsForTicket(ticket) : [];
    const locked = !!(ticket && ticket.scoringLocked);
    const disabled = !ticket || locked || !resourceCan(ticket, 'score');
    rows.forEach((row, index) => {
      const tr = el('tr');
      const nameTd = labeledTd('Tên/Chức danh');
      const nameInput = el('input', {
        className: 'input',
        attrs: { 'data-attendee-index': String(index), placeholder: 'Nhập tên/chức danh' },
      });
      nameInput.value = row.name || '';
      nameInput.disabled = disabled;
      nameTd.appendChild(nameInput);
      tr.appendChild(nameTd);

      const openingTd = labeledTd('Họp khai mạc');
      const openingInput = el('input', { attrs: { type: 'checkbox', 'data-attendee-opening': String(index) } });
      openingInput.checked = !!row.opening;
      openingInput.disabled = disabled;
      openingTd.appendChild(openingInput);
      tr.appendChild(openingTd);

      const closingTd = labeledTd('Họp bế mạc');
      const closingInput = el('input', { attrs: { type: 'checkbox', 'data-attendee-closing': String(index) } });
      closingInput.checked = !!row.closing;
      closingInput.disabled = disabled;
      closingTd.appendChild(closingInput);
      tr.appendChild(closingTd);

      const actionTd = labeledTd('Thao tác', { className: 'table-action-cell' });
      actionTd.appendChild(RowActionGroup([
        actionDescriptor('evaluation.remove_attendee', () => {
          saveAttendeeInputs();
          attendeeRowsForTicket(ticket).splice(index, 1);
          renderScoring();
        }, ticket, {
          label: 'Xóa người tham dự', objectIdentity: `#${index + 1}`,
          disabled, disabledReason: disabled ? 'invalid_status' : '',
        }),
      ]));
      tr.appendChild(actionTd);
      tbody.appendChild(tr);
    });
    const empty = $('attendees-empty');
    if (empty) empty.classList.toggle('hidden', !ticket || rows.length > 0);
    const addBtn = $('btn-add-attendee');
    if (addBtn) addBtn.disabled = disabled;
  }

  function renderSupplierIntroduction(ticket) {
    const input = $('supplier-introduction-input');
    const error = $('supplier-introduction-error');
    if (!input) return;
    const roundNo = ticket ? Number(ticket.current_round_no || ticket.completed_round || 1) : 1;
    const hasSavedIntroduction = !!supplierIntroductionForTicket(ticket);
    const lockedForReuse = roundNo > 1 && hasSavedIntroduction;
    const disabled = !ticket || !!(ticket && ticket.scoringLocked) || !resourceCan(ticket, 'score') || lockedForReuse;
    input.value = ticket ? (ticket.supplier_introduction || '') : '';
    input.disabled = disabled;
    input.classList.toggle('invalid', !!(scoringValidationTarget && scoringValidationTarget.type === 'supplier_introduction'));
    if (error) {
      error.textContent = scoringValidationTarget && scoringValidationTarget.type === 'supplier_introduction'
        ? scoringValidationTarget.message
        : '';
    }
  }

  async function loadScoringRoundAndRender(ticket) {
    try {
      await loadRoundData(ticket);
    } catch (error) {
      $('scoring-msg').textContent = 'Không tải được dữ liệu chấm điểm.';
      return;
    }
    try {
      renderScoring();
    } catch (error) {
      handleScoringRenderError(error);
    }
  }

  function renderScoring() {
    const select = $('scoring-ticket-select');
    if (!select) return;
    if (state.workflowLoading || state.workflowError) {
      select.textContent = '';
      select.appendChild(el('option', { attrs: { value: '' }, text: state.workflowLoading ? 'Đang tải phiếu...' : 'Không tải được dữ liệu' }));
      $('scoring-tbody').textContent = '';
      $('scoring-empty').classList.toggle('hidden', state.workflowLoading);
      $('scoring-msg').textContent = state.workflowLoading ? 'Đang tải dữ liệu chấm điểm...' : state.workflowError;
      renderAttendees(null);
      renderSupplierIntroduction(null);
      renderNonconformities([], null);
      renderScoringSummary(null, null);
      renderEvaluationWorkflowStepper(null);
      return;
    }
    const routeTicket = scoringTicketFromRoute();
    const current = routeTicket || state.scoringTicket || select.value;
    select.textContent = '';
    select.appendChild(el('option', { attrs: { value: '' }, text: 'Chọn phiếu đánh giá' }));
    demoEvaluations.filter(ownsWorkflowRecord).forEach((r) => select.appendChild(el('option', { attrs: { value: r.code }, text: r.code + ' · ' + r.supplier_name })));
    if (current) select.value = current;
    state.scoringTicket = select.value;
    if (routeTicket && !state.scoringTicket && $('scoring-msg')) {
      $('scoring-msg').textContent = 'Không tìm thấy hoặc không thể truy cập phiếu đánh giá đã chọn.';
    }
    select.classList.toggle('invalid', !!(scoringValidationTarget && scoringValidationTarget.type === 'ticket'));
    if (scoringValidationTarget) {
      const msg = $('scoring-msg');
      if (msg) {
        msg.textContent = scoringValidationTarget.message;
        msg.classList.add('validation-error');
      }
    } else if ($('scoring-msg')) {
      $('scoring-msg').classList.remove('validation-error');
    }
    const chosen = !!state.scoringTicket;
    const selectedTicket = demoEvaluations.find((r) => r.code === state.scoringTicket);
    const roundNo = selectedTicket ? (selectedTicket.current_round_no || selectedTicket.completed_round || 1) : 1;
    const roundKey = selectedTicket ? selectedTicket.code + ':' + roundNo : '';
    if (selectedTicket && !state.roundLoaded[roundKey]) {
      $('scoring-msg').textContent = 'Đang tải dữ liệu chấm điểm...';
      loadScoringRoundAndRender(selectedTicket);
      return;
    }
    renderEvaluationWorkflowStepper(selectedTicket);
    const ticketQuestions = questionsForTicket(selectedTicket);
    const sectionSelect = $('scoring-section-filter');
    const currentSection = sectionSelect.value;
    const validationQuestion = scoringValidationTarget && scoringValidationTarget.type === 'question'
      ? ticketQuestions.find((q) => String(q.id) === String(scoringValidationTarget.questionId))
      : null;
    sectionSelect.textContent = '';
    sectionSelect.appendChild(el('option', { attrs: { value: '' }, text: 'Tất cả hạng mục' }));
    Array.from(new Set(ticketQuestions.map((q) => q.section).filter(Boolean))).forEach((section) => {
      sectionSelect.appendChild(el('option', { attrs: { value: section }, text: section }));
    });
    sectionSelect.value = validationQuestion?.section
      || (Array.from(sectionSelect.options).some((opt) => opt.value === currentSection) ? currentSection : '');
    const sectionFilter = sectionSelect.value;
    const rows = chosen ? ticketQuestions.filter((r) => !sectionFilter || r.section === sectionFilter) : [];
    const answers = ensureAnswers(state.scoringTicket, ticketQuestions);
    const locked = selectedTicket && selectedTicket.scoringLocked;
    const editableRound = !!selectedTicket && resourceCan(selectedTicket, 'score') && !locked;
    renderAttendees(selectedTicket);
    renderSupplierIntroduction(selectedTicket);
    const tbody = $('scoring-tbody');
    tbody.textContent = '';
    if (chosen && ticketQuestions.length === 0) {
      const tr = el('tr');
      tr.appendChild(el('td', {
        className: 'muted',
        attrs: { colspan: '6' },
        text: 'Chưa có tiêu chí đang hoạt động phù hợp với biểu mẫu, loại cơ sở và quy mô NCC của phiếu.',
      }));
      tbody.appendChild(tr);
      $('scoring-msg').textContent = 'Không thể chấm điểm: chưa có bộ tiêu chí phù hợp cho biến thể BM đã chọn.';
    }
    let lastSection = null;
    rows.forEach((r) => {
      const answer = answers[r.id] || { score: '', note: '' };
      const answerReadonly = !!(answer.readonly || answer.inherited);
      if (r.section !== lastSection) {
        lastSection = r.section;
        const sectionTr = el('tr');
        sectionTr.appendChild(el('td', {
          className: 'label',
          attrs: { colspan: '6' },
          text: r.section || 'Chưa phân loại',
        }));
        tbody.appendChild(sectionTr);
      }
      const rowIssue = scoringValidationTarget && scoringValidationTarget.type === 'question' && String(scoringValidationTarget.questionId) === String(r.id)
        ? scoringValidationTarget
        : null;
      const tr = el('tr', {
        className: rowIssue ? 'validation-row' : '',
        attrs: { 'data-scoring-question-row': r.id },
      });
      tr.appendChild(labeledTd('Điều khoản', { className: 'mono muted', text: r.question_code || '' }));
      const qTd = labeledTd('Câu hỏi');
      qTd.appendChild(el('div', { text: r.question }));
      if (answerReadonly) qTd.appendChild(el('div', { className: 'muted mono', text: 'Kế thừa từ lần 1' }));
      if (r.requiresAttachment) qTd.appendChild(el('div', { className: 'muted mono', text: 'Yêu cầu bằng chứng' }));
      if (rowIssue) qTd.appendChild(el('div', { className: 'field-error validation-inline', text: rowIssue.message }));
      tr.appendChild(qTd);
      const typeTd = labeledTd('Loại');
      if (r.clause === 'exclusion') typeTd.appendChild(el('span', { className: 'tag sev-red', text: 'Loại' }));
      else if (r.critical) typeTd.appendChild(el('span', { className: 'tag sev-amber', text: 'Chính yếu' }));
      else typeTd.appendChild(el('span', { className: 'tag sev-gray', text: 'Thường' }));
      if (r.requiresAttachment) typeTd.appendChild(el('span', { className: 'tag sev-blue', text: UI_TEXT.common.evidence }));
      tr.appendChild(typeTd);
      const scoreTd = labeledTd('Điểm');
      const scoreInvalid = issueMatchesQuestion(scoringValidationTarget, r.id, 'score');
      const scoreChoices = scoringChoicesForQuestion(r);
      const scoreGroup = el('div', {
        className: 'score-segmented' + (r.clause === 'exclusion' ? ' exclusion' : '') + (scoreInvalid ? ' invalid' : ''),
        attrs: {
          role: 'radiogroup',
          tabindex: '-1',
          'aria-label': `Điểm cho điều khoản ${r.question_code || r.id}`,
          'aria-invalid': scoreInvalid ? 'true' : 'false',
          'data-question-id': r.id,
        },
      });
      const scoreValue = el('input', {
        attrs: { type: 'hidden', 'data-score-value': r.id, value: answer.score || '' },
      });
      scoreValue.value = answer.score || '';
      scoreGroup.appendChild(scoreValue);
      scoreChoices.forEach((value, index) => {
        const selected = answer.score === value;
        const choice = el('button', {
          className: 'score-segment' + (selected ? ' selected' : ''),
          text: value,
          attrs: {
            type: 'button',
            role: 'radio',
            'aria-checked': selected ? 'true' : 'false',
            tabindex: selected || (!answer.score && index === 0) ? '0' : '-1',
            'data-score-choice': value,
          },
        });
        choice.disabled = !editableRound || answerReadonly;
        scoreGroup.appendChild(choice);
      });
      scoreTd.appendChild(scoreGroup); tr.appendChild(scoreTd);
      const noteTd = labeledTd('Ghi chú');
      const note = el('input', {
        className: 'input note-input' + (issueMatchesQuestion(scoringValidationTarget, r.id, 'note') ? ' invalid' : ''),
        attrs: { 'data-note-id': r.id, placeholder: ['B', 'C', 'D', 'NA'].includes(answer.score) ? 'Bắt buộc nhập ghi chú' : 'Ghi chú nếu có' },
      });
      note.value = answer.note || '';
      note.disabled = !editableRound || answerReadonly;
      noteTd.appendChild(note); tr.appendChild(noteTd);
      const td = labeledTd('Trạng thái');
      td.appendChild(statusBadge(answerComplete(answer, r) ? 'Hoàn thành' : (answer.score ? 'Đang xử lý' : 'Khởi tạo')));
      tr.appendChild(td);
      tbody.appendChild(tr);
    });
    renderScoringSummary(chosen ? answers : null, selectedTicket, ticketQuestions);
    $('scoring-empty').classList.toggle('hidden', chosen);
  }

  function renderEvaluationWorkflowStepper(ticket) {
    const container = $('scoring-workflow-stepper');
    if (!container) return;
    container.textContent = '';
    const steps = getEvaluationWorkflowSteps(ticket);
    container.classList.toggle('hidden', steps.length === 0);
    steps.forEach((step) => {
      const item = el('div', { className: `evaluation-workflow-step ${step.state}` });
      const marker = step.state === 'complete' ? '✓' : step.state === 'current' ? '●' : '○';
      item.appendChild(el('span', { className: 'evaluation-workflow-marker', text: marker, attrs: { 'aria-hidden': 'true' } }));
      const content = el('span', { className: 'evaluation-workflow-content' });
      content.appendChild(el('span', { className: 'evaluation-workflow-label', text: step.label }));
      if (step.occurredAt) {
        content.appendChild(el('time', {
          className: 'evaluation-workflow-date',
          text: isoToVNDate(String(step.occurredAt).slice(0, 10)),
          attrs: { datetime: step.occurredAt },
        }));
      }
      item.appendChild(content);
      container.appendChild(item);
    });
  }

  function renderScoringSummary(answers, ticket, questions) {
    const activeQuestions = questions || [];
    const total = activeQuestions.length;
    const done = answers ? activeQuestions.filter((q) => answerComplete(answers[q.id], q)).length : 0;
    $('score-progress').textContent = `${done} / ${answers ? total : 0}`;
    const complete = answers && total > 0 && done === total;
    const result = complete ? calculateScoring(answers, activeQuestions) : null;
    $('score-overall').textContent = result ? result.finalScore.toFixed(1) + '%' : '—';
    $('score-classification').textContent = result ? result.label : 'Chưa hoàn thành';
    $('score-grade').textContent = result ? result.grade : '—';
    $('score-reason').textContent = result ? result.reason : 'Theo thang BRD';
    $('score-counts').textContent = result ? `${result.counts.A}/${result.counts.B}/${result.counts.C}/${result.counts.D}` : '0/0/0/0';
    $('scoring-status').textContent = ticket ? `Trạng thái phiếu: ${ticket.status}` : '';
    renderReassessmentBanner(ticket);
    renderNonconformities(currentRoundNonconformityRows(ticket, result ? result.nonconformities : null), ticket);
    const roundNo = ticket ? (ticket.current_round_no || ticket.completed_round || 1) : 1;
    const leadEligibility = result ? leadSubmissionEligibility(answers, activeQuestions, result) : { eligible: false };
    const canScoreRound = !!ticket && resourceCan(ticket, 'score');
    const roundLocked = !!(ticket && ticket.scoringLocked);
    $('btn-complete-scoring').disabled = !answers || roundLocked || !canScoreRound;
    $('btn-save-scoring-draft').disabled = !answers || roundLocked || !canScoreRound;
    $('btn-complete-scoring').classList.toggle('hidden', !!ticket && (roundLocked || !canScoreRound));
    $('btn-save-scoring-draft').classList.toggle('hidden', !!ticket && (roundLocked || !canScoreRound));
    const canSubmitLead = !!ticket && resourceCan(ticket, 'submit_lead') && ticket.scoringLocked && result && [1, 2].includes(Number(roundNo)) && leadEligibility.eligible;
    $('btn-submit-lead').classList.toggle('hidden', !canSubmitLead);
    if ($('btn-end-evaluation')) {
      const endAllowed = canEndEvaluation(ticket);
      $('btn-end-evaluation').classList.toggle('hidden', !endAllowed);
      $('btn-end-evaluation').disabled = !endAllowed;
      if (endAllowed) {
        delete $('btn-end-evaluation').dataset.actionDisabled;
        $('btn-end-evaluation').removeAttribute('title');
      }
    }
    const showRound2 = ticket && resourceCan(ticket, 'round2_start') && Number(roundNo) === 1 && ticket.round_2_eligible && !ticket.round_2_exists;
    $('btn-start-round2').textContent = 'Tạo đánh giá lần 2';
    $('btn-start-round2').classList.toggle('hidden', !showRound2);
  }

  function renderReassessmentBanner(ticket) {
    const msg = $('scoring-msg');
    if (!msg || !msg.parentElement) return;
    let banner = $('scoring-reassessment-banner');
    if (!banner) {
      banner = el('div', { className: 'deadline-banner hidden', attrs: { id: 'scoring-reassessment-banner' } });
      const scoringPanel = msg.closest('.panel');
      const nonconformityPanel = scoringPanel && scoringPanel.querySelector('#nonconformity-tbody')?.closest('.panel');
      if (nonconformityPanel) nonconformityPanel.before(banner);
      else msg.parentElement.after(banner);
    }
    const status = reassessmentStatus(ticket);
    const show = !!(status.applies && status.due && ticket && ticket.status === 'Chờ khắc phục');
    banner.textContent = show ? '⚠️ Phiếu đã đến hạn đánh giá lại. Vui lòng thực hiện đánh giá lần 2.' : '';
    banner.classList.toggle('hidden', !show);
  }

  function correctionRowLocked(ticket, row) {
    if (!ticket || ticket.status !== 'Đang xử lý') return true;
    return !!ticket.scoringLocked || !!(row && Number(row.correction_locked || 0));
  }

  function nonconformityQuestionKey(row) {
    return String(row?.question_item_id || row?.evaluation_answer_id || row?.question_id
      || row?.db_id || row?.questionId || row?.question_code || row?.clause_code || row?.id || '').trim();
  }

  function draftCorrectiveRequirementKey(ticket, row) {
    const questionKey = nonconformityQuestionKey(row);
    if (!ticket || !questionKey) return '';
    const roundNo = ticket.current_round_no || ticket.completed_round || 1;
    return `${ticket.code}:${roundNo}:${questionKey}`;
  }

  function draftCorrectiveRequirementStore() {
    state.scoringDraftCorrectiveRequirements = state.scoringDraftCorrectiveRequirements || {};
    return state.scoringDraftCorrectiveRequirements;
  }

  function draftCorrectiveRequirement(ticket, row) {
    const key = draftCorrectiveRequirementKey(ticket, row);
    return key ? (draftCorrectiveRequirementStore()[key] || {}) : {};
  }

  function evaluationDateForNonconformities(ticket) {
    const roundNo = Number(ticket?.current_round_no || ticket?.completed_round || 1);
  if (roundNo !== 1) return '';

  return ticket?.actual_evaluation_date_iso || '';
  }

  function defaultCorrectionDueDateForTicket(ticket) {
    const roundNo = Number(ticket?.current_round_no || ticket?.completed_round || 1);
    if (!ticket || roundNo !== 1) return '';
    const evaluationDate = evaluationDateForNonconformities(ticket);
    if (!evaluationDate) return '';

    return addCalendarDaysISODate(evaluationDate, 7);
  }

  function currentRoundNonconformityRows(ticket, calculatedRows) {
    if (!ticket) return [];
    const roundNo = Number(ticket.current_round_no || ticket.completed_round || 1);
    const savedRows = (ticket.nonconformities || []).filter((row) => {
      const rowRound = Number(row && row.round_no);
      return (!rowRound || rowRound === roundNo) && ['B', 'C', 'D'].includes(row.severity || row.score);
    });
    if (!Array.isArray(calculatedRows)) return savedRows;
    const savedByQuestion = new Map(savedRows.map((row) => [nonconformityQuestionKey(row), row]));
    return calculatedRows
      .filter((row) => ['B', 'C', 'D'].includes(row && (row.score || row.severity)))
      .map((row) => {
        const saved = savedByQuestion.get(nonconformityQuestionKey(row));
        const score = row.score || row.severity;
        if (!saved) return row;
        return {
          ...row,
          ...saved,
          category: row.category || row.section || saved.category || saved.section || '',
          section: row.section || row.category || saved.section || saved.category || '',
          clause_code: row.clause_code || row.question_code || saved.clause_code || saved.question_code || '',
          question_code: row.question_code || row.clause_code || saved.question_code || saved.clause_code || '',
          severity: score,
          score,
          note: row.note || '',
          nonconformity_content: row.note || row.nonconformity_content || row.nonconformity || '',
          nonconformity: row.note || row.nonconformity_content || row.nonconformity || '',
        };
      });
  }

  function nonconformityDisplayRow(row, ticket) {
    const persisted = !!(row && row.id && row.evaluation_answer_id);
    const draftKey = persisted ? '' : draftCorrectiveRequirementKey(ticket, row);
    const draft = draftKey ? (draftCorrectiveRequirementStore()[draftKey] || {}) : {};
    const hasDraftDueDate = Object.prototype.hasOwnProperty.call(draft, 'due_date');
    const hasDraftRequirementId = Object.prototype.hasOwnProperty.call(draft, 'corrective_requirement_id');
    const savedDueDate = row?.due_date || (hasDraftDueDate ? draft.due_date : '');
    const defaultDueDate = !hasDraftDueDate && !savedDueDate
      ? defaultCorrectionDueDateForTicket(ticket)
      : '';
    return {
      ...row,
      nonconformity_content: row?.nonconformity_content || row?.nonconformity || row?.note || '',
      remediation_content: row?.remediation_content || row?.remediation || draft.remediation || '',
      nonconformity: row?.nonconformity_content || row?.nonconformity || row?.note || '',
      remediation: row?.remediation_content || row?.remediation || draft.remediation || '',
      corrective_requirement_id: hasDraftRequirementId
        ? draft.corrective_requirement_id
        : (row?.corrective_requirement_id || null),
      due_date: savedDueDate || defaultDueDate,
      _due_date_is_default: !!defaultDueDate,
      _validation_id: persisted ? String(row.id) : draftKey,
      _draft_key: draftKey,
    };
  }

  function saveDraftNonconformityRequirementInput(input) {
    if (!input) return;
    const isRemediation = input.hasAttribute('data-nc-draft-remediation');
    const key = input.getAttribute(isRemediation ? 'data-nc-draft-remediation' : 'data-nc-draft-due-date');
    if (!key) return;
    const store = draftCorrectiveRequirementStore();
    store[key] = store[key] || {};
    if (!isRemediation
      && input.hasAttribute('data-nc-default-due-date')
      && input.getAttribute('data-nc-due-date-dirty') !== 'true') return;
    if (isRemediation) {
      const selected = input.getAttribute('data-corrective-requirement-selected') === 'true';
      store[key].remediation = selected ? displayCorrectiveRequirementName(input.value) : '';
      store[key].corrective_requirement_id = selected
        ? (Number(input.getAttribute('data-corrective-requirement-id')) || null)
        : null;
      return;
    }
    store[key].due_date = input.value || '';
  }

  function saveDraftNonconformityRequirementInputs() {
    Array.from(document.querySelectorAll('[data-nc-draft-remediation], [data-nc-draft-due-date]'))
      .forEach(saveDraftNonconformityRequirementInput);
  }

  function missingDraftCorrectiveRequirements(ticket, rows) {
    return (rows || [])
      .map((row) => nonconformityDisplayRow(row, ticket))
      .filter((row) => !String(row.remediation || '').trim() || !String(row.due_date || '').trim());
  }

  function renderNonconformityErrorState(message) {
    const tbody = $('nonconformity-tbody');
    if (!tbody) return;
    tbody.textContent = '';
    const tr = el('tr');
    tr.appendChild(el('td', {
      className: 'muted',
      attrs: { colspan: '7' },
      text: message || 'Không thể hiển thị bảng điểm không phù hợp. Vui lòng tải lại trang.',
    }));
    tbody.appendChild(tr);
    if ($('nonconformity-count')) $('nonconformity-count').textContent = 'Không xác định';
    if ($('nonconformity-empty')) $('nonconformity-empty').classList.toggle('hidden', true);
  }

  function handleScoringRenderError(error) {
    console.error('[scoring.render_failed]', error);
    if ($('scoring-msg')) $('scoring-msg').textContent = 'Không thể hiển thị dữ liệu chấm điểm. Vui lòng tải lại trang.';
    renderNonconformityErrorState();
  }

  function renderNonconformities(rows, ticket) {
    const tbody = $('nonconformity-tbody');
    if (!tbody) return;
    tbody.textContent = '';
    rows.forEach((rawRow) => {
      const r = nonconformityDisplayRow(rawRow, ticket);
      const validationId = r._validation_id || String(r.id || '');
      const rowIssue = scoringValidationTarget && issueMatchesNonconformity(scoringValidationTarget, r)
        ? scoringValidationTarget
        : null;
      const tr = el('tr', {
        className: rowIssue ? 'validation-row' : '',
        attrs: validationId ? { 'data-nc-row': validationId } : {},
      });
      tr.appendChild(labeledTd('Hạng mục', { className: 'label', text: r.category || r.section || '' }));
      tr.appendChild(labeledTd('Điều khoản', { text: r.clause_code || r.question_code || r.question || '' }));
      tr.appendChild(labeledTd('Điểm', { className: 'mono', text: r.severity || r.score || '' }));
      tr.appendChild(labeledTd('Mô tả', { className: 'muted', text: r.nonconformity || r.note || '-' }));
      const lockedCorrection = r._draft_key ? !!(ticket && ticket.scoringLocked) : correctionRowLocked(ticket, r);
      const canEditNc = resourceCan(ticket, 'score') && !lockedCorrection && (!!r.id || !!r._draft_key);
      const remediationTd = labeledTd('Yêu cầu');
      if (canEditNc) {
        const inputAttrs = r._draft_key
          ? { 'data-nc-remediation': validationId, 'data-nc-draft-remediation': r._draft_key }
          : { 'data-nc-remediation': validationId };
        inputAttrs.role = 'combobox';
        inputAttrs.type = 'search';
        inputAttrs.placeholder = 'Chọn yêu cầu khắc phục...';
        inputAttrs.autocomplete = 'off';
        inputAttrs.maxlength = '120';
        inputAttrs['aria-autocomplete'] = 'list';
        inputAttrs['aria-haspopup'] = 'listbox';
        inputAttrs['aria-controls'] = 'corrective-requirement-options';
        inputAttrs['aria-expanded'] = 'false';
        inputAttrs['data-corrective-requirement-combobox'] = 'true';
        inputAttrs['data-corrective-requirement-selected'] = r.remediation ? 'true' : 'false';
        if (r.corrective_requirement_id) inputAttrs['data-corrective-requirement-id'] = r.corrective_requirement_id;
        const wrapper = el('div', { className: 'corrective-requirement-combobox' });
        const input = el('input', {
          className: 'input corrective-requirement-input' + (issueMatchesNonconformity(scoringValidationTarget, r, 'remediation') ? ' invalid' : ''),
          attrs: inputAttrs,
        });
        input.value = r.remediation || '';
        wrapper.appendChild(input);
        wrapper.appendChild(el('button', {
          className: 'corrective-requirement-toggle',
          text: '▾',
          attrs: {
            type: 'button',
            'aria-label': 'Mở danh mục yêu cầu khắc phục',
            'data-corrective-requirement-toggle': 'true',
          },
        }));
        remediationTd.appendChild(wrapper);
        if (issueMatchesNonconformity(scoringValidationTarget, r, 'remediation')) remediationTd.appendChild(el('span', { className: 'field-error validation-inline', text: rowIssue.message }));
      } else {
        remediationTd.appendChild(el('span', { className: 'muted', text: r.remediation || (r.id ? '-' : 'Lưu tạm để nhập yêu cầu') }));
      }
      tr.appendChild(remediationTd);
      const dueTd = labeledTd('Thời hạn');
      if (canEditNc) {
        const dueAttrs = r._draft_key
          ? { type: 'date', 'data-nc-due-date': validationId, 'data-nc-draft-due-date': r._draft_key }
          : { type: 'date', 'data-nc-due-date': validationId };
        const minimumDueDate = evaluationDateForNonconformities(ticket);
        if (minimumDueDate) dueAttrs.min = minimumDueDate;
        if (r._due_date_is_default) {
          dueAttrs['data-nc-default-due-date'] = r.due_date;
          dueAttrs['data-nc-due-date-dirty'] = 'false';
        }
        const input = el('input', {
          className: 'input' + (issueMatchesNonconformity(scoringValidationTarget, r, 'due_date') ? ' invalid' : ''),
          attrs: dueAttrs,
        });
        input.value = dateInputValue(r.due_date);
        dueTd.appendChild(input);
        if (issueMatchesNonconformity(scoringValidationTarget, r, 'due_date')) dueTd.appendChild(el('span', { className: 'field-error validation-inline', text: rowIssue.message }));
      } else {
        dueTd.appendChild(el('span', { className: 'mono muted', text: r.due_date || '-' }));
      }
      tr.appendChild(dueTd);
      const statusTd = labeledTd('Trạng thái');
      statusTd.appendChild(el('span', { className: 'mono muted', text: r.status || (r.id ? 'OPEN' : 'DRAFT') }));
      if (lockedCorrection && r.id) {
        statusTd.appendChild(document.createElement('br'));
        statusTd.appendChild(el('span', { className: 'tag sev-gray', text: 'Đã khóa' }));
      }
      tr.appendChild(statusTd);
      tbody.appendChild(tr);
    });
    $('nonconformity-count').textContent = rows.length + ' điều khoản';
    $('nonconformity-empty').classList.toggle('hidden', rows.length > 0);
  }

  function missingCorrectiveRequirements(ticket) {
    const rows = (ticket && ticket.nonconformities) || [];
    return rows.map((row) => nonconformityDisplayRow(row, ticket)).filter((row) => ['B', 'C', 'D'].includes(row.severity || row.score) && (!String(row.remediation || '').trim() || !String(row.due_date || '').trim()));
  }

  async function updateNonconformityRequirement(ticket, row, fields) {
    if (!ticket || !row || !row.id) return null;
    const body = {
      remediation: Object.prototype.hasOwnProperty.call(fields || {}, 'remediation') ? fields.remediation : row.remediation,
      corrective_requirement_id: Object.prototype.hasOwnProperty.call(fields || {}, 'corrective_requirement_id')
        ? fields.corrective_requirement_id
        : (row.corrective_requirement_id || null),
      due_date: Object.prototype.hasOwnProperty.call(fields || {}, 'due_date') ? fields.due_date : row.due_date,
      status: row.status || 'OPEN',
    };
    const r = await api('/evaluations/' + encodeURIComponent(ticket.code) + '/nonconformities/' + encodeURIComponent(row.id), { method: 'PUT', body });
    if (!r.ok) throw new Error((r.data && r.data.error) || 'nonconformity_update_failed');
    Object.assign(row, r.data.item || {});
    if (r.data && r.data.ticket) {
      const updated = mapTicketFromApi(r.data.ticket);
      Object.assign(ticket, updated, { nonconformities: ticket.nonconformities || [] });
      const index = demoEvaluations.findIndex((item) => item.code === updated.code);
      if (index >= 0) Object.assign(demoEvaluations[index], updated, { nonconformities: ticket.nonconformities || [] });
    }
    return r.data.item || row;
  }

  async function applyDraftNonconformityRequirements(ticket) {
    if (!ticket) return;
    const store = draftCorrectiveRequirementStore();
    const rows = (ticket.nonconformities || []).filter((row) => row.id && row.evaluation_answer_id && nonconformityQuestionKey(row));
    for (const row of rows) {
      const key = draftCorrectiveRequirementKey(ticket, row);
      const draft = key ? store[key] : null;
      if (!draft) continue;
      const hasRemediation = Object.prototype.hasOwnProperty.call(draft, 'remediation');
      const hasRequirementId = Object.prototype.hasOwnProperty.call(draft, 'corrective_requirement_id');
      const hasDueDate = Object.prototype.hasOwnProperty.call(draft, 'due_date');
      if (!hasRemediation && !hasRequirementId && !hasDueDate) continue;
      const next = {
        remediation: hasRemediation ? draft.remediation : row.remediation,
        corrective_requirement_id: hasRequirementId ? draft.corrective_requirement_id : row.corrective_requirement_id,
        due_date: hasDueDate ? draft.due_date : row.due_date,
      };
      if (String(next.remediation || '') !== String(row.remediation || '')
        || String(next.corrective_requirement_id || '') !== String(row.corrective_requirement_id || '')
        || String(next.due_date || '') !== String(row.due_date || '')) {
        await updateNonconformityRequirement(ticket, row, next);
      }
      delete store[key];
    }
  }

  async function saveNonconformityRequirement(input) {
    const ticket = selectedTicket();
    if (!ticket || !input) return;
    const id = input.getAttribute('data-nc-remediation') || input.getAttribute('data-nc-due-date');
    if (!id) return;
    const row = (ticket.nonconformities || []).find((item) => String(item.id) === String(id));
    if (!row) return;
    await updateNonconformityRequirement(ticket, row, {
      remediation: input.hasAttribute('data-nc-remediation') ? input.value : row.remediation,
      corrective_requirement_id: input.hasAttribute('data-nc-remediation')
        ? (Number(input.getAttribute('data-corrective-requirement-id')) || null)
        : row.corrective_requirement_id,
      due_date: input.hasAttribute('data-nc-due-date') ? input.value : row.due_date,
    });
  }

  function renderApprovals() {
    const tbody = $('approval-tbody');
    if (!tbody) return;
    if (state.workflowLoading || state.workflowError) {
      tbody.textContent = '';
      const message = state.workflowLoading ? 'Đang tải hàng chờ phê duyệt...' : state.workflowError;
      setText('approval-count', state.workflowLoading ? 'Đang tải' : '0 phiếu');
      const tr = el('tr');
      tr.appendChild(el('td', { className: 'muted', attrs: { colspan: '7' }, text: message }));
      tbody.appendChild(tr);
      appendMobileState(ensureMobileList('approval-mobile-list', tbody.closest('table')), message);
      $('approval-empty').classList.add('hidden');
      return;
    }
    const q = (state.approvalSearch || '').toLowerCase();
    const assessmentRows = demoEvaluations
      .filter(canSeeApprovalRecord)
      .map(mapAssessmentApprovalRecord);
    const rows = assessmentRows
      .filter((r) => !q || [r.code, r.supplier_name, r.supplier_code].some((v) => String(v).toLowerCase().includes(q)))
      .filter((r) => !state.approvalRole || r.role === state.approvalRole);
    setText('approval-count', rows.length + ' phiếu');
    tbody.textContent = '';
    rows.forEach((r) => {
      const tr = el('tr');
      tr.appendChild(labeledTd('Mã phiếu', { className: 'mono label', text: r.code }));
      tr.appendChild(labeledTd('Loại phiếu', { text: r.approvalTypeLabel }));
      tr.appendChild(labeledTd('NCC', { text: r.supplier_name }));
      tr.appendChild(labeledTd('Vai trò', { text: r.role }));
      const td = labeledTd('Trạng thái'); td.appendChild(statusBadge(r.status)); tr.appendChild(td);
      tr.appendChild(labeledTd('Kết quả', { className: 'num', text: r.resultText || (r.result == null ? '—' : r.result.toFixed(1) + '%') }));
      const actionTd = labeledTd('Thao tác', { className: 'table-action-cell approval-actions-cell' });
      const descriptors = approvalActionDescriptors(r);
      const actions = RowActionGroup(descriptors);
      actions.classList.add('approval-action-icons');
      actionTd.appendChild(actions);
      tr.appendChild(actionTd);
      tbody.appendChild(tr);
    });
    updateEmptyStateAction('approval-empty', {
      filterText: rows.length === 0 ? filterSummary([state.approvalSearch && '"' + state.approvalSearch + '"', state.approvalRole]) : '',
      defaultTitle: 'Chưa có phiếu chờ phê duyệt',
      defaultBody: 'Khi phiếu được gửi duyệt, hàng chờ xử lý sẽ hiển thị tại đây.',
      defaultActionLabel: 'Xem danh sách phiếu',
      onDefaultAction: () => navigateToTab('evaluations'),
      onClear: () => $('approval-reset') && $('approval-reset').click(),
    });
    $('approval-empty').classList.toggle('hidden', rows.length > 0);
    renderApprovalMobileCards(rows);
    requestTableLabelHydration();
  }

  function renderReports() {
    const tbody = $('report-tbody');
    if (!tbody) return;
    if (state.workflowLoading || state.workflowError) {
      tbody.textContent = '';
      const message = state.workflowLoading ? 'Đang tải dữ liệu báo cáo...' : state.workflowError;
      const tr = el('tr');
      tr.appendChild(el('td', { className: 'muted', attrs: { colspan: '6' }, text: message }));
      tbody.appendChild(tr);
      appendMobileState(ensureMobileList('report-mobile-list', tbody.closest('table')), message);
      $('report-empty').classList.add('hidden');
      return;
    }
    const q = (state.reportSearch || '').toLowerCase();
    const rows = demoEvaluations.filter((r) => ownsWorkflowRecord(r) && (r.completed_round || 0) >= 1).flatMap((r) =>
      REPORT_TYPES
        .filter((type) => (r.completed_round || 0) >= type.minCompletedRound)
        .map((type) => ({ ...r, reportType: type.label, reportTypeCode: type.code, reportRoundNo: type.roundNo, reportNote: type.note }))
    ).filter((r) => !q || [r.code, r.supplier_name].some((v) => String(v).toLowerCase().includes(q)))
      .filter((r) => !state.reportType || r.reportTypeCode === state.reportType || r.reportType === state.reportType);
    tbody.textContent = '';
    rows.forEach((r) => {
      const tr = el('tr');
      tr.appendChild(labeledTd('Mã phiếu', { className: 'mono label', text: r.code }));
      tr.appendChild(labeledTd('NCC', { text: r.supplier_name }));
      tr.appendChild(labeledTd('Loại báo cáo', { text: r.reportType }));
      const td = labeledTd('Trạng thái'); td.appendChild(statusBadge('Hoàn thành')); tr.appendChild(td);
      tr.appendChild(labeledTd('Ghi chú', { className: 'muted', text: r.reportNote }));
      const actionTd = labeledTd('Thao tác', { className: 'table-action-cell' });
      actionTd.appendChild(RowActionGroup(reportActionDescriptors(r)));
      tr.appendChild(actionTd);
      tbody.appendChild(tr);
    });
    updateEmptyStateAction('report-empty', {
      filterText: rows.length === 0 ? filterSummary([state.reportSearch && '"' + state.reportSearch + '"', state.reportType && reportTypeText(state.reportType)]) : '',
      defaultTitle: 'Chưa có báo cáo phù hợp',
      defaultBody: 'Báo cáo sẽ được xuất từ kết quả phiếu khi luồng nghiệp vụ hoàn tất.',
      defaultActionLabel: 'Xem phiếu đánh giá',
      onDefaultAction: () => navigateToTab('evaluations'),
      onClear: () => $('report-reset') && $('report-reset').click(),
    });
    $('report-empty').classList.toggle('hidden', rows.length > 0);
    renderReportMobileCards(rows);
    requestTableLabelHydration();
  }

  async function exportReportFormat(code, reportTypeCode, roundNo, format) {
    const endpoint = format === 'excel' ? 'export-excel' : format === 'print' ? 'export-print' : 'export-pdf';
    const extension = format === 'excel' ? 'xlsx' : format === 'print' ? 'html' : 'pdf';
    const accept = format === 'excel'
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/json'
      : format === 'print'
        ? 'text/html, application/json'
        : 'application/pdf, application/json';
    const r = await requestExportDownload('/evaluations/' + encodeURIComponent(code) + '/reports/' + endpoint, {
      body: { report_type: reportTypeCode, round_no: roundNo },
      accept,
      fallbackFileName: code + '-report.' + extension,
      openInNewTab: format === 'print',
    });
    if (!r.ok) return showToast(UI_TEXT.reports.exportReportFailed, 'err');
    showToast('Đã tải báo cáo.', 'ok');
  }

  function evaluationSummaryExportFilters() {
    const filters = state.evalFilters || {};
    return {
      q: state.evalSearch || '',
      dateType: filters.dateType || 'created_at',
      type: filters.type || '',
      status: filters.status || state.evalStatusTab || '',
      mch2: filters.mch2 || '',
      mch3: filters.mch3 || '',
      from: filters.from || '',
      to: filters.to || '',
      reassessment: filters.reassessment || '',
    };
  }

  function evaluationSummaryDefaultFileName() {
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    return `${day}.${month}_Báo cáo đánh giá NCC.xlsx`;
  }

  function fileNameFromDisposition(disposition) {
    const text = String(disposition || '');
    const encoded = text.match(/filename\*=UTF-8''([^;]+)/i);
    if (encoded) {
      try { return decodeURIComponent(encoded[1].trim()); } catch {}
    }
    const plain = text.match(/filename="?([^";]+)"?/i);
    return plain ? plain[1].trim() : '';
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function openBlobInNewTab(blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function requestExportDownload(pathUrl, options = {}) {
    try {
      const res = await fetch('/qlcl/api' + pathUrl, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          Accept: options.accept || 'application/octet-stream, application/json',
          'Content-Type': 'application/json',
          ...actionRequestHeaders(),
        },
        body: JSON.stringify(options.body || {}),
      });
      if (!res.ok) {
        let data = {};
        try { data = await res.json(); } catch {}
        return { ok: false, status: res.status, error: data && data.error };
      }
      const blob = await res.blob();
      const fileName = fileNameFromDisposition(res.headers.get('Content-Disposition'))
        || options.fallbackFileName
        || 'download';
      if (options.openInNewTab) openBlobInNewTab(blob);
      else downloadBlob(blob, fileName);
      return { ok: true, fileName, exportId: res.headers.get('X-Export-Id') || '' };
    } catch {
      return { ok: false, status: 0, error: 'network_error' };
    }
  }

  async function exportEvaluationSummary() {
    const btn = $('eval-export-excel');
    const finishButton = setButtonLoading(btn, 'Đang xuất Excel...');
    setMsg('eval-export-msg', 'Đang xuất Excel...');
    let exported = false;
    try {
      const res = await fetch('/qlcl/api/evaluations/export-summary', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/json',
          'Content-Type': 'application/json',
          ...actionRequestHeaders(),
        },
        body: JSON.stringify({
          filters: evaluationSummaryExportFilters(),
          sort: state.evalSort || {},
        }),
      });
      if (!res.ok) {
        let data = {};
        try { data = await res.json(); } catch {}
        const code = data && data.error;
        const message = code === 'no_matching_evaluations'
          ? 'Không có dữ liệu phù hợp với bộ lọc hiện tại.'
          : apiErrorMessage(code, 'Không xuất được báo cáo Excel.');
        setMsg('eval-export-msg', message, 'err');
        return;
      }
      const blob = await res.blob();
      const fileName = fileNameFromDisposition(res.headers.get('Content-Disposition')) || evaluationSummaryDefaultFileName();
      downloadBlob(blob, fileName);
      exported = true;
      setMsg('eval-export-msg', 'Đã tải file Excel.', 'ok');
    } catch {
      setMsg('eval-export-msg', 'Không xuất được báo cáo Excel.', 'err');
    } finally {
      finishButton(exported ? 'Đã xuất ✓' : '');
    }
  }

  function loadWorkflowTab() {
    if (state.tab === 'suppliers') return loadSuppliers();
    if (!state.workflowLoaded && !state.workflowLoading && !state.workflowError) {
      loadWorkflowData(false);
      return;
    }
    if (state.tab === 'evaluations') renderEvaluations();
    if (state.tab === 'scoring') renderScoring();
    if (state.tab === 'approvals') renderApprovals();
    if (state.tab === 'reports') renderReports();
  }

  // ============ Login flow ============
  let otpTimerId = null;

  function stopOtpTimer() {
    if (otpTimerId) window.clearInterval(otpTimerId);
    otpTimerId = null;
  }

  function resetOtpChallenge() {
    stopOtpTimer();
    state.sessionId = null;
    state.otpDeliveryMode = null;
    state.otpSecurityProfile = null;
    state.otpExpiresAt = null;
    state.otpRetryAt = null;
    state.screenOtpCode = null;
    $('otp').value = '';
    $('otp').disabled = false;
    $('btn-verify').disabled = false;
    $('screen-otp-code').textContent = '';
    $('screen-otp-callout').classList.add('hidden');
    $('screen-otp-dev-warning').classList.add('hidden');
    $('otp-countdown').textContent = '';
  }

  function updateOtpClock() {
    const now = Date.now();
    const remaining = Math.max(0, Math.ceil((Number(state.otpExpiresAt || 0) - now) / 1000));
    const cooldown = Math.max(0, Math.ceil((Number(state.otpRetryAt || 0) - now) / 1000));
    const minutes = String(Math.floor(remaining / 60)).padStart(2, '0');
    const seconds = String(remaining % 60).padStart(2, '0');
    $('otp-countdown').textContent = remaining > 0
      ? `Mã hết hạn sau ${minutes}:${seconds}`
      : 'Mã đã hết hạn. Vui lòng gửi lại mã mới.';
    $('otp').disabled = remaining <= 0;
    $('btn-verify').disabled = remaining <= 0;
    $('btn-resend-otp').disabled = cooldown > 0;
    $('btn-resend-otp').textContent = cooldown > 0 ? `Gửi lại sau ${cooldown}s` : 'Gửi lại mã';
    if (remaining <= 0 && state.screenOtpCode) {
      state.screenOtpCode = null;
      $('screen-otp-code').textContent = '';
      $('screen-otp-callout').classList.add('hidden');
      stopOtpTimer();
    }
  }

  function startOtpClock() {
    stopOtpTimer();
    updateOtpClock();
    otpTimerId = window.setInterval(updateOtpClock, 1000);
  }

  function applyOtpChallenge(data, email) {
    state.sessionId = data.sessionId;
    state.email = email;
    state.otpDeliveryMode = data.deliveryMode;
    state.otpSecurityProfile = data.securityProfile || 'guarded';
    state.otpExpiresAt = Date.parse(data.expiresAt);
    state.otpRetryAt = Date.now() + Math.max(0, Number(data.retryAfter || 0)) * 1000;
    state.screenOtpCode = data.deliveryMode === 'screen' ? String(data.screenCode || '') : null;
    $('otp').value = '';
    $('otp').disabled = false;
    $('btn-verify').disabled = false;
    $('screen-otp-code').textContent = state.screenOtpCode || '';
    $('screen-otp-callout').classList.toggle('hidden', !state.screenOtpCode);
    $('screen-otp-dev-warning').classList.toggle('hidden', state.otpSecurityProfile !== 'development_relaxed');
    $('otp-hint').textContent = data.deliveryMode === 'screen'
      ? `Nhập mã đăng nhập tạm cho ${email}. Mã không được tự điền.`
      : `Mã 6 chữ số đã gửi tới ${email}.`;
    setMsg('otp-msg', '');
    setView('otp');
    startOtpClock();
    window.setTimeout(() => $('otp').focus(), 50);
  }

  function otpRequestError(error) {
    if (error === 'too_many_requests') return 'Bạn đã yêu cầu quá nhiều lần. Vui lòng chờ trước khi gửi lại.';
    if (error === 'invalid_domain') return 'Email không thuộc domain @masangroup.com. Vui lòng dùng email công ty.';
    if (error === 'email_required') return 'Vui lòng nhập email.';
    if (error === 'otp_delivery_unavailable') return 'Kênh gửi mã hiện không khả dụng. Vui lòng liên hệ đội vận hành.';
    return 'Không thể gửi mã. Thử lại sau.';
  }

  $('form-login').addEventListener('submit', (e) => {
    e.preventDefault();
    const email = $('email').value.trim().toLowerCase();
    if (!email) return;
    const finishButton = setButtonLoading($('btn-send-otp'), 'Đang gửi mã...');
    setMsg('login-msg', 'Đang gửi mã…');
    api('/auth/request-otp', { method: 'POST', body: { email } }).then((r) => {
      finishButton(r.ok ? 'Đã gửi ✓' : '');
      if (r.ok) {
        state.sessionId = r.data.sessionId;
        state.email = email;
        applyOtpChallenge(r.data, email);
      } else {
        const err = r.data && r.data.error;
        setMsg('login-msg', otpRequestError(err), 'err');
      }
    });
  });

  $('btn-copy-screen-otp').addEventListener('click', async () => {
    if (!state.screenOtpCode) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(state.screenOtpCode);
      else {
        const input = document.createElement('textarea');
        input.value = state.screenOtpCode;
        input.setAttribute('readonly', '');
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        input.remove();
      }
      setMsg('otp-msg', 'Đã sao chép mã tạm.', 'ok');
    } catch {
      setMsg('otp-msg', 'Không sao chép được. Vui lòng nhập mã thủ công.', 'err');
    }
  });

  $('btn-resend-otp').addEventListener('click', () => {
    if ($('btn-resend-otp').disabled || !state.email) return;
    const finishButton = setButtonLoading($('btn-resend-otp'), 'Đang gửi lại...');
    api('/auth/request-otp', { method: 'POST', body: { email: state.email } }).then((r) => {
      finishButton(r.ok ? 'Đã gửi ✓' : '');
      if (r.ok) applyOtpChallenge(r.data, state.email);
      else setMsg('otp-msg', otpRequestError(r.data?.error), 'err');
    });
  });

  $('btn-back-login').addEventListener('click', () => {
    resetOtpChallenge();
    setView('login');
  });

  $('form-otp').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!state.otpExpiresAt || Date.now() >= state.otpExpiresAt) {
      updateOtpClock();
      return setMsg('otp-msg', 'Mã đã hết hạn. Vui lòng gửi lại mã mới.', 'err');
    }
    const code = $('otp').value.trim();
    if (!/^[0-9]{6}$/.test(code)) return setMsg('otp-msg', 'Mã phải là 6 chữ số.', 'err');
    const finishButton = setButtonLoading($('btn-verify'), 'Đang xác thực...');
    setMsg('otp-msg', 'Đang xác thực…');
    api('/auth/verify-otp', { method: 'POST', body: { sessionId: state.sessionId, code } }).then((r) => {
      finishButton(r.ok ? 'Đã xác thực ✓' : '');
      if (r.ok) {
        applySession(r.data);
        resetOtpChallenge();
        const resolution = resolveAuthorizedRoute();
        if (activateRouteResolution(resolution, { updateHash: false })) {
          loadMonths().then(() => loadTab());
        }
      } else {
        const err = r.data && r.data.error;
        let msg = 'Mã không đúng. Vui lòng thử lại.';
        if (err === 'expired') msg = 'Mã đã hết hạn. Gửi lại.';
        else if (err === 'too_many_attempts') msg = 'Bạn đã sai quá nhiều lần. Yêu cầu mã mới.';
        else if (err === 'too_many_requests') msg = 'Vui lòng chờ.';
        else if (err === 'account_disabled') msg = 'Tài khoản đã bị khóa. Liên hệ admin.';
        if (Number.isInteger(r.data?.attemptsLeft) && r.data.attemptsLeft > 0) {
          msg += ` Còn ${r.data.attemptsLeft} lần thử.`;
        }
        if (err === 'too_many_attempts') {
          $('otp').disabled = true;
          $('btn-verify').disabled = true;
        }
        setMsg('otp-msg', msg, 'err');
      }
    });
  });

  function applySession(d) {
    const previousAuthzVersion = state.authzVersion;
    state.email = d.email;
    state.userId = d.userId || d.user_id || null;
    state.authDeliveryMode = d.degradedAuth === true || d.authDeliveryMode === 'screen' ? 'screen' : 'email';
    state.authSecurityProfile = d.authSecurityProfile === 'development_relaxed' ? 'development_relaxed' : 'guarded';
    $('degraded-auth-banner').classList.toggle('hidden', state.authDeliveryMode !== 'screen');
    $('degraded-auth-dev-warning').classList.toggle('hidden', state.authSecurityProfile !== 'development_relaxed');
    state.displayName = d.displayName || d.name || '';
    state.isAdmin = !!d.isAdmin;
    state.role = d.role || (d.isAdmin ? 'Admin' : 'Chuyên viên');
    state.roleCodes = Array.isArray(d.role_codes) ? d.role_codes : [];
    state.capabilities = Array.isArray(d.capabilities) ? d.capabilities : [];
    state.authzVersion = Number(d.authz_version || 0);
    state.navigationVersion = Number(d.navigation_version || 0);
    state.actionVersion = Number(d.action_version || 0);
    $('user-email').textContent = d.email;
    // Avatar + tên hiển thị ở sidebar footer — lấy ký tự đầu local-part làm initial
    const local = (d.email || '?').split('@')[0];
    const av = $('user-avatar');
    if (av) av.textContent = (local[0] || '?').toUpperCase();
    const topAv = $('top-user-avatar');
    if (topAv) topAv.textContent = (local[0] || '?').toUpperCase();
    const nm = $('user-name');
    if (nm) nm.textContent = d.name || local;
    const roleNode = $('user-role');
    if (roleNode) roleNode.textContent = state.role;
    const topRole = $('top-user-role');
    if (topRole) topRole.textContent = state.role;
    Array.from(document.querySelectorAll('[data-admin-management]')).forEach((node) => node.classList.toggle('hidden', !canManageSystem()));
    Array.from(document.querySelectorAll('[data-audit-read]')).forEach((node) => node.classList.toggle('hidden', !canReadAudit()));
    Array.from(document.querySelectorAll('[data-audit-export]')).forEach((node) => node.classList.toggle('hidden', !canExportAudit()));
    Array.from(document.querySelectorAll('[data-specialist-action]')).forEach((node) => node.classList.toggle('hidden', !canEditWorkflow()));
    refreshStaticActionAvailability();
    renderNavigationSurfaces();
    loadNotifications();
    if (previousAuthzVersion && previousAuthzVersion !== state.authzVersion) {
      const resolution = resolveAuthorizedRoute();
      activateRouteResolution(resolution, { updateHash: false });
    }
  }

  $('btn-logout').addEventListener('click', async () => {
    const discard = await confirmAuthzRouteLeave('#logout');
    if (!discard) return;
    await api('/auth/logout', { method: 'POST' });
    resetOtpChallenge();
    Object.assign(state, { view: 'login', email: null, userId: null, isAdmin: false, role: 'Chuyên viên', roleCodes: [], capabilities: [], authDeliveryMode: 'email', authSecurityProfile: 'guarded' });
    state.notifications = [];
    state.notificationUnreadCount = 0;
    updateNotificationBadges();
    closeNotificationPanel();
    $('degraded-auth-banner').classList.add('hidden');
    $('degraded-auth-dev-warning').classList.add('hidden');
    $('email').value = '';
    setView('login');
  });

  // Route buttons are rendered after session capability resolution, so one
  // delegated handler serves desktop, mobile, module, admin and breadcrumbs.
  document.addEventListener('click', (event) => {
    const groupToggle = event.target.closest('[data-navigation-group-toggle]');
    if (groupToggle) {
      toggleNavigationGroup(groupToggle);
      return;
    }
    const moreTrigger = event.target.closest('[data-mobile-more]');
    if (moreTrigger) {
      openMobileMore();
      return;
    }
    const routeButtonNode = event.target.closest('[data-route-tab]');
    if (!routeButtonNode || routeButtonNode.disabled) return;
    navigateToTab(routeButtonNode.dataset.routeTab);
  });

  document.querySelectorAll('[data-action-id="notification.open"]').forEach((button) => {
    button.addEventListener('click', openNotificationPanel);
  });
  $('notification-close')?.addEventListener('click', closeNotificationPanel);
  bindRegisteredAction($('notification-mark-all'), 'notification.mark_all', markAllNotificationsRead, { announceSuccess: false });
  $('notification-panel')?.addEventListener('click', (event) => {
    if (event.target === $('notification-panel')) closeNotificationPanel();
  });
  document.querySelectorAll('[data-notification-filter]').forEach((button) => {
    button.addEventListener('click', () => loadNotifications(button.dataset.notificationFilter));
  });

  if ($('mobile-more-close')) $('mobile-more-close').addEventListener('click', closeMobileMore);
  if ($('route-denied-back')) $('route-denied-back').addEventListener('click', () => navigateToTab('overview'));
  if ($('mobile-more-sheet')) $('mobile-more-sheet').addEventListener('click', (event) => {
    if (event.target === $('mobile-more-sheet')) closeMobileMore();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeMobileMore();
    closeMobileFilters();
    closeNotificationPanel();
  });
  window.addEventListener('resize', debounce(() => {
    updateMobileChrome(state.view);
    syncActiveNav();
    if (state.view !== 'dashboard') return;
    if (state.tab === 'evaluations') renderEvaluations();
    if (state.tab === 'approvals') renderApprovals();
    if (state.tab === 'reports') renderReports();
    if (state.tab === 'suppliers') renderSuppliers();
  }, 160));

  // ============ BRD workflow shell interactions ============
  function refreshMch3Options(reset) {
    renderMch3Options($('new-mch2'), $('new-mch3'), 'Chọn MCH3', { reset });
  }

  function refreshEvalMch3Filter(reset) {
    renderMch3Options($('eval-mch2-filter'), $('eval-mch3-filter'), 'MCH3', { reset });
  }

  function refreshFacilityOptions() {
    const sel = $('new-facility-type');
    if (!sel) return;
    const selected = sel.value;
    const values = variantsForTemplate($('new-template').value);
    sel.textContent = '';
    sel.appendChild(el('option', { attrs: { value: '' }, text: values.length ? 'Chọn loại cơ sở' : 'Chọn biểu mẫu trước' }));
    values.forEach((v) => sel.appendChild(el('option', { attrs: { value: v.facility_type }, text: v.facility_label || v.facility_type })));
    if (selected && values.some((v) => v.facility_type === selected)) sel.value = selected;
  }

  const EVALUATION_HISTORY_DEFAULT_FIELDS = ['template', 'facility_type', 'supplier_scale'];

  function supportsPreviousEvaluationDefaults(value) {
    const normalized = String(value || '')
      .replace(/[đĐ]/g, 'd')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    return ['danh gia dinh ky', 'dinh ky', 'danh gia dot xuat', 'dot xuat'].includes(normalized);
  }

  function resetEvaluationHistoryDefaults() {
    const tracker = state.evaluationHistoryDefaults;
    tracker.requestId += 1;
    tracker.supplierId = null;
    EVALUATION_HISTORY_DEFAULT_FIELDS.forEach((fieldName) => {
      tracker.fieldSources[fieldName] = '';
    });
  }

  function clearAutoEvaluationHistoryFields() {
    const form = $('evaluation-form');
    const tracker = state.evaluationHistoryDefaults;
    if (!form || !tracker) return;
    const shouldRefreshFacility = tracker.fieldSources.template === 'auto';
    EVALUATION_HISTORY_DEFAULT_FIELDS.forEach((fieldName) => {
      if (tracker.fieldSources[fieldName] !== 'auto') return;
      form.elements[fieldName].value = '';
      tracker.fieldSources[fieldName] = '';
    });
    if (shouldRefreshFacility) refreshFacilityOptions();
  }

  function prepareEvaluationHistoryDefaultsForSupplier(supplierId) {
    const tracker = state.evaluationHistoryDefaults;
    const normalizedSupplierId = Number(supplierId) || null;
    if (tracker.supplierId === normalizedSupplierId) return;
    tracker.requestId += 1;
    clearAutoEvaluationHistoryFields();
    tracker.supplierId = normalizedSupplierId;
  }

  function markEvaluationHistoryFieldManual(fieldName) {
    if (!EVALUATION_HISTORY_DEFAULT_FIELDS.includes(fieldName)) return;
    state.evaluationHistoryDefaults.fieldSources[fieldName] = 'manual';
  }

  function applyPreviousEvaluationDefaults(item) {
    const form = $('evaluation-form');
    const tracker = state.evaluationHistoryDefaults;
    if (!form || !item) return;
    const setAutoValue = (fieldName, value) => {
      if (!String(value || '').trim() || tracker.fieldSources[fieldName] === 'manual') return false;
      form.elements[fieldName].value = value;
      tracker.fieldSources[fieldName] = 'auto';
      return true;
    };

    const facilityWasManuallyEdited = tracker.fieldSources.facility_type === 'manual';
    const templateApplied = !facilityWasManuallyEdited && setAutoValue('template', item.template_code);
    if (templateApplied) refreshFacilityOptions();
    const facility = form.elements.facility_type;
    const facilityAvailable = Array.from(facility.options).some((option) => option.value === item.facility_type);
    if (facilityAvailable) setAutoValue('facility_type', item.facility_type);
    setAutoValue('supplier_scale', item.supplier_scale);
  }

  async function loadPreviousEvaluationDefaults() {
    if (state.editingTicketCode) return;
    const supplierId = Number(state.selectedSupplierId);
    prepareEvaluationHistoryDefaultsForSupplier(supplierId);
    const evaluationType = String(($('new-eval-type') && $('new-eval-type').value) || '');
    if (!Number.isSafeInteger(supplierId) || supplierId <= 0 || !supportsPreviousEvaluationDefaults(evaluationType)) {
      state.evaluationHistoryDefaults.requestId += 1;
      if (!supportsPreviousEvaluationDefaults(evaluationType)) clearAutoEvaluationHistoryFields();
      return;
    }

    const requestId = ++state.evaluationHistoryDefaults.requestId;
    const params = new URLSearchParams({
      supplier_id: String(supplierId),
      evaluation_type: evaluationType,
    });
    const response = await api('/evaluations/previous-defaults?' + params.toString());
    if (requestId !== state.evaluationHistoryDefaults.requestId) return;
    if (supplierId !== Number(state.selectedSupplierId)) return;
    if (!supportsPreviousEvaluationDefaults(($('new-eval-type') && $('new-eval-type').value) || '')) return;
    if (!response.ok || !response.data || !response.data.item) return;
    applyPreviousEvaluationDefaults(response.data.item);
    setMsg('evaluation-form-msg', 'Đã điền thông tin từ lần đánh giá gần nhất.', 'ok');
  }

  function updateAdHocReasonVisibility() {
    const wrap = $('ad-hoc-reason-field');
    if (!wrap) return;
    const on = $('new-eval-type').value === 'Đánh giá đột xuất';
    wrap.classList.toggle('hidden', !on);
    $('new-ad-hoc-reason').required = on;
    if (!on) $('new-ad-hoc-reason').value = '';
  }

  function validateEvaluationForm(form) {
    clearFieldErrors(form);
    const required = [
      ['evaluation_type', 'Vui lòng chọn loại hình đánh giá.'],
      ['supplier_name', 'Vui lòng nhập tên NCC.'],
      ['supplier_code', 'Vui lòng nhập mã NCC.'],
      ['tax_code', 'Vui lòng nhập mã số thuế.'],
      ['address', 'Vui lòng nhập địa chỉ NCC.'],
      ['region', 'Vui lòng chọn khu vực.'],
      ['province', 'Vui lòng chọn tỉnh.'],
      ['business_type', 'Vui lòng chọn loại hình kinh doanh.'],
      ['cmc_owner', 'Vui lòng nhập CMC phụ trách.'],
      ['cmc_head', 'Vui lòng nhập CMC trưởng phòng.'],
      ['contact_name', 'Vui lòng nhập người liên hệ NCC.'],
      ['phone', 'Vui lòng nhập SĐT.'],
      ['email', 'Vui lòng nhập email.'],
      ['mch2', 'Vui lòng chọn MCH2.'],
      ['mch3', 'Vui lòng chọn MCH3.'],
      ['products', 'Vui lòng nhập sản phẩm dự kiến đánh giá.'],
      ['template', 'Vui lòng chọn biểu mẫu đánh giá.'],
      ['facility_type', 'Vui lòng chọn loại cơ sở.'],
      ['supplier_scale', 'Vui lòng chọn quy mô NCC.'],
      ['planned_date', 'Vui lòng nhập ngày đánh giá dự kiến.'],
    ];
    const errors = {};
    required.forEach(([name, msg]) => {
      if (!String(form.elements[name].value || '').trim()) errors[name] = msg;
    });
    if (form.elements.evaluation_type.value === 'Đánh giá đột xuất' && !String(form.elements.ad_hoc_reason.value || '').trim()) {
      errors.ad_hoc_reason = 'Vui lòng nhập lý do đánh giá đột xuất.';
    }
    if (form.elements.email.value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.elements.email.value.trim())) {
      errors.email = 'Email không hợp lệ.';
    }
    if (form.elements.phone.value && !/^[0-9+\-\s.]{8,20}$/.test(form.elements.phone.value.trim())) {
      errors.phone = 'SĐT không hợp lệ.';
    }
    if (form.elements.planned_date.value && !isValidISODate(form.elements.planned_date.value.trim())) {
      errors.planned_date = 'Ngày không hợp lệ.';
    }
    if (form.elements.region.value && !isValidRegionValue(form.elements.region.value)) {
      errors.region = 'Khu vực không hợp lệ.';
    }
    if (form.elements.province.value && !isValidProvinceValue(form.elements.region.value, form.elements.province.value)) {
      errors.province = 'Tỉnh không thuộc khu vực đã chọn.';
    }
    if (form.elements.business_type.value && !isValidBusinessTypeValue(form.elements.business_type.value)) {
      errors.business_type = 'Loại hình kinh doanh không hợp lệ.';
    }
    const evaluationAddress = form.elements.snapshot_evaluation_address.value.trim();
    const linkedName = form.elements.snapshot_linked_facility_name.value.trim();
    const linkedAddress = form.elements.snapshot_linked_facility_address.value.trim();
    if (!evaluationAddress && !linkedAddress) {
      errors.snapshot_evaluation_address = 'Phải nhập ít nhất một địa chỉ đánh giá.';
      errors.snapshot_linked_facility_address = 'Phải nhập ít nhất một địa chỉ đánh giá.';
    }
    if (Boolean(linkedName) !== Boolean(linkedAddress)) {
      errors.snapshot_linked_facility_name = 'Tên và địa chỉ đơn vị liên kết phải đi theo cặp.';
      errors.snapshot_linked_facility_address = 'Tên và địa chỉ đơn vị liên kết phải đi theo cặp.';
    }
    if (form.elements.mch2.value && form.elements.mch3.value && !isValidMchPair(form.elements.mch2.value, form.elements.mch3.value)) {
      errors.mch3 = 'MCH3 không thuộc MCH2 đã chọn.';
    }
    Object.keys(errors).forEach((name) => setFieldError(form, name, errors[name]));
    return Object.keys(errors).length === 0;
  }

  function createTicketFromForm(form) {
    return {
      supplier_code: form.elements.supplier_code.value.trim().toUpperCase(),
      supplier_name: form.elements.supplier_name.value.trim(),
      supplier_id: state.selectedSupplierId || undefined,
      tax_code: form.elements.tax_code.value.trim(),
      address: form.elements.address.value.trim(),
      snapshot_evaluation_address: form.elements.snapshot_evaluation_address.value.trim(),
      snapshot_linked_facility_name: form.elements.snapshot_linked_facility_name.value.trim(),
      snapshot_linked_facility_address: form.elements.snapshot_linked_facility_address.value.trim(),
      region: form.elements.region.value.trim(),
      province: form.elements.province.value.trim(),
      business_type: form.elements.business_type.value.trim(),
      cmc_owner: form.elements.cmc_owner.value.trim(),
      cmc_head: form.elements.cmc_head.value.trim(),
      contact_name: form.elements.contact_name.value.trim(),
      contact_email: form.elements.email.value.trim(),
      contact_phone: form.elements.phone.value.trim(),
      email: form.elements.email.value.trim(),
      phone: form.elements.phone.value.trim(),
      evaluation_type: form.elements.evaluation_type.value,
      ad_hoc_reason: form.elements.ad_hoc_reason.value.trim(),
      mch2: form.elements.mch2.value,
      mch3: form.elements.mch3.value,
      template: form.elements.template.value,
      facility_type: form.elements.facility_type.value,
      supplier_scale: form.elements.supplier_scale.value,
      snapshot_product_name: form.elements.products.value.trim(),
      products: form.elements.products.value.trim(),
      planned_date: form.elements.planned_date.value.trim(),
      assignee: state.email ? state.email.split('@')[0] : 'Bạn',
    };
  }

  function selectedTicket() {
    return demoEvaluations.find((r) => r.code === state.scoringTicket) || null;
  }

  function questionsForTicket(ticket) {
    if (!ticket) return [];
    const roundNo = ticket.current_round_no || ticket.completed_round || 1;
    const roundQuestions = state.roundQuestions[roundStateKey(ticket.code, roundNo)];
    if (Array.isArray(roundQuestions)) {
      return roundQuestions.filter((question) => question.active !== false)
        .sort((a, b) => (a.order_index || 0) - (b.order_index || 0) || String(a.question_code).localeCompare(String(b.question_code)));
    }
    const templateCode = ticket.template_code || '';
    const facilityType = ticket.facility_type || '';
    const supplierScale = ticket.supplier_scale || '';
    return questionBank.filter((q) => {
      const templateOk = q.template_code === templateCode;
      const facilityOk = !!facilityType && q.facility_type === facilityType;
      const scaleOk = !!supplierScale && q.supplier_scale === supplierScale;
      return templateOk && facilityOk && scaleOk && q.active !== false;
    }).sort((a, b) => (a.order_index || 0) - (b.order_index || 0) || String(a.question_code).localeCompare(String(b.question_code)));
  }

  function fillEvaluationFormFromTicket(row) {
    const form = $('evaluation-form');
    if (!form || !row) return;
    resetEvaluationHistoryDefaults();
    state.selectedSupplierId = row.supplier_id || null;
    form.elements.evaluation_type.value = row.evaluation_type || '';
    form.elements.supplier_name.value = row.supplier_name || '';
    form.elements.supplier_code.value = row.supplier_code || '';
    form.elements.tax_code.value = row.tax_code || '';
    form.elements.address.value = row.address || '';
    form.elements.snapshot_evaluation_address.value = row.snapshot_evaluation_address || row.evaluation_address || '';
    form.elements.snapshot_linked_facility_name.value = row.snapshot_linked_facility_name || row.linked_facility_name || '';
    form.elements.snapshot_linked_facility_address.value = row.snapshot_linked_facility_address || row.linked_facility_address || '';
    setMasterDataControlValues('new', row.region, row.province, row.business_type);
    form.elements.cmc_owner.value = row.cmc_owner || '';
    form.elements.cmc_head.value = row.cmc_head || '';
    form.elements.contact_name.value = row.contact_name || '';
    form.elements.phone.value = row.contact_phone || '';
    form.elements.email.value = row.contact_email || '';
    form.elements.mch2.value = row.mch2 || '';
    refreshMch3Options();
    form.elements.mch3.value = row.mch3 || '';
    form.elements.products.value = row.product_name || row.product_group || '';
    form.elements.template.value = row.template_code || '';
    refreshFacilityOptions();
    form.elements.facility_type.value = row.facility_type || '';
    form.elements.supplier_scale.value = row.supplier_scale || '';
    form.elements.planned_date.value = row.planned_iso || dateInputValue(row.planned_at);
    resetNewSupplierSelect();
    updateAdHocReasonVisibility();
  }

  function applySupplierToEvaluationForm(supplier) {
    const form = $('evaluation-form');
    if (!form || !supplier) return;
    state.selectedSupplierId = supplier.id || null;
    form.elements.supplier_code.value = supplier.supplier_code || '';
    form.elements.supplier_name.value = supplier.supplier_name || '';
    form.elements.tax_code.value = supplier.tax_code || '';
    form.elements.address.value = supplier.address || '';
    form.elements.snapshot_evaluation_address.value = '';
    form.elements.snapshot_linked_facility_name.value = '';
    form.elements.snapshot_linked_facility_address.value = '';
    setMasterDataControlValues('new', supplier.region, supplier.province, supplier.business_type);
    form.elements.cmc_owner.value = '';
    form.elements.cmc_head.value = '';
    form.elements.contact_name.value = supplier.contact_name || '';
    form.elements.email.value = supplier.contact_email || '';
    form.elements.phone.value = supplier.contact_phone || '';
    form.elements.mch2.value = '';
    refreshMch3Options();
    form.elements.mch3.value = '';
    form.elements.products.value = '';
    setMsg('evaluation-form-msg', UI_TEXT.suppliers.importedFromDirectory, 'ok');
    loadPreviousEvaluationDefaults();
  }

  function supplierLookupLabel(supplier) {
    return [supplier.supplier_code, supplier.supplier_name, supplier.tax_code].filter(Boolean).join(' · ');
  }

  function selectedLookupSupplier(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    return state.supplierLookupItems.find((s) => String(s.id) === text || supplierLookupLabel(s) === text) || null;
  }

  function renderSupplierLookupOptions(items) {
    const options = $('new-supplier-options');
    if (!options) return;
    options.textContent = '';
    (items || []).forEach((s) => {
      options.appendChild(el('option', {
        attrs: { value: supplierLookupLabel(s), 'data-id': String(s.id) },
      }));
    });
  }

  async function searchSuppliersForTicket(q) {
    const input = $('new-supplier-select');
    const query = String(q ?? (input && input.value) ?? '').trim();
    if (!query) {
      state.supplierLookupItems = [];
      renderSupplierLookupOptions([]);
      state.selectedSupplierId = null;
      prepareEvaluationHistoryDefaultsForSupplier(null);
      return;
    }
    const r = await api('/suppliers?q=' + encodeURIComponent(query) + '&page_size=20&status=ACTIVE');
    if (query !== String((input && input.value) || '').trim()) return;
    state.supplierLookupItems = (r.ok && r.data.items) || [];
    renderSupplierLookupOptions(state.supplierLookupItems);
    const found = selectedLookupSupplier(input && input.value);
    if (found) applySupplierToEvaluationForm(found);
  }

  function scheduleSupplierLookup() {
    const input = $('new-supplier-select');
    const value = String((input && input.value) || '').trim();
    const found = selectedLookupSupplier(value);
    if (found) {
      applySupplierToEvaluationForm(found);
      return;
    }
    state.selectedSupplierId = null;
    prepareEvaluationHistoryDefaultsForSupplier(null);
    window.clearTimeout(supplierLookupTimer);
    supplierLookupTimer = window.setTimeout(() => searchSuppliersForTicket(value), 250);
  }

  function saveCurrentScoringInputs() {
    const ticket = selectedTicket();
    if (!ticket || !resourceCan(ticket, 'score') || ticket.scoringLocked) return;
    const answers = ensureAnswers(state.scoringTicket, questionsForTicket(ticket));
    Array.from(document.querySelectorAll('[data-score-value]')).forEach((sel) => {
      const id = sel.getAttribute('data-score-value');
      answers[id] = answers[id] || { score: '', note: '' };
      answers[id].score = sel.value;
    });
    Array.from(document.querySelectorAll('[data-note-id]')).forEach((input) => {
      const id = input.getAttribute('data-note-id');
      answers[id] = answers[id] || { score: '', note: '' };
      answers[id].note = input.value;
    });
    saveDraftNonconformityRequirementInputs();
    saveAttendeeInputs();
    saveSupplierIntroductionInput();
  }

  async function completeCurrentScoring() {
    const ticket = selectedTicket();
    if (!ticket) {
      showScoringValidationIssue({ type: 'ticket', message: 'Vui lòng chọn phiếu đánh giá trước khi hoàn thành.' });
      return;
    }
    saveCurrentScoringInputs();
    const roundNo = ticket.current_round_no || ticket.completed_round || 1;
    if (!attendeeRowsForTicket(ticket).length) {
      showScoringValidationIssue(participantValidationIssue());
      return;
    }
    if (!supplierIntroductionForTicket(ticket)) {
      showScoringValidationIssue(supplierIntroductionValidationIssue());
      return;
    }
    const ticketQuestions = questionsForTicket(ticket);
    if (ticketQuestions.length === 0) {
      showScoringValidationIssue({
        type: 'questions',
        message: 'Chưa có bộ câu hỏi đang hoạt động phù hợp với biểu mẫu / loại cơ sở / quy mô của phiếu.',
      });
      return;
    }
    const answers = ensureAnswers(ticket.code, ticketQuestions);
    const validationIssues = collectScoringValidationIssues(answers, ticketQuestions);
    if (validationIssues.length) {
      showScoringValidationIssue(validationIssues[0]);
      return;
    }
    const scoreResult = calculateScoring(answers, ticketQuestions);
    const hasCurrentRoundNonconformities = (ticket.nonconformities || []).some((row) => row.id && Number(row.round_no || roundNo) === Number(roundNo));
    if (roundNo !== 2 && scoreResult.nonconformities.length && !hasCurrentRoundNonconformities) {
      const missingDraftRequirements = missingDraftCorrectiveRequirements(ticket, scoreResult.nonconformities);
      if (missingDraftRequirements.length) {
        showScoringValidationIssue(correctiveValidationIssue(missingDraftRequirements[0]));
        return;
      }
    }
    if (scoreResult.nonconformities.length && !hasCurrentRoundNonconformities) {
      try {
        await persistAnswers(ticket.code);
      } catch {
        $('scoring-msg').textContent = 'Không lưu được câu trả lời để tạo danh sách khắc phục.';
        renderScoring();
        return;
      }
    }
    try {
      const missingRequirements = roundNo === 2 ? [] : missingCorrectiveRequirements(ticket);
      if (missingRequirements.length) {
        showScoringValidationIssue(correctiveValidationIssue(missingRequirements[0]));
        return;
      }
      const finalAction = roundNo === 2 ? 'COMPLETE' : 'WAITING_CORRECTION';
      const r = await api('/evaluations/' + encodeURIComponent(ticket.code) + '/rounds/' + roundNo + '/complete', {
        method: 'POST',
        body: {
          canonical_answers: answers,
          attendees: state.roundAttendees[roundStateKey(ticket.code, roundNo)] || [],
          supplier_introduction: ticket.supplier_introduction || '',
          final_action: finalAction,
        },
      });
      if (!r.ok) {
        if (r.data && r.data.error === 'attendees_required') {
          showScoringValidationIssue(participantValidationIssue());
          return;
        }
        if (r.data && r.data.error === 'supplier_introduction_required') {
          showScoringValidationIssue(supplierIntroductionValidationIssue());
          return;
        }
        if (r.data && r.data.error === 'missing_corrective_requirements') {
          ticket.nonconformities = r.data.items || ticket.nonconformities || [];
          showScoringValidationIssue(correctiveValidationIssue((r.data.items || [])[0] || {}));
          return;
        }
        throw new Error((r.data && r.data.error) || 'round_complete_failed');
      }
      clearScoringValidationIssue();
      answersByTicket[ticket.code] = r.data.canonical_answers || r.data.answers || answers;
      if (r.data.round) state.roundAttendees[roundStateKey(ticket.code, roundNo)] = normalizeAttendees(r.data.round.attendees || []);
      const updated = mapTicketFromApi(r.data.ticket);
      updated.scoringLocked = !!(r.data.round && r.data.round.locked);
      Object.assign(ticket, updated);
      ticket.nonconformities = r.data.nonconformities || ticket.nonconformities || [];
      $('scoring-msg').textContent = 'Đã hoàn thành đánh giá và khóa lần đánh giá.';
    } catch {
      $('scoring-msg').textContent = 'Không lưu được kết quả chấm điểm. Vui lòng thử lại.';
    }
    renderScoring();
  }

  async function submitCurrentTicketToLead() {
    const ticket = selectedTicket();
    if (!ticket) {
      showScoringValidationIssue({ type: 'ticket', message: 'Vui lòng chọn phiếu đánh giá trước khi gửi duyệt.' });
      return;
    }
    saveCurrentScoringInputs();
    try {
      if (!ticket.scoringLocked) {
        const ticketQuestions = questionsForTicket(ticket);
        const answers = ensureAnswers(ticket.code, ticketQuestions);
        if (ticketQuestions.length === 0) {
          showScoringValidationIssue({
            type: 'questions',
            message: 'Chưa có bộ câu hỏi đang hoạt động phù hợp với biểu mẫu / loại cơ sở / quy mô của phiếu.',
          });
          return;
        }
        if (!attendeeRowsForTicket(ticket).length) {
          showScoringValidationIssue(participantValidationIssue());
          return;
        }
        if (!supplierIntroductionForTicket(ticket)) {
          showScoringValidationIssue(supplierIntroductionValidationIssue());
          return;
        }
        const validationIssues = collectScoringValidationIssues(answers, ticketQuestions);
        if (validationIssues.length) {
          showScoringValidationIssue(validationIssues[0]);
          return;
        }
        const scoreResult = calculateScoring(answers, ticketQuestions);
        if (!leadSubmissionEligibility(answers, ticketQuestions, scoreResult).eligible) {
          showScoringValidationIssue(leadSubmissionValidationIssue());
          return;
        }
        const roundNo = ticket.current_round_no || ticket.completed_round || 1;
        const hasCurrentRoundNonconformities = (ticket.nonconformities || []).some((row) => row.id && Number(row.round_no || roundNo) === Number(roundNo));
        if (roundNo !== 2 && scoreResult.nonconformities.length && !hasCurrentRoundNonconformities) {
          const missingDraftRequirements = missingDraftCorrectiveRequirements(ticket, scoreResult.nonconformities);
          if (missingDraftRequirements.length) {
            showScoringValidationIssue(correctiveValidationIssue(missingDraftRequirements[0]));
            return;
          }
        }
        if (scoreResult.nonconformities.length && !hasCurrentRoundNonconformities) {
          await persistAnswers(ticket.code);
        }
        const missingRequirements = roundNo === 2 ? [] : missingCorrectiveRequirements(ticket);
        if (missingRequirements.length) {
          showScoringValidationIssue(correctiveValidationIssue(missingRequirements[0]));
          return;
        }
        const completeRes = await api('/evaluations/' + encodeURIComponent(ticket.code) + '/rounds/' + roundNo + '/complete', {
          method: 'POST',
          body: {
            answers,
            attendees: state.roundAttendees[roundStateKey(ticket.code, roundNo)] || [],
            supplier_introduction: ticket.supplier_introduction || '',
            final_action: 'SUBMIT_LEAD',
          },
        });
        if (!completeRes.ok) {
          if (completeRes.data && completeRes.data.error === 'attendees_required') {
            showScoringValidationIssue(participantValidationIssue());
            return;
          }
          if (completeRes.data && completeRes.data.error === 'supplier_introduction_required') {
            showScoringValidationIssue(supplierIntroductionValidationIssue());
            return;
          }
          if (completeRes.data && completeRes.data.error === 'missing_corrective_requirements') {
            ticket.nonconformities = completeRes.data.items || ticket.nonconformities || [];
            showScoringValidationIssue(correctiveValidationIssue((completeRes.data.items || [])[0] || {}));
            return;
          }
          if (completeRes.data && completeRes.data.error === 'lead_submission_not_eligible') {
            showScoringValidationIssue(leadSubmissionValidationIssue());
            return;
          }
          throw new Error('round_complete_failed');
        }
        answersByTicket[ticket.code] = completeRes.data.answers || answers;
        if (completeRes.data.round) state.roundAttendees[roundStateKey(ticket.code, roundNo)] = normalizeAttendees(completeRes.data.round.attendees || []);
        const updated = mapTicketFromApi(completeRes.data.ticket);
        updated.scoringLocked = !!(completeRes.data.round && completeRes.data.round.locked);
        Object.assign(ticket, updated);
        ticket.nonconformities = completeRes.data.nonconformities || ticket.nonconformities || [];
      } else {
        const ticketQuestions = questionsForTicket(ticket);
        const answers = answersByTicket[ticket.code];
        const complete = answers && ticketQuestions.length > 0 && ticketQuestions.every((q) => answerComplete(answers[q.id], q));
        if (complete) {
          const scoreResult = calculateScoring(answers, ticketQuestions);
          if (!leadSubmissionEligibility(answers, ticketQuestions, scoreResult).eligible) {
            showScoringValidationIssue(leadSubmissionValidationIssue());
            return;
          }
        }
      }
      const r = await api('/evaluations/' + encodeURIComponent(ticket.code) + '/submit-to-lead', { method: 'POST', body: { comment: '' } });
      if (!r.ok) {
        if (r.data && r.data.error === 'attendees_required') {
          showScoringValidationIssue(participantValidationIssue());
          return;
        }
        if (r.data && r.data.error === 'supplier_introduction_required') {
          showScoringValidationIssue(supplierIntroductionValidationIssue());
          return;
        }
        if (r.data && r.data.error === 'missing_corrective_requirements') {
          ticket.nonconformities = r.data.items || ticket.nonconformities || [];
          showScoringValidationIssue(correctiveValidationIssue((r.data.items || [])[0] || {}));
          return;
        }
        if (r.data && r.data.error === 'lead_submission_not_eligible') {
          showScoringValidationIssue(leadSubmissionValidationIssue());
          return;
        }
        throw new Error('submit_to_lead_failed');
      }
      clearScoringValidationIssue();
      Object.assign(ticket, mapTicketFromApi(r.data.ticket));
      $('scoring-msg').textContent = 'Đã khóa lần đánh giá và chuyển phiếu sang Chờ duyệt (Lead).';
    } catch {
      $('scoring-msg').textContent = 'Không chuyển được phiếu. Vui lòng thử lại.';
    }
    renderScoring();
    renderEvaluations();
    renderAuditWorkspace();
  }

  async function endEvaluation(code) {
    const ticket = code ? demoEvaluations.find((row) => row.code === code) : selectedTicket();
    if (!ticket || !canEndEvaluation(ticket)) return;
    const ok = await confirmAction({
      title: 'Kết thúc đánh giá?',
      message: 'Phiếu sẽ chuyển sang Hoàn thành và lần chấm điểm đã khóa được giữ nguyên.',
      cancelLabel: 'Hủy',
      confirmLabel: 'Kết thúc đánh giá',
    });
    if (!ok) return;
    try {
      const r = await api('/evaluations/' + encodeURIComponent(ticket.code), {
        method: 'PATCH',
        body: {
          workflow_status: 'Hoàn thành',
          comment: 'Kết thúc đánh giá sau khi hoàn tất chấm điểm.',
        },
      });
      if (!r.ok) throw new Error((r.data && r.data.error) || 'end_evaluation_failed');
      Object.assign(ticket, mapTicketFromApi(r.data.ticket));
      if ($('scoring-msg')) $('scoring-msg').textContent = 'Đã kết thúc đánh giá và chuyển phiếu sang Hoàn thành.';
      showToast('Đã kết thúc đánh giá ' + ticket.code + '.', 'ok');
    } catch {
      if ($('scoring-msg')) $('scoring-msg').textContent = 'Không kết thúc được đánh giá. Vui lòng kiểm tra quyền hoặc trạng thái phiếu.';
      showToast('Không kết thúc được đánh giá.', 'err');
    }
    renderScoring();
    renderEvaluations();
    renderReports();
    renderAuditWorkspace();
  }

  function openAssessmentRound(code, roundNo) {
    const ticket = demoEvaluations.find((row) => row.code === code);
    if (!ticket || !roundNo) return;
    ticket.current_round_no = Number(roundNo);
    state.scoringTicket = ticket.code;
    navigateToTab('scoring');
    const detailModal = $('ticket-detail-modal');
    if (detailModal) detailModal.classList.add('hidden');
    loadRoundData(ticket, true).finally(() => {
      renderScoring();
      renderSidebar();
    });
  }

  async function startRound2(code) {
    if (code && typeof code !== 'string') code = '';
    const ticket = code ? demoEvaluations.find((row) => row.code === code) : selectedTicket();
    if (!ticket) return;
    if (ticket.round_2_exists) {
      openAssessmentRound(ticket.code, 2);
      return;
    }
    if (!ticket.round_2_eligible) {
      if ($('scoring-msg')) $('scoring-msg').textContent = apiErrorMessage('round_2_not_allowed');
      return;
    }
    try {
      const r = await api('/evaluations/' + encodeURIComponent(ticket.code) + '/round-2', { method: 'POST', body: {} });
      if (!r.ok) throw new Error((r.data && (r.data.reason || r.data.error)) || 'round_2_failed');
      state.roundQuestions[roundStateKey(ticket.code, 2)] = (r.data.questions || []).map(mapQuestionFromApi);
      answersByTicket[ticket.code] = r.data.canonical_answers || r.data.answers || {};
      const updated = mapTicketFromApi(r.data.ticket);
      Object.assign(ticket, updated, {
        current_round_no: 2,
        round_2_exists: true,
        round_2_eligible: false,
        scoringLocked: !!(r.data.round && r.data.round.locked),
      });
      state.roundLoaded[roundStateKey(ticket.code, 2)] = true;
      state.roundAttendees[roundStateKey(ticket.code, 2)] = normalizeAttendees((r.data.round && r.data.round.attendees) || []);
      state.scoringTicket = ticket.code;
      navigateToTab('scoring');
      const detailModal = $('ticket-detail-modal');
      if (detailModal) detailModal.classList.add('hidden');
      if ($('scoring-msg')) $('scoring-msg').textContent = 'Đã tạo đánh giá lần 2 từ dữ liệu kế thừa của lần 1.';
    } catch (err) {
      if (err && err.message === 'round_2_exists') {
        ticket.round_2_exists = true;
        ticket.round_2_eligible = false;
        openAssessmentRound(ticket.code, 2);
        if ($('scoring-msg')) $('scoring-msg').textContent = 'Đã mở đánh giá lần 2 hiện có.';
        return;
      }
      const errorCode = err && err.message ? err.message : 'round_2_failed';
      if ($('scoring-msg')) $('scoring-msg').textContent = apiErrorMessage(errorCode, 'Không tạo được đánh giá lần 2. Kiểm tra phiếu đang ở trạng thái Chờ khắc phục và chưa có đánh giá lần 2.');
    }
    renderScoring();
    renderEvaluations();
    renderSidebar();
  }

  async function applyWorkflowAction(action, code) {
    const ticket = demoEvaluations.find((r) => r.code === code);
    if (!ticket) return;
    const endpointByAction = {
      'lead-reject': 'lead-reject',
      'lead-approve': 'lead-approve',
      'tbp-reject': 'tbp-reject',
      'tbp-send-gdk': 'tbp-send-gdk',
      'tbp-approve': 'tbp-approve',
      'gdk-reject': 'gdk-reject',
      'gdk-approve': 'gdk-approve',
    };
    if (!endpointByAction[action]) return;
    let comment = '';
    if (action.endsWith('reject')) {
      comment = prompt('Nhập lý do từ chối / trả về:') || '';
      if (!comment.trim()) {
        showToast('Vui lòng nhập lý do từ chối hoặc trả về.', 'err');
        return;
      }
    } else if (action === 'tbp-send-gdk') {
      comment = prompt('Ý kiến gửi GĐK (tùy chọn):') || '';
    } else if (action.endsWith('approve')) {
      comment = prompt('Ý kiến phê duyệt (tùy chọn):') || '';
    }
    try {
      const r = await api('/evaluations/' + encodeURIComponent(code) + '/' + endpointByAction[action], { method: 'POST', body: { comment } });
      if (!r.ok) throw new Error((r.data && r.data.error) || 'approval_failed');
      Object.assign(ticket, mapTicketFromApi(r.data.ticket));
    } catch {
      state.workflowError = 'Không cập nhật được luồng phê duyệt. Vui lòng thử lại.';
    }
    renderApprovals();
    renderEvaluations();
    renderReports();
  }

  initCollapsibleFilterPanel('eval-filter-toggle', 'eval-filter-details');
  syncCollapsibleFilterIndicators();

  const evalApply = $('eval-apply-filters');
  if (evalApply) evalApply.addEventListener('click', () => {
    state.evalSearch = $('eval-search').value;
    state.evalFilters = {
      dateType: $('eval-date-type').value,
      type: $('eval-type-filter').value,
      status: $('eval-status-filter').value,
      mch2: $('eval-mch2-filter').value,
      mch3: $('eval-mch3-filter').value,
      from: $('eval-date-from').value.trim(),
      to: $('eval-date-to').value.trim(),
    };
    if (state.evalFilters.status) state.evalStatusTab = '';
    state.evalPage = 1;
    resetMobileLimit('eval');
    renderEvaluations();
  });
  const evalReset = $('eval-reset-filters');
  if (evalReset) evalReset.addEventListener('click', () => {
    ['eval-search', 'eval-type-filter', 'eval-status-filter', 'eval-mch2-filter', 'eval-mch3-filter', 'eval-date-from', 'eval-date-to'].forEach((id) => { if ($(id)) $(id).value = ''; });
    $('eval-date-type').value = 'created_at';
    state.evalSearch = '';
    state.evalStatusTab = '';
    state.evalFilters = {};
    state.evalPage = 1;
    resetMobileLimit('eval');
    refreshEvalMch3Filter(true);
    renderEvaluations();
  });
  const evalSearch = $('eval-search');
  const debouncedEvalSearch = debounce((value) => {
    state.evalSearch = value;
    state.evalPage = 1;
    resetMobileLimit('eval');
    renderEvaluations();
  }, 300);
  if (evalSearch) {
    evalSearch.addEventListener('input', (e) => debouncedEvalSearch(e.target.value));
    evalSearch.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('eval-apply-filters').click(); } });
  }
  const evalExport = $('eval-export-excel');
  bindRegisteredAction(evalExport, 'evaluation.export', exportEvaluationSummary, { announceSuccess: false });
  Array.from(document.querySelectorAll('[data-eval-sort]')).forEach((btn) => {
    btn.addEventListener('click', () => {
      const field = btn.dataset.evalSort;
      state.evalSort = {
        field,
        dir: state.evalSort.field === field && state.evalSort.dir === 'asc' ? 'desc' : 'asc',
      };
      resetMobileLimit('eval');
      renderEvaluations();
    });
  });
  if ($('eval-prev-page')) $('eval-prev-page').addEventListener('click', () => { state.evalPage -= 1; renderEvaluations(); });
  if ($('eval-next-page')) $('eval-next-page').addEventListener('click', () => { state.evalPage += 1; renderEvaluations(); });
  if ($('btn-close-ticket-detail')) $('btn-close-ticket-detail').addEventListener('click', () => $('ticket-detail-modal').classList.add('hidden'));
  if ($('btn-close-assessment-detail')) $('btn-close-assessment-detail').addEventListener('click', () => $('assessment-detail-modal').classList.add('hidden'));
  if ($('btn-close-ticket-history')) $('btn-close-ticket-history').addEventListener('click', () => $('ticket-history-modal').classList.add('hidden'));
  if ($('btn-close-supplier-detail')) $('btn-close-supplier-detail').addEventListener('click', () => $('supplier-detail-modal').classList.add('hidden'));
  if ($('btn-close-supplier-history')) $('btn-close-supplier-history').addEventListener('click', () => $('supplier-history-modal').classList.add('hidden'));
  if ($('new-supplier-select')) $('new-supplier-select').addEventListener('input', scheduleSupplierLookup);
  if ($('new-supplier-select')) $('new-supplier-select').addEventListener('change', (e) => {
    const found = selectedLookupSupplier(e.target.value);
    if (found) applySupplierToEvaluationForm(found);
  });
  if ($('new-supplier-select')) $('new-supplier-select').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const found = selectedLookupSupplier(e.target.value);
    if (found) {
      e.preventDefault();
      applySupplierToEvaluationForm(found);
    }
  });

  if ($('supplier-apply-filters')) $('supplier-apply-filters').addEventListener('click', () => {
    state.supplierSearch = $('supplier-search').value.trim();
    state.supplierFilters = {
      status: $('supplier-filter-status').value,
    };
    state.supplierPage = 1;
    loadSuppliers();
  });
  if ($('supplier-reset-filters')) $('supplier-reset-filters').addEventListener('click', () => {
    ['supplier-search', 'supplier-filter-status'].forEach((id) => { if ($(id)) $(id).value = ''; });
    state.supplierSearch = '';
    state.supplierFilters = {};
    state.supplierPage = 1;
    loadSuppliers();
  });
  const debouncedSupplierSearch = debounce((value) => {
    state.supplierSearch = value.trim();
    state.supplierPage = 1;
    loadSuppliers();
  }, 300);
  if ($('supplier-search')) {
    $('supplier-search').addEventListener('input', (e) => debouncedSupplierSearch(e.target.value));
    $('supplier-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('supplier-apply-filters').click(); } });
  }
  if ($('supplier-prev-page')) $('supplier-prev-page').addEventListener('click', () => { state.supplierPage -= 1; loadSuppliers(); });
  if ($('supplier-next-page')) $('supplier-next-page').addEventListener('click', () => { state.supplierPage += 1; loadSuppliers(); });
  if ($('btn-add-supplier')) $('btn-add-supplier').addEventListener('click', () => openSupplierModal(null));
  if ($('btn-import-suppliers')) $('btn-import-suppliers').addEventListener('click', () => {
    if (!canManageSuppliers()) return;
    $('supplier-import-file').value = '';
    $('supplier-import-result').textContent = '';
    setMsg('supplier-import-msg', UI_TEXT.suppliers.importHelp);
    $('supplier-import-modal').classList.remove('hidden');
  });
  if ($('btn-cancel-supplier')) $('btn-cancel-supplier').addEventListener('click', () => $('supplier-modal').classList.add('hidden'));
  if ($('btn-cancel-supplier-import')) $('btn-cancel-supplier-import').addEventListener('click', () => $('supplier-import-modal').classList.add('hidden'));
  SUPPLIER_REQUIRED_FIELD_SPECS.map((spec) => spec.id).forEach((id) => {
    const field = $(id);
    if (!field) return;
    field.addEventListener('input', () => {
      if (field.classList.contains('invalid')) validateSupplierRequiredFields();
    });
    field.addEventListener('blur', validateSupplierRequiredFields);
  });
  async function saveSupplierAction(e) {
    e.preventDefault();
    if (!canManageSuppliers()) return;
    const finishButton = setButtonLoading($('btn-save-supplier'), 'Đang lưu NCC...');
    const payload = supplierFormPayload();
    if (!validateSupplierRequiredFields()) {
      finishButton();
      setMsg('supplier-form-msg', 'Vui lòng nhập đầy đủ các trường bắt buộc.', 'err');
      return;
    }
    const pathUrl = state.editingSupplierId ? '/suppliers/' + encodeURIComponent(state.editingSupplierId) : '/suppliers';
    const method = state.editingSupplierId ? 'PUT' : 'POST';
    const r = await api(pathUrl, { method, body: payload });
    if (!r.ok) {
      finishButton();
      const err = r.data && r.data.error;
      const errors = (r.data && r.data.errors) || {};
      applySupplierServerErrors(errors);
      setMsg('supplier-form-msg', apiErrorMessage(err, 'Không lưu được NCC.'), 'err');
      return;
    }
    finishButton('Đã lưu ✓');
    showToast(state.editingSupplierId ? 'Đã cập nhật NCC.' : 'Đã thêm NCC.', 'ok');
    $('supplier-modal').classList.add('hidden');
    loadSuppliers();
  }
  bindRegisteredAction($('supplier-form'), () => state.editingSupplierId ? 'supplier.edit' : 'supplier.create', saveSupplierAction, {
    event: 'submit', preventDefault: true, trigger: $('btn-save-supplier'), announceSuccess: false,
  });

  function downloadSupplierImportTemplate() {
    const anchor = document.createElement('a');
    anchor.href = '/qlcl/api/suppliers/import-template';
    anchor.download = 'mau-import-danh-sach-ncc.xlsx';
    anchor.click();
  }

  function renderSupplierImportErrors(errors) {
    const result = $('supplier-import-result');
    result.textContent = '';
    (errors || []).slice(0, 20).forEach((row) => {
      const details = Array.isArray(row.details) && row.details.length
        ? row.details
        : (row.errors || []).map((code) => ({ column: '', code, message: code }));
      details.forEach((detail) => {
        const location = row.row > 0 ? `Dòng ${row.row}` : 'Cấu trúc file';
        const column = detail.column ? ` · cột ${detail.column}` : '';
        result.appendChild(el('div', {
          className: 'mono',
          text: `${location}${column}: ${detail.message || detail.code}`,
        }));
      });
    });
  }

  bindRegisteredAction($('btn-download-supplier-template'), 'supplier.download_template', downloadSupplierImportTemplate, {
    announceSuccess: false,
  });

  async function importSuppliersAction(e) {
    e.preventDefault();
    if (!canManageSuppliers()) return;
    const f = $('supplier-import-file').files[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('file', f);
    const finishButton = setButtonLoading($('btn-submit-supplier-import'), 'Đang nhập danh mục...');
    setMsg('supplier-import-msg', UI_TEXT.suppliers.importStarted);
    const r = await api('/suppliers/import-excel', { method: 'POST', body: fd });
    if (!r.ok) {
      finishButton();
      const err = r.data && r.data.error;
      renderSupplierImportErrors(r.data && r.data.errors);
      setMsg('supplier-import-msg', apiErrorMessage(err, UI_TEXT.suppliers.importFailed), 'err');
      return;
    }
    finishButton('Đã nhập ✓');
    const s = r.data.summary || {};
    setMsg('supplier-import-msg', UI_TEXT.suppliers.importSummary({
      status: s.status,
      successRows: s.success_rows || 0,
      totalRows: s.total_rows || 0,
      failedRows: s.failed_rows || 0,
    }), s.failed_rows ? 'err' : 'ok');
    renderSupplierImportErrors(r.data.errors);
    loadSuppliers();
  }
  bindRegisteredAction($('supplier-import-form'), 'supplier.import', importSuppliersAction, {
    event: 'submit', preventDefault: true, trigger: $('btn-submit-supplier-import'), announceSuccess: false,
  });

  function hasSavedEvaluationIdentity(saved) {
    return Number.isSafeInteger(Number(saved?.id)) && Number(saved.id) > 0 && Boolean(String(saved.code || '').trim());
  }

  function clearSavedEvaluationScoreAction() {
    state.savedEvaluationForScoring = null;
    const scoreAfterSave = $('evaluation-score-after-save');
    const button = $('btn-score-saved-evaluation');
    if (scoreAfterSave) scoreAfterSave.classList.add('hidden');
    if (button) {
      button.disabled = true;
      delete button.dataset.ticketId;
      delete button.dataset.ticketCode;
    }
  }

  function showSavedEvaluationScoreAction(saved) {
    clearSavedEvaluationScoreAction();
    if (!hasSavedEvaluationIdentity(saved) || !resourceCan(saved, 'score')) return;
    state.savedEvaluationForScoring = saved;
    const scoreAfterSave = $('evaluation-score-after-save');
    const button = $('btn-score-saved-evaluation');
    if (scoreAfterSave) scoreAfterSave.classList.remove('hidden');
    if (button) {
      button.disabled = false;
      button.dataset.ticketId = String(saved.id);
      button.dataset.ticketCode = saved.code;
    }
  }

  function openSavedEvaluationScoring() {
    const saved = state.savedEvaluationForScoring;
    if (!hasSavedEvaluationIdentity(saved) || !resourceCan(saved, 'score')) {
      clearSavedEvaluationScoreAction();
      return;
    }
    const ticket = demoEvaluations.find((row) =>
      Number(row.id) === Number(saved.id) && row.code === saved.code
    );
    if (!ticket || !resourceCan(ticket, 'score')) {
      clearSavedEvaluationScoreAction();
      return;
    }
    openScoringForTicket(ticket.code);
  }

  function resetEvaluationFormAfterSuccessfulSave(form) {
    state.editingTicketCode = null;
    state.selectedSupplierId = null;
    form.reset();
    resetEvaluationHistoryDefaults();
    updateLegalFileLabel('business_license_file', '');
    updateLegalFileLabel('attp_certificate_file', '');
    resetNewSupplierSelect();
    updateAdHocReasonVisibility();
    setMasterDataControlValues('new', '', '', '');
    refreshMch3Options();
    refreshFacilityOptions();
  }

  if ($('new-eval-type')) $('new-eval-type').addEventListener('change', () => {
    updateAdHocReasonVisibility();
    loadPreviousEvaluationDefaults();
  });
  if ($('eval-mch2-filter')) $('eval-mch2-filter').addEventListener('change', () => refreshEvalMch3Filter(true));
  if ($('new-mch2')) $('new-mch2').addEventListener('change', () => refreshMch3Options(true));
  if ($('new-region')) $('new-region').addEventListener('change', () => refreshProvinceOptions('new', true));
  if ($('supplier-region')) $('supplier-region').addEventListener('change', () => refreshProvinceOptions('supplier', true));
  if ($('new-template')) $('new-template').addEventListener('change', () => {
    markEvaluationHistoryFieldManual('template');
    refreshFacilityOptions();
  });
  if ($('new-facility-type')) $('new-facility-type').addEventListener('change', () => markEvaluationHistoryFieldManual('facility_type'));
  if ($('new-supplier-scale')) $('new-supplier-scale').addEventListener('change', () => markEvaluationHistoryFieldManual('supplier_scale'));
  if ($('new-business-license-file')) $('new-business-license-file').addEventListener('change', () => updateLegalFileLabel('business_license_file', ''));
  if ($('new-attp-certificate-file')) $('new-attp-certificate-file').addEventListener('change', () => updateLegalFileLabel('attp_certificate_file', ''));
  if ($('btn-form-reset')) $('btn-form-reset').addEventListener('click', () => {
    const form = $('evaluation-form');
    state.editingTicketCode = null;
    state.selectedSupplierId = null;
    form.reset();
    resetEvaluationHistoryDefaults();
    clearSavedEvaluationScoreAction();
    updateLegalFileLabel('business_license_file', '');
    updateLegalFileLabel('attp_certificate_file', '');
    resetNewSupplierSelect();
    clearFieldErrors(form);
    updateAdHocReasonVisibility();
    setMasterDataControlValues('new', '', '', '');
    refreshMch3Options();
    refreshFacilityOptions();
    setMsg('evaluation-form-msg', '');
  });
  async function saveEvaluationAction(e) {
    e.preventDefault();
    if (state.evaluationSaveInFlight) return;
    clearSavedEvaluationScoreAction();
    const form = e.currentTarget;
    if (!validateEvaluationForm(form)) {
      setMsg('evaluation-form-msg', 'Vui lòng kiểm tra các trường bắt buộc.', 'err');
      return;
    }
    const wasEditing = Boolean(state.editingTicketCode);
    state.evaluationSaveInFlight = true;
    const finishButton = setButtonLoading($('btn-save-evaluation'), 'Đang lưu phiếu...');
    setMsg('evaluation-form-msg', 'Đang lưu phiếu...', '');
    try {
      const payload = createTicketFromForm(form);
      const requestBody = evaluationRequestBody(form, payload);
      const r = state.editingTicketCode
        ? await api('/evaluations/' + encodeURIComponent(state.editingTicketCode), { method: 'PUT', body: requestBody })
        : await api('/evaluations', { method: 'POST', body: requestBody });
      if (!r.ok) {
        finishButton();
        setMsg('evaluation-form-msg', 'Không lưu được phiếu. Vui lòng thử lại.', 'err');
        return;
      }
      finishButton('Đã lưu ✓');
      setMsg('evaluation-form-msg', wasEditing ? 'Đã cập nhật phiếu.' : 'Đã thêm phiếu ở trạng thái Khởi tạo.', 'ok');
      if (!r.data || !r.data.ticket) {
        resetEvaluationFormAfterSuccessfulSave(form);
        renderEvaluations();
        return;
      }
      const saved = mapTicketFromApi(r.data.ticket);
      const existingIndex = demoEvaluations.findIndex((row) => row.code === saved.code);
      if (existingIndex >= 0) demoEvaluations[existingIndex] = saved;
      else demoEvaluations.unshift(saved);
      resetEvaluationFormAfterSuccessfulSave(form);
      if (!wasEditing) showSavedEvaluationScoreAction(saved);
      renderEvaluations();
    } finally {
      state.evaluationSaveInFlight = false;
    }
  }
  bindRegisteredAction($('evaluation-form'), 'evaluation.save', saveEvaluationAction, {
    event: 'submit', preventDefault: true, trigger: $('btn-save-evaluation'), announceSuccess: false,
  });
  bindRegisteredAction($('btn-score-saved-evaluation'), 'evaluation.score', openSavedEvaluationScoring, {
    resource: () => state.savedEvaluationForScoring,
    objectIdentity: () => state.savedEvaluationForScoring?.code || '',
    announceSuccess: false,
  });

  if ($('scoring-ticket-select')) $('scoring-ticket-select').addEventListener('change', (e) => {
    clearScoringValidationIssue();
    state.scoringTicket = e.target.value;
    const route = state.scoringTicket
      ? '/evaluations/scoring?ticket=' + encodeURIComponent(state.scoringTicket)
      : '/evaluations/scoring';
    if (window.location.hash !== '#' + route) {
      window.location.hash = route;
      return;
    }
    if (!resourceCan(ticket, 'score') || ticket.scoringLocked) {
      showScoringValidationIssue({ type: 'ticket', message: 'Phiếu không còn cho phép chấm điểm hoặc lần đánh giá đã được khóa.' });
      return;
    }
    renderScoring();
  });
  if ($('scoring-section-filter')) $('scoring-section-filter').addEventListener('change', () => { clearScoringValidationIssue(); renderScoring(); });
  if ($('btn-add-attendee')) $('btn-add-attendee').addEventListener('click', () => {
    const ticket = selectedTicket();
    if (!ticket) return;
    saveAttendeeInputs();
    attendeeRowsForTicket(ticket).push({ name: '', opening: false, closing: false });
    renderScoring();
  });
  if ($('attendees-tbody')) $('attendees-tbody').addEventListener('input', saveAttendeeInputs);
  if ($('attendees-tbody')) $('attendees-tbody').addEventListener('change', saveAttendeeInputs);
  if ($('supplier-introduction-input')) $('supplier-introduction-input').addEventListener('input', saveSupplierIntroductionInput);
  if ($('scoring-tbody')) $('scoring-tbody').addEventListener('click', (event) => {
    const choice = event.target.closest('[data-score-choice]');
    if (!choice || choice.disabled) return;
    const group = choice.closest('.score-segmented');
    const scoreValue = group?.querySelector('[data-score-value]');
    if (!group || !scoreValue) return;
    scoreValue.value = choice.getAttribute('data-score-choice') || '';
    group.querySelectorAll('[data-score-choice]').forEach((button) => {
      const selected = button === choice;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-checked', selected ? 'true' : 'false');
      button.setAttribute('tabindex', selected ? '0' : '-1');
    });
    scoreValue.dispatchEvent(new Event('change', { bubbles: true }));
  });
  if ($('scoring-tbody')) $('scoring-tbody').addEventListener('keydown', (event) => {
    const choice = event.target.closest('[data-score-choice]');
    if (!choice || choice.disabled || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const choices = Array.from(choice.closest('.score-segmented')?.querySelectorAll('[data-score-choice]:not(:disabled)') || []);
    if (!choices.length) return;
    event.preventDefault();
    const currentIndex = Math.max(0, choices.indexOf(choice));
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? choices.length - 1
        : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + choices.length) % choices.length;
    choices[nextIndex].focus();
    choices[nextIndex].click();
  });
  if ($('scoring-tbody')) $('scoring-tbody').addEventListener('change', (e) => {
    if (e.target.matches('[data-score-value]')) {
      if (issueMatchesQuestion(scoringValidationTarget, e.target.getAttribute('data-score-value'), 'score')) clearScoringValidationIssue();
      saveCurrentScoringInputs();
      renderScoring();
    }
    if (e.target.matches('[data-attachment-id]')) {
      const ticket = selectedTicket();
      const file = e.target.files && e.target.files[0];
      if (!ticket || !file) return;
      const questionId = e.target.getAttribute('data-attachment-id');
      uploadScoringAttachment(ticket, questionId, file).then(() => {
        if (issueMatchesQuestion(scoringValidationTarget, questionId, 'attachment')) clearScoringValidationIssue();
        $('scoring-msg').textContent = 'Đã tải bằng chứng lên.';
        renderScoring();
      }).catch(() => {
        $('scoring-msg').textContent = 'Không tải được bằng chứng. Hãy kiểm tra file rồi thử lại.';
        renderScoring();
      });
    }
  });
  if ($('scoring-tbody')) $('scoring-tbody').addEventListener('input', (e) => {
    if (e.target.matches('[data-note-id]')) {
      if (issueMatchesQuestion(scoringValidationTarget, e.target.getAttribute('data-note-id'), 'note')) {
        clearScoringValidationIssue();
        clearValidationDecorationsNear(e.target);
      }
      saveCurrentScoringInputs();
    }
  });
  if ($('nonconformity-tbody')) $('nonconformity-tbody').addEventListener('focusin', (event) => {
    if (event.target.matches('[data-corrective-requirement-combobox]')) renderCorrectiveRequirementOptions(event.target);
  });
  if ($('nonconformity-tbody')) $('nonconformity-tbody').addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-corrective-requirement-toggle]');
    const input = toggle
      ? toggle.closest('.corrective-requirement-combobox')?.querySelector('[data-corrective-requirement-combobox]')
      : (event.target.matches('[data-corrective-requirement-combobox]') ? event.target : null);
    if (!input) return;
    event.preventDefault();
    input.focus();
    renderCorrectiveRequirementOptions(input);
  });
  if ($('nonconformity-tbody')) $('nonconformity-tbody').addEventListener('input', (event) => {
    const input = event.target;
    if (!input.matches('[data-corrective-requirement-combobox]')) return;
    input.setAttribute('data-corrective-requirement-selected', 'false');
    input.removeAttribute('data-corrective-requirement-id');
    if (input.hasAttribute('data-nc-draft-remediation')) saveDraftNonconformityRequirementInput(input);
    renderCorrectiveRequirementOptions(input);
  });
  if ($('nonconformity-tbody')) $('nonconformity-tbody').addEventListener('keydown', (event) => {
    const input = event.target;
    if (!input.matches('[data-corrective-requirement-combobox]')) return;
    if (event.key === 'Escape') {
      closeCorrectiveRequirementOptions();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      $('corrective-requirement-options')?.querySelector('button')?.focus();
      return;
    }
    if (event.key !== 'Enter') return;
    const exact = correctiveRequirementItems.find((item) => normalizedCorrectiveRequirementName(item.name) === normalizedCorrectiveRequirementName(input.value));
    if (exact) {
      event.preventDefault();
      applyCorrectiveRequirementSelection(input, exact);
    }
  });
  $('corrective-requirement-options')?.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    const input = activeCorrectiveRequirementInput;
    if (!button || !input) return;
    if (button.hasAttribute('data-corrective-requirement-create')) {
      openCorrectiveRequirementCreateModal(input);
      return;
    }
    if (!button.hasAttribute('data-corrective-requirement-option-id')) return;
    const id = Number(button.getAttribute('data-corrective-requirement-option-id')) || null;
    const name = button.getAttribute('data-corrective-requirement-option-name') || '';
    const item = correctiveRequirementItems.find((entry) => (id && Number(entry.id) === id)
      || normalizedCorrectiveRequirementName(entry.name) === normalizedCorrectiveRequirementName(name));
    if (item) applyCorrectiveRequirementSelection(input, item);
  });
  $('corrective-requirement-cancel')?.addEventListener('click', () => closeCorrectiveRequirementCreateModal(true));
  $('corrective-requirement-modal')?.addEventListener('click', (event) => {
    if (event.target === $('corrective-requirement-modal')) closeCorrectiveRequirementCreateModal(true);
  });
  $('corrective-requirement-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = correctiveRequirementCreateTarget;
    const name = displayCorrectiveRequirementName($('corrective-requirement-name')?.value);
    if (!input || !name || name.length > 120) {
      $('corrective-requirement-error').textContent = 'Tên yêu cầu không hợp lệ.';
      return;
    }
    const finish = setButtonLoading($('corrective-requirement-submit'), 'Đang thêm...');
    $('corrective-requirement-error').textContent = '';
    try {
      const response = await api('/evaluations/corrective-requirements', { method: 'POST', body: { name } });
      if (!response.ok || !response.data?.item) throw new Error(response.data?.error || 'corrective_requirement_create_failed');
      const target = input;
      const item = rememberCorrectiveRequirement(response.data.item);
      closeCorrectiveRequirementCreateModal(false);
      await applyCorrectiveRequirementSelection(target, item);
      showToast(response.data.created ? 'Đã thêm yêu cầu khắc phục mới.' : 'Yêu cầu đã tồn tại, hệ thống đã dùng mục hiện có.', 'ok');
    } catch (error) {
      $('corrective-requirement-error').textContent = apiErrorMessage(error?.message, 'Không thể thêm yêu cầu khắc phục.');
    } finally {
      finish();
    }
  });
  document.addEventListener('click', (event) => {
    const options = $('corrective-requirement-options');
    if (!options || options.classList.contains('hidden')) return;
    const activeCombobox = activeCorrectiveRequirementInput?.closest('.corrective-requirement-combobox');
    if (options.contains(event.target) || activeCombobox?.contains(event.target)) return;
    closeCorrectiveRequirementOptions();
  });
  window.addEventListener('resize', closeCorrectiveRequirementOptions);
  window.addEventListener('scroll', closeCorrectiveRequirementOptions, true);
  if ($('nonconformity-tbody')) $('nonconformity-tbody').addEventListener('change', (e) => {
    if (e.target.matches('[data-corrective-requirement-combobox]')) return;
    if (e.target.matches('[data-nc-draft-remediation], [data-nc-draft-due-date]')) {
      const isRemediation = e.target.matches('[data-nc-draft-remediation]');
      if (!isRemediation) e.target.setAttribute('data-nc-due-date-dirty', 'true');
      saveDraftNonconformityRequirementInput(e.target);
      const field = isRemediation ? 'remediation' : 'due_date';
      if (issueMatchesNonconformity(scoringValidationTarget, { _validation_id: e.target.getAttribute('data-nc-remediation') || e.target.getAttribute('data-nc-due-date') }, field)) {
        clearScoringValidationIssue();
        clearValidationDecorationsNear(e.target);
      }
      $('scoring-msg').textContent = isRemediation ? 'Đã ghi nhận yêu cầu khắc phục.' : 'Đã ghi nhận thời hạn khắc phục.';
      return;
    }
    if (!e.target.matches('[data-nc-due-date], [data-nc-remediation]')) return;
    const isRemediation = e.target.matches('[data-nc-remediation]');
    saveNonconformityRequirement(e.target).then(() => {
      const field = isRemediation ? 'remediation' : 'due_date';
      if (issueMatchesNonconformity(scoringValidationTarget, { id: e.target.getAttribute(isRemediation ? 'data-nc-remediation' : 'data-nc-due-date') }, field)) clearScoringValidationIssue();
      $('scoring-msg').textContent = isRemediation ? 'Đã lưu yêu cầu khắc phục.' : 'Đã lưu thời hạn khắc phục.';
      renderScoring();
    }).catch((err) => {
      $('scoring-msg').textContent = apiErrorMessage(err && err.message, isRemediation ? 'Không lưu được yêu cầu khắc phục.' : 'Không lưu được thời hạn khắc phục.');
    });
  });
  async function saveScoringDraftAction() {
    const finishButton = setButtonLoading($('btn-save-scoring-draft'), 'Đang lưu nháp...');
    const ticket = selectedTicket();
    if (!ticket || !resourceCan(ticket, 'score') || ticket.scoringLocked) {
      finishButton();
      $('scoring-msg').textContent = ticket
        ? 'Phiếu không còn cho phép lưu bản nháp chấm điểm.'
        : 'Vui lòng chọn phiếu đánh giá.';
      renderScoring();
      return;
    }
    saveCurrentScoringInputs();
    try {
      await persistAnswers(state.scoringTicket);
      finishButton('Đã lưu ✓');
      $('scoring-msg').textContent = 'Đã lưu tạm câu trả lời.';
      showToast('Đã lưu bản nháp chấm điểm.', 'ok');
    } catch {
      finishButton();
      $('scoring-msg').textContent = 'Không lưu được câu trả lời. Vui lòng thử lại.';
    }
    renderScoring();
  }
  const selectedScoringResource = () => selectedTicket();
  const selectedEndEvaluationContext = () => {
    const ticket = selectedTicket();
    return actionContext(ticket, {
      preconditions: {
        scoring_locked: !!ticket?.scoringLocked,
        no_pending_approval: !ticket?.pendingApproval,
      },
    });
  };
  bindRegisteredAction($('btn-save-scoring-draft'), 'evaluation.save_scoring', saveScoringDraftAction, { announceSuccess: false, resource: selectedScoringResource });
  bindRegisteredAction($('btn-complete-scoring'), 'evaluation.complete_scoring', completeCurrentScoring, { announceSuccess: false, resource: selectedScoringResource });
  bindRegisteredAction($('btn-end-evaluation'), 'evaluation.complete', () => endEvaluation(), { announceSuccess: false, context: selectedEndEvaluationContext });
  bindRegisteredAction($('btn-submit-lead'), 'evaluation.submit_lead', submitCurrentTicketToLead, { announceSuccess: false, resource: selectedScoringResource });
  bindRegisteredAction($('btn-start-round2'), 'evaluation.round2_start', () => startRound2(), { announceSuccess: false, resource: selectedScoringResource });
  if ($('approval-tbody')) $('approval-tbody').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-workflow-action]');
    if (!btn) return;
    applyWorkflowAction(btn.getAttribute('data-workflow-action'), btn.getAttribute('data-ticket-code'));
  });
  const debouncedApprovalSearch = debounce((value) => {
    state.approvalSearch = value;
    resetMobileLimit('approval');
    renderApprovals();
  }, 300);
  if ($('approval-search')) $('approval-search').addEventListener('input', (e) => debouncedApprovalSearch(e.target.value));
  if ($('approval-role-filter')) $('approval-role-filter').addEventListener('change', (e) => { state.approvalRole = e.target.value; resetMobileLimit('approval'); renderApprovals(); });
  if ($('approval-reset')) $('approval-reset').addEventListener('click', () => { $('approval-search').value = ''; $('approval-role-filter').value = ''; state.approvalSearch = ''; state.approvalRole = ''; resetMobileLimit('approval'); renderApprovals(); });
  const debouncedReportSearch = debounce((value) => {
    state.reportSearch = value;
    resetMobileLimit('report');
    renderReports();
  }, 300);
  if ($('report-search')) $('report-search').addEventListener('input', (e) => debouncedReportSearch(e.target.value));
  if ($('report-type-filter')) $('report-type-filter').addEventListener('change', (e) => { state.reportType = e.target.value; resetMobileLimit('report'); renderReports(); });
  if ($('report-reset')) $('report-reset').addEventListener('click', () => { $('report-search').value = ''; $('report-type-filter').value = ''; state.reportSearch = ''; state.reportType = ''; resetMobileLimit('report'); renderReports(); });
  refreshMch3Options();
  refreshFacilityOptions();
  updateAdHocReasonVisibility();
  // ============ Sidebar toggle + persist localStorage ============
  // Default expanded for the audit workspace; respect the user's saved toggle.
  try {
    const saved = localStorage.getItem('qlcl.sidebar');
    document.body.classList.toggle('sidebar-collapsed', saved === 'collapsed');
  } catch {}
  $('sb-toggle').addEventListener('click', () => {
    document.body.classList.toggle('sidebar-collapsed');
    const collapsed = document.body.classList.contains('sidebar-collapsed');
    try { localStorage.setItem('qlcl.sidebar', collapsed ? 'collapsed' : 'expanded'); } catch {}
  });

  if ($('audit-open-scoring')) {
    $('audit-open-scoring').addEventListener('click', () => {
      const ticket = activeAuditTicket();
      if (ticket) openScoringForTicket(ticket.code);
    });
  }
  if ($('audit-open-history')) {
    $('audit-open-history').addEventListener('click', () => {
      const ticket = activeAuditTicket();
      if (ticket) openTicketHistory(ticket.code);
    });
  }

  // ============ Month picker ============
  const DASHBOARD_PERIOD_SESSION_KEY = 'qlcl.dashboard.period';

  function dashboardPeriodFromRoute() {
    return REPORTING_PERIOD.periodFromRoute(routePathFromHash());
  }

  function dashboardPeriodSessionValue() {
    try { return sessionStorage.getItem(DASHBOARD_PERIOD_SESSION_KEY) || ''; }
    catch { return ''; }
  }

  function rememberDashboardPeriod(value) {
    try { sessionStorage.setItem(DASHBOARD_PERIOD_SESSION_KEY, value); }
    catch {}
  }

  function renderDashboardPeriodNotice() {
    const node = $('period-notice');
    if (!node) return;
    node.textContent = state.dashboardPeriodNotice || '';
    node.classList.toggle('hidden', !shouldShowGlobalPeriod() || !state.dashboardPeriodNotice);
  }

  function currentDashboardReportValue(type) {
    const month = currentMonthVN();
    const [year, monthNo] = month.split('-').map(Number);
    if (type === 'QUARTER') return `${year}-Q${Math.ceil(monthNo / 3)}`;
    if (type === 'YEAR') return String(year);
    return month;
  }

  function validDashboardReportValue(type, value) {
    if (!['MONTH', 'QUARTER', 'YEAR'].includes(type)) return false;
    if (type === 'QUARTER') return /^\d{4}-Q[1-4]$/.test(value);
    if (type === 'YEAR') return /^\d{4}$/.test(value);
    return REPORTING_PERIOD.isValidPeriod(value);
  }

  function dashboardReportLabel(type, value) {
    if (type === 'QUARTER') {
      const match = String(value).match(/^(\d{4})-Q([1-4])$/);
      return match ? `Quý ${['I', 'II', 'III', 'IV'][Number(match[2]) - 1]}/${match[1]}` : value;
    }
    if (type === 'YEAR') return `Năm ${value}`;
    return REPORTING_PERIOD.labelForPeriod(value);
  }

  function offsetDashboardReportValue(type, value, offset) {
    if (type === 'YEAR') return String(Number(value) + offset);
    if (type === 'QUARTER') {
      const match = String(value).match(/^(\d{4})-Q([1-4])$/);
      if (!match) return value;
      const index = (Number(match[1]) * 4) + Number(match[2]) - 1 + offset;
      return `${Math.floor(index / 4)}-Q${(index % 4) + 1}`;
    }
    const [year, month] = String(value).split('-').map(Number);
    const index = (year * 12) + month - 1 + offset;
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
  }

  function dashboardReportRouteState() {
    const params = recordRouteParams();
    const type = String(params.get('periodType') || 'MONTH').toUpperCase();
    const value = String(params.get('periodValue') || params.get('period') || '');
    return validDashboardReportValue(type, value) ? { type, value } : null;
  }

  function dashboardReportOptions(type, selected) {
    return Array.from({ length: 11 }, (_, index) => offsetDashboardReportValue(type, selected, 2 - index));
  }

  function renderDashboardPeriodControls() {
    const reportMode = state.tab === 'overview';
    const periods = REPORTING_PERIOD.normalizePeriods(state.dashboardPeriods);
    const report = state.dashboardReport;
    const type = reportMode ? report.periodType : 'MONTH';
    const current = reportMode ? currentDashboardReportValue(type) : currentMonthVN();
    const selected = reportMode ? report.periodValue : state.month;
    const adjacent = REPORTING_PERIOD.adjacentPeriods(periods, selected);
    ['dashboard-period-segment', 'dashboard-period-segment-mobile'].forEach((id) => {
      const segment = $(id);
      if (segment) segment.classList.toggle('hidden', !reportMode);
    });
    document.querySelectorAll('[data-dashboard-period-type]').forEach((button) => {
      button.classList.toggle('active', reportMode && button.dataset.dashboardPeriodType === type);
      button.setAttribute('aria-pressed', reportMode && button.dataset.dashboardPeriodType === type ? 'true' : 'false');
    });
    ['month-picker', 'mobile-month-picker'].forEach((id) => {
      const select = $(id);
      if (!select) return;
      select.textContent = '';
      const options = reportMode ? dashboardReportOptions(type, selected) : periods.map((item) => item.value);
      options.forEach((value) => select.appendChild(el('option', {
        attrs: { value },
        text: reportMode ? dashboardReportLabel(type, value) : REPORTING_PERIOD.labelForPeriod(value),
      })));
      select.value = selected;
      select.disabled = options.length === 0;
    });
    ['period-previous', 'mobile-period-previous'].forEach((id) => {
      const button = $(id);
      if (button) button.disabled = reportMode ? false : !adjacent.previous;
    });
    ['period-next', 'mobile-period-next'].forEach((id) => {
      const button = $(id);
      if (button) button.disabled = reportMode ? false : !adjacent.next;
    });
    ['period-current', 'mobile-period-current'].forEach((id) => {
      const button = $(id);
      if (button) button.classList.toggle('hidden', !selected || selected === current);
    });
    renderDashboardPeriodNotice();
  }

  function syncDashboardPeriodUrl({ replace = false } = {}) {
    if (!shouldShowGlobalPeriod() || !REPORTING_PERIOD.isValidPeriod(state.month)) return false;
    let route;
    if (state.tab === 'overview' && validDashboardReportValue(state.dashboardReport.periodType, state.dashboardReport.periodValue)) {
      const params = new URLSearchParams({
        periodType: state.dashboardReport.periodType,
        periodValue: state.dashboardReport.periodValue,
      });
      route = `/dashboard?${params.toString()}`;
    } else {
      route = REPORTING_PERIOD.routeWithPeriod(routePathFromHash(), state.month);
    }
    const next = '#' + route;
    if (window.location.hash === next) return false;
    if (replace) window.history.replaceState(null, '', next);
    else window.location.hash = route;
    return true;
  }

  function selectDashboardPeriod(value, { replace = false } = {}) {
    if (!REPORTING_PERIOD.isValidPeriod(value)) return;
    const changed = value !== state.month;
    state.month = value;
    state.dashboardPeriodNotice = '';
    rememberDashboardPeriod(value);
    if (!state.dashboardPeriods.some((item) => item.value === value)) {
      state.dashboardPeriods = REPORTING_PERIOD.normalizePeriods([
        ...state.dashboardPeriods,
        { value, has_data: false, is_current: value === currentMonthVN(), updated_at: null },
      ]);
    }
    renderDashboardPeriodControls();
    syncDashboardPeriodUrl({ replace });
    if (changed && shouldShowGlobalPeriod()) loadTab();
  }

  function selectDashboardReportPeriod(value, { replace = false } = {}) {
    const report = state.dashboardReport;
    if (!validDashboardReportValue(report.periodType, value)) return;
    const changed = value !== report.periodValue;
    report.periodValue = value;
    renderDashboardPeriodControls();
    syncDashboardPeriodUrl({ replace });
    if (changed && state.tab === 'overview') loadTab();
  }

  function selectDashboardReportType(type) {
    const report = state.dashboardReport;
    if (!['MONTH', 'QUARTER', 'YEAR'].includes(type) || type === report.periodType) return;
    let anchorMonth = state.month || currentMonthVN();
    if (report.periodType === 'QUARTER' && /^\d{4}-Q[1-4]$/.test(report.periodValue)) {
      const [year, quarter] = report.periodValue.split('-Q').map(Number);
      anchorMonth = `${year}-${String(((quarter - 1) * 3) + 1).padStart(2, '0')}`;
    } else if (report.periodType === 'YEAR' && /^\d{4}$/.test(report.periodValue)) {
      anchorMonth = `${report.periodValue}-01`;
    } else if (report.periodType === 'MONTH') {
      anchorMonth = report.periodValue;
    }
    const [year, month] = anchorMonth.split('-').map(Number);
    report.periodType = type;
    report.periodValue = type === 'MONTH' ? anchorMonth : type === 'QUARTER' ? `${year}-Q${Math.ceil(month / 3)}` : String(year);
    renderDashboardPeriodControls();
    syncDashboardPeriodUrl();
    if (state.tab === 'overview') loadTab();
  }

  async function loadMonths() {
    const r = await api('/dashboard/months');
    const cur = currentMonthVN();
    let periods = REPORTING_PERIOD.normalizePeriods((r.ok && r.data.months) || []);
    if (!periods.some((item) => item.value === cur)) {
      periods = REPORTING_PERIOD.normalizePeriods([...periods, { value: cur, has_data: false, is_current: true, updated_at: null }]);
    }
    const initial = REPORTING_PERIOD.selectInitialPeriod({
      urlPeriod: REPORTING_PERIOD.periodFromRoute(routePathFromHash()),
      sessionPeriod: dashboardPeriodSessionValue(),
      currentPeriod: cur,
      periods,
    });
    if (initial.value && !periods.some((item) => item.value === initial.value)) {
      periods = REPORTING_PERIOD.normalizePeriods([...periods, {
        value: initial.value,
        has_data: false,
        is_current: initial.value === cur,
        updated_at: null,
      }]);
    }
    state.dashboardPeriods = periods;
    state.month = initial.value || cur;
    const reportRoute = dashboardReportRouteState();
    state.dashboardReport.periodType = reportRoute?.type || 'MONTH';
    state.dashboardReport.periodValue = reportRoute?.value || state.month;
    state.dashboardPeriodNotice = initial.fallback_from_current
      ? `${REPORTING_PERIOD.labelForPeriod(cur)} chưa có dữ liệu. Đang hiển thị kỳ gần nhất: ${REPORTING_PERIOD.labelForPeriod(state.month)}.`
      : '';
    rememberDashboardPeriod(state.month);
    renderDashboardPeriodControls();
    syncDashboardPeriodUrl({ replace: true });
  }
  ['month-picker', 'mobile-month-picker'].forEach((id) => {
    if ($(id)) $(id).addEventListener('change', (event) => {
      if (state.tab === 'overview') selectDashboardReportPeriod(event.target.value);
      else selectDashboardPeriod(event.target.value);
    });
  });
  document.querySelectorAll('[data-dashboard-period-type]').forEach((button) => {
    button.addEventListener('click', () => selectDashboardReportType(button.dataset.dashboardPeriodType));
  });
  [['period-previous', 'previous'], ['mobile-period-previous', 'previous'], ['period-next', 'next'], ['mobile-period-next', 'next']]
    .forEach(([id, direction]) => {
      if (!$(id)) return;
      $(id).addEventListener('click', () => {
        if (state.tab === 'overview') {
          selectDashboardReportPeriod(offsetDashboardReportValue(state.dashboardReport.periodType, state.dashboardReport.periodValue, direction === 'previous' ? -1 : 1));
          return;
        }
        const adjacent = REPORTING_PERIOD.adjacentPeriods(state.dashboardPeriods, state.month);
        if (adjacent[direction]) selectDashboardPeriod(adjacent[direction]);
      });
    });
  ['period-current', 'mobile-period-current'].forEach((id) => {
    if ($(id)) $(id).addEventListener('click', () => {
      if (state.tab === 'overview') selectDashboardReportPeriod(currentDashboardReportValue(state.dashboardReport.periodType));
      else selectDashboardPeriod(currentMonthVN());
    });
  });

  let workspaceReloadTimer = null;

  function workspaceModuleLabel(module) {
    if (module === 'EVALUATION') return 'Phiếu đánh giá';
    return module || '—';
  }

  function workspaceRoute(route) {
    const target = String(route || '').trim();
    if (!target.startsWith('/qlcl/#/')) return;
    window.location.assign(target);
  }

  function workspaceOpenButton(item) {
    const button = el('button', {
      className: 'btn-primary workspace-action',
      text: 'Mở xử lý',
      attrs: { type: 'button', 'data-action-id': 'workspace.open' },
    });
    setRegisteredButtonAction(button, 'workspace.open', () => workspaceRoute(item.route), {
      objectIdentity: item.entity_code,
    });
    return button;
  }

  function renderWorkspaceFilters(filters, selected) {
    const setOptions = (select, items, allLabel) => {
      if (!select) return;
      select.textContent = '';
      select.appendChild(el('option', { text: allLabel, attrs: { value: '' } }));
      (items || []).forEach((item) => {
        const value = typeof item === 'string' ? item : item.value;
        const label = typeof item === 'string' ? item : item.label;
        select.appendChild(el('option', { text: label, attrs: { value } }));
      });
    };
    setOptions($('workspace-status-filter'), filters.statuses, 'Tất cả trạng thái');
    if ($('workspace-status-filter')) $('workspace-status-filter').value = selected.status;
  }

  function renderWorkspace(payload, selected) {
    const summary = payload.summary || {};
    setText('workspace-summary-need-action', fmtInt(summary.need_action || 0));
    setText('workspace-summary-overdue', fmtInt(summary.overdue || 0));
    setText('workspace-summary-due-soon', fmtInt(summary.due_soon || 0));
    setText('workspace-summary-handled', fmtInt(summary.handled_recent || 0));
    renderWorkspaceFilters(payload.available_filters || {}, selected);

    const pagination = payload.pagination || { page: 1, page_size: 20, total: 0, total_pages: 1 };
    const rows = (payload.items || []).filter((item) => item.module === 'EVALUATION');
    const tbody = $('workspace-tbody');
    tbody.textContent = '';
    rows.forEach((item) => {
      const tr = el('tr');
      tr.appendChild(labeledTd('Loại việc', { text: workspaceModuleLabel(item.module) }));
      const codeTd = labeledTd('Mã / Nhà cung cấp');
      const codeWrap = el('div', { className: 'workspace-code' });
      codeWrap.appendChild(el('span', { className: 'mono', text: item.entity_code || '—' }));
      codeWrap.appendChild(el('span', { className: 'supplier', text: item.supplier_name || '—', attrs: { title: item.supplier_name || '' } }));
      codeTd.appendChild(codeWrap);
      tr.appendChild(codeTd);
      const taskTd = labeledTd('Việc cần làm');
      taskTd.appendChild(el('div', { className: 'workspace-task-label', text: item.task_label || '—' }));
      if (item.product_count) {
        taskTd.appendChild(el('div', {
          className: 'workspace-task-meta',
          text: `${item.actionable_product_count || 0}/${item.product_count} sản phẩm cần xử lý`,
        }));
      }
      tr.appendChild(taskTd);
      const statusTd = labeledTd('Trạng thái');
      statusTd.appendChild(statusBadge(item.status || '—'));
      tr.appendChild(statusTd);
      const dueText = item.due_date ? isoToVNDate(item.due_date) : '—';
      const overdueText = Number(item.overdue_days || 0) > 0 ? ` · quá ${item.overdue_days} ngày` : '';
      tr.appendChild(labeledTd('Hạn xử lý', {
        className: `mono workspace-due${Number(item.overdue_days || 0) > 0 ? ' overdue' : ''}`,
        text: dueText + overdueText,
      }));
      const actionTd = labeledTd('Hành động', { className: 'table-action-cell' });
      actionTd.appendChild(workspaceOpenButton(item));
      tr.appendChild(actionTd);
      tbody.appendChild(tr);
    });
    $('workspace-empty').classList.toggle('hidden', rows.length > 0);
    setText('workspace-total', `${pagination.total || 0} việc`);
    setText('workspace-page-meta', pagination.total
      ? `${(pagination.page - 1) * pagination.page_size + 1}-${Math.min(pagination.page * pagination.page_size, pagination.total)} / ${pagination.total} việc`
      : '0 việc');
    setText('workspace-page-label', `${pagination.page || 1} / ${pagination.total_pages || 1}`);
    $('workspace-prev-page').disabled = Number(pagination.page || 1) <= 1;
    $('workspace-next-page').disabled = Number(pagination.page || 1) >= Number(pagination.total_pages || 1);
    $('workspace-prev-page').dataset.page = String(Math.max(1, Number(pagination.page || 1) - 1));
    $('workspace-next-page').dataset.page = String(Math.min(Number(pagination.total_pages || 1), Number(pagination.page || 1) + 1));

    const recentList = $('workspace-recent-list');
    recentList.textContent = '';
    const recent = (payload.recent || []).filter((item) => item.module === 'EVALUATION');
    if (!recent.length) {
      recentList.appendChild(el('div', { className: 'workspace-empty', text: 'Chưa có công việc được bạn xử lý trong 7 ngày gần đây.' }));
    } else {
      recent.forEach((item) => {
        const row = el('div', { className: 'workspace-recent-item' });
        const identity = el('div', { className: 'workspace-code' });
        identity.appendChild(el('span', { className: 'mono', text: item.entity_code || '—' }));
        identity.appendChild(el('span', { className: 'supplier', text: item.supplier_name || '—' }));
        row.appendChild(identity);
        const detail = el('div');
        detail.appendChild(el('div', { className: 'workspace-task-label', text: item.task_label || 'Đã xử lý' }));
        detail.appendChild(el('div', { className: 'workspace-task-meta', text: [workspaceModuleLabel(item.module), notificationTime(item.acted_at)].filter(Boolean).join(' · ') }));
        row.appendChild(detail);
        row.appendChild(workspaceOpenButton(item));
        recentList.appendChild(row);
      });
    }
  }

  async function loadWorkspace() {
    const routeParams = recordRouteParams();
    const selected = {
      q: String(routeParams.get('q') || ''),
      status: String(routeParams.get('status') || ''),
      due: String(routeParams.get('due') || ''),
      module: 'EVALUATION',
      page: Math.max(1, Number.parseInt(routeParams.get('page'), 10) || 1),
    };
    if ($('workspace-search')) $('workspace-search').value = selected.q;
    if ($('workspace-due-filter')) $('workspace-due-filter').value = selected.due;
    $('workspace-loading').classList.remove('hidden');
    $('workspace-empty').classList.add('hidden');
    const params = new URLSearchParams();
    Object.entries(selected).forEach(([key, value]) => {
      if (value && !(key === 'page' && value === 1)) params.set(key, value);
    });
    params.set('module', 'EVALUATION');
    const r = await api('/workspace' + (params.size ? '?' + params.toString() : ''));
    $('workspace-loading').classList.add('hidden');
    if (!r.ok) {
      $('workspace-tbody').textContent = '';
      $('workspace-empty').textContent = apiErrorMessage(r.data?.error, 'Không tải được công việc.');
      $('workspace-empty').classList.remove('hidden');
      return;
    }
    $('workspace-empty').textContent = 'Không có công việc phù hợp.';
    renderWorkspace(r.data || {}, selected);
  }

  function syncWorkspaceRoute(page = 1) {
    const params = new URLSearchParams();
    const values = {
      q: String($('workspace-search')?.value || '').trim(),
      status: String($('workspace-status-filter')?.value || ''),
      due: String($('workspace-due-filter')?.value || ''),
    };
    Object.entries(values).forEach(([key, value]) => { if (value) params.set(key, value); });
    params.set('module', 'EVALUATION');
    if (page > 1) params.set('page', String(page));
    const target = '/workspace' + (params.size ? '?' + params.toString() : '');
    if (routePathFromHash() === target) loadWorkspace();
    else window.location.hash = target;
  }

  ['workspace-status-filter', 'workspace-due-filter'].forEach((id) => {
    if ($(id)) $(id).addEventListener('change', () => syncWorkspaceRoute(1));
  });
  if ($('workspace-search')) $('workspace-search').addEventListener('input', () => {
    window.clearTimeout(workspaceReloadTimer);
    workspaceReloadTimer = window.setTimeout(() => syncWorkspaceRoute(1), 250);
  });
  if ($('workspace-prev-page')) $('workspace-prev-page').addEventListener('click', () => syncWorkspaceRoute(Number($('workspace-prev-page').dataset.page || 1)));
  if ($('workspace-next-page')) $('workspace-next-page').addEventListener('click', () => syncWorkspaceRoute(Number($('workspace-next-page').dataset.page || 1)));

  const ROUTE_LOADERS = Object.freeze({
    'workspace': loadWorkspace,
    'overview': loadOverview,
    'approvals': loadWorkflowTab,
    'evaluations': loadWorkflowTab,
    'evaluation-new': loadWorkflowTab,
    'scoring': loadWorkflowTab,
    'suppliers': loadWorkflowTab,
    'reports': loadWorkflowTab,
    'admin': loadAdminDashboard,
    'admin-users': loadAdmin,
    'admin-roles': loadAdmin,
    'admin-personnel-import': loadAdmin,
    'admin-approval-assignments': loadAdmin,
    'admin-question-templates': loadAdmin,
    'admin-report-templates': loadAdmin,
    'admin-scoring-policies': loadAdmin,
    'admin-system-logs': loadAdmin,
  });

  const ROUTE_REGISTRY = Object.freeze(Object.fromEntries(routeItems.map((item) => [item.route, Object.freeze({
    id: item.id,
    view: item.view,
    loader: ROUTE_LOADERS[item.id] || null,
  })])));

  function loadTab() {
    if (state.routeAccessStatus !== 'allowed') return undefined;
    const item = navigationItem(state.tab);
    const registration = item?.route ? ROUTE_REGISTRY[item.route] : null;
    if (!registration || registration.id !== item.id || registration.view !== item.view || typeof registration.loader !== 'function') {
      activateRouteResolution({ status: 'not_found', item }, { updateHash: false });
      return undefined;
    }
    const dashboardRequestId = shouldShowGlobalPeriod() ? ++state.dashboardRequestId : 0;
    const result = registration.loader(dashboardRequestId);
    if (result && typeof result.finally === 'function') return result.finally(requestTableLabelHydration);
    requestTableLabelHydration();
    return result;
  }

  // ============ Tab: Tổng quan ============
  function dashboardRequestActive(requestId, month) {
    return requestId === state.dashboardRequestId && month === state.month;
  }

  let statisticalDashboardPayload = null;
  const DASHBOARD_STATUS_COLORS = Object.freeze({
    DRAFT: '#F3C7CB', IN_PROGRESS: '#E98D95', WAITING_APPROVAL: '#E45C68',
    WAITING_CORRECTION: '#DC3545', ROUND_2: '#F02D48',
    COMPLETED: '#A30D22', CANCELLED: '#540812',
  });
  const DASHBOARD_RATING_COLORS = Object.freeze({
    FAILED: '#220006', BASIC: '#73000E', GOOD: '#BA001D', HIGH: '#E53945',
  });
  const DASHBOARD_DETAIL_COLORS = Object.freeze({ passed: '#E53945', failed: '#220006', violation: '#BA001D' });
  const DASHBOARD_DONUT_EXCLUDED_STATUS_CODES = new Set(['EXTENDED', 'SUSPENDED']);
  const DASHBOARD_KPIS = Object.freeze([
    ['evaluated_supplier_count', 'Số lượng NCC được đánh giá', '♙'],
    ['evaluation_ticket_count', 'Số phiếu đánh giá NCC', '▤'],
    ['passed_ticket_count', 'Số phiếu đạt', '✓'],
    ['failed_ticket_count', 'Số phiếu không đạt', '!'],
  ]);

  function dashboardReportKey() {
    const report = state.dashboardReport;
    return JSON.stringify([report.periodType, report.periodValue, report.filters]);
  }

  function dashboardReportQuery() {
    const report = state.dashboardReport;
    const params = new URLSearchParams({ periodType: report.periodType, periodValue: report.periodValue });
    Object.entries(report.filters).forEach(([key, values]) => {
      if (values.length) params.set(key, values.join(','));
    });
    return params.toString();
  }

  function dashboardReportRequestActive(requestId, key) {
    return requestId === state.dashboardRequestId && key === dashboardReportKey();
  }

  function renderDashboardLoading() {
    const cards = $('statistics-kpi-cards');
    cards.textContent = '';
    DASHBOARD_KPIS.forEach(() => cards.appendChild(el('div', { className: 'statistics-kpi-card statistics-skeleton' })));
    $('statistics-ranking-body').textContent = '';
    $('status-donut-legend').textContent = '';
    $('status-donut-total').textContent = '—';
    $('status-donut-empty').classList.add('hidden');
    $('statistics-ranking-empty').classList.add('hidden');
    $('quality-trend-empty').classList.add('hidden');
    $('rating-distribution-total').textContent = '';
    $('rating-distribution-bar').textContent = '';
    $('rating-distribution-legend').textContent = '';
    $('industry-performance-chart').textContent = '';
    $('industry-performance-empty').classList.add('hidden');
    $('rating-distribution-empty').classList.add('hidden');
    $('violation-distribution-empty').classList.add('hidden');
  }

  function comparisonText(value) {
    const change = Number(value?.absolute_change || 0);
    if (!change) return 'Không đổi so với kỳ trước';
    const arrow = change > 0 ? '↑' : '↓';
    const pct = value.percentage_change;
    return `${arrow} ${pct == null ? `${Math.abs(change)} phiếu` : `${Math.abs(pct).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%`} so với kỳ trước`;
  }

  function renderStatisticKpi(id, title, icon, value) {
    const node = el('article', { className: 'statistics-kpi-card', attrs: { 'data-kpi-id': id, 'aria-label': title } });
    const head = el('div', { className: 'statistics-kpi-head' });
    head.appendChild(el('div', { className: 'statistics-kpi-label', text: title }));
    head.appendChild(el('span', { className: 'statistics-kpi-icon', text: icon, attrs: { 'aria-hidden': 'true' } }));
    node.appendChild(head);
    node.appendChild(el('strong', { className: 'statistics-kpi-value', text: fmtInt(Number(value?.current_value || 0)) }));
    node.appendChild(el('span', {
      className: `statistics-kpi-comparison ${String(value?.sentiment || '').toLowerCase()}`,
      text: comparisonText(value),
    }));
    return node;
  }

  function dashboardFilterLabel(key) {
    return key === 'regions' ? 'Khu vực' : key === 'evaluationTypes' ? 'Loại đánh giá' : 'Ngành hàng - MCH2';
  }

  function dashboardFilterOptionsKey(key) {
    return key === 'evaluationTypes' ? 'evaluation_types' : key;
  }

  function renderDashboardFilter(host) {
    const key = host.dataset.filterKey;
    const selected = state.dashboardReport.filters[key];
    const options = state.dashboardReport.filterOptions[dashboardFilterOptionsKey(key)] || [];
    host.textContent = '';
    host.appendChild(el('label', { text: dashboardFilterLabel(key) }));
    const trigger = el('button', { className: 'dashboard-filter-trigger', attrs: { type: 'button', 'aria-expanded': 'false' } });
    trigger.appendChild(el('span', { text: selected.length ? `${selected.length} mục đã chọn` : 'Tất cả' }));
    trigger.appendChild(el('b', { text: selected.length ? String(selected.length) : '⌄' }));
    host.appendChild(trigger);
    const menu = el('div', { className: 'dashboard-filter-menu hidden' });
    const search = el('input', { className: 'input', attrs: { type: 'search', placeholder: 'Tìm kiếm...', 'aria-label': `Tìm ${dashboardFilterLabel(key)}` } });
    menu.appendChild(search);
    const actions = el('div', { className: 'dashboard-filter-actions' });
    const all = el('button', { text: 'Chọn tất cả', attrs: { type: 'button' } });
    const clear = el('button', { text: 'Xóa lựa chọn', attrs: { type: 'button' } });
    actions.append(all, clear);
    menu.appendChild(actions);
    const optionHost = el('div', { className: 'dashboard-filter-options' });
    menu.appendChild(optionHost);
    host.appendChild(menu);
    const drawOptions = () => {
      optionHost.textContent = '';
      const query = normalizedMasterText(search.value);
      options.filter((value) => !query || normalizedMasterText(value).includes(query)).forEach((value) => {
        const label = el('label', { className: 'dashboard-filter-option' });
        const checkbox = el('input', { attrs: { type: 'checkbox', value } });
        checkbox.checked = selected.includes(value);
        checkbox.addEventListener('change', () => {
          const next = new Set(state.dashboardReport.filters[key]);
          if (checkbox.checked) next.add(value); else next.delete(value);
          state.dashboardReport.filters[key] = [...next];
          renderDashboardFilters();
          loadTab();
        });
        label.append(checkbox, el('span', { text: value }));
        optionHost.appendChild(label);
      });
      if (!optionHost.childElementCount) optionHost.appendChild(el('div', { className: 'muted', text: 'Không có giá trị phù hợp.' }));
    };
    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      document.querySelectorAll('.dashboard-filter-menu').forEach((node) => { if (node !== menu) node.classList.add('hidden'); });
      menu.classList.toggle('hidden');
      trigger.setAttribute('aria-expanded', menu.classList.contains('hidden') ? 'false' : 'true');
      if (!menu.classList.contains('hidden')) search.focus();
    });
    menu.addEventListener('click', (event) => event.stopPropagation());
    search.addEventListener('input', drawOptions);
    all.addEventListener('click', () => {
      state.dashboardReport.filters[key] = [...options];
      renderDashboardFilters();
      loadTab();
    });
    clear.addEventListener('click', () => {
      state.dashboardReport.filters[key] = [];
      renderDashboardFilters();
      loadTab();
    });
    drawOptions();
  }

  function renderDashboardFilters() {
    ['dashboard-filter-region', 'dashboard-filter-evaluation-type', 'dashboard-filter-mch2'].forEach((id) => {
      if ($(id)) renderDashboardFilter($(id));
    });
  }

  document.addEventListener('click', () => document.querySelectorAll('.dashboard-filter-menu').forEach((node) => node.classList.add('hidden')));

  function showStatisticsTooltip(event, lines) {
    const tooltip = $('statistics-tooltip');
    tooltip.textContent = '';
    lines.forEach((line, index) => tooltip.appendChild(el(index ? 'div' : 'strong', { text: line })));
    tooltip.classList.remove('hidden');
    const tooltipWidth = tooltip.offsetWidth || 280;
    const tooltipHeight = tooltip.offsetHeight || 130;
    tooltip.style.left = `${Math.max(8, Math.min(window.innerWidth - tooltipWidth - 8, event.clientX + 14))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(window.innerHeight - tooltipHeight - 8, event.clientY + 14))}px`;
  }

  function hideStatisticsTooltip() {
    $('statistics-tooltip')?.classList.add('hidden');
  }

  function drawStatusDonut(distribution) {
    const canvas = $('status-donut-canvas');
    const context = canvas.getContext('2d');
    const items = (distribution.items || [])
      .filter((item) => !DASHBOARD_DONUT_EXCLUDED_STATUS_CODES.has(item.code) && Number(item.count || 0) > 0)
      .map((item) => ({ ...item, count: Number(item.count || 0) }));
    const total = items.reduce((sum, item) => sum + Number(item.count || 0), 0);
    items.forEach((item) => {
      item.percentage = total ? Math.round((item.count / total) * 1000) / 10 : 0;
    });
    if (!items.some((item) => item.code === state.dashboardReport.selectedStatus)) state.dashboardReport.selectedStatus = '';
    $('status-donut-total').textContent = fmtInt(total);
    $('status-donut-empty').classList.toggle('hidden', total > 0);
    $('statistics-donut-content').classList.toggle('hidden', total === 0);
    const legend = $('status-donut-legend');
    legend.textContent = '';
    items.forEach((item) => {
      const button = el('button', {
        className: `statistics-status-item${state.dashboardReport.selectedStatus === item.code ? ' active' : ''}${state.dashboardReport.selectedStatus && state.dashboardReport.selectedStatus !== item.code ? ' muted' : ''}`,
        attrs: { type: 'button', 'data-status-code': item.code, 'aria-label': item.label },
      });
      button.append(el('i', { className: 'statistics-status-dot', attrs: { style: `background:${DASHBOARD_STATUS_COLORS[item.code]}` } }), el('span', { text: item.label }));
      button.addEventListener('click', () => {
        state.dashboardReport.selectedStatus = state.dashboardReport.selectedStatus === item.code ? '' : item.code;
        drawStatusDonut(distribution);
      });
      legend.appendChild(button);
    });
    const size = 250;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * ratio; canvas.height = size * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, size, size);
    if (!total) return;
    const active = state.dashboardReport.selectedStatus;
    let angle = -Math.PI / 2;
    const arcs = [];
    items.forEach((item) => {
      const next = angle + (Math.PI * 2 * item.count / total);
      if (item.count) {
        context.beginPath(); context.arc(125, 125, 94, angle, next); context.strokeStyle = DASHBOARD_STATUS_COLORS[item.code];
        context.globalAlpha = active && active !== item.code ? .25 : 1; context.lineWidth = active === item.code ? 46.5 : 40.5; context.stroke(); context.globalAlpha = 1;
        arcs.push({ start: angle, end: next, item });
      }
      angle = next;
    });
    const arcAt = (event) => {
      const rect = canvas.getBoundingClientRect();
      const x = (event.clientX - rect.left) * size / rect.width - 125;
      const y = (event.clientY - rect.top) * size / rect.height - 125;
      let target = Math.atan2(y, x);
      if (target < -Math.PI / 2) target += Math.PI * 2;
      return Math.hypot(x, y) >= 69 && Math.hypot(x, y) <= 118 ? arcs.find((arc) => target >= arc.start && target <= arc.end) : null;
    };
    canvas._dashboardDonutMove = (event) => {
      const arc = arcAt(event);
      if (!arc) return hideStatisticsTooltip();
      showStatisticsTooltip(event, [arc.item.label, `Số phiếu: ${fmtInt(arc.item.count)}`, `Tỷ lệ: ${arc.item.percentage.toLocaleString('vi-VN')}%`]);
    };
    canvas._dashboardDonutClick = (event) => {
      const arc = arcAt(event);
      if (!arc) return;
      state.dashboardReport.selectedStatus = state.dashboardReport.selectedStatus === arc.item.code ? '' : arc.item.code;
      drawStatusDonut(distribution);
    };
    if (!canvas.dataset.dashboardEventsBound) {
      canvas.addEventListener('mousemove', (event) => canvas._dashboardDonutMove?.(event));
      canvas.addEventListener('mouseleave', hideStatisticsTooltip);
      canvas.addEventListener('click', (event) => canvas._dashboardDonutClick?.(event));
      canvas.dataset.dashboardEventsBound = 'true';
    }
  }

  function renderRanking(rows) {
    const body = $('statistics-ranking-body');
    body.textContent = '';
    $('statistics-ranking-content').classList.toggle('hidden', !rows.length);
    $('statistics-ranking-empty').classList.toggle('hidden', rows.length > 0);
    rows.forEach((row) => {
      const tr = el('tr', { attrs: { tabindex: '0', title: row.supplier_name } });
      tr.appendChild(el('td', { className: 'mono', text: String(row.rank).padStart(2, '0') }));
      const supplier = el('td');
      supplier.append(el('div', { className: 'statistics-ranking-name', text: row.supplier_name, attrs: { title: row.supplier_name } }), el('small', { className: 'statistics-ranking-code', text: row.supplier_code || 'Chưa có mã NCC' }));
      tr.appendChild(supplier);
      const scoreText = Number(row.average_final_score).toLocaleString('vi-VN', { maximumFractionDigits: 1 });
      tr.appendChild(el('td', { className: 'statistics-score', text: `${scoreText}%` }));
      const grade = el('td'); grade.appendChild(el('span', { className: `statistics-grade${row.classification === 'Không đạt' ? ' failed' : ''}`, text: row.classification })); tr.appendChild(grade);
      const open = () => { state.evalSearch = row.supplier_code || row.supplier_name; navigateToTab('evaluations'); };
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', (event) => { if (event.key === 'Enter') open(); });
      body.appendChild(tr);
    });
  }

  function drawQualityTrend(payload = statisticalDashboardPayload) {
    const canvas = $('quality-trend-canvas');
    const empty = $('quality-trend-empty');
    const rows = (Array.isArray(payload?.trend) ? payload.trend : []).map((row) => {
      const passed = Math.max(0, Number(row.passed_ticket_count || 0));
      const failed = Math.max(0, Number(row.failed_ticket_count || 0));
      const calculatedTotal = passed + failed;
      const apiTotal = Number(row.evaluation_ticket_count);
      const total = Number.isFinite(apiTotal) && apiTotal === calculatedTotal ? apiTotal : calculatedTotal;
      return {
        ...row,
        passed_ticket_count: passed,
        failed_ticket_count: failed,
        evaluation_ticket_count: total,
        failed_rate: total ? failed / total : 0,
      };
    });
    const hasData = rows.some((row) => row.evaluation_ticket_count > 0);
    empty.classList.toggle('hidden', hasData);
    const context = canvas.getContext('2d');
    const width = Math.max(280, Math.round(canvas.parentElement?.clientWidth || 760));
    const height = 300;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * ratio; canvas.height = height * ratio; canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
    canvas._dashboardTrendHitTargets = [];
    if (!rows.length || !hasData) return;
    const styles = getComputedStyle(document.documentElement);
    const grid = styles.getPropertyValue('--border').trim() || '#e5e7eb';
    const textColor = styles.getPropertyValue('--muted').trim() || '#6b7280';
    const inkColor = styles.getPropertyValue('--text').trim() || '#1a2232';
    const surface = styles.getPropertyValue('--surface').trim() || '#fff';
    const passedColor = styles.getPropertyValue('--green').trim() || '#16a34a';
    const failedColor = styles.getPropertyValue('--red').trim() || '#e03040';
    const accentColor = styles.getPropertyValue('--accent').trim() || '#2563eb';
    const lineColor = '#9AA4B2';
    const sideMargin = width < 520 ? 42 : 56;
    const plot = { left: sideMargin, right: width - sideMargin, top: 38, bottom: height - 48 };
    const chartHeight = plot.bottom - plot.top;
    const step = (plot.right - plot.left) / rows.length;
    const maxTotal = Math.max(...rows.map((row) => row.evaluation_ticket_count));
    const rawCountStep = Math.max(1, maxTotal / 5);
    const countMagnitude = 10 ** Math.floor(Math.log10(rawCountStep));
    const normalizedCountStep = rawCountStep / countMagnitude;
    const countStep = (normalizedCountStep <= 1 ? 1 : normalizedCountStep <= 2 ? 2 : normalizedCountStep <= 5 ? 5 : 10) * countMagnitude;
    const maxCount = Math.max(countStep, Math.ceil(maxTotal / countStep) * countStep);
    const maxFailedRate = Math.max(...rows.map((row) => row.failed_rate));
    const maxRate = Math.min(1, Math.max(.5, Math.ceil(maxFailedRate / .25) * .25));
    const xAt = (index) => plot.left + step * index + step / 2;
    const yCount = (value) => plot.bottom - chartHeight * value / maxCount;
    const yRate = (value) => plot.bottom - chartHeight * Math.max(0, Math.min(maxRate, value)) / maxRate;
    const formatRate = (value) => `${(value * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%`;
    const periodLabel = (row) => {
      const month = String(row.period_value || '').match(/^(\d{4})-(\d{2})$/);
      if (month) return `${month[2]}/${month[1]}`;
      const quarter = String(row.period_value || '').match(/^(\d{4})-Q([1-4])$/);
      if (quarter) return `Q${quarter[2]}/${quarter[1]}`;
      return String(row.period_value || row.label || '');
    };
    context.font = '10px Be Vietnam Pro, system-ui'; context.textBaseline = 'middle';
    context.fillStyle = textColor; context.textAlign = 'left'; context.fillText('Số phiếu đánh giá', plot.left, 13);
    context.textAlign = 'right'; context.fillText('Tỷ lệ (%)', plot.right, 13);
    rows.forEach((row, index) => {
      if (!row.is_selected) return;
      const bandWidth = Math.min(112, step * .82);
      const bandX = xAt(index) - bandWidth / 2;
      context.beginPath(); context.roundRect(bandX, plot.top - 17, bandWidth, height - plot.top + 7, 9);
      context.fillStyle = 'rgba(37,99,235,.045)'; context.fill();
      context.strokeStyle = 'rgba(37,99,235,.12)'; context.lineWidth = 1; context.stroke();
    });
    for (let index = 0; index <= 5; index += 1) {
      const ratioValue = index / 5; const y = plot.bottom - chartHeight * ratioValue;
      context.beginPath(); context.strokeStyle = grid; context.lineWidth = 1; context.moveTo(plot.left, y); context.lineTo(plot.right, y); context.stroke();
      context.fillStyle = textColor; context.textAlign = 'right'; context.fillText(String(Math.round(maxCount * ratioValue)), plot.left - 8, y);
      context.textAlign = 'left'; context.fillText(`${Math.round(maxRate * ratioValue * 100)}%`, plot.right + 8, y);
    }
    const hitTargets = [];
    const drawSegment = (row, kind, x, y, segmentWidth, segmentHeight, color, radii) => {
      if (segmentHeight <= 0) return;
      context.beginPath(); context.roundRect(x, y, segmentWidth, segmentHeight, radii); context.fillStyle = color; context.fill();
      hitTargets.push({ kind, row, x, y, width: segmentWidth, height: segmentHeight });
    };
    rows.forEach((row, index) => {
      const columnWidth = Math.max(16, Math.min(78, step * .54));
      const x = xAt(index) - columnWidth / 2;
      const totalY = yCount(row.evaluation_ticket_count);
      const passedY = yCount(row.passed_ticket_count);
      drawSegment(row, 'passed', x, passedY, columnWidth, plot.bottom - passedY, passedColor, row.failed_ticket_count ? 0 : [6, 6, 0, 0]);
      drawSegment(row, 'failed', x, totalY, columnWidth, passedY - totalY, failedColor, [6, 6, 0, 0]);
      if (row.passed_ticket_count && row.failed_ticket_count) {
        context.beginPath(); context.strokeStyle = 'rgba(255,255,255,.55)'; context.lineWidth = 1; context.moveTo(x, passedY); context.lineTo(x + columnWidth, passedY); context.stroke();
      }
      const totalLabelY = row.evaluation_ticket_count ? Math.max(plot.top - 8, totalY - 11) : plot.bottom - 10;
      context.fillStyle = inkColor; context.font = '700 11px Be Vietnam Pro, system-ui'; context.textAlign = 'center'; context.fillText(fmtInt(row.evaluation_ticket_count), xAt(index), totalLabelY);
      const label = periodLabel(row);
      context.fillStyle = row.is_selected ? accentColor : textColor;
      context.textAlign = 'center';
      if (width < 520 && label.includes('/')) {
        const [periodPart, yearPart] = label.split('/');
        context.font = `${row.is_selected ? 750 : 600} 9px Be Vietnam Pro, system-ui`; context.fillText(periodPart, xAt(index), height - 25);
        context.font = `${row.is_selected ? 700 : 500} 7.5px Be Vietnam Pro, system-ui`; context.fillText(yearPart, xAt(index), height - 13);
      } else {
        context.font = `${row.is_selected ? 750 : 500} 10px Be Vietnam Pro, system-ui`; context.fillText(label, xAt(index), height - 18);
      }
    });
    context.beginPath();
    rows.forEach((row, index) => { const x = xAt(index); const y = yRate(row.failed_rate); if (index) context.lineTo(x, y); else context.moveTo(x, y); });
    context.strokeStyle = lineColor; context.lineWidth = 2.5; context.lineJoin = 'round'; context.lineCap = 'round'; context.stroke();
    rows.forEach((row, index) => {
      const x = xAt(index); const y = yRate(row.failed_rate); const radius = row.is_selected ? 4.5 : 3.5;
      context.beginPath(); context.arc(x, y, radius + 2.5, 0, Math.PI * 2); context.fillStyle = surface; context.fill();
      context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fillStyle = lineColor; context.fill();
      context.beginPath(); context.arc(x, y, Math.max(1.5, radius - 2), 0, Math.PI * 2); context.fillStyle = surface; context.fill();
      hitTargets.push({ kind: 'rate', row, x, y, radius: 10 });
      const totalLabelY = row.evaluation_ticket_count ? Math.max(plot.top - 8, yCount(row.evaluation_ticket_count) - 11) : plot.bottom - 10;
      let rateLabelY = y - 12;
      if (Math.abs(rateLabelY - totalLabelY) < 14) rateLabelY = y + 13;
      if (rateLabelY > plot.bottom - 8) rateLabelY = y - 12;
      if (width >= 560 || row.is_selected) {
        context.fillStyle = inkColor; context.font = `${row.is_selected ? 750 : 600} 9.5px Be Vietnam Pro, system-ui`; context.textAlign = 'center'; context.fillText(formatRate(row.failed_rate), x, rateLabelY);
      }
    });
    canvas._dashboardTrendHitTargets = hitTargets;
    canvas._dashboardTrendMove = (event) => {
      const rect = canvas.getBoundingClientRect();
      const pointer = { x: (event.clientX - rect.left) * width / rect.width, y: (event.clientY - rect.top) * height / rect.height };
      const rateTarget = hitTargets.find((target) => target.kind === 'rate' && Math.hypot(pointer.x - target.x, pointer.y - target.y) <= target.radius);
      const segmentTarget = hitTargets.find((target) => target.kind !== 'rate' && pointer.x >= target.x && pointer.x <= target.x + target.width && pointer.y >= target.y && pointer.y <= target.y + target.height);
      const target = rateTarget || segmentTarget;
      if (!target) { hideStatisticsTooltip(); return; }
      if (target.kind === 'rate') {
        showStatisticsTooltip(event, [target.row.label, 'Tỷ lệ không đạt', formatRate(target.row.failed_rate)]);
        return;
      }
      const passed = target.kind === 'passed';
      showStatisticsTooltip(event, [target.row.label, passed ? 'Phiếu đạt' : 'Phiếu không đạt', `${fmtInt(passed ? target.row.passed_ticket_count : target.row.failed_ticket_count)} phiếu`]);
    };
    if (!canvas.dataset.dashboardEventsBound) {
      canvas.addEventListener('mousemove', (event) => canvas._dashboardTrendMove?.(event));
      canvas.addEventListener('mouseleave', hideStatisticsTooltip);
      canvas.dataset.dashboardEventsBound = 'true';
    }
  }

  function setupDashboardCanvas(canvas, height) {
    const width = Math.max(280, Math.round(canvas.parentElement?.clientWidth || 640));
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    return { context, width, height };
  }

  function clippedCanvasText(context, text, maxWidth) {
    const value = String(text || '');
    if (context.measureText(value).width <= maxWidth) return value;
    let output = value;
    while (output.length > 1 && context.measureText(`${output}…`).width > maxWidth) output = output.slice(0, -1);
    return `${output}…`;
  }

  function clearDashboardCanvas(id) {
    const canvas = $(id);
    if (!canvas) return;
    if (typeof canvas.getContext === 'function') {
      canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    canvas.textContent = '';
  }

  function displayCorrectiveRequirementName(value) {
    return String(value || '').normalize('NFC').trim().replace(/\s+/gu, ' ');
  }

  function normalizedCorrectiveRequirementName(value) {
    return displayCorrectiveRequirementName(value).normalize('NFKC').toLocaleLowerCase('vi-VN');
  }

  function correctiveRequirementTokens(value) {
    return normalizedCorrectiveRequirementName(value).split(/[^\p{L}\p{N}]+/gu).filter(Boolean);
  }

  function correctiveRequirementSimilarity(name, query) {
    const candidate = normalizedCorrectiveRequirementName(name);
    const searched = normalizedCorrectiveRequirementName(query);
    if (!searched) return 1;
    if (candidate === searched) return 100;
    if (candidate.startsWith(searched) || searched.startsWith(candidate)) return 85;
    if (candidate.includes(searched) || searched.includes(candidate)) return 70;
    const queryTokens = correctiveRequirementTokens(searched);
    const candidateTokens = new Set(correctiveRequirementTokens(candidate));
    if (!queryTokens.length) return 0;
    const overlap = queryTokens.filter((token) => candidateTokens.has(token)).length;
    return overlap ? 35 + Math.round((overlap / Math.max(queryTokens.length, candidateTokens.size)) * 30) : 0;
  }

  function matchingCorrectiveRequirements(query, includeWeak) {
    const searched = normalizedCorrectiveRequirementName(query);
    return correctiveRequirementItems
      .map((item) => ({ item, score: correctiveRequirementSimilarity(item.name, searched) }))
      .filter((entry) => !searched || entry.score >= (includeWeak ? 35 : 70))
      .sort((a, b) => b.score - a.score || String(a.item.name).localeCompare(String(b.item.name), 'vi'));
  }

  function closeCorrectiveRequirementOptions() {
    const options = $('corrective-requirement-options');
    if (options) options.classList.add('hidden');
    if (activeCorrectiveRequirementInput) activeCorrectiveRequirementInput.setAttribute('aria-expanded', 'false');
    activeCorrectiveRequirementInput = null;
  }

  function positionCorrectiveRequirementOptions(input) {
    const options = $('corrective-requirement-options');
    if (!options || !input || typeof input.getBoundingClientRect !== 'function') return;
    const anchor = input.closest('.corrective-requirement-combobox') || input;
    const rect = anchor.getBoundingClientRect();
    const viewportWidth = Math.max(280, window.innerWidth || document.documentElement.clientWidth || 280);
    const viewportHeight = Math.max(320, window.innerHeight || document.documentElement.clientHeight || 320);
    const width = Math.min(Math.max(240, rect.width), viewportWidth - 16);
    const left = Math.max(8, Math.min(rect.left, viewportWidth - width - 8));
    const dropdownHeight = Math.min(280, options.scrollHeight || 280);
    const spaceBelow = viewportHeight - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    const openAbove = spaceBelow < Math.min(180, dropdownHeight) && spaceAbove > spaceBelow;
    const top = openAbove
      ? Math.max(8, rect.top - dropdownHeight - 4)
      : Math.min(viewportHeight - dropdownHeight - 8, rect.bottom + 4);
    options.style.left = `${left}px`;
    options.style.top = `${Math.max(8, top)}px`;
    options.style.width = `${width}px`;
  }

  function renderCorrectiveRequirementOptions(input) {
    const options = $('corrective-requirement-options');
    if (!options || !input) return;
    const query = displayCorrectiveRequirementName(input.value);
    const matches = matchingCorrectiveRequirements(query, false);
    const exact = correctiveRequirementItems.some((item) => normalizedCorrectiveRequirementName(item.name) === normalizedCorrectiveRequirementName(query));
    options.textContent = '';
    options.appendChild(el('div', {
      className: 'corrective-requirement-options-label',
      text: query ? (matches.length ? 'Có thể bạn đang tìm' : 'Không có kết quả trùng') : 'Danh mục yêu cầu',
    }));
    matches.forEach(({ item }) => {
      options.appendChild(el('button', {
        className: 'corrective-requirement-option',
        text: item.name,
        attrs: { 'data-corrective-requirement-option-id': String(item.id || ''), 'data-corrective-requirement-option-name': item.name },
      }));
    });
    if (!matches.length && !query) options.appendChild(el('div', { className: 'corrective-requirement-options-empty', text: 'Chưa có yêu cầu đang hoạt động.' }));
    if (query && !exact && query.length <= 120) {
      options.appendChild(el('div', { className: 'corrective-requirement-options-separator' }));
      options.appendChild(el('button', {
        className: 'corrective-requirement-option create',
        text: `+ Thêm “${query}”`,
        attrs: { 'data-corrective-requirement-create': 'true' },
      }));
    }
    activeCorrectiveRequirementInput = input;
    input.setAttribute('aria-expanded', 'true');
    options.classList.remove('hidden');
    positionCorrectiveRequirementOptions(input);
  }

  function rememberCorrectiveRequirement(item) {
    if (!item?.name) return item;
    const normalized = item.normalized_name || normalizedCorrectiveRequirementName(item.name);
    const index = correctiveRequirementItems.findIndex((entry) => normalizedCorrectiveRequirementName(entry.name) === normalized);
    const canonical = { ...item, normalized_name: normalized };
    if (index >= 0) correctiveRequirementItems[index] = canonical;
    else correctiveRequirementItems.push(canonical);
    return canonical;
  }

  async function applyCorrectiveRequirementSelection(input, item) {
    if (!input || !item) return;
    const canonical = rememberCorrectiveRequirement(item);
    input.value = canonical.name;
    input.setAttribute('data-corrective-requirement-selected', 'true');
    if (canonical.id) input.setAttribute('data-corrective-requirement-id', String(canonical.id));
    else input.removeAttribute('data-corrective-requirement-id');
    closeCorrectiveRequirementOptions();
    const validationId = input.getAttribute('data-nc-remediation');
    if (input.hasAttribute('data-nc-draft-remediation')) {
      saveDraftNonconformityRequirementInput(input);
      if (issueMatchesNonconformity(scoringValidationTarget, { _validation_id: validationId }, 'remediation')) {
        clearScoringValidationIssue();
        clearValidationDecorationsNear(input);
      }
      $('scoring-msg').textContent = 'Đã ghi nhận yêu cầu khắc phục.';
      return;
    }
    const ticket = selectedTicket();
    const row = (ticket?.nonconformities || []).find((entry) => String(entry.id) === String(validationId));
    if (!ticket || !row) return;
    try {
      await updateNonconformityRequirement(ticket, row, {
        remediation: canonical.name,
        corrective_requirement_id: canonical.id || null,
      });
      if (issueMatchesNonconformity(scoringValidationTarget, { id: validationId }, 'remediation')) clearScoringValidationIssue();
      $('scoring-msg').textContent = 'Đã lưu yêu cầu khắc phục.';
      renderScoring();
    } catch (error) {
      $('scoring-msg').textContent = apiErrorMessage(error?.message, 'Không lưu được yêu cầu khắc phục.');
      renderScoring();
    }
  }

  function openCorrectiveRequirementCreateModal(input) {
    const name = displayCorrectiveRequirementName(input?.value);
    if (!input || !name || name.length > 120) return;
    correctiveRequirementCreateTarget = input;
    closeCorrectiveRequirementOptions();
    const similar = matchingCorrectiveRequirements(name, true)
      .filter(({ item }) => normalizedCorrectiveRequirementName(item.name) !== normalizedCorrectiveRequirementName(name))
      .slice(0, 3);
    $('corrective-requirement-name').value = name;
    $('corrective-requirement-error').textContent = '';
    const warning = $('corrective-requirement-similar-warning');
    warning.textContent = similar.length
      ? `Đã có mục gần giống: ${similar.map(({ item }) => item.name).join('; ')}. Hãy kiểm tra trước khi tạo mục mới.`
      : '';
    warning.classList.toggle('hidden', similar.length === 0);
    $('corrective-requirement-cancel').textContent = similar.length ? 'Quay lại chọn' : 'Hủy';
    $('corrective-requirement-submit').textContent = similar.length ? 'Vẫn thêm mới' : 'Thêm và sử dụng';
    $('corrective-requirement-modal').classList.remove('hidden');
    $('corrective-requirement-submit').focus();
  }

  function closeCorrectiveRequirementCreateModal(returnFocus) {
    $('corrective-requirement-modal')?.classList.add('hidden');
    if (returnFocus && correctiveRequirementCreateTarget?.isConnected) {
      correctiveRequirementCreateTarget.focus();
      renderCorrectiveRequirementOptions(correctiveRequirementCreateTarget);
    }
    if (!returnFocus) correctiveRequirementCreateTarget = null;
  }

  function fitDashboardSegmentLabels(container, selector, minimumWidth = 44) {
    window.requestAnimationFrame(() => {
      container.querySelectorAll(selector).forEach((segment) => {
        segment.classList.toggle('has-label', segment.getBoundingClientRect().width >= minimumWidth);
      });
    });
  }

  function drawRatingDistribution(distribution) {
    const content = $('rating-distribution-content');
    const empty = $('rating-distribution-empty');
    const totalLabel = $('rating-distribution-total');
    const bar = $('rating-distribution-bar');
    const legend = $('rating-distribution-legend');
    const items = distribution?.items || [];
    const total = Number(distribution?.total_suppliers || items.reduce((sum, item) => sum + Number(item.count || 0), 0));
    content.classList.toggle('hidden', total === 0);
    empty.classList.toggle('hidden', total > 0);
    totalLabel.textContent = `Tổng số ${fmtInt(total)} NCC`;
    bar.textContent = '';
    legend.textContent = '';
    items.forEach((item) => {
      const percentageValue = Number(item.percentage || 0);
      const percentageLabel = `${percentageValue.toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%`;
      if (Number(item.count || 0) > 0) {
        const segment = el('div', {
          className: 'statistics-composition-segment',
          attrs: {
            style: `width:${percentageValue}%;background:${DASHBOARD_RATING_COLORS[item.code]}`,
            'aria-label': `${item.label}: ${fmtInt(item.count)} NCC, ${percentageLabel}`,
          },
        });
        segment.appendChild(el('span', { text: percentageLabel }));
        segment.addEventListener('mousemove', (event) => showStatisticsTooltip(event, [item.label, `${fmtInt(item.count)} NCC · ${percentageLabel}`]));
        segment.addEventListener('mouseleave', hideStatisticsTooltip);
        bar.appendChild(segment);
      }
      const row = el('div', { className: 'statistics-rating-item' });
      row.appendChild(el('i', { attrs: { style: `background:${DASHBOARD_RATING_COLORS[item.code]}` } }));
      const copy = el('span', { text: `${item.label} · `, attrs: { title: item.label } });
      copy.appendChild(el('small', { text: `${fmtInt(item.count)} NCC · ${percentageLabel}` }));
      row.appendChild(copy);
      legend.appendChild(row);
    });
    bar.setAttribute('aria-label', `Cơ cấu 100% của ${fmtInt(total)} NCC theo bốn mức xếp loại`);
    fitDashboardSegmentLabels(bar, '.statistics-composition-segment');
  }

  function drawIndustryPerformance(rows) {
    const chart = $('industry-performance-chart');
    const empty = $('industry-performance-empty');
    const data = Array.isArray(rows) ? rows : [];
    empty.classList.toggle('hidden', data.length > 0);
    chart.classList.toggle('hidden', data.length === 0);
    chart.textContent = '';
    if (!data.length) return;
    const header = el('div', { className: 'statistics-industry-header', attrs: { role: 'row' } });
    header.appendChild(el('span', { text: 'Ngành hàng MCH3', attrs: { role: 'columnheader' } }));
    const legend = el('div', { className: 'statistics-industry-legend', attrs: { role: 'columnheader' } });
    const passedLegend = el('span', { text: 'Đạt (%)' });
    passedLegend.prepend(el('i', { attrs: { style: `background:${DASHBOARD_DETAIL_COLORS.passed}` } }));
    const failedLegend = el('span', { text: 'Không đạt (%)' });
    failedLegend.prepend(el('i', { attrs: { style: `background:${DASHBOARD_DETAIL_COLORS.failed}` } }));
    legend.append(passedLegend, failedLegend);
    header.appendChild(legend);
    header.appendChild(el('span', { text: 'Tổng NCC', attrs: { role: 'columnheader' } }));
    header.appendChild(el('span', { text: 'Điểm TB', attrs: { role: 'columnheader' } }));
    chart.appendChild(header);
    const body = el('div', { className: 'statistics-industry-rows', attrs: { role: 'rowgroup' } });
    data.forEach((row, index) => {
      const industry = row.mch3 || row.industry || 'Chưa xác định';
      const passedPercentage = Number(row.passed_percentage || 0);
      const failedPercentage = Number(row.failed_percentage || 0);
      const passedLabel = `${passedPercentage.toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%`;
      const failedLabel = `${failedPercentage.toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%`;
      const line = el('div', { className: 'statistics-industry-row', attrs: { role: 'row' } });
      line.appendChild(el('div', { className: 'statistics-industry-name', text: industry, attrs: { title: industry, role: 'rowheader' } }));
      const bar = el('div', { className: 'statistics-industry-bar', attrs: { role: 'cell', 'aria-label': `${industry}: đạt ${passedLabel}, không đạt ${failedLabel}` } });
      [
        ['Đạt', row.passed_suppliers, passedPercentage, passedLabel, DASHBOARD_DETAIL_COLORS.passed],
        ['Không đạt', row.failed_suppliers, failedPercentage, failedLabel, DASHBOARD_DETAIL_COLORS.failed],
      ].forEach(([label, count, percentageValue, percentageLabel, color]) => {
        if (percentageValue <= 0) return;
        const segment = el('div', { className: 'statistics-industry-segment', attrs: { style: `width:${percentageValue}%;background:${color}`, 'aria-label': `${label}: ${fmtInt(count)} NCC, ${percentageLabel}` } });
        segment.appendChild(el('span', { text: percentageLabel }));
        segment.addEventListener('mousemove', (event) => showStatisticsTooltip(event, [industry, `${label}: ${fmtInt(count)} NCC · ${percentageLabel}`]));
        segment.addEventListener('mouseleave', hideStatisticsTooltip);
        bar.appendChild(segment);
      });
      line.appendChild(bar);
      const totalMetric = el('div', { className: 'statistics-industry-metric statistics-industry-total', attrs: { role: 'cell' } });
      totalMetric.append(el('small', { text: 'Tổng NCC:' }), document.createTextNode(fmtInt(row.total_suppliers)));
      line.appendChild(totalMetric);
      const scoreMetric = el('div', { className: 'statistics-industry-metric statistics-industry-score', attrs: { role: 'cell' } });
      scoreMetric.append(el('small', { text: 'Điểm TB:' }), document.createTextNode(`${Number(row.average_score).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%`));
      line.appendChild(scoreMetric);
      body.appendChild(line);
    });
    chart.appendChild(body);
    fitDashboardSegmentLabels(chart, '.statistics-industry-segment');
  }

  function drawViolationDistribution(distribution) {
    const canvas = $('violation-distribution-canvas');
    const empty = $('violation-distribution-empty');
    const data = [...(distribution?.items || [])].sort((a, b) => Number(b.count || 0) - Number(a.count || 0));
    empty.classList.toggle('hidden', data.length > 0);
    canvas.classList.toggle('hidden', data.length === 0);
    const height = Math.max(300, data.length * 58 + 54);
    const { context, width } = setupDashboardCanvas(canvas, height);
    if (!data.length) return;
    const styles = getComputedStyle(document.documentElement);
    const grid = styles.getPropertyValue('--border').trim() || '#e5e7eb';
    const textColor = styles.getPropertyValue('--muted').trim() || '#6b7280';
    const left = width < 520 ? 138 : 245;
    const plot = { left, right: width - 52, top: 24, bottom: height - 24 };
    const chartWidth = Math.max(80, plot.right - plot.left);
    const step = (plot.bottom - plot.top) / data.length;
    const hits = [];
    context.font = '10px Be Vietnam Pro, system-ui'; context.textBaseline = 'middle';
    [0, 25, 50, 75, 100].forEach((tick) => {
      const x = plot.left + chartWidth * tick / 100;
      context.beginPath(); context.moveTo(x, plot.top - 8); context.lineTo(x, plot.bottom); context.strokeStyle = grid; context.lineWidth = 1; context.stroke();
      context.fillStyle = textColor; context.textAlign = 'center'; context.fillText(`${tick}%`, x, 10);
    });
    data.forEach((row, index) => {
      const y = plot.top + step * index + step / 2;
      const barHeight = Math.min(25, step * .52);
      const barWidth = chartWidth * Math.min(100, Math.max(0, Number(row.percentage || 0))) / 100;
      context.fillStyle = textColor; context.textAlign = 'right'; context.fillText(clippedCanvasText(context, row.label, left - 18), plot.left - 10, y);
      context.fillStyle = DASHBOARD_DETAIL_COLORS.violation; context.fillRect(plot.left, y - barHeight / 2, barWidth, barHeight);
      context.fillStyle = textColor; context.textAlign = 'left'; context.fillText(`${Number(row.percentage || 0).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%`, Math.min(plot.right + 7, plot.left + barWidth + 7), y);
      hits.push({ top: y - step / 2, bottom: y + step / 2, row });
    });
    canvas._dashboardViolationMove = (event) => {
      const rect = canvas.getBoundingClientRect();
      const y = (event.clientY - rect.top) * height / rect.height;
      const hit = hits.find((item) => y >= item.top && y <= item.bottom);
      if (!hit) return hideStatisticsTooltip();
      showStatisticsTooltip(event, [hit.row.label, `Số lượt: ${fmtInt(hit.row.count)}`, `Tỷ lệ: ${Number(hit.row.percentage || 0).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%`]);
    };
    if (!canvas.dataset.dashboardEventsBound) {
      canvas.addEventListener('mousemove', (event) => canvas._dashboardViolationMove?.(event));
      canvas.addEventListener('mouseleave', hideStatisticsTooltip);
      canvas.dataset.dashboardEventsBound = 'true';
    }
  }

  function renderDashboardMode() {
    const mode = state.dashboardReport.mode === 'detail' ? 'detail' : 'overview';
    state.dashboardReport.mode = mode;
    document.querySelectorAll('[data-dashboard-mode]').forEach((button) => {
      const active = button.dataset.dashboardMode === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      button.tabIndex = active ? 0 : -1;
    });
    $('statistics-overview-charts').classList.toggle('hidden', mode !== 'overview');
    $('statistics-detail-charts').classList.toggle('hidden', mode !== 'detail');
  }

  function renderActiveDashboardCharts() {
    renderDashboardMode();
    if (!statisticalDashboardPayload) return;
    if (state.dashboardReport.mode === 'detail') {
      clearDashboardCanvas('status-donut-canvas');
      clearDashboardCanvas('quality-trend-canvas');
      $('statistics-ranking-body').textContent = '';
      window.requestAnimationFrame(() => {
        drawIndustryPerformance(statisticalDashboardPayload.details.industry_performance);
        drawRatingDistribution(statisticalDashboardPayload.details.rating_distribution);
        drawViolationDistribution(statisticalDashboardPayload.details.violation_distribution);
      });
      return;
    }
    clearDashboardCanvas('industry-performance-chart');
    clearDashboardCanvas('rating-distribution-bar');
    clearDashboardCanvas('violation-distribution-canvas');
    drawStatusDonut(statisticalDashboardPayload.status_distribution);
    renderRanking(statisticalDashboardPayload.top_suppliers);
    window.requestAnimationFrame(() => drawQualityTrend(statisticalDashboardPayload));
  }

  function selectDashboardMode(mode) {
    if (!['overview', 'detail'].includes(mode) || state.dashboardReport.mode === mode) return;
    state.dashboardReport.mode = mode;
    hideStatisticsTooltip();
    renderActiveDashboardCharts();
  }

  function validStatisticalDashboard(data, report) {
    return !!data && data.period?.type === report.periodType && data.period?.value === report.periodValue && data.kpis && Array.isArray(data.status_distribution?.items) && Array.isArray(data.top_suppliers) && Array.isArray(data.trend) && Array.isArray(data.details?.rating_distribution?.items) && Array.isArray(data.details?.industry_performance) && Array.isArray(data.details?.violation_distribution?.items);
  }

  function renderStatisticalDashboard(payload) {
    statisticalDashboardPayload = payload;
    state.dashboardReport.data = payload;
    state.dashboardReport.filterOptions = payload.filters?.options || state.dashboardReport.filterOptions;
    renderDashboardFilters();
    const cards = $('statistics-kpi-cards'); cards.textContent = '';
    DASHBOARD_KPIS.forEach(([id, title, icon]) => cards.appendChild(renderStatisticKpi(id, title, icon, payload.kpis[id])));
    renderDashboardState('overview-state', '', '', null);
    renderActiveDashboardCharts();
  }

  async function loadOverview(requestId) {
    const report = state.dashboardReport;
    if (!validDashboardReportValue(report.periodType, report.periodValue)) report.periodValue = currentDashboardReportValue(report.periodType);
    renderDashboardPeriodControls(); renderDashboardFilters(); renderDashboardMode(); renderDashboardLoading();
    const key = dashboardReportKey();
    renderDashboardState('overview-state', 'loading', `Đang tải dữ liệu ${dashboardReportLabel(report.periodType, report.periodValue)}...`, () => loadTab());
    const r = await api('/dashboard/statistics?' + dashboardReportQuery());
    if (!dashboardReportRequestActive(requestId, key)) return;
    if (!r.ok || !validStatisticalDashboard(r.data, report)) {
      statisticalDashboardPayload = null;
      renderDashboardState('overview-state', 'error', 'Không thể tải dữ liệu. Vui lòng thử lại.', () => loadTab());
      return;
    }
    renderStatisticalDashboard(r.data);
  }

  function refreshStatisticalDashboardFilters() {
    state.dashboardReport.filters = {
      ...state.dashboardReport.filters,
      regions: [],
      evaluationTypes: [],
      mch2: [],
    };
    state.dashboardReport.selectedStatus = '';
    statisticalDashboardPayload = null;
    renderDashboardFilters();
    loadTab();
  }

  $('dashboard-refresh')?.addEventListener('click', refreshStatisticalDashboardFilters);
  document.querySelectorAll('[data-dashboard-mode]').forEach((button) => {
    button.addEventListener('click', () => selectDashboardMode(button.dataset.dashboardMode));
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const nextMode = state.dashboardReport.mode === 'overview' ? 'detail' : 'overview';
      selectDashboardMode(nextMode);
      document.querySelector(`[data-dashboard-mode="${nextMode}"]`)?.focus();
    });
  });
  window.addEventListener('resize', debounce(() => {
    if (state.tab === 'overview' && statisticalDashboardPayload) {
      renderActiveDashboardCharts();
    }
  }, 120));

  const NCC_EVALUATION_VIOLATION_ORDER = [
    ['LEGAL', 'Lỗi vi phạm điều khoản pháp lý'],
    ['QUALITY_CONTROL', 'Lỗi kiểm soát chất lượng'],
    ['TRACEABILITY', 'Lỗi truy xuất nguồn gốc SP'],
    ['FOOD_SAFETY', 'Lỗi an toàn vệ sinh thực phẩm'],
  ];

  function dashboardMonthLabel(month) {
    const match = String(month || '').match(/^(\d{4})-(\d{2})$/);
    if (!match) return month || '—';
    return `Tháng ${match[2]}/${match[1]}`;
  }

  function dashboardPercent(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return '0%';
    const pct = numeric * 100;
    return pct >= 10 ? pct.toFixed(1).replace(/\.0$/, '') + '%' : pct.toFixed(2).replace(/\.00$/, '').replace(/0$/, '') + '%';
  }

  function safeInteger(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  }

  function safeFraction(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.min(Math.max(numeric, 0), 1);
  }

  function categoryText(value) {
    const text = String(value == null ? '' : value).trim();
    return text || 'Chưa xác định';
  }

  function dashboardErrorMessage(data, fallback) {
    const error = data && data.error;
    if (error && typeof error === 'object') return error.message || apiErrorMessage(error.code, fallback);
    return apiErrorMessage(error, fallback);
  }

  function renderDashboardState(id, status, message, retryHandler) {
    const box = $(id);
    if (!box) return;
    box.textContent = '';
    box.classList.remove('error', 'empty');
    if (!message) {
      box.classList.add('hidden');
      return;
    }
    box.classList.toggle('error', status === 'error');
    box.classList.toggle('empty', status === 'loaded-empty');
    const text = el('span');
    text.appendChild(el('strong', {
      text: state.tab === 'overview'
        ? dashboardReportLabel(state.dashboardReport.periodType, state.dashboardReport.periodValue)
        : dashboardMonthLabel(state.month),
    }));
    text.appendChild(el('span', { text: ' · ' + message }));
    box.appendChild(text);
    if (status === 'error' && retryHandler) {
      const retry = el('button', { className: 'btn-ghost', text: 'Thử lại', attrs: { type: 'button', 'data-action-id': 'filter.retry' } });
      setRegisteredButtonAction(retry, 'filter.retry', retryHandler, { announceSuccess: false });
      box.appendChild(retry);
    }
    if (status === 'loaded-empty') {
      const nearest = REPORTING_PERIOD.normalizePeriods(state.dashboardPeriods)
        .find((item) => item.has_data && item.value !== state.month);
      if (nearest) {
        const nearestButton = el('button', {
          className: 'btn-ghost',
          text: `Xem kỳ gần nhất: ${REPORTING_PERIOD.labelForPeriod(nearest.value)}`,
          attrs: { type: 'button', 'data-action-id': 'filter.retry' },
        });
        setRegisteredButtonAction(nearestButton, 'filter.retry', () => selectDashboardPeriod(nearest.value), { announceSuccess: false });
        box.appendChild(nearestButton);
      }
    }
    box.classList.remove('hidden');
  }

  function normalizeEvaluationViolations(rows) {
    const byCode = new Map((Array.isArray(rows) ? rows : []).map((row) => [String(row.code || '').trim().toUpperCase(), row]));
    return NCC_EVALUATION_VIOLATION_ORDER.map(([code, label]) => {
      const row = byCode.get(code) || {};
      return {
        code,
        label: String(row.label || label),
        supplier_count: safeInteger(row.supplier_count),
        ratio: safeFraction(row.ratio),
        note: row.note || null,
      };
    });
  }

  function renderViolationChart(rows) {
    const chart = $('ncc-violations-chart');
    const empty = $('ncc-violations-empty');
    chart.textContent = '';
    if (!rows.length) {
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    rows.forEach((row) => {
      const ratio = safeFraction(row.ratio);
      const pct = Math.min(100, Math.max(0, ratio * 100));
      const wrap = el('div', {
        className: 'ncc-violation-row',
        attrs: {
          role: 'group',
          'aria-label': `${row.label}: ${fmtInt(row.supplier_count)} NCC, ${dashboardPercent(ratio)}`,
        },
      });
      wrap.appendChild(el('div', { className: 'ncc-violation-label', text: row.label }));
      const meter = el('div', { className: 'ncc-violation-meter' });
      const track = el('div', { className: 'bar-track' });
      track.appendChild(el('div', { className: 'bar-fill sev-' + sevOf(ratio), attrs: { style: 'width:' + pct.toFixed(2) + '%' } }));
      meter.appendChild(track);
      meter.appendChild(el('span', { className: 'tag sev-' + sevOf(ratio), text: dashboardPercent(ratio) }));
      wrap.appendChild(meter);
      wrap.appendChild(el('div', { className: 'ncc-violation-stat', text: fmtInt(row.supplier_count) + ' NCC' }));
      chart.appendChild(wrap);
    });
  }

  function renderNccEvalDashboard() {
    const local = state.nccEvaluationsDashboard;
    const data = local.data || {};
    const overview = data.overview || { total: 0, passed: 0, failed: 0, passed_ratio: 0, failed_ratio: 0 };
    const byCategory = Array.isArray(data.by_category) ? data.by_category : [];
    const sum = $('ncc-eval-summary');
    sum.textContent = '';
    const monthLabel = dashboardMonthLabel(local.requestedMonth || state.month);
    sum.appendChild(summaryCard('Số lượng NCC đánh giá/tháng', fmtInt(safeInteger(overview.total)), 'gray', monthLabel));
    sum.appendChild(summaryCard('Kết quả đạt', fmtInt(safeInteger(overview.passed)), 'green', dashboardPercent(overview.passed_ratio)));
    sum.appendChild(summaryCard('Kết quả không đạt', fmtInt(safeInteger(overview.failed)), sevOf(overview.failed_ratio), dashboardPercent(overview.failed_ratio)));
    const tbody = $('ncc-eval-tbody');
    tbody.textContent = '';
    $('ncc-eval-count').textContent = '';
    $('ncc-eval-empty').classList.add('hidden');
    $('ncc-violations-chart').textContent = '';
    $('ncc-violations-empty').classList.add('hidden');
    if (local.status === 'loading') {
      renderDashboardState('ncc-eval-state', 'loading', 'Đang tải dữ liệu Đánh giá NCC...', () => loadTab());
      return;
    }
    if (local.status === 'error') {
      renderDashboardState('ncc-eval-state', 'error', local.error || 'Không tải được dữ liệu Đánh giá NCC.', () => loadTab());
      return;
    }
    if (local.status === 'loaded-empty') {
      renderDashboardState('ncc-eval-state', 'loaded-empty', 'Không có dữ liệu Đánh giá NCC trong tháng đã chọn.', null);
      $('ncc-eval-empty').classList.remove('hidden');
      return;
    }
    renderDashboardState('ncc-eval-state', '', '', null);
    $('ncc-eval-count').textContent = byCategory.length + ' ngành · ' + fmtInt(safeInteger(overview.total)) + ' NCC';
    byCategory.forEach((row) => {
      const tr = el('tr');
      tr.appendChild(el('td', { className: 'muted mono', text: String(row.stt || '').padStart(2, '0') }));
      tr.appendChild(el('td', { className: 'label', text: categoryText(row.category) }));
      tr.appendChild(el('td', { className: 'num', text: fmtInt(safeInteger(row.passed)) }));
      tr.appendChild(el('td', { className: 'num-strong', text: fmtInt(safeInteger(row.failed)) }));
      tr.appendChild(el('td', { className: 'num', text: fmtInt(safeInteger(row.total)) }));
      tr.appendChild(el('td', { className: 'num', text: dashboardPercent(row.passed_ratio) }));
      tr.appendChild(el('td', { className: 'num', text: dashboardPercent(row.failed_ratio) }));
      tbody.appendChild(tr);
    });
    renderViolationChart(normalizeEvaluationViolations(data.violations));
  }

  function validNccEvalResponse(data) {
    return !!(data && data.overview && Array.isArray(data.by_category) && Array.isArray(data.violations));
  }

  async function loadNccEval(dashboardRequestId) {
    renderDashboardPeriodControls();
    const local = state.nccEvaluationsDashboard;
    const month = state.month;
    const requestId = (local.requestId || 0) + 1;
    Object.assign(local, { status: 'loading', requestedMonth: month, requestId, data: null, error: '' });
    renderNccEvalDashboard();
    const r = await api('/dashboard/ncc-evaluations?month=' + encodeURIComponent(month));
    if (state.nccEvaluationsDashboard.requestId !== requestId || !dashboardRequestActive(dashboardRequestId, month)) return;
    if (!r.ok) {
      Object.assign(local, { status: 'error', data: null, error: dashboardErrorMessage(r.data, 'Không tải được dữ liệu Đánh giá NCC.') });
      renderNccEvalDashboard();
      return;
    }
    if (!validNccEvalResponse(r.data) || r.data.month !== month) {
      Object.assign(local, { status: 'error', data: null, error: 'Dữ liệu trả về không đúng định dạng.' });
      renderNccEvalDashboard();
      return;
    }
    Object.assign(local, {
      status: safeInteger(r.data.overview.total) === 0 ? 'loaded-empty' : 'loaded-data',
      data: r.data,
      error: '',
    });
    renderNccEvalDashboard();
  }

  // ============ Admin ============
  $('btn-admin-close').addEventListener('click', () => {
    navigateToTab('admin');
  });

  function renderBusinessConfigLifecycle(hostId, version, options = {}) {
    BUSINESS_CONFIG.renderLifecycle($(hostId), version, options);
  }

  function businessConfigDirty(tab = state.tab) {
    if (tab === 'admin-question-templates') return Boolean(state.questionWorkspaceDirty);
    if (tab === 'admin-report-templates') return Boolean(state.reportTemplateDirty);
    if (tab === 'admin-scoring-policies') return Boolean(state.scoringPolicyDirty);
    return false;
  }

  function clearBusinessConfigDirty(tab = state.tab) {
    if (tab === 'admin-question-templates') markQuestionWorkspaceDirty(false);
    if (tab === 'admin-report-templates') markReportTemplateDirty(false);
    if (tab === 'admin-scoring-policies') markScoringPolicyDirty(false);
  }

  function confirmBusinessConfigRouteLeave(_nextRoute = '') {
    if (!businessConfigDirty()) return true;
    const accepted = window.confirm('Bạn có thay đổi bản nháp chưa lưu. Bỏ thay đổi để rời workspace?');
    if (accepted) clearBusinessConfigDirty();
    return accepted;
  }

  function showBusinessConfigSurface(hostId, input = {}) {
    const host = $(hostId);
    if (!host) return;
    const model = BUSINESS_CONFIG.surfaceState(input);
    host.dataset.state = model.state;
    host.textContent = model.message;
    host.classList.toggle('hidden', model.state === 'ready');
  }

  function syncGuidedWorkspace(workspace, activeStep = 1) {
    const root = document.querySelector(`[data-guided-workspace="${workspace}"]`);
    if (!root) return;
    const normalized = Math.max(1, Number(activeStep) || 1);
    root.dataset.guidedStage = String(normalized);
    root.querySelectorAll('[data-guided-step]').forEach((item) => {
      const step = Number(item.dataset.guidedStep);
      item.dataset.state = step < normalized ? 'complete' : step === normalized ? 'current' : 'pending';
      if (step === normalized) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
  }

  function getAdminModulePanels() {
    return {
      authorization: $('authorization-admin') && $('authorization-admin').closest('.panel'),
      'personnel-import': $('admin-personnel-import'),
      'question-templates': $('question-template-tbody') && $('question-template-tbody').closest('.panel'),
      'report-templates': $('report-template-tbody') && $('report-template-tbody').closest('.panel'),
      'scoring-policies': $('scoring-policy-workspace'),
      'system-logs': $('system-log-tbody') && $('system-log-tbody').closest('.panel'),
    };
  }

  function loadAdminDashboard() {
    const dashboard = $('admin-dashboard');
    const adminHeader = document.querySelector('#view-admin .section-hdr');
    if (adminHeader) adminHeader.classList.remove('hidden');
    if (dashboard && adminHeader && dashboard.previousElementSibling !== adminHeader) adminHeader.after(dashboard);
    if (dashboard) dashboard.classList.remove('hidden');
    const adminSub = document.querySelector('#view-admin .section-hdr .sub');
    if (adminSub) adminSub.textContent = navigationItem('admin')?.description || '';
    const panels = getAdminModulePanels();
    Object.keys(panels).forEach((key) => {
      const node = panels[key];
      if (!node) return;
      node.dataset.adminModule = key;
      node.classList.add('hidden');
    });
  }

  async function loadAdmin(force = false) {
    if (!navigationItemAllowed(state.tab)) {
      syncAdminModuleView();
      showSystemLogState('permission');
      return;
    }
    syncAdminModuleView();
    const config = adminRouteConfig(state.tab);
    const module = config?.module || 'authorization';
    if (module === 'authorization') {
      await selectAuthzTab(config.pane || 'users', { force: true, focus: false });
      await loadAuthorizationAdmin(force);
      return;
    }
    if (module === 'personnel-import') {
      await loadPersonnelImport();
      return;
    }
    if (module === 'question-templates') {
      await loadQuestionAdmin();
      return;
    }
    if (module === 'report-templates') {
      await loadReportTemplatesAdmin();
      return;
    }
    if (module === 'scoring-policies') {
      await loadScoringPolicyWorkspace();
      return;
    }
    if (module === 'system-logs') {
      await loadSystemLogs();
    }
  }

  function syncAdminModuleView() {
    const config = adminRouteConfig(state.tab);
    const module = config?.module || 'authorization';
    const dashboard = $('admin-dashboard');
    if (dashboard) dashboard.classList.add('hidden');
    const adminHeader = document.querySelector('#view-admin .section-hdr');
    if (adminHeader) adminHeader.classList.toggle('hidden', module === 'personnel-import');
    const adminTitle = $('admin-page-title');
    if (adminTitle) {
      adminTitle.textContent = navigationItem(state.tab)?.label || 'Quản trị';
    }
    const adminSub = document.querySelector('#view-admin .section-hdr .sub');
    if (adminSub) adminSub.textContent = navigationItem(state.tab)?.description || '';
    const panels = getAdminModulePanels();
    Object.keys(panels).forEach((key) => {
      const node = panels[key];
      if (!node) return;
      node.dataset.adminModule = key;
      node.classList.toggle('hidden', key !== module);
    });
  }

  // ============ Personnel import workflow (PROMPT-07) ============
  const PERSONNEL_IMPORT_STEPS = Object.freeze(['upload', 'columns', 'roles', 'review']);
  const PERSONNEL_IMPORT_API = Object.freeze({
    catalog: '/admin/authorization/catalog',
    template: '/admin/authorization/personnel-import/template.xlsx',
    example: '/admin/authorization/personnel-import/example.xlsx',
    preview: '/admin/authorization/personnel-import/batches/preview',
    batches: '/admin/authorization/personnel-import/batches/',
  });
  const PERSONNEL_IMPORT_FIELDS = Object.freeze([
    { key: 'email', label: 'Email', required: true, hint: 'Bắt buộc · lowercase · duy nhất trong file' },
    { key: 'display_name', label: 'Họ và tên', required: false, hint: 'Tùy chọn · tối đa 160 ký tự' },
    { key: 'active', label: 'Hoạt động', required: false, hint: 'Tùy chọn · mặc định true khi tạo mới' },
    { key: 'role_codes', label: 'Vai trò', required: false, hint: 'Nhiều giá trị phân cách bằng dấu “;”' },
    { key: 'valid_from', label: 'Hiệu lực từ', required: false, hint: 'ISO date hoặc RFC 3339' },
    { key: 'valid_until', label: 'Hiệu lực đến', required: false, hint: 'ISO date hoặc RFC 3339' },
    { key: 'scope_type', label: 'Loại phạm vi', required: false, hint: 'GLOBAL, MCH1, MCH2 hoặc MCH3' },
    { key: 'scope_value', label: 'Giá trị phạm vi', required: false, hint: 'Bắt buộc trừ GLOBAL' },
    { key: 'scope_effect', label: 'Hiệu lực phạm vi', required: false, hint: 'ALLOW hoặc DENY' },
  ]);

  const PERSONNEL_IMPORT_ERROR_LABELS = Object.freeze({
    file_required: 'Hãy chọn file XLSX.',
    invalid_file_type: 'File không đúng định dạng XLSX.',
    invalid_xlsx_mime: 'Trình duyệt không nhận diện được MIME XLSX.',
    file_too_large: 'File vượt quá giới hạn 5 MB.',
    workbook_formula_forbidden: 'File có công thức và không thể nhập an toàn.',
    workbook_formula_like_cell_forbidden: 'File có ô bắt đầu giống công thức và không thể nhập an toàn.',
    workbook_row_limit_exceeded: 'File vượt quá giới hạn 2.000 dòng.',
    email_mapping_required: 'Cần đối chiếu cột email trước khi tiếp tục.',
    email_invalid: 'Email không hợp lệ.',
    email_duplicate_in_file: 'Email bị trùng trong file.',
    role_value_mapping_required: 'Vai trò trong file chưa được đối chiếu.',
    role_not_found: 'Role không tồn tại hoặc đã ngừng hoạt động.',
    role_code_duplicate: 'Vai trò bị lặp trên cùng một dòng.',
    department_column_cannot_be_persisted: 'Cột phòng ban không được lưu trong phiên bản này.',
    unhandled_source_columns: 'Còn cột nguồn chưa được đối chiếu hoặc bỏ qua.',
    personnel_import_source_checksum_mismatch: 'Checksum file đã thay đổi. Hãy tải lại file.',
    personnel_import_batch_checksum_mismatch: 'Checksum batch đã thay đổi. Hãy kiểm tra lại dữ liệu.',
    personnel_import_preview_stale: 'Dữ liệu hoặc quyền đã thay đổi. Hãy kiểm tra lại batch.',
    personnel_import_batch_expired: 'Batch preview đã hết hạn. Hãy tải lại file.',
    personnel_import_not_committable: 'Batch còn lỗi hoặc không có thay đổi để nhập.',
    exact_confirmation_required: 'Chuỗi xác nhận chưa chính xác.',
    cannot_disable_self: 'Không thể vô hiệu hóa chính tài khoản đang thao tác.',
    cannot_self_escalate: 'Không thể tự nâng quyền qua import.',
    last_super_admin_required: 'Hệ thống phải còn ít nhất một SYS_ADMIN hoạt động.',
    forbidden: 'Bạn không có quyền USER.MANAGE.',
    network: 'Không kết nối được máy chủ. Có thể thử lại an toàn.',
  });

  function emptyPersonnelImportState(catalog = null) {
    return {
      step: 'upload',
      catalog,
      preview: null,
      validation: null,
      result: null,
      fileMeta: null,
      columnMapping: {},
      roleValueMapping: {},
      ignoredColumns: [],
      idempotencyKey: '',
      dirty: false,
      committed: false,
    };
  }

  let personnelImportState = emptyPersonnelImportState();
  let personnelImportValidationInFlight = false;
  let personnelImportCommitInFlight = false;
  let personnelImportStableHash = window.location.hash;
  let personnelImportRouteBypass = false;
  let personnelImportIconsReady = false;

  function personnelImportErrorMessage(code) {
    return PERSONNEL_IMPORT_ERROR_LABELS[String(code || '')]
      || String(code || 'personnel_import_failed').replaceAll('_', ' ');
  }

  function personnelImportHasUnsaved() {
    return Boolean(personnelImportState.preview && personnelImportState.dirty && !personnelImportState.committed);
  }

  function resetPersonnelImportState() {
    const catalog = personnelImportState.catalog;
    personnelImportState = emptyPersonnelImportState(catalog);
    renderPersonnelImport();
  }

  function ensurePersonnelImportIcons() {
    if (personnelImportIconsReady) return;
    const upload = document.querySelector('.personnel-import-upload-icon');
    const success = document.querySelector('.personnel-import-success-icon');
    if (upload) upload.appendChild(iconSvg('download'));
    if (success) success.appendChild(iconSvg('check'));
    personnelImportIconsReady = true;
  }

  function showPersonnelImportState(stateName, message) {
    const node = $('personnel-import-state');
    if (!node) return;
    node.classList.toggle('hidden', !message);
    node.dataset.state = stateName || 'ready';
    node.classList.toggle('admin-state--error', stateName === 'error');
    node.classList.toggle('admin-state--forbidden', stateName === 'denied');
    const icon = node.querySelector('[data-personnel-state-icon]');
    if (icon) {
      icon.textContent = '';
      if (message) icon.appendChild(iconSvg(stateName === 'error' || stateName === 'denied' ? 'return' : stateName === 'loading' ? 'history' : 'check'));
    }
    const text = node.querySelector('[data-personnel-state-message]');
    if (text) text.textContent = message || '';
    if (message && (stateName === 'error' || stateName === 'denied')) node.focus();
  }

  function personnelImportStepIndex(step = personnelImportState.step) {
    const index = PERSONNEL_IMPORT_STEPS.indexOf(step);
    return index < 0 ? PERSONNEL_IMPORT_STEPS.length : index;
  }

  function setPersonnelImportStep(step) {
    if (!PERSONNEL_IMPORT_STEPS.includes(step) && step !== 'success') return;
    personnelImportState.step = step;
    renderPersonnelImport();
    const active = document.querySelector(`[data-personnel-step="${step}"] h4`);
    if (active) {
      active.setAttribute('tabindex', '-1');
      active.focus();
    }
  }

  function renderPersonnelImportStepper() {
    const current = personnelImportStepIndex();
    document.querySelectorAll('[data-personnel-step-indicator]').forEach((item, index) => {
      const stateName = personnelImportState.step === 'success' || index < current
        ? 'complete' : index === current ? 'current' : 'pending';
      item.dataset.state = stateName;
      const detail = item.querySelector('small');
      if (detail) detail.textContent = stateName === 'complete' ? 'Đã hoàn thành'
        : stateName === 'current' ? 'Đang thực hiện' : 'Chưa bắt đầu';
    });
    syncGuidedWorkspace('personnel-import', current + 1);
  }

  function personnelImportColumnValue(sample, field) {
    const header = personnelImportState.columnMapping[field];
    const index = personnelImportState.preview?.headers?.indexOf(header);
    return index >= 0 ? String(sample?.cells?.[index] || '') : '';
  }

  function updatePersonnelIgnoredColumns() {
    const used = new Set(Object.values(personnelImportState.columnMapping).filter(Boolean));
    personnelImportState.ignoredColumns = (personnelImportState.preview?.headers || []).filter((header) => !used.has(header));
  }

  function personnelImportMappingIssue() {
    const mapping = personnelImportState.columnMapping;
    if (!mapping.email) return 'Cần đối chiếu cột Email trước khi tiếp tục.';
    const used = Object.values(mapping).filter(Boolean);
    if (new Set(used).size !== used.length) return 'Một cột nguồn không thể dùng cho nhiều trường canonical.';
    return '';
  }

  function renderPersonnelColumnMapping() {
    const host = $('personnel-import-column-mapping');
    if (!host || !personnelImportState.preview) return;
    host.textContent = '';
    const headers = personnelImportState.preview.headers || [];
    const sample = personnelImportState.preview.sampleRows?.[0];
    let mappedCount = 0;
    PERSONNEL_IMPORT_FIELDS.forEach((field) => {
      const row = el('div', { className: 'personnel-import-mapping-row' });
      const identity = el('div', { className: 'personnel-import-mapping-field' });
      identity.appendChild(el('strong', { text: field.label }));
      identity.appendChild(el('small', { text: field.hint }));
      row.appendChild(identity);

      const select = el('select', {
        className: 'input',
        attrs: { 'aria-label': `Cột nguồn cho ${field.label}`, 'data-personnel-field': field.key },
      });
      select.appendChild(el('option', { text: field.required ? 'Chọn cột bắt buộc' : 'Không đối chiếu', attrs: { value: '' } }));
      headers.forEach((header) => select.appendChild(el('option', { text: header, attrs: { value: header } })));
      select.value = personnelImportState.columnMapping[field.key] || '';
      if (select.value) mappedCount += 1;
      select.addEventListener('change', () => {
        personnelImportState.columnMapping[field.key] = select.value || null;
        personnelImportState.validation = null;
        personnelImportState.idempotencyKey = '';
        personnelImportState.dirty = true;
        updatePersonnelIgnoredColumns();
        renderPersonnelColumnMapping();
        renderPersonnelRoleMapping();
        renderPersonnelImportPreview();
        renderPersonnelImportActions();
      });
      row.appendChild(select);

      const example = el('div', { className: 'personnel-import-mapping-example' });
      example.appendChild(el('span', { text: 'Ví dụ dữ liệu' }));
      example.appendChild(el('code', { text: personnelImportColumnValue(sample, field.key) || '—' }));
      row.appendChild(example);
      row.appendChild(el('span', {
        className: 'admin-status-badge',
        text: select.value ? 'Đã đối chiếu' : field.required ? 'Bắt buộc' : 'Tùy chọn',
      }));
      host.appendChild(row);
    });
    setText('personnel-import-column-progress', `${mappedCount}/${PERSONNEL_IMPORT_FIELDS.length} trường đã đối chiếu`);
  }

  function activePersonnelRoles() {
    return (personnelImportState.catalog?.roles || []).filter((role) => role.active !== false)
      .sort((left, right) => String(left.displayLabel || left.roleCode).localeCompare(String(right.displayLabel || right.roleCode), 'vi'));
  }

  function personnelImportRoleValues() {
    const preview = personnelImportState.preview;
    const roleHeader = personnelImportState.columnMapping.role_codes;
    if (!preview || !roleHeader) return [];
    if (roleHeader === preview.suggestedColumnMapping?.role_codes && Array.isArray(preview.distinctRoleValues)) {
      return [...preview.distinctRoleValues];
    }
    const index = preview.headers.indexOf(roleHeader);
    if (index < 0) return [];
    return [...new Set((preview.sampleRows || []).flatMap((row) => String(row.cells?.[index] || '')
      .split(';').map((value) => value.trim()).filter(Boolean)))].sort((a, b) => a.localeCompare(b, 'vi'));
  }

  function directPersonnelRole(value) {
    const code = String(value || '').trim().toUpperCase();
    return activePersonnelRoles().find((role) => role.roleCode === code) || null;
  }

  function personnelImportRoleCode(value) {
    return directPersonnelRole(value)?.roleCode || personnelImportState.roleValueMapping[value] || '';
  }

  function personnelImportRoleMissingCount() {
    return personnelImportRoleValues().filter((value) => !personnelImportRoleCode(value)).length;
  }

  function renderPersonnelRoleMapping() {
    const host = $('personnel-import-role-mapping');
    if (!host || !personnelImportState.preview) return;
    host.textContent = '';
    const values = personnelImportRoleValues();
    if (!personnelImportState.columnMapping.role_codes) {
      host.appendChild(el('div', { className: 'admin-state admin-state--empty', text: 'Không đối chiếu cột vai trò. Tài khoản mới cần có vai trò; tài khoản hiện hữu giữ nguyên vai trò.' }));
      return;
    }
    if (!values.length) {
      host.appendChild(el('div', { className: 'admin-state admin-state--empty', text: 'Không tìm thấy giá trị role trong dữ liệu preview.' }));
      return;
    }
    values.forEach((sourceValue) => {
      const direct = directPersonnelRole(sourceValue);
      const selected = personnelImportRoleCode(sourceValue);
      const row = el('div', { className: 'personnel-import-role-row', attrs: { 'data-state': selected ? 'mapped' : 'unmapped' } });
      const identity = el('div', { className: 'personnel-import-role-source' });
      identity.appendChild(el('strong', { text: sourceValue }));
      identity.appendChild(el('span', { text: direct ? 'Đã khớp vai trò hiện hữu' : 'Vai trò trong file' }));
      row.appendChild(identity);
      const select = el('select', {
        className: 'input',
        attrs: { 'aria-label': `Role áp dụng cho ${sourceValue}`, ...(direct ? { disabled: 'disabled' } : {}) },
      });
      select.appendChild(el('option', { text: 'Chọn vai trò hiện hữu', attrs: { value: '' } }));
      activePersonnelRoles().forEach((role) => select.appendChild(el('option', {
        text: `${role.displayLabel || role.roleCode} · ${role.roleCode}`,
        attrs: { value: role.roleCode },
      })));
      select.value = selected;
      select.addEventListener('change', () => {
        if (select.value) personnelImportState.roleValueMapping[sourceValue] = select.value;
        else delete personnelImportState.roleValueMapping[sourceValue];
        personnelImportState.validation = null;
        personnelImportState.idempotencyKey = '';
        personnelImportState.dirty = true;
        renderPersonnelRoleMapping();
        renderPersonnelImportPreview();
        renderPersonnelImportMetrics();
        renderPersonnelImportActions();
      });
      row.appendChild(select);
      row.appendChild(el('span', { className: 'admin-status-badge', text: selected ? 'Đã đối chiếu' : 'Cần đối chiếu' }));
      host.appendChild(row);
    });
  }

  function personnelImportAppliedRoles(raw) {
    return [...new Set(String(raw || '').split(';').map((value) => value.trim()).filter(Boolean)
      .map(personnelImportRoleCode).filter(Boolean))];
  }

  function personnelImportSourceRows() {
    const preview = personnelImportState.preview;
    if (!preview) return [];
    const samples = new Map((preview.sampleRows || []).map((row) => [row.rowNumber, row]));
    if (personnelImportState.validation?.rows) {
      return personnelImportState.validation.rows.slice(0, 50).map((row) => ({ ...row, sample: samples.get(row.rowNumber) || null }));
    }
    return (preview.sampleRows || []).map((sample) => ({ rowNumber: sample.rowNumber, outcome: 'PENDING', errors: [], warnings: [], changes: [], sample }));
  }

  function personnelImportOutcomeLabel(outcome) {
    const labels = { CREATE: 'Tạo mới', UPDATE: 'Cập nhật', UNCHANGED: 'Không đổi', ERROR: 'Lỗi', PENDING: 'Chưa kiểm tra' };
    return labels[String(outcome || '').toUpperCase()] || String(outcome || '—');
  }

  function renderPersonnelImportPreview() {
    const section = $('personnel-import-preview');
    const tbody = $('personnel-import-preview-tbody');
    if (!section || !tbody) return;
    const visible = Boolean(personnelImportState.preview && ['roles', 'review'].includes(personnelImportState.step));
    section.classList.toggle('hidden', !visible);
    if (!visible) return;
    tbody.textContent = '';
    const rows = personnelImportSourceRows();
    rows.forEach((row) => {
      const sample = row.sample;
      const email = row.email || personnelImportColumnValue(sample, 'email') || '—';
      const displayName = personnelImportColumnValue(sample, 'display_name') || '—';
      const sourceRoles = personnelImportColumnValue(sample, 'role_codes') || '—';
      const appliedRoles = personnelImportAppliedRoles(sourceRoles);
      const outcome = String(row.outcome || 'PENDING').toUpperCase();
      const messages = [
        ...(row.errors || []).map((error) => personnelImportErrorMessage(error.code)),
        ...(row.warnings || []).map(personnelImportErrorMessage),
      ];
      if (!messages.length && row.changes?.length) messages.push(row.changes.join(' · '));
      if (!messages.length) messages.push(outcome === 'PENDING' ? 'Sẽ kiểm tra ở bước tiếp theo.' : 'Không cần xử lý.');
      const tr = el('tr', { attrs: { 'data-outcome': outcome.toLowerCase() } });
      tr.appendChild(labeledTd('Email', { className: 'mono', text: email }));
      tr.appendChild(labeledTd('Họ và tên', { text: displayName }));
      tr.appendChild(labeledTd('Vai trò trong file', { text: sourceRoles }));
      tr.appendChild(labeledTd('Vai trò sẽ áp dụng', { className: 'mono', text: appliedRoles.join('; ') || '—' }));
      const status = labeledTd('Kết quả');
      status.appendChild(el('span', { className: `personnel-import-outcome personnel-import-outcome--${outcome.toLowerCase()}`, text: personnelImportOutcomeLabel(outcome) }));
      tr.appendChild(status);
      const handling = labeledTd('Hướng xử lý');
      handling.appendChild(el('span', { className: 'personnel-import-row-message', text: messages.join(' · ') }));
      tr.appendChild(handling);
      tbody.appendChild(tr);
    });
    if (!rows.length) {
      const tr = el('tr');
      tr.appendChild(el('td', { className: 'muted', text: 'Không có dòng dữ liệu để xem trước.', attrs: { colspan: '6' } }));
      tbody.appendChild(tr);
    }
    const validated = personnelImportState.validation;
    setText('personnel-import-preview-description', validated
      ? `${validated.counts?.create || 0} tạo mới · ${validated.counts?.update || 0} cập nhật · ${validated.counts?.error || 0} lỗi${validated.rows?.length > 50 ? ' · đang hiển thị 50 dòng đầu' : ''}`
      : `Hiển thị ${rows.length} dòng mẫu. Chưa có dữ liệu nào được nhập.`);
    requestTableLabelHydration();
  }

  function renderPersonnelImportMetrics() {
    const aside = $('personnel-import-metrics');
    if (!aside) return;
    const visible = Boolean(personnelImportState.preview && ['roles', 'review'].includes(personnelImportState.step));
    aside.classList.toggle('hidden', !visible);
    if (!visible) return;
    const validation = personnelImportState.validation;
    const total = Number(personnelImportState.preview.totalRows || 0);
    const valid = validation ? Number(validation.counts?.create || 0) + Number(validation.counts?.update || 0) + Number(validation.counts?.unchanged || 0) : 0;
    const warnings = validation ? (validation.rows || []).filter((row) => row.warnings?.length).length : personnelImportRoleMissingCount();
    const errors = validation ? Number(validation.counts?.error || 0) : 0;
    const impact = validation ? Number(validation.counts?.create || 0) + Number(validation.counts?.update || 0) : 0;
    setText('personnel-import-metric-total', String(total));
    setText('personnel-import-metric-valid', String(valid));
    setText('personnel-import-metric-warning', String(warnings));
    setText('personnel-import-metric-error', String(errors));
    setText('personnel-import-metric-impact', String(impact));
    setText('personnel-import-summary-note', validation
      ? `Batch ${validation.status === 'VALIDATED' ? 'đã kiểm tra' : 'còn lỗi'} · checksum được giữ đến khi commit.`
      : 'Đang chuẩn bị đối chiếu; chưa gửi dữ liệu vào hệ thống.');
  }

  function renderPersonnelImportFileCard() {
    const card = $('personnel-import-file-card');
    const meta = personnelImportState.fileMeta;
    if (!card) return;
    card.classList.toggle('hidden', !meta);
    if (!meta) return;
    setText('personnel-import-file-name', meta.name || 'personnel.xlsx');
    const size = Number(meta.size || 0);
    const sizeText = size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(size / 1024))} KB`;
    setText('personnel-import-file-detail', `${personnelImportState.preview?.totalRows || 0} dòng dữ liệu · ${sizeText}`);
    const badge = $('personnel-import-file-status');
    if (badge) {
      badge.textContent = meta.status === 'parsed' ? 'Đã phân tích' : meta.status === 'error' ? 'Có lỗi' : 'Đang xử lý';
      badge.className = `admin-status-badge ${meta.status === 'parsed' ? 'done' : meta.status === 'error' ? 'failed' : 'processing'}`;
    }
  }

  function personnelImportCommitDisabledReason() {
    const validation = personnelImportState.validation;
    if (!validation) return 'Cần kiểm tra dữ liệu trước khi nhập.';
    if (!validation.commitAllowed) return validation.counts?.error ? 'Cần xử lý hết lỗi trước khi nhập.' : 'Batch không có thay đổi để nhập.';
    const reason = String($('personnel-import-reason')?.value || '').trim();
    if (reason.length < 8) return 'Lý do nhập phải có ít nhất 8 ký tự.';
    if (validation.requiredConfirmation && String($('personnel-import-confirmation')?.value || '') !== validation.requiredConfirmation) {
      return 'Nhập đúng chuỗi xác nhận nhạy cảm để tiếp tục.';
    }
    return '';
  }

  function renderPersonnelImportActions() {
    const step = personnelImportState.step;
    const back = $('personnel-import-back');
    const next = $('personnel-import-next');
    const validate = $('personnel-import-validate');
    const commit = $('personnel-import-commit');
    const cancel = $('personnel-import-cancel');
    if (back) back.classList.toggle('hidden', !['columns', 'roles', 'review'].includes(step));
    if (next) next.classList.toggle('hidden', step !== 'columns');
    if (validate) validate.classList.toggle('hidden', step !== 'roles');
    if (commit) commit.classList.toggle('hidden', step !== 'review');
    if (cancel) cancel.classList.toggle('hidden', step === 'success');
    let message = '';
    if (step === 'columns') {
      message = personnelImportMappingIssue();
      if (next) next.disabled = Boolean(message);
    } else if (step === 'roles') {
      const missing = personnelImportRoleMissingCount();
      message = missing ? `${missing} vai trò trong file chưa được đối chiếu.` : '';
      if (validate) validate.disabled = Boolean(missing) || personnelImportValidationInFlight;
    } else if (step === 'review') {
      message = personnelImportCommitDisabledReason();
      if (commit) commit.disabled = Boolean(message) || personnelImportCommitInFlight;
    }
    setText('personnel-import-action-message', message);
    [next, validate, commit].filter(Boolean).forEach((button) => {
      if (button.disabled && message) button.title = message;
      else button.removeAttribute('title');
    });
  }

  function renderPersonnelImportCommitFields() {
    const validation = personnelImportState.validation;
    const field = $('personnel-import-confirmation-field');
    const input = $('personnel-import-confirmation');
    if (field) field.classList.toggle('hidden', !validation?.requiredConfirmation);
    if (input && validation?.requiredConfirmation) input.placeholder = validation.requiredConfirmation;
    setText('personnel-import-confirmation-hint', validation?.requiredConfirmation
      ? `Nhập chính xác: ${validation.requiredConfirmation}` : '');
  }

  function renderPersonnelImportSuccess() {
    const success = $('personnel-import-success');
    const visible = personnelImportState.step === 'success' && personnelImportState.result;
    if (success) success.classList.toggle('hidden', !visible);
    if (!visible) return;
    const counts = personnelImportState.result.counts || {};
    setText('personnel-import-success-summary', `${counts.created || 0} tạo mới · ${counts.updated || 0} cập nhật · ${counts.unchanged || 0} không đổi.`);
  }

  function renderPersonnelImport() {
    ensurePersonnelImportIcons();
    renderPersonnelImportStepper();
    document.querySelectorAll('[data-personnel-step]').forEach((section) => {
      section.classList.toggle('hidden', section.dataset.personnelStep !== personnelImportState.step);
    });
    renderPersonnelImportFileCard();
    renderPersonnelColumnMapping();
    renderPersonnelRoleMapping();
    renderPersonnelImportPreview();
    renderPersonnelImportMetrics();
    renderPersonnelImportCommitFields();
    renderPersonnelImportSuccess();
    renderPersonnelImportActions();
    const sticky = document.querySelector('.personnel-import-sticky');
    if (sticky) sticky.classList.toggle('hidden', personnelImportState.step === 'success');
  }

  async function loadPersonnelImportCatalog(force = false) {
    if (personnelImportState.catalog && !force) return true;
    const response = await withActionRequestContext({ actionId: 'personnel_import.retry', mutation: false }, () => api(PERSONNEL_IMPORT_API.catalog));
    if (!response.ok) {
      showPersonnelImportState(response.status === 403 ? 'denied' : 'error', personnelImportErrorMessage(response.status === 403 ? 'forbidden' : response.data?.error));
      return false;
    }
    personnelImportState.catalog = response.data || { roles: [] };
    renderPersonnelRoleMapping();
    return true;
  }

  async function downloadPersonnelImportWorkbook(kind) {
    const actionId = kind === 'example' ? 'personnel_import.open_example' : 'personnel_import.download_template';
    const endpoint = kind === 'example' ? PERSONNEL_IMPORT_API.example : PERSONNEL_IMPORT_API.template;
    const button = $(kind === 'example' ? 'personnel-import-open-example' : 'personnel-import-download-template');
    const finish = setButtonLoading(button, kind === 'example' ? 'Đang tải ví dụ…' : 'Đang tải mẫu…');
    try {
      const response = await withActionRequestContext({ actionId, mutation: false }, () => fetch('/qlcl/api' + endpoint, {
        credentials: 'same-origin',
        headers: { Accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ...actionRequestHeaders() },
      }));
      if (!response.ok) {
        showPersonnelImportState(response.status === 403 ? 'denied' : 'error', personnelImportErrorMessage(response.status === 403 ? 'forbidden' : 'network'));
        return;
      }
      const blob = await response.blob();
      downloadBlob(blob, fileNameFromDisposition(response.headers.get('Content-Disposition')) || `personnel-import-${kind}.xlsx`);
      showToast(kind === 'example' ? 'Đã tải file ví dụ synthetic.' : 'Đã tải file mẫu nhập nhân sự.', 'ok');
    } catch {
      showPersonnelImportState('error', personnelImportErrorMessage('network'));
    } finally {
      finish();
    }
  }

  function initializePersonnelImportMappings(preview) {
    personnelImportState.columnMapping = Object.fromEntries(PERSONNEL_IMPORT_FIELDS.map((field) => [
      field.key, preview.suggestedColumnMapping?.[field.key] || null,
    ]));
    personnelImportState.roleValueMapping = {};
    updatePersonnelIgnoredColumns();
  }

  async function previewPersonnelImportFile(file) {
    if (!file) return;
    showPersonnelImportState('', '');
    const validExtension = /\.xlsx$/i.test(file.name || '');
    const validMime = !file.type || file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if (!validExtension || !validMime || file.size > 5 * 1024 * 1024) {
      const code = file.size > 5 * 1024 * 1024 ? 'file_too_large' : 'invalid_file_type';
      personnelImportState.fileMeta = { name: file.name, size: file.size, status: 'error' };
      renderPersonnelImportFileCard();
      showPersonnelImportState('error', personnelImportErrorMessage(code));
      return;
    }
    personnelImportState.fileMeta = { name: file.name, size: file.size, status: 'parsing' };
    renderPersonnelImportFileCard();
    showPersonnelImportState('loading', 'Đang phân tích file và tạo preview an toàn…');
    const form = new FormData();
    form.append('file', file, file.name);
    const response = await withActionRequestContext({ actionId: 'personnel_import.upload_preview', mutation: false }, () => api(PERSONNEL_IMPORT_API.preview, {
      method: 'POST', body: form,
    }));
    if (!response.ok) {
      personnelImportState.preview = null;
      personnelImportState.fileMeta.status = 'error';
      renderPersonnelImportFileCard();
      showPersonnelImportState(response.status === 403 ? 'denied' : 'error', personnelImportErrorMessage(response.status === 403 ? 'forbidden' : response.data?.error));
      return;
    }
    personnelImportState.preview = response.data.item;
    personnelImportState.validation = null;
    personnelImportState.result = null;
    personnelImportState.idempotencyKey = '';
    personnelImportState.fileMeta.status = 'parsed';
    personnelImportState.dirty = true;
    personnelImportState.committed = false;
    personnelImportStableHash = window.location.hash;
    initializePersonnelImportMappings(personnelImportState.preview);
    showPersonnelImportState('ready', `Đã phân tích ${personnelImportState.preview.totalRows || 0} dòng. Chưa có dữ liệu nào được nhập.`);
    setPersonnelImportStep('columns');
  }

  async function validatePersonnelImport() {
    if (personnelImportValidationInFlight || !personnelImportState.preview) return;
    const mappingIssue = personnelImportMappingIssue();
    if (mappingIssue) {
      showPersonnelImportState('error', mappingIssue);
      setPersonnelImportStep('columns');
      return;
    }
    personnelImportValidationInFlight = true;
    renderPersonnelImportActions();
    showPersonnelImportState('loading', 'Đang kiểm tra dữ liệu đối chiếu, quyền hiệu lực và rủi ro…');
    updatePersonnelIgnoredColumns();
    try {
      const response = await withActionRequestContext({ actionId: 'personnel_import.validate', mutation: false }, () => api(`${PERSONNEL_IMPORT_API.batches}${encodeURIComponent(personnelImportState.preview.batchId)}/validate`, {
        method: 'POST',
        body: {
          expectedSourceChecksum: personnelImportState.preview.sourceChecksum,
          columnMapping: personnelImportState.columnMapping,
          ignoredColumns: personnelImportState.ignoredColumns,
          roleValueMapping: personnelImportState.roleValueMapping,
        },
      }));
      if (!response.ok) {
        showPersonnelImportState(response.status === 403 ? 'denied' : 'error', personnelImportErrorMessage(response.status === 403 ? 'forbidden' : response.data?.error));
        return;
      }
      personnelImportState.validation = response.data.item;
      personnelImportState.idempotencyKey = `personnel-import-ui-${crypto.randomUUID()}`;
      personnelImportState.dirty = true;
      showPersonnelImportState(response.data.item.commitAllowed ? 'ready' : 'error', response.data.item.commitAllowed
        ? 'Batch hợp lệ. Kiểm tra summary, nhập lý do và xác nhận trước khi commit.'
        : `Batch còn ${response.data.item.counts?.error || 0} lỗi và chưa thể commit.`);
      setPersonnelImportStep('review');
    } finally {
      personnelImportValidationInFlight = false;
      renderPersonnelImportActions();
    }
  }

  async function commitPersonnelImport() {
    if (personnelImportCommitInFlight || !personnelImportState.validation) return;
    const disabledReason = personnelImportCommitDisabledReason();
    if (disabledReason) {
      showPersonnelImportState('error', disabledReason);
      return;
    }
    personnelImportCommitInFlight = true;
    renderPersonnelImportActions();
    const button = $('personnel-import-commit');
    const finish = setButtonLoading(button, 'Đang nhập…');
    showPersonnelImportState('loading', 'Đang commit toàn bộ batch trong một transaction…');
    try {
      const response = await withActionRequestContext({
        actionId: 'personnel_import.commit',
        mutation: true,
        idempotencyKey: personnelImportState.idempotencyKey,
      }, () => api(`${PERSONNEL_IMPORT_API.batches}${encodeURIComponent(personnelImportState.preview.batchId)}/commit`, {
        method: 'POST',
        body: {
          expectedBatchChecksum: personnelImportState.validation.batchChecksum,
          reason: String($('personnel-import-reason')?.value || '').trim(),
          confirmation: personnelImportState.validation.requiredConfirmation
            ? String($('personnel-import-confirmation')?.value || '') : '',
        },
      }));
      if (!response.ok) {
        const message = personnelImportErrorMessage(response.status === 403 ? 'forbidden' : response.data?.error);
        showPersonnelImportState(response.status === 403 ? 'denied' : 'error', `${message} Không có dòng nào được commit một phần.`);
        return;
      }
      personnelImportState.result = response.data.item;
      personnelImportState.committed = true;
      personnelImportState.dirty = false;
      showPersonnelImportState('ready', 'Batch đã được commit và audit thành công.');
      setPersonnelImportStep('success');
    } finally {
      personnelImportCommitInFlight = false;
      finish();
      renderPersonnelImportActions();
    }
  }

  async function retryPersonnelImport() {
    if (personnelImportState.step === 'roles') {
      showPersonnelImportState('loading', 'Đang tải lại danh sách vai trò hiện hữu…');
      const ok = await loadPersonnelImportCatalog(true);
      if (ok) showPersonnelImportState('ready', 'Đã làm mới catalog role. Mapping hiện tại được giữ lại.');
      renderPersonnelImport();
      return;
    }
    await validatePersonnelImport();
  }

  async function confirmPersonnelImportRouteLeave(nextHash) {
    if (!personnelImportHasUnsaved() || nextHash === personnelImportStableHash) return true;
    const discard = await confirmAction({
      title: 'Rời batch nhập nhân sự chưa commit?',
      message: 'Mapping và checksum đang giữ trong bộ nhớ sẽ bị bỏ. Chưa có dữ liệu nào được nhập vào hệ thống.',
      cancelLabel: 'Tiếp tục đối chiếu',
      confirmLabel: 'Bỏ batch và rời trang',
      destructive: true,
    });
    if (discard) resetPersonnelImportState();
    return Boolean(discard);
  }

  async function cancelPersonnelImport() {
    const canLeave = await confirmPersonnelImportRouteLeave('#/admin/users');
    if (canLeave) navigateToTab('admin-users');
  }

  async function loadPersonnelImport() {
    ensurePersonnelImportIcons();
    renderPersonnelImport();
    await loadPersonnelImportCatalog();
    renderPersonnelImport();
  }

  $('personnel-import-download-template')?.addEventListener('click', () => downloadPersonnelImportWorkbook('template'));
  $('personnel-import-open-example')?.addEventListener('click', () => downloadPersonnelImportWorkbook('example'));
  $('personnel-import-select-file')?.addEventListener('click', () => $('personnel-import-file')?.click());
  $('personnel-import-file')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0] || null;
    event.target.value = '';
    await previewPersonnelImportFile(file);
  });
  $('personnel-import-next')?.addEventListener('click', () => setPersonnelImportStep('roles'));
  $('personnel-import-back')?.addEventListener('click', () => {
    const previous = { columns: 'upload', roles: 'columns', review: 'roles' }[personnelImportState.step];
    if (previous) setPersonnelImportStep(previous);
  });
  $('personnel-import-validate')?.addEventListener('click', validatePersonnelImport);
  $('personnel-import-retry')?.addEventListener('click', retryPersonnelImport);
  $('personnel-import-refresh-roles')?.addEventListener('click', retryPersonnelImport);
  $('personnel-import-commit')?.addEventListener('click', commitPersonnelImport);
  $('personnel-import-cancel')?.addEventListener('click', cancelPersonnelImport);
  $('personnel-import-return-users')?.addEventListener('click', () => navigateToTab('admin-users'));
  $('personnel-import-reason')?.addEventListener('input', renderPersonnelImportActions);
  $('personnel-import-confirmation')?.addEventListener('input', renderPersonnelImportActions);
  window.addEventListener('beforeunload', (event) => {
    if (!personnelImportHasUnsaved()) return;
    event.preventDefault();
    event.returnValue = '';
  });

  // ============ Authorization administration (RUN-10) ============
  const AUTHZ_TABS = Object.freeze(['users', 'roles', 'approvals', 'history']);
  let authzActiveTab = 'users';
  let authzCatalog = null;
  let authzUsers = [];
  let authzUserDetails = new Map();
  let authzAssignments = [];
  let authzSelectedRole = null;
  let authzRoleDetail = null;
  let authzSelectedUser = null;
  let authzUserDetail = null;
  let authzRoleDrafts = [];
  let authzScopeDrafts = [];
  let authzEditingApprovalId = null;
  let authzUnsaved = false;
  let authzRoleCreateMode = null;
  let authzStableHash = window.location.hash;
  let authzRouteBypass = false;
  let authzRoleRequestSequence = 0;
  let authzUserRequestSequence = 0;
  let authzHistoryRows = [];
  let authzHistoryPage = 0;
  let authzHistoryRequestSequence = 0;
  let authzHistorySearchTimer = null;
  let authzHistoryMeta = {
    pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1, hasPrevious: false, hasNext: false },
    summary: { total: 0, system: 0, manual: 0, missingReason: 0 },
  };
  const AUTHZ_HISTORY_PAGE_SIZE = 20;
  let authzUserEditorOpen = false;
  let authzRoleEditorOpen = false;
  let authzUserEditorTrigger = null;
  let authzRoleEditorTrigger = null;

  function authzUserKey(user) {
    return user?.user_id || user?.userId || user?.email || '';
  }

  function requiredConfirmation(action, objectKey) {
    const labels = {
      PUBLISH_ROLE: 'PUBLISH ROLE',
      DELETE_ROLE: 'DELETE ROLE',
      ASSIGN_ROLES: 'ASSIGN ROLES',
      ASSIGN_SCOPE: 'ASSIGN SCOPE',
      PUBLISH_APPROVER: 'PUBLISH APPROVER',
    };
    return `${labels[action] || action} ${String(objectKey || '').trim()}`;
  }

  function setAuthzUnsaved(value) {
    authzUnsaved = value === true;
    if (authzUnsaved) authzStableHash = window.location.hash;
    const shell = $('authorization-admin');
    if (shell) shell.dataset.unsaved = authzUnsaved ? 'true' : 'false';
    if (authzActiveTab === 'users') syncGuidedWorkspace('users', authzUnsaved ? 3 : authzSelectedUser ? 2 : 1);
    if (authzActiveTab === 'roles') syncGuidedWorkspace('roles', authzUnsaved ? 3 : authzSelectedRole ? 2 : 1);
    if (authzActiveTab === 'approvals') syncGuidedWorkspace('approval-assignments', authzUnsaved ? 3 : authzEditingApprovalId ? 2 : 1);
  }

  async function confirmAuthzRouteLeave(nextHash) {
    if (!authzUnsaved || nextHash === authzStableHash) return true;
    const discard = await confirmAction({
      title: 'Bỏ thay đổi phân quyền chưa lưu?',
      message: 'Bạn đang rời Trung tâm quản trị khi bản nháp phân quyền chưa được publish.',
      cancelLabel: 'Tiếp tục chỉnh sửa',
      confirmLabel: 'Bỏ bản nháp và rời trang',
      destructive: true,
    });
    if (discard) setAuthzUnsaved(false);
    return discard;
  }

  function showAuthzState(stateName, message) {
    const node = $('authz-admin-state');
    if (!node) return;
    node.dataset.state = stateName;
    const icon = node.querySelector('[data-authz-state-icon]');
    const text = node.querySelector('[data-authz-state-message]');
    if (icon) icon.textContent = stateName === 'loading' ? '◌' : stateName === 'ready' ? '✓' : stateName === 'empty' ? '○' : '!';
    if (text) text.textContent = message || '';
    if (stateName === 'error' || stateName === 'denied') node.focus();
  }

  function authzErrorMessage(response) {
    const error = response?.data?.error;
    const labels = {
      forbidden_permission: 'Bạn không có quyền USER.MANAGE để mở cấu hình này.',
      cannot_self_escalate: 'Không thể tự mở rộng quyền hoặc phạm vi của chính bạn.',
      last_super_admin_required: 'Hệ thống phải luôn còn ít nhất một SYS_ADMIN hiệu lực.',
      exact_confirmation_required: 'Chuỗi xác nhận chưa khớp chính xác.',
      change_reason_required: 'Lý do phải có từ 8 đến 500 ký tự.',
      approval_candidate_missing: 'Fixture không tìm thấy approver hiệu lực trong phạm vi.',
      approval_assignment_conflict: 'Phân công xung đột với một approver cùng stage, scope và priority.',
      approval_stage_missing: 'Không thể publish vì workflow sẽ thiếu stage bắt buộc.',
      system_role_delete_forbidden: 'Vai trò hệ thống không thể xóa.',
      role_in_use: 'Vai trò đang được gán cho người dùng hoặc stage phê duyệt.',
    };
    return labels[error] || 'Không thể lưu cấu hình phân quyền. Dữ liệu hiện tại được giữ nguyên.';
  }

  function applyExpectedConfirmation(response, inputId) {
    const expected = response?.data?.expectedConfirmation;
    if (expected && $(inputId)) {
      $(inputId).placeholder = expected;
      $(inputId).focus();
    }
  }

  function toApiInstant(value) {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : value;
  }

  function toLocalInput(value) {
    return value ? String(value).replace(' ', 'T').slice(0, 16) : '';
  }

  function option(value, label, selected) {
    return el('option', { text: label, attrs: { value, ...(selected ? { selected: 'selected' } : {}) } });
  }

  function fillSelect(select, items, value) {
    if (!select) return;
    select.textContent = '';
    items.forEach((item) => select.appendChild(option(item.value, item.label, item.value === value)));
  }

  function setAuthzDrawerState(kind, open, trigger = null, restoreFocus = true) {
    const isUser = kind === 'user';
    const drawer = $(isUser ? 'authz-user-detail' : 'authz-role-form');
    const backdrop = $(isUser ? 'authz-user-detail-backdrop' : 'authz-role-form-backdrop');
    if (!drawer || !backdrop) return;
    const wasOpen = isUser ? authzUserEditorOpen : authzRoleEditorOpen;
    if (isUser) {
      authzUserEditorOpen = open;
      if (open) authzUserEditorTrigger = trigger || document.activeElement;
    } else {
      authzRoleEditorOpen = open;
      if (open) authzRoleEditorTrigger = trigger || document.activeElement;
    }
    drawer.classList.toggle('is-open', open);
    backdrop.classList.toggle('is-open', open);
    drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
    backdrop.setAttribute('aria-hidden', open ? 'false' : 'true');
    document.body.classList.toggle('authz-drawer-open', authzUserEditorOpen || authzRoleEditorOpen);
    document.body.classList.toggle('authz-user-drawer-open', authzUserEditorOpen);
    document.body.classList.toggle('authz-role-drawer-open', authzRoleEditorOpen);
    if (open) {
      window.setTimeout(() => drawer.querySelector('h4[tabindex="-1"]')?.focus(), 0);
    } else if (restoreFocus && wasOpen) {
      const previous = isUser ? authzUserEditorTrigger : authzRoleEditorTrigger;
      if (previous?.isConnected) previous.focus();
    }
    if (!open && wasOpen) {
      if (isUser) { authzUserEditorTrigger = null; renderFilteredAuthzUsers(); }
      else { authzRoleEditorTrigger = null; renderAuthzRoleCatalog(); }
    }
  }

  function hideAuthzDrawers(options = {}) {
    setAuthzDrawerState('user', false, null, options.restoreFocus !== false);
    setAuthzDrawerState('role', false, null, options.restoreFocus !== false);
  }

  async function requestCloseAuthzDrawer(kind) {
    if (authzUnsaved) {
      const discard = await confirmAction({
        title: 'Bỏ thay đổi chưa lưu?',
        message: 'Các thay đổi trong drawer chưa được lưu.',
        cancelLabel: 'Tiếp tục chỉnh sửa',
        confirmLabel: 'Bỏ thay đổi',
        destructive: true,
      });
      if (!discard) return;
      setAuthzUnsaved(false);
    }
    setAuthzDrawerState(kind, false);
  }

  function trapAuthzDrawerFocus(event) {
    if (event.key !== 'Tab') return;
    const drawer = authzUserEditorOpen ? $('authz-user-detail') : authzRoleEditorOpen ? $('authz-role-form') : null;
    if (!drawer) return;
    const focusable = [...drawer.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  async function selectAuthzTab(nextTab, options = {}) {
    if (!AUTHZ_TABS.includes(nextTab)) return;
    if (!options.force && authzUnsaved) {
      const discard = await confirmAction({
        title: 'Bỏ thay đổi chưa lưu?',
        message: 'Bản nháp phân quyền hiện tại chưa được publish.',
        cancelLabel: 'Tiếp tục chỉnh sửa',
        confirmLabel: 'Bỏ bản nháp',
        destructive: true,
      });
      if (!discard) return;
      setAuthzUnsaved(false);
    }
    authzActiveTab = nextTab;
    hideAuthzDrawers({ restoreFocus: false });
    document.querySelector('[data-testid="authorization-admin"]')?.setAttribute('data-authz-active', nextTab);
    $('btn-add-user')?.classList.toggle('hidden', nextTab !== 'users');
    document.querySelectorAll('[data-authz-tab]').forEach((button) => {
      const active = button.dataset.authzTab === nextTab;
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      button.tabIndex = active ? 0 : -1;
    });
    document.querySelectorAll('[data-authz-pane]').forEach((pane) => {
      pane.classList.toggle('hidden', pane.dataset.authzPane !== nextTab);
    });
    const heading = document.querySelector(`[data-authz-pane="${nextTab}"] h4[tabindex="-1"]`);
    if (heading && options.focus !== false) heading.focus();
    if (window.matchMedia('(max-width: 900px)').matches) {
      document.querySelector(`[data-authz-tab="${nextTab}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
    if (nextTab === 'users') syncGuidedWorkspace('users', authzSelectedUser ? 2 : 1);
    if (nextTab === 'roles') syncGuidedWorkspace('roles', authzSelectedRole ? 2 : 1);
    if (nextTab === 'approvals') syncGuidedWorkspace('approval-assignments', authzEditingApprovalId ? 2 : 1);
    if (nextTab === 'history') await loadAuthzHistory();
  }

  function authzUserHealth(detail) {
    const explanations = detail?.effective?.explanations || [];
    return {
      expired: explanations.some((item) => item.type === 'expired_role'),
      conflict: explanations.some((item) => item.type === 'permission_conflict' || item.type === 'scope_conflict'),
    };
  }

  function renderAuthzUserFilters() {
    if (!authzCatalog) return;
    const select = $('authz-user-role-filter');
    const current = select?.value || 'all';
    fillSelect(select, [
      { value: 'all', label: 'Tất cả vai trò' },
      ...authzCatalog.roles.map((role) => ({ value: role.roleCode, label: role.displayLabel })),
    ], current);
  }

  function filteredAuthzUsers() {
    const query = String($('authz-user-search')?.value || '').trim().toLocaleLowerCase('vi');
    const active = $('authz-user-active-filter')?.value || 'all';
    const roleCode = $('authz-user-role-filter')?.value || 'all';
    const healthFilter = $('authz-user-health-filter')?.value || 'all';
    return authzUsers.filter((user) => {
      const detail = authzUserDetails.get(authzUserKey(user));
      const health = authzUserHealth(detail);
      const haystack = `${user.email} ${user.display_name || ''}`.toLocaleLowerCase('vi');
      if (query && !haystack.includes(query)) return false;
      if (active === 'active' && !user.is_active) return false;
      if (active === 'inactive' && user.is_active) return false;
      if (roleCode !== 'all' && !detail?.roles?.some((role) => role.active && role.roleCode === roleCode)) return false;
      if (healthFilter === 'expired' && !health.expired) return false;
      if (healthFilter === 'conflict' && !health.conflict) return false;
      return true;
    });
  }

  function renderFilteredAuthzUsers() {
    const filtered = filteredAuthzUsers();
    renderUsers(filtered);
    const summary = $('authz-user-filter-summary');
    if (summary) {
      const conflictCount = authzUsers.filter((user) => authzUserHealth(authzUserDetails.get(authzUserKey(user))).conflict).length;
      const expiredCount = authzUsers.filter((user) => authzUserHealth(authzUserDetails.get(authzUserKey(user))).expired).length;
      summary.textContent = `${filtered.length}/${authzUsers.length} nhân sự · ${expiredCount} có vai trò hết hạn · ${conflictCount} có quyền đang bị giới hạn`;
    }
  }

  async function loadAuthorizationAdmin(force = false) {
    if (!force && authzCatalog && authzUsers.length) {
      showAuthzState('ready', 'Sẵn sàng');
      return;
    }
    showAuthzState('loading', 'Đang tải role, permission, scope và approver…');
    const [catalogResponse, usersResponse, approvalsResponse] = await Promise.all([
      api('/admin/authorization/catalog'),
      api('/admin/users'),
      api('/admin/authorization/approval-assignments'),
    ]);
    if (!catalogResponse.ok) {
      showAuthzState(catalogResponse.status === 403 ? 'denied' : 'error', authzErrorMessage(catalogResponse));
      return;
    }
    authzCatalog = catalogResponse.data;
    authzUsers = usersResponse.ok ? usersResponse.data.items || [] : [];
    authzAssignments = approvalsResponse.ok
      ? (approvalsResponse.data.items || []).filter((item) => item.workflowType === 'EVALUATION')
      : [];
    const detailResponses = await Promise.all(authzUsers.map(async (user) => ({
      userId: authzUserKey(user),
      response: await api(`/admin/authorization/users/${encodeURIComponent(authzUserKey(user))}`),
    })));
    authzUserDetails = new Map(detailResponses.filter((item) => item.response.ok)
      .map((item) => [item.userId, item.response.data]));
    renderAuthzUserFilters();
    renderFilteredAuthzUsers();
    renderAuthzRoleCatalog();
    renderPermissionRoleSelect();
    renderAuthzUserSelects();
    renderApprovalAssignments();
    syncApprovalSubjectOptions();
    showAuthzState(authzUsers.length || authzCatalog.roles.length ? 'ready' : 'empty',
      authzUsers.length || authzCatalog.roles.length ? 'Sẵn sàng' : 'Chưa có dữ liệu phân quyền.');
    if (!authzSelectedRole && authzCatalog.roles.length) await loadAuthzRole(authzCatalog.roles[0].roleCode);
    if (!authzSelectedUser && authzUsers.length) await loadAuthzUser(authzUserKey(authzUsers[0]));
  }

  function renderAuthzRoleCatalog() {
    const root = $('authz-role-list');
    if (!root || !authzCatalog) return;
    root.textContent = '';
    const search = $('authz-role-search')?.value.trim().toLocaleLowerCase('vi-VN') || '';
    const status = $('authz-role-status-filter')?.value || 'all';
    const roles = authzCatalog.roles.filter((role) => {
      if (status === 'active' && !role.active) return false;
      if (status === 'inactive' && role.active) return false;
      return !search || [role.displayLabel, role.roleCode].some((value) => String(value || '').toLocaleLowerCase('vi-VN').includes(search));
    });
    const summary = $('authz-role-filter-summary');
    if (summary) summary.textContent = `${roles.length}/${authzCatalog.roles.length} vai trò`;
    if (!roles.length) return root.appendChild(el('div', {
      className: 'authz-empty admin-state admin-state--empty',
      text: authzCatalog.roles.length ? 'Không có vai trò phù hợp bộ lọc.' : 'Chưa có vai trò.',
      attrs: { role: 'status' },
    }));
    roles.forEach((role) => {
      const card = el('div', { className: `authz-role-card${authzSelectedRole === role.roleCode && authzRoleEditorOpen ? ' active' : ''}`, attrs: { role: 'listitem' } });
      const label = el('button', { className: 'authz-role-open', attrs: { type: 'button', 'data-action-id': 'authorization.role_select' } });
      label.appendChild(el('strong', { text: role.displayLabel }));
      label.appendChild(el('div', { className: 'muted', text: role.roleKind === 'system' || role.role_kind === 'system' ? 'Vai trò hệ thống' : 'Vai trò tùy chỉnh' }));
      const permissions = el('div', { className: 'authz-role-actions' });
      const allowed = Array.isArray(role.allowedPermissions) ? role.allowedPermissions.slice(0, 3) : [];
      allowed.forEach((permissionCode) => permissions.appendChild(el('span', { className: 'tag sev-gray', text: permissionDisplayLabel(permissionCode), attrs: { title: permissionCode } })));
      if (!allowed.length) permissions.appendChild(el('span', { className: 'tag sev-gray', text: `${role.permissionCount} thao tác` }));
      if (Number(role.permissionCount || 0) > allowed.length && allowed.length) permissions.appendChild(el('span', { className: 'muted', text: `+${role.permissionCount - allowed.length}` }));
      if (role.approvalCount) permissions.appendChild(el('span', { className: 'tag sev-gray', text: `${role.approvalCount} bước duyệt` }));
      const people = el('span', { className: 'authz-role-people', text: `${role.userCount} người` });
      const statusNode = el('span', { className: `tag sev-${role.active ? 'green' : 'gray'}`, text: role.active ? 'Hoạt động' : 'Tạm ngưng' });
      const menu = RowActionGroup([], [
        actionDescriptor('authorization.role_select', () => openAuthzRoleEditor(role.roleCode, label), null, { label: 'Chỉnh sửa', icon: 'pen', announceSuccess: false }),
        actionDescriptor('authorization.role_clone', async () => {
          const loaded = await loadAuthzRole(role.roleCode);
          if (loaded) beginNewRole(role.roleCode, authzRoleDetail, label);
        }, null, { label: 'Nhân bản', icon: 'copy', announceSuccess: false }),
      ]);
      setRegisteredButtonAction(label, 'authorization.role_select', () => openAuthzRoleEditor(role.roleCode, label), { announceSuccess: false });
      card.append(label, permissions, people, statusNode, menu);
      root.appendChild(card);
    });
  }

  function renderPermissionRoleSelect() {
    if (!authzCatalog) return;
    fillSelect($('authz-permission-role'), authzCatalog.roles.map((role) => ({ value: role.roleCode, label: `${role.displayLabel} · ${role.roleCode}` })), authzSelectedRole);
  }

  async function loadAuthzRole(roleCode) {
    const requestSequence = ++authzRoleRequestSequence;
    if (authzUnsaved && (authzRoleCreateMode || (authzSelectedRole && authzSelectedRole !== roleCode))) {
      const discard = await confirmAction({
        title: 'Bỏ bản nháp vai trò?', message: 'Các thay đổi quyền chưa publish sẽ bị mất.',
        cancelLabel: 'Tiếp tục chỉnh sửa', confirmLabel: 'Bỏ bản nháp', destructive: true,
      });
      if (requestSequence !== authzRoleRequestSequence) return false;
      if (!discard) return false;
      setAuthzUnsaved(false);
    }
    const response = await api(`/admin/authorization/roles/${encodeURIComponent(roleCode)}`);
    if (requestSequence !== authzRoleRequestSequence) return false;
    if (!response.ok) { showAuthzState('error', authzErrorMessage(response)); return false; }
    authzSelectedRole = roleCode;
    authzRoleDetail = response.data;
    authzRoleCreateMode = null;
    $('authz-role-code').value = authzRoleDetail.role_code;
    $('authz-role-code').readOnly = true;
    if ($('authz-role-technical')) $('authz-role-technical').open = false;
    $('authz-role-editor-title').textContent = 'Điều chỉnh vai trò';
    $('authz-role-label').value = authzRoleDetail.display_label;
    $('authz-role-status').value = authzRoleDetail.active ? 'active' : 'inactive';
    $('authz-role-counts').textContent = `${authzRoleDetail.userCount} nhân sự · ${authzRoleDetail.permissionCount} thao tác · ${authzRoleDetail.approvalCount || 0} bước duyệt`;
    const assignmentCount = authzRoleDetail.assignmentCount ?? authzRoleDetail.userCount;
    const deleteReason = authzRoleDetail.role_kind === 'system'
      ? 'Vai trò hệ thống được bảo vệ và không thể xóa.'
      : authzRoleDetail.inUse
        ? `Vai trò có ${assignmentCount} lượt gán người dùng (kể cả lịch sử) và ${authzRoleDetail.approvalCount || 0} luồng duyệt.`
        : '';
    $('authz-delete-role').disabled = Boolean(deleteReason);
    setDisabledReason($('authz-delete-role'), deleteReason);
    $('authz-role-delete-reason').textContent = deleteReason;
    $('authz-role-reason').value = '';
    $('authz-role-confirm').value = '';
    $('authz-role-confirm').placeholder = requiredConfirmation('PUBLISH_ROLE', roleCode);
    renderAuthzRoleCatalog();
    renderPermissionRoleSelect();
    $('authz-permission-role').value = roleCode;
    renderPermissionMatrix();
    setAuthzUnsaved(false);
    return true;
  }

  async function openAuthzRoleEditor(roleCode, trigger = null) {
    const loaded = await loadAuthzRole(roleCode);
    if (!loaded) return;
    setAuthzDrawerState('user', false, null, false);
    setAuthzDrawerState('role', true, trigger);
    renderAuthzRoleCatalog();
  }

  function beginNewRole(cloneFrom = null, sourceDetail = null, trigger = null) {
    authzRoleRequestSequence += 1;
    authzRoleCreateMode = { cloneFrom };
    authzSelectedRole = null;
    authzRoleDetail = {
      role_code: '',
      display_label: '',
      active: true,
      role_kind: 'custom',
      userCount: 0,
      permissionCount: sourceDetail?.permissions?.length || 0,
      approvalCount: 0,
      permissions: (sourceDetail?.permissions || []).map((permission) => ({ ...permission })),
    };
    $('authz-role-code').readOnly = false;
    $('authz-role-code').value = '';
    $('authz-role-label').value = cloneFrom ? 'Bản sao vai trò' : '';
    $('authz-role-status').value = 'active';
    $('authz-role-counts').textContent = cloneFrom ? `Tạo bản sao từ ${roleDisplayLabel(cloneFrom)}; mã kỹ thuật mới sẽ không thể đổi sau khi tạo.` : 'Vai trò tùy chỉnh mới, chưa có quyền.';
    $('authz-delete-role').disabled = true;
    setDisabledReason($('authz-delete-role'), 'Vai trò chưa được tạo.');
    $('authz-role-delete-reason').textContent = 'Lưu vai trò trước khi có thể xóa.';
    $('authz-role-reason').value = '';
    $('authz-role-confirm').value = '';
    $('authz-role-editor-title').textContent = cloneFrom ? 'Tạo bản sao vai trò' : 'Tạo vai trò mới';
    $('authz-permission-lock')?.classList.add('hidden');
    if ($('authz-role-technical')) $('authz-role-technical').open = true;
    renderPermissionMatrix();
    setAuthzUnsaved(true);
    setAuthzDrawerState('user', false, null, false);
    setAuthzDrawerState('role', true, trigger);
    window.setTimeout(() => $('authz-role-code').focus(), 0);
    renderAuthzRoleCatalog();
  }

  function permissionEffectsForValue(value) {
    if (value === 'ALLOW_DENY') return ['ALLOW', 'DENY'];
    if (value === 'ALLOW' || value === 'DENY') return [value];
    return [];
  }

  function permissionAssignmentsFromForm() {
    return Array.from(document.querySelectorAll('[data-authz-permission-code]')).flatMap((select) =>
      permissionEffectsForValue(select.value).map((effect) => ({
        permissionCode: select.dataset.authzPermissionCode,
        effect,
      })));
  }

  function permissionEffectsByCode(assignments, codeKey) {
    const result = new Map();
    assignments.forEach((item) => {
      const code = item[codeKey];
      const effects = result.get(code) || new Set();
      effects.add(item.effect);
      result.set(code, effects);
    });
    return result;
  }

  const AUTHZ_MODULE_LABELS = Object.freeze({
    AUDIT: 'Lịch sử hệ thống', DASHBOARD: 'Bảng điều khiển', EVALUATION: 'Phiếu đánh giá',
    QUESTION_TEMPLATE: 'Bộ câu hỏi đánh giá', REPORT: 'Báo cáo', REPORT_TEMPLATE: 'Mẫu báo cáo',
    SCORING_POLICY: 'Chính sách tính điểm', SUPPLIER: 'Nhà cung cấp', SYSTEM: 'Quản trị hệ thống',
    USER: 'Nhân sự và phân quyền',
  });

  function permissionDescriptionText(permission) {
    return ({
      'SUPPLIER.PROPOSE': 'Đề xuất nhà cung cấp mới trong quy trình được giao.',
      'SUPPLIER.VERIFY': 'Xác minh thông tin nhà cung cấp được đề xuất.',
      'SUPPLIER.MERGE': 'Hợp nhất hồ sơ nhà cung cấp trùng đã được xác minh.',
    })[permission.permissionCode] || permission.description;
  }

  function permissionEffectLabel(effects) {
    const allow = effects?.has('ALLOW');
    const deny = effects?.has('DENY');
    if (allow && deny) return 'Có xung đột — hệ thống sẽ giới hạn';
    if (allow) return 'Được sử dụng';
    if (deny) return 'Bị giới hạn';
    return 'Chưa thiết lập';
  }

  function renderPermissionSummary() {
    if (!$('authz-before-summary') || !authzRoleDetail) return;
    const before = authzRoleDetail.permissions || [];
    const after = permissionAssignmentsFromForm();
    const beforeByCode = permissionEffectsByCode(before, 'permission_code');
    const afterByCode = permissionEffectsByCode(after, 'permissionCode');
    const changes = [...new Set([...beforeByCode.keys(), ...afterByCode.keys()])]
      .map((permissionCode) => ({
        permissionCode,
        beforeEffects: beforeByCode.get(permissionCode) || new Set(),
        afterEffects: afterByCode.get(permissionCode) || new Set(),
      }))
      .filter((item) => permissionEffectLabel(item.beforeEffects) !== permissionEffectLabel(item.afterEffects));
    const added = changes.filter((item) => item.beforeEffects.size === 0);
    const removed = changes.filter((item) => item.afterEffects.size === 0);
    const changed = changes.filter((item) => item.beforeEffects.size > 0 && item.afterEffects.size > 0);
    const allowCount = after.filter((item) => item.effect === 'ALLOW').length;
    const denyCount = after.filter((item) => item.effect === 'DENY').length;
    $('authz-before-summary').textContent = '';
    $('authz-before-summary').appendChild(el('strong', { text: `Hiện tại: ${before.length} thiết lập` }));
    $('authz-after-summary').textContent = '';
    $('authz-after-summary').appendChild(el('strong', { text: `Sau khi lưu: ${after.length} thiết lập` }));
    const deltaCount = changes.length;
    $('authz-after-summary').appendChild(el('p', { className: 'muted', text: `${allowCount} được sử dụng · ${denyCount} bị giới hạn · ${deltaCount ? `${deltaCount} thay đổi chưa lưu` : 'Chưa có khác biệt'}.` }));
    const delta = el('div', { className: 'authz-permission-delta' });
    delta.appendChild(el('p', { text: `Tác động dự kiến: ${authzRoleDetail.userCount || 0} nhân sự đang có vai trò này.` }));
    if (added.length) delta.appendChild(el('p', { text: `Thêm: ${added.map((item) => `${permissionDisplayLabel(item.permissionCode)} — ${permissionEffectLabel(item.afterEffects)}`).join(', ')}` }));
    if (changed.length) delta.appendChild(el('p', { text: `Thay đổi: ${changed.map((item) => `${permissionDisplayLabel(item.permissionCode)}: ${permissionEffectLabel(item.beforeEffects)} → ${permissionEffectLabel(item.afterEffects)}`).join(', ')}` }));
    if (removed.length) delta.appendChild(el('p', { text: `Bỏ: ${removed.map((item) => `${permissionDisplayLabel(item.permissionCode)} — ${permissionEffectLabel(item.beforeEffects)}`).join(', ')}` }));
    if (denyCount) delta.appendChild(el('p', { className: 'authz-deny-wins', text: 'Nếu một thao tác vừa được cho phép vừa bị giới hạn, hệ thống sẽ ưu tiên giới hạn để bảo vệ dữ liệu.' }));
    $('authz-after-summary').appendChild(delta);
  }

  function applyPermissionFilters() {
    const query = String($('authz-permission-search')?.value || '').trim().toLocaleLowerCase('vi');
    const effect = $('authz-permission-effect-filter')?.value || 'all';
    document.querySelectorAll('.authz-permission-row').forEach((row) => {
      const select = row.querySelector('[data-authz-permission-code]');
      const matchesQuery = !query || String(row.dataset.authzPermissionSearch || '').includes(query);
      const matchesEffect = effect === 'all'
        || (effect === 'assigned'
          ? select?.value !== 'NONE'
          : effect === 'NONE'
            ? select?.value === 'NONE'
            : effect === 'ALLOW_DENY'
              ? select?.value === 'ALLOW_DENY'
              : permissionEffectsForValue(select?.value).includes(effect));
      row.classList.toggle('authz-filter-hidden', !matchesQuery || !matchesEffect);
    });
    document.querySelectorAll('.authz-permission-group').forEach((group) => {
      const visible = group.querySelector('.authz-permission-row:not(.authz-filter-hidden)');
      group.classList.toggle('authz-filter-hidden', !visible);
    });
  }

  function renderPermissionMatrix() {
    const root = $('authz-permission-matrix');
    if (!root || !authzCatalog || !authzRoleDetail) return;
    root.textContent = '';
    const locked = authzRoleDetail.role_code === 'SYS_ADMIN';
    $('authz-permission-lock')?.classList.toggle('hidden', !locked);
    const grouped = new Map();
    authzCatalog.permissions.forEach((permission) => {
      const rows = grouped.get(permission.module) || [];
      rows.push(permission);
      grouped.set(permission.module, rows);
    });
    for (const [module, permissions] of grouped) {
      const group = el('details', { className: 'authz-permission-group', attrs: { open: 'open' } });
      const summary = el('summary');
      summary.appendChild(el('strong', { text: AUTHZ_MODULE_LABELS[module] || module }));
      summary.appendChild(el('span', { className: 'muted', text: `${permissions.length} thao tác` }));
      group.appendChild(summary);
      const permissionGrid = el('div', { className: 'authz-permission-grid' });
      permissions.forEach((permission) => {
        const friendlyDescription = permissionDescriptionText(permission);
        const row = el('div', { className: 'authz-permission-row', attrs: {
          'data-authz-permission-search': `${permission.permissionCode} ${friendlyDescription} ${permission.module}`.toLocaleLowerCase('vi'),
        } });
        const assignedEffects = new Set(authzRoleDetail.permissions
          .filter((item) => item.permission_code === permission.permissionCode)
          .map((item) => item.effect));
        const assignedValue = assignedEffects.has('ALLOW') && assignedEffects.has('DENY')
          ? 'ALLOW_DENY'
          : assignedEffects.has('ALLOW')
            ? 'ALLOW'
            : assignedEffects.has('DENY')
              ? 'DENY'
              : 'NONE';
        const label = el('label', { className: 'authz-permission-check', attrs: { title: friendlyDescription } });
        const checkbox = el('input', { attrs: { type: 'checkbox', 'data-authz-permission-primary': permission.permissionCode, 'aria-label': `Cho phép ${permissionDisplayLabel(permission.permissionCode)}` } });
        checkbox.checked = assignedValue === 'ALLOW';
        checkbox.indeterminate = assignedValue === 'ALLOW_DENY';
        checkbox.disabled = locked;
        const copy = el('span', { className: 'authz-permission-copy' });
        copy.appendChild(el('strong', { text: permissionDisplayLabel(permission.permissionCode) }));
        copy.appendChild(el('small', { text: friendlyDescription }));
        label.append(checkbox, copy);
        const advanced = el('details', { className: 'authz-permission-state', attrs: assignedValue === 'DENY' || assignedValue === 'ALLOW_DENY' ? { open: 'open' } : {} });
        const advancedSummary = el('summary', { text: assignedValue === 'DENY' ? 'Đang giới hạn' : assignedValue === 'ALLOW_DENY' ? 'Có xung đột' : 'Trạng thái nâng cao' });
        const select = el('select', { className: 'input', attrs: { 'data-authz-permission-code': permission.permissionCode, 'aria-label': `Trạng thái nâng cao của ${permissionDisplayLabel(permission.permissionCode)}` } });
        const effects = [
          { value: 'NONE', label: 'Chưa thiết lập' },
          { value: 'ALLOW', label: 'Cho phép' },
          { value: 'DENY', label: 'Giới hạn' },
          { value: 'ALLOW_DENY', label: 'Cho phép + Giới hạn' },
        ];
        effects.forEach((effect) => select.appendChild(option(effect.value, effect.label, assignedValue === effect.value)));
        select.disabled = locked;
        const syncPrimary = () => {
          checkbox.checked = select.value === 'ALLOW';
          checkbox.indeterminate = select.value === 'ALLOW_DENY';
          advancedSummary.textContent = select.value === 'DENY' ? 'Đang giới hạn' : select.value === 'ALLOW_DENY' ? 'Có xung đột' : 'Trạng thái nâng cao';
          row.dataset.permissionState = select.value;
        };
        checkbox.addEventListener('change', () => {
          checkbox.indeterminate = false;
          select.value = checkbox.checked ? 'ALLOW' : 'NONE';
          syncPrimary();
          setAuthzUnsaved(true);
          renderPermissionSummary();
          applyPermissionFilters();
        });
        select.addEventListener('change', () => {
          syncPrimary();
          setAuthzUnsaved(true);
          renderPermissionSummary();
          applyPermissionFilters();
        });
        advanced.append(advancedSummary, select, el('small', { className: 'muted', text: `Mã kỹ thuật: ${permission.permissionCode}` }));
        row.append(label, advanced);
        syncPrimary();
        permissionGrid.appendChild(row);
      });
      group.appendChild(permissionGrid);
      root.appendChild(group);
    }
    $('authz-permission-confirm').placeholder = requiredConfirmation('PUBLISH_ROLE', authzSelectedRole);
    renderPermissionSummary();
    applyPermissionFilters();
  }

  function renderAuthzUserSelects() {
    const choices = authzUsers.map((user) => ({ value: authzUserKey(user), label: `${user.display_name || user.email} · ${user.email}` }));
    fillSelect($('authz-scope-user'), choices, authzSelectedUser);
    if (authzCatalog) {
      fillSelect($('authz-scope-role'), [{ value: '', label: 'Override trực tiếp người dùng' }, ...authzCatalog.roles.map((role) => ({ value: role.roleCode, label: role.displayLabel }))], '');
    }
  }

  async function loadAuthzUser(userId) {
    const requestSequence = ++authzUserRequestSequence;
    if (authzUnsaved && authzSelectedUser && authzSelectedUser !== userId) {
      const discard = await confirmAction({
        title: 'Bỏ bản nháp phân vai?', message: 'Các thay đổi role và validity window chưa lưu sẽ bị mất.',
        cancelLabel: 'Tiếp tục chỉnh sửa', confirmLabel: 'Bỏ bản nháp', destructive: true,
      });
      if (requestSequence !== authzUserRequestSequence) return false;
      if (!discard) return false;
      setAuthzUnsaved(false);
    }
    const response = await api(`/admin/authorization/users/${encodeURIComponent(userId)}`);
    if (requestSequence !== authzUserRequestSequence) return false;
    if (!response.ok) { showAuthzState('error', authzErrorMessage(response)); return false; }
    authzSelectedUser = response.data.user.userId || response.data.user.user_id || userId;
    authzUserDetail = response.data;
    authzUserDetails.set(authzSelectedUser, response.data);
    authzRoleDrafts = authzUserDetail.roles.filter((role) => role.source === 'MANUAL' && role.active).map((role) => ({
      roleCode: role.roleCode,
      validFrom: role.validFrom || null,
      validUntil: role.validUntil || null,
    }));
    authzScopeDrafts = authzUserDetail.scopes.filter((scope) => scope.source === 'MANUAL' && scope.active).map((scope) => ({ ...scope }));
    $('authz-user-role-reason').value = '';
    $('authz-user-role-confirm').value = '';
    renderAuthzUserDetail();
    renderAuthzScopes();
    renderAuthzUserSelects();
    if ($('authz-scope-user')) $('authz-scope-user').value = authzSelectedUser;
    renderFilteredAuthzUsers();
    setAuthzUnsaved(false);
    return true;
  }

  const AUTHZ_SCOPE_LABELS = Object.freeze({
    GLOBAL: 'Toàn bộ dữ liệu', REGION: 'Theo khu vực', MCH2: 'Theo ngành hàng',
    ASSIGNED: 'Dữ liệu được phân công', OWN: 'Dữ liệu do người này tạo',
    SUPPLIER: 'Theo nhà cung cấp', CUSTOM: 'Phạm vi tùy chỉnh',
  });

  function roleDisplayLabel(roleCode) {
    return authzCatalog?.roles?.find((role) => role.roleCode === roleCode)?.displayLabel || roleCode || 'Vai trò chưa xác định';
  }

  function permissionDisplayLabel(permissionCode) {
    const permission = authzCatalog?.permissions?.find((item) => item.permissionCode === permissionCode);
    return String(permission?.description || permissionCode || 'Thao tác chưa xác định').replace(/[.]$/u, '');
  }

  function scopeDisplayLabel(scopeType, scopeValue = null) {
    const base = AUTHZ_SCOPE_LABELS[scopeType] || 'Phạm vi khác';
    if (!scopeValue || ['GLOBAL', 'ASSIGNED', 'OWN'].includes(scopeType)) return base;
    return `${base}: ${scopeValue}`;
  }

  function workflowDisplayLabel(workflowType) {
    return workflowType === 'EVALUATION' ? 'Phiếu đánh giá' : workflowType;
  }

  function approvalStageDisplayLabel(stageCode) {
    return ({ LEAD: 'Lead miền', TBP: 'Trưởng bộ phận', GDK: 'Giám đốc khối' })[stageCode] || stageCode;
  }

  function approvalAssignedUser(assignment) {
    const principalId = assignment.assignedPrincipalId || assignment.assigned_principal_id || null;
    return authzUsers.find((user) => authzUserKey(user) === principalId
      || authzUserKey(user) === assignment.assignedUserId
      || user.email === assignment.assignedUserId);
  }

  async function openAuthzUserEditor(userId, trigger = null) {
    const loaded = await loadAuthzUser(userId);
    if (!loaded) return;
    setAuthzDrawerState('role', false, null, false);
    setAuthzDrawerState('user', true, trigger);
    renderFilteredAuthzUsers();
  }

  function authzAssignedRoleCodes() {
    return new Set([
      ...authzUserDetail.roles.filter((role) => role.source !== 'MANUAL' && role.active).map((role) => role.roleCode),
      ...authzRoleDrafts.map((role) => role.roleCode),
    ]);
  }

  function removeAuthzRoleDraft(roleCode) {
    authzRoleDrafts = authzRoleDrafts.filter((role) => role.roleCode !== roleCode);
    const inherited = authzUserDetail.roles.some((role) => role.roleCode === roleCode && role.source !== 'MANUAL' && role.active);
    const removedScopeCount = inherited ? 0 : authzScopeDrafts.filter((scope) => scope.roleCode === roleCode).length;
    if (!inherited) authzScopeDrafts = authzScopeDrafts.filter((scope) => scope.roleCode !== roleCode);
    setAuthzUnsaved(true);
    renderAuthzUserDetail();
    renderAuthzScopes();
    if (removedScopeCount) showToast(`Đã bỏ vai trò và ${removedScopeCount} phạm vi đi kèm khỏi bản nháp.`, 'info');
  }

  function addAuthzScopeDraft(form) {
    const scopeType = form.querySelector('[data-authz-drawer-scope-type]').value;
    const valueInput = form.querySelector('[data-authz-drawer-scope-value]');
    const roleCode = form.querySelector('[data-authz-drawer-scope-role]').value || null;
    const needsValue = !['GLOBAL', 'ASSIGNED', 'OWN'].includes(scopeType);
    const scopeValue = scopeType === 'GLOBAL' ? null : ['ASSIGNED', 'OWN'].includes(scopeType) ? 'SELF' : valueInput.value.trim();
    if (needsValue && !scopeValue) {
      valueInput.focus();
      return showToast('Vui lòng nhập giá trị phạm vi.', 'error');
    }
    const customSchemaCode = form.querySelector('[data-authz-drawer-custom-code]').value.trim();
    const customSchemaVersion = Number(form.querySelector('[data-authz-drawer-custom-version]').value || 0) || null;
    if (scopeType === 'CUSTOM' && (!customSchemaCode || !customSchemaVersion)) {
      form.querySelector('details').open = true;
      form.querySelector('[data-authz-drawer-custom-code]').focus();
      return showToast('Phạm vi tùy chỉnh cần mã và phiên bản schema.', 'error');
    }
    const draft = {
      roleCode,
      scopeType,
      scopeValue,
      effect: form.querySelector('[data-authz-drawer-scope-effect]').value,
      validFrom: toApiInstant(form.querySelector('[data-authz-drawer-scope-from]').value),
      validUntil: toApiInstant(form.querySelector('[data-authz-drawer-scope-until]').value),
      customSchemaCode: scopeType === 'CUSTOM' ? customSchemaCode : null,
      customSchemaVersion: scopeType === 'CUSTOM' ? customSchemaVersion : null,
      source: 'MANUAL',
      active: true,
    };
    const key = (scope) => `${scope.roleCode || ''}:${scope.scopeType}:${scope.scopeValue || ''}:${scope.effect}`;
    if (authzScopeDrafts.some((scope) => key(scope) === key(draft))) return showToast('Phạm vi này đã có trong bản nháp.', 'info');
    authzScopeDrafts.push(draft);
    setAuthzUnsaved(true);
    renderAuthzUserDetail();
    renderAuthzScopes();
  }

  function renderAuthzScopeDraftEditor(root) {
    const details = el('details', { className: 'authz-role-picker authz-scope-picker' });
    details.appendChild(el('summary', { text: 'Thêm phạm vi' }));
    const form = el('div', { className: 'authz-drawer-scope-form' });
    const typeField = el('label', { className: 'form-field' });
    typeField.appendChild(el('span', { text: 'Loại dữ liệu' }));
    const type = el('select', { className: 'input', attrs: { 'data-authz-drawer-scope-type': '' } });
    authzCatalog.scopeTypes.forEach((scope) => type.appendChild(option(scope.scopeType, AUTHZ_SCOPE_LABELS[scope.scopeType] || scope.scopeType)));
    typeField.appendChild(type);
    const valueField = el('label', { className: 'form-field' });
    valueField.appendChild(el('span', { text: 'Giá trị phạm vi' }));
    const value = el('input', { className: 'input', attrs: { 'data-authz-drawer-scope-value': '', placeholder: 'Nhập khu vực, ngành hàng hoặc nhà cung cấp' } });
    valueField.appendChild(value);
    const effectField = el('label', { className: 'form-field' });
    effectField.appendChild(el('span', { text: 'Quyền xem' }));
    const effect = el('select', { className: 'input', attrs: { 'data-authz-drawer-scope-effect': '' } });
    effect.append(option('ALLOW', 'Cho xem'), option('DENY', 'Không cho xem'));
    effectField.appendChild(effect);
    form.append(typeField, valueField, effectField);

    const advanced = el('details', { className: 'guided-disclosure authz-drawer-scope-advanced' });
    advanced.appendChild(el('summary', { text: 'Tùy chọn nâng cao' }));
    const advancedGrid = el('div', { className: 'guided-disclosure-grid' });
    const roleField = el('label', { className: 'form-field' });
    roleField.appendChild(el('span', { text: 'Đi kèm vai trò' }));
    const role = el('select', { className: 'input', attrs: { 'data-authz-drawer-scope-role': '' } });
    role.appendChild(option('', 'Áp dụng riêng cho nhân sự'));
    const assignedRoleCodes = authzAssignedRoleCodes();
    authzCatalog.roles.filter((item) => assignedRoleCodes.has(item.roleCode)).forEach((item) => role.appendChild(option(item.roleCode, item.displayLabel)));
    roleField.appendChild(role);
    const fromField = el('label', { className: 'form-field' });
    fromField.append(el('span', { text: 'Hiệu lực từ' }), el('input', { className: 'input', attrs: { type: 'datetime-local', 'data-authz-drawer-scope-from': '' } }));
    const untilField = el('label', { className: 'form-field' });
    untilField.append(el('span', { text: 'Hiệu lực đến' }), el('input', { className: 'input', attrs: { type: 'datetime-local', 'data-authz-drawer-scope-until': '' } }));
    const customCodeField = el('label', { className: 'form-field authz-custom-scope-field hidden' });
    customCodeField.append(el('span', { text: 'Mã schema tùy chỉnh' }), el('input', { className: 'input', attrs: { 'data-authz-drawer-custom-code': '' } }));
    const customVersionField = el('label', { className: 'form-field authz-custom-scope-field hidden' });
    customVersionField.append(el('span', { text: 'Phiên bản schema' }), el('input', { className: 'input', attrs: { type: 'number', min: '1', 'data-authz-drawer-custom-version': '' } }));
    advancedGrid.append(roleField, fromField, untilField, customCodeField, customVersionField);
    advanced.appendChild(advancedGrid);
    form.appendChild(advanced);
    const addButton = el('button', { className: 'btn-ghost authz-drawer-scope-add', text: 'Thêm vào danh sách', attrs: { type: 'button' } });
    setRegisteredButtonAction(addButton, 'authorization.scope_add', () => addAuthzScopeDraft(form), { announceSuccess: false });
    form.appendChild(addButton);
    const syncScopeFields = () => {
      const needsValue = !['GLOBAL', 'ASSIGNED', 'OWN'].includes(type.value);
      value.disabled = !needsValue;
      if (!needsValue) value.value = '';
      form.querySelectorAll('.authz-custom-scope-field').forEach((field) => field.classList.toggle('hidden', type.value !== 'CUSTOM'));
    };
    type.addEventListener('change', syncScopeFields);
    syncScopeFields();
    details.appendChild(form);
    root.appendChild(details);
  }

  function renderAuthzUserDetail() {
    const root = $('authz-user-role-list');
    if (!root || !authzCatalog || !authzUserDetail) return;
    $('authz-user-detail-title').textContent = 'Điều chỉnh vai trò & dữ liệu';
    const displayName = authzUserDetail.user.displayName || authzUserDetail.user.email;
    $('authz-user-detail-sub').textContent = displayName === authzUserDetail.user.email
      ? authzUserDetail.user.email
      : `${displayName} · ${authzUserDetail.user.email}`;
    const accountStatus = $('authz-user-account-status');
    if (accountStatus) {
      const isActive = authzUserDetail.user.active ?? authzUserDetail.user.isActive ?? authzUserDetail.user.is_active ?? true;
      accountStatus.textContent = '';
      accountStatus.dataset.state = isActive ? 'active' : 'locked';
      const statusCopy = el('div');
      statusCopy.appendChild(el('strong', { text: isActive ? 'Đang hoạt động' : 'Tài khoản đã khóa' }));
      statusCopy.appendChild(el('p', { text: isActive
        ? 'Nhân sự có thể đăng nhập và sử dụng các quyền đang có hiệu lực.'
        : 'Vai trò vẫn được giữ lại, nhưng nhân sự không thể đăng nhập cho đến khi tài khoản được mở lại.' }));
      accountStatus.appendChild(statusCopy);
      if (!isActive && authzSelectedUser !== state.userId) {
        const reactivate = el('button', { className: 'btn-primary', text: 'Mở lại tài khoản', attrs: { type: 'button', 'data-action-id': 'authorization.user_reactivate' } });
        setRegisteredButtonAction(reactivate, 'authorization.user_reactivate', () => reactivateUser(authzSelectedUser, authzUserDetail.user.email), {
          confirm: false, objectIdentity: authzSelectedUser,
        });
        accountStatus.appendChild(reactivate);
      }
    }
    root.textContent = '';
    root.appendChild(el('strong', { className: 'authz-detail-section-title', text: 'Vai trò đang có' }));
    const assignedList = el('div', { className: 'authz-user-role-chips' });
    const availableList = el('div', { className: 'authz-role-picker-list' });
    authzCatalog.roles.forEach((role) => {
      const inherited = authzUserDetail.roles.find((item) => item.roleCode === role.roleCode && item.active && item.source !== 'MANUAL');
      const manual = authzRoleDrafts.find((item) => item.roleCode === role.roleCode);
      if (inherited || manual) {
        const chip = el('div', { className: 'authz-user-role-chip' });
        const checkbox = el('input', { className: 'sr-only', attrs: { type: 'checkbox', checked: '', 'data-authz-user-role': role.roleCode, 'aria-label': role.displayLabel } });
        checkbox.checked = true;
        checkbox.disabled = Boolean(inherited);
        chip.append(checkbox, el('span', { text: role.displayLabel }));
        if (inherited) chip.appendChild(el('span', { className: 'tag sev-gray', text: 'Mặc định' }));
        else {
          const remove = el('button', { className: 'authz-chip-remove', text: '×', attrs: { type: 'button', 'aria-label': `Bỏ vai trò ${role.displayLabel}` } });
          setRegisteredButtonAction(remove, 'authorization.user_role_remove', () => removeAuthzRoleDraft(role.roleCode), { announceSuccess: false });
          chip.appendChild(remove);
        }
        assignedList.appendChild(chip);
      } else {
        const label = el('label', { className: 'authz-role-picker-row' });
        const checkbox = el('input', { attrs: { type: 'checkbox', 'data-authz-user-role': role.roleCode } });
        checkbox.addEventListener('change', () => {
          if (!checkbox.checked) return;
          authzRoleDrafts.push({ roleCode: role.roleCode, validFrom: null, validUntil: null });
          setAuthzUnsaved(true);
          renderAuthzUserDetail();
        });
        label.append(checkbox, el('span', { text: role.displayLabel }));
        availableList.appendChild(label);
      }
    });
    if (!assignedList.children.length) assignedList.appendChild(el('span', { className: 'muted', text: 'Chưa có vai trò.' }));
    root.appendChild(assignedList);
    const picker = el('details', { className: 'authz-role-picker' });
    picker.appendChild(el('summary', { text: 'Thêm vai trò' }));
    picker.appendChild(availableList);
    root.appendChild(picker);

    const effective = $('authz-user-effective');
    effective.textContent = '';
    effective.appendChild(el('strong', { className: 'authz-detail-section-title', text: 'Dữ liệu được xem' }));
    const scopeList = el('div', { className: 'authz-user-scope-list' });
    const roleCodes = authzAssignedRoleCodes();
    const inheritedScopes = authzUserDetail.scopes.filter((scope) => scope.source !== 'MANUAL' && scope.active
      && (!scope.roleCode || roleCodes.has(scope.roleCode)));
    const activeScopes = [...inheritedScopes, ...authzScopeDrafts];
    activeScopes.forEach((scope, index) => {
      const row = el('div', { className: 'authz-user-scope-row' });
      const copy = el('div');
      copy.appendChild(el('strong', { text: scopeDisplayLabel(scope.scopeType, scope.scopeValue) }));
      copy.appendChild(el('span', { className: `authz-scope-effect authz-scope-effect--${scope.effect === 'DENY' ? 'deny' : 'allow'}`, text: scope.effect === 'DENY' ? 'Không cho xem' : 'Cho xem' }));
      if (scope.roleCode) copy.appendChild(el('span', { className: 'muted', text: `Đi kèm ${roleDisplayLabel(scope.roleCode)}` }));
      row.appendChild(copy);
      if (scope.source === 'MANUAL') {
        const remove = el('button', { className: 'authz-scope-remove', text: '×', attrs: { type: 'button', 'aria-label': `Bỏ phạm vi ${scopeDisplayLabel(scope.scopeType, scope.scopeValue)}` } });
        setRegisteredButtonAction(remove, 'authorization.scope_remove', () => {
          authzScopeDrafts.splice(index - inheritedScopes.length, 1);
          setAuthzUnsaved(true);
          renderAuthzUserDetail();
          renderAuthzScopes();
        }, { confirm: false, announceSuccess: false });
        row.appendChild(remove);
      } else row.appendChild(el('span', { className: 'tag sev-gray', text: 'Theo vai trò' }));
      scopeList.appendChild(row);
    });
    if (!activeScopes.length) scopeList.appendChild(el('p', { className: 'muted', text: 'Chưa có phạm vi dữ liệu.' }));
    effective.appendChild(scopeList);
    renderAuthzScopeDraftEditor(effective);
    const permissionDetails = el('details', { className: 'authz-effective-details' });
    permissionDetails.appendChild(el('summary', { text: `${authzUserDetail.effective.permissions.length} thao tác hiện đang áp dụng` }));
    const permissionList = el('div', { className: 'authz-summary-wrap' });
    authzUserDetail.effective.permissions.forEach((code) => permissionList.appendChild(el('span', { className: 'authz-summary-chip', text: permissionDisplayLabel(code), attrs: { title: `Mã kỹ thuật: ${code}` } })));
    if (!authzUserDetail.effective.permissions.length) permissionList.appendChild(el('span', { className: 'muted', text: 'Chưa có thao tác được áp dụng.' }));
    permissionDetails.appendChild(permissionList);
    effective.appendChild(permissionDetails);
    if (authzUserDetail.effective.explanations.some((item) => item.type === 'permission_conflict' || item.type === 'scope_conflict')) effective.appendChild(el('p', {
      className: 'authz-warning',
      text: 'Một số thiết lập vừa cho phép vừa giới hạn. Hệ thống luôn ưu tiên giới hạn để bảo vệ dữ liệu.',
      attrs: { role: 'note' },
    }));
    if (authzSelectedUser === state.userId) effective.appendChild(el('p', {
      className: 'authz-warning',
      text: 'Bạn đang chỉnh quyền của chính mình. Backend sẽ chặn mọi thay đổi làm tăng quyền hoặc phạm vi.',
      attrs: { role: 'note' },
    }));
    $('authz-user-role-confirm').placeholder = requiredConfirmation('ASSIGN_ROLES', authzUserDetail.user.email);
    $('authz-scope-confirm').placeholder = requiredConfirmation('ASSIGN_SCOPE', authzUserDetail.user.email);
  }

  function renderAuthzScopes() {
    const root = $('authz-scope-list');
    if (!root || !authzUserDetail) return;
    root.textContent = '';
    const compatibility = authzUserDetail.scopes.filter((scope) => scope.source !== 'MANUAL' && scope.active);
    [...compatibility.map((scope) => ({ ...scope, locked: true })), ...authzScopeDrafts].forEach((scope, index) => {
      const row = el('div', { className: 'authz-choice-row' });
      const text = el('div');
      text.appendChild(el('strong', { text: scopeDisplayLabel(scope.scopeType, scope.scopeValue) }));
      text.appendChild(el('div', { className: 'muted', text: `${scope.effect === 'DENY' ? 'Không cho phép xem' : 'Cho phép xem'} · ${scope.roleCode ? `Đi kèm ${roleDisplayLabel(scope.roleCode)}` : 'Gán trực tiếp'}` }));
      row.appendChild(text);
      if (scope.locked) row.appendChild(el('span', { className: 'tag sev-gray', text: 'Kế thừa' }));
      else {
        const remove = el('button', { className: 'btn-ghost authz-danger', text: 'Bỏ', attrs: { type: 'button', 'data-action-id': 'authorization.scope_remove' } });
        setRegisteredButtonAction(remove, 'authorization.scope_remove', () => { authzScopeDrafts.splice(index - compatibility.length, 1); renderAuthzScopes(); setAuthzUnsaved(true); }, {
          objectIdentity: `${scope.scopeType}:${scope.scopeValue || 'GLOBAL'}`, announceSuccess: false,
        });
        row.appendChild(remove);
      }
      root.appendChild(row);
    });
    if (!compatibility.length && !authzScopeDrafts.length) root.appendChild(el('div', { className: 'authz-empty admin-state admin-state--empty', text: 'Chưa có dữ liệu được phép xem.', attrs: { role: 'status' } }));
    const preview = $('authz-scope-preview');
    preview.textContent = '';
    preview.appendChild(el('strong', { text: `${authzScopeDrafts.length} phạm vi gán trực tiếp sau khi lưu` }));
    const conflicts = new Map();
    authzScopeDrafts.forEach((scope) => {
      const key = `${scope.scopeType}:${scope.scopeValue || 'GLOBAL'}`;
      const values = conflicts.get(key) || new Set(); values.add(scope.effect); conflicts.set(key, values);
    });
    [...conflicts].filter(([, effects]) => effects.size > 1).forEach(([key]) => preview.appendChild(el('p', { text: `${key}: hệ thống sẽ ưu tiên không cho phép xem.` })));
    $('authz-scope-confirm').placeholder = requiredConfirmation('ASSIGN_SCOPE', authzUserDetail?.user?.email || 'email');
  }

  function renderApprovalAssignments() {
    const root = $('authz-approval-list');
    if (!root) return;
    root.textContent = '';
    const query = $('authz-approval-search')?.value.trim().toLocaleLowerCase('vi-VN') || '';
    const workflow = $('authz-approval-workflow-filter')?.value || 'all';
    const rows = authzAssignments.filter((assignment) => {
      if (workflow !== 'all' && assignment.workflowType !== workflow) return false;
      const assignedUser = approvalAssignedUser(assignment);
      const subject = assignment.roleCode ? roleDisplayLabel(assignment.roleCode) : `${assignedUser?.display_name || ''} ${assignedUser?.email || assignment.assignedUserId || ''}`;
      return !query || `${workflowDisplayLabel(assignment.workflowType)} ${approvalStageDisplayLabel(assignment.stageCode)} ${subject} ${scopeDisplayLabel(assignment.scopeType, assignment.scopeValue)}`.toLocaleLowerCase('vi-VN').includes(query);
    });
    const scroll = el('div', { className: 'authz-table-scroll' });
    const table = el('table', { className: 'data-table authz-approval-table' });
    const thead = el('thead');
    const header = el('tr');
    ['Quy trình', 'Bước phê duyệt', 'Người phê duyệt', 'Phạm vi', 'Trạng thái', ''].forEach((label) => header.appendChild(el('th', { text: label })));
    thead.appendChild(header);
    const tbody = el('tbody');
    rows.forEach((assignment) => {
      const tr = el('tr', { attrs: { tabindex: '0', 'data-action-id': 'authorization.approval_select', ...(authzEditingApprovalId === assignment.id ? { 'aria-current': 'true' } : {}) } });
      tr.appendChild(el('td', { text: workflowDisplayLabel(assignment.workflowType) }));
      tr.appendChild(el('td', { text: approvalStageDisplayLabel(assignment.stageCode) }));
      const assignedUser = approvalAssignedUser(assignment);
      const subject = el('td');
      subject.appendChild(el('strong', { text: assignment.roleCode ? roleDisplayLabel(assignment.roleCode) : assignedUser?.display_name || assignedUser?.email || 'Nhân sự không còn hoạt động' }));
      if (!assignment.roleCode && assignedUser?.display_name) subject.appendChild(el('span', { className: 'muted', text: assignedUser.email }));
      tr.appendChild(subject);
      tr.appendChild(el('td', { text: scopeDisplayLabel(assignment.scopeType, assignment.scopeValue) }));
      const status = el('td');
      status.appendChild(el('span', { className: `tag sev-${assignment.active ? 'green' : 'gray'}`, text: assignment.active ? 'Đang áp dụng' : 'Tạm ngưng' }));
      tr.appendChild(status);
      tr.appendChild(el('td', { className: 'table-action-cell', text: '›' }));
      const selectAssignment = () => selectApprovalAssignment(assignment);
      tr.addEventListener('click', selectAssignment);
      tr.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectAssignment(); } });
      tbody.appendChild(tr);
    });
    if (!rows.length) {
      const tr = el('tr');
      tr.appendChild(el('td', { className: 'authz-empty admin-state admin-state--empty', text: authzAssignments.length ? 'Không có người phê duyệt phù hợp bộ lọc.' : 'Chưa có người phê duyệt.', attrs: { colspan: 6 } }));
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    scroll.appendChild(table);
    root.appendChild(scroll);
  }

  function syncApprovalSubjectOptions() {
    if (!authzCatalog) return;
    const isRole = $('authz-approval-subject-type').value === 'role';
    const items = isRole
      ? authzCatalog.roles.filter((role) => role.active).map((role) => ({ value: role.roleCode, label: role.displayLabel }))
      : authzUsers.filter((user) => user.is_active ?? user.isActive ?? user.active ?? true)
        .map((user) => ({ value: authzUserKey(user), label: user.display_name ? `${user.display_name} · ${user.email}` : user.email }));
    if ($('authz-approval-subject-label')) $('authz-approval-subject-label').textContent = isRole ? 'Vai trò' : 'Email nhân sự';
    fillSelect($('authz-approval-subject'), items, $('authz-approval-subject').value);
  }

  function syncApprovalScopeFields() {
    const scopeType = $('authz-approval-scope-type').value;
    const value = $('authz-approval-scope-value');
    const needsValue = !['GLOBAL', 'ASSIGNED', 'OWN'].includes(scopeType);
    value.disabled = !needsValue;
    if (!needsValue) value.value = '';
    value.placeholder = ({ REGION: 'Nhập khu vực', MCH2: 'Nhập ngành hàng', SUPPLIER: 'Nhập nhà cung cấp' })[scopeType] || 'Không cần nhập giá trị';
  }

  function selectApprovalAssignment(assignment) {
    authzEditingApprovalId = assignment.id;
    $('authz-approval-workflow').value = assignment.workflowType;
    $('authz-approval-stage').value = assignment.stageCode;
    $('authz-approval-subject-type').value = assignment.roleCode ? 'role' : 'user';
    syncApprovalSubjectOptions();
    const assignedUser = approvalAssignedUser(assignment);
    $('authz-approval-subject').value = assignment.roleCode
      || assignment.assignedPrincipalId
      || assignment.assigned_principal_id
      || (assignedUser ? authzUserKey(assignedUser) : assignment.assignedUserId);
    $('authz-approval-scope-type').value = assignment.scopeType;
    $('authz-approval-scope-value').value = assignment.scopeValue || '';
    syncApprovalScopeFields();
    $('authz-approval-priority').value = assignment.priority;
    $('authz-approval-reason').value = '';
    $('authz-approval-confirm').value = '';
    $('authz-approval-confirm').placeholder = requiredConfirmation('PUBLISH_APPROVER', `${assignment.workflowType}:${assignment.stageCode}`);
    if ($('authz-approval-advanced')) $('authz-approval-advanced').open = false;
    if ($('authz-approval-editor-sub')) $('authz-approval-editor-sub').textContent = `Đang chỉnh: ${workflowDisplayLabel(assignment.workflowType)} · ${approvalStageDisplayLabel(assignment.stageCode)}`;
    renderApprovalAssignments();
    setAuthzUnsaved(false);
  }

  function approvalPayload() {
    const type = $('authz-approval-subject-type').value;
    const workflowType = $('authz-approval-workflow').value;
    const stageCode = $('authz-approval-stage').value;
    return {
      ...(authzEditingApprovalId ? { id: authzEditingApprovalId } : {}),
      workflowType,
      stageCode,
      roleCode: type === 'role' ? $('authz-approval-subject').value : null,
      assignedUserId: type === 'user' ? $('authz-approval-subject').value : null,
      scopeType: $('authz-approval-scope-type').value,
      scopeValue: $('authz-approval-scope-type').value === 'GLOBAL'
        ? null
        : ['ASSIGNED', 'OWN'].includes($('authz-approval-scope-type').value)
          ? 'SELF'
          : $('authz-approval-scope-value').value.trim(),
      priority: Number($('authz-approval-priority').value || 100),
      fixture: { mch2Id: $('authz-approval-fixture-mch2').value.trim() || undefined },
    };
  }

  async function previewApproval() {
    const response = await api('/admin/authorization/approval-assignments/preview', { method: 'POST', body: approvalPayload() });
    const root = $('authz-approval-preview');
    root.textContent = '';
    if (!response.ok) return root.appendChild(el('p', { className: 'auth-msg err', text: authzErrorMessage(response) }));
    root.appendChild(el('strong', { text: response.data.candidates.length ? `${response.data.candidates.length} người phê duyệt phù hợp` : 'Không có người phê duyệt phù hợp' }));
    if (response.data.requiredPermission) root.appendChild(el('p', { className: 'muted', text: `Đã kiểm tra quyền ${permissionDisplayLabel(response.data.requiredPermission)} và phạm vi dữ liệu.` }));
    response.data.candidates.forEach((candidate) => {
      const value = typeof candidate === 'string' ? candidate : candidate.email || candidate.displayName || candidate.userId;
      root.appendChild(el('span', { className: 'authz-summary-chip', text: value }));
    });
    if (response.data.conflicts.length) root.appendChild(el('p', { className: 'auth-msg err', text: `Trùng phân công: ${response.data.conflicts.join(', ')}` }));
  }

  function authzHistoryCell(label, options = {}) {
    const cell = el('td', { className: options.className || '', attrs: { 'data-label': label } });
    if (options.text != null) cell.textContent = String(options.text);
    (options.children || []).forEach((child) => cell.appendChild(child));
    return cell;
  }

  function authzHistoryChangeLabel(changeType) {
    const labels = {
      ROLE_CREATED: 'Tạo vai trò',
      ROLE_UPDATED: 'Cập nhật vai trò',
      ROLE_DELETED: 'Xóa vai trò',
      ROLE_PERMISSIONS_CHANGED: 'Cập nhật ma trận quyền',
      USER_ROLES_CHANGED: 'Cập nhật vai trò người dùng',
      SCOPE_ASSIGNED: 'Gán phạm vi dữ liệu',
      APPROVAL_ASSIGNMENT_CHANGED: 'Cập nhật phân công duyệt',
      LEGACY_COMPAT_SYNC: 'Đồng bộ tương thích',
      MIGRATION_APPLIED: 'Áp dụng migration',
    };
    return labels[changeType] || String(changeType || 'Không xác định')
      .toLocaleLowerCase('vi-VN')
      .replaceAll('_', ' ')
      .replace(/^./u, (letter) => letter.toLocaleUpperCase('vi-VN'));
  }

  function authzHistoryActor(item) {
    return String(item?.actorUserId || 'system');
  }

  function authzHistoryIsSystem(item) {
    return authzHistoryActor(item).toLocaleLowerCase('vi-VN') === 'system';
  }

  function authzHistoryKeySummary(value, emptyLabel) {
    const keys = value && typeof value === 'object' ? Object.keys(value) : [];
    return keys.length ? keys.join(', ') : emptyLabel;
  }

  function renderAuthzHistory() {
    const tbody = $('authz-history-tbody');
    if (!tbody) return;
    tbody.textContent = '';
    const rows = authzHistoryRows;
    const pagination = authzHistoryMeta.pagination;
    const summary = authzHistoryMeta.summary;
    const pageStart = (pagination.page - 1) * pagination.pageSize;

    if ($('authz-history-total')) $('authz-history-total').textContent = String(summary.total);
    if ($('authz-history-system')) $('authz-history-system').textContent = String(summary.system);
    if ($('authz-history-manual')) $('authz-history-manual').textContent = String(summary.manual);
    if ($('authz-history-missing-reason')) $('authz-history-missing-reason').textContent = String(summary.missingReason);
    if ($('authz-history-result-count')) $('authz-history-result-count').textContent = pagination.total
      ? `Hiển thị ${pageStart + 1}–${pageStart + rows.length} / ${pagination.total} kết quả`
      : '0 kết quả';
    if ($('authz-history-page')) $('authz-history-page').textContent = `Trang ${pagination.page} / ${pagination.totalPages}`;
    if ($('authz-history-prev')) $('authz-history-prev').disabled = !pagination.hasPrevious;
    if ($('authz-history-next')) $('authz-history-next').disabled = !pagination.hasNext;

    rows.forEach((item) => {
      const tr = el('tr');
      const timeCell = authzHistoryCell('Thời gian');
      const normalizedTime = String(item.createdAt || '').replace('T', ' ').replace(/Z$/i, '');
      timeCell.appendChild(el('span', { className: 'authz-history-primary mono', text: fmtDatetime(normalizedTime), attrs: { title: item.createdAt || '' } }));
      tr.appendChild(timeCell);

      const actorCell = authzHistoryCell('Người thực hiện');
      actorCell.appendChild(el('span', { className: 'authz-history-primary mono', text: authzHistoryActor(item) }));
      actorCell.appendChild(el('span', { className: 'authz-history-secondary', text: authzHistoryIsSystem(item) ? 'Hệ thống' : 'Người dùng' }));
      tr.appendChild(actorCell);

      const changeCell = authzHistoryCell('Thay đổi');
      changeCell.appendChild(el('span', { className: 'authz-history-primary', text: authzHistoryChangeLabel(item.changeType) }));
      changeCell.appendChild(el('span', { className: 'authz-history-code mono', text: `${item.objectType || 'Đối tượng'} · ${item.objectKey || '—'}` }));
      tr.appendChild(changeCell);

      tr.appendChild(authzHistoryCell('Trước', { text: authzHistoryKeySummary(item.before, 'Tạo mới') }));
      tr.appendChild(authzHistoryCell('Sau', { text: authzHistoryKeySummary(item.after, 'Đã xóa') }));

      const detailCell = authzHistoryCell('Chi tiết', { className: 'table-action-cell' });
      const details = el('details', { className: 'authz-history-details' });
      details.appendChild(el('summary', { text: 'Xem' }));
      details.appendChild(el('p', { className: item.reason ? '' : 'authz-history-missing', text: item.reason || 'Chưa ghi nhận lý do' }));
      details.appendChild(el('pre', { className: 'mono', text: JSON.stringify({ before: item.before || null, after: item.after || null, correlationId: item.correlationId || null, authzVersion: item.authzVersion ?? null }, null, 2) }));
      detailCell.appendChild(details);
      tr.appendChild(detailCell);
      tbody.appendChild(tr);
    });
    if (!rows.length) {
      const tr = el('tr');
      tr.appendChild(el('td', {
        className: 'authz-empty admin-state admin-state--empty',
        text: authzHistoryRows.length ? 'Không có thay đổi phù hợp bộ lọc.' : 'Chưa có thay đổi phân quyền.',
        attrs: { colspan: 6, 'data-label': 'Kết quả' },
      }));
      tbody.appendChild(tr);
    }
  }

  function authzHistoryQuery() {
    const query = new URLSearchParams({
      page: String(authzHistoryPage + 1),
      pageSize: String(AUTHZ_HISTORY_PAGE_SIZE),
    });
    const values = {
      search: $('authz-history-search')?.value.trim() || '',
      actor: $('authz-history-actor-filter')?.value || 'all',
      changeType: $('authz-history-change-filter')?.value || 'all',
      from: $('authz-history-date-from')?.value || '',
      to: $('authz-history-date-to')?.value || '',
    };
    Object.entries(values).forEach(([key, value]) => {
      if (value && value !== 'all') query.set(key, value);
    });
    return query;
  }

  async function loadAuthzHistory(resetPage = true) {
    if (resetPage === true || resetPage?.type) authzHistoryPage = 0;
    const requestSequence = ++authzHistoryRequestSequence;
    const response = await api(`/admin/authorization/history?${authzHistoryQuery().toString()}`);
    if (requestSequence !== authzHistoryRequestSequence) return;
    if (!response.ok) return showAuthzState(response.status === 403 ? 'denied' : 'error', authzErrorMessage(response));
    authzHistoryRows = response.data.items || [];
    authzHistoryMeta = {
      pagination: response.data.pagination || authzHistoryMeta.pagination,
      summary: response.data.summary || authzHistoryMeta.summary,
    };
    authzHistoryPage = Math.max(0, Number(authzHistoryMeta.pagination.page || 1) - 1);
    const changeFilter = $('authz-history-change-filter');
    const selectedChange = changeFilter?.value || 'all';
    fillSelect(changeFilter, [
      { value: 'all', label: 'Tất cả thay đổi' },
      ...[...new Set((response.data.filters?.changeTypes || []).filter(Boolean))]
        .sort((left, right) => authzHistoryChangeLabel(left).localeCompare(authzHistoryChangeLabel(right), 'vi'))
        .map((changeType) => ({ value: changeType, label: authzHistoryChangeLabel(changeType) })),
    ], selectedChange);
    renderAuthzHistory();
    showAuthzState('ready', 'Sẵn sàng');
  }

  async function exportAuthorizationWorkbook(section = 'history', button = $('authz-export-authorization')) {
    const finish = setButtonLoading(button, 'Đang xuất Excel…');
    try {
      const query = authzHistoryQuery();
      query.delete('page');
      query.delete('pageSize');
      query.set('section', section);
      const response = await withActionRequestContext({ actionId: 'authorization.export', mutation: false }, () => fetch(
        `/qlcl/api/admin/authorization/export.xlsx?${query.toString()}`,
        { credentials: 'same-origin', headers: { Accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ...actionRequestHeaders() } },
      ));
      if (!response.ok) throw new Error('authorization_export_failed');
      const blob = await response.blob();
      downloadBlob(blob, fileNameFromDisposition(response.headers.get('Content-Disposition')) || 'authorization.xlsx');
      showToast('Đã xuất cấu hình phân quyền.', 'ok');
    } catch {
      showToast('Không xuất được cấu hình phân quyền.', 'err');
    } finally {
      finish();
    }
  }

  document.querySelectorAll('[data-authz-tab]').forEach((button) => button.addEventListener('click', () => selectAuthzTab(button.dataset.authzTab)));
  $('authz-user-search').addEventListener('input', renderFilteredAuthzUsers);
  ['authz-user-active-filter', 'authz-user-role-filter', 'authz-user-health-filter']
    .forEach((id) => $(id).addEventListener('change', renderFilteredAuthzUsers));
  $('authz-history-search')?.addEventListener('input', () => {
    window.clearTimeout(authzHistorySearchTimer);
    authzHistorySearchTimer = window.setTimeout(() => loadAuthzHistory(true), 250);
  });
  ['authz-history-actor-filter', 'authz-history-change-filter', 'authz-history-date-from', 'authz-history-date-to']
    .forEach((id) => $(id)?.addEventListener('change', () => loadAuthzHistory(true)));
  $('authz-history-prev')?.addEventListener('click', () => { authzHistoryPage = Math.max(0, authzHistoryPage - 1); loadAuthzHistory(false); });
  $('authz-history-next')?.addEventListener('click', () => { authzHistoryPage += 1; loadAuthzHistory(false); });
  $('authz-role-search')?.addEventListener('input', renderAuthzRoleCatalog);
  $('authz-role-status-filter')?.addEventListener('change', renderAuthzRoleCatalog);
  $('authz-approval-search')?.addEventListener('input', renderApprovalAssignments);
  $('authz-approval-workflow-filter')?.addEventListener('change', renderApprovalAssignments);
  $('authz-permission-search').addEventListener('input', applyPermissionFilters);
  $('authz-permission-effect-filter').addEventListener('change', applyPermissionFilters);
  document.querySelector('.authz-ia-tabs')?.addEventListener('keydown', async (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = Math.max(0, AUTHZ_TABS.indexOf(document.activeElement?.dataset?.authzTab || authzActiveTab));
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? AUTHZ_TABS.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + AUTHZ_TABS.length) % AUTHZ_TABS.length;
    await selectAuthzTab(AUTHZ_TABS[next], { focus: false });
    document.querySelector(`[data-authz-tab="${authzActiveTab}"]`)?.focus();
  });
  $('authorization-admin').addEventListener('input', (event) => {
    const nonDraft = event.target.closest('.authz-filter-bar')
      || ['authz-permission-role', 'authz-scope-user'].includes(event.target.id);
    if (!nonDraft && event.target.matches('input, select, textarea')) setAuthzUnsaved(true);
  });
  window.addEventListener('beforeunload', (event) => {
    if (!authzUnsaved) return;
    event.preventDefault();
    event.returnValue = '';
  });
  document.addEventListener('keydown', trapAuthzDrawerFocus);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (authzUserEditorOpen || authzRoleEditorOpen) {
      event.preventDefault();
      requestCloseAuthzDrawer(authzUserEditorOpen ? 'user' : 'role');
      return;
    }
    if (!authzUnsaved || !$('authorization-admin').contains(document.activeElement)) return;
    confirmAction({ title: 'Bỏ thay đổi chưa lưu?', message: 'Bản nháp phân quyền chưa được publish.', confirmLabel: 'Bỏ bản nháp', cancelLabel: 'Tiếp tục chỉnh sửa', destructive: true })
      .then((confirmed) => { if (confirmed) { setAuthzUnsaved(false); loadAuthorizationAdmin(true); } });
  });
  ['authz-close-user-detail', 'authz-cancel-user-detail'].forEach((id) => $(id)?.addEventListener('click', () => requestCloseAuthzDrawer('user')));
  ['authz-close-role-form', 'authz-cancel-role-form'].forEach((id) => $(id)?.addEventListener('click', () => requestCloseAuthzDrawer('role')));
  $('authz-user-detail-backdrop')?.addEventListener('click', () => requestCloseAuthzDrawer('user'));
  $('authz-role-form-backdrop')?.addEventListener('click', () => requestCloseAuthzDrawer('role'));

  bindRegisteredAction($('authz-new-role'), 'authorization.role_new', () => beginNewRole(null, null, $('authz-new-role')), { announceSuccess: false });
  bindRegisteredAction($('authz-clone-role'), 'authorization.role_clone', () => { if (authzRoleDetail) beginNewRole(authzRoleDetail.role_code, authzRoleDetail, $('authz-clone-role')); }, { announceSuccess: false });
  bindRegisteredAction($('authz-role-form'), 'authorization.role_save', async (event) => {
    event.preventDefault();
    const code = $('authz-role-code').value.trim().toUpperCase();
    const body = {
      displayLabel: $('authz-role-label').value.trim(),
      active: $('authz-role-status').value === 'active',
      reason: $('authz-role-reason').value.trim() || $('authz-permission-reason').value.trim(),
      confirmation: $('authz-role-confirm').value || $('authz-permission-confirm').value,
    };
    const response = authzRoleCreateMode
      ? await api('/admin/authorization/roles', { method: 'POST', body: { ...body, roleCode: code, cloneFrom: authzRoleCreateMode.cloneFrom, permissions: permissionAssignmentsFromForm() } })
      : await api(`/admin/authorization/roles/${encodeURIComponent(authzSelectedRole)}/configuration`, {
        method: 'PUT', body: { ...body, permissions: permissionAssignmentsFromForm() },
      });
    if (!response.ok) {
      applyExpectedConfirmation(response, 'authz-role-confirm');
      return showAuthzState('error', authzErrorMessage(response));
    }
    setAuthzUnsaved(false);
    authzCatalog = null;
    await loadAuthorizationAdmin(true);
    await loadAuthzRole(response.data.role_code || response.data.roleCode || code);
    setAuthzDrawerState('role', false);
    showToast('Đã lưu vai trò.', 'ok');
  }, { event: 'submit', preventDefault: true, trigger: $('authz-save-role'), confirm: false, announceSuccess: false });
  bindRegisteredAction($('authz-delete-role'), 'authorization.role_delete', async () => {
    if (!authzSelectedRole) return;
    const response = await api(`/admin/authorization/roles/${encodeURIComponent(authzSelectedRole)}`, {
      method: 'DELETE', body: { reason: $('authz-role-reason').value.trim(), confirmation: $('authz-role-confirm').value },
    });
    if (!response.ok) { applyExpectedConfirmation(response, 'authz-role-confirm'); return showAuthzState('error', authzErrorMessage(response)); }
    setAuthzUnsaved(false); authzCatalog = null; authzSelectedRole = null; setAuthzDrawerState('role', false); await loadAuthorizationAdmin(true); showToast('Đã xóa vai trò tùy chỉnh.', 'ok');
  }, { confirm: false, announceSuccess: false });
  $('authz-permission-role').addEventListener('change', (event) => loadAuthzRole(event.target.value));
  bindRegisteredAction($('authz-save-permissions'), 'authorization.permissions_publish', async () => {
    if (!authzSelectedRole) return;
    const response = await api(`/admin/authorization/roles/${encodeURIComponent(authzSelectedRole)}/configuration`, {
      method: 'PUT', body: {
        displayLabel: $('authz-role-label').value.trim(),
        active: $('authz-role-status').value === 'active',
        permissions: permissionAssignmentsFromForm(),
        reason: $('authz-permission-reason').value.trim() || $('authz-role-reason').value.trim(),
        confirmation: $('authz-permission-confirm').value || $('authz-role-confirm').value,
      },
    });
    if (!response.ok) { applyExpectedConfirmation(response, 'authz-permission-confirm'); return showAuthzState('error', authzErrorMessage(response)); }
    setAuthzUnsaved(false); authzCatalog = null; await loadAuthorizationAdmin(true); await loadAuthzRole(authzSelectedRole); showToast('Đã publish ma trận quyền.', 'ok');
  }, { confirm: false, announceSuccess: false });
  bindRegisteredAction($('authz-save-user-roles'), 'authorization.user_roles_save', async () => {
    if (!authzSelectedUser) return;
    const response = await api(`/admin/authorization/users/${encodeURIComponent(authzSelectedUser)}/authorization`, {
      method: 'PUT', body: {
        roles: authzRoleDrafts, scopes: authzScopeDrafts,
        reason: $('authz-user-role-reason').value.trim(),
        roleConfirmation: $('authz-user-role-confirm').value,
        scopeConfirmation: $('authz-scope-confirm').value,
        expectedAuthzVersion: authzUserDetail?.user?.authzVersion,
      },
    });
    if (!response.ok) { applyExpectedConfirmation(response, 'authz-user-role-confirm'); return showAuthzState('error', authzErrorMessage(response)); }
    setAuthzUnsaved(false); await loadAuthzUser(authzSelectedUser); showToast('Đã lưu vai trò và dữ liệu được xem.', 'ok');
  }, { confirm: false, announceSuccess: false });
  $('authz-scope-user').addEventListener('change', (event) => loadAuthzUser(event.target.value));
  $('authz-scope-type').addEventListener('change', () => { $('authz-scope-value').disabled = $('authz-scope-type').value === 'GLOBAL'; if ($('authz-scope-value').disabled) $('authz-scope-value').value = ''; });
  bindRegisteredAction($('authz-add-scope'), 'authorization.scope_add', () => {
    if (!authzSelectedUser) return;
    authzScopeDrafts.push({
      roleCode: $('authz-scope-role').value || null,
      scopeType: $('authz-scope-type').value,
      scopeValue: $('authz-scope-type').value === 'GLOBAL' ? null : $('authz-scope-value').value.trim(),
      effect: $('authz-scope-effect').value,
      validFrom: toApiInstant($('authz-scope-from').value),
      validUntil: toApiInstant($('authz-scope-until').value),
      source: 'MANUAL', active: true,
    });
    renderAuthzScopes(); setAuthzUnsaved(true);
  }, { announceSuccess: false });
  bindRegisteredAction($('authz-save-scopes'), 'authorization.scopes_save', async () => {
    if (!authzSelectedUser) return;
    const response = await api(`/admin/authorization/users/${encodeURIComponent(authzSelectedUser)}/authorization`, {
      method: 'PUT', body: {
        roles: authzRoleDrafts, scopes: authzScopeDrafts,
        reason: $('authz-scope-reason').value.trim(),
        roleConfirmation: $('authz-user-role-confirm').value,
        scopeConfirmation: $('authz-scope-confirm').value,
        expectedAuthzVersion: authzUserDetail?.user?.authzVersion,
      },
    });
    if (!response.ok) { applyExpectedConfirmation(response, 'authz-scope-confirm'); return showAuthzState('error', authzErrorMessage(response)); }
    setAuthzUnsaved(false); await loadAuthzUser(authzSelectedUser); showToast('Đã lưu phạm vi dữ liệu.', 'ok');
  }, { confirm: false, announceSuccess: false });
  $('authz-approval-subject-type').addEventListener('change', syncApprovalSubjectOptions);
  $('authz-approval-scope-type').addEventListener('change', syncApprovalScopeFields);
  ['authz-approval-workflow', 'authz-approval-stage'].forEach((id) => $(id).addEventListener('change', () => {
    $('authz-approval-confirm').placeholder = requiredConfirmation('PUBLISH_APPROVER', `${$('authz-approval-workflow').value}:${$('authz-approval-stage').value}`);
  }));
  bindRegisteredAction($('authz-preview-approval'), 'authorization.approval_preview', previewApproval, { announceSuccess: false });
  bindRegisteredAction($('authz-new-approval'), 'authorization.approval_new', () => {
    authzEditingApprovalId = null;
    $('authz-approval-workflow').value = 'EVALUATION';
    $('authz-approval-stage').value = 'LEAD';
    $('authz-approval-subject-type').value = 'role';
    syncApprovalSubjectOptions();
    $('authz-approval-scope-type').value = 'GLOBAL';
    syncApprovalScopeFields();
    $('authz-approval-priority').value = '100';
    $('authz-approval-fixture-mch2').value = '';
    $('authz-approval-preview').textContent = '';
    $('authz-approval-reason').value = '';
    $('authz-approval-confirm').value = '';
    $('authz-approval-confirm').placeholder = requiredConfirmation('PUBLISH_APPROVER', 'EVALUATION:LEAD');
    if ($('authz-approval-advanced')) $('authz-approval-advanced').open = false;
    if ($('authz-approval-editor-sub')) $('authz-approval-editor-sub').textContent = 'Tạo phân công phê duyệt mới cho phiếu đánh giá.';
    renderApprovalAssignments();
    setAuthzUnsaved(true);
    $('authz-approval-editor')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, { announceSuccess: false });
  $('authz-cancel-approval')?.addEventListener('click', () => {
    const current = authzAssignments.find((assignment) => assignment.id === authzEditingApprovalId) || authzAssignments[0];
    if (current) selectApprovalAssignment(current);
    else {
      authzEditingApprovalId = null;
      $('authz-approval-preview').textContent = '';
      $('authz-approval-reason').value = '';
      $('authz-approval-confirm').value = '';
      if ($('authz-approval-editor-sub')) $('authz-approval-editor-sub').textContent = 'Chọn một phân công để chỉnh sửa hoặc tạo mới.';
      setAuthzUnsaved(false);
      renderApprovalAssignments();
    }
  });
  bindRegisteredAction($('authz-publish-approval'), 'authorization.approval_publish', async () => {
    const payload = approvalPayload();
    const response = await api('/admin/authorization/approval-assignments/publish', {
      method: 'POST', body: { ...payload, reason: $('authz-approval-reason').value.trim(), confirmation: $('authz-approval-confirm').value },
    });
    if (!response.ok) { applyExpectedConfirmation(response, 'authz-approval-confirm'); return showAuthzState('error', authzErrorMessage(response)); }
    setAuthzUnsaved(false);
    authzAssignments = ((await api('/admin/authorization/approval-assignments')).data.items || [])
      .filter((item) => item.workflowType === 'EVALUATION');
    renderApprovalAssignments();
    await previewApproval();
    showToast('Đã lưu người phê duyệt.', 'ok');
  }, { confirm: false, announceSuccess: false });
  bindRegisteredAction($('authz-refresh-history'), 'authorization.history_refresh', loadAuthzHistory, { announceSuccess: false });
  bindRegisteredAction($('authz-export-authorization'), 'authorization.export', () => exportAuthorizationWorkbook('history', $('authz-export-authorization')), { announceSuccess: false });
  [['authz-export-users', 'users'], ['authz-export-roles', 'roles'], ['authz-export-approvals', 'approvals']].forEach(([id, section]) => {
    bindRegisteredAction($(id), 'authorization.export', () => exportAuthorizationWorkbook(section, $(id)), { announceSuccess: false });
  });

  const SYSTEM_LOG_FILTERS = Object.freeze({
    from: 'system-log-from',
    to: 'system-log-to',
    category: 'system-log-category',
    event: 'system-log-event',
    severity: 'system-log-severity',
    actor: 'system-log-actor',
    entity: 'system-log-entity',
    outcome: 'system-log-outcome',
    request: 'system-log-request',
    correlation: 'system-log-correlation',
    uat: 'system-log-uat',
  });
  let systemLogReturnFocus = null;

  function systemLogLocalTime(date) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function ensureSystemLogTimeRange() {
    if (!$('system-log-from') || !$('system-log-to')) return;
    const now = new Date();
    if (!$('system-log-to').value) $('system-log-to').value = systemLogLocalTime(now);
    if (!$('system-log-from').value) $('system-log-from').value = systemLogLocalTime(new Date(now.getTime() - 7 * 86400000));
  }

  function systemLogQuery(cursor, format) {
    const params = new URLSearchParams();
    Object.entries(SYSTEM_LOG_FILTERS).forEach(([name, id]) => {
      const node = $(id);
      if (!node || !node.value) return;
      let value = node.value.trim();
      if ((name === 'from' || name === 'to') && value) value = new Date(value).toISOString();
      params.set(name, value);
    });
    params.set('limit', '50');
    if (cursor) params.set('cursor', cursor);
    if (format) {
      params.delete('limit');
      params.set('format', format);
    }
    return params;
  }

  function showSystemLogState(kind, message) {
    ['loading', 'empty', 'error', 'permission'].forEach((name) => {
      const node = $(`system-log-${name}`);
      if (node) node.classList.toggle('hidden', name !== kind);
    });
    if (message && kind && $(`system-log-${kind}`)) $(`system-log-${kind}`).textContent = message;
  }

  function systemLogTag(value, kind) {
    const normalized = String(value || '').toUpperCase();
    let color = 'gray';
    if (kind === 'severity') color = normalized === 'CRITICAL' || normalized === 'HIGH' ? 'red' : normalized === 'WARN' ? 'amber' : 'gray';
    if (kind === 'outcome') color = normalized === 'SUCCESS' ? 'green' : normalized === 'DEGRADED' ? 'amber' : 'red';
    return el('span', { className: `tag sev-${color}`, text: normalized || '—' });
  }

  function systemLogCell(label, options = {}) {
    return el('td', { className: options.className || '', text: options.text, attrs: { 'data-label': label } });
  }

  function renderSystemLogs() {
    const tbody = $('system-log-tbody');
    if (!tbody) return;
    tbody.textContent = '';
    state.systemLogEvents.forEach((item) => {
      const tr = el('tr');
      tr.appendChild(systemLogCell('Thời điểm', { className: 'mono muted', text: fmtDatetime(item.occurred_at) }));
      const severity = systemLogCell('Mức độ');
      severity.appendChild(systemLogTag(item.severity, 'severity'));
      tr.appendChild(severity);
      const eventCell = systemLogCell('Sự kiện');
      const open = el('button', {
        className: 'system-log-event-button',
        text: item.event_name,
        attrs: { type: 'button', 'data-action-id': 'audit.view', 'aria-label': `Xem chi tiết ${item.event_name}` },
      });
      open.addEventListener('click', () => executeAction('audit.view', {
        trigger: open, context: actionContext(item), objectIdentity: String(item.id), announceSuccess: false,
        returnFocus: false,
        run: () => openSystemLogDetail(item.id, open),
      }));
      eventCell.appendChild(open);
      eventCell.appendChild(el('div', { className: 'muted', text: item.summary || '' }));
      tr.appendChild(eventCell);
      tr.appendChild(systemLogCell('Người thực hiện', { text: item.actor_user_id || 'Hệ thống' }));
      tr.appendChild(systemLogCell('Đối tượng', { className: 'mono', text: item.entity_id ? `${item.entity_type} · ${item.entity_id}` : item.entity_type }));
      const outcome = systemLogCell('Kết quả');
      outcome.appendChild(systemLogTag(item.outcome, 'outcome'));
      tr.appendChild(outcome);
      tr.appendChild(systemLogCell('Request ID', { className: 'mono muted', text: item.request_id || '—' }));
      tbody.appendChild(tr);
    });
    if ($('system-log-count')) $('system-log-count').textContent = `${state.systemLogEvents.length} sự kiện`;
    if ($('system-log-more')) $('system-log-more').classList.toggle('hidden', !state.systemLogCursor);
  }

  async function loadSystemLogs(options = {}) {
    const append = options.append === true;
    if (!canReadAudit()) {
      state.systemLogEvents = [];
      state.systemLogCursor = null;
      renderSystemLogs();
      showSystemLogState('permission');
      return;
    }
    if (state.systemLogLoading) return;
    ensureSystemLogTimeRange();
    state.systemLogLoading = true;
    showSystemLogState('loading');
    const cursor = append ? state.systemLogCursor : null;
    const result = await api(`/admin/audit-events?${systemLogQuery(cursor).toString()}`);
    state.systemLogLoading = false;
    if (!result.ok) {
      if (result.status === 403) {
        state.systemLogEvents = [];
        state.systemLogCursor = null;
        renderSystemLogs();
        showSystemLogState('permission');
      }
      else showSystemLogState('error', apiErrorMessage(result.data?.error) || 'Không tải được nhật ký hệ thống.');
      return;
    }
    const items = Array.isArray(result.data.items) ? result.data.items : [];
    state.systemLogEvents = append ? state.systemLogEvents.concat(items) : items;
    state.systemLogCursor = result.data.next_cursor || null;
    renderSystemLogs();
    showSystemLogState(state.systemLogEvents.length ? null : 'empty');
  }

  function timelineSection(title, pairs) {
    const section = el('section', { className: 'system-log-timeline-item' });
    section.appendChild(el('h4', { text: title }));
    const list = el('dl', { className: 'system-log-kv' });
    pairs.filter((pair) => pair[1] != null && pair[1] !== '').forEach(([label, value, copyable]) => {
      list.appendChild(el('dt', { text: label }));
      const detail = el('dd', { className: copyable ? 'mono' : '', text: String(value) });
      if (copyable) {
        const copy = el('button', { className: 'btn-ghost system-log-copy', text: 'Sao chép', attrs: { type: 'button', 'data-action-id': 'audit.copy_id', 'aria-label': `Sao chép ${label}` } });
        copy.addEventListener('click', () => executeAction('audit.copy_id', {
          trigger: copy, announceSuccess: false, run: () => copySystemLogId(String(value), copy),
        }));
        detail.appendChild(copy);
      }
      list.appendChild(detail);
    });
    section.appendChild(list);
    return section;
  }

  async function copySystemLogId(value, button) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(value);
      else {
        const input = document.createElement('textarea');
        input.value = value;
        input.setAttribute('readonly', '');
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        input.remove();
      }
      const before = button.textContent;
      button.textContent = 'Đã chép';
      window.setTimeout(() => { button.textContent = before; }, 1200);
    } catch {
      showToast('Không sao chép được mã.', 'err');
    }
  }

  function flattenSystemLogMetadata(value, prefix = '', output = [], depth = 0) {
    if (depth > 4 || output.length >= 80) return output;
    if (value == null || typeof value !== 'object') {
      output.push([prefix || 'Giá trị', value == null ? '—' : String(value)]);
      return output;
    }
    if (Array.isArray(value)) {
      if (value.every((item) => item == null || typeof item !== 'object')) output.push([prefix || 'Danh sách', value.join(', ')]);
      else value.forEach((item, index) => flattenSystemLogMetadata(item, `${prefix}[${index + 1}]`, output, depth + 1));
      return output;
    }
    Object.entries(value).forEach(([key, child]) => {
      const label = prefix ? `${prefix} · ${key.replace(/_/g, ' ')}` : key.replace(/_/g, ' ');
      flattenSystemLogMetadata(child, label, output, depth + 1);
    });
    return output;
  }

  function renderSystemLogMetadata(metadata) {
    const list = $('system-log-metadata');
    list.textContent = '';
    const entries = flattenSystemLogMetadata(metadata || {});
    if (!entries.length) {
      list.appendChild(el('dt', { text: 'Thông tin' }));
      list.appendChild(el('dd', { className: 'muted', text: 'Không có thông tin bổ sung.' }));
      return;
    }
    entries.forEach(([label, value]) => {
      list.appendChild(el('dt', { text: label }));
      list.appendChild(el('dd', { text: value }));
    });
  }

  function systemLogEntityRoute(item) {
    const type = String(item.entity_type || '').toUpperCase();
    if (type === 'SUPPLIER' && hasCapability('SUPPLIER.READ')) return { tab: 'suppliers', label: 'Mở NCC' };
    if ((type === 'EVALUATION' || type === 'EVALUATION_TICKET') && hasCapability('EVALUATION.READ')) return { tab: 'evaluations', label: 'Mở phiếu đánh giá' };
    return null;
  }

  function openSystemLogEntity(item, route) {
    closeSystemLogDrawer();
    if (route.tab === 'suppliers') {
      state.supplierSearch = item.entity_id || '';
      if ($('supplier-search')) $('supplier-search').value = state.supplierSearch;
    } else if (route.tab === 'evaluations') {
      state.evalSearch = item.entity_id || '';
      if ($('eval-search')) $('eval-search').value = state.evalSearch;
    }
    navigateToTab(route.tab);
  }

  function renderSystemLogDetail(item) {
    $('system-log-drawer-subtitle').textContent = `#${item.id} · ${item.event_name}`;
    const timeline = $('system-log-timeline');
    timeline.textContent = '';
    timeline.appendChild(timelineSection('Sự kiện', [
      ['Thời điểm', fmtDatetime(item.occurred_at)], ['Mức độ', item.severity], ['Hành động', item.action],
      ['Kết quả', item.outcome], ['Lý do', item.reason_code], ['Mô tả', item.summary], ['Retention', item.retention_class],
    ]));
    timeline.appendChild(timelineSection('Tác nhân', [
      ['Người thực hiện', item.actor_user_id || 'Hệ thống'], ['Vai trò', (item.actor_roles || []).join(', ') || '—'],
    ]));
    timeline.appendChild(timelineSection('Đối tượng', [
      ['Loại', item.entity_type], ['Mã', item.entity_id],
    ]));
    timeline.appendChild(timelineSection('Theo dấu yêu cầu', [
      ['Request ID', item.request_id, true], ['Correlation ID', item.correlation_id, true], ['UAT run ID', item.uat_run_id, true],
    ]));
    renderSystemLogMetadata(item.metadata);
    const actions = $('system-log-entity-actions');
    actions.textContent = '';
    const route = systemLogEntityRoute(item);
    if (route && item.entity_id) {
      const open = el('button', { className: 'btn-primary', text: route.label, attrs: { type: 'button', 'data-action-id': 'audit.open_entity' } });
      open.addEventListener('click', () => executeAction('audit.open_entity', {
        trigger: open, announceSuccess: false, run: () => openSystemLogEntity(item, route),
      }));
      actions.appendChild(open);
    }
  }

  async function openSystemLogDetail(id, trigger) {
    systemLogReturnFocus = trigger || document.activeElement;
    state.selectedSystemLogId = id;
    $('system-log-drawer').classList.remove('hidden');
    $('system-log-drawer-loading').classList.remove('hidden');
    $('system-log-timeline').textContent = '';
    $('system-log-metadata').textContent = '';
    $('system-log-entity-actions').textContent = '';
    $('system-log-drawer-close').focus();
    const result = await api(`/admin/audit-events/${encodeURIComponent(id)}`);
    $('system-log-drawer-loading').classList.add('hidden');
    if (!result.ok) {
      $('system-log-timeline').appendChild(el('div', { className: 'system-log-status error', text: result.status === 403 ? 'Bạn không có quyền xem chi tiết sự kiện.' : 'Không tải được chi tiết sự kiện.' }));
      return;
    }
    renderSystemLogDetail(result.data.item);
  }

  function closeSystemLogDrawer() {
    if (!$('system-log-drawer') || $('system-log-drawer').classList.contains('hidden')) return;
    $('system-log-drawer').classList.add('hidden');
    state.selectedSystemLogId = null;
    if (systemLogReturnFocus && typeof systemLogReturnFocus.focus === 'function') systemLogReturnFocus.focus();
    systemLogReturnFocus = null;
  }

  async function exportSystemLogs(format, button) {
    if (!canExportAudit()) return showSystemLogState('permission', 'Bạn không có quyền xuất nhật ký hệ thống.');
    ensureSystemLogTimeRange();
    const finish = setButtonLoading(button, 'Đang chuẩn bị…');
    try {
      const response = await fetch(`/qlcl/api/admin/audit-events/export?${systemLogQuery(null, format).toString()}`, {
        credentials: 'same-origin',
        headers: { Accept: format === 'csv' ? 'text/csv' : 'application/x-ndjson', ...actionRequestHeaders() },
      });
      if (!response.ok) {
        let code = 'audit_export_failed';
        try { code = (await response.json()).error || code; } catch {}
        showSystemLogState(response.status === 403 ? 'permission' : 'error', apiErrorMessage(code) || 'Không xuất được nhật ký hệ thống.');
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `audit-events.${format}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      showToast(`Đã xuất ${response.headers.get('x-audit-row-count') || 0} sự kiện.`, 'ok');
    } catch {
      showSystemLogState('error', 'Không xuất được nhật ký hệ thống.');
    } finally {
      finish();
    }
  }

  async function loadRetentionDryRun() {
    const node = $('system-log-retention');
    if (!node || !canReadAudit()) return;
    node.classList.remove('hidden');
    node.textContent = 'Đang lập báo cáo retention dry-run…';
    const result = await api(`/admin/audit-events/retention/dry-run?as_of=${encodeURIComponent(new Date().toISOString())}`);
    if (!result.ok) {
      node.textContent = 'Không lập được báo cáo retention dry-run.';
      return;
    }
    const report = result.data.report;
    node.textContent = `Dry-run ${report.approval_reference}: ${report.total_eligible_rows} dòng đủ tuổi lưu giữ; chế độ REPORT_ONLY, không xóa dữ liệu.`;
  }

  function initSystemLogControls() {
    if (!$('system-log-filter-form') || $('system-log-filter-form').dataset.ready) return;
    $('system-log-filter-form').dataset.ready = '1';
    ensureSystemLogTimeRange();
    $('system-log-filter-form').addEventListener('submit', (event) => {
      event.preventDefault();
      state.systemLogCursor = null;
      loadSystemLogs();
    });
    $('system-log-reset').addEventListener('click', () => {
      Object.values(SYSTEM_LOG_FILTERS).forEach((id) => { if ($(id)) $(id).value = ''; });
      ensureSystemLogTimeRange();
      state.systemLogCursor = null;
      loadSystemLogs();
    });
    bindRegisteredAction($('system-log-more'), 'audit.load_more', () => loadSystemLogs({ append: true }), { announceSuccess: false });
    bindRegisteredAction($('system-log-export-csv'), 'audit.export_csv', () => exportSystemLogs('csv', $('system-log-export-csv')), { announceSuccess: false });
    bindRegisteredAction($('system-log-export-ndjson'), 'audit.export_ndjson', () => exportSystemLogs('ndjson', $('system-log-export-ndjson')), { announceSuccess: false });
    bindRegisteredAction($('system-log-retention-dry-run'), 'audit.retention_report', loadRetentionDryRun, { announceSuccess: false });
    $('system-log-drawer-close').addEventListener('click', closeSystemLogDrawer);
    $('system-log-drawer').addEventListener('click', (event) => { if (event.target === $('system-log-drawer')) closeSystemLogDrawer(); });
    $('system-log-drawer').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSystemLogDrawer();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = Array.from($('system-log-drawer').querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled])'));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }

  initSystemLogControls();

  const REPORT_TEMPLATE_TABS = ['structure', 'data', 'presentation', 'preview', 'validation', 'versions', 'scope'];
  const REPORT_TEMPLATE_BINDINGS = [
    'doc4.related_information.report_no', 'doc4.related_information.evaluation_date',
    'doc4.related_information.evaluators', 'doc4.related_information.supplier_name',
    'doc4.related_information.supplier_code', 'doc4.related_information.evaluation_address',
    'doc4.scope.product', 'doc4.scope.business_type', 'doc4.scope.evaluation_type',
    'doc4.scope.question_template_version_id', 'doc4.participants.rows',
    'doc4.supplier_introduction.content', 'doc4.compliance_summary',
    'doc4.nonconformity_summary', 'doc4.result_summary.final_score_percent',
    'doc4.result_summary.final_result_label', 'doc4.result_summary.final_conclusion',
    'doc4.signatures.evaluator', 'doc4.signatures.supplier_representative',
    'doc4.signatures.approved_by', 'corrective_action_rows', 'approval_history_rows',
  ];

  function reportTemplateParams() {
    const raw = routePathFromHash();
    const query = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '';
    return new URLSearchParams(query);
  }

  function hydrateReportTemplateUrl() {
    const params = reportTemplateParams();
    if (params.get('definition')) state.selectedReportDefinitionCode = params.get('definition');
    if (params.get('version')) state.selectedReportTemplateVersionId = params.get('version');
    if (REPORT_TEMPLATE_TABS.includes(params.get('tab'))) state.reportTemplateTab = params.get('tab');
  }

  function syncReportTemplateUrl({ replace = false } = {}) {
    if (state.tab !== 'admin-report-templates') return;
    const params = new URLSearchParams();
    if (state.selectedReportDefinitionCode) params.set('definition', state.selectedReportDefinitionCode);
    if (state.selectedReportTemplateVersionId) params.set('version', state.selectedReportTemplateVersionId);
    params.set('tab', REPORT_TEMPLATE_TABS.includes(state.reportTemplateTab) ? state.reportTemplateTab : 'structure');
    const next = `#/admin/report-templates?${params.toString()}`;
    if (window.location.hash === next.slice(1)) return;
    if (replace) window.history.replaceState(null, '', next);
    else window.location.hash = next.slice(1);
  }

  function selectedReportDefinition() {
    return (state.reportTemplateDefinitions || []).find((item) => item.definition_code === state.selectedReportDefinitionCode) || null;
  }

  function selectedReportTemplateVersion() {
    return (state.reportTemplateVersions || []).find((item) => String(item.id) === String(state.selectedReportTemplateVersionId)) || null;
  }

  function reportTemplateEditable(version = state.reportTemplateVersionDetail) {
    return Boolean(version?.status === 'DRAFT' && version.allowed_actions?.includes('report_template.save_draft'));
  }

  function reportTemplateActionAllowed(actionId, resource = state.reportTemplateVersionDetail) {
    return Boolean(resource?.allowed_actions?.includes(actionId));
  }

  function markReportTemplateDirty(dirty = true) {
    state.reportTemplateDirty = dirty;
    const node = $('report-template-dirty-state');
    if (node) node.textContent = dirty ? 'Có thay đổi Draft chưa lưu' : 'Không có thay đổi chưa lưu';
    syncGuidedWorkspace('report-templates', dirty ? 3 : state.selectedReportDefinitionCode ? 2 : 1);
  }

  function showReportTemplateState(status, message = '') {
    const node = $('report-template-state');
    if (!node) return;
    node.dataset.state = status;
    node.textContent = message;
  }

  function reportTemplateWarning(code) {
    return ({
      default_version_missing: 'Chưa có Published mặc định.',
      draft_not_in_production: 'Draft mới nhất chưa ảnh hưởng production.',
    })[code] || code;
  }

  async function loadReportTemplatesAdmin() {
    if (!$('report-template-tbody')) return;
    hydrateReportTemplateUrl();
    state.reportTemplateTab = REPORT_TEMPLATE_TABS.includes(state.reportTemplateTab) ? state.reportTemplateTab : 'structure';
    showReportTemplateState('loading', 'Đang tải catalog mẫu báo cáo…');
    const response = await api('/report-templates/definitions');
    if (!response.ok) {
      state.reportTemplateDefinitions = [];
      renderReportTemplatesAdmin();
      showReportTemplateState(response.status === 403 ? 'denied' : 'error', response.status === 403
        ? 'Bạn không có quyền đọc catalog mẫu báo cáo.'
        : `Không tải được catalog. Request ${response.requestId || '—'}`);
      return;
    }
    state.reportTemplateDefinitions = response.data.items || [];
    if (!state.reportTemplateDefinitions.some((item) => item.definition_code === state.selectedReportDefinitionCode)) {
      state.selectedReportDefinitionCode = state.reportTemplateDefinitions[0]?.definition_code || '';
      state.selectedReportTemplateVersionId = '';
    }
    showReportTemplateState('ready');
    renderReportTemplatesAdmin();
    if (state.selectedReportDefinitionCode) await loadReportTemplateVersions();
  }

  function filteredReportTemplateDefinitions() {
    const search = ($('report-template-search')?.value || '').trim().toLowerCase();
    const status = $('report-template-status')?.value || '';
    return (state.reportTemplateDefinitions || []).filter((item) => {
      if (search && !`${item.definition_code} ${item.display_name} ${item.description}`.toLowerCase().includes(search)) return false;
      return !status || item.latest_version?.status === status;
    });
  }

  function businessVersionStatusLabel(status) {
    return ({
      DRAFT: 'Bản nháp',
      IN_REVIEW: 'Chờ duyệt',
      PUBLISHED: 'Đã phát hành',
      RETIRED: 'Ngừng áp dụng',
    })[status] || status || 'Chưa có phiên bản';
  }

  function reportTemplateComponentTypeLabel(type) {
    return ({
      header: 'Tiêu đề báo cáo',
      metadata_grid: 'Thông tin báo cáo',
      scope_summary: 'Phạm vi đánh giá',
      participants_table: 'Thành phần tham dự',
      supplier_introduction: 'Giới thiệu NCC',
      compliance_overview: 'Tổng quan tuân thủ',
      text_block: 'Khối nội dung',
      page_break: 'Ngắt trang',
      spacer: 'Khoảng trắng',
    })[type] || type || 'Thành phần';
  }

  function renderReportTemplatesAdmin() {
    const host = $('report-template-tbody');
    if (!host) return;
    host.textContent = '';
    const definitions = filteredReportTemplateDefinitions();
    if ($('report-template-count')) $('report-template-count').textContent = String(definitions.length);
    definitions.forEach((definition) => {
      const selected = definition.definition_code === state.selectedReportDefinitionCode;
      const card = el('article', {
        className: 'report-template-catalog-card',
        attrs: { role: 'listitem', 'data-selected': selected ? 'true' : 'false' },
      });
      const open = el('button', {
        className: 'report-template-catalog-open',
        attrs: { type: 'button', 'data-action-id': 'report_template.tab_open', 'aria-current': selected ? 'true' : 'false' },
      });
      const heading = el('span', { className: 'report-template-catalog-heading' });
      heading.appendChild(el('span', { className: 'report-template-catalog-code mono', text: definition.definition_code }));
      heading.appendChild(el('span', {
        className: `tag sev-${definition.latest_version?.status === 'PUBLISHED' ? 'green' : definition.latest_version?.status === 'DRAFT' ? 'amber' : 'gray'}`,
        text: businessVersionStatusLabel(definition.latest_version?.status),
      }));
      open.appendChild(heading);
      open.appendChild(el('strong', { className: 'report-template-catalog-name', text: definition.display_name }));
      open.appendChild(el('span', { className: 'report-template-catalog-description', text: definition.description }));
      const meta = el('span', { className: 'report-template-catalog-meta' });
      meta.appendChild(el('span', { text: `${definition.version_count} phiên bản` }));
      meta.appendChild(el('span', { text: definition.default_version ? `Đang áp dụng v${definition.default_version.version_no} · ${definition.default_scope}` : 'Chưa có phiên bản áp dụng' }));
      open.appendChild(meta);
      setRegisteredButtonAction(open, 'report_template.tab_open', async () => {
        if (!confirmBusinessConfigRouteLeave(window.location.hash)) return;
        state.selectedReportDefinitionCode = definition.definition_code;
        state.selectedReportTemplateVersionId = '';
        state.selectedReportComponentId = '';
        renderReportTemplatesAdmin();
        await loadReportTemplateVersions();
      }, { context: actionContext(definition) });
      card.appendChild(open);
      const openDefinition = async (tab = 'structure') => {
        if (!confirmBusinessConfigRouteLeave(window.location.hash)) return;
        state.selectedReportDefinitionCode = definition.definition_code;
        state.selectedReportTemplateVersionId = '';
        state.selectedReportComponentId = '';
        renderReportTemplatesAdmin();
        await loadReportTemplateVersions();
        setReportTemplateTab(tab);
      };
      card.appendChild(RowActionGroup([
        actionDescriptor('report_template.tab_open', () => openDefinition('structure'), definition, { label: 'Mở mẫu', announceSuccess: false }),
      ], [
        actionDescriptor('report_template.preview', () => openDefinition('preview'), definition, { label: 'Xem trước', announceSuccess: false }),
        actionDescriptor('report_template.create_draft', async () => { await openDefinition('versions'); await createReportTemplateDraft(); }, definition, { label: 'Tạo bản nháp', announceSuccess: false }),
      ]));
      const warningText = (definition.warnings || []).map(reportTemplateWarning).join(' · ');
      if (warningText) card.appendChild(el('p', { className: 'report-template-catalog-warning', text: warningText }));
      host.appendChild(card);
    });
    if (!host.children.length) {
      host.appendChild(el('p', { className: 'report-template-catalog-empty muted', text: 'Không có mẫu canonical khớp bộ lọc.' }));
    }
    syncReportTemplateActionButtons();
  }

  async function loadReportTemplateVersions() {
    const definition = selectedReportDefinition();
    if (!definition) return renderReportTemplateWorkspace();
    const response = await api(`/report-templates/definitions/${encodeURIComponent(definition.definition_code)}/versions`);
    if (!response.ok) {
      showReportTemplateState('error', `Không tải được version. Request ${response.requestId || '—'}`);
      return;
    }
    state.reportTemplateVersions = response.data.items || [];
    const stillSelected = state.reportTemplateVersions.some((version) => String(version.id) === String(state.selectedReportTemplateVersionId));
    if (!stillSelected) {
      const preferred = state.reportTemplateVersions.find((version) => version.status === 'DRAFT')
        || state.reportTemplateVersions.find((version) => version.is_default)
        || state.reportTemplateVersions[0];
      state.selectedReportTemplateVersionId = String(preferred?.id || '');
    }
    await loadReportTemplateVersionDetail();
  }

  async function loadReportTemplateVersionDetail() {
    if (!state.selectedReportTemplateVersionId) {
      state.reportTemplateVersionDetail = null;
      renderReportTemplateWorkspace();
      return;
    }
    const response = await api(`/report-templates/versions/${encodeURIComponent(state.selectedReportTemplateVersionId)}`);
    if (!response.ok) {
      showReportTemplateState('error', `Không tải được chi tiết version. Request ${response.requestId || '—'}`);
      return;
    }
    state.reportTemplateVersionDetail = response.data.item;
    state.reportTemplateVersionEvents = response.data.events || [];
    const components = state.reportTemplateVersionDetail.definition?.components || [];
    if (!components.some((component) => component.id === state.selectedReportComponentId)) state.selectedReportComponentId = components[0]?.id || '';
    state.reportTemplateAdvancedDirty = false;
    markReportTemplateDirty(false);
    renderReportTemplateWorkspace();
    await loadReportTemplatePreviewSources();
    await previewReportTemplateVersion();
    syncReportTemplateUrl({ replace: true });
  }

  function renderReportTemplateWorkspace() {
    const definition = selectedReportDefinition();
    const version = state.reportTemplateVersionDetail;
    syncGuidedWorkspace('report-templates', state.reportTemplateDirty ? 3 : definition ? 2 : 1);
    const editor = $('report-template-editor');
    if (!editor) return;
    editor.classList.toggle('hidden', !definition);
    if (!definition) return;
    $('report-template-editor-title').textContent = `${definition.definition_code} · ${definition.display_name}`;
    $('report-template-version-meta').textContent = version
      ? `v${version.version_no} · ${version.status} · ${version.is_default ? 'Mặc định GLOBAL/*' : 'Không phải mặc định'} · lock ${version.lock_version}`
      : 'Chưa có version.';
    const select = $('report-template-version-select');
    select.textContent = '';
    (state.reportTemplateVersions || []).forEach((item) => select.appendChild(el('option', { text: `v${item.version_no} · ${businessVersionStatusLabel(item.status)}${item.is_default ? ' · Đang áp dụng' : ''}`, attrs: { value: item.id } })));
    select.value = state.selectedReportTemplateVersionId || '';
    renderBusinessConfigLifecycle('report-template-lifecycle', version);
    const readOnlyBanner = $('report-template-readonly');
    const readOnly = Boolean(version && !reportTemplateEditable(version));
    readOnlyBanner.classList.toggle('hidden', !readOnly);
    readOnlyBanner.dataset.status = version?.status || '';
    $('report-template-readonly-message').textContent = version?.status === 'IN_REVIEW'
      ? 'Phiên bản đang Review nên chỉ đọc nhưng vẫn có thể preview đúng version đã chọn. Clone thành Draft nếu cần chỉnh sửa.'
      : 'Published/Retired là bất biến. Clone thành Draft để chỉnh sửa mà không thay đổi output production hiện tại.';
    renderReportTemplateTabs();
    renderReportTemplateComponentTree();
    renderReportTemplateProperties();
    renderReportTemplateTimeline();
    syncReportTemplateActionButtons();
  }

  function renderReportTemplateTabs() {
    const active = REPORT_TEMPLATE_TABS.includes(state.reportTemplateTab) ? state.reportTemplateTab : 'structure';
    document.querySelectorAll('[data-report-template-tab]').forEach((button) => {
      const selected = button.dataset.reportTemplateTab === active;
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
      button.tabIndex = selected ? 0 : -1;
    });
    const builder = document.querySelector('.report-template-builder');
    const builderActive = ['structure', 'data', 'presentation', 'preview'].includes(active);
    if (builder) {
      builder.classList.toggle('hidden', !builderActive);
      builder.dataset.activeTab = active;
      builder.setAttribute('aria-labelledby', `report-template-tab-${active}`);
    }
    const visiblePanels = {
      structure: new Set(['tree', 'inspector']),
      data: new Set(['tree', 'inspector']),
      presentation: new Set(['preview', 'inspector']),
      preview: new Set(['preview']),
    }[active] || new Set();
    document.querySelectorAll('[data-report-builder-panel]').forEach((panel) => {
      const visible = builderActive && visiblePanels.has(panel.dataset.reportBuilderPanel);
      panel.classList.toggle('hidden', !visible);
      panel.setAttribute('aria-hidden', visible ? 'false' : 'true');
    });
    $('report-template-validation')?.classList.toggle('hidden', active !== 'validation');
    $('report-template-version-timeline')?.classList.toggle('hidden', active !== 'versions');
    $('report-template-scope')?.classList.toggle('hidden', active !== 'scope');
    document.querySelectorAll('[data-report-inspector-tab]').forEach((field) => {
      const visible = field.dataset.reportInspectorTab === active;
      field.classList.toggle('hidden', !visible);
    });
    $('report-template-standard-properties')?.classList.toggle('hidden', !['structure', 'data'].includes(active));
    if (active === 'presentation') renderReportTemplateProperties();
  }

  function setReportTemplateTab(tab, { focus = false } = {}) {
    if (!REPORT_TEMPLATE_TABS.includes(tab)) return;
    state.reportTemplateTab = tab;
    renderReportTemplateTabs();
    syncReportTemplateUrl();
    if (focus) document.querySelector(`[data-report-template-tab="${tab}"]`)?.focus();
  }

  function reportTemplateComponents() {
    return state.reportTemplateVersionDetail?.definition?.components || [];
  }

  function selectedReportTemplateComponent() {
    return reportTemplateComponents().find((component) => component.id === state.selectedReportComponentId) || null;
  }

  function renderReportTemplateComponentTree() {
    const host = $('report-template-component-tree');
    if (!host) return;
    host.textContent = '';
    const components = reportTemplateComponents();
    $('report-template-component-count').textContent = `${components.length} thành phần`;
    components.forEach((component, index) => {
      const button = el('button', {
        className: 'report-template-component-node',
        attrs: { type: 'button', role: 'treeitem', 'aria-selected': component.id === state.selectedReportComponentId ? 'true' : 'false', 'data-action-id': 'report_template.tab_open' },
      });
      button.appendChild(el('strong', { text: `${index + 1}. ${component.title || reportTemplateComponentTypeLabel(component.type)}` }));
      button.appendChild(el('span', { className: 'report-template-component-meta', text: `${reportTemplateComponentTypeLabel(component.type)} · ${component.id}` }));
      setRegisteredButtonAction(button, 'report_template.tab_open', () => {
        state.selectedReportComponentId = component.id;
        renderReportTemplateComponentTree();
        renderReportTemplateProperties();
      }, { context: actionContext(state.reportTemplateVersionDetail) });
      host.appendChild(button);
    });
  }

  function setControlValue(id, value, disabled) {
    const node = $(id);
    if (!node) return;
    node.value = value == null ? '' : value;
    node.disabled = disabled;
    setDisabledReason(node, disabled ? 'invalid_status' : '');
  }

  function renderReportTemplateProperties() {
    const component = selectedReportTemplateComponent();
    const version = state.reportTemplateVersionDetail;
    const editable = reportTemplateEditable(version);
    $('report-template-selected-component').textContent = component ? `${reportTemplateComponentTypeLabel(component.type)} · ${component.id}` : 'Chưa chọn';
    setControlValue('report-template-component-title', component?.title || '', !editable || !component || ['page_break', 'spacer'].includes(component.type));
    const binding = $('report-template-component-binding');
    binding.textContent = '';
    binding.appendChild(el('option', { text: 'Không dùng binding', attrs: { value: '' } }));
    REPORT_TEMPLATE_BINDINGS.forEach((item) => binding.appendChild(el('option', { text: item, attrs: { value: item } })));
    const bindingKey = component?.type === 'header' ? 'subtitle_binding' : 'binding';
    binding.value = component?.[bindingKey] || '';
    binding.disabled = !editable || !component || !(bindingKey in (component || {}));
    setControlValue('report-template-component-text', component?.type === 'text_block' ? component.text || '' : '', !editable || component?.type !== 'text_block');
    const styles = version?.definition?.styles || {};
    setControlValue('report-template-orientation', styles.page_orientation || 'portrait', !editable);
    setControlValue('report-template-font-scale', styles.font_scale || 1, !editable);
    setControlValue('report-template-accent', styles.accent_color || '#111827', !editable);
    const isOverview = component?.type === 'compliance_overview';
    $('report-template-overview-editor').classList.toggle('hidden', !isOverview || state.reportTemplateTab !== 'presentation');
    if (isOverview) {
      const presentation = component.presentation || {};
      setControlValue('report-template-overview-layout', presentation.layout || 'table_chart', !editable);
      $('report-template-overview-chart').checked = presentation.show_chart !== false;
      $('report-template-overview-chart').disabled = !editable;
      $('report-template-overview-legend').checked = presentation.show_legend !== false;
      $('report-template-overview-legend').disabled = !editable;
    }
    const advanced = $('report-template-advanced');
    advanced.classList.toggle('hidden', state.reportTemplateTab !== 'structure' || !reportTemplateActionAllowed('report_template.advanced_json', version));
    if (!advanced.classList.contains('hidden') && !state.reportTemplateAdvancedDirty) {
      $('report-template-advanced-json').value = JSON.stringify(version?.definition || {}, null, 2);
    }
  }

  function updateSelectedReportComponent(field, value) {
    if (!reportTemplateEditable()) return;
    const component = selectedReportTemplateComponent();
    if (!component) return;
    if (value === '') delete component[field];
    else component[field] = value;
    state.reportTemplateAdvancedDirty = false;
    markReportTemplateDirty(true);
    renderReportTemplateComponentTree();
  }

  function updateReportTemplateStyle() {
    if (!reportTemplateEditable()) return;
    state.reportTemplateVersionDetail.definition.styles = {
      page_orientation: $('report-template-orientation').value,
      font_scale: Number($('report-template-font-scale').value),
      accent_color: $('report-template-accent').value,
    };
    state.reportTemplateAdvancedDirty = false;
    markReportTemplateDirty(true);
  }

  function updateReportTemplateOverview() {
    const component = selectedReportTemplateComponent();
    if (!reportTemplateEditable() || component?.type !== 'compliance_overview') return;
    component.presentation = {
      layout: $('report-template-overview-layout').value,
      category_mode: 'all',
      show_chart: $('report-template-overview-chart').checked,
      show_legend: $('report-template-overview-legend').checked,
    };
    state.reportTemplateAdvancedDirty = false;
    markReportTemplateDirty(true);
  }

  function uniqueReportComponentId(type) {
    const ids = new Set(reportTemplateComponents().map((component) => component.id));
    let index = 1;
    while (ids.has(`${type.replaceAll('_', '-')}-${index}`)) index += 1;
    return `${type.replaceAll('_', '-')}-${index}`;
  }

  function addReportTemplateComponent() {
    if (!reportTemplateEditable()) return;
    const type = $('report-template-component-type').value;
    const id = uniqueReportComponentId(type);
    const component = type === 'text_block'
      ? { id, type, title: 'Khối văn bản mới', text: 'Nhập nội dung hiển thị' }
      : type === 'spacer' ? { id, type, lines: 1 } : { id, type };
    reportTemplateComponents().push(component);
    state.selectedReportComponentId = id;
    markReportTemplateDirty(true);
    renderReportTemplateComponentTree();
    renderReportTemplateProperties();
  }

  function moveReportTemplateComponent(direction) {
    if (!reportTemplateEditable()) return;
    const components = reportTemplateComponents();
    const index = components.findIndex((component) => component.id === state.selectedReportComponentId);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= components.length) return;
    [components[index], components[next]] = [components[next], components[index]];
    markReportTemplateDirty(true);
    renderReportTemplateComponentTree();
    $('report-template-component-tree')?.querySelector('[aria-selected="true"]')?.focus();
  }

  function applyAdvancedReportTemplateJson() {
    if (!reportTemplateActionAllowed('report_template.advanced_json')) return;
    try {
      const definition = JSON.parse($('report-template-advanced-json').value);
      state.reportTemplateVersionDetail.definition = definition;
      state.reportTemplateAdvancedDirty = true;
      state.selectedReportComponentId = definition.components?.[0]?.id || '';
      markReportTemplateDirty(true);
      renderReportTemplateComponentTree();
      renderReportTemplateProperties();
      $('report-template-live').textContent = 'JSON đã parse cục bộ; schema và sanitizer sẽ kiểm tra khi Lưu Draft.';
    } catch {
      showReportTemplateValidation(['JSON không hợp lệ. Dữ liệu Draft chưa thay đổi.']);
    }
  }

  function formatReportTemplateValidationIssue(data = {}, requestId = '') {
    const details = data?.details || {};
    const path = String(details.path || '');
    const componentIndex = path.match(/^components\.(\d+)/)?.[1];
    const component = componentIndex == null ? null : reportTemplateComponents()[Number(componentIndex)];
    const parts = [data?.error || 'report_template_validation_failed'];
    if (component?.id) parts.push(`component ${component.id}`);
    if (path) parts.push(`path ${path}`);
    if (details.binding) parts.push(`binding ${details.binding}`);
    if (requestId) parts.push(`Request ${requestId}`);
    return parts.join(' · ');
  }

  function focusReportTemplateValidationTarget(details = {}) {
    const path = String(details.path || '');
    if (!path) return;
    const componentIndex = path.match(/^components\.(\d+)/)?.[1];
    if (componentIndex != null) {
      const component = reportTemplateComponents()[Number(componentIndex)];
      if (component) state.selectedReportComponentId = component.id;
    }
    const tab = path.startsWith('styles') || path.includes('.presentation')
      ? 'presentation'
      : path.includes('.binding') || path.includes('.fields') || path.includes('.columns') ? 'data' : 'structure';
    setReportTemplateTab(tab);
    renderReportTemplateComponentTree();
    renderReportTemplateProperties();
    const target = tab === 'presentation'
      ? $('report-template-orientation')
      : tab === 'data' ? $('report-template-component-binding') : $('report-template-component-tree')?.querySelector('[aria-selected="true"]');
    target?.focus();
  }

  function showReportTemplateValidation(errors, details = null) {
    const summary = $('report-template-validation-summary');
    const messages = errors || [];
    const text = messages.join(' · ');
    summary.textContent = text;
    summary.classList.toggle('hidden', !messages.length);
    const helpLink = $('report-template-error-help');
    if (helpLink) {
      const errorCode = text.match(/\b(?:report|artifact|forbidden|unsafe|export)_[a-z0-9_]+\b/i)?.[0] || 'report_help_general';
      helpLink.dataset.errorCode = messages.length ? errorCode : '';
      helpLink.textContent = `Hướng dẫn xử lý${messages.length && errorCode !== 'report_help_general' ? `: ${errorCode}` : ' lỗi báo cáo'}`;
      helpLink.classList.toggle('hidden', !messages.length);
    }
    if (messages.length) {
      summary.focus();
      if (details?.path) window.setTimeout(() => focusReportTemplateValidationTarget(details), 0);
    }
  }

  async function saveReportTemplateDraft({ quiet = false } = {}) {
    const version = state.reportTemplateVersionDetail;
    if (!reportTemplateEditable(version)) return false;
    const finish = quiet ? () => {} : setButtonLoading($('report-template-save-draft'), 'Đang lưu…');
    const advanced = state.reportTemplateAdvancedDirty;
    const body = advanced ? {
      lock_version: version.lock_version,
      editor_mode: 'advanced_json',
      definition: version.definition,
    } : {
      lock_version: version.lock_version,
      components: version.definition.components,
      styles: version.definition.styles || {},
    };
    const response = await api(`/report-templates/versions/${encodeURIComponent(version.id)}`, { method: 'PUT', body });
    finish(response.ok ? 'Đã lưu ✓' : '');
    if (!response.ok) {
      const message = response.data?.error === 'report_template_version_conflict'
        ? 'Draft đã thay đổi ở phiên làm việc khác. Tải lại trước khi lưu để tránh ghi đè.'
        : formatReportTemplateValidationIssue(response.data, response.requestId);
      showReportTemplateValidation([message], response.data?.details);
      return false;
    }
    state.reportTemplateVersionDetail = response.data.item;
    state.reportTemplateAdvancedDirty = false;
    markReportTemplateDirty(false);
    showReportTemplateValidation([]);
    if (!quiet) $('report-template-live').textContent = 'Đã lưu Draft; production export chưa thay đổi.';
    renderReportTemplateWorkspace();
    return true;
  }

  async function createReportTemplateDraft() {
    const definition = selectedReportDefinition();
    if (!definition) return;
    const source = state.reportTemplateVersionDetail || definition.default_version;
    const response = await api(`/report-templates/definitions/${encodeURIComponent(definition.definition_code)}/versions`, {
      method: 'POST', body: { source_version_id: source?.id || null, version_name: `${definition.display_name} Draft` },
    });
    if (!response.ok) return showReportTemplateValidation([formatReportTemplateValidationIssue(response.data, response.requestId)], response.data?.details);
    state.selectedReportTemplateVersionId = String(response.data.item.id);
    $('report-template-live').textContent = 'Đã clone thành Draft. Published hiện tại vẫn điều khiển production.';
    await loadReportTemplateVersions();
  }

  async function validateReportTemplateDraft() {
    if (state.reportTemplateDirty && !(await saveReportTemplateDraft({ quiet: true }))) return;
    const version = state.reportTemplateVersionDetail;
    if (!version) return;
    const response = await api(`/report-templates/versions/${encodeURIComponent(version.id)}/validate`, { method: 'POST', body: {} });
    if (!response.ok) return showReportTemplateValidation([formatReportTemplateValidationIssue(response.data, response.requestId)], response.data?.details);
    const result = response.data.item;
    $('report-template-validation-result').textContent = `Hợp lệ · ${result.component_count} component · checksum ${result.checksum} · ${result.warnings.length ? result.warnings.join(', ') : 'không có cảnh báo'}`;
    showReportTemplateValidation([]);
    setReportTemplateTab('validation');
  }

  async function transitionReportTemplate(action) {
    if (state.reportTemplateDirty && !(await saveReportTemplateDraft({ quiet: true }))) return;
    const version = state.reportTemplateVersionDetail;
    if (!version) return;
    const response = await api(`/report-templates/versions/${encodeURIComponent(version.id)}/${action}`, { method: 'POST', body: { lock_version: version.lock_version } });
    if (!response.ok) return showReportTemplateValidation([formatReportTemplateValidationIssue(response.data, response.requestId)], response.data?.details);
    state.selectedReportTemplateVersionId = String(response.data.item.id);
    $('report-template-live').textContent = action === 'publish'
      ? 'Đã publish và đặt mặc định cho export mới; artifact lịch sử giữ nguyên provenance.'
      : action === 'rollback' ? 'Đã rollback mặc định cho export mới; artifact lịch sử không đổi.' : 'Đã gửi version sang Review.';
    await loadReportTemplatesAdmin();
  }

  async function loadReportTemplatePreviewSources() {
    const definition = selectedReportDefinition();
    if (!definition) return;
    const response = await api(`/report-templates/preview-sources?definition_code=${encodeURIComponent(definition.definition_code)}`);
    const select = $('report-template-preview-source');
    if (!select) return;
    const previous = select.value;
    select.textContent = '';
    ((response.ok && response.data.items) || [{ source: 'synthetic', supplier_name: 'Dữ liệu tổng hợp an toàn' }]).forEach((item) => {
      const value = item.source === 'synthetic' ? 'synthetic' : `ticket:${item.ticket_code}`;
      select.appendChild(el('option', { text: item.source === 'synthetic' ? 'Dữ liệu tổng hợp an toàn' : `${item.ticket_code} · ${item.supplier_name}`, attrs: { value } }));
    });
    select.value = Array.from(select.options).some((option) => option.value === previous) ? previous : 'synthetic';
    const round = $('report-template-preview-round');
    round.textContent = '';
    (definition.allowed_rounds || [1]).forEach((value) => round.appendChild(el('option', { text: `Vòng ${value}`, attrs: { value } })));
  }

  async function previewReportTemplateVersion() {
    const version = state.reportTemplateVersionDetail;
    if (!version) return;
    if (state.reportTemplateDirty && !(await saveReportTemplateDraft({ quiet: true }))) return;
    const sourceValue = $('report-template-preview-source')?.value || 'synthetic';
    const round = $('report-template-preview-round')?.value || selectedReportDefinition()?.allowed_rounds?.[0] || 1;
    const query = sourceValue === 'synthetic'
      ? `source=synthetic&round_no=${encodeURIComponent(round)}&format=HTML&envelope=1`
      : `source=ticket&ticket_code=${encodeURIComponent(sourceValue.slice(7))}&round_no=${encodeURIComponent(round)}&format=HTML&envelope=1`;
    const response = await api(`/report-templates/versions/${encodeURIComponent(version.id)}/preview?${query}`);
    if (!response.ok) return showReportTemplateValidation([formatReportTemplateValidationIssue(response.data, response.requestId)], response.data?.details);
    const preview = response.data;
    const frame = $('report-template-a4-preview');
    frame.setAttribute('sandbox', '');
    frame.srcdoc = preview.html;
    const provenance = preview.provenance;
    $('report-template-preview-provenance').textContent = `Definition ${provenance.definition_code} · template v${provenance.template_version_no} #${provenance.template_version_id} · data contract v${provenance.data_contract_version} · policy ${provenance.scoring_policy.version_id || provenance.scoring_policy.compatibility_marker} · ${provenance.source} · vòng ${provenance.round_no}`;
    const warnings = $('report-template-preview-warnings');
    warnings.textContent = '';
    (preview.warnings || []).forEach((warning) => warnings.appendChild(el('div', { className: 'report-template-preview-warning', text: `${warning.code}${warning.component_id ? ` · ${warning.component_id}` : ''}` })));
    const formats = $('report-template-format-links'); formats.textContent = '';
    (preview.formats || []).forEach((item) => formats.appendChild(el('a', { className: 'btn-ghost', text: `${item.format} · cùng semantic`, attrs: { href: item.url, target: '_blank', rel: 'noopener' } })));
    $('report-template-preview-compare').textContent = preview.comparison.changed
      ? `Khác Published v${preview.comparison.baseline_template_version_id || '—'} tại: ${preview.comparison.changed_component_ids.join(', ') || 'style/layout'}. Chưa ảnh hưởng production khi còn Draft.`
      : 'Semantic giống version Published mặc định.';
    showReportTemplateValidation([]);
  }

  function renderReportTemplateTimeline() {
    const host = $('report-template-version-events');
    if (!host) return;
    host.textContent = '';
    (state.reportTemplateVersions || []).forEach((version) => host.appendChild(el('div', { className: 'report-template-version-event', text: `v${version.version_no} · ${businessVersionStatusLabel(version.status)} · ${version.is_default ? 'Mặc định' : 'Không mặc định'} · ${version.export_count || 0} lượt xuất` })));
    (state.reportTemplateVersionEvents || []).forEach((event) => host.appendChild(el('div', { className: 'report-template-version-event', text: `${event.created_at} · ${event.action} · ${event.actor_user_id || 'system'} · ${event.correlation_id || '—'}` })));
  }

  function exportReportTemplatePackage() {
    const version = state.reportTemplateVersionDetail;
    if (!version) return;
    const anchor = document.createElement('a');
    anchor.href = `/qlcl/api/report-templates/versions/${encodeURIComponent(version.id)}/package`;
    anchor.download = `${version.definition_code.toLowerCase()}-v${version.version_no}.report.json`;
    anchor.click();
  }

  async function importReportTemplatePackage() {
    const definition = selectedReportDefinition();
    const file = $('report-template-package-file')?.files?.[0];
    if (!definition || !file) return showReportTemplateValidation(['Chọn definition package JSON trước khi import.']);
    let packageData;
    try { packageData = JSON.parse(await file.text()); } catch { return showReportTemplateValidation(['Definition package không phải JSON hợp lệ.']); }
    const response = await api(`/report-templates/definitions/${encodeURIComponent(definition.definition_code)}/import-package`, {
      method: 'POST', body: { package: packageData, conflict_strategy: $('report-template-package-conflict').value },
    });
    if (!response.ok) return showReportTemplateValidation([formatReportTemplateValidationIssue(response.data, response.requestId)], response.data?.details);
    state.selectedReportTemplateVersionId = String(response.data.item.id);
    $('report-template-live').textContent = 'Package đã được kiểm tra và import vào Draft mới; chưa publish.';
    await loadReportTemplateVersions();
  }

  function syncReportTemplateActionButtons() {
    const version = state.reportTemplateVersionDetail;
    const definition = selectedReportDefinition();
    const actions = {
      'report-template-create-draft': ['report_template.create_draft', definition],
      'report-template-save-draft': ['report_template.save_draft', version],
      'report-template-validate': ['report_template.validate', version],
      'report-template-submit-review': ['report_template.submit_review', version],
      'report-template-publish': ['report_template.publish', version],
      'report-template-rollback': ['report_template.rollback', version],
      'report-template-preview-refresh': ['report_template.preview', version],
      'report-template-import-package': ['report_template.import_package', definition],
      'report-template-export-package': ['report_template.export_package', version],
    };
    Object.entries(actions).forEach(([id, [actionId, resource]]) => {
      const button = $(id); if (!button) return;
      BUSINESS_CONFIG.applyActionState(button, resource, actionId, setDisabledReason);
    });
    for (const id of ['report-template-save-draft', 'report-template-publish']) {
      const button = $(id); if (!button) continue;
      const actionId = button.dataset.actionId;
      const isPrimary = version?.allowed_actions?.includes(actionId);
      button.classList.toggle('btn-primary', isPrimary);
      button.classList.toggle('btn-ghost', !isPrimary);
    }
    const editable = reportTemplateEditable(version);
    for (const id of ['report-template-component-add', 'report-template-component-up', 'report-template-component-down']) {
      if (!$(id)) continue;
      $(id).disabled = !editable;
      setDisabledReason($(id), editable ? '' : (version?.disabled_reasons?.['report_template.save_draft'] || 'invalid_status'));
    }
  }

  async function loadQuestionAdmin() {
    await loadQuestionWorkspace();
  }

  function selectedQuestionVersion() {
    return (state.questionVersions || []).find((version) => String(version.id) === String(state.selectedQuestionVersionId)) || null;
  }

  async function loadQuestionVersions() {
    if (!state.selectedQuestionTemplateId) {
      state.questionVersions = [];
      state.selectedQuestionVersionId = '';
      renderQuestionImport();
      return;
    }
    const response = await api('/question-templates/' + encodeURIComponent(state.selectedQuestionTemplateId) + '/versions');
    state.questionVersions = (response.ok && response.data.items) || [];
    const selectedStillExists = state.questionVersions.some((version) => String(version.id) === String(state.selectedQuestionVersionId));
    if (!selectedStillExists) {
      const draft = state.questionVersions.find((version) => version.status === 'DRAFT');
      state.selectedQuestionVersionId = String((draft || state.questionVersions[0] || {}).id || '');
    }
    renderQuestionImport();
  }

  function renderQuestionImport() {
    const select = $('question-version-select');
    if (!select) return;
    select.textContent = '';
    (state.questionVersions || []).forEach((version) => select.appendChild(el('option', {
      attrs: { value: String(version.id) },
      text: `v${version.version_no} · ${version.status} · ${version.item_count} câu hỏi`,
    })));
    select.value = state.selectedQuestionVersionId || '';
    const version = selectedQuestionVersion();
    const previewButton = $('question-import-preview');
    const cloneButton = $('question-version-clone-draft');
    if (cloneButton) cloneButton.disabled = !version;
    if (previewButton) {
      previewButton.disabled = !version || version.status !== 'DRAFT';
      previewButton.title = version && version.status !== 'DRAFT' ? 'Chỉ có thể preview import vào Draft.' : '';
    }

    const preview = state.questionImportPreview;
    const batch = preview?.batch;
    const summary = $('question-import-summary');
    const tbody = $('question-import-diff-tbody');
    const partialWrap = $('question-import-partial-wrap');
    const partial = $('question-import-accept-partial');
    const commit = $('question-import-commit');
    const errors = $('question-import-errors');
    const rollback = $('question-import-rollback');
    if (!preview || Number(batch?.target_version_id) !== Number(version?.id)) {
      if (summary) summary.textContent = version?.status === 'DRAFT'
        ? 'Chọn workbook để xem diff trước khi commit.'
        : 'Phiên bản này bất biến. Hãy tạo hoặc chọn một Draft.';
      if (tbody) {
        tbody.textContent = '';
        const empty = el('tr');
        empty.appendChild(el('td', { className: 'muted', attrs: { colspan: '3' }, text: 'Chưa có preview.' }));
        tbody.appendChild(empty);
      }
      partialWrap?.classList.add('hidden');
      errors?.classList.add('hidden');
      rollback?.classList.add('hidden');
      if (commit) commit.disabled = true;
      return;
    }

    if (summary) summary.textContent = [
      `Batch ${batch.public_id}`,
      `Thêm ${batch.added_count}`,
      `Đổi ${batch.changed_count}`,
      `Xóa ${batch.removed_count}`,
      `Giữ nguyên ${batch.unchanged_count}`,
      `Lỗi ${batch.invalid_rows + batch.duplicate_rows}`,
    ].join(' · ');
    if (tbody) {
      tbody.textContent = '';
      const order = ['ADDED', 'CHANGED', 'REMOVED', 'UNCHANGED', 'DUPLICATE', 'INVALID'];
      const rows = order.flatMap((type) => (preview.diff?.[type] || []).map((change) => ({ type, change })));
      rows.slice(0, 100).forEach(({ type, change }) => {
        const tr = el('tr');
        const severity = ['INVALID', 'DUPLICATE'].includes(type) ? 'red' : (type === 'REMOVED' ? 'amber' : 'gray');
        const typeCell = el('td');
        typeCell.appendChild(el('span', { className: `tag sev-${severity}`, text: type }));
        tr.appendChild(typeCell);
        tr.appendChild(el('td', { className: 'mono', text: change.key || '—' }));
        tr.appendChild(el('td', {
          className: 'muted',
          text: change.errors?.length ? change.errors.join(', ') : (change.row ? `Dòng ${change.row}` : 'Đã đối chiếu với Draft hiện tại'),
        }));
        tbody.appendChild(tr);
      });
      if (!rows.length) {
        const empty = el('tr');
        empty.appendChild(el('td', { className: 'muted', attrs: { colspan: '3' }, text: 'Không có thay đổi.' }));
        tbody.appendChild(empty);
      }
    }
    const needsPartial = batch.status === 'PREVIEWED';
    partialWrap?.classList.toggle('hidden', !needsPartial);
    errors?.classList.toggle('hidden', (batch.invalid_rows + batch.duplicate_rows) === 0);
    rollback?.classList.toggle('hidden', batch.status !== 'COMMITTED');
    if (commit) commit.disabled = batch.status === 'COMMITTED' || batch.status === 'ROLLED_BACK' || (needsPartial && !partial?.checked);
  }

  async function createQuestionVersionDraft() {
    const version = selectedQuestionVersion();
    if (!version || !state.selectedQuestionTemplateId) return;
    const response = await api('/question-templates/' + encodeURIComponent(state.selectedQuestionTemplateId) + '/versions', {
      method: 'POST',
      body: { clone_from_version_id: version.id, note: `Draft imported from v${version.version_no}` },
    });
    if (!response.ok) return setMsg('question-import-status', 'Không tạo được Draft.', 'err');
    state.selectedQuestionVersionId = String(response.data.item.id);
    state.questionImportPreview = null;
    setMsg('question-import-status', 'Đã tạo Draft mới. Chọn workbook để preview.', 'ok');
    await loadQuestionVersions();
  }

  async function previewQuestionImport() {
    const version = selectedQuestionVersion();
    const file = $('question-import-file')?.files?.[0];
    if (!version || version.status !== 'DRAFT') return setMsg('question-import-status', 'Chỉ import vào Draft.', 'err');
    if (!file || !file.name.toLowerCase().endsWith('.xlsx')) return setMsg('question-import-status', 'Chọn workbook .xlsx hợp lệ.', 'err');
    const form = new FormData();
    form.append('file', file);
    const finish = setButtonLoading($('question-import-preview'), 'Đang kiểm tra...');
    const response = await api('/question-templates/' + encodeURIComponent(state.selectedQuestionTemplateId)
      + '/versions/' + encodeURIComponent(version.id) + '/imports/preview', { method: 'POST', body: form });
    finish();
    if (!response.ok) return setMsg('question-import-status', `Preview thất bại: ${response.data.error || 'unknown'} · Request ${response.requestId || '—'}`, 'err');
    state.questionImportPreview = response.data.item;
    if ($('question-import-accept-partial')) $('question-import-accept-partial').checked = false;
    setMsg('question-import-status', 'Preview đã sẵn sàng. Kiểm tra diff và lỗi trước khi commit.', 'ok');
    renderQuestionImport();
  }

  async function commitQuestionImport() {
    const version = selectedQuestionVersion();
    const preview = state.questionImportPreview;
    if (!version || !preview?.confirmation_token) return;
    const response = await api('/question-templates/' + encodeURIComponent(state.selectedQuestionTemplateId)
      + '/versions/' + encodeURIComponent(version.id) + '/imports/' + encodeURIComponent(preview.batch.public_id) + '/commit', {
      method: 'POST',
      body: {
        confirmation_token: preview.confirmation_token,
        expected_lock_version: version.lock_version,
        accept_partial: $('question-import-accept-partial')?.checked === true,
      },
    });
    if (!response.ok) return setMsg('question-import-status', `Commit thất bại: ${response.data.error || 'unknown'} · Request ${response.requestId || '—'}`, 'err');
    state.questionImportPreview = { ...preview, batch: response.data.item.batch, version: response.data.item.version };
    setMsg('question-import-status', 'Đã commit nguyên tử vào Draft. Phiên bản chưa được publish.', 'ok');
    await loadQuestionVersions();
  }

  async function rollbackQuestionImport() {
    const version = selectedQuestionVersion();
    const preview = state.questionImportPreview;
    if (!version || preview?.batch?.status !== 'COMMITTED') return;
    const response = await api('/question-templates/' + encodeURIComponent(state.selectedQuestionTemplateId)
      + '/versions/' + encodeURIComponent(version.id) + '/imports/' + encodeURIComponent(preview.batch.public_id) + '/rollback', {
      method: 'POST', body: { expected_lock_version: version.lock_version },
    });
    if (!response.ok) return setMsg('question-import-status', `Hoàn tác thất bại: ${response.data.error || 'unknown'} · Request ${response.requestId || '—'}`, 'err');
    state.questionImportPreview = { ...preview, batch: response.data.item.batch, version: response.data.item.version };
    setMsg('question-import-status', 'Đã phục hồi snapshot Draft trước batch.', 'ok');
    await loadQuestionVersions();
  }

  function downloadQuestionImportErrors() {
    const version = selectedQuestionVersion();
    const batch = state.questionImportPreview?.batch;
    if (!version || !batch) return;
    const anchor = document.createElement('a');
    anchor.href = '/qlcl/api/question-templates/' + encodeURIComponent(state.selectedQuestionTemplateId)
      + '/versions/' + encodeURIComponent(version.id) + '/imports/' + encodeURIComponent(batch.public_id) + '/errors.xlsx';
    anchor.click();
  }

  async function loadAdminQuestions() {
    if (!state.selectedQuestionTemplateId) {
      state.adminQuestions = [];
      renderAdminQuestions();
      return;
    }
    const r = await api('/question-templates/' + encodeURIComponent(state.selectedQuestionTemplateId) + '/questions?include_inactive=1');
    state.adminQuestions = (r.ok && r.data.items) || [];
    renderAdminQuestions();
  }

  function resetTemplateForm() {
    state.selectedQuestionTemplateId = '';
    if ($('qt-code')) $('qt-code').value = '';
    if ($('qt-name')) $('qt-name').value = '';
    if ($('qt-description')) $('qt-description').value = '';
    if ($('qt-active')) $('qt-active').checked = true;
  }

  function resetQuestionForm() {
    state.editingQuestionId = null;
    if ($('question-facility')) $('question-facility').value = 'ALL';
    if ($('question-scale')) $('question-scale').value = 'ALL';
    if ($('question-category')) $('question-category').value = '';
    if ($('question-code')) $('question-code').value = '';
    if ($('question-order')) $('question-order').value = '1';
    if ($('question-text')) $('question-text').value = '';
    if ($('question-elimination')) $('question-elimination').checked = false;
    if ($('question-critical')) $('question-critical').checked = false;
    if ($('question-attachment')) $('question-attachment').checked = false;
    if ($('question-active')) $('question-active').checked = true;
    syncQuestionEvidenceControl();
  }

  function syncQuestionEvidenceControl() {
    const elimination = $('question-elimination');
    const attachment = $('question-attachment');
    if (!elimination || !attachment) return;
    if (elimination.checked) attachment.checked = false;
    attachment.disabled = elimination.checked;
  }

  function fillTemplateForm(template) {
    state.selectedQuestionTemplateId = String(template.id);
    $('qt-code').value = template.template_code || '';
    $('qt-name').value = template.template_name || '';
    $('qt-description').value = template.description || '';
    $('qt-active').checked = !!template.active;
    if ($('question-template-select')) $('question-template-select').value = state.selectedQuestionTemplateId;
  }

  function fillQuestionForm(q) {
    state.editingQuestionId = q.id;
    $('question-facility').value = q.facility_type || 'ALL';
    $('question-scale').value = q.supplier_scale || 'ALL';
    $('question-category').value = q.category || '';
    $('question-code').value = q.question_code || '';
    $('question-order').value = q.order_index || 0;
    $('question-text').value = q.question_text || '';
    $('question-elimination').checked = !!q.is_elimination_clause;
    $('question-critical').checked = !!q.is_critical_clause;
    $('question-attachment').checked = !!q.requires_attachment;
    $('question-active').checked = !!q.active;
    syncQuestionEvidenceControl();
  }

  function renderQuestionTemplates() {
    const tbody = $('question-template-tbody');
    if (!tbody) return;
    tbody.textContent = '';
    const select = $('question-template-select');
    if (select) {
      select.textContent = '';
      state.questionTemplates.forEach((t) => select.appendChild(el('option', { attrs: { value: String(t.id) }, text: `${t.template_code} · ${t.template_name}` })));
      if (state.selectedQuestionTemplateId) select.value = state.selectedQuestionTemplateId;
    }
    state.questionTemplates.forEach((t) => {
      const tr = el('tr');
      tr.appendChild(el('td', { className: 'mono', text: t.template_code }));
      tr.appendChild(el('td', { text: t.template_name }));
      const active = el('td');
      active.appendChild(el('span', { className: 'tag sev-' + (t.active ? 'green' : 'gray'), text: statusText(t.active ? 'ACTIVE' : 'INACTIVE') }));
      tr.appendChild(active);
      const action = el('td', { className: 'table-action-cell text-right' });
      action.appendChild(RowActionGroup([
        actionDescriptor('question_template.edit', async () => { fillTemplateForm(t); await loadAdminQuestions(); }),
      ]));
      tr.appendChild(action);
      tbody.appendChild(tr);
    });
  }

  function renderAdminQuestions() {
    const tbody = $('question-tbody');
    if (!tbody) return;
    tbody.textContent = '';
    if (!state.selectedQuestionTemplateId) {
      const tr = el('tr');
      tr.appendChild(el('td', { className: 'muted', attrs: { colspan: 9 }, text: UI_TEXT.admin.noTemplateSelected }));
      tbody.appendChild(tr);
      return;
    }
    if (state.adminQuestions.length === 0) {
      const tr = el('tr');
      tr.appendChild(el('td', { className: 'muted', attrs: { colspan: 9 }, text: UI_TEXT.admin.noQuestionsForTemplate }));
      tbody.appendChild(tr);
      return;
    }
    state.adminQuestions.forEach((q) => {
      const tr = el('tr');
      tr.appendChild(el('td', { className: 'mono muted', text: `${q.facility_type} / ${q.supplier_scale}` }));
      tr.appendChild(el('td', { className: 'mono', text: q.question_code }));
      tr.appendChild(el('td', { text: q.category }));
      tr.appendChild(el('td', { text: q.question_text }));
      tr.appendChild(el('td', { text: q.is_elimination_clause ? 'Loại' : (q.is_critical_clause ? 'Chính yếu' : 'Thường') }));
      tr.appendChild(el('td', { className: 'mono', text: q.allowed_scores }));
      tr.appendChild(el('td', { text: q.requires_attachment ? 'Có' : 'Không' }));
      const active = el('td');
      active.appendChild(el('span', { className: 'tag sev-' + (q.active ? 'green' : 'gray'), text: statusText(q.active ? 'ACTIVE' : 'INACTIVE') }));
      tr.appendChild(active);
      const action = el('td', { className: 'table-action-cell text-right' });
      action.appendChild(RowActionGroup([
        actionDescriptor('question.edit', () => fillQuestionForm(q)),
        q.active ? actionDescriptor('question.deactivate', () => deactivateQuestion(q.id), null, { confirm: false, objectIdentity: q.question_code }) : null,
      ]));
      tr.appendChild(action);
      tbody.appendChild(tr);
    });
  }

  async function saveQuestionTemplate() {
    const finishButton = setButtonLoading($('btn-save-template'), 'Đang lưu biểu mẫu...');
    const body = {
      template_code: $('qt-code').value.trim(),
      template_name: $('qt-name').value.trim(),
      description: $('qt-description').value.trim(),
      active: $('qt-active').checked,
    };
    const editing = !!state.selectedQuestionTemplateId && state.questionTemplates.some((t) => String(t.id) === state.selectedQuestionTemplateId);
    const path = editing ? '/question-templates/' + encodeURIComponent(state.selectedQuestionTemplateId) : '/question-templates';
    const r = await api(path, { method: editing ? 'PUT' : 'POST', body });
    if (!r.ok) {
      finishButton();
      return setMsg('question-admin-msg', UI_TEXT.admin.saveTemplateFailed, 'err');
    }
    state.selectedQuestionTemplateId = String(r.data.item.id);
    finishButton('Đã lưu ✓');
    setMsg('question-admin-msg', UI_TEXT.admin.templateSaved, 'ok');
    await loadQuestionAdmin();
  }

  async function saveQuestion() {
    if (!state.selectedQuestionTemplateId) return setMsg('question-admin-msg', UI_TEXT.admin.chooseTemplate, 'err');
    const finishButton = setButtonLoading($('btn-save-question'), 'Đang lưu câu hỏi...');
    const elimination = $('question-elimination').checked;
    const body = {
      facility_type: $('question-facility').value.trim() || 'ALL',
      supplier_scale: $('question-scale').value,
      category: $('question-category').value.trim(),
      question_code: $('question-code').value.trim(),
      question_text: $('question-text').value.trim(),
      is_elimination_clause: elimination,
      is_critical_clause: $('question-critical').checked,
      requires_attachment: elimination ? false : $('question-attachment').checked,
      allowed_scores: elimination ? 'A/D/NA' : 'A/B/C/D/NA',
      order_index: parseInt($('question-order').value || '0', 10),
      active: $('question-active').checked,
    };
    const base = '/question-templates/' + encodeURIComponent(state.selectedQuestionTemplateId) + '/questions';
    const path = state.editingQuestionId ? base + '/' + encodeURIComponent(state.editingQuestionId) : base;
    const r = await api(path, { method: state.editingQuestionId ? 'PUT' : 'POST', body });
    if (!r.ok) {
      finishButton();
      return setMsg('question-admin-msg', 'Không lưu được câu hỏi.', 'err');
    }
    resetQuestionForm();
    finishButton('Đã lưu ✓');
    setMsg('question-admin-msg', 'Đã lưu câu hỏi.', 'ok');
    await loadAdminQuestions();
    await loadWorkflowData(true);
  }

  async function deactivateQuestion(id) {
    const confirmed = await confirmAction({
      title: 'Tắt câu hỏi?',
      message: 'Câu hỏi này sẽ không còn dùng cho các phiếu đánh giá mới.',
      cancelLabel: 'Giữ câu hỏi hoạt động',
      confirmLabel: 'Tắt câu hỏi',
      destructive: true,
    });
    if (!confirmed) return;
    const r = await api('/question-templates/' + encodeURIComponent(state.selectedQuestionTemplateId) + '/questions/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!r.ok) return setMsg('question-admin-msg', 'Không tắt được câu hỏi.', 'err');
    setMsg('question-admin-msg', 'Đã tắt câu hỏi.', 'ok');
    await loadAdminQuestions();
    await loadWorkflowData(true);
  }

  const QUESTION_WORKSPACE_TABS = ['questions', 'variants', 'scopes', 'versions'];
  const QUESTION_WORKSPACE_TAB_ALIASES = { overview: 'questions', imports: 'versions' };
  const questionExpandedGroupKeys = new Set();
  let questionEditorGroup = null;

  function canonicalQuestionWorkspaceTab(tab) {
    return QUESTION_WORKSPACE_TABS.includes(tab) ? tab : (QUESTION_WORKSPACE_TAB_ALIASES[tab] || 'questions');
  }

  function questionWorkspaceParams() {
    const raw = routePathFromHash();
    const query = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '';
    return new URLSearchParams(query);
  }

  function hydrateQuestionWorkspaceFromUrl() {
    const params = questionWorkspaceParams();
    if (params.get('template')) state.selectedQuestionTemplateId = params.get('template');
    if (params.get('version')) state.selectedQuestionVersionId = params.get('version');
    state.questionWorkspaceTab = canonicalQuestionWorkspaceTab(params.get('tab'));
  }

  function syncQuestionWorkspaceUrl({ replace = false } = {}) {
    if (state.tab !== 'admin-question-templates') return;
    const params = new URLSearchParams();
    if (state.selectedQuestionTemplateId) params.set('template', state.selectedQuestionTemplateId);
    if (state.selectedQuestionVersionId) params.set('version', state.selectedQuestionVersionId);
    params.set('tab', canonicalQuestionWorkspaceTab(state.questionWorkspaceTab));
    const next = `#/admin/question-templates?${params.toString()}`;
    if (window.location.hash === next.slice(1)) return;
    if (replace) window.history.replaceState(null, '', next);
    else window.location.hash = next.slice(1);
  }

  function showQuestionWorkspaceState(status, message = '') {
    const host = $('question-catalog-state');
    if (!host) return;
    host.dataset.state = status;
    host.textContent = message;
  }

  function selectedQuestionTemplate() {
    return (state.questionTemplates || []).find((item) => String(item.id) === String(state.selectedQuestionTemplateId)) || null;
  }

  function isQuestionVersionEditable(version = selectedQuestionVersion()) {
    return Boolean(version && version.status === 'DRAFT' && (version.allowed_actions || []).includes('question_version.save_draft'));
  }

  function questionVersionAllows(actionId, version = selectedQuestionVersion()) {
    return Boolean(version && Array.isArray(version.allowed_actions) && version.allowed_actions.includes(actionId));
  }

  function markQuestionWorkspaceDirty(dirty = true) {
    state.questionWorkspaceDirty = dirty;
    const indicator = $('question-unsaved-indicator');
    if (indicator) indicator.textContent = dirty ? 'Có thay đổi chưa lưu' : '';
    syncGuidedWorkspace('question-templates', dirty ? 3 : state.selectedQuestionTemplateId ? 2 : 1);
  }

  function confirmQuestionWorkspaceDiscard() {
    return confirmBusinessConfigRouteLeave(window.location.hash);
  }

  function catalogQuery() {
    const params = new URLSearchParams({ include_inactive: '1' });
    const values = {
      search: $('question-catalog-search')?.value.trim(),
      status: $('question-catalog-status')?.value,
      facility_type: $('question-catalog-facility')?.value.trim(),
      supplier_scale: $('question-catalog-scale')?.value,
    };
    Object.entries(values).forEach(([key, value]) => { if (value) params.set(key, value); });
    return params.toString();
  }

  async function loadQuestionWorkspace() {
    const root = $('question-management-workspace-root');
    if (!root) return;
    root.closest('.panel')?.classList.add('question-workspace-panel');
    hydrateQuestionWorkspaceFromUrl();
    state.questionWorkspaceLoading = true;
    state.questionWorkspaceError = '';
    showQuestionWorkspaceState('loading', 'Đang tải danh mục bộ câu hỏi…');
    const response = await api('/question-templates?' + catalogQuery());
    state.questionWorkspaceLoading = false;
    if (!response.ok) {
      state.questionWorkspaceError = response.data?.error || 'question_catalog_failed';
      showQuestionWorkspaceState(response.status === 403 ? 'denied' : 'error', response.status === 403
        ? 'Bạn không có quyền quản lý bộ câu hỏi.'
        : `Không tải được danh mục. Request ${response.requestId || '—'}`);
      state.questionTemplates = [];
      renderQuestionCatalog();
      return;
    }
    state.questionTemplates = response.data.items || [];
    if (!state.questionTemplates.some((item) => String(item.id) === String(state.selectedQuestionTemplateId))) {
      state.selectedQuestionTemplateId = String(state.questionTemplates[0]?.id || '');
      state.selectedQuestionVersionId = '';
    }
    showQuestionWorkspaceState('ready');
    renderQuestionCatalog();
    if (state.selectedQuestionTemplateId) await loadQuestionWorkspaceVersion();
    else renderQuestionWorkspace();
    syncQuestionWorkspaceUrl({ replace: true });
  }

  async function loadQuestionWorkspaceVersion() {
    if (!state.selectedQuestionTemplateId) return;
    showQuestionWorkspaceState('loading', 'Đang tải phiên bản và tác động…');
    const versionsResponse = await api('/question-templates/' + encodeURIComponent(state.selectedQuestionTemplateId) + '/versions');
    if (!versionsResponse.ok) {
      showQuestionWorkspaceState('error', `Không tải được phiên bản. Request ${versionsResponse.requestId || '—'}`);
      return;
    }
    state.questionVersions = versionsResponse.data.items || [];
    if (!state.questionVersions.some((version) => String(version.id) === String(state.selectedQuestionVersionId))) {
      const catalogVersion = selectedQuestionTemplate()?.current_version;
      state.selectedQuestionVersionId = String(catalogVersion?.id || state.questionVersions[0]?.id || '');
    }
    const version = selectedQuestionVersion();
    if (!version) {
      state.questionVersionDetail = null;
      renderQuestionWorkspace();
      return;
    }
    const prior = state.questionVersions.find((item) => Number(item.version_no) < Number(version.version_no));
    const base = '/question-templates/' + encodeURIComponent(state.selectedQuestionTemplateId) + '/versions/' + encodeURIComponent(version.id);
    const [detailResponse, impactResponse, validationResponse, historyResponse, diffResponse] = await Promise.all([
      api(base),
      api(base + '/impact'),
      api(base + '/validate'),
      api(base + '/imports'),
      prior ? api(base + '/diff?against=' + encodeURIComponent(prior.id)) : Promise.resolve({ ok: true, data: { item: null } }),
    ]);
    if (!detailResponse.ok) {
      showQuestionWorkspaceState('error', `Không tải được nội dung phiên bản. Request ${detailResponse.requestId || '—'}`);
      return;
    }
    state.questionVersionDetail = detailResponse.data.item;
    const listIndex = state.questionVersions.findIndex((item) => String(item.id) === String(version.id));
    if (listIndex >= 0) state.questionVersions[listIndex] = { ...state.questionVersions[listIndex], ...detailResponse.data.item };
    state.questionVersionImpact = impactResponse.ok ? impactResponse.data.item : null;
    state.questionVersionValidation = validationResponse.ok ? validationResponse.data.item : null;
    if ($('question-validation-summary')) {
      $('question-validation-summary').textContent = '';
      $('question-validation-summary').classList.add('hidden');
      $('question-validation-summary').classList.remove('is-valid');
    }
    state.questionImportHistory = historyResponse.ok ? (historyResponse.data.items || []) : [];
    state.questionVersionDiff = diffResponse.ok ? diffResponse.data.item : null;
    state.adminQuestions = state.questionVersionDetail.items || [];
    state.questionSelectedItemIds = [];
    markQuestionWorkspaceDirty(false);
    showQuestionWorkspaceState('ready');
    renderQuestionCatalog();
    renderQuestionWorkspace();
    syncQuestionWorkspaceUrl({ replace: true });
  }

  function renderQuestionCatalog() {
    const tbody = $('question-catalog-list');
    if (!tbody) return;
    tbody.textContent = '';
    const empty = $('question-catalog-empty');
    empty?.classList.toggle('hidden', state.questionTemplates.length > 0);
    if ($('question-catalog-count')) $('question-catalog-count').textContent = String(state.questionTemplates.length);
    state.questionTemplates.forEach((template) => {
      const version = template.current_version;
      const tr = el('tr', { attrs: { 'aria-current': String(template.id) === String(state.selectedQuestionTemplateId) ? 'true' : 'false' } });
      const identity = el('td');
      const button = el('button', { attrs: { type: 'button', 'data-action-id': 'question_template.edit', 'aria-label': `Mở ${template.template_code} ${template.template_name}` } });
      button.appendChild(el('span', { className: 'question-catalog-code mono', text: template.template_code }));
      button.appendChild(el('span', { className: 'question-catalog-name', text: template.template_name }));
      button.appendChild(el('span', { className: 'question-catalog-counts', text: `${template.question_count} câu · ${template.variant_count} biến thể · ${template.version_count} phiên bản` }));
      button.addEventListener('click', () => selectQuestionWorkspaceTemplate(template.id));
      identity.appendChild(button);
      tr.appendChild(identity);
      const versionCell = el('td');
      versionCell.appendChild(el('span', { className: 'tag sev-' + questionStatusSeverity(version?.status), text: businessVersionStatusLabel(version?.status) }));
      if (template.default_version) versionCell.appendChild(el('span', { className: 'question-catalog-counts', text: `Đang áp dụng v${template.default_version.version_no}` }));
      if (template.warnings?.length) versionCell.appendChild(el('span', { className: 'question-catalog-counts', text: `${template.warnings.length} cảnh báo` }));
      tr.appendChild(versionCell);
      const actions = el('td', { className: 'table-action-cell' });
      const openTemplate = async (tab = 'questions') => {
        await selectQuestionWorkspaceTemplate(template.id);
        setQuestionWorkspaceTab(tab);
      };
      actions.appendChild(RowActionGroup([
        actionDescriptor('question_template.edit', () => openTemplate('questions'), template, { label: 'Mở bộ câu hỏi', announceSuccess: false }),
      ], [
        actionDescriptor('question_version.clone_draft', async () => { await openTemplate('versions'); await createQuestionWorkspaceDraft(); }, template, { label: 'Tạo bản nháp', announceSuccess: false }),
        actionDescriptor('question_template.tab_open', () => openTemplate('versions'), template, { label: 'Xem lịch sử', announceSuccess: false }),
      ]));
      tr.appendChild(actions);
      tbody.appendChild(tr);
    });
  }

  function questionStatusSeverity(status) {
    return status === 'PUBLISHED' ? 'green' : status === 'IN_REVIEW' ? 'amber' : status === 'DRAFT' ? 'gray' : 'red';
  }

  async function selectQuestionWorkspaceTemplate(templateId) {
    if (String(templateId) === String(state.selectedQuestionTemplateId)) return;
    if (!confirmQuestionWorkspaceDiscard()) return;
    state.selectedQuestionTemplateId = String(templateId);
    state.selectedQuestionVersionId = '';
    state.questionImportPreview = null;
    state.questionImportStep = 'select';
    if ($('question-workspace-live')) $('question-workspace-live').textContent = '';
    syncQuestionWorkspaceUrl();
    renderQuestionCatalog();
    await loadQuestionWorkspaceVersion();
  }

  function renderQuestionWorkspace() {
    const template = selectedQuestionTemplate();
    const version = selectedQuestionVersion();
    syncGuidedWorkspace('question-templates', state.questionWorkspaceDirty ? 3 : template ? 2 : 1);
    $('question-workspace-empty')?.classList.toggle('hidden', Boolean(template && version));
    $('question-workspace-content')?.classList.toggle('hidden', !template || !version);
    if (!template || !version) return;
    if ($('question-workspace-code')) $('question-workspace-code').textContent = template.template_code;
    if ($('question-workspace-title')) $('question-workspace-title').textContent = template.template_name;
    if ($('question-workspace-meta')) $('question-workspace-meta').textContent = `${template.description || 'Không có mô tả'} · cập nhật ${template.updated_at || '—'}`;
    const versionSelect = $('question-workspace-version-select');
    if (versionSelect) {
      versionSelect.textContent = '';
      state.questionVersions.forEach((item) => versionSelect.appendChild(el('option', { attrs: { value: String(item.id) }, text: `v${item.version_no} · ${businessVersionStatusLabel(item.status)}${item.is_default ? ' · Đang áp dụng' : ''} · ${item.item_count ?? item.items?.length ?? 0} bản ghi phạm vi` })));
      versionSelect.value = state.selectedQuestionVersionId;
    }
    const chip = $('question-version-status-chip');
    if (chip) { chip.className = 'tag sev-' + questionStatusSeverity(version.status); chip.textContent = businessVersionStatusLabel(version.status); }
    renderBusinessConfigLifecycle('question-lifecycle', version);
    const editable = isQuestionVersionEditable(version);
    const readonly = $('question-published-readonly');
    if (readonly) {
      readonly.classList.toggle('hidden', editable);
      readonly.textContent = ['PUBLISHED', 'RETIRED'].includes(version.status)
        ? 'Phiên bản Published/Retired là bất biến. Tạo Draft mới để chỉnh sửa nội dung.'
        : 'Phiên bản đang Review nên chỉ đọc. Nội dung Draft đã gửi duyệt không được chỉnh sửa.';
    }
    for (const id of ['question-version-note', 'question-version-effective-from', 'question-version-effective-to']) {
      const control = $(id); if (control) control.disabled = !editable;
    }
    if ($('question-version-note')) $('question-version-note').value = state.questionVersionDetail?.version_note || '';
    if ($('question-version-effective-from')) $('question-version-effective-from').value = state.questionVersionDetail?.effective_from || '';
    if ($('question-version-effective-to')) $('question-version-effective-to').value = state.questionVersionDetail?.effective_to || '';
    renderQuestionOverview();
    renderQuestionWorkspaceTabs();
    renderVersionQuestions();
    renderQuestionVariants();
    renderQuestionScopes();
    renderQuestionWorkspaceImport();
    renderQuestionVersionsAudit();
    renderQuestionLifecycleActions();
  }

  function renderQuestionOverview() {
    const host = $('question-overview-counts');
    const template = selectedQuestionTemplate();
    const detail = state.questionVersionDetail || {};
    const impact = state.questionVersionImpact || {};
    if (host) {
      host.textContent = '';
      const validation = state.questionVersionValidation || {};
      const logicalQuestions = groupQuestionItems(detail.items || []);
      [['Câu hỏi logic', logicalQuestions.length], ['Bản ghi phạm vi', detail.items?.length || 0], ['Biến thể', detail.variants?.length || 0], ['Lỗi kiểm tra', validation.error_count || 0], ['Phạm vi áp dụng', validation.scope_count ?? impact.default_scope_count ?? 0], ['Phiếu đã pin', impact.ticket_count || 0]].forEach(([label, value]) => {
        const card = el('div', { className: 'question-overview-card admin-metric-card', attrs: { role: 'group', 'aria-label': `${label}: ${value}` } });
        card.appendChild(el('strong', { text: String(value) })); card.appendChild(el('span', { className: 'muted', text: label })); host.appendChild(card);
      });
    }
    const warningHost = $('question-overview-warnings');
    if (warningHost) {
      warningHost.textContent = '';
      (template?.warnings || []).forEach((warning) => warningHost.appendChild(el('div', { className: 'question-warning', text: questionWarningText(warning) })));
    }
  }

  function questionWarningText(code) {
    return ({ missing_version: 'Biểu mẫu chưa có phiên bản.', missing_default_published_version: 'Chưa có Published mặc định cho phiếu mới.', draft_has_no_questions: 'Draft chưa có câu hỏi.', publishing_disabled: 'Publish đang bị tắt bởi feature gate.' })[code] || code;
  }

  function renderQuestionWorkspaceTabs() {
    const active = canonicalQuestionWorkspaceTab(state.questionWorkspaceTab);
    document.querySelectorAll('[data-question-tab]').forEach((button) => {
      const selected = button.dataset.questionTab === active;
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
      button.tabIndex = selected ? 0 : -1;
    });
    document.querySelectorAll('[data-question-pane]').forEach((pane) => pane.classList.toggle('hidden', pane.dataset.questionPane !== active));
  }

  function setQuestionWorkspaceTab(tab, { focus = false } = {}) {
    const canonical = canonicalQuestionWorkspaceTab(tab);
    if (!QUESTION_WORKSPACE_TABS.includes(canonical)) return;
    state.questionWorkspaceTab = canonical;
    renderQuestionWorkspaceTabs();
    syncQuestionWorkspaceUrl();
    if (focus) document.querySelector(`[data-question-tab="${canonical}"]`)?.focus();
  }

  function filteredVersionQuestions() {
    return filterQuestionGroups(groupQuestionItems(state.questionVersionDetail?.items || []), {
      search: $('question-item-search')?.value || '',
      category: $('question-item-category')?.value || '',
      active: $('question-item-active')?.value || '',
    });
  }

  function questionFacilityLabels() {
    const labels = new Map([['ALL', 'Tất cả loại cơ sở']]);
    const templateCode = selectedQuestionTemplate()?.template_code;
    criteriaVariants().filter((variant) => !templateCode || variant.template_code === templateCode).forEach((variant) => {
      if (variant.facility_type && variant.facility_label) labels.set(variant.facility_type, variant.facility_label);
    });
    return labels;
  }

  function questionScopeSummaries(group) {
    return summarizeQuestionScopes(group?.scopes || [], { facilityLabels: questionFacilityLabels() });
  }

  function questionScaleLabel(value) {
    return ({ ALL: 'Tất cả quy mô', LARGE: 'Lớn', SMALL: 'Nhỏ' })[value] || value || '—';
  }

  function toggleQuestionGroupDetails(groupKey) {
    if (questionExpandedGroupKeys.has(groupKey)) questionExpandedGroupKeys.delete(groupKey);
    else questionExpandedGroupKeys.add(groupKey);
    renderVersionQuestions();
  }

  function renderQuestionGroupDetails(group, detailId, editable) {
    const detailRow = el('tr', { className: 'question-scope-detail-row', attrs: { id: detailId } });
    const cell = el('td', { attrs: { colspan: '9' } });
    const list = el('div', { className: 'question-scope-detail-list' });
    const facilityLabels = questionFacilityLabels();
    group.members.forEach((item) => {
      const row = el('div', { className: 'question-scope-detail-item' });
      row.appendChild(el('span', { text: facilityLabels.get(item.facility_type) || item.facility_type }));
      row.appendChild(el('span', { text: questionScaleLabel(item.supplier_scale) }));
      row.appendChild(el('span', { className: 'mono', text: item.question_code }));
      row.appendChild(el('span', { text: item.category || 'Chưa phân nhóm' }));
      row.appendChild(el('span', { className: 'mono', text: `Thứ tự ${item.order_index}` }));
      row.appendChild(el('span', { className: 'tag sev-' + (item.active ? 'green' : 'gray'), text: item.active ? 'Đang dùng' : 'Đã tắt' }));
      if (editable) row.appendChild(RowActionGroup([
        actionDescriptor('question.edit', () => openQuestionEditor(item), item, { label: `Sửa riêng ${item.facility_type} / ${item.supplier_scale}` }),
      ]));
      list.appendChild(row);
    });
    cell.appendChild(list);
    detailRow.appendChild(cell);
    return detailRow;
  }

  function renderVersionQuestions() {
    const tbody = $('question-version-tbody');
    if (!tbody) return;
    const editable = isQuestionVersionEditable();
    const categorySelect = $('question-item-category');
    if (categorySelect) {
      const current = categorySelect.value;
      const categories = [...new Set((state.questionVersionDetail?.items || []).map((item) => item.category).filter(Boolean))].sort();
      categorySelect.textContent = ''; categorySelect.appendChild(el('option', { attrs: { value: '' }, text: 'Tất cả nhóm' }));
      categories.forEach((category) => categorySelect.appendChild(el('option', { attrs: { value: category }, text: category })));
      categorySelect.value = categories.includes(current) ? current : '';
    }
    const rows = filteredVersionQuestions();
    tbody.textContent = '';
    $('question-items-empty')?.classList.toggle('hidden', rows.length > 0);
    rows.forEach((group, index) => {
      const tr = el('tr');
      const choose = el('td');
      if (editable) {
        const checkbox = el('input', { attrs: { type: 'checkbox', 'aria-label': `Chọn ${group.display_question_code || group.question_code} và ${group.physical_count} phạm vi` } });
        const selectedIds = new Set(state.questionSelectedItemIds);
        checkbox.checked = group.member_ids.every((id) => selectedIds.has(id));
        checkbox.indeterminate = !checkbox.checked && group.member_ids.some((id) => selectedIds.has(id));
        checkbox.addEventListener('change', () => toggleQuestionGroupSelection(group.member_ids, checkbox.checked));
        choose.appendChild(checkbox);
      }
      tr.appendChild(choose);
      tr.appendChild(el('td', { className: 'mono question-order-cell', text: group.common_order_index == null ? 'Theo phạm vi' : String(group.common_order_index) }));
      tr.appendChild(el('td', { className: 'mono question-code-cell', text: group.display_question_code || group.question_code }));
      const textCell = el('td', { className: 'question-text-cell' });
      textCell.appendChild(el('strong', { text: group.question_text }));
      textCell.appendChild(el('span', { className: 'muted', text: group.is_critical_clause ? 'Điều khoản quan trọng' : 'Câu hỏi đánh giá' }));
      if (group.has_scope_variance) textCell.appendChild(el('span', { className: 'question-scope-warning', text: 'Nội dung khác theo phạm vi' }));
      tr.appendChild(textCell);
      const scopeCell = el('td', { className: 'question-scope-cell' });
      questionScopeSummaries(group).forEach((scope) => scopeCell.appendChild(el('span', { className: 'question-scope-chip', text: scope.label })));
      const detailId = `question-scope-detail-${index}`;
      const expanded = questionExpandedGroupKeys.has(group.key);
      const detailButton = el('button', { className: 'question-scope-toggle', text: `${group.physical_count} phạm vi`, attrs: { type: 'button', 'aria-expanded': expanded ? 'true' : 'false', 'aria-controls': detailId } });
      detailButton.addEventListener('click', () => toggleQuestionGroupDetails(group.key));
      scopeCell.appendChild(detailButton);
      tr.appendChild(scopeCell);
      const categoryCell = el('td'); categoryCell.appendChild(el('span', { className: 'question-soft-chip', text: group.display_category || group.category || 'Chưa phân nhóm' })); tr.appendChild(categoryCell);
      const answerCell = el('td'); answerCell.appendChild(el('span', { className: 'question-soft-chip', text: group.is_elimination_clause ? 'Đạt / Không đạt / NA' : (group.allowed_scores || '—') })); tr.appendChild(answerCell);
      const active = el('td'); active.appendChild(el('span', { className: 'tag sev-' + (group.active ? 'green' : 'gray'), text: group.active ? 'Đang dùng' : 'Đã tắt' })); tr.appendChild(active);
      const actions = el('td', { className: 'table-action-cell' });
      if (editable) {
        actions.appendChild(RowActionGroup([
          actionDescriptor('question.edit', () => openQuestionGroupEditor(group), group, { label: `Sửa nội dung chung ${group.display_question_code || group.question_code}` }),
        ]));
      } else actions.appendChild(RowActionGroup([]));
      tr.appendChild(actions); tbody.appendChild(tr);
      if (expanded) tbody.appendChild(renderQuestionGroupDetails(group, detailId, editable));
    });
    $('question-add-item')?.classList.toggle('hidden', !editable);
    $('question-bulk-deactivate')?.classList.toggle('hidden', !editable);
    if ($('question-bulk-deactivate')) $('question-bulk-deactivate').disabled = state.questionSelectedItemIds.length === 0;
  }

  function toggleQuestionGroupSelection(ids, checked) {
    const selected = new Set(state.questionSelectedItemIds);
    (ids || []).forEach((id) => { const key = String(id); if (checked) selected.add(key); else selected.delete(key); });
    state.questionSelectedItemIds = [...selected];
    if ($('question-bulk-deactivate')) $('question-bulk-deactivate').disabled = selected.size === 0;
  }

  async function saveQuestionVersionItems(items, successMessage) {
    const version = selectedQuestionVersion();
    if (!isQuestionVersionEditable(version)) return false;
    const patchFields = [
      'variant_code', 'facility_type', 'supplier_scale', 'category_code', 'question_code', 'clause_code',
      'question_text', 'category', 'is_elimination_clause', 'is_critical_clause', 'requires_attachment',
      'allowed_scores', 'weight', 'order_index', 'active',
    ];
    const currentById = new Map((state.questionVersionDetail?.items || []).map((item) => [String(item.id), item]));
    const updates = [];
    const additions = [];
    (items || []).forEach((item) => {
      const existing = item.id == null ? null : currentById.get(String(item.id));
      if (!existing) {
        additions.push(Object.fromEntries(patchFields.filter((field) => Object.prototype.hasOwnProperty.call(item, field)).map((field) => [field, item[field]])));
        return;
      }
      const delta = { id: item.id };
      patchFields.forEach((field) => {
        if (String(existing[field] ?? '') !== String(item[field] ?? '')) delta[field] = item[field];
      });
      if (Object.keys(delta).length > 1) updates.push(delta);
    });
    if (!updates.length && !additions.length) return true;
    const response = await api('/question-templates/' + encodeURIComponent(state.selectedQuestionTemplateId) + '/versions/' + encodeURIComponent(version.id) + '/items', {
      method: 'PATCH', body: { expected_lock_version: version.lock_version, updates, additions },
    });
    if (!response.ok) {
      const errors = response.data?.error === 'question_version_conflict'
        ? [`Phiên bản đã được người khác cập nhật. Lock hiện tại: ${response.data.current_lock_version ?? '—'}. Dữ liệu đang nhập vẫn được giữ.`]
        : [`Không lưu được Draft: ${response.data?.error || 'unknown'} · Request ${response.requestId || '—'}`];
      focusQuestionValidationSummary(errors);
      return false;
    }
    state.selectedQuestionVersionId = String(response.data.item.id);
    markQuestionWorkspaceDirty(false);
    if ($('question-workspace-live')) $('question-workspace-live').textContent = successMessage;
    await loadQuestionWorkspaceVersion();
    return true;
  }

  async function reorderQuestionItem(itemId, direction) {
    const items = (state.questionVersionDetail?.items || []).map((item) => ({ ...item }));
    const ordered = items.slice().sort((left, right) => Number(left.order_index) - Number(right.order_index));
    const index = ordered.findIndex((item) => String(item.id) === String(itemId));
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ordered.length) return;
    [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
    ordered.forEach((item, order) => { item.order_index = order + 1; });
    await saveQuestionVersionItems(ordered, 'Đã cập nhật thứ tự câu hỏi trong Draft.');
  }

  async function bulkDeactivateQuestionItems() {
    if (!state.questionSelectedItemIds.length) return;
    const selected = new Set(state.questionSelectedItemIds);
    const items = (state.questionVersionDetail?.items || []).map((item) => selected.has(String(item.id)) ? { ...item, active: 0 } : item);
    const saved = await saveQuestionVersionItems(items, 'Đã tắt các câu hỏi đã chọn trong Draft.');
    if (saved) state.questionSelectedItemIds = [];
  }

  function resetQuestionEditor() {
    state.questionEditorItemId = null;
    questionEditorGroup = null;
    const values = { 'question-editor-facility': 'ALL', 'question-editor-scale': 'ALL', 'question-editor-variant': '', 'question-editor-category-code': '', 'question-editor-category': '', 'question-editor-code': '', 'question-editor-clause': '', 'question-editor-order': String((state.questionVersionDetail?.items?.length || 0) + 1), 'question-editor-text': '', 'question-editor-scores': 'A/B/C/D/NA', 'question-editor-weight': '1' };
    Object.entries(values).forEach(([id, value]) => { if ($(id)) $(id).value = value; });
    for (const id of ['question-editor-facility', 'question-editor-scale', 'question-editor-variant', 'question-editor-order', 'question-editor-code', 'question-editor-category-code', 'question-editor-category']) if ($(id)) $(id).disabled = false;
    for (const id of ['question-editor-elimination', 'question-editor-critical', 'question-editor-evidence']) if ($(id)) $(id).checked = false;
    if ($('question-editor-active')) $('question-editor-active').checked = true;
    $('question-editor-scope-summary')?.classList.add('hidden');
    if ($('question-editor-scope-list')) $('question-editor-scope-list').textContent = '';
  }

  function fillQuestionEditor(item) {
    state.questionEditorItemId = item.id;
    const values = { 'question-editor-facility': item.facility_type, 'question-editor-scale': item.supplier_scale, 'question-editor-variant': item.variant_code || '', 'question-editor-category-code': item.category_code || '', 'question-editor-category': item.category, 'question-editor-code': item.question_code, 'question-editor-clause': item.clause_code || '', 'question-editor-order': item.order_index, 'question-editor-text': item.question_text, 'question-editor-scores': item.allowed_scores, 'question-editor-weight': item.weight };
    Object.entries(values).forEach(([id, value]) => { if ($(id)) $(id).value = value ?? ''; });
    $('question-editor-elimination').checked = !!item.is_elimination_clause;
    $('question-editor-critical').checked = !!item.is_critical_clause;
    $('question-editor-evidence').checked = !!item.requires_attachment;
    $('question-editor-active').checked = !!item.active;
  }

  function openQuestionEditor(item = null, returnFocus = null) {
    if (!isQuestionVersionEditable()) return;
    resetQuestionEditor();
    state.questionEditorReturnFocus = returnFocus || document.activeElement;
    if (item) {
      fillQuestionEditor(item);
      $('question-editor-scope-list')?.appendChild(el('span', { className: 'question-scope-chip', text: `${item.facility_type || 'ALL'} · ${item.supplier_scale || 'ALL'}` }));
      $('question-editor-scope-summary')?.classList.remove('hidden');
    }
    if ($('question-editor-subtitle')) $('question-editor-subtitle').textContent = item ? `Chỉnh sửa ${item.question_code}` : 'Thêm câu hỏi mới vào Draft';
    $('question-editor-drawer')?.classList.remove('hidden');
    $('question-editor-code')?.focus();
  }

  function openQuestionGroupEditor(group, returnFocus = null) {
    if (!isQuestionVersionEditable() || !group?.members?.length) return;
    resetQuestionEditor();
    questionEditorGroup = group;
    state.questionEditorReturnFocus = returnFocus || document.activeElement;
    fillQuestionEditor(group.representative);
    for (const id of ['question-editor-facility', 'question-editor-scale', 'question-editor-variant', 'question-editor-order']) if ($(id)) $(id).disabled = true;
    if ($('question-editor-code')) $('question-editor-code').disabled = !!group.has_question_code_variance;
    for (const id of ['question-editor-category-code', 'question-editor-category']) if ($(id)) $(id).disabled = !!group.has_category_variance;
    const scopeList = $('question-editor-scope-list');
    if (scopeList) questionScopeSummaries(group).forEach((scope) => scopeList.appendChild(el('span', { className: 'question-scope-chip', text: scope.label })));
    $('question-editor-scope-summary')?.classList.remove('hidden');
    if ($('question-editor-subtitle')) $('question-editor-subtitle').textContent = `Sửa nội dung chung ${group.display_question_code || group.question_code} · ${group.physical_count} phạm vi`;
    $('question-editor-drawer')?.classList.remove('hidden');
    $('question-editor-text')?.focus();
  }

  function closeQuestionEditor() {
    $('question-editor-drawer')?.classList.add('hidden');
    questionEditorGroup = null;
    const target = state.questionEditorReturnFocus;
    state.questionEditorReturnFocus = null;
    if (target && document.contains(target)) target.focus();
  }

  function focusQuestionValidationSummary(errors) {
    const summary = $('question-validation-summary');
    if (!summary) return;
    summary.textContent = '';
    summary.appendChild(el('strong', { text: 'Cần kiểm tra trước khi lưu:' }));
    const list = el('ul'); (errors || []).forEach((error) => list.appendChild(el('li', { text: error }))); summary.appendChild(list);
    summary.classList.remove('hidden', 'is-valid'); summary.focus();
  }

  async function saveQuestionEditorItem() {
    const existing = (state.questionVersionDetail?.items || []).find((item) => String(item.id) === String(state.questionEditorItemId));
    const editingGroup = questionEditorGroup;
    const elimination = $('question-editor-elimination').checked;
    const item = {
      ...(existing || {}),
      facility_type: $('question-editor-facility').value.trim(), supplier_scale: $('question-editor-scale').value,
      variant_code: $('question-editor-variant').value.trim() || null, category_code: $('question-editor-category-code').value.trim() || null,
      category: $('question-editor-category').value.trim(), question_code: $('question-editor-code').value.trim(), clause_code: $('question-editor-clause').value.trim() || null,
      order_index: Number.parseInt($('question-editor-order').value, 10), question_text: $('question-editor-text').value.trim(),
      allowed_scores: elimination ? 'A/D/NA' : $('question-editor-scores').value.trim(), weight: Number($('question-editor-weight').value),
      is_elimination_clause: elimination ? 1 : 0, is_critical_clause: $('question-editor-critical').checked ? 1 : 0,
      requires_attachment: !elimination && $('question-editor-evidence').checked ? 1 : 0, active: $('question-editor-active').checked ? 1 : 0,
    };
    const errors = [];
    if (!editingGroup && !item.facility_type) errors.push('Loại cơ sở là bắt buộc.');
    if (!item.category) errors.push('Nhóm câu hỏi là bắt buộc.');
    if (!item.question_code) errors.push('Mã câu hỏi là bắt buộc.');
    if (!item.question_text) errors.push('Nội dung câu hỏi là bắt buộc.');
    if (!/^(?:A|B|C|D|NA)(?:\/(?:A|B|C|D|NA))*$/.test(item.allowed_scores)) errors.push('Điểm cho phép không hợp lệ.');
    if (!Number.isFinite(item.weight) || item.weight < 0) errors.push('Trọng số phải là số không âm.');
    if (!Number.isInteger(item.order_index) || item.order_index < 0) errors.push('Thứ tự phải là số nguyên không âm.');
    const duplicate = editingGroup ? null : (state.questionVersionDetail?.items || []).find((candidate) => String(candidate.id) !== String(existing?.id) && candidate.facility_type === item.facility_type && candidate.supplier_scale === item.supplier_scale && candidate.question_code === item.question_code);
    if (duplicate) errors.push('Mã câu hỏi đã tồn tại trong cùng facility/scale.');
    if (errors.length) { focusQuestionValidationSummary(errors); return; }
    const items = (state.questionVersionDetail?.items || []).map((candidate) => ({ ...candidate }));
    if (editingGroup) {
      const updates = new Map(buildSharedQuestionUpdates(editingGroup, item).map((update) => [String(update.id), update]));
      items.forEach((candidate, index) => { const update = updates.get(String(candidate.id)); if (update) items[index] = { ...candidate, ...update }; });
    } else if (existing) items[items.findIndex((candidate) => String(candidate.id) === String(existing.id))] = item;
    else items.push(item);
    const saved = await saveQuestionVersionItems(items, editingGroup ? `Đã cập nhật ${editingGroup.physical_count} phạm vi của câu hỏi logic.` : existing ? 'Đã lưu câu hỏi trong bản nháp.' : 'Đã thêm câu hỏi vào bản nháp.');
    if (saved) closeQuestionEditor();
  }

  function renderQuestionVariants() {
    const tbody = $('question-variant-tbody'); if (!tbody) return; tbody.textContent = '';
    const items = state.questionVersionDetail?.items || [];
    (state.questionVersionDetail?.variants || []).forEach((variant) => {
      const tr = el('tr');
      tr.appendChild(el('td', { className: 'mono', text: variant.facility_type })); tr.appendChild(el('td', { className: 'mono', text: variant.supplier_scale }));
      tr.appendChild(el('td', { text: variant.source_sheet || 'Draft editor' })); tr.appendChild(el('td', { text: variant.active ? 'Đang dùng' : 'Đã tắt' }));
      tr.appendChild(el('td', { text: String(items.filter((item) => item.facility_type === variant.facility_type && item.supplier_scale === variant.supplier_scale).length) })); tbody.appendChild(tr);
    });
  }

  function renderQuestionScopes() {
    const tbody = $('question-scope-tbody');
    if (!tbody) return;
    tbody.textContent = '';
    const assignments = state.questionVersionDetail?.assignments || [];
    assignments.forEach((assignment) => {
      const tr = el('tr');
      tr.appendChild(el('td', { className: 'mono', text: assignment.facility_type }));
      tr.appendChild(el('td', { className: 'mono', text: assignment.supplier_scale }));
      tr.appendChild(el('td', { text: `${assignment.effective_from || 'Không giới hạn'} → ${assignment.effective_to || 'Không giới hạn'}` }));
      const defaultCell = el('td');
      defaultCell.appendChild(el('span', { className: 'tag sev-' + (assignment.is_default ? 'green' : 'gray'), text: assignment.is_default ? 'Mặc định' : 'Không' }));
      tr.appendChild(defaultCell);
      tr.appendChild(el('td', { text: assignment.active ? 'Đang áp dụng' : 'Đã tắt' }));
      tbody.appendChild(tr);
    });
    if (!assignments.length) {
      const tr = el('tr');
      tr.appendChild(el('td', { className: 'muted', attrs: { colspan: '5' }, text: 'Version này chưa có phạm vi mặc định. Publish/Rollback mới thay đổi phạm vi cho phiếu mới.' }));
      tbody.appendChild(tr);
    }
  }

  function openQuestionPreview() {
    const version = selectedQuestionVersion();
    const detail = state.questionVersionDetail;
    if (!version || !detail || !questionVersionAllows('question_version.preview', version)) return;
    state.questionPreviewReturnFocus = document.activeElement;
    if ($('question-preview-meta')) $('question-preview-meta').textContent = `${detail.template_code} · v${detail.version_no} · ${detail.status} · ${detail.items.length} câu hỏi`;
    const tbody = $('question-preview-tbody');
    if (tbody) {
      tbody.textContent = '';
      detail.items.slice().sort((left, right) => Number(left.order_index) - Number(right.order_index)).forEach((item) => {
        const tr = el('tr');
        tr.appendChild(el('td', { className: 'mono', text: String(item.order_index) }));
        tr.appendChild(el('td', { className: 'mono', text: item.question_code }));
        tr.appendChild(el('td', { text: item.category }));
        tr.appendChild(el('td', { text: item.question_text }));
        tr.appendChild(el('td', { className: 'mono', text: item.is_elimination_clause ? 'Đạt / Không đạt / NA' : (item.allowed_scores || '—') }));
        tr.appendChild(el('td', { className: 'mono', text: `${item.facility_type} / ${item.supplier_scale}` }));
        tbody.appendChild(tr);
      });
    }
    $('question-preview-dialog')?.classList.remove('hidden');
    $('question-preview-close')?.focus();
  }

  function closeQuestionPreview() {
    $('question-preview-dialog')?.classList.add('hidden');
    const target = state.questionPreviewReturnFocus;
    state.questionPreviewReturnFocus = null;
    if (target && document.contains(target)) target.focus();
  }

  function questionValidationText(code) {
    return ({
      question_items_required: 'Phiên bản chưa có câu hỏi.',
      facility_type_required: 'Có câu hỏi thiếu loại cơ sở.',
      supplier_scale_invalid: 'Có câu hỏi dùng quy mô NCC không hợp lệ.',
      question_code_required: 'Có câu hỏi thiếu mã ổn định.',
      question_text_required: 'Có câu hỏi thiếu nội dung.',
      category_required: 'Có câu hỏi thiếu nhóm.',
      allowed_scores_invalid: 'Có câu hỏi dùng loại trả lời/điểm không hợp lệ.',
      elimination_allowed_scores_must_be_a_d_na: 'Điều khoản loại phải dùng Đạt / Không đạt / NA.',
      question_item_duplicate: 'Có mã câu hỏi trùng trong cùng facility/scale.',
      effective_window_invalid: 'Khoảng thời gian hiệu lực không hợp lệ.',
    })[code] || code;
  }

  async function runQuestionVersionValidation() {
    const version = selectedQuestionVersion();
    if (!version || !questionVersionAllows('question_version.validate', version)) return;
    const base = '/question-templates/' + encodeURIComponent(state.selectedQuestionTemplateId) + '/versions/' + encodeURIComponent(version.id);
    const response = await api(base + '/validate');
    if (!response.ok) {
      focusQuestionValidationSummary([`Không kiểm tra được version: ${response.data?.error || 'unknown'} · Request ${response.requestId || '—'}`]);
      return;
    }
    state.questionVersionValidation = response.data.item;
    renderQuestionOverview();
    if (!state.questionVersionValidation.valid) {
      focusQuestionValidationSummary(state.questionVersionValidation.errors.map(questionValidationText));
      return;
    }
    const summary = $('question-validation-summary');
    if (summary) {
      summary.textContent = `Kiểm tra hợp lệ: ${state.questionVersionValidation.active_item_count} câu đang dùng, ${state.questionVersionValidation.variant_count} biến thể, ${state.questionVersionValidation.scope_count} phạm vi.`;
      summary.classList.remove('hidden');
      summary.classList.add('is-valid');
      summary.focus();
    }
    if ($('question-workspace-live')) $('question-workspace-live').textContent = 'Version đã qua kiểm tra read-only; lifecycle không thay đổi.';
  }

  function renderQuestionLifecycleActions() {
    const version = selectedQuestionVersion(); if (!version) return;
    const actions = {
      'question-preview': 'question_version.preview',
      'question-validate': 'question_version.validate',
      'question-version-clone': 'question_version.clone_draft',
      'question-save-draft': 'question_version.save_draft',
      'question-submit-review': 'question_version.submit_review',
      'question-publish': 'question_version.publish',
    };
    Object.entries(actions).forEach(([id, actionId]) => BUSINESS_CONFIG.applyActionState($(id), version, actionId, setDisabledReason));
    const impact = state.questionVersionImpact;
    if ($('question-publish-impact')) $('question-publish-impact').textContent = impact
      ? `${impact.ticket_count} phiếu đã pin tiếp tục giữ version; Publish chỉ đổi ${impact.default_scope_count} phạm vi mặc định cho phiếu mới.`
      : 'Chưa tải được tác động publish; thao tác Publish không nên tiếp tục.';
  }

  async function saveQuestionVersionDraft() {
    const version = selectedQuestionVersion(); if (!isQuestionVersionEditable(version)) return;
    const from = $('question-version-effective-from').value || null; const to = $('question-version-effective-to').value || null;
    if (from && to && to <= from) { focusQuestionValidationSummary(['Ngày kết thúc hiệu lực phải sau ngày bắt đầu.']); return; }
    const response = await api('/question-templates/' + encodeURIComponent(state.selectedQuestionTemplateId) + '/versions/' + encodeURIComponent(version.id), { method: 'PUT', body: { expected_lock_version: version.lock_version, note: $('question-version-note').value.trim(), effective_from: from, effective_to: to } });
    if (!response.ok) {
      focusQuestionValidationSummary([response.data?.error === 'question_version_conflict' ? 'Phiên bản đã thay đổi ở nơi khác. Dữ liệu hiện tại chưa bị xóa.' : `Không lưu được Draft · Request ${response.requestId || '—'}`]); return;
    }
    markQuestionWorkspaceDirty(false); $('question-workspace-live').textContent = 'Đã lưu ghi chú và thời gian hiệu lực của Draft.'; await loadQuestionWorkspaceVersion();
  }

  async function transitionQuestionVersion(action) {
    const version = selectedQuestionVersion(); if (!version) return;
    const base = '/question-templates/' + encodeURIComponent(state.selectedQuestionTemplateId) + '/versions/' + encodeURIComponent(version.id);
    if (action === 'publish') {
      const impactResponse = await api(base + '/impact');
      if (!impactResponse.ok) {
        focusQuestionValidationSummary([`Không xác minh được tác động publish · Request ${impactResponse.requestId || '—'}. Chưa có thay đổi nào được ghi.`]);
        return;
      }
      state.questionVersionImpact = impactResponse.data.item;
      renderQuestionOverview();
      renderQuestionVersionsAudit();
      renderQuestionLifecycleActions();
    }
    const response = await api(base + '/' + action, { method: 'POST', body: { expected_lock_version: version.lock_version } });
    if (!response.ok) {
      focusQuestionValidationSummary([response.data?.error === 'question_version_conflict' ? 'Phiên bản đã được cập nhật. Hãy tải lại trước khi tiếp tục.' : `${action === 'submit' ? 'Gửi duyệt' : 'Publish'} thất bại: ${response.data?.error || 'unknown'} · Request ${response.requestId || '—'}`]); return;
    }
    $('question-workspace-live').textContent = action === 'submit' ? 'Draft đã chuyển sang Review; nội dung hiện chỉ đọc.' : 'Phiên bản đã Published và trở thành mặc định cho phạm vi phù hợp.';
    await loadQuestionWorkspace();
  }

  async function createQuestionWorkspaceDraft() {
    const version = selectedQuestionVersion(); if (!version) return;
    const response = await api('/question-templates/' + encodeURIComponent(state.selectedQuestionTemplateId) + '/versions', { method: 'POST', body: { clone_from_version_id: version.id, note: `Draft từ v${version.version_no}` } });
    if (!response.ok) { focusQuestionValidationSummary([`Không tạo được Draft · Request ${response.requestId || '—'}`]); return; }
    state.selectedQuestionVersionId = String(response.data.item.id); state.questionWorkspaceTab = 'questions'; state.questionImportPreview = null; syncQuestionWorkspaceUrl(); await loadQuestionWorkspace();
  }

  async function createQuestionWorkspaceTemplate() {
    const code = $('question-create-code').value.trim(); const name = $('question-create-name').value.trim();
    if (!code || !name) { focusQuestionValidationSummary(['Mã và tên biểu mẫu là bắt buộc.']); return; }
    const response = await api('/question-templates', { method: 'POST', body: { template_code: code, template_name: name, description: $('question-create-description').value.trim() } });
    if (!response.ok) { focusQuestionValidationSummary([`Không tạo được biểu mẫu: ${response.data?.error || 'unknown'} · Request ${response.requestId || '—'}`]); return; }
    state.selectedQuestionTemplateId = String(response.data.item.id); state.selectedQuestionVersionId = String(response.data.item.current_version.id); state.questionWorkspaceTab = 'questions';
    $('question-create-card').classList.add('hidden'); syncQuestionWorkspaceUrl(); await loadQuestionWorkspace();
  }

  function questionImportRows() {
    const order = ['ADDED', 'CHANGED', 'REMOVED', 'UNCHANGED', 'DUPLICATE', 'INVALID'];
    const rows = order.flatMap((type) => (state.questionImportPreview?.diff?.[type] || []).map((change) => ({ type, change })));
    const filter = $('question-import-error-filter')?.value || '';
    if (filter === 'errors') return rows.filter((row) => ['DUPLICATE', 'INVALID'].includes(row.type));
    if (filter === 'changed') return rows.filter((row) => ['ADDED', 'CHANGED', 'REMOVED'].includes(row.type));
    return rows;
  }

  function renderQuestionWorkspaceImport() {
    const version = selectedQuestionVersion(); const editable = isQuestionVersionEditable(version); const preview = state.questionImportPreview; const batch = preview?.batch;
    BUSINESS_CONFIG.applyActionState($('question-workspace-import-preview'), version, 'question_import.preview', setDisabledReason);
    const steps = ['select', 'validate', 'compare', 'confirm']; const currentIndex = Math.max(0, steps.indexOf(state.questionImportStep));
    document.querySelectorAll('[data-import-step]').forEach((step) => { const index = steps.indexOf(step.dataset.importStep); step.dataset.state = index < currentIndex ? 'complete' : index === currentIndex ? 'current' : ''; });
    const summary = $('question-workspace-import-summary');
    if (summary) summary.textContent = batch ? `Batch ${batch.public_id} · Thêm ${batch.added_count} · Đổi ${batch.changed_count} · Xóa ${batch.removed_count} · Lỗi ${Number(batch.invalid_rows) + Number(batch.duplicate_rows)}` : (editable ? 'Chọn workbook để bắt đầu preview.' : 'Chỉ Draft mới nhận import.');
    const tbody = $('question-workspace-diff-tbody');
    if (tbody) {
      tbody.textContent = ''; const rows = questionImportRows();
      rows.slice(0, 200).forEach(({ type, change }) => { const tr = el('tr'); const typeCell = el('td'); typeCell.appendChild(el('span', { className: 'tag sev-' + (['INVALID', 'DUPLICATE'].includes(type) ? 'red' : type === 'REMOVED' ? 'amber' : 'gray'), text: type })); tr.appendChild(typeCell); tr.appendChild(el('td', { className: 'mono', text: change.key || '—' })); tr.appendChild(el('td', { text: change.before?.question_text || change.errors?.join(', ') || '—' })); tr.appendChild(el('td', { text: change.after?.question_text || (change.row ? `Dòng ${change.row}` : '—') })); tbody.appendChild(tr); });
      if (!rows.length) { const tr = el('tr'); tr.appendChild(el('td', { className: 'muted', attrs: { colspan: '4' }, text: preview ? 'Không có kết quả phù hợp bộ lọc.' : 'Chưa có preview.' })); tbody.appendChild(tr); }
    }
    const errors = Number(batch?.invalid_rows || 0) + Number(batch?.duplicate_rows || 0);
    $('question-workspace-import-errors')?.classList.toggle('hidden', !batch || errors === 0);
    $('question-workspace-partial-wrap')?.classList.toggle('hidden', batch?.status !== 'PREVIEWED');
    $('question-workspace-import-rollback')?.classList.toggle('hidden', batch?.status !== 'COMMITTED');
    const commit = $('question-workspace-import-commit'); if (commit) commit.disabled = !editable || !preview?.confirmation_token || ['COMMITTED', 'ROLLED_BACK'].includes(batch?.status) || (batch?.status === 'PREVIEWED' && !$('question-workspace-accept-partial')?.checked);
    renderQuestionImportHistory();
  }

  function renderQuestionImportHistory() {
    const tbody = $('question-import-history-tbody'); if (!tbody) return; tbody.textContent = '';
    (state.questionImportHistory || []).forEach((batch) => { const tr = el('tr'); tr.appendChild(el('td', { className: 'muted', text: batch.created_at || '—' })); tr.appendChild(el('td', { text: batch.original_filename })); const status = el('td'); status.appendChild(el('span', { className: 'tag sev-' + (batch.status === 'COMMITTED' ? 'green' : batch.status === 'PREVIEWED' ? 'amber' : 'gray'), text: batch.status })); tr.appendChild(status); tr.appendChild(el('td', { className: 'mono', text: `+${batch.added_count} ~${batch.changed_count} -${batch.removed_count}` })); tr.appendChild(el('td', { text: batch.created_by || '—' })); tbody.appendChild(tr); });
    if (!state.questionImportHistory?.length) { const tr = el('tr'); tr.appendChild(el('td', { className: 'muted', attrs: { colspan: '5' }, text: 'Chưa có lần import cho phiên bản này.' })); tbody.appendChild(tr); }
  }

  async function previewQuestionWorkspaceImport() {
    const version = selectedQuestionVersion(); const file = $('question-workspace-import-file')?.files?.[0];
    if (!isQuestionVersionEditable(version)) return; if (!file || !file.name.toLowerCase().endsWith('.xlsx')) { focusQuestionValidationSummary(['Chọn workbook .xlsx hợp lệ.']); return; }
    const form = new FormData(); form.append('file', file); state.questionImportStep = 'validate'; renderQuestionWorkspaceImport();
    const finish = setButtonLoading($('question-workspace-import-preview'), 'Đang kiểm tra…');
    const response = await api('/question-templates/' + encodeURIComponent(state.selectedQuestionTemplateId) + '/versions/' + encodeURIComponent(version.id) + '/imports/preview', { method: 'POST', body: form }); finish();
    if (!response.ok) { state.questionImportStep = 'select'; setMsg('question-workspace-import-status', `Kiểm tra thất bại: ${response.data?.error || 'unknown'} · Request ${response.requestId || '—'}`, 'err'); renderQuestionWorkspaceImport(); return; }
    state.questionImportPreview = response.data.item; state.questionImportStep = 'compare'; $('question-workspace-accept-partial').checked = false; setMsg('question-workspace-import-status', 'Đã kiểm tra file. Xem lỗi và before/after trước khi xác nhận.', 'ok');
    state.questionImportHistory = [response.data.item.batch, ...(state.questionImportHistory || [])]; renderQuestionWorkspaceImport();
  }

  async function commitQuestionWorkspaceImport() {
    const version = selectedQuestionVersion(); const preview = state.questionImportPreview; if (!isQuestionVersionEditable(version) || !preview?.confirmation_token) return;
    state.questionImportStep = 'confirm'; renderQuestionWorkspaceImport();
    const response = await api('/question-templates/' + encodeURIComponent(state.selectedQuestionTemplateId) + '/versions/' + encodeURIComponent(version.id) + '/imports/' + encodeURIComponent(preview.batch.public_id) + '/commit', { method: 'POST', body: { confirmation_token: preview.confirmation_token, expected_lock_version: version.lock_version, accept_partial: $('question-workspace-accept-partial')?.checked === true } });
    if (!response.ok) { focusQuestionValidationSummary([response.data?.error === 'question_version_conflict' ? 'Draft đã thay đổi sau preview; dữ liệu chưa bị ghi một phần.' : `Commit thất bại: ${response.data?.error || 'unknown'} · Request ${response.requestId || '—'}`]); return; }
    state.questionImportPreview = { ...preview, batch: response.data.item.batch }; $('question-workspace-live').textContent = 'Đã commit nguyên tử vào Draft; chưa publish.'; await loadQuestionWorkspaceVersion();
  }

  async function rollbackQuestionWorkspaceImport() {
    const version = selectedQuestionVersion(); const preview = state.questionImportPreview; if (!version || preview?.batch?.status !== 'COMMITTED') return;
    const response = await api('/question-templates/' + encodeURIComponent(state.selectedQuestionTemplateId) + '/versions/' + encodeURIComponent(version.id) + '/imports/' + encodeURIComponent(preview.batch.public_id) + '/rollback', { method: 'POST', body: { expected_lock_version: version.lock_version } });
    if (!response.ok) { focusQuestionValidationSummary([`Hoàn tác thất bại: ${response.data?.error || 'unknown'} · Request ${response.requestId || '—'}`]); return; }
    state.questionImportPreview = { ...preview, batch: response.data.item.batch }; $('question-workspace-live').textContent = 'Đã phục hồi snapshot Draft; các ticket cũ không thay đổi.'; await loadQuestionWorkspaceVersion();
  }

  function downloadQuestionWorkspaceTemplate() {
    const anchor = document.createElement('a'); anchor.href = '/qlcl/api/question-templates/import-template'; anchor.download = 'question-template-import.xlsx'; anchor.click();
  }

  function downloadQuestionWorkspaceErrors() {
    const version = selectedQuestionVersion(); const batch = state.questionImportPreview?.batch; if (!version || !batch) return;
    const anchor = document.createElement('a'); anchor.href = '/qlcl/api/question-templates/' + encodeURIComponent(state.selectedQuestionTemplateId) + '/versions/' + encodeURIComponent(version.id) + '/imports/' + encodeURIComponent(batch.public_id) + '/errors.xlsx'; anchor.click();
  }

  function renderQuestionVersionsAudit() {
    const timeline = $('question-version-timeline'); if (timeline) { timeline.textContent = ''; state.questionVersions.forEach((version) => { const row = el('div', { className: 'question-version-event', attrs: { 'data-current': String(version.id) === String(state.selectedQuestionVersionId) ? 'true' : 'false' } }); row.appendChild(el('strong', { text: `v${version.version_no} · ${businessVersionStatusLabel(version.status)}` })); row.appendChild(el('div', { className: 'muted', text: `${version.item_count ?? version.items?.length ?? 0} bản ghi phạm vi · ${version.updated_at || version.created_at || '—'}` })); timeline.appendChild(row); }); (state.questionVersionDetail?.events || []).forEach((event) => timeline.appendChild(el('div', { className: 'question-version-event', text: `${event.created_at} · ${event.action} · ${event.actor_user_id || 'system'}` }))); }
    const impact = state.questionVersionImpact; if ($('question-version-impact')) $('question-version-impact').textContent = impact ? `${impact.ticket_count} phiếu đã pin · ${impact.round_count} vòng · ${impact.answer_count} câu trả lời · ${impact.default_scope_count} phạm vi mặc định` : 'Chưa có dữ liệu tác động.';
    const diff = state.questionVersionDiff; if ($('question-version-diff')) $('question-version-diff').textContent = diff ? `So với version trước: thêm ${diff.added.length}, đổi ${diff.changed.length}, xóa ${diff.removed.length}. Rollback chỉ đổi mặc định cho phiếu mới.` : 'Đây là phiên bản đầu tiên; chưa có version để so sánh.';
  }

  function trapQuestionEditorFocus(event) {
    const drawer = $('question-editor-drawer'); if (!drawer || drawer.classList.contains('hidden')) return;
    if (event.key === 'Escape') { event.preventDefault(); closeQuestionEditor(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...drawer.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])')];
    if (!focusable.length) return; const first = focusable[0]; const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function trapQuestionPreviewFocus(event) {
    const dialog = $('question-preview-dialog');
    if (!dialog || dialog.classList.contains('hidden')) return;
    if (event.key === 'Escape') { event.preventDefault(); closeQuestionPreview(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])')];
    if (!focusable.length) return;
    const first = focusable[0]; const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function renderUsers(items) {
    const tbody = $('admin-users-tbody');
    tbody.textContent = '';
    if (!items.length) {
      const empty = el('tr');
      empty.appendChild(el('td', { className: 'authz-empty', text: 'Không có nhân sự phù hợp với bộ lọc.', attrs: { colspan: 5 } }));
      tbody.appendChild(empty);
      return;
    }
    items.forEach((u) => {
      const userId = authzUserKey(u);
      const detail = authzUserDetails.get(userId);
      const health = authzUserHealth(detail);
      const tr = el('tr', { attrs: {
        tabindex: '0',
        'data-authz-user-id': userId,
        'aria-label': `Mở phân quyền của ${u.email}`,
        ...(authzSelectedUser === userId && authzUserEditorOpen ? { 'aria-current': 'true' } : {}),
      } });
      const tdPerson = el('td');
      tdPerson.appendChild(el('strong', { text: u.display_name || u.email }));
      tdPerson.appendChild(el('span', { className: 'authz-person-email mono muted', text: u.email }));
      tr.appendChild(tdPerson);
      const tdRole = el('td');
      const assignedRoles = detail?.roles?.filter((role) => role.active) || [];
      if (assignedRoles.length) assignedRoles.slice(0, 3).forEach((role) => tdRole.appendChild(el('span', {
        className: `tag sev-${role.effective ? 'gray' : 'amber'}`,
        text: role.displayLabel,
        attrs: { title: `${role.roleCode}${role.validUntil ? ` · đến ${role.validUntil}` : ''}` },
      })));
      else tdRole.appendChild(el('span', { className: 'muted', text: detail ? 'Chưa gán vai trò' : 'Đang tải vai trò…' }));
      if (assignedRoles.length > 3) tdRole.appendChild(el('span', { className: 'tag sev-gray', text: `+${assignedRoles.length - 3}` }));
      tr.appendChild(tdRole);
      const tdScope = el('td');
      const effectiveScopes = detail?.scopes?.filter((scope) => scope.effective) || [];
      effectiveScopes.slice(0, 3).forEach((scope) => tdScope.appendChild(el('span', {
        className: `tag sev-${scope.effect === 'DENY' ? 'red' : 'gray'}`,
        text: `${scope.scopeType}${scope.scopeValue ? `:${scope.scopeValue}` : ''}`,
        attrs: { title: `${scope.effect}${scope.roleCode ? ` · ${scope.roleCode}` : ''}` },
      })));
      if (!effectiveScopes.length) tdScope.appendChild(el('span', { className: 'muted', text: 'Chưa giới hạn' }));
      if (effectiveScopes.length > 3) tdScope.appendChild(el('span', { className: 'tag sev-gray', text: `+${effectiveScopes.length - 3}` }));
      tr.appendChild(tdScope);
      const tdStatus = el('td');
      tdStatus.appendChild(el('span', { className: 'tag sev-' + (u.is_active ? 'green' : 'gray'), text: statusText(u.is_active ? 'ACTIVE' : 'LOCKED') }));
      if (health.expired) tdStatus.appendChild(el('span', { className: 'tag sev-amber', text: 'Role hết hạn' }));
      if (health.conflict) tdStatus.appendChild(el('span', { className: 'tag sev-red', text: 'DENY conflict' }));
      tr.appendChild(tdStatus);
      const tdAct = el('td', { className: 'table-action-cell text-right' });
      const rowMenu = RowActionGroup([
        actionDescriptor('authorization.tab_open', () => openAuthzUserEditor(userId, tr), null, { label: 'Điều chỉnh', icon: 'pen', announceSuccess: false }),
      ], u.is_active
        ? (userId !== state.userId ? [actionDescriptor('authorization.user_deactivate', () => deactivateUser(userId, u.email), null, { confirm: false, objectIdentity: u.email })] : [])
        : [actionDescriptor('authorization.user_reactivate', () => reactivateUser(userId, u.email), null, { confirm: false, objectIdentity: u.email })]);
      tdAct.appendChild(rowMenu);
      tr.appendChild(tdAct);
      tr.addEventListener('click', (event) => {
        if (event.target.closest('button')) return;
        openAuthzUserEditor(userId, tr);
      });
      tr.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openAuthzUserEditor(userId, tr);
        }
      });
      tbody.appendChild(tr);
    });
  }
  const SCORING_POLICY_TABS = ['overview', 'grade-scale', 'bands', 'penalties', 'simulation', 'impact', 'versions'];
  const SCORING_POLICY_SYNTHETIC_FIXTURES = Object.freeze(
    [59.999, 60, 75, 75.000001, 90, 90.000001]
      .map((score, index) => Object.freeze({ id: `synthetic-boundary-${index + 1}`, score })),
  );

  function scoringPolicyParams() {
    const raw = routePathFromHash();
    return new URLSearchParams(raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '');
  }

  function hydrateScoringPolicyUrl() {
    const params = scoringPolicyParams();
    if (params.get('policy')) state.selectedScoringPolicyCode = params.get('policy');
    if (params.get('version')) state.selectedScoringPolicyVersionId = params.get('version');
    if (SCORING_POLICY_TABS.includes(params.get('tab'))) state.scoringPolicyTab = params.get('tab');
  }

  function syncScoringPolicyUrl({ replace = false } = {}) {
    if (state.tab !== 'admin-scoring-policies') return;
    const next = BUSINESS_CONFIG.workspaceHash('/admin/scoring-policies', {
      policy: state.selectedScoringPolicyCode,
      version: state.selectedScoringPolicyVersionId,
      tab: SCORING_POLICY_TABS.includes(state.scoringPolicyTab) ? state.scoringPolicyTab : 'overview',
    });
    if (window.location.hash === next) return;
    if (replace) window.history.replaceState(null, '', next);
    else window.location.hash = next.slice(1);
  }

  function selectedScoringPolicy() {
    return (state.scoringPolicies || []).find((item) => item.policy_code === state.selectedScoringPolicyCode) || null;
  }

  function selectedScoringPolicyVersion() {
    return (state.scoringPolicyVersions || []).find((item) => String(item.id) === String(state.selectedScoringPolicyVersionId)) || null;
  }

  function markScoringPolicyDirty(dirty = true) {
    state.scoringPolicyDirty = dirty;
    const host = $('scoring-policy-dirty-state');
    if (host) host.textContent = dirty ? 'Có thay đổi Draft chưa lưu' : 'Không có thay đổi chưa lưu';
    syncGuidedWorkspace('scoring-policies', dirty ? 3 : state.selectedScoringPolicyCode ? 2 : 1);
  }

  async function loadScoringPolicyWorkspace() {
    hydrateScoringPolicyUrl();
    state.scoringPolicyTab = SCORING_POLICY_TABS.includes(state.scoringPolicyTab) ? state.scoringPolicyTab : 'overview';
    showBusinessConfigSurface('scoring-policy-state', { loading: true, message: 'Đang tải chính sách tính điểm…' });
    const response = await api('/scoring-policies');
    if (!response.ok) {
      state.scoringPolicies = [];
      renderScoringPolicyCatalog();
      showBusinessConfigSurface('scoring-policy-state', {
        status: response.status,
        error: true,
        message: response.status === 403 ? undefined : `Không tải được chính sách tính điểm · Request ${response.requestId || '—'}`,
      });
      return;
    }
    state.scoringPolicies = response.data.items || [];
    if (!state.scoringPolicies.some((item) => item.policy_code === state.selectedScoringPolicyCode)) {
      state.selectedScoringPolicyCode = state.scoringPolicies[0]?.policy_code || '';
      state.selectedScoringPolicyVersionId = '';
    }
    renderScoringPolicyCatalog();
    if (!state.selectedScoringPolicyCode) {
      showBusinessConfigSurface('scoring-policy-state', { empty: true, message: 'Chưa có chính sách tính điểm.' });
      renderScoringPolicyWorkspace();
      return;
    }
    showBusinessConfigSurface('scoring-policy-state');
    await loadScoringPolicyVersions();
  }

  function filteredScoringPolicies() {
    const search = ($('scoring-policy-search')?.value || '').trim().toLowerCase();
    const status = $('scoring-policy-status-filter')?.value || '';
    return (state.scoringPolicies || []).filter((item) => {
      if (search && !`${item.policy_code} ${item.policy_name}`.toLowerCase().includes(search)) return false;
      return !status || item.latest_version?.status === status;
    });
  }

  function renderScoringPolicyCatalog() {
    const host = $('scoring-policy-catalog');
    if (!host) return;
    host.textContent = '';
    const rows = filteredScoringPolicies();
    if ($('scoring-policy-count')) $('scoring-policy-count').textContent = `${rows.length} chính sách`;
    $('scoring-policy-catalog-empty')?.classList.toggle('hidden', rows.length > 0);
    rows.forEach((policy) => {
      const card = el('article', { className: 'business-config-catalog-item', attrs: { role: 'listitem', 'aria-current': policy.policy_code === state.selectedScoringPolicyCode ? 'true' : 'false' } });
      const button = el('button', { className: 'business-config-catalog-open', attrs: { type: 'button' } });
      button.appendChild(el('strong', { className: 'mono', text: policy.policy_code }));
      button.appendChild(el('span', { text: policy.policy_name }));
      button.appendChild(el('span', { text: `${policy.version_count || 0} phiên bản · ${businessVersionStatusLabel(policy.latest_version?.status)}${policy.default_version ? ` · Đang áp dụng v${policy.default_version.version_no}` : ''}` }));
      setRegisteredButtonAction(button, 'scoring_policy.tab_open', async () => {
        if (policy.policy_code === state.selectedScoringPolicyCode || !confirmBusinessConfigRouteLeave(window.location.hash)) return;
        state.selectedScoringPolicyCode = policy.policy_code;
        state.selectedScoringPolicyVersionId = '';
        state.scoringPolicyTab = 'overview';
        renderScoringPolicyCatalog();
        await loadScoringPolicyVersions();
      }, { context: actionContext(null) });
      const openPolicy = async (tab = 'overview') => {
        state.selectedScoringPolicyCode = policy.policy_code;
        state.selectedScoringPolicyVersionId = '';
        state.scoringPolicyTab = tab;
        renderScoringPolicyCatalog();
        await loadScoringPolicyVersions();
        setScoringPolicyTab(tab);
      };
      const historyAction = actionDescriptor('scoring_policy.tab_open', () => openPolicy('versions'), null, { label: 'Xem lịch sử', announceSuccess: false });
      if (historyAction) historyAction.key = 'scoring_policy.history_open';
      card.append(button, RowActionGroup([
        actionDescriptor('scoring_policy.tab_open', () => openPolicy('overview'), null, { label: 'Mở chính sách', announceSuccess: false }),
      ], [
        actionDescriptor('scoring_policy.create_draft', async () => { await openPolicy('versions'); await createScoringPolicyDraft(); }, null, { label: 'Tạo bản nháp', announceSuccess: false }),
        historyAction,
      ]));
      host.appendChild(card);
    });
  }

  async function loadScoringPolicyVersions() {
    const policy = selectedScoringPolicy();
    if (!policy) return renderScoringPolicyWorkspace();
    const response = await api(`/scoring-policies/${encodeURIComponent(policy.policy_code)}/versions`);
    if (!response.ok) {
      showBusinessConfigSurface('scoring-policy-state', { status: response.status, error: true, message: `Không tải được version · Request ${response.requestId || '—'}` });
      return;
    }
    state.scoringPolicyVersions = response.data.items || [];
    if (!state.scoringPolicyVersions.some((item) => String(item.id) === String(state.selectedScoringPolicyVersionId))) {
      const preferred = state.scoringPolicyVersions.find((item) => item.status === 'DRAFT')
        || state.scoringPolicyVersions.find((item) => item.is_default)
        || state.scoringPolicyVersions[0];
      state.selectedScoringPolicyVersionId = String(preferred?.id || '');
    }
    await loadScoringPolicyVersionDetail();
  }

  async function loadScoringPolicyVersionDetail() {
    if (!state.selectedScoringPolicyVersionId) {
      state.scoringPolicyVersionDetail = null;
      renderScoringPolicyWorkspace();
      return;
    }
    const response = await api(`/scoring-policies/versions/${encodeURIComponent(state.selectedScoringPolicyVersionId)}`);
    if (!response.ok) {
      showBusinessConfigSurface('scoring-policy-state', { status: response.status, error: true, message: `Không tải được chi tiết version · Request ${response.requestId || '—'}` });
      return;
    }
    state.scoringPolicyVersionDetail = response.data.item;
    state.scoringPolicyDraftDefinition = structuredClone(response.data.item.definition || {});
    state.scoringPolicyVersionEvents = response.data.events || [];
    state.scoringPolicyValidationResult = null;
    state.scoringPolicySimulationResult = null;
    state.scoringPolicyImpactResult = null;
    state.scoringPolicyCompletedChecks = new Set();
    markScoringPolicyDirty(false);
    showBusinessConfigSurface('scoring-policy-state');
    renderScoringPolicyWorkspace();
    syncScoringPolicyUrl({ replace: true });
  }

  function scoringPolicyDateTimeValue(value) {
    return value ? String(value).replace(' ', 'T').slice(0, 16) : '';
  }

  function renderScoringPolicyWorkspace() {
    const policy = selectedScoringPolicy();
    const version = state.scoringPolicyVersionDetail;
    syncGuidedWorkspace('scoring-policies', state.scoringPolicyDirty ? 3 : policy ? 2 : 1);
    if ($('scoring-policy-code')) $('scoring-policy-code').textContent = policy?.policy_code || '';
    if ($('scoring-policy-version-title')) $('scoring-policy-version-title').textContent = policy?.policy_name || 'Chọn một chính sách';
    if ($('scoring-policy-version-meta')) $('scoring-policy-version-meta').textContent = version
      ? `v${version.version_no} · lock ${version.lock_version} · formula ${String(version.formula_checksum || '').slice(0, 12)}…`
      : 'Chưa có version.';
    const select = $('scoring-policy-version-select');
    if (select) {
      select.textContent = '';
      (state.scoringPolicyVersions || []).forEach((item) => select.appendChild(el('option', {
        attrs: { value: String(item.id) },
        text: `v${item.version_no} · ${businessVersionStatusLabel(item.status)}${item.is_default ? ' · Đang áp dụng' : ''}`,
      })));
      select.value = state.selectedScoringPolicyVersionId || '';
    }
    const status = $('scoring-policy-status');
    if (status) { status.textContent = businessVersionStatusLabel(version?.status); status.dataset.status = version?.status || ''; }
    renderBusinessConfigLifecycle('scoring-policy-lifecycle', version);
    const versionModel = BUSINESS_CONFIG.versionState(version || {});
    $('scoring-policy-readonly')?.classList.toggle('hidden', !versionModel.readOnly);
    const editable = BUSINESS_CONFIG.actionState(version || {}, 'scoring_policy.save_draft').state === 'enabled';
    for (const id of [
      'scoring-policy-note', 'scoring-policy-effective-from', 'scoring-policy-effective-to',
      'scoring-policy-overview-title', 'scoring-policy-default-reason', 'scoring-policy-pass-min',
      'scoring-policy-lead-threshold', 'scoring-policy-rounding-mode', 'scoring-policy-display-decimals',
      'scoring-policy-elimination-clause', 'scoring-policy-elimination-score',
      'scoring-policy-elimination-forced', 'scoring-policy-elimination-reason',
    ]) {
      const control = $(id); if (control) control.disabled = !editable;
    }
    if ($('scoring-policy-note')) $('scoring-policy-note').value = version?.version_note || '';
    if ($('scoring-policy-effective-from')) $('scoring-policy-effective-from').value = scoringPolicyDateTimeValue(version?.effective_from);
    if ($('scoring-policy-effective-to')) $('scoring-policy-effective-to').value = scoringPolicyDateTimeValue(version?.effective_to);
    renderScoringPolicySummary();
    renderScoringPolicyDefinition();
    renderScoringPolicySimulationResult();
    renderScoringPolicyImpactResult();
    renderScoringPolicyTimeline();
    renderScoringPolicyTabs();
    syncScoringPolicyActions();
  }

  function renderScoringPolicySummary() {
    const host = $('scoring-policy-summary');
    if (!host) return;
    host.textContent = '';
    const definition = state.scoringPolicyVersionDetail?.definition || {};
    const metrics = [
      ['Nhóm tiêu chí', definition.categories?.length || 0],
      ['Khoảng xếp loại', definition.bands?.length || 0],
      ['Mức điểm', Object.keys(definition.grades || {}).length],
      ['Phiên bản cấu trúc', `v${definition.schema_version || state.scoringPolicyVersionDetail?.schema_version || '—'}`],
    ];
    metrics.forEach(([label, value]) => {
      const card = el('div', { className: 'admin-metric-card', attrs: { role: 'group', 'aria-label': `${label}: ${value}` } });
      card.appendChild(el('strong', { text: String(value) }));
      card.appendChild(el('span', { text: label }));
      host.appendChild(card);
    });
  }

  function scoringPolicyDefinition() {
    return state.scoringPolicyDraftDefinition || state.scoringPolicyVersionDetail?.definition || {};
  }

  function scoringPolicyDefinitionEditable() {
    return BUSINESS_CONFIG.actionState(state.scoringPolicyVersionDetail || {}, 'scoring_policy.save_draft').state === 'enabled';
  }

  function resetScoringPolicyChecks() {
    state.scoringPolicyCompletedChecks = new Set();
    state.scoringPolicyValidationResult = null;
    state.scoringPolicySimulationResult = null;
    state.scoringPolicyImpactResult = null;
    const simulation = $('scoring-policy-simulation-result');
    if (simulation) { simulation.textContent = 'Cần lưu Draft rồi chạy lại mô phỏng.'; simulation.classList.add('admin-state--empty'); }
    const impact = $('scoring-policy-impact-result');
    if (impact) { impact.textContent = 'Cần lưu Draft rồi phân tích lại tác động.'; impact.classList.add('admin-state--empty'); }
    syncScoringPolicyActions();
  }

  function markScoringPolicyDefinitionDirty() {
    markScoringPolicyDirty(true);
    resetScoringPolicyChecks();
  }

  function scoringPolicyCellInput(value, { label, type = 'text', step, nullable = false, onValue }) {
    const input = el('input', {
      className: 'input scoring-policy-cell-input',
      attrs: { type, 'aria-label': label, ...(step ? { step } : {}) },
    });
    input.value = value == null ? '' : String(value);
    input.disabled = !scoringPolicyDefinitionEditable();
    input.addEventListener('input', () => {
      const next = type === 'number'
        ? (nullable && input.value === '' ? null : Number(input.value))
        : input.value;
      onValue(next);
      markScoringPolicyDefinitionDirty();
    });
    return input;
  }

  function appendScoringPolicyInputCell(row, value, options) {
    const cell = el('td');
    cell.appendChild(scoringPolicyCellInput(value, options));
    row.appendChild(cell);
  }

  function renderScoringPolicyDefinition() {
    const definition = scoringPolicyDefinition();
    const editable = scoringPolicyDefinitionEditable();
    const setControl = (id, value) => {
      const control = $(id);
      if (!control) return;
      control.value = value == null ? '' : String(value);
      control.disabled = !editable;
    };
    setControl('scoring-policy-overview-title', definition.compliance_overview?.title);
    setControl('scoring-policy-default-reason', definition.default_reason);
    setControl('scoring-policy-pass-min', definition.final_conclusion?.pass_min);
    setControl('scoring-policy-lead-threshold', definition.workflow_thresholds?.lead_submission_score_below);
    setControl('scoring-policy-rounding-mode', definition.rounding?.calculation_mode || 'NONE');
    setControl('scoring-policy-display-decimals', definition.rounding?.display_decimals);
    setControl('scoring-policy-elimination-clause', definition.elimination?.clause_type);
    setControl('scoring-policy-elimination-score', definition.elimination?.score);
    setControl('scoring-policy-elimination-forced', definition.elimination?.forced_score);
    setControl('scoring-policy-elimination-reason', definition.elimination?.reason);

    const categories = $('scoring-policy-category-tbody');
    if (categories) {
      categories.textContent = '';
      (definition.categories || []).forEach((item, index) => {
        const row = el('tr');
        row.appendChild(el('td', { className: 'mono', text: item.code || '—' }));
        appendScoringPolicyInputCell(row, item.label, {
          label: `Nhãn category ${item.code}`, onValue: (value) => { definition.categories[index].label = value; },
        });
        appendScoringPolicyInputCell(row, item.order, {
          label: `Thứ tự category ${item.code}`, type: 'number', step: '1', onValue: (value) => { definition.categories[index].order = value; },
        });
        categories.appendChild(row);
      });
    }

    const grades = $('scoring-policy-grade-tbody');
    if (grades) {
      grades.textContent = '';
      Object.entries(definition.grades || {}).forEach(([code, grade]) => {
        const row = el('tr');
        row.appendChild(el('td', { className: 'mono', text: code }));
        row.appendChild(el('td', { text: grade.label || code }));
        appendScoringPolicyInputCell(row, definition.score_values?.[code], {
          label: `Giá trị điểm ${code}`, type: 'number', step: '0.01', nullable: code === 'NA',
          onValue: (value) => { definition.score_values[code] = value; },
        });
        row.appendChild(el('td', { text: grade.passed == null ? 'Không áp dụng' : (grade.passed ? 'Có' : 'Không') }));
        appendScoringPolicyInputCell(row, grade.next_evaluation_months, {
          label: `Tháng đánh giá lại ${code}`, type: 'number', step: '1', nullable: true,
          onValue: (value) => { definition.grades[code].next_evaluation_months = value; },
        });
        grades.appendChild(row);
      });
    }

    const bands = $('scoring-policy-band-tbody');
    if (bands) {
      bands.textContent = '';
      (definition.bands || []).forEach((item, index) => {
        const row = el('tr');
        row.appendChild(el('td', { className: 'mono', text: item.key || '—' }));
        row.appendChild(el('td', { className: 'mono', text: item.grade || '—' }));
        appendScoringPolicyInputCell(row, item.min, {
          label: `Ngưỡng từ ${item.key}`, type: 'number', step: '0.000001', nullable: true,
          onValue: (value) => { definition.bands[index].min = value; },
        });
        appendScoringPolicyInputCell(row, item.max, {
          label: `Ngưỡng đến ${item.key}`, type: 'number', step: '0.000001', nullable: true,
          onValue: (value) => { definition.bands[index].max = value; },
        });
        appendScoringPolicyInputCell(row, item.result_label, {
          label: `Kết luận ${item.key}`, onValue: (value) => { definition.bands[index].result_label = value; },
        });
        bands.appendChild(row);
      });
    }

    const penalties = $('scoring-policy-penalty-tbody');
    if (penalties) {
      penalties.textContent = '';
      (definition.penalties || []).forEach((item, index) => {
        const row = el('tr');
        row.appendChild(el('td', { className: 'mono', text: item.code || '—' }));
        row.appendChild(el('td', { text: `${item.question_flag || '—'} = ${item.score || '—'}` }));
        appendScoringPolicyInputCell(row, item.multiplier, {
          label: `Hệ số ${item.code}`, type: 'number', step: '0.01', onValue: (value) => { definition.penalties[index].multiplier = value; },
        });
        appendScoringPolicyInputCell(row, item.priority, {
          label: `Ưu tiên ${item.code}`, type: 'number', step: '1', onValue: (value) => { definition.penalties[index].priority = value; },
        });
        appendScoringPolicyInputCell(row, item.reason, {
          label: `Giải thích ${item.code}`, onValue: (value) => { definition.penalties[index].reason = value; },
        });
        penalties.appendChild(row);
      });
    }
  }

  function renderScoringPolicySimulationResult() {
    const payload = state.scoringPolicySimulationResult;
    const host = $('scoring-policy-simulation-result');
    const tbody = $('scoring-policy-simulation-tbody');
    if (!host || !tbody) return;
    tbody.textContent = '';
    if (!payload) return;
    host.classList.remove('admin-state--empty');
    host.textContent = `${payload.items?.length || 0} fixture synthetic · ${payload.changed_fixture_count || 0} kết quả thay đổi · server version #${payload.policy_version_id || '—'}.`;
    (payload.items || []).forEach((item) => {
      const row = el('tr');
      for (const value of [
        item.fixture_id, item.score_after, item.band_before, item.band_after,
        item.grade_after, item.next_evaluation_months_after ?? '—',
      ]) row.appendChild(el('td', { text: String(value ?? '—') }));
      tbody.appendChild(row);
    });
  }

  function renderScoringPolicyImpactResult() {
    const payload = state.scoringPolicyImpactResult;
    const host = $('scoring-policy-impact-result');
    const summary = $('scoring-policy-impact-summary');
    const tbody = $('scoring-policy-impact-tbody');
    if (!host || !summary || !tbody) return;
    summary.textContent = '';
    tbody.textContent = '';
    if (!payload) return;
    host.classList.remove('admin-state--empty');
    host.textContent = `So với Published #${payload.compared_to_version_id || '—'} · ${payload.formula_changed ? 'Công thức thay đổi' : 'Công thức không đổi'}.`;
    for (const [label, value] of [
      ['Fixture đổi', payload.changed_fixture_count || 0],
      ['Band đổi', payload.changed_band_count || 0],
      ['Category tác động', payload.affected_categories?.length || 0],
    ]) {
      const card = el('div', { className: 'admin-metric-card' });
      card.appendChild(el('strong', { text: String(value) }));
      card.appendChild(el('span', { text: label }));
      summary.appendChild(card);
    }
    (payload.items || []).forEach((item) => {
      const row = el('tr');
      for (const value of [
        item.fixture_id, item.band_before, item.band_after, item.grade_before, item.grade_after,
        `${item.next_evaluation_months_before ?? '—'} / ${item.next_evaluation_months_after ?? '—'}`,
      ]) row.appendChild(el('td', { text: String(value ?? '—') }));
      tbody.appendChild(row);
    });
  }

  function renderScoringPolicyTimeline() {
    const host = $('scoring-policy-version-events');
    if (!host) return;
    host.textContent = '';
    (state.scoringPolicyVersions || []).forEach((version) => host.appendChild(el('div', {
      className: 'business-config-event', text: `v${version.version_no} · ${businessVersionStatusLabel(version.status)} · ${version.is_default ? 'Mặc định' : 'Không mặc định'} · phiên bản khóa ${version.lock_version}`,
    })));
    (state.scoringPolicyVersionEvents || []).forEach((event) => host.appendChild(el('div', {
      className: 'business-config-event', text: `${event.created_at || '—'} · ${event.action || '—'} · ${event.actor || event.actor_user_id || 'system'} · ${event.correlation_id || '—'}`,
    })));
  }

  function renderScoringPolicyTabs() {
    const active = SCORING_POLICY_TABS.includes(state.scoringPolicyTab) ? state.scoringPolicyTab : 'overview';
    document.querySelectorAll('[data-scoring-policy-tab]').forEach((button) => {
      const selected = button.dataset.scoringPolicyTab === active;
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
      button.tabIndex = selected ? 0 : -1;
    });
    document.querySelectorAll('[data-scoring-policy-pane]').forEach((pane) => pane.classList.toggle('hidden', pane.dataset.scoringPolicyPane !== active));
  }

  function setScoringPolicyTab(tab, { focus = false } = {}) {
    if (!SCORING_POLICY_TABS.includes(tab)) return;
    state.scoringPolicyTab = tab;
    renderScoringPolicyTabs();
    syncScoringPolicyUrl();
    if (focus) document.querySelector(`[data-scoring-policy-tab="${tab}"]`)?.focus();
  }

  function syncScoringPolicyActions() {
    const version = state.scoringPolicyVersionDetail || {};
    const actions = {
      'scoring-policy-create-draft': 'scoring_policy.create_draft',
      'scoring-policy-simulate': 'scoring_policy.simulate',
      'scoring-policy-impact': 'scoring_policy.impact',
      'scoring-policy-validate': 'scoring_policy.validate',
      'scoring-policy-save-draft': 'scoring_policy.save_draft',
      'scoring-policy-submit-review': 'scoring_policy.submit_review',
      'scoring-policy-publish': 'scoring_policy.publish',
      'scoring-policy-rollback': 'scoring_policy.rollback',
    };
    Object.entries(actions).forEach(([id, actionId]) => BUSINESS_CONFIG.applyActionState($(id), version, actionId, setDisabledReason));
    const submit = $('scoring-policy-submit-review');
    const completed = state.scoringPolicyCompletedChecks || new Set();
    if (submit && BUSINESS_CONFIG.actionState(version, 'scoring_policy.submit_review').state === 'enabled'
      && (state.scoringPolicyDirty || ['validate', 'simulate', 'impact'].some((check) => !completed.has(check)))) {
      submit.disabled = true;
      setDisabledReason(submit, 'scoring_policy_checks_required');
    }
    const publishState = BUSINESS_CONFIG.actionState(version, 'scoring_policy.publish').state;
    const rollbackState = BUSINESS_CONFIG.actionState(version, 'scoring_policy.rollback').state;
    $('scoring-policy-decision-field')?.classList.toggle('hidden', !['enabled', 'disabled'].includes(publishState) && !['enabled', 'disabled'].includes(rollbackState));
  }

  function scoringPolicyChecksMayRun() {
    if (!state.scoringPolicyDirty) return true;
    $('scoring-policy-live').textContent = 'Hãy lưu Draft trước khi chạy kiểm tra, mô phỏng hoặc tác động để server dùng đúng checksum.';
    $('scoring-policy-save-draft')?.focus();
    return false;
  }

  async function simulateScoringPolicy() {
    const version = state.scoringPolicyVersionDetail;
    if (!version || !scoringPolicyChecksMayRun()) return;
    const response = await api(`/scoring-policies/versions/${encodeURIComponent(version.id)}/simulate`, {
      method: 'POST', body: { fixtures: SCORING_POLICY_SYNTHETIC_FIXTURES },
    });
    if (!response.ok) return showScoringPolicyError(response, 'Không mô phỏng được policy');
    state.scoringPolicySimulationResult = response.data;
    state.scoringPolicyCompletedChecks = state.scoringPolicyCompletedChecks || new Set();
    state.scoringPolicyCompletedChecks.add('simulate');
    renderScoringPolicySimulationResult();
    syncScoringPolicyActions();
    setScoringPolicyTab('simulation');
  }

  async function analyzeScoringPolicyImpact() {
    const version = state.scoringPolicyVersionDetail;
    if (!version || !scoringPolicyChecksMayRun()) return;
    const response = await api(`/scoring-policies/versions/${encodeURIComponent(version.id)}/impact`, {
      method: 'POST', body: { fixtures: SCORING_POLICY_SYNTHETIC_FIXTURES },
    });
    if (!response.ok) return showScoringPolicyError(response, 'Không phân tích được tác động');
    state.scoringPolicyImpactResult = response.data;
    state.scoringPolicyCompletedChecks = state.scoringPolicyCompletedChecks || new Set();
    state.scoringPolicyCompletedChecks.add('impact');
    renderScoringPolicyImpactResult();
    syncScoringPolicyActions();
    setScoringPolicyTab('impact');
  }

  async function validateScoringPolicy() {
    const version = state.scoringPolicyVersionDetail;
    if (!version || !scoringPolicyChecksMayRun()) return;
    const response = await api(`/scoring-policies/versions/${encodeURIComponent(version.id)}/validate`, { method: 'POST', body: {} });
    if (!response.ok) return showScoringPolicyError(response, 'Kiểm tra policy thất bại');
    state.scoringPolicyValidationResult = response.data;
    state.scoringPolicyCompletedChecks = state.scoringPolicyCompletedChecks || new Set();
    state.scoringPolicyCompletedChecks.add('validate');
    $('scoring-policy-live').textContent = `Hợp lệ · ${response.data.categories || 0} category · ${response.data.bands || 0} band · checksum ${String(response.data.checksum || '').slice(0, 12)}…`;
    syncScoringPolicyActions();
  }

  function showScoringPolicyError(response, fallback) {
    const conflict = response.status === 409;
    if (conflict) showBusinessConfigSurface('scoring-policy-state', { status: 409 });
    if ($('scoring-policy-live')) $('scoring-policy-live').textContent = `${response.data?.error || fallback} · Request ${response.requestId || '—'}`;
  }

  async function saveScoringPolicyDraft() {
    const version = state.scoringPolicyVersionDetail; if (!version) return;
    const response = await api(`/scoring-policies/versions/${encodeURIComponent(version.id)}`, {
      method: 'PUT',
      body: {
        lock_version: version.lock_version,
        definition: scoringPolicyDefinition(),
        version_note: $('scoring-policy-note')?.value.trim() || null,
        effective_from: $('scoring-policy-effective-from')?.value || null,
        effective_to: $('scoring-policy-effective-to')?.value || null,
      },
    });
    if (!response.ok) return showScoringPolicyError(response, 'Không lưu được Draft');
    state.scoringPolicyVersionDetail = response.data.item;
    state.scoringPolicyDraftDefinition = structuredClone(response.data.item.definition || {});
    markScoringPolicyDirty(false);
    state.scoringPolicyCompletedChecks = new Set();
    $('scoring-policy-live').textContent = 'Đã lưu Draft; cần chạy lại Kiểm tra, Mô phỏng và Tác động trên checksum mới.';
    await loadScoringPolicyVersions();
  }

  async function createScoringPolicyDraft() {
    const policy = selectedScoringPolicy(); const version = state.scoringPolicyVersionDetail;
    if (!policy || !version) return;
    const response = await api(`/scoring-policies/${encodeURIComponent(policy.policy_code)}/versions`, {
      method: 'POST', body: { source_version_id: version.id, version_note: `Draft từ v${version.version_no}` },
    });
    if (!response.ok) return showScoringPolicyError(response, 'Không tạo được Draft');
    state.selectedScoringPolicyVersionId = String(response.data.item.id);
    state.scoringPolicyTab = 'overview';
    await loadScoringPolicyVersions();
  }

  async function transitionScoringPolicy(action) {
    const version = state.scoringPolicyVersionDetail; if (!version) return;
    if (action === 'submit') {
      const completed = state.scoringPolicyCompletedChecks || new Set();
      if (state.scoringPolicyDirty || ['validate', 'simulate', 'impact'].some((check) => !completed.has(check))) {
        $('scoring-policy-live').textContent = actionReasonText('scoring_policy_checks_required');
        return;
      }
    }
    const decisionId = $('scoring-policy-decision-id')?.value.trim() || '';
    if (['publish', 'rollback'].includes(action) && decisionId.length < 6) {
      $('scoring-policy-live').textContent = 'Nhập Decision ID có ít nhất 6 ký tự trước khi tiếp tục.';
      $('scoring-policy-decision-id')?.focus();
      return;
    }
    const response = await api(`/scoring-policies/versions/${encodeURIComponent(version.id)}/${action}`, {
      method: 'POST', body: { lock_version: version.lock_version, ...(decisionId ? { decision_id: decisionId } : {}) },
    });
    if (!response.ok) return showScoringPolicyError(response, `${action} thất bại`);
    $('scoring-policy-live').textContent = action === 'submit'
      ? 'Draft đã chuyển sang Review và hiện chỉ đọc.'
      : 'Lifecycle đã được backend cập nhật; các phiếu cũ giữ version đã pin.';
    await loadScoringPolicyVersions();
  }

  // ============ Modals ============
  $('btn-add-user').addEventListener('click', () => {
    $('new-user-email').value = '';
    $('new-user-name').value = '';
    $('new-user-role').value = 'Chuyên viên';
    $('new-user-reason').value = '';
    setMsg('add-user-msg', '');
    $('add-user-modal').classList.remove('hidden');
  });
  $('authz-import-users')?.addEventListener('click', () => navigateToTab('admin-personnel-import'));
  $('btn-cancel-add-user').addEventListener('click', () => $('add-user-modal').classList.add('hidden'));

  bindRegisteredAction($('form-add-user'), 'authorization.user_add', async (e) => {
    e.preventDefault();
    const finishButton = setButtonLoading($('btn-submit-add-user'), 'Đang thêm người dùng...');
    const body = {
      email: $('new-user-email').value.trim().toLowerCase(),
      display_name: $('new-user-name').value.trim() || null,
      role: $('new-user-role').value,
      reason: $('new-user-reason').value.trim(),
    };
    const r = await api('/admin/users', { method: 'POST', body });
    if (r.ok) {
      finishButton('Đã thêm ✓');
      showToast('Đã thêm người dùng.', 'ok');
      $('add-user-modal').classList.add('hidden');
      loadAdmin();
    }
    else {
      finishButton();
      const err = r.data && r.data.error;
      let msg = 'Không thêm được.';
      if (err === 'invalid_email') msg = 'Email không hợp lệ.';
      else if (err === 'forbidden') msg = 'Bạn không có quyền admin.';
      else if (err === 'change_reason_required') msg = 'Lý do phải có từ 8 đến 500 ký tự.';
      setMsg('add-user-msg', msg, 'err');
    }
  }, { event: 'submit', preventDefault: true, trigger: $('btn-submit-add-user'), announceSuccess: false });

  async function deactivateUser(userId, email = userId) {
    const errorMessage = (response) => {
      const code = response?.data?.error;
      if (code === 'work_transfer_required') return 'Tài khoản vẫn còn công việc cần bàn giao.';
      if (code === 'transfer_recipient_inactive') return 'Người nhận đã bị vô hiệu hóa. Hãy chọn người khác.';
      if (code === 'transfer_recipient_same_user') return 'Người nhận phải khác người đang được vô hiệu hóa.';
      if (code === 'transfer_recipient_ineligible') return 'Người nhận không còn đủ quyền hoặc phạm vi dữ liệu phù hợp.';
      if (code === 'workload_changed') return 'Danh sách công việc vừa thay đổi. Đóng hộp thoại và kiểm tra lại.';
      if (code === 'last_super_admin_required') return 'Không thể vô hiệu hóa quản trị viên cuối cùng.';
      if (code === 'cannot_deactivate_self') return 'Không thể vô hiệu hóa chính tài khoản đang thao tác.';
      if (code === 'change_reason_required') return 'Lý do phải có từ 8 đến 500 ký tự.';
      if (code === 'idempotency_key_conflict') return 'Yêu cầu bị trùng mã nhưng khác nội dung. Hãy mở lại hộp thoại.';
      return 'Không thể hoàn tất vô hiệu hóa. Hãy kiểm tra và thử lại.';
    };
    const result = await new Promise((resolve) => {
      const modal = $('user-offboard-modal');
      const form = $('user-offboard-form');
      const loading = $('user-offboard-loading');
      const content = $('user-offboard-content');
      const summary = $('user-offboard-summary');
      const recipientField = $('user-offboard-recipient-field');
      const recipient = $('user-offboard-recipient');
      const recipientNote = $('user-offboard-recipient-note');
      const reason = $('user-offboard-reason');
      const submit = $('user-offboard-submit');
      if (!modal || !form || !loading || !content || !summary || !recipientField
          || !recipient || !recipientNote || !reason || !submit) {
        resolve(null);
        return;
      }
      let workload = null;
      let inFlight = false;
      const idempotencyKey = globalThis.crypto?.randomUUID
        ? `offboard-ui-${globalThis.crypto.randomUUID()}`
        : `offboard-ui-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      $('user-offboard-identity').textContent = email;
      loading.classList.remove('hidden');
      content.classList.add('hidden');
      recipientField.classList.add('hidden');
      recipient.replaceChildren(el('option', { text: 'Chọn người nhận bàn giao', attrs: { value: '' } }));
      recipientNote.textContent = '';
      reason.value = '';
      setMsg('user-offboard-error', '');
      submit.textContent = 'Vô hiệu hóa';
      submit.disabled = true;
      modal.classList.remove('hidden');

      const cleanup = () => {
        form.removeEventListener('submit', onSubmit);
        $('user-offboard-cancel')?.removeEventListener('click', onCancel);
        $('user-offboard-close')?.removeEventListener('click', onCancel);
        recipient.removeEventListener('change', syncSubmit);
        reason.removeEventListener('input', syncSubmit);
        modal.removeEventListener('click', onBackdrop);
      };
      const close = (value) => {
        cleanup();
        modal.classList.add('hidden');
        resolve(value);
      };
      const onCancel = () => { if (!inFlight) close(null); };
      const onBackdrop = (event) => { if (event.target === modal && !inFlight) close(null); };
      const syncSubmit = () => {
        const validReason = reason.value.trim().length >= 8 && reason.value.trim().length <= 500;
        const hasRecipient = !workload?.summary?.total || Boolean(recipient.value);
        submit.disabled = inFlight || !workload || !validReason || !hasRecipient
          || (Boolean(workload?.summary?.total) && !(workload?.eligible_recipients || []).length);
      };
      const onSubmit = async (event) => {
        event.preventDefault();
        syncSubmit();
        if (submit.disabled || inFlight) return;
        inFlight = true;
        const stopLoading = setButtonLoading(submit,
          workload.summary.total ? 'Đang chuyển giao…' : 'Đang vô hiệu hóa…');
        setMsg('user-offboard-error', '');
        const response = await withActionRequestContext({
          actionId: 'authorization.user_deactivate', mutation: true, idempotencyKey,
        }, () => api(`/admin/users/${encodeURIComponent(userId)}/offboard`, {
          method: 'POST',
          body: {
            reason: reason.value.trim(),
            ...(workload.summary.total ? { transfer_to_user_id: recipient.value } : {}),
          },
        }));
        inFlight = false;
        stopLoading();
        if (!response.ok) {
          setMsg('user-offboard-error', errorMessage(response), 'err');
          syncSubmit();
          return;
        }
        close(response);
      };
      form.addEventListener('submit', onSubmit);
      $('user-offboard-cancel')?.addEventListener('click', onCancel);
      $('user-offboard-close')?.addEventListener('click', onCancel);
      recipient.addEventListener('change', syncSubmit);
      reason.addEventListener('input', syncSubmit);
      modal.addEventListener('click', onBackdrop);

      api(`/admin/users/${encodeURIComponent(userId)}/workload`).then((response) => {
        loading.classList.add('hidden');
        content.classList.remove('hidden');
        if (!response.ok) {
          setMsg('user-offboard-error', errorMessage(response), 'err');
          syncSubmit();
          return;
        }
        workload = response.data;
        const counts = workload.summary || {};
        summary.replaceChildren();
        if (!counts.total) {
          summary.textContent = 'Người dùng không còn công việc active cần bàn giao.';
          recipientField.classList.add('hidden');
          submit.textContent = 'Vô hiệu hóa';
        } else {
          summary.appendChild(el('strong', { text: `Có ${counts.total} công việc cần bàn giao` }));
          const list = el('ul', { className: 'mt-2' });
          if (counts.evaluation_tickets) list.appendChild(el('li', { text: `${counts.evaluation_tickets} phiếu đánh giá` }));
          if (counts.evaluation_approval_tasks) list.appendChild(el('li', { text: `${counts.evaluation_approval_tasks} nhiệm vụ duyệt đánh giá` }));
          if (counts.approval_stage_assignments) list.appendChild(el('li', { text: `${counts.approval_stage_assignments} phân công tuyến phê duyệt` }));
          summary.appendChild(list);
          recipientField.classList.remove('hidden');
          for (const user of workload.eligible_recipients || []) {
            recipient.appendChild(el('option', {
              text: user.display_name ? `${user.display_name} · ${user.email}` : user.email,
              attrs: { value: user.user_id },
            }));
          }
          if (!(workload.eligible_recipients || []).length) {
            recipientNote.textContent = 'Không có người đang hoạt động và đủ quyền/phạm vi để nhận toàn bộ công việc.';
            setMsg('user-offboard-error', 'Cần bổ sung người nhận phù hợp trước khi vô hiệu hóa.', 'err');
          } else {
            recipientNote.textContent = 'Danh sách chỉ gồm người đang hoạt động và đủ quyền/phạm vi cho toàn bộ công việc.';
          }
          submit.textContent = 'Chuyển giao & vô hiệu hóa';
        }
        syncSubmit();
        reason.focus();
      });
    });
    if (result?.ok) {
      const transferredCount = Number(result.data?.transferred_count || 0);
      showToast(transferredCount
        ? `Đã chuyển giao ${transferredCount} công việc và vô hiệu hóa ${email}.`
        : `Đã vô hiệu hóa ${email}.`, 'ok');
      await loadAdmin(true);
    }
    return result;
  }

  async function reactivateUser(userId, email = userId) {
    const reason = await confirmAction({
      title: 'Mở lại tài khoản?',
      message: `${email} sẽ có thể đăng nhập lại với nguyên vai trò và phạm vi hiện có.`,
      cancelLabel: 'Hủy',
      confirmLabel: 'Mở lại tài khoản',
      reasonRequired: true,
      reasonPlaceholder: `Lý do mở lại ${email}`,
    });
    if (!reason) return;
    const response = await api(`/admin/users/${encodeURIComponent(userId)}/reactivate`, {
      method: 'PATCH', body: { reason },
    });
    if (response.ok) {
      showToast(`Đã mở lại tài khoản ${email}; vai trò và phạm vi được giữ nguyên.`, 'ok');
      loadAdmin();
    } else {
      showToast('Không mở lại được tài khoản. Hãy thử lại.', 'err');
    }
  }

  bindRegisteredAction($('btn-save-template'), 'question_template.save', saveQuestionTemplate, { announceSuccess: false });
  bindRegisteredAction($('btn-new-template'), 'question_template.create', () => { resetTemplateForm(); resetQuestionForm(); renderAdminQuestions(); }, { announceSuccess: false });
  if ($('question-template-select')) $('question-template-select').addEventListener('change', async (e) => {
    state.selectedQuestionTemplateId = e.target.value;
    state.selectedQuestionVersionId = '';
    state.questionImportPreview = null;
    const selected = state.questionTemplates.find((t) => String(t.id) === state.selectedQuestionTemplateId);
    if (selected) fillTemplateForm(selected);
    resetQuestionForm();
    await loadQuestionVersions();
    await loadAdminQuestions();
  });
  if ($('question-version-select')) $('question-version-select').addEventListener('change', (event) => {
    state.selectedQuestionVersionId = event.target.value;
    state.questionImportPreview = null;
    if ($('question-import-file')) $('question-import-file').value = '';
    renderQuestionImport();
  });
  if ($('question-import-accept-partial')) $('question-import-accept-partial').addEventListener('change', renderQuestionImport);
  bindRegisteredAction($('question-version-clone-draft'), 'question_version.clone_draft', createQuestionVersionDraft, {
    announceSuccess: false,
    objectIdentity: () => selectedQuestionVersion() ? `v${selectedQuestionVersion().version_no}` : '',
  });
  bindRegisteredAction($('question-import-preview'), 'question_import.preview', previewQuestionImport, { announceSuccess: false });
  bindRegisteredAction($('question-import-commit'), 'question_import.commit', commitQuestionImport, {
    announceSuccess: false,
    objectIdentity: () => state.questionImportPreview?.batch?.public_id || '',
    context: () => actionContext(selectedQuestionVersion(), {
      preconditions: { preview_confirmed: !!state.questionImportPreview?.confirmation_token },
    }),
  });
  bindRegisteredAction($('question-import-rollback'), 'question_import.rollback', rollbackQuestionImport, {
    announceSuccess: false,
    objectIdentity: () => state.questionImportPreview?.batch?.public_id || '',
    context: () => actionContext(selectedQuestionVersion()),
  });
  bindRegisteredAction($('question-import-errors'), 'question_import.export_errors', downloadQuestionImportErrors, { announceSuccess: false });
  bindRegisteredAction($('btn-save-question'), 'question.save', saveQuestion, { announceSuccess: false });
  bindRegisteredAction($('btn-new-question'), 'question.create', resetQuestionForm, { announceSuccess: false });
  if ($('question-elimination')) $('question-elimination').addEventListener('change', syncQuestionEvidenceControl);
  bindRegisteredAction($('question-new-template'), 'question_template.create', () => {
    $('question-create-card')?.classList.remove('hidden');
    $('question-create-code')?.focus();
  }, { announceSuccess: false });
  bindRegisteredAction($('question-create-cancel'), 'dialog.cancel', () => $('question-create-card')?.classList.add('hidden'), { announceSuccess: false });
  bindRegisteredAction($('question-create-submit'), 'question_template.create', createQuestionWorkspaceTemplate, { announceSuccess: false });
  bindRegisteredAction($('question-catalog-apply'), 'question_template.filter_apply', loadQuestionWorkspace, { announceSuccess: false });
  bindRegisteredAction($('question-catalog-reset'), 'question_template.filter_reset', () => {
    for (const id of ['question-catalog-search', 'question-catalog-status', 'question-catalog-facility', 'question-catalog-scale']) if ($(id)) $(id).value = '';
    loadQuestionWorkspace();
  }, { announceSuccess: false });
  if ($('question-catalog-search')) $('question-catalog-search').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); loadQuestionWorkspace(); }
  });
  $('question-catalog-status')?.addEventListener('change', loadQuestionWorkspace);
  bindRegisteredAction($('question-open-history'), 'question_template.tab_open', () => setQuestionWorkspaceTab('versions', { focus: true }), { announceSuccess: false });
  document.querySelectorAll('[data-question-tab]').forEach((button) => {
    bindRegisteredAction(button, 'question_template.tab_open', () => setQuestionWorkspaceTab(button.dataset.questionTab), { announceSuccess: false });
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const current = QUESTION_WORKSPACE_TABS.indexOf(button.dataset.questionTab);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? QUESTION_WORKSPACE_TABS.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + QUESTION_WORKSPACE_TABS.length) % QUESTION_WORKSPACE_TABS.length;
      setQuestionWorkspaceTab(QUESTION_WORKSPACE_TABS[next], { focus: true });
    });
  });
  if ($('question-workspace-version-select')) $('question-workspace-version-select').addEventListener('change', async (event) => {
    const previous = state.selectedQuestionVersionId;
    if (!confirmQuestionWorkspaceDiscard()) { event.target.value = previous; return; }
    state.selectedQuestionVersionId = event.target.value;
    state.questionImportPreview = null;
    state.questionImportStep = 'select';
    if ($('question-workspace-live')) $('question-workspace-live').textContent = '';
    syncQuestionWorkspaceUrl();
    await loadQuestionWorkspaceVersion();
  });
  for (const id of ['question-version-note', 'question-version-effective-from', 'question-version-effective-to']) {
    if ($(id)) $(id).addEventListener('input', () => { if (isQuestionVersionEditable()) markQuestionWorkspaceDirty(true); });
  }
  for (const id of ['question-item-search', 'question-item-category', 'question-item-active']) {
    if ($(id)) $(id).addEventListener(id === 'question-item-search' ? 'input' : 'change', renderVersionQuestions);
  }
  bindRegisteredAction($('question-add-item'), 'question.create', () => openQuestionEditor(null, $('question-add-item')), { announceSuccess: false });
  bindRegisteredAction($('question-bulk-deactivate'), 'question.bulk_deactivate', bulkDeactivateQuestionItems, {
    announceSuccess: false,
    objectIdentity: () => `${state.questionSelectedItemIds.length} câu hỏi`,
    context: () => actionContext(selectedQuestionVersion()),
  });
  bindRegisteredAction($('question-version-clone'), 'question_version.clone_draft', createQuestionWorkspaceDraft, { announceSuccess: false, objectIdentity: () => `v${selectedQuestionVersion()?.version_no || ''}` });
  bindRegisteredAction($('question-preview'), 'question_version.preview', openQuestionPreview, { announceSuccess: false, context: () => actionContext(selectedQuestionVersion()) });
  bindRegisteredAction($('question-validate'), 'question_version.validate', runQuestionVersionValidation, { announceSuccess: false, context: () => actionContext(selectedQuestionVersion()) });
  bindRegisteredAction($('question-save-draft'), 'question_version.save_draft', saveQuestionVersionDraft, { announceSuccess: false, context: () => actionContext(selectedQuestionVersion()) });
  bindRegisteredAction($('question-submit-review'), 'question_version.submit_review', () => transitionQuestionVersion('submit'), { announceSuccess: false, objectIdentity: () => `v${selectedQuestionVersion()?.version_no || ''}`, context: () => actionContext(selectedQuestionVersion()) });
  bindRegisteredAction($('question-publish'), 'question_version.publish', () => transitionQuestionVersion('publish'), { announceSuccess: false, objectIdentity: () => `v${selectedQuestionVersion()?.version_no || ''}`, context: () => actionContext(selectedQuestionVersion()) });
  bindRegisteredAction($('question-download-template'), 'question_import.download_template', downloadQuestionWorkspaceTemplate, { announceSuccess: false });
  bindRegisteredAction($('question-workspace-import-preview'), 'question_import.preview', previewQuestionWorkspaceImport, { announceSuccess: false });
  bindRegisteredAction($('question-workspace-import-commit'), 'question_import.commit', commitQuestionWorkspaceImport, { announceSuccess: false, objectIdentity: () => state.questionImportPreview?.batch?.public_id || '', context: () => actionContext(selectedQuestionVersion(), { preconditions: { preview_confirmed: !!state.questionImportPreview?.confirmation_token } }) });
  bindRegisteredAction($('question-workspace-import-rollback'), 'question_import.rollback', rollbackQuestionWorkspaceImport, { announceSuccess: false, objectIdentity: () => state.questionImportPreview?.batch?.public_id || '', context: () => actionContext(selectedQuestionVersion()) });
  bindRegisteredAction($('question-workspace-import-errors'), 'question_import.export_errors', downloadQuestionWorkspaceErrors, { announceSuccess: false });
  if ($('question-import-error-filter')) $('question-import-error-filter').addEventListener('change', renderQuestionWorkspaceImport);
  if ($('question-workspace-accept-partial')) $('question-workspace-accept-partial').addEventListener('change', renderQuestionWorkspaceImport);
  bindRegisteredAction($('question-editor-close'), 'dialog.close', closeQuestionEditor, { announceSuccess: false });
  bindRegisteredAction($('question-preview-close'), 'dialog.close', closeQuestionPreview, { announceSuccess: false });
  bindRegisteredAction($('question-editor-cancel'), 'dialog.cancel', closeQuestionEditor, { announceSuccess: false });
  bindRegisteredAction($('question-editor-save'), 'question.save', saveQuestionEditorItem, { announceSuccess: false });
  if ($('question-editor-elimination')) $('question-editor-elimination').addEventListener('change', () => {
    if ($('question-editor-elimination').checked) { $('question-editor-evidence').checked = false; $('question-editor-scores').value = 'A/D/NA'; }
    $('question-editor-evidence').disabled = $('question-editor-elimination').checked;
  });
  document.addEventListener('keydown', trapQuestionEditorFocus);
  document.addEventListener('keydown', trapQuestionPreviewFocus);
  bindRegisteredAction($('report-template-catalog-apply'), 'report_template.filter_apply', renderReportTemplatesAdmin, { announceSuccess: false });
  bindRegisteredAction($('report-template-create-draft'), 'report_template.create_draft', createReportTemplateDraft, {
    announceSuccess: false, resource: selectedReportDefinition, context: () => actionContext(selectedReportDefinition()),
    objectIdentity: () => state.selectedReportDefinitionCode || 'REPORT_TEMPLATE',
  });
  bindRegisteredAction($('report-template-save-draft'), 'report_template.save_draft', saveReportTemplateDraft, {
    announceSuccess: false, resource: () => state.reportTemplateVersionDetail,
    context: () => actionContext(state.reportTemplateVersionDetail), objectIdentity: () => state.reportTemplateVersionDetail?.version_name || '',
  });
  bindRegisteredAction($('report-template-validate'), 'report_template.validate', validateReportTemplateDraft, {
    announceSuccess: false, context: () => actionContext(state.reportTemplateVersionDetail),
  });
  bindRegisteredAction($('report-template-submit-review'), 'report_template.submit_review', () => transitionReportTemplate('submit'), {
    announceSuccess: false, context: () => actionContext(state.reportTemplateVersionDetail), objectIdentity: () => state.reportTemplateVersionDetail?.version_name || '',
  });
  bindRegisteredAction($('report-template-publish'), 'report_template.publish', () => transitionReportTemplate('publish'), {
    announceSuccess: false, context: () => actionContext(state.reportTemplateVersionDetail), objectIdentity: () => state.reportTemplateVersionDetail?.version_name || '',
  });
  bindRegisteredAction($('report-template-rollback'), 'report_template.rollback', () => transitionReportTemplate('rollback'), {
    announceSuccess: false, context: () => actionContext(state.reportTemplateVersionDetail), objectIdentity: () => state.reportTemplateVersionDetail?.version_name || '',
  });
  bindRegisteredAction($('report-template-preview-refresh'), 'report_template.preview', previewReportTemplateVersion, {
    announceSuccess: false, context: () => actionContext(state.reportTemplateVersionDetail),
  });
  bindRegisteredAction($('report-template-component-add'), 'report_template.component_add', addReportTemplateComponent, {
    announceSuccess: false, context: () => actionContext(state.reportTemplateVersionDetail),
  });
  bindRegisteredAction($('report-template-component-up'), 'report_template.component_move', () => moveReportTemplateComponent(-1), {
    announceSuccess: false, context: () => actionContext(state.reportTemplateVersionDetail),
  });
  bindRegisteredAction($('report-template-component-down'), 'report_template.component_move', () => moveReportTemplateComponent(1), {
    announceSuccess: false, context: () => actionContext(state.reportTemplateVersionDetail),
  });
  bindRegisteredAction($('report-template-advanced-apply'), 'report_template.advanced_json', applyAdvancedReportTemplateJson, {
    announceSuccess: false, context: () => actionContext(state.reportTemplateVersionDetail),
  });
  bindRegisteredAction($('report-template-import-package'), 'report_template.import_package', importReportTemplatePackage, {
    announceSuccess: false, context: () => actionContext(selectedReportDefinition()),
  });
  bindRegisteredAction($('report-template-export-package'), 'report_template.export_package', exportReportTemplatePackage, {
    announceSuccess: false, context: () => actionContext(state.reportTemplateVersionDetail),
  });
  document.querySelectorAll('[data-report-template-tab]').forEach((button) => bindRegisteredAction(button, 'report_template.tab_open', () => setReportTemplateTab(button.dataset.reportTemplateTab, { focus: true }), { announceSuccess: false }));
  bindRegisteredAction($('report-template-open-history'), 'report_template.tab_open', () => setReportTemplateTab('versions', { focus: true }), { announceSuccess: false });
  $('report-template-tabs')?.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = REPORT_TEMPLATE_TABS.indexOf(state.reportTemplateTab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? REPORT_TEMPLATE_TABS.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + REPORT_TEMPLATE_TABS.length) % REPORT_TEMPLATE_TABS.length;
    setReportTemplateTab(REPORT_TEMPLATE_TABS[next], { focus: true });
  });
  $('report-template-version-select')?.addEventListener('change', async (event) => {
    if (!confirmBusinessConfigRouteLeave(window.location.hash)) {
      event.target.value = state.selectedReportTemplateVersionId;
      return;
    }
    state.selectedReportTemplateVersionId = event.target.value;
    state.selectedReportComponentId = '';
    await loadReportTemplateVersionDetail();
  });
  $('report-template-search')?.addEventListener('input', renderReportTemplatesAdmin);
  $('report-template-status')?.addEventListener('change', renderReportTemplatesAdmin);
  $('report-template-component-title')?.addEventListener('input', (event) => updateSelectedReportComponent('title', event.target.value));
  $('report-template-component-binding')?.addEventListener('change', (event) => {
    const component = selectedReportTemplateComponent();
    updateSelectedReportComponent(component?.type === 'header' ? 'subtitle_binding' : 'binding', event.target.value);
  });
  $('report-template-component-text')?.addEventListener('input', (event) => updateSelectedReportComponent('text', event.target.value));
  for (const id of ['report-template-orientation', 'report-template-font-scale', 'report-template-accent']) {
    $(id)?.addEventListener(id === 'report-template-font-scale' ? 'input' : 'change', updateReportTemplateStyle);
  }
  for (const id of ['report-template-overview-layout', 'report-template-overview-chart', 'report-template-overview-legend']) {
    $(id)?.addEventListener('change', updateReportTemplateOverview);
  }
  $('report-template-component-tree')?.addEventListener('keydown', (event) => {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) return moveReportTemplateComponent(event.key === 'ArrowUp' ? -1 : 1);
    const components = reportTemplateComponents();
    const current = Math.max(0, components.findIndex((component) => component.id === state.selectedReportComponentId));
    const next = Math.max(0, Math.min(components.length - 1, current + (event.key === 'ArrowUp' ? -1 : 1)));
    state.selectedReportComponentId = components[next]?.id || '';
    renderReportTemplateComponentTree();
    renderReportTemplateProperties();
    $('report-template-component-tree')?.querySelector('[aria-selected="true"]')?.focus();
  });
  bindRegisteredAction($('scoring-policy-create-draft'), 'scoring_policy.create_draft', createScoringPolicyDraft, {
    announceSuccess: false, context: () => actionContext(state.scoringPolicyVersionDetail), objectIdentity: () => state.selectedScoringPolicyCode || 'SCORING_POLICY',
  });
  bindRegisteredAction($('scoring-policy-simulate'), 'scoring_policy.simulate', simulateScoringPolicy, {
    announceSuccess: false, context: () => actionContext(state.scoringPolicyVersionDetail),
  });
  bindRegisteredAction($('scoring-policy-impact'), 'scoring_policy.impact', analyzeScoringPolicyImpact, {
    announceSuccess: false, context: () => actionContext(state.scoringPolicyVersionDetail),
  });
  bindRegisteredAction($('scoring-policy-validate'), 'scoring_policy.validate', validateScoringPolicy, {
    announceSuccess: false, context: () => actionContext(state.scoringPolicyVersionDetail),
  });
  bindRegisteredAction($('scoring-policy-save-draft'), 'scoring_policy.save_draft', saveScoringPolicyDraft, {
    announceSuccess: false, context: () => actionContext(state.scoringPolicyVersionDetail),
  });
  bindRegisteredAction($('scoring-policy-submit-review'), 'scoring_policy.submit_review', () => transitionScoringPolicy('submit'), {
    announceSuccess: false, context: () => actionContext(state.scoringPolicyVersionDetail), objectIdentity: () => `v${state.scoringPolicyVersionDetail?.version_no || ''}`,
  });
  bindRegisteredAction($('scoring-policy-publish'), 'scoring_policy.publish', () => transitionScoringPolicy('publish'), {
    announceSuccess: false, context: () => actionContext(state.scoringPolicyVersionDetail), objectIdentity: () => `v${state.scoringPolicyVersionDetail?.version_no || ''}`,
  });
  bindRegisteredAction($('scoring-policy-rollback'), 'scoring_policy.rollback', () => transitionScoringPolicy('rollback'), {
    announceSuccess: false, context: () => actionContext(state.scoringPolicyVersionDetail), objectIdentity: () => `v${state.scoringPolicyVersionDetail?.version_no || ''}`,
  });
  document.querySelectorAll('[data-scoring-policy-tab]').forEach((button) => bindRegisteredAction(button, 'scoring_policy.tab_open', () => setScoringPolicyTab(button.dataset.scoringPolicyTab, { focus: true }), { announceSuccess: false }));
  bindRegisteredAction($('scoring-policy-open-history'), 'scoring_policy.tab_open', () => setScoringPolicyTab('versions', { focus: true }), { announceSuccess: false });
  $('scoring-policy-workspace')?.querySelector('.business-config-tabs')?.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = SCORING_POLICY_TABS.indexOf(state.scoringPolicyTab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? SCORING_POLICY_TABS.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + SCORING_POLICY_TABS.length) % SCORING_POLICY_TABS.length;
    setScoringPolicyTab(SCORING_POLICY_TABS[next], { focus: true });
  });
  $('scoring-policy-version-select')?.addEventListener('change', async (event) => {
    if (!confirmBusinessConfigRouteLeave(window.location.hash)) {
      event.target.value = state.selectedScoringPolicyVersionId;
      return;
    }
    state.selectedScoringPolicyVersionId = event.target.value;
    await loadScoringPolicyVersionDetail();
  });
  $('scoring-policy-search')?.addEventListener('input', renderScoringPolicyCatalog);
  $('scoring-policy-status-filter')?.addEventListener('change', renderScoringPolicyCatalog);
  for (const id of ['scoring-policy-note', 'scoring-policy-effective-from', 'scoring-policy-effective-to']) {
    $(id)?.addEventListener('input', () => {
      if (BUSINESS_CONFIG.actionState(state.scoringPolicyVersionDetail || {}, 'scoring_policy.save_draft').state === 'enabled') markScoringPolicyDirty(true);
    });
  }
  const scoringPolicyDefinitionControls = {
    'scoring-policy-overview-title': (definition, value) => { definition.compliance_overview.title = value; },
    'scoring-policy-default-reason': (definition, value) => { definition.default_reason = value; },
    'scoring-policy-pass-min': (definition, value) => { definition.final_conclusion.pass_min = Number(value); },
    'scoring-policy-lead-threshold': (definition, value) => { definition.workflow_thresholds.lead_submission_score_below = Number(value); },
    'scoring-policy-rounding-mode': (definition, value) => { definition.rounding.calculation_mode = value; },
    'scoring-policy-display-decimals': (definition, value) => { definition.rounding.display_decimals = Number(value); },
    'scoring-policy-elimination-clause': (definition, value) => { definition.elimination.clause_type = value; },
    'scoring-policy-elimination-score': (definition, value) => { definition.elimination.score = value; },
    'scoring-policy-elimination-forced': (definition, value) => { definition.elimination.forced_score = Number(value); },
    'scoring-policy-elimination-reason': (definition, value) => { definition.elimination.reason = value; },
  };
  Object.entries(scoringPolicyDefinitionControls).forEach(([id, update]) => {
    $(id)?.addEventListener('input', (event) => {
      if (!scoringPolicyDefinitionEditable()) return;
      update(scoringPolicyDefinition(), event.target.value);
      markScoringPolicyDefinitionDirty();
    });
  });
  window.addEventListener('beforeunload', (event) => {
    if (!businessConfigDirty()) return;
    event.preventDefault();
    event.returnValue = '';
  });

  window.addEventListener('hashchange', async () => {
    const requestedHash = window.location.hash;
    if (!personnelImportRouteBypass && personnelImportHasUnsaved() && requestedHash !== personnelImportStableHash) {
      window.history.replaceState(null, '', personnelImportStableHash || '#/admin/personnel-import');
      const discard = await confirmPersonnelImportRouteLeave(requestedHash);
      if (discard) {
        personnelImportRouteBypass = true;
        window.location.hash = requestedHash;
      }
      return;
    }
    personnelImportRouteBypass = false;
    if (!personnelImportHasUnsaved()) personnelImportStableHash = requestedHash;
    if (!authzRouteBypass && authzUnsaved && requestedHash !== authzStableHash) {
      window.history.replaceState(null, '', authzStableHash || '#/admin/users');
      const discard = await confirmAuthzRouteLeave(requestedHash);
      if (discard) {
        authzRouteBypass = true;
        window.location.hash = requestedHash;
      }
      return;
    }
    authzRouteBypass = false;
    authzStableHash = requestedHash;
    if (state.view === 'login' || state.view === 'otp') return;
    const resolution = resolveAuthorizedRoute();
    if (resolution.status === 'allowed' && resolution.item.id === state.tab && state.routeAccessStatus === 'allowed') {
      if (resolution.redirected_from && resolution.canonical_route) {
        window.history.replaceState(null, '', '#' + resolution.canonical_route);
      }
      if (state.tab === 'scoring') {
        const nextTicket = scoringTicketFromRoute();
        if (nextTicket !== state.scoringTicket) {
          state.scoringTicket = nextTicket;
          renderScoring();
        }
      }
      if (shouldShowGlobalPeriod()) {
        const nextPeriod = dashboardPeriodFromRoute();
        if (nextPeriod && nextPeriod !== state.month) {
          state.month = nextPeriod;
          state.dashboardPeriodNotice = '';
          rememberDashboardPeriod(nextPeriod);
          if (!state.dashboardPeriods.some((item) => item.value === nextPeriod)) {
            state.dashboardPeriods = REPORTING_PERIOD.normalizePeriods([
              ...state.dashboardPeriods,
              { value: nextPeriod, has_data: false, is_current: nextPeriod === currentMonthVN(), updated_at: null },
            ]);
          }
          renderDashboardPeriodControls();
          loadTab();
          return;
        }
      }
      if (state.tab === 'admin-question-templates') {
        const params = questionWorkspaceParams();
        const nextTemplate = params.get('template') || '';
        const nextVersion = params.get('version') || '';
        const nextTab = canonicalQuestionWorkspaceTab(params.get('tab'));
        const selectionChanged = nextTemplate !== state.selectedQuestionTemplateId || nextVersion !== state.selectedQuestionVersionId;
        const tabChanged = nextTab !== state.questionWorkspaceTab;
        if (selectionChanged || tabChanged) {
          if (selectionChanged && !confirmQuestionWorkspaceDiscard()) {
            syncQuestionWorkspaceUrl({ replace: true });
            return;
          }
          state.selectedQuestionTemplateId = nextTemplate;
          state.selectedQuestionVersionId = nextVersion;
          state.questionWorkspaceTab = nextTab;
          if (selectionChanged) loadQuestionWorkspace();
          else renderQuestionWorkspaceTabs();
        }
      }
      if (state.tab === 'admin-report-templates') {
        const params = reportTemplateParams();
        const nextDefinition = params.get('definition') || '';
        const nextVersion = params.get('version') || '';
        const nextTab = REPORT_TEMPLATE_TABS.includes(params.get('tab')) ? params.get('tab') : 'structure';
        const selectionChanged = nextDefinition !== state.selectedReportDefinitionCode || nextVersion !== state.selectedReportTemplateVersionId;
        const tabChanged = nextTab !== state.reportTemplateTab;
        if (selectionChanged || tabChanged) {
          if (selectionChanged && !confirmBusinessConfigRouteLeave(requestedHash)) {
            syncReportTemplateUrl({ replace: true });
            return;
          }
          if (selectionChanged) {
            state.selectedReportDefinitionCode = nextDefinition;
            state.selectedReportTemplateVersionId = nextVersion;
            loadReportTemplatesAdmin();
          } else {
            state.reportTemplateTab = nextTab;
            renderReportTemplateTabs();
          }
        }
      }
      if (state.tab === 'admin-scoring-policies') {
        const params = scoringPolicyParams();
        const nextPolicy = params.get('policy') || '';
        const nextVersion = params.get('version') || '';
        const nextTab = SCORING_POLICY_TABS.includes(params.get('tab')) ? params.get('tab') : 'overview';
        const selectionChanged = nextPolicy !== state.selectedScoringPolicyCode || nextVersion !== state.selectedScoringPolicyVersionId;
        const tabChanged = nextTab !== state.scoringPolicyTab;
        if (selectionChanged || tabChanged) {
          if (selectionChanged && !confirmBusinessConfigRouteLeave(requestedHash)) {
            syncScoringPolicyUrl({ replace: true });
            return;
          }
          if (selectionChanged) {
            state.selectedScoringPolicyCode = nextPolicy;
            state.selectedScoringPolicyVersionId = nextVersion;
            loadScoringPolicyWorkspace();
          } else {
            state.scoringPolicyTab = nextTab;
            renderScoringPolicyTabs();
          }
        }
      }
      return;
    }
    if (resolution.status === 'allowed' && GLOBAL_PERIOD_TABS.includes(resolution.item.id)) {
      const routePeriod = REPORTING_PERIOD.periodFromRoute(routePathFromHash());
      if (routePeriod) {
        state.month = routePeriod;
        state.dashboardPeriodNotice = '';
        rememberDashboardPeriod(routePeriod);
        if (!state.dashboardPeriods.some((item) => item.value === routePeriod)) {
          state.dashboardPeriods = REPORTING_PERIOD.normalizePeriods([
            ...state.dashboardPeriods,
            { value: routePeriod, has_data: false, is_current: routePeriod === currentMonthVN(), updated_at: null },
          ]);
        }
        renderDashboardPeriodControls();
      }
    }
    if (activateRouteResolution(resolution, { updateHash: false })) loadTab();
  });

  // ============ Bootstrap ============
  hydrateStaticActionButtons();
  enhanceInputSemantics();
  initMobileFilters();
  initMerchandisingSelects();
  initMasterDataSelects();
  api('/auth/me').then((r) => {
    if (r.ok) {
      applySession(r.data);
      const resolution = resolveAuthorizedRoute();
      if (activateRouteResolution(resolution, { updateHash: false })) {
        loadMonths().then(() => loadTab());
      }
    } else {
      setView('login');
    }
  });
})();

