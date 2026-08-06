# RUN-26 — Thiết kế lại Dashboard đánh giá NCC

## Phạm vi

- Màn hình: `#/dashboard`.
- Giữ nguyên màn hình phân tích cũ `#/dashboard/ncc-evaluations` và API `/dashboard/ncc-evaluations`.
- Không thay đổi schema, workflow chấm điểm, công thức điểm hoặc dữ liệu nghiệp vụ.

## Contract báo cáo

- Kỳ báo cáo: `MONTH`, `QUARTER`, `YEAR` với khoảng ngày đầu kỳ và cận trên đầu kỳ kế tiếp.
- Bộ lọc dùng chung: khu vực, loại đánh giá và MCH2.
- KPI chỉ dùng phiếu chuyển sang `Hoàn thành` trong kỳ, còn hiệu lực tại cuối kỳ và có kết quả cuối hợp lệ.
- Điểm cuối: vòng 2 chính thức nếu tồn tại, nếu không dùng vòng 1 chính thức.
- Snapshot trạng thái: trạng thái workflow gần nhất tại cuối kỳ; Lead/TBP/GĐK gộp thành `Chờ phê duyệt`; phiếu kết thúc trước kỳ không tính lại.
- Top 10 nhóm bằng `supplier_id`, xếp theo điểm bình quân, số phiếu, ngày gần nhất và tên NCC.
- Xu hướng hiển thị sáu kỳ cùng độ phân giải với kỳ đang chọn.

## API

- `GET /qlcl/api/dashboard/statistics`
  - `periodType=MONTH|QUARTER|YEAR`
  - `periodValue=2026-07|2026-Q3|2026`
  - `regions`, `evaluationTypes`, `mch2`: danh sách phân tách bằng dấu phẩy.
- `GET /qlcl/api/dashboard/statistics/export`: xuất CSV theo đúng kỳ và bộ lọc hiện tại.
- Query cũ `period=YYYY-MM` vẫn được nhận như kỳ tháng.

## Trạng thái giao diện

- Loading skeleton cho KPI và thông báo tải dữ liệu.
- Empty state riêng cho donut, Top 10 và xu hướng.
- Error state có nút `Thử lại`.
- Dashboard responsive: 4 KPI desktop, 2 × 2 tablet, một cột mobile; bảng và biểu đồ xu hướng cho phép cuộn ngang khi cần.

## Evidence

- Focused tests:
  - `test/run13StatisticalDashboard.test.js`
  - `test/run08DashboardReportingPeriod.test.js`
  - `test/dashboardWorkflowAggregates.test.js`
- UAT localhost:
  - đăng nhập bằng tài khoản chuyên viên;
  - tải kỳ tháng 08/2026;
  - chuyển sang quý III/2026;
  - chọn bộ lọc khu vực MB và xác nhận KPI/donut/Top 10 đổi đồng bộ;
  - kiểm tra desktop 1280 px và mobile 390 × 844;
  - không có console error hoặc warning.
