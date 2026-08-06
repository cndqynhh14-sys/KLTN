# RUN-27 — Tinh gọn bố cục Dashboard đánh giá NCC

Ngày thực hiện: 2026-08-06

## Phạm vi

- Màn hình: `qlcl/#/dashboard`.
- Chỉ thay đổi cấu trúc trình bày và typography phía frontend.
- Không thay đổi API, dữ liệu, bộ lọc, KPI hoặc business rule dashboard.

## Thay đổi

- Xóa thanh tìm kiếm nhanh trên page header và handler phím tắt `Ctrl/Command + K` liên quan.
- Xóa mô tả phụ dưới tiêu đề Dashboard, caption kỳ báo cáo và mô tả phụ của ba khu vực nội dung.
- Giữ nguyên ba tiêu đề chính:
  - Phân bố phiếu theo trạng thái xử lý.
  - Top 10 NCC theo điểm đánh giá.
  - Xu hướng đánh giá NCC.
- Tăng tiêu đề khu vực từ `14px` lên `18px`, dùng font-weight `800`.
- Cân lại padding và alignment của card header sau khi xóa nội dung phụ.

## Regression evidence

- RED: `node --test test/run13StatisticalDashboard.test.js` thất bại tại case RUN-27 vì thanh tìm kiếm và nội dung phụ vẫn tồn tại.
- GREEN: cùng lệnh trên PASS `5/5` sau implementation.
- Regression test kiểm tra không còn DOM/handler tìm kiếm, không còn các chuỗi mô tả phụ và typography tiêu đề đạt `18px/800`.

## Xác nhận tương thích

- API và contract dashboard không đổi.
- Bộ lọc, KPI, biểu đồ donut, bảng Top 10 và biểu đồ xu hướng vẫn dùng luồng dữ liệu hiện hành.

## Quality gate và UAT

- Focused test: PASS `5/5`.
- Full test: PASS `383`, FAIL `0`, SKIP `1` E2E tùy chọn (`384` test tổng cộng).
- Lint: PASS, `262` file được kiểm tra, `0` lỗi.
- Build CSS: PASS.
- UAT desktop `1280x720`: PASS; đủ 4 KPI, không còn search/caption/nội dung phụ, ba tiêu đề đạt `18px/800`, không tràn ngang.
- UAT mobile `390x844`: PASS; ba tiêu đề hiển thị, không tràn ngang.
- Browser console: không có warning/error.
