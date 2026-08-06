# RUN-28 — Hoàn thiện biểu đồ phân bố trạng thái xử lý

Ngày thực hiện: 2026-08-06

## Phạm vi

- Màn hình: `qlcl/#/dashboard`.
- Chỉ thay đổi phép tổng hợp và trình bày của biểu đồ Donut trạng thái.
- Không thay đổi workflow, schema, dữ liệu live, KPI, bảng Top 10 hoặc biểu đồ xu hướng.

## Thay đổi

- Giữ `Gia hạn` và `Tạm ngừng` trong ánh xạ workflow nhưng loại hai trạng thái này khỏi tập tổng hợp riêng của Donut.
- Tổng phiếu, tỷ lệ và góc lát được tính lại từ đúng các trạng thái thực sự hiển thị.
- Frontend lọc phòng thủ `EXTENDED` và `SUSPENDED`, kể cả khi nhận payload tương thích cũ.
- Legend chỉ tạo cho trạng thái có số lượng lớn hơn `0` và chỉ hiển thị màu cùng tên trạng thái.
- Bố cục Donut/legend chuyển thành `3fr/2fr`, tương ứng `60%/40%`.
- Độ dày lát thường tăng từ `27px` lên `40.5px`; lát đang chọn tăng từ `31px` lên `46.5px`.
- Vùng bắt hover/click được mở rộng tương ứng với vòng Donut mới.
- Áp dụng palette:
  - Khởi tạo: `#6E0012`.
  - Đang xử lý: `#930019`.
  - Chờ phê duyệt: `#BC0A25`.
  - Chờ khắc phục: `#DA1E38`.
  - Đang đánh giá lần 2: `#F02D48`.
  - Hoàn thành: `#E53945`.
  - Hủy: `#FFA0A8`.

## Regression evidence

- RED: focused test thất bại vì API còn trả `EXTENDED/SUSPENDED` và frontend vẫn dùng palette, legend, bố cục, độ dày cũ.
- GREEN: focused test PASS `7/7` sau implementation.
- Fixture synthetic xác nhận hai phiếu `Gia hạn/Tạm ngừng` không đi vào tổng Donut; tổng số lát và tổng tỷ lệ của các trạng thái còn lại khớp chính xác.

## Quality gate và UAT

- Focused test: PASS `7/7`.
- Full test: PASS `385`, FAIL `0`, SKIP `1` E2E tùy chọn (`386` test tổng cộng).
- Lint: PASS, `262` file được kiểm tra, `0` lỗi.
- Build CSS: PASS.
- UAT desktop `1280x720`: PASS; tổng tâm Donut `23`, legend chỉ có 6 trạng thái có dữ liệu, không có `EXTENDED/SUSPENDED`, trạng thái `CANCELLED` bằng 0 không xuất hiện.
- Tỷ lệ bố cục thực tế: `59.9995%/40.0005%`; màu render khớp palette yêu cầu.
- Tooltip lát `Khởi tạo`: hiển thị `Số phiếu: 6` và `Tỷ lệ: 26,1%`.
- UAT mobile `390x844`: PASS; legend chỉ gồm màu/tên, không tràn ngang.
- Browser console: không có warning/error.
