# RUN-34 — Hỗ trợ Phiếu lịch sử và dry-run import dữ liệu đánh giá

## Kết quả

- Bổ sung loại nguồn `NATIVE`/`HISTORICAL`; phiếu lịch sử ở trạng thái hoàn thành và chỉ đọc.
- Phiếu `HISTORICAL` không cần template, phiên bản câu hỏi, scoring policy, loại cơ sở hoặc quy mô NCC. Validation và behavior của phiếu `NATIVE` được giữ nguyên.
- Không tạo template/câu hỏi/đáp án giả. `evaluation_answers` dự kiến tạo bằng 0.
- KPH lịch sử được lưu trực tiếp, không bắt buộc liên kết `evaluation_answer_id` và vẫn tham gia thống kê nhóm vi phạm.
- UI chi tiết hiển thị nguồn lịch sử, địa điểm, các vòng, điểm, kết luận và KPH; không mở màn chấm điểm, phê duyệt, khắc phục, gia hạn hoặc tạo vòng mới.
- Dashboard dùng NCC duy nhất, điểm vòng cuối, Đạt/Không đạt, ngành hàng, xu hướng và lỗi lịch sử; không đưa phiếu lịch sử vào thống kê câu hỏi/tiêu chí.
- Importer riêng có khóa nguồn ổn định, không gọi workflow NATIVE và chạy lại không tạo bản ghi mới.

## Schema và implementation

- Migration `0034_historical_evaluation_support.sql`:
  - thêm `source_kind` và metadata nguồn lịch sử vào `evaluation_tickets`;
  - cho phép các field template/scoring/location-classification thiếu chỉ với `HISTORICAL`;
  - cho phép vòng 2 lịch sử thiếu ngày mà không tự fallback;
  - cho phép KPH thiếu `evaluation_answer_id`, với unique index có điều kiện;
  - trigger tự pin scoring policy chỉ áp dụng cho `NATIVE`.
- Parser đọc trực tiếp workbook 45 cột và giữ payload nguồn.
- Importer map duy nhất theo `supplier_code`, tạo ticket/vòng/KPH/participant snapshot trong một transaction.
- Service/API khóa mutation của phiếu lịch sử bằng lỗi `historical_ticket_readonly` (HTTP 409).
- Repository/Service Dashboard nhận vòng cuối lịch sử ngay cả khi vòng 2 không có ngày khắc phục; kỳ báo cáo dùng ngày đánh giá thực tế của phiếu.

## Dry-run workbook

Nguồn: `Data Phieu danh gia NCC.xlsx`, sheet `Sheet1`, SHA-256 `c13494cc5d7c1efc3180660114b486f64256edbf8c02b6adfa4b661ccf898f7e`.

- Dòng nguồn/hợp lệ: 370/370; không hợp lệ: 0.
- NCC map thành công: 370; không map: 0.
- Ticket dự kiến: 370.
- Vòng 1: 370; chỉ vòng 1: 263; có vòng 2: 107.
- Vòng 2 do điểm thay đổi: 105; do lý do/ngày khi điểm không đổi: 2.
- Thiếu điểm vòng 1: 5; vòng 2 thiếu ngày khắc phục: 37.
- KPH dự kiến: 832; `evaluation_answers`: 0.
- Import lần đầu trên DB clone: 370 ticket, 477 vòng, 832 KPH, 835 participant snapshot.
- Import lần hai trên cùng clone: 370 duplicate; 0 ticket/vòng/KPH/participant mới.
- `foreign_key_check`: 0 lỗi; workflow/approval/notification: 0.

Chi tiết máy đọc được: `artifacts/run34-historical-evaluations/dry-run.json`.

## Evidence

- Red regression: thiếu module/importer HISTORICAL trước implementation.
- Focused RUN-34 + Dashboard: 18/18 PASS.
- Full test: 406 test; 405 PASS, 1 E2E skip theo harness và đã chạy riêng.
- Lint: 273 tệp, 0 lỗi.
- Build: PASS.
- UAT synthetic: 6/6 PASS, run `c5a8bb9f-b1bb-427d-b303-71b93fae6ee6`.
- DB thật sau dry-run: migration `0033`; `evaluation_tickets`, `evaluation_rounds`, `evaluation_answers`, `evaluation_nonconformities` đều bằng 0; không ghi dữ liệu import.

## Trạng thái

Dry-run PASS. Chưa áp migration `0034` và chưa import dữ liệu vào DB thật. Dừng tại đây để chờ xác nhận commit.
