const API_ERROR_MESSAGES = Object.freeze({
  internal_error: 'Hệ thống gặp lỗi nội bộ. Vui lòng thử lại.',
  file_too_large: 'File vượt quá dung lượng cho phép (10MB).',
  only_xlsx_allowed: 'Chỉ chấp nhận file Excel định dạng .xlsx.',
  file_type_not_allowed: 'Định dạng file không được hỗ trợ.',
  file_upload_failed: 'Không tải file lên được. Vui lòng thử lại.',
  file_required: 'Vui lòng chọn file Excel.',
  invalid_workbook: 'File Excel không đọc được. Vui lòng kiểm tra lại file.',
  sheet_required: 'Không tìm thấy worksheet cần nhập.',
  template_invalid: 'File Excel thiếu cột bắt buộc.',
  no_valid_rows: 'File Excel không có dòng dữ liệu hợp lệ.',
  too_many_uploads: 'Tải lên quá nhiều lần. Chờ vài phút rồi thử lại.',
  supplier_code_exists: 'Mã NCC đã tồn tại.',
  supplier_not_found: 'Không tìm thấy NCC.',
  merchandising_invalid: 'Vui lòng chọn MCH2/MCH3 hợp lệ.',
  invalid_merchandising: 'Vui lòng chọn MCH2/MCH3 hợp lệ.',
  ticket_not_found: 'Không tìm thấy phiếu đánh giá.',
  ticket_locked: 'Phiếu đánh giá đã khóa.',
  round_not_found: 'Không tìm thấy lần đánh giá.',
  round_locked: 'Lần đánh giá đã khóa.',
  round_load_failed: 'Không tải được dữ liệu lần đánh giá.',
  round_answers_update_failed: 'Không lưu được câu trả lời.',
  round_complete_failed: 'Không hoàn thành được lần đánh giá.',
  round_2_exists: 'Đánh giá lần 2 đã tồn tại.',
  round_2_failed: 'Không tạo được đánh giá lần 2.',
  round_2_create_failed: 'Không tạo được đánh giá lần 2.',
  round_2_not_allowed: 'Phiếu chưa đủ điều kiện đánh giá lần 2.',
  round_2_not_passed_required: 'Chỉ gửi đề xuất khi đánh giá lần 2 không đạt.',
  missing_corrective_requirements: 'Còn thiếu Yêu cầu khắc phục hoặc Thời hạn khắc phục cho điểm không phù hợp.',
  missing_required_nonconformity_actions: 'Còn thiếu Yêu cầu khắc phục hoặc Thời hạn khắc phục cho điểm không phù hợp.',
  supplier_introduction_required: 'Vui lòng nhập Giới thiệu NCC trước khi hoàn thành đánh giá.',
  lead_submission_not_eligible: 'Chỉ được gửi Lead miền duyệt khi điểm đánh giá dưới 60% hoặc có ít nhất một điều khoản chính yếu điểm D.',
  invalid_remediation: 'Vui lòng chọn Yêu cầu khắc phục trong danh mục.',
  due_date_invalid: 'Thời hạn khắc phục không hợp lệ.',
  extension_reason_required: 'Vui lòng nhập lý do gia hạn.',
  extension_due_date_required: 'Vui lòng nhập thời hạn khắc phục mới.',
  extension_due_date_invalid: 'Thời hạn mới không hợp lệ.',
  extension_create_failed: 'Không lưu được gia hạn khắc phục.',
  correction_fields_locked: 'Dữ liệu yêu cầu khắc phục và thời hạn khắc phục đã khóa. Chỉ có thể chỉnh sửa khi phiếu đang xử lý hoặc được trả về.',
  audit_cursor_invalid: 'Con trỏ phân trang nhật ký không hợp lệ. Hãy tải lại danh sách.',
  audit_export_time_range_required: 'Cần chọn đầy đủ thời điểm bắt đầu và kết thúc để xuất nhật ký.',
  audit_export_time_range_too_large: 'Khoảng thời gian xuất nhật ký vượt quá giới hạn cho phép.',
  audit_export_row_limit_exceeded: 'Số dòng xuất vượt quá giới hạn. Hãy thu hẹp bộ lọc hoặc khoảng thời gian.',
  audit_export_format_invalid: 'Định dạng xuất nhật ký không được hỗ trợ.',
  audit_event_not_found: 'Không tìm thấy sự kiện audit.',
  forbidden_permission: 'Bạn không có quyền thực hiện thao tác này.',
  forbidden_scope: 'Phạm vi dữ liệu hiện tại không cho phép thao tác này.',
});

