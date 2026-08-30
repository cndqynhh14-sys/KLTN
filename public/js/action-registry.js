(function initActionRegistry(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.QLCL_ACTIONS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function actionRegistryFactory() {
  'use strict';

  const ACTION_VERSION = 15;
  const variants = new Set(['primary', 'secondary', 'ghost', 'danger']);
  const placements = new Set(['page', 'form', 'row', 'empty', 'dialog', 'control']);

  function define(actionId, label, options = {}) {
    const mutation = options.mutation === true;
    return Object.freeze({
      action_id: actionId,
      label,
      short_label: options.short_label || label,
      icon: options.icon || 'action',
      variant: options.variant || 'secondary',
      placement: options.placement || 'control',
      permission: options.permission || null,
      entity: options.entity || 'UI',
      allowed_statuses: Object.freeze([...(options.allowed_statuses || [])]),
      preconditions: Object.freeze([...(options.preconditions || [])]),
      confirm: Object.freeze({
        required: options.confirm?.required === true,
        exact: options.confirm?.exact || null,
        include_object: options.confirm?.include_object === true,
        consequence: options.confirm?.consequence || '',
      }),
      reason: Object.freeze({ required: options.reason?.required === true }),
      idempotency: Object.freeze({
        required: mutation || options.idempotency?.required === true,
        header: 'Idempotency-Key',
      }),
      success: Object.freeze({ message: options.success || (mutation ? 'Đã hoàn tất thao tác.' : '') }),
      event: options.event || null,
      mutation,
      backend_action: options.backend_action || null,
      version: ACTION_VERSION,
    });
  }

  const destructive = (consequence, exact = null) => ({
    required: true, include_object: true, consequence, exact,
  });

  const ACTION_REGISTRY = Object.freeze([
    define('question_template.filter_apply', 'Áp dụng bộ lọc biểu mẫu câu hỏi', { icon: 'search', permission: 'QUESTION_TEMPLATE.MANAGE', entity: 'QUESTION_TEMPLATE' }),
    define('question_template.filter_reset', 'Xóa bộ lọc biểu mẫu câu hỏi', { icon: 'refresh', permission: 'QUESTION_TEMPLATE.MANAGE', entity: 'QUESTION_TEMPLATE' }),
    define('question_template.tab_open', 'Mở tab workspace bộ câu hỏi', { icon: 'arrow', permission: 'QUESTION_TEMPLATE.MANAGE', entity: 'QUESTION_TEMPLATE' }),
    define('question_version.preview', 'Xem trước phiên bản câu hỏi', { short_label: 'Xem trước', icon: 'eye', placement: 'form', permission: 'QUESTION_TEMPLATE.MANAGE', entity: 'QUESTION_TEMPLATE', allowed_statuses: ['DRAFT', 'IN_REVIEW', 'PUBLISHED', 'RETIRED'], backend_action: 'question_version.preview' }),
    define('question_version.validate', 'Kiểm tra phiên bản câu hỏi', { short_label: 'Kiểm tra', icon: 'check', placement: 'form', permission: 'QUESTION_TEMPLATE.MANAGE', entity: 'QUESTION_TEMPLATE', allowed_statuses: ['DRAFT', 'IN_REVIEW', 'PUBLISHED', 'RETIRED'], backend_action: 'question_version.validate' }),
    define('question_version.save_draft', 'Lưu nháp phiên bản câu hỏi', { short_label: 'Lưu nháp', icon: 'save', variant: 'primary', placement: 'form', permission: 'QUESTION_TEMPLATE.MANAGE', entity: 'QUESTION_TEMPLATE', allowed_statuses: ['DRAFT'], backend_action: 'question_version.save_draft', mutation: true, success: 'Đã lưu Draft bộ câu hỏi.', event: 'question.template.changed' }),
    define('question_version.submit_review', 'Gửi duyệt phiên bản câu hỏi', { short_label: 'Gửi duyệt', icon: 'send', placement: 'form', permission: 'QUESTION_TEMPLATE.MANAGE', entity: 'QUESTION_TEMPLATE', allowed_statuses: ['DRAFT'], backend_action: 'question_version.submit_review', confirm: { required: true, include_object: true, consequence: 'Phiên bản sẽ chuyển sang Review và không còn chỉnh sửa nội dung.' }, mutation: true, success: 'Đã gửi phiên bản câu hỏi để duyệt.', event: 'question.template.changed' }),
    define('question_version.publish', 'Publish phiên bản câu hỏi', { short_label: 'Publish', icon: 'check', variant: 'primary', placement: 'form', permission: 'QUESTION_TEMPLATE.MANAGE', entity: 'QUESTION_TEMPLATE', allowed_statuses: ['IN_REVIEW'], backend_action: 'question_version.publish', confirm: { required: true, include_object: true, consequence: 'Phiên bản Published trở thành mặc định cho phiếu mới trong các phạm vi của nó.' }, mutation: true, success: 'Đã publish phiên bản câu hỏi.', event: 'question.template.changed' }),
    define('question_version.rollback_default', 'Khôi phục phiên bản mặc định', { icon: 'return', placement: 'form', permission: 'QUESTION_TEMPLATE.MANAGE', entity: 'QUESTION_TEMPLATE', allowed_statuses: ['PUBLISHED', 'RETIRED'], backend_action: 'question_version.rollback_default', confirm: { required: true, include_object: true, consequence: 'Phiên bản được chọn sẽ là mặc định cho phiếu mới; phiếu cũ vẫn giữ phiên bản đã pin.' }, mutation: true, success: 'Đã đổi phiên bản mặc định cho phiếu mới.', event: 'question.template.changed' }),
    define('question.bulk_deactivate', 'Tắt các câu hỏi đã chọn', { icon: 'close', variant: 'danger', placement: 'form', permission: 'QUESTION_TEMPLATE.MANAGE', entity: 'QUESTION_TEMPLATE', allowed_statuses: ['DRAFT'], confirm: destructive('Các câu hỏi đã chọn sẽ bị tắt trong Draft; phiên bản Published và phiếu cũ không thay đổi.'), mutation: true, success: 'Đã tắt các câu hỏi đã chọn trong Draft.', event: 'question.template.changed' }),
    define('question.reorder', 'Sắp xếp câu hỏi trong Draft', { icon: 'sort', placement: 'row', permission: 'QUESTION_TEMPLATE.MANAGE', entity: 'QUESTION_TEMPLATE', allowed_statuses: ['DRAFT'], mutation: true, success: 'Đã cập nhật thứ tự câu hỏi trong Draft.', event: 'question.template.changed' }),
    define('question_import.download_template', 'Tải file mẫu bộ câu hỏi', { icon: 'download', placement: 'page', permission: 'QUESTION_TEMPLATE.MANAGE', entity: 'QUESTION_TEMPLATE' }),
    define('navigation.open', 'Mở chức năng', { icon: 'arrow', entity: 'NAVIGATION' }),
    define('navigation.toggle', 'Thu gọn hoặc mở rộng điều hướng', { icon: 'menu', entity: 'NAVIGATION' }),
    define('navigation.group_toggle', 'Thu gọn hoặc mở rộng nhóm điều hướng', { icon: 'menu', entity: 'NAVIGATION' }),
    define('navigation.back', 'Quay lại màn hình trước', { icon: 'arrow', entity: 'NAVIGATION' }),
    define('navigation.more', 'Mở thêm chức năng', { icon: 'more', entity: 'NAVIGATION' }),
    define('notification.open', 'Mở thông báo', { icon: 'bell', entity: 'NOTIFICATION' }),
    define('notification.filter', 'Lọc thông báo', { icon: 'filter', entity: 'NOTIFICATION' }),
    define('notification.mark_all', 'Đánh dấu tất cả thông báo đã đọc', { icon: 'check', entity: 'NOTIFICATION', mutation: true, success: 'Đã đánh dấu tất cả thông báo là đã đọc.', event: 'notification.read' }),
    define('workspace.open', 'Mở xử lý', { short_label: 'Mở xử lý', icon: 'arrow', variant: 'primary', placement: 'row', entity: 'WORKSPACE' }),
    define('workspace.previous_page', 'Mở trang công việc trước', { icon: 'arrow', entity: 'WORKSPACE' }),
    define('workspace.next_page', 'Mở trang công việc sau', { icon: 'arrow', entity: 'WORKSPACE' }),
    define('dialog.close', 'Đóng hộp thoại', { icon: 'close', placement: 'dialog' }),
    define('dialog.cancel', 'Bỏ thay đổi và đóng', { icon: 'close', placement: 'dialog' }),
    define('confirmation.accept', 'Xác nhận thao tác', { icon: 'check', placement: 'dialog', variant: 'primary' }),
    define('confirmation.cancel', 'Giữ nguyên dữ liệu', { icon: 'close', placement: 'dialog' }),
    define('form.clear_selection', 'Xóa lựa chọn', { icon: 'close', placement: 'form' }),
    define('form.toggle_selection', 'Chọn hoặc bỏ lựa chọn', { icon: 'check', placement: 'form' }),
    define('form.remove_selection', 'Bỏ một lựa chọn', { icon: 'close', placement: 'form' }),
    define('collection.load_more', 'Tải thêm kết quả', { icon: 'more' }),
    define('collection.toggle_detail', 'Mở hoặc thu gọn chi tiết', { icon: 'arrow' }),
    define('filter.open', 'Mở bộ lọc', { icon: 'filter' }),
    define('filter.close', 'Đóng bộ lọc', { icon: 'close' }),
    define('filter.retry', 'Thử tải lại dữ liệu', { icon: 'refresh' }),
    define('dashboard.period_previous', 'Xem kỳ báo cáo trước', { icon: 'arrow', permission: 'DASHBOARD.READ', entity: 'DASHBOARD' }),
    define('dashboard.period_next', 'Xem kỳ báo cáo sau', { icon: 'arrow', permission: 'DASHBOARD.READ', entity: 'DASHBOARD' }),
    define('dashboard.period_current', 'Về kỳ báo cáo hiện tại', { icon: 'refresh', permission: 'DASHBOARD.READ', entity: 'DASHBOARD' }),
    define('dashboard.period_type', 'Đổi loại kỳ báo cáo', { icon: 'calendar', permission: 'DASHBOARD.READ', entity: 'DASHBOARD' }),
    define('dashboard.mode', 'Đổi chế độ dashboard', { icon: 'layout-dashboard', permission: 'DASHBOARD.READ', entity: 'DASHBOARD' }),
    define('dashboard.refresh', 'Làm mới bộ lọc dashboard đánh giá NCC', { icon: 'refresh', placement: 'page', permission: 'DASHBOARD.READ', entity: 'DASHBOARD' }),
    define('session.logout', 'Đăng xuất', { icon: 'logout', entity: 'AUTH', mutation: true, success: 'Đã đăng xuất.', event: 'auth.logout.succeeded' }),
    define('auth.request_otp', 'Gửi mã xác thực', { icon: 'send', entity: 'AUTH', mutation: true, success: 'Đã gửi yêu cầu mã xác thực.', event: 'auth.otp.request.succeeded' }),
    define('auth.verify_otp', 'Xác thực mã đăng nhập', { icon: 'check', entity: 'AUTH', mutation: true, success: 'Đăng nhập thành công.', event: 'auth.login.succeeded' }),
    define('auth.copy_otp', 'Sao chép mã đăng nhập tạm', { icon: 'copy', entity: 'AUTH' }),
    define('auth.resend_otp', 'Gửi lại mã xác thực', { icon: 'refresh', entity: 'AUTH', mutation: true, success: 'Đã gửi lại mã xác thực.', event: 'auth.otp.request.succeeded' }),
    define('auth.change_email', 'Đổi email đăng nhập', { icon: 'arrow', entity: 'AUTH' }),

    define('evaluation.create', 'Tạo phiếu đánh giá', { short_label: 'Tạo phiếu', icon: 'add', variant: 'primary', placement: 'page', permission: 'EVALUATION.CREATE', entity: 'EVALUATION', mutation: true, success: 'Đã tạo phiếu đánh giá.', event: 'evaluation.created' }),
    define('evaluation.view', 'Xem chi tiết phiếu', { short_label: 'Chi tiết', icon: 'eye', placement: 'row', permission: 'EVALUATION.READ', entity: 'EVALUATION', backend_action: 'view' }),
    define('evaluation.history', 'Xem lịch sử phiếu', { short_label: 'Lịch sử', icon: 'history', placement: 'row', permission: 'EVALUATION.READ', entity: 'EVALUATION', backend_action: 'view' }),
    define('evaluation.edit', 'Chỉnh sửa phiếu', { short_label: 'Chỉnh sửa', icon: 'pen', placement: 'row', permission: 'EVALUATION.CREATE', entity: 'EVALUATION', allowed_statuses: ['Khoi tao', 'Dang xu ly'], backend_action: 'edit', mutation: true, success: 'Đã cập nhật phiếu đánh giá.', event: 'evaluation.updated' }),
    define('evaluation.delete', 'Xóa phiếu nháp', { short_label: 'Xóa nháp', icon: 'trash', variant: 'danger', placement: 'row', permission: 'EVALUATION.DELETE_DRAFT', entity: 'EVALUATION', allowed_statuses: ['Khoi tao'], backend_action: 'delete', confirm: destructive('Phiếu nháp và dữ liệu chưa công bố sẽ bị xóa.'), reason: { required: true }, mutation: true, success: 'Đã xóa phiếu nháp.', event: 'evaluation.deleted' }),
    define('evaluation.score', 'Chấm điểm phiếu', { short_label: 'Chấm điểm', icon: 'flask', variant: 'primary', placement: 'row', permission: 'EVALUATION.SCORE', entity: 'EVALUATION', allowed_statuses: ['Khoi tao', 'Dang xu ly', 'Dang danh gia lan 2'], backend_action: 'score' }),
    define('evaluation.round2_start', 'Bắt đầu đánh giá lần 2', { short_label: 'Đánh giá lần 2', icon: 'flask', variant: 'primary', placement: 'row', permission: 'EVALUATION.SCORE', entity: 'EVALUATION', allowed_statuses: ['Chờ khắc phục', 'Gia hạn'], backend_action: 'round2_start', mutation: true, success: 'Đã bắt đầu đánh giá lần 2.', event: 'evaluation.workflow.transitioned' }),
    define('evaluation.complete', 'Kết thúc đánh giá', { short_label: 'Kết thúc', icon: 'check', variant: 'primary', placement: 'row', permission: 'EVALUATION.SCORE', entity: 'EVALUATION', preconditions: ['scoring_locked', 'no_pending_approval'], backend_action: 'end', mutation: true, success: 'Đã kết thúc đánh giá.', event: 'evaluation.workflow.transitioned' }),
    define('evaluation.save', 'Lưu phiếu đánh giá', { icon: 'save', variant: 'primary', placement: 'form', permission: 'EVALUATION.CREATE', entity: 'EVALUATION', mutation: true, success: 'Đã lưu phiếu đánh giá.', event: 'evaluation.updated' }),
    define('evaluation.reset_form', 'Xóa thông tin phiếu', { icon: 'refresh', placement: 'form', permission: 'EVALUATION.CREATE', entity: 'EVALUATION' }),
    define('evaluation.save_scoring', 'Lưu bản nháp chấm điểm', { short_label: 'Lưu nháp', icon: 'save', placement: 'form', permission: 'EVALUATION.SCORE', entity: 'EVALUATION', backend_action: 'score', mutation: true, success: 'Đã lưu bản nháp chấm điểm.', event: 'scoring.answers.updated' }),
    define('evaluation.complete_scoring', 'Hoàn tất chấm điểm', { icon: 'check', variant: 'primary', placement: 'form', permission: 'EVALUATION.SCORE', entity: 'EVALUATION', backend_action: 'score', mutation: true, success: 'Đã hoàn tất chấm điểm.', event: 'scoring.round.completed' }),
    define('evaluation.submit_lead', 'Gửi Lead duyệt phiếu', { short_label: 'Gửi Lead', icon: 'send', variant: 'primary', placement: 'form', permission: 'EVALUATION.SCORE', entity: 'EVALUATION', backend_action: 'submit_lead', mutation: true, success: 'Đã gửi phiếu cho Lead duyệt.', event: 'evaluation.workflow.transitioned' }),
    define('evaluation.add_attendee', 'Thêm người tham dự', { icon: 'add', placement: 'form', permission: 'EVALUATION.SCORE', entity: 'EVALUATION' }),
    define('evaluation.remove_attendee', 'Xóa người tham dự', { icon: 'trash', variant: 'danger', placement: 'row', permission: 'EVALUATION.SCORE', entity: 'EVALUATION', confirm: destructive('Người tham dự sẽ bị loại khỏi bản nháp phiên đánh giá.') }),
    define('evaluation.cancellation_request', 'Yêu cầu hủy phiếu', { icon: 'close', variant: 'danger', placement: 'form', permission: 'EVALUATION.SCORE', entity: 'EVALUATION', backend_action: 'score', confirm: destructive('Phiếu sẽ được chuyển vào luồng xem xét hủy.'), reason: { required: true }, mutation: true, success: 'Đã gửi yêu cầu hủy phiếu.', event: 'evaluation.workflow.transitioned' }),
    define('evaluation.correction_extension', 'Gia hạn khắc phục', { icon: 'calendar', variant: 'primary', placement: 'form', permission: 'EVALUATION.SCORE', entity: 'EVALUATION', backend_action: 'score', reason: { required: true }, mutation: true, success: 'Đã gia hạn khắc phục.', event: 'evaluation.workflow.transitioned' }),
    define('evaluation.suspension_request', 'Đề xuất tạm ngưng', { icon: 'pause', placement: 'form', permission: 'EVALUATION.SCORE', entity: 'EVALUATION', backend_action: 'score', reason: { required: true }, mutation: true, success: 'Đã gửi đề xuất tạm ngưng.', event: 'evaluation.workflow.transitioned' }),
    define('evaluation.workflow_history', 'Xem lịch sử xử lý phiếu', { icon: 'history', placement: 'dialog', permission: 'EVALUATION.READ', entity: 'EVALUATION', backend_action: 'view' }),
    define('evaluation.sort', 'Sắp xếp danh sách phiếu', { icon: 'sort', permission: 'EVALUATION.READ', entity: 'EVALUATION' }),
    define('evaluation.filter_open', 'Mở bộ lọc phiếu', { icon: 'filter', permission: 'EVALUATION.READ', entity: 'EVALUATION' }),
    define('evaluation.filter_apply', 'Áp dụng bộ lọc phiếu', { icon: 'search', permission: 'EVALUATION.READ', entity: 'EVALUATION' }),
    define('evaluation.filter_reset', 'Xóa bộ lọc phiếu', { icon: 'refresh', permission: 'EVALUATION.READ', entity: 'EVALUATION' }),
    define('evaluation.export', 'Xuất danh sách đánh giá', { icon: 'spreadsheet', placement: 'page', permission: 'REPORT.EXPORT', entity: 'EVALUATION', mutation: true, success: 'Đã tạo danh sách đánh giá.', event: 'export.generated' }),
    define('evaluation.previous_page', 'Mở trang phiếu trước', { icon: 'arrow', permission: 'EVALUATION.READ', entity: 'EVALUATION' }),
    define('evaluation.next_page', 'Mở trang phiếu sau', { icon: 'arrow', permission: 'EVALUATION.READ', entity: 'EVALUATION' }),

    define('approval.view', 'Xem chi tiết phê duyệt', { short_label: 'Chi tiết', icon: 'eye', placement: 'row', entity: 'APPROVAL' }),
    define('approval.approve_lead', 'Phê duyệt phiếu ở bước Lead', { short_label: 'Phê duyệt', icon: 'check', variant: 'primary', placement: 'row', permission: 'EVALUATION.APPROVE_LEAD', entity: 'APPROVAL', backend_action: 'approve_lead', mutation: true, success: 'Đã phê duyệt phiếu.', event: 'approval.decision.recorded' }),
    define('approval.reject_lead', 'Trả phiếu về chuyên viên', { short_label: 'Trả về', icon: 'return', variant: 'danger', placement: 'row', permission: 'EVALUATION.APPROVE_LEAD', entity: 'APPROVAL', backend_action: 'approve_lead', confirm: destructive('Phiếu sẽ quay về chuyên viên để chỉnh sửa.'), reason: { required: true }, mutation: true, success: 'Đã trả phiếu về chuyên viên.', event: 'approval.decision.recorded' }),
    define('approval.approve_tbp', 'Phê duyệt kết quả ở bước TBP', { short_label: 'Phê duyệt', icon: 'check', variant: 'primary', placement: 'row', permission: 'EVALUATION.APPROVE_TBP', entity: 'APPROVAL', backend_action: 'approve_tbp', mutation: true, success: 'Đã phê duyệt kết quả.', event: 'approval.decision.recorded' }),
    define('approval.reject_tbp', 'Trả phiếu về Lead', { short_label: 'Trả về', icon: 'return', variant: 'danger', placement: 'row', permission: 'EVALUATION.APPROVE_TBP', entity: 'APPROVAL', backend_action: 'approve_tbp', confirm: destructive('Phiếu sẽ quay về Lead để xử lý lại.'), reason: { required: true }, mutation: true, success: 'Đã trả phiếu về Lead.', event: 'approval.decision.recorded' }),
    define('approval.send_gdk', 'Gửi GĐK duyệt phiếu', { short_label: 'Gửi GĐK', icon: 'send', placement: 'row', permission: 'EVALUATION.APPROVE_TBP', entity: 'APPROVAL', backend_action: 'approve_tbp', mutation: true, success: 'Đã gửi GĐK duyệt.', event: 'approval.decision.recorded' }),
    define('approval.approve_gdk', 'Phê duyệt cuối phiếu', { short_label: 'Phê duyệt', icon: 'check', variant: 'primary', placement: 'row', permission: 'EVALUATION.APPROVE_GDK', entity: 'APPROVAL', backend_action: 'approve_gdk', mutation: true, success: 'Đã phê duyệt cuối.', event: 'approval.decision.recorded' }),
    define('approval.reject_gdk', 'Trả phiếu về TBP', { short_label: 'Trả về', icon: 'return', variant: 'danger', placement: 'row', permission: 'EVALUATION.APPROVE_GDK', entity: 'APPROVAL', backend_action: 'approve_gdk', confirm: destructive('Phiếu sẽ quay về TBP để xử lý lại.'), reason: { required: true }, mutation: true, success: 'Đã trả phiếu về TBP.', event: 'approval.decision.recorded' }),
    define('approval.filter_reset', 'Xóa bộ lọc phê duyệt', { icon: 'refresh', entity: 'APPROVAL' }),

    define('supplier.create', 'Thêm nhà cung cấp', { short_label: 'Thêm NCC', icon: 'add', variant: 'primary', placement: 'page', permission: 'SUPPLIER.WRITE', entity: 'SUPPLIER', mutation: true, success: 'Đã thêm nhà cung cấp.', event: 'supplier.created' }),
    define('supplier.view', 'Xem chi tiết nhà cung cấp', { short_label: 'Chi tiết', icon: 'eye', placement: 'row', permission: 'SUPPLIER.READ', entity: 'SUPPLIER', backend_action: 'view' }),
    define('supplier.history', 'Xem lịch sử nhà cung cấp', { short_label: 'Lịch sử', icon: 'history', placement: 'row', permission: 'SUPPLIER.READ', entity: 'SUPPLIER', backend_action: 'history' }),
    define('supplier.edit', 'Chỉnh sửa nhà cung cấp', { short_label: 'Chỉnh sửa', icon: 'pen', placement: 'row', permission: 'SUPPLIER.WRITE', entity: 'SUPPLIER', backend_action: 'edit', mutation: true, success: 'Đã cập nhật nhà cung cấp.', event: 'supplier.updated' }),
    define('supplier.import', 'Nhập danh mục nhà cung cấp', { short_label: 'Nhập danh mục', icon: 'upload', placement: 'page', permission: 'SUPPLIER.WRITE', entity: 'SUPPLIER', mutation: true, success: 'Đã nhập danh mục nhà cung cấp.', event: 'import.completed' }),
    define('supplier.download_template', 'Tải file mẫu danh sách NCC', { short_label: 'Tải file mẫu', icon: 'download', placement: 'dialog', permission: 'SUPPLIER.WRITE', entity: 'SUPPLIER' }),
    define('supplier.filter_apply', 'Áp dụng bộ lọc nhà cung cấp', { icon: 'search', permission: 'SUPPLIER.READ', entity: 'SUPPLIER' }),
    define('supplier.filter_reset', 'Xóa bộ lọc nhà cung cấp', { icon: 'refresh', permission: 'SUPPLIER.READ', entity: 'SUPPLIER' }),
    define('supplier.previous_page', 'Mở trang nhà cung cấp trước', { icon: 'arrow', permission: 'SUPPLIER.READ', entity: 'SUPPLIER' }),
    define('supplier.next_page', 'Mở trang nhà cung cấp sau', { icon: 'arrow', permission: 'SUPPLIER.READ', entity: 'SUPPLIER' }),

    define('report.print', 'In báo cáo đánh giá', { short_label: 'In báo cáo', icon: 'printer', placement: 'row', permission: 'REPORT.EXPORT', entity: 'REPORT', backend_action: 'export', mutation: true, success: 'Đã tạo bản in báo cáo.', event: 'export.generated' }),
    define('report.export_excel', 'Xuất báo cáo Excel', { short_label: 'Xuất Excel', icon: 'spreadsheet', placement: 'row', permission: 'REPORT.EXPORT', entity: 'REPORT', backend_action: 'export', mutation: true, success: 'Đã tạo báo cáo Excel.', event: 'export.generated' }),
    define('report.export_pdf', 'Tải báo cáo PDF', { short_label: 'Tải PDF', icon: 'download', variant: 'primary', placement: 'row', permission: 'REPORT.EXPORT', entity: 'REPORT', backend_action: 'export', mutation: true, success: 'Đã tạo báo cáo PDF.', event: 'export.generated' }),
    define('report.filter_reset', 'Xóa bộ lọc báo cáo', { icon: 'refresh', permission: 'REPORT.READ', entity: 'REPORT' }),

    define('authorization.tab_open', 'Mở khu vực phân quyền', { icon: 'tab', permission: 'USER.MANAGE', entity: 'AUTHORIZATION' }),
    define('authorization.user_add', 'Thêm người dùng', { icon: 'add', variant: 'primary', placement: 'page', permission: 'USER.MANAGE', entity: 'AUTHORIZATION', mutation: true, success: 'Đã thêm người dùng.', event: 'user.account.upserted' }),
    define('authorization.personnel_import_open', 'Mở màn hình nhập nhân sự', { short_label: 'Nhập Excel', icon: 'upload', placement: 'page', permission: 'USER.MANAGE', entity: 'AUTHORIZATION' }),
    define('authorization.user_roles_save', 'Lưu vai trò và dữ liệu được xem', { short_label: 'Lưu thay đổi', icon: 'save', variant: 'primary', placement: 'form', permission: 'USER.MANAGE', entity: 'AUTHORIZATION', reason: { required: true }, mutation: true, success: 'Đã lưu quyền truy cập.', event: 'user.authorization.changed' }),
    define('authorization.role_new', 'Tạo vai trò mới', { icon: 'add', placement: 'page', permission: 'USER.MANAGE', entity: 'AUTHORIZATION' }),
    define('authorization.role_clone', 'Nhân bản vai trò', { icon: 'copy', placement: 'page', permission: 'USER.MANAGE', entity: 'AUTHORIZATION' }),
    define('authorization.role_save', 'Lưu vai trò', { icon: 'save', variant: 'primary', placement: 'form', permission: 'USER.MANAGE', entity: 'AUTHORIZATION', reason: { required: true }, mutation: true, success: 'Đã lưu vai trò.', event: 'role.catalog.changed' }),
    define('authorization.role_delete', 'Xóa vai trò tùy chỉnh', { icon: 'trash', variant: 'danger', placement: 'form', permission: 'USER.MANAGE', entity: 'AUTHORIZATION', confirm: destructive('Vai trò tùy chỉnh sẽ bị xóa nếu không còn người dùng hoặc workflow phụ thuộc.', 'DELETE ROLE'), reason: { required: true }, mutation: true, success: 'Đã xóa vai trò.', event: 'role.catalog.changed' }),
    define('authorization.permissions_publish', 'Công bố ma trận quyền', { short_label: 'Công bố quyền', icon: 'check', variant: 'primary', placement: 'form', permission: 'USER.MANAGE', entity: 'AUTHORIZATION', confirm: { required: true, include_object: true, consequence: 'Quyền hiệu lực của người dùng có thể thay đổi ngay.' }, reason: { required: true }, mutation: true, success: 'Đã công bố ma trận quyền.', event: 'role.permissions.changed' }),
    define('authorization.scope_add', 'Thêm phạm vi vào bản nháp', { icon: 'add', placement: 'form', permission: 'USER.MANAGE', entity: 'AUTHORIZATION' }),
    define('authorization.scopes_save', 'Lưu phạm vi dữ liệu', { icon: 'save', variant: 'primary', placement: 'form', permission: 'USER.MANAGE', entity: 'AUTHORIZATION', reason: { required: true }, mutation: true, success: 'Đã lưu phạm vi dữ liệu.', event: 'user.authorization.changed' }),
    define('authorization.approval_preview', 'Xem trước phân công phê duyệt', { icon: 'eye', placement: 'form', permission: 'USER.MANAGE', entity: 'AUTHORIZATION' }),
    define('authorization.approval_new', 'Tạo phân công phê duyệt', { icon: 'add', placement: 'page', permission: 'USER.MANAGE', entity: 'AUTHORIZATION' }),
    define('authorization.approval_publish', 'Công bố phân công phê duyệt', { short_label: 'Công bố phân công', icon: 'check', variant: 'primary', placement: 'form', permission: 'USER.MANAGE', entity: 'AUTHORIZATION', confirm: { required: true, include_object: true, consequence: 'Luồng phê duyệt sẽ dùng phân công mới ngay.' }, reason: { required: true }, mutation: true, success: 'Đã công bố phân công phê duyệt.', event: 'approval.assignment.changed' }),
    define('authorization.history_refresh', 'Làm mới lịch sử phân quyền', { icon: 'refresh', permission: 'USER.MANAGE', entity: 'AUTHORIZATION' }),
    define('authorization.export', 'Xuất cấu hình phân quyền', { short_label: 'Xuất Excel', icon: 'download', placement: 'page', permission: 'USER.MANAGE', entity: 'AUTHORIZATION', event: 'authz.exported' }),
    define('authorization.role_select', 'Chọn vai trò để chỉnh sửa', { icon: 'arrow', permission: 'USER.MANAGE', entity: 'AUTHORIZATION' }),
    define('authorization.user_role_remove', 'Bỏ vai trò khỏi bản nháp', { icon: 'close', variant: 'danger', permission: 'USER.MANAGE', entity: 'AUTHORIZATION' }),
    define('authorization.scope_remove', 'Bỏ phạm vi khỏi bản nháp', { icon: 'close', variant: 'danger', permission: 'USER.MANAGE', entity: 'AUTHORIZATION', confirm: destructive('Phạm vi sẽ bị loại khỏi bản nháp chưa công bố.') }),
    define('authorization.approval_select', 'Chọn phân công phê duyệt', { icon: 'arrow', permission: 'USER.MANAGE', entity: 'AUTHORIZATION' }),
    define('authorization.user_deactivate', 'Khóa tài khoản người dùng', { icon: 'lock', variant: 'danger', placement: 'row', permission: 'USER.MANAGE', entity: 'AUTHORIZATION', confirm: destructive('Người dùng sẽ mất quyền truy cập và phiên hiện tại bị thu hồi.'), reason: { required: true }, mutation: true, success: 'Đã khóa tài khoản.', event: 'user.account.deactivated' }),
    define('authorization.user_reactivate', 'Mở lại tài khoản người dùng', { icon: 'check', variant: 'primary', placement: 'row', permission: 'USER.MANAGE', entity: 'AUTHORIZATION', reason: { required: true }, mutation: true, success: 'Đã mở lại tài khoản.', event: 'user.account.reactivated' }),

    define('personnel_import.download_template', 'Tải file mẫu nhập nhân sự', { short_label: 'Tải file mẫu', icon: 'download', placement: 'page', permission: 'USER.MANAGE', entity: 'PERSONNEL_IMPORT' }),
    define('personnel_import.open_example', 'Xem file ví dụ nhập nhân sự', { short_label: 'Xem file ví dụ', icon: 'eye', placement: 'page', permission: 'USER.MANAGE', entity: 'PERSONNEL_IMPORT' }),
    define('personnel_import.upload_preview', 'Tải file và tạo preview nhân sự', { short_label: 'Chọn file XLSX', icon: 'upload', variant: 'primary', placement: 'form', permission: 'USER.MANAGE', entity: 'PERSONNEL_IMPORT', event: 'personnel.import.previewed' }),
    define('personnel_import.mapping_continue', 'Tiếp tục mapping nhập nhân sự', { short_label: 'Tiếp tục', icon: 'arrow', variant: 'primary', placement: 'form', permission: 'USER.MANAGE', entity: 'PERSONNEL_IMPORT' }),
    define('personnel_import.mapping_back', 'Quay lại bước nhập nhân sự trước', { short_label: 'Quay lại', icon: 'arrow', placement: 'form', permission: 'USER.MANAGE', entity: 'PERSONNEL_IMPORT' }),
    define('personnel_import.validate', 'Kiểm tra batch nhập nhân sự', { short_label: 'Kiểm tra dữ liệu', icon: 'check', variant: 'primary', placement: 'form', permission: 'USER.MANAGE', entity: 'PERSONNEL_IMPORT', event: 'personnel.import.validated' }),
    define('personnel_import.retry', 'Thử lại bước nhập nhân sự an toàn', { short_label: 'Thử lại', icon: 'refresh', placement: 'form', permission: 'USER.MANAGE', entity: 'PERSONNEL_IMPORT' }),
    define('personnel_import.commit', 'Nhập batch nhân sự đã kiểm tra', { short_label: 'Nhập nhân sự', icon: 'check', variant: 'primary', placement: 'form', permission: 'USER.MANAGE', entity: 'PERSONNEL_IMPORT', confirm: { required: true, include_object: true, consequence: 'Toàn bộ thay đổi nhân sự, role và scope đã kiểm tra sẽ được ghi nguyên tử.' }, reason: { required: true }, mutation: true, success: 'Đã nhập nhân sự thành công.', event: 'personnel.import.committed' }),
    define('personnel_import.cancel', 'Hủy workflow nhập nhân sự', { short_label: 'Hủy bỏ', icon: 'close', placement: 'form', permission: 'USER.MANAGE', entity: 'PERSONNEL_IMPORT' }),
    define('personnel_import.return_users', 'Về danh sách nhân sự sau khi nhập', { short_label: 'Danh sách nhân sự', icon: 'arrow', variant: 'primary', placement: 'form', permission: 'USER.MANAGE', entity: 'PERSONNEL_IMPORT' }),

    define('question_template.create', 'Tạo biểu mẫu câu hỏi', { icon: 'add', placement: 'page', permission: 'QUESTION_TEMPLATE.MANAGE', entity: 'QUESTION_TEMPLATE' }),
    define('question_template.save', 'Lưu biểu mẫu câu hỏi', { icon: 'save', variant: 'primary', placement: 'form', permission: 'QUESTION_TEMPLATE.MANAGE', entity: 'QUESTION_TEMPLATE', mutation: true, success: 'Đã lưu biểu mẫu câu hỏi.', event: 'question.template.changed' }),
    define('question_template.edit', 'Chỉnh sửa biểu mẫu câu hỏi', { icon: 'pen', placement: 'row', permission: 'QUESTION_TEMPLATE.MANAGE', entity: 'QUESTION_TEMPLATE' }),
    define('question.create', 'Tạo câu hỏi', { icon: 'add', placement: 'page', permission: 'QUESTION_TEMPLATE.MANAGE', entity: 'QUESTION_TEMPLATE' }),
    define('question.save', 'Lưu câu hỏi', { icon: 'save', variant: 'primary', placement: 'form', permission: 'QUESTION_TEMPLATE.MANAGE', entity: 'QUESTION_TEMPLATE', mutation: true, success: 'Đã lưu câu hỏi.', event: 'question.template.changed' }),
    define('question.edit', 'Chỉnh sửa câu hỏi', { icon: 'pen', placement: 'row', permission: 'QUESTION_TEMPLATE.MANAGE', entity: 'QUESTION_TEMPLATE' }),
    define('question.deactivate', 'Tắt câu hỏi', { icon: 'close', variant: 'danger', placement: 'row', permission: 'QUESTION_TEMPLATE.MANAGE', entity: 'QUESTION_TEMPLATE', confirm: destructive('Câu hỏi sẽ không còn dùng cho phiên bản mới.'), mutation: true, success: 'Đã tắt câu hỏi.', event: 'question.template.changed' }),
    define('question_version.clone_draft', 'Tạo bản nháp bộ câu hỏi', { short_label: 'Tạo bản nháp', icon: 'copy', placement: 'form', permission: 'QUESTION_TEMPLATE.MANAGE', entity: 'QUESTION_TEMPLATE', mutation: true, success: 'Đã tạo bản nháp bộ câu hỏi.', event: 'question.template.changed' }),
    define('question_import.preview', 'Xem trước nhập bộ câu hỏi', { icon: 'eye', placement: 'form', permission: 'QUESTION_TEMPLATE.MANAGE', entity: 'QUESTION_TEMPLATE', mutation: true, success: 'Đã tạo preview bộ câu hỏi.', event: 'question.import.previewed' }),
    define('question_import.commit', 'Commit bộ câu hỏi vào Draft', { icon: 'save', variant: 'primary', placement: 'form', permission: 'QUESTION_TEMPLATE.MANAGE', entity: 'QUESTION_TEMPLATE', allowed_statuses: ['DRAFT'], preconditions: ['preview_confirmed'], confirm: { required: true, include_object: true, consequence: 'Các thay đổi đã preview sẽ được ghi nguyên tử vào Draft; phiên bản chưa được publish.' }, mutation: true, success: 'Đã commit bộ câu hỏi vào Draft.', event: 'question.import.committed' }),
    define('question_import.rollback', 'Hoàn tác batch nhập câu hỏi', { icon: 'return', variant: 'danger', placement: 'form', permission: 'QUESTION_TEMPLATE.MANAGE', entity: 'QUESTION_TEMPLATE', allowed_statuses: ['DRAFT'], confirm: destructive('Draft sẽ trở về snapshot ngay trước batch; thay đổi mới hơn sẽ chặn thao tác.'), mutation: true, success: 'Đã hoàn tác batch nhập câu hỏi.', event: 'question.import.rolled_back' }),
    define('question_import.export_errors', 'Tải danh sách lỗi nhập câu hỏi', { icon: 'download', placement: 'form', permission: 'QUESTION_TEMPLATE.MANAGE', entity: 'QUESTION_TEMPLATE' }),

    define('report_template.create', 'Tạo mẫu báo cáo', { icon: 'add', placement: 'page', permission: 'REPORT_TEMPLATE.MANAGE', entity: 'REPORT_TEMPLATE' }),
    define('report_template.save', 'Lưu mẫu báo cáo', { icon: 'save', variant: 'primary', placement: 'form', permission: 'REPORT_TEMPLATE.MANAGE', entity: 'REPORT_TEMPLATE', mutation: true, success: 'Đã lưu mẫu báo cáo.', event: 'report.template.changed' }),
    define('report_template.preview', 'Xem trước mẫu báo cáo', { icon: 'eye', placement: 'row', permission: 'REPORT.READ', entity: 'REPORT_TEMPLATE', backend_action: 'report_template.preview' }),
    define('report_template.edit', 'Chỉnh sửa mẫu báo cáo', { icon: 'pen', placement: 'row', permission: 'REPORT_TEMPLATE.MANAGE', entity: 'REPORT_TEMPLATE' }),
    define('report_template.deactivate', 'Tắt mẫu báo cáo', { icon: 'close', variant: 'danger', placement: 'row', permission: 'REPORT_TEMPLATE.MANAGE', entity: 'REPORT_TEMPLATE', confirm: destructive('Mẫu báo cáo sẽ không còn được chọn cho lượt xuất mới.'), mutation: true, success: 'Đã tắt mẫu báo cáo.', event: 'report.template.changed' }),
    define('report_template.filter_apply', 'Lọc catalog mẫu báo cáo', { icon: 'search', placement: 'control', permission: 'REPORT.READ', entity: 'REPORT_TEMPLATE' }),
    define('report_template.tab_open', 'Mở tab workspace mẫu báo cáo', { icon: 'arrow', placement: 'control', permission: 'REPORT.READ', entity: 'REPORT_TEMPLATE' }),
    define('report_template.create_draft', 'Tạo bản nháp mẫu báo cáo', { short_label: 'Tạo bản nháp', icon: 'copy', placement: 'page', permission: 'REPORT_TEMPLATE.MANAGE', entity: 'REPORT_TEMPLATE', backend_action: 'report_template.create_draft', mutation: true, success: 'Đã tạo bản nháp mẫu báo cáo.', event: 'report.template.changed' }),
    define('report_template.save_draft', 'Lưu thay đổi mẫu báo cáo', { short_label: 'Lưu thay đổi', icon: 'save', variant: 'primary', placement: 'form', permission: 'REPORT_TEMPLATE.MANAGE', entity: 'REPORT_TEMPLATE', allowed_statuses: ['DRAFT'], backend_action: 'report_template.save_draft', mutation: true, success: 'Đã lưu bản nháp mẫu báo cáo.', event: 'report.template.changed' }),
    define('report_template.validate', 'Kiểm tra Draft mẫu báo cáo', { short_label: 'Kiểm tra', icon: 'check', placement: 'form', permission: 'REPORT_TEMPLATE.MANAGE', entity: 'REPORT_TEMPLATE', allowed_statuses: ['DRAFT'], backend_action: 'report_template.validate' }),
    define('report_template.submit_review', 'Gửi duyệt mẫu báo cáo', { short_label: 'Gửi duyệt', icon: 'send', placement: 'form', permission: 'REPORT_TEMPLATE.MANAGE', entity: 'REPORT_TEMPLATE', allowed_statuses: ['DRAFT'], backend_action: 'report_template.submit_review', confirm: { required: true, include_object: true, consequence: 'Version chuyển sang Review và không còn chỉnh sửa cho đến khi được clone lại.' }, mutation: true, success: 'Đã gửi mẫu báo cáo để duyệt.', event: 'report.template.changed' }),
    define('report_template.publish', 'Publish và đặt mẫu báo cáo mặc định', { short_label: 'Publish', icon: 'check', variant: 'primary', placement: 'form', permission: 'REPORT_TEMPLATE.PUBLISH', entity: 'REPORT_TEMPLATE', allowed_statuses: ['IN_REVIEW'], backend_action: 'report_template.publish', confirm: { required: true, include_object: true, consequence: 'Version này trở thành mặc định cho các lượt export mới; lịch sử cũ giữ provenance đã pin.' }, mutation: true, success: 'Đã publish và đặt version mặc định.', event: 'report.template.changed' }),
    define('report_template.rollback', 'Rollback mẫu báo cáo mặc định', { short_label: 'Rollback', icon: 'return', variant: 'danger', placement: 'form', permission: 'REPORT_TEMPLATE.PUBLISH', entity: 'REPORT_TEMPLATE', allowed_statuses: ['PUBLISHED', 'RETIRED'], backend_action: 'report_template.rollback', confirm: destructive('Version được chọn trở thành mặc định cho lượt export mới; artifact lịch sử không thay đổi.'), mutation: true, success: 'Đã rollback version mặc định.', event: 'report.template.changed' }),
    define('report_template.component_add', 'Thêm component vào Draft', { icon: 'add', placement: 'control', permission: 'REPORT_TEMPLATE.MANAGE', entity: 'REPORT_TEMPLATE', allowed_statuses: ['DRAFT'] }),
    define('report_template.component_move', 'Sắp xếp component trong Draft', { icon: 'sort', placement: 'control', permission: 'REPORT_TEMPLATE.MANAGE', entity: 'REPORT_TEMPLATE', allowed_statuses: ['DRAFT'] }),
    define('report_template.export_package', 'Export definition package', { icon: 'download', placement: 'form', permission: 'REPORT.READ', entity: 'REPORT_TEMPLATE', backend_action: 'report_template.export_package' }),
    define('report_template.import_package', 'Import definition package vào Draft', { icon: 'upload', placement: 'form', permission: 'REPORT_TEMPLATE.MANAGE', entity: 'REPORT_TEMPLATE', backend_action: 'report_template.import_package', mutation: true, success: 'Đã import package vào Draft mới.', event: 'report.template.changed' }),
    define('report_template.advanced_json', 'Áp dụng Advanced JSON đã kiểm tra', { icon: 'code', placement: 'form', permission: 'REPORT_TEMPLATE.ADVANCED', entity: 'REPORT_TEMPLATE', allowed_statuses: ['DRAFT'], backend_action: 'report_template.advanced_json' }),

    define('scoring_policy.tab_open', 'Mở tab workspace chính sách tính điểm', { icon: 'arrow', permission: 'SCORING_POLICY.MANAGE', entity: 'SCORING_POLICY' }),
    define('scoring_policy.preview', 'Xem trước tác động chính sách tính điểm', { short_label: 'Xem trước', icon: 'eye', placement: 'form', permission: 'SCORING_POLICY.MANAGE', entity: 'SCORING_POLICY', backend_action: 'scoring_policy.preview' }),
    define('scoring_policy.simulate', 'Mô phỏng chính sách tính điểm bằng fixture synthetic', { short_label: 'Mô phỏng', icon: 'eye', placement: 'form', permission: 'SCORING_POLICY.MANAGE', entity: 'SCORING_POLICY', backend_action: 'scoring_policy.simulate' }),
    define('scoring_policy.impact', 'Phân tích tác động chính sách tính điểm', { short_label: 'Tác động', icon: 'report', placement: 'form', permission: 'SCORING_POLICY.MANAGE', entity: 'SCORING_POLICY', backend_action: 'scoring_policy.impact' }),
    define('scoring_policy.validate', 'Kiểm tra chính sách tính điểm', { short_label: 'Kiểm tra', icon: 'check', placement: 'form', permission: 'SCORING_POLICY.MANAGE', entity: 'SCORING_POLICY', backend_action: 'scoring_policy.validate' }),
    define('scoring_policy.create_draft', 'Tạo bản nháp chính sách tính điểm', { short_label: 'Tạo bản nháp', icon: 'copy', placement: 'page', permission: 'SCORING_POLICY.MANAGE', entity: 'SCORING_POLICY', backend_action: 'scoring_policy.create_draft', mutation: true, success: 'Đã tạo bản nháp chính sách tính điểm.', event: 'scoring.policy.changed' }),
    define('scoring_policy.save_draft', 'Lưu thay đổi chính sách tính điểm', { short_label: 'Lưu thay đổi', icon: 'save', variant: 'primary', placement: 'form', permission: 'SCORING_POLICY.MANAGE', entity: 'SCORING_POLICY', allowed_statuses: ['DRAFT'], backend_action: 'scoring_policy.save_draft', mutation: true, success: 'Đã lưu bản nháp chính sách tính điểm.', event: 'scoring.policy.changed' }),
    define('scoring_policy.submit_review', 'Gửi duyệt chính sách tính điểm', { short_label: 'Gửi duyệt', icon: 'send', placement: 'form', permission: 'SCORING_POLICY.MANAGE', entity: 'SCORING_POLICY', allowed_statuses: ['DRAFT'], backend_action: 'scoring_policy.submit_review', confirm: { required: true, include_object: true, consequence: 'Phiên bản sẽ chuyển sang Review và không còn chỉnh sửa cho đến khi clone lại.' }, mutation: true, success: 'Đã gửi chính sách tính điểm để duyệt.', event: 'scoring.policy.changed' }),
    define('scoring_policy.publish', 'Công bố chính sách tính điểm', { short_label: 'Công bố', icon: 'check', variant: 'primary', placement: 'form', permission: 'SCORING_POLICY.PUBLISH', entity: 'SCORING_POLICY', allowed_statuses: ['IN_REVIEW'], backend_action: 'scoring_policy.publish', confirm: { required: true, include_object: true, consequence: 'Phiên bản trở thành chính sách mặc định cho phiếu mới; phiếu cũ giữ phiên bản đã chọn.' }, mutation: true, success: 'Đã công bố chính sách tính điểm.', event: 'scoring.policy.changed' }),
    define('scoring_policy.rollback', 'Rollback chính sách tính điểm mặc định', { short_label: 'Rollback', icon: 'return', variant: 'danger', placement: 'form', permission: 'SCORING_POLICY.PUBLISH', entity: 'SCORING_POLICY', allowed_statuses: ['PUBLISHED', 'RETIRED'], backend_action: 'scoring_policy.rollback', confirm: destructive('Phiên bản được chọn trở thành mặc định cho phiếu mới; phiếu và báo cáo lịch sử không thay đổi.'), mutation: true, success: 'Đã rollback chính sách tính điểm mặc định.', event: 'scoring.policy.changed' }),

    define('audit.filter_apply', 'Áp dụng bộ lọc audit', { icon: 'search', permission: 'AUDIT.READ', entity: 'AUDIT' }),
    define('audit.filter_reset', 'Xóa bộ lọc audit', { icon: 'refresh', permission: 'AUDIT.READ', entity: 'AUDIT' }),
    define('audit.view', 'Xem chi tiết sự kiện audit', { short_label: 'Chi tiết', icon: 'eye', placement: 'row', permission: 'AUDIT.READ', entity: 'AUDIT', event: 'audit.read' }),
    define('audit.copy_id', 'Sao chép mã truy vết', { icon: 'copy', placement: 'dialog', permission: 'AUDIT.READ', entity: 'AUDIT' }),
    define('audit.open_entity', 'Mở đối tượng liên quan', { icon: 'arrow', placement: 'dialog', permission: 'AUDIT.READ', entity: 'AUDIT' }),
    define('audit.export_csv', 'Xuất audit CSV', { short_label: 'Xuất CSV', icon: 'spreadsheet', placement: 'page', permission: 'AUDIT.EXPORT', entity: 'AUDIT', mutation: true, success: 'Đã tạo tệp audit CSV.', event: 'audit.export' }),
    define('audit.export_ndjson', 'Xuất audit NDJSON', { short_label: 'Xuất NDJSON', icon: 'download', placement: 'page', permission: 'AUDIT.EXPORT', entity: 'AUDIT', mutation: true, success: 'Đã tạo tệp audit NDJSON.', event: 'audit.export' }),
    define('audit.retention_report', 'Tạo báo cáo retention dry-run', { short_label: 'Retention dry-run', icon: 'report', placement: 'page', permission: 'AUDIT.READ', entity: 'AUDIT', event: 'audit.read' }),
    define('audit.load_more', 'Tải thêm sự kiện audit', { icon: 'more', permission: 'AUDIT.READ', entity: 'AUDIT' }),
  ]);

  const STATIC_ACTION_BINDINGS = Object.freeze({
    'question-new-template': 'question_template.create', 'question-create-cancel': 'dialog.cancel', 'question-create-submit': 'question_template.create',
    'question-catalog-apply': 'question_template.filter_apply', 'question-catalog-reset': 'question_template.filter_reset',
    'question-tab-questions': 'question_template.tab_open', 'question-tab-variants': 'question_template.tab_open',
    'question-tab-scopes': 'question_template.tab_open', 'question-tab-versions': 'question_template.tab_open',
    'question-add-item': 'question.create', 'question-bulk-deactivate': 'question.bulk_deactivate',
    'question-download-template': 'question_import.download_template', 'question-workspace-import-preview': 'question_import.preview',
    'question-workspace-import-errors': 'question_import.export_errors', 'question-workspace-import-rollback': 'question_import.rollback',
    'question-workspace-import-commit': 'question_import.commit', 'question-version-clone': 'question_version.clone_draft',
    'question-preview': 'question_version.preview', 'question-validate': 'question_version.validate',
    'question-save-draft': 'question_version.save_draft', 'question-submit-review': 'question_version.submit_review',
    'question-publish': 'question_version.publish', 'question-preview-close': 'dialog.close', 'question-editor-close': 'dialog.close',
    'question-editor-cancel': 'dialog.cancel', 'question-editor-save': 'question.save',
    'sb-toggle': 'navigation.toggle', 'btn-logout': 'session.logout',
    'btn-send-otp': 'auth.request_otp', 'btn-verify': 'auth.verify_otp',
    'btn-copy-screen-otp': 'auth.copy_otp', 'btn-resend-otp': 'auth.resend_otp', 'btn-back-login': 'auth.change_email',
    'mobile-back': 'navigation.back', 'route-denied-back': 'navigation.back', 'mobile-more-close': 'dialog.close',
    'eval-filter-toggle': 'evaluation.filter_open', 'eval-reset-filters': 'evaluation.filter_reset', 'eval-apply-filters': 'evaluation.filter_apply',
    'eval-export-excel': 'evaluation.export', 'eval-prev-page': 'evaluation.previous_page', 'eval-next-page': 'evaluation.next_page',
      'btn-form-reset': 'evaluation.reset_form', 'btn-save-evaluation': 'evaluation.save',
      'btn-score-saved-evaluation': 'evaluation.score',
    'btn-save-scoring-draft': 'evaluation.save_scoring', 'btn-complete-scoring': 'evaluation.complete_scoring',
    'btn-end-evaluation': 'evaluation.complete', 'btn-submit-lead': 'evaluation.submit_lead',
    'btn-start-round2': 'evaluation.round2_start', 'btn-add-attendee': 'evaluation.add_attendee',
    'approval-reset': 'approval.filter_reset', 'report-reset': 'report.filter_reset',
    'audit-open-scoring': 'evaluation.score', 'audit-open-history': 'evaluation.history', 'audit-open-report': 'navigation.open',
    'btn-import-suppliers': 'supplier.import', 'btn-download-supplier-template': 'supplier.download_template', 'btn-add-supplier': 'supplier.create',
    'supplier-apply-filters': 'supplier.filter_apply', 'supplier-reset-filters': 'supplier.filter_reset',
    'supplier-prev-page': 'supplier.previous_page', 'supplier-next-page': 'supplier.next_page',
    'btn-admin-close': 'navigation.back', 'btn-add-user': 'authorization.user_add',
    'authz-save-user-roles': 'authorization.user_roles_save', 'authz-new-role': 'authorization.role_new',
    'authz-clone-role': 'authorization.role_clone', 'authz-delete-role': 'authorization.role_delete', 'authz-save-role': 'authorization.role_save',
    'authz-save-permissions': 'authorization.permissions_publish', 'authz-add-scope': 'authorization.scope_add',
    'authz-save-scopes': 'authorization.scopes_save', 'authz-preview-approval': 'authorization.approval_preview',
    'authz-new-approval': 'authorization.approval_new', 'authz-publish-approval': 'authorization.approval_publish',
    'authz-refresh-history': 'authorization.history_refresh', 'authz-export-authorization': 'authorization.export',
    'system-log-reset': 'audit.filter_reset', 'system-log-export-csv': 'audit.export_csv',
    'system-log-export-ndjson': 'audit.export_ndjson', 'system-log-retention-dry-run': 'audit.retention_report',
    'system-log-more': 'audit.load_more', 'system-log-drawer-close': 'dialog.close',
    'btn-new-template': 'question_template.create', 'btn-save-template': 'question_template.save',
    'btn-new-question': 'question.create', 'btn-save-question': 'question.save',
    'question-version-clone-draft': 'question_version.clone_draft',
    'question-import-preview': 'question_import.preview', 'question-import-commit': 'question_import.commit',
    'question-import-rollback': 'question_import.rollback', 'question-import-errors': 'question_import.export_errors',
    'btn-new-report-template': 'report_template.create', 'btn-save-report-template': 'report_template.save',
    'confirm-cancel': 'confirmation.cancel', 'confirm-accept': 'confirmation.accept',
    'btn-cancel-add-user': 'dialog.cancel', 'btn-submit-add-user': 'authorization.user_add',
    'btn-cancel-supplier': 'dialog.close', 'btn-save-supplier': 'supplier.create',
    'btn-cancel-supplier-import': 'dialog.close', 'btn-submit-supplier-import': 'supplier.import',
    'btn-close-supplier-detail': 'dialog.close', 'btn-close-supplier-history': 'dialog.close',
    'btn-close-ticket-detail': 'dialog.close', 'btn-edit-ticket': 'evaluation.edit', 'btn-delete-ticket': 'evaluation.delete',
    'btn-close-ticket-history': 'dialog.close',
  });

  const byId = new Map(ACTION_REGISTRY.map((item) => [item.action_id, item]));

  function getAction(actionId) {
    return byId.get(String(actionId || '')) || null;
  }

  function normalizedState(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/gi, 'd')
      .trim()
      .toLowerCase();
  }

  function resolveActionState(actionId, context = {}) {
    const action = getAction(actionId);
    if (!action) return { state: 'hidden', reason: 'action_not_catalogued' };
    const capabilities = new Set(context.capabilities || []);
    if (action.permission && !capabilities.has(action.permission)) return { state: 'hidden', reason: 'forbidden_permission' };
    const resource = context.resource || null;
    const backendAction = action.backend_action;
    if (resource && backendAction) {
      const allowed = Array.isArray(resource.allowed_actions) && resource.allowed_actions.includes(backendAction);
      if (!allowed) {
        const reason = resource.disabled_reasons?.[backendAction] || 'action_unavailable';
        return { state: reason === 'forbidden_permission' ? 'hidden' : 'disabled', reason };
      }
    }
    const status = String(context.status || context.resource?.current_status || context.resource?.status || '');
    if (action.allowed_statuses.length && status && !action.allowed_statuses.some((allowed) => normalizedState(allowed) === normalizedState(status))) {
      return { state: 'disabled', reason: 'invalid_status' };
    }
    for (const precondition of action.preconditions) {
      if (context.preconditions?.[precondition] !== true) return { state: 'disabled', reason: `precondition_${precondition}` };
    }
    return { state: 'enabled', reason: '' };
  }

  function partitionRowActions(descriptors) {
    const actions = (descriptors || []).filter(Boolean);
    const normal = actions.filter((item) => item.variant !== 'danger');
    const danger = actions.filter((item) => item.variant === 'danger');
    return { direct: [], overflow: [...normal, ...danger] };
  }

  function validateRegistry() {
    const errors = [];
    const seen = new Set();
    const required = ['action_id', 'label', 'short_label', 'icon', 'variant', 'placement', 'permission', 'entity',
      'allowed_statuses', 'preconditions', 'confirm', 'reason', 'idempotency', 'success', 'event'];
    for (const item of ACTION_REGISTRY) {
      if (!/^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/.test(item.action_id)) errors.push(`${item.action_id}:invalid_id`);
      if (seen.has(item.action_id)) errors.push(`${item.action_id}:duplicate`);
      seen.add(item.action_id);
      for (const field of required) if (!Object.prototype.hasOwnProperty.call(item, field)) errors.push(`${item.action_id}.${field}:missing`);
      if (!variants.has(item.variant)) errors.push(`${item.action_id}:invalid_variant`);
      if (!placements.has(item.placement)) errors.push(`${item.action_id}:invalid_placement`);
      if (item.version !== ACTION_VERSION) errors.push(`${item.action_id}:version`);
      if (item.mutation && (!item.idempotency.required || !item.event || !item.success.message)) errors.push(`${item.action_id}:mutation_contract`);
    }
    for (const [buttonId, actionId] of Object.entries(STATIC_ACTION_BINDINGS)) {
      if (!getAction(actionId)) errors.push(`${buttonId}:unknown_action:${actionId}`);
    }
    return errors.sort();
  }

  return Object.freeze({
    ACTION_VERSION,
    ACTION_REGISTRY,
    STATIC_ACTION_BINDINGS,
    getAction,
    resolveActionState,
    partitionRowActions,
    validateRegistry,
  });
});
