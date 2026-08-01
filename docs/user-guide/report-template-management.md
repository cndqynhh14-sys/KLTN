<a id="report-template-management"></a>
# Quản lý mẫu báo cáo và Overview

Workspace quản lý ba canonical definition `WORKING_MINUTES`, `ROUND1_RESULT`, `ROUND2_RESULT`. `INTERNAL`/`NCC` chỉ xuất hiện ở Migration/Archived khi có history; UI không tạo legacy mới.

<a id="prerequisites"></a>
## Điều kiện trước khi làm

- Chọn canonical definition, source version, owner, scope/effective window và sample/fixture ticket đúng type/round.
- Có kế hoạch backup, smoke và rollback. Xác nhận gate production/publisher nếu định publish.
- Đọc [phân biệt Overview và Scoring Policy](compliance-overview-and-scoring-policy.md#layout-vs-score) trước khi sửa phần tổng quan.

<a id="permissions"></a>
## Quyền cần có

- `REPORT.READ` để xem catalog/version và nguồn preview được phép.
- `REPORT_TEMPLATE.MANAGE` để Clone/tạo/sửa/import Draft, validate và submit.
- `REPORT_TEMPLATE.PUBLISH` để publish/default/rollback.
- `REPORT_TEMPLATE.ADVANCED` riêng cho Advanced JSON; quyền này không bypass schema hoặc sanitizer.
- `SCORING_POLICY.MANAGE/PUBLISH` mới được sửa/publish công thức điểm; report permission không cấp quyền đó.

<a id="quick-start-designer"></a>
<a id="steps"></a>
## Các bước vận hành

### Backup và tạo Draft

1. Mở **Quản trị → Mẫu báo cáo**, chọn definition/version Published hiện tại.
2. Tải **definition package** trước khi thay: package chỉ gồm manifest/schema/JSON/style/checksum, không có ticket data.
3. Bấm **Clone Draft** từ exact version. Ghi version ID/checksum nguồn.
4. Không import package lạ vào Published; import hợp lệ luôn tạo Draft và xử lý code conflict có lựa chọn.

### Chỉnh builder

1. Ở **Cấu trúc**, sắp xếp component tree; dùng move up/down và một component ID ổn định.
2. Ở **Dữ liệu**, chọn binding allowlist. Không nhập token tùy ý hoặc raw unsafe HTML.
3. Ở **Trình bày**, chỉnh style/layout. Standard mode không cho raw HTML; Advanced JSON vẫn schema validate, diff và sanitize.
4. Overview editor chỉ đổi title/category/order/chart/legend/display. Policy field read-only nếu thiếu scoring permission.
5. Lưu Draft với optimistic lock; khi conflict, giữ form rồi so version trước khi áp lại.

### Preview và so format

1. Chọn synthetic fixture hoặc sample ticket đúng definition/round và được phép đọc.
2. Kiểm tra template version, policy version, data contract, missing binding, overflow/page và chart warning.
3. Dùng compare before/after với Published default.
4. So semantic title, totals, conclusion, category/order và provenance giữa Preview/HTML/PDF/XLSX. Layout XLSX có thể khác, nhưng component/value/total/conclusion/order phải cùng semantic model.

### Validate, Review và publish

1. Chạy Validate đến khi không còn lỗi chặn; đọc toàn bộ warning/impact.
2. Submit chuyển Draft sang Review; Published luôn read-only.
3. Publisher độc lập xác nhận definition/version/checksum, scope/effective window, before/after và ba format.

<a id="publish-impact"></a>
4. Publish mới được đổi output production và default assignment. Sau publish, smoke một fixture và một ticket được phép: preview, export, immediate download và history download.
5. Ghi provenance gồm definition/template version/hash, question version, scoring policy/checksum, context hash, renderer/app commit và artifact SHA-256.

<a id="expected-result"></a>
## Kết quả mong đợi

- Draft preview phản ánh thay đổi nhưng export production vẫn dùng Published default.
- Publish/default chỉ tác động render mới trong đúng scope/effective window; history artifact cũ giữ bytes và provenance cũ.
- Cùng pinned context/version cho HTML/PDF/XLSX, không canonical path bỏ qua version.

<a id="rollback"></a>
## Hoàn tác

Dùng action rollback để đổi default về version Published/Retired đã duyệt, rồi chạy lại smoke. Không sửa JSON Published, không xóa export/job/artifact/source snapshot và không regenerate history để che lỗi. Hướng dẫn chi tiết: [rollback report template](../admin-runbook/configuration-rollback.md#report-template).

<a id="escalation"></a>
## Escalation

Ghi definition code, version/status/checksum/lock, scope, fixture/ticket synthetic ID, round, format, warning/error code, job/artifact ID, expected/actual, `request_id` và correlation ID. Dùng [bảng xử lý lỗi](report-troubleshooting.md#error-codes); không gửi report bytes hoặc context thật.

