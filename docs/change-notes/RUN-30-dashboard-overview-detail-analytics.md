# RUN-30 — Điều hướng Tổng quan/Chi tiết và dashboard phân tích NCC

Ngày thực hiện: 2026-08-09

## Phạm vi

- Hợp nhất dashboard tại `qlcl/#/dashboard`; loại màn hình độc lập `qlcl/#/dashboard/ncc-evaluations` khỏi navigation manifest và HTML.
- Giữ nguyên header, kỳ báo cáo, bộ lọc, nút Làm mới và bốn KPI khi chuyển chế độ.
- Giữ backend aggregate cũ để không phá vỡ compatibility; bookmark cũ được thay URL tại chỗ về dashboard hợp nhất.

## Thay đổi chính

- Thêm segmented control `Tổng quan / Chi tiết` ngay dưới bốn KPI.
- Chuyển chế độ bằng local state, không reload, không gọi lại API và không reset bộ lọc.
- Chỉ panel đang chọn được hiển thị và render; canvas của panel ẩn được giải phóng.
- Tổng quan giữ ba thành phần hiện hành: Tiến độ kế hoạch, Xu hướng đánh giá NCC theo tháng và Top 10 NCC.
- Chi tiết gồm:
  - Pie phân bố mức xếp loại theo kết quả gần nhất của từng NCC duy nhất.
  - Bar ngang 100% hiệu quả theo ngành hàng với ngưỡng đạt `>= 60%`.
  - Bar ngang tỷ lệ nhóm vi phạm theo số lượt vi phạm, sắp xếp giảm dần.
- Layout Chi tiết dùng tỷ lệ `65% : 35%` ở hàng đầu và toàn chiều rộng cho hàng dưới; chuyển một cột trên màn hình hẹp.
- File xuất CSV được bổ sung ba vùng dữ liệu phân tích chi tiết.

## Quy tắc dữ liệu

- Mức xếp loại: `<60`, `60–75`, `>75–90`, `>90`; tỷ lệ tính trên tổng NCC đã đánh giá sau bộ lọc.
- Hiệu quả ngành hàng: mỗi NCC lấy kết quả mới nhất trong ngành; thống kê tổng, đạt, không đạt, tỷ lệ và điểm trung bình.
- Vi phạm: ưu tiên từng KPH đã lưu; câu trả lời B/C/D chưa có KPH được bổ sung như một lượt, không đếm trùng cùng câu trả lời.
- Kỳ báo cáo, khu vực, loại đánh giá và ngành hàng dùng chung một request nên tác động đồng bộ đến KPI và cả hai chế độ biểu đồ.

## Regression evidence

- Focused RUN-30 và dashboard/navigation/action regression: PASS `38/38`.
- Kiểm thử khóa công thức kết quả gần nhất theo NCC, phân nhóm điểm, ngưỡng đạt, lượt vi phạm, bộ lọc dùng chung, route hợp nhất, màu và tooltip.

## Quality gate và UAT

- Focused dashboard/navigation/action test: PASS `38/38`.
- Full test: PASS `391`, FAIL `0`, SKIP `1` E2E tùy chọn (`392` test tổng cộng).
- Lint: PASS, `263` file được kiểm tra, `0` lỗi.
- Build CSS: PASS.
- UAT desktop `1440 × 900`: PASS; segmented control cách KPI `18px`, hai card hàng đầu rộng `701px / 378px` (xấp xỉ `65% / 35%`), không tràn ngang.
- UAT mobile `390 × 844`: PASS; hai card xếp một cột `343px`, không tràn ngang.
- Chuyển tab giữ nguyên URL và kỳ `Tháng 08/2026`; panel ẩn không còn canvas hiển thị đồng thời.
- Bookmark `#/dashboard/ncc-evaluations?month=2026-08` được thay tại chỗ thành `#/dashboard?periodType=MONTH&periodValue=2026-08`; view cũ không còn trong DOM.
- Browser console: không có warning/error.