const UI_TEXT = Object.freeze({
  common: Object.freeze({
    edit: 'Sửa',
    delete: 'Xóa',
    deactivate: 'Tắt',
    action: 'Thao tác',
    evidence: 'Bằng chứng',
    downloadPdf: 'Tải PDF',
    statusActive: 'Đang hoạt động',
    statusInactive: 'Không hoạt động',
    statusSuspended: 'Tạm ngưng',
    statusLocked: 'Đã khóa',
    statusOk: 'Thành công',
    statusPartial: 'Một phần',
    statusFailed: 'Thất bại',
  }),
  workflow: Object.freeze({
    loadFailed: 'Không tải được dữ liệu phiếu đánh giá. Hãy kiểm tra kết nối rồi thử lại.',
  }),
  suppliers: Object.freeze({
    loadFailed: 'Không tải được danh mục NCC. Hãy kiểm tra kết nối rồi thử lại.',
    loading: 'Đang tải danh mục NCC...',
    emptyFiltered: 'Không có NCC phù hợp với bộ lọc hiện tại. Hãy xóa lọc hoặc tải Excel danh mục NCC lên.',
    detailLoadFailed: 'Không tải được thông tin NCC. Hãy mở lại danh sách NCC rồi thử lại.',
    importedFromDirectory: 'Đã lấy thông tin từ danh mục NCC. Có thể chỉnh thông tin lưu trên phiếu nếu cần.',
    importHelp: 'Dùng file mẫu chuẩn. Bắt buộc có supplier_code, supplier_name, mch2 và mch3.',
    importStarted: 'Đang nhập danh sách NCC...',
    importFailed: 'Không nhập được danh sách NCC. Toàn bộ file đã được giữ nguyên, hãy sửa các dòng báo lỗi rồi thử lại.',
    importSummary(summary) {
      const status = statusText(summary.status);
      return `Nhập dữ liệu ${status}: ${summary.successRows || 0}/${summary.totalRows || 0} dòng hợp lệ, lỗi ${summary.failedRows || 0}.`;
    },
  }),
  reports: Object.freeze({
    chooseTemplate: 'Chọn mẫu báo cáo trước.',
    exportingPdf: 'Đang xuất PDF...',
    exportPdfFailed: 'Không xuất được PDF. Hãy chọn mẫu báo cáo rồi thử lại.',
    exportReportFailed: 'Không xuất được báo cáo. Hãy kiểm tra phiếu rồi thử lại.',
    reportTypes: Object.freeze({
      WORKING_MINUTES: 'Biên bản làm việc với NCC',
      ROUND1_RESULT: 'Kết quả đánh giá lần 1',
      ROUND2_RESULT: 'Kết quả đánh giá lần 2',
      INTERNAL: 'Báo cáo nội bộ',
      NCC: 'Báo cáo NCC',
    }),
  }),
  admin: Object.freeze({
    noTemplateSelected: 'Chưa chọn biểu mẫu. Hãy chọn một biểu mẫu để xem câu hỏi.',
    noQuestionsForTemplate: 'Chưa có câu hỏi cho biểu mẫu này. Hãy tạo câu hỏi mới hoặc chọn biểu mẫu khác.',
    saveTemplateFailed: 'Không lưu được biểu mẫu. Hãy kiểm tra mã và tên biểu mẫu rồi thử lại.',
    templateSaved: 'Đã lưu biểu mẫu.',
    chooseTemplate: 'Vui lòng chọn biểu mẫu.',
    previewReportTemplate: 'Xem mẫu',
    saveReportTemplateFailed: 'Không lưu được mẫu báo cáo. Hãy kiểm tra tên, loại báo cáo và nội dung mẫu rồi thử lại.',
    reportTemplateSaved: 'Đã lưu mẫu báo cáo.',
    deactivateReportTemplateConfirm: 'Tắt mẫu báo cáo này?',
    deactivateReportTemplateFailed: 'Không tắt được mẫu báo cáo. Hãy tải lại danh sách rồi thử lại.',
    reportTemplateDeactivated: 'Đã tắt mẫu báo cáo.',
  }),
  emptyStates: Object.freeze({
    criteriaPreview: 'Chưa có dữ liệu tiêu chí để xem trước. Hãy chọn biểu mẫu có câu hỏi đang hoạt động.',
    notIngested: 'Chưa nhập dữ liệu',
    noPeriodData: 'Chưa có dữ liệu kỳ này',
  }),
});

function apiErrorMessage(errorCode, fallback = 'Không thực hiện được thao tác. Vui lòng thử lại.') {
  return API_ERROR_MESSAGES[errorCode] || fallback;
}

function statusText(status) {
  const key = String(status || '').trim().toUpperCase();
  const labels = {
    ACTIVE: UI_TEXT.common.statusActive,
    INACTIVE: UI_TEXT.common.statusInactive,
    SUSPENDED: UI_TEXT.common.statusSuspended,
    LOCKED: UI_TEXT.common.statusLocked,
    OK: UI_TEXT.common.statusOk,
    COMPLETED: UI_TEXT.common.statusOk,
    PARTIAL: UI_TEXT.common.statusPartial,
    FAILED: UI_TEXT.common.statusFailed,
  };
  return labels[key] || String(status || '');
}

function reportTypeText(type) {
  const key = String(type || '').trim().toUpperCase();
  return UI_TEXT.reports.reportTypes[key] || String(type || '');
}

export { API_ERROR_MESSAGES, UI_TEXT, apiErrorMessage, reportTypeText, statusText };
