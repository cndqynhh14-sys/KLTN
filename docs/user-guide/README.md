# Hướng dẫn vận hành QLCL

Tài liệu này là lối vào nhanh theo vai trò. Các bước dùng dữ liệu thử nghiệm tổng hợp, không dùng tài khoản hay hồ sơ thật. Mọi thao tác nhạy cảm phải giữ lại `request_id`, mã quyết định và kết quả kiểm tra để truy vết.

<a id="quick-start-admin"></a>
## Quick start — Admin

1. Mở **Quản trị → Tài khoản & phân quyền** và kiểm tra mình có `USER.MANAGE`.
2. [Clone vai trò, đặt thời hạn và xem quyền hiệu lực](role-permission-management.md#quick-start-admin). Không tự gán thêm quyền cho chính mình; dùng một tài khoản thử `admin.fixture@qlcl.invalid` để preview.
3. Chọn phạm vi dữ liệu, kiểm tra `DENY`, xung đột và approval assignment trước khi lưu.
4. Với thay đổi nhạy cảm, nhập lý do, xác nhận đúng chuỗi UI yêu cầu và để người có thẩm quyền độc lập thực hiện bước publish nếu quy trình yêu cầu.
5. Sau khi đổi role/scope, xác nhận phiên cũ đã bị thu hồi và đăng nhập lại bằng tài khoản thử để kiểm tra menu, deep link và effective rights.
6. Khi có lỗi, ghi thời điểm, route, thao tác, `request_id`; không chụp cookie, mã xác thực hoặc dữ liệu cá nhân.

Kết quả nhanh: role có mã ổn định, user chỉ thấy dữ liệu và action đúng scope, lịch sử thay đổi có before/after. Hoàn tác bằng thay đổi mới có lý do, không sửa trực tiếp DB.

<a id="quick-start-designer"></a>
## Quick start — Designer

1. Với câu hỏi, mở **Quản trị → Bộ câu hỏi**, [Clone thành Draft](question-template-management.md#quick-start-designer), chỉnh nội dung rồi Lưu nháp.
2. Nếu nhập workbook, tải [file mẫu canonical](question-template-import.md#download-sample), chạy Preview, đọc diff/lỗi, sau đó mới Commit vào Draft. Commit không publish.
3. Validate Draft, xem impact và gửi Review. Published chỉ đọc; muốn sửa phải Clone Draft mới.
4. Với báo cáo, [backup definition package rồi Clone Draft](report-template-management.md#quick-start-designer). Chỉnh component/binding trong Standard mode, preview bằng fixture tổng hợp và so HTML/PDF/XLSX.
5. Ghi lại version, checksum và warning. Không dùng Advanced JSON nếu không có `REPORT_TEMPLATE.ADVANCED`.
6. Bàn giao publisher bằng version ID và kết quả validate/preview; giữ `request_id` nếu có lỗi.

Kết quả nhanh: thay đổi chỉ nằm trong Draft, production và ticket cũ chưa đổi. Quay lại bằng cách bỏ Draft chưa publish hoặc khôi phục snapshot Draft/import batch đúng hướng dẫn.

<a id="quick-start-publisher"></a>
## Quick start — Publisher

1. Đảm bảo không phải người submit khi quy trình four-eyes áp dụng và có quyền publish tương ứng.
2. Đọc diff, validation, impact, scope/effective window và cảnh báo trước khi duyệt.
3. Câu hỏi: publish version Review, kiểm tra default cho ticket mới và xác nhận ticket cũ vẫn pin version cũ. Xem [publish và pin](question-template-management.md#publish-and-pin).
4. Báo cáo: chạy preview fixture, so ba format, kiểm tra definition/template/policy provenance rồi [publish/default/smoke](report-template-management.md#publish-impact).
5. Nếu thay công thức điểm, dùng Scoring Policy, chạy impact simulation và có Decision ID; không sửa Overview để lách phê duyệt.
6. Khi smoke không đạt, dùng [configuration rollback](../admin-runbook/configuration-rollback.md#report-template), ghi `request_id` và thông báo owner.

Kết quả nhanh: chỉ Published/default mới ảnh hưởng tác vụ mới; ticket và artifact lịch sử không bị tính lại.

<a id="quick-start-auditor"></a>
## Quick start — Auditor

1. Dùng quyền đọc/audit, không xin quyền manage chỉ để kiểm tra lịch sử.
2. Đối chiếu version ID, checksum, scope/effective window, before/after, người submit/publish, Decision ID và correlation/request ID.
3. Với report, kiểm tra definition code, template version/hash, question version, scoring policy/checksum, context hash, renderer/app commit và artifact SHA-256 trong history provenance.
4. Với legacy alias, xác nhận deprecation/mapping version; không chấp nhận silent fallback từ round 2 sang round 1.
5. Với lỗi, theo [Symptoms → Cause → Check → Resolution → Escalation](report-troubleshooting.md#error-codes); chỉ lưu mã lỗi và metadata an toàn.
6. Không tải hoặc đưa dữ liệu thật vào evidence. Dùng fixture tổng hợp và ghi `request_id` đã được redaction.

Kết quả nhanh: mỗi quyết định và output truy nguyên được tới version/context/artifact; không sửa history hoặc hard-delete để “làm sạch” sai lệch.

