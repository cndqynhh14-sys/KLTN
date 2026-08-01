<a id="report-troubleshooting"></a>
# Xử lý sự cố báo cáo

Giữ nguyên mã lỗi và `request_id` hiển thị trên UI. Không retry mù, không sửa DB, không đánh dấu job `COMPLETED`, không regenerate history để che lỗi.

<a id="prerequisites"></a>
## Điều kiện trước khi kiểm tra

- Có thời điểm, route/action, definition, version, round, format và fixture/ticket synthetic ID.
- Có quyền đọc đúng scope; không xin quyền rộng hơn để “thử”.
- Chỉ thu thập metadata đã redaction: job/artifact ID, status, checksum/version và request/correlation ID.

<a id="permissions"></a>
## Quyền cần có

- `REPORT.READ` để đọc catalog, preview và history trong scope.
- `REPORT.EXPORT` để tái hiện export/download bằng fixture được phép.
- `REPORT_TEMPLATE.MANAGE` chỉ khi cần chẩn đoán Draft/validation; `REPORT_TEMPLATE.PUBLISH` chỉ dành cho rollback đã duyệt.

<a id="error-codes"></a>
<a id="steps"></a>
## Symptoms → Cause → Check → Resolution → Escalation

### Không có template/default hoặc preview lỗi binding

**Symptoms** — UI báo `report_definition_not_found`, `report_template_version_not_found`, `report_context_invalid`, `report_binding_not_allowed` hoặc `report_component_unknown`.

**Cause** — Sai canonical definition/version, không có Published assignment hiệu lực, context thiếu dữ liệu hoặc Draft dùng component/binding ngoài schema.

**Check** — Kiểm definition/version/status/checksum, scope/effective window, data contract, allowed binding và `allowed_next_actions`. Preview phải dùng exact version; production chỉ dùng Published default.

**Resolution** — Chọn đúng version/round; sửa Draft rồi Validate. Nếu Published assignment thiếu, publisher gán default đã duyệt. Không fallback sang legacy alias.

**Escalation** — Gửi Report Owner mã lỗi, definition/version, field path đã sanitize, `request_id` và correlation ID; không gửi context/report body.

### Sai round hoặc lộ điểm trong biên bản

**Symptoms** — `report_round_not_allowed`, `report_round_missing`, `report_round_not_completed` hoặc `report_score_exposure_forbidden`.

**Cause** — `ROUND1_RESULT` không dùng round 1, `ROUND2_RESULT` chưa có round 2 đủ điều kiện, hoặc `WORKING_MINUTES` chứa binding score/result bị cấm.

**Check** — Đối chiếu canonical code, pinned round/state và component tree. Không chấp nhận ROUND2 fallback round 1.

**Resolution** — Hoàn tất đúng round/allowed next action, hoặc bỏ binding score khỏi Draft Working Minutes rồi validate/publish theo quy trình.

**Escalation** — Gửi Workflow/Report Owner ticket fixture, round expected/actual, error code, `request_id`; dừng export nếu conclusion/round sai.

### Export job không hoàn tất hoặc tải lại lỗi

**Symptoms** — Job `FAILED/QUEUED`, `report_worker_required`, `report_storage_unavailable`, `artifact_missing`, `artifact_unavailable`, checksum/signature/size mismatch hoặc không có download action.

**Cause** — Worker/storage/readiness chưa sẵn sàng, persist byte thất bại, object mất hoặc bị quarantine; history legacy có file thiếu.

**Check** — Kiểm readiness, execution/storage adapter, job outcome/attempt, relative storage key, artifact availability, SHA-256, MIME, size. Immediate và history phải trỏ cùng artifact record.

**Resolution** — Khôi phục worker/storage theo runbook; retry cùng idempotency. Không tạo artifact thứ hai, không sửa absolute path và không trả link giả. Legacy missing giữ trạng thái rõ; regenerate chỉ khi policy cho phép và phải tạo artifact mới có provenance.

**Escalation** — Gửi Platform Owner job/artifact ID, adapter/status, safe filename, error code, `request_id` và correlation ID; Security Owner nếu IDOR/path/content spoofing.

### Output mới khác format hoặc history thay đổi

**Symptoms** — Title/totals/conclusion/category/order khác giữa HTML/PDF/XLSX, semantic checksum lệch, hoặc artifact lịch sử đổi sau publish/rollback.

**Cause** — Format dùng context/renderer riêng, version pin sai, policy/layout bị trộn, hoặc history bị regenerate/ghi đè ngoài policy.

**Check** — So provenance: definition/template version/hash, question version, scoring policy/formula checksum, context/component/semantic checksum, renderer/app commit và artifact hash.

**Resolution** — Dừng publish/export mới, rollback default đã duyệt, giữ artifact cũ bất biến và chạy matrix canonical × format × round bằng fixture.

**Escalation** — Incident tới Report + Scoring + Platform Owners với before/after semantic metadata, `request_id`; không gửi bytes hoặc ticket thật.

<a id="expected-result"></a>
## Kết quả mong đợi

Người vận hành xác định được lớp lỗi (definition/context/component/round/storage/authorization), dùng allowed next action và giữ history/provenance bất biến. Retry không nhân đôi job/artifact.

<a id="rollback"></a>
## Hoàn tác

Khi lỗi xuất hiện sau publish, đổi default về version đã duyệt theo [runbook cấu hình](../admin-runbook/configuration-rollback.md#report-template), smoke lại ba format và giám sát job/download. Không xóa history hoặc hard-delete artifact.

<a id="escalation"></a>
## Escalation tổng hợp

Mẫu tối thiểu: môi trường, thời gian, route/action, definition/version/round/format, status/error code, safe job/artifact ID, expected/actual, `request_id`, correlation ID và owner đã liên hệ. Không gồm cookie, authorization header, OTP, workbook/report body hoặc PII.

