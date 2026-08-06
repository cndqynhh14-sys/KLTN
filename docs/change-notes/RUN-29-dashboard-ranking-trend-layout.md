# RUN-29 — Hoàn thiện Top 10 NCC và biểu đồ xu hướng

Ngày thực hiện: 2026-08-06

## Phạm vi

- Màn hình: `qlcl/#/dashboard`.
- Chỉ thay đổi layout/rendering của bảng Top 10 NCC và biểu đồ Xu hướng đánh giá NCC.
- Không thay đổi dữ liệu, KPI, quy tắc xếp hạng, service, repository hoặc contract API.

## Thay đổi bảng Top 10 NCC

- Thêm `colgroup` và `table-layout: fixed` để khóa tỷ lệ cột `10% : 50% : 20% : 20%`, tương ứng `1 : 5 : 2 : 2`.
- Căn giữa toàn bộ tiêu đề cột.
- Căn giữa dữ liệu Hạng, Điểm đánh giá bình quân và Xếp loại; giữ Nhà cung cấp căn trái.
- Xóa progress bar và số lượng phiếu khỏi ô điểm.
- Ô điểm chỉ hiển thị phần trăm, tối đa một chữ số thập phân.

## Thay đổi biểu đồ xu hướng

- Tăng công thức chiều rộng cột từ `min(46, step × 0.46)` lên đúng gấp đôi: `min(92, step × 0.92)`.
- Giữ tâm cột theo sáu khoảng chia đều để khoảng cách được phân bố đồng nhất.
- Bỏ `min-width: 680px`; canvas lấy chiều rộng container hiện tại.
- Tắt overflow ngang của chart wrapper và giới hạn canvas trong `100%` chiều rộng.
- Giữ nguyên line tỷ lệ không đạt, hai trục Y, tooltip và highlight kỳ được chọn.

## Regression evidence

- RED: focused test thất bại vì chưa có `colgroup`, căn lề/tỷ lệ mới và biểu đồ vẫn dùng min-width/công thức cột cũ.
- GREEN: focused test PASS `9/9` sau implementation.
- Regression test khóa tỷ lệ cột, alignment, score-only cell, công thức cột gấp đôi và các thành phần line/axes/tooltip/highlight.

## Quality gate và UAT

- Focused test: PASS `9/9`.
- Full test: PASS `387`, FAIL `0`, SKIP `1` E2E tùy chọn (`388` test tổng cộng).
- Lint: PASS, `262` file được kiểm tra, `0` lỗi.
- Build CSS: PASS.
- UAT desktop `1280x720`: PASS; tỷ lệ cột thực tế `0.1/0.5/0.2/0.2`, header căn giữa, dữ liệu `center/left/center/center`, ô điểm `99%` và không có progress bar.
- Chart desktop: `scrollWidth = clientWidth = 931px`; canvas hiển thị, document không tràn ngang.
- Tooltip desktop hiển thị đủ kỳ, số NCC, số đạt, số không đạt và tỷ lệ; không bị cắt khỏi viewport.
- UAT mobile `390x844`: PASS; chart `scrollWidth = clientWidth = 341px`, bảng không cần scroll nội bộ, document không tràn ngang.
- Tooltip mobile hiển thị đầy đủ và nằm hoàn toàn trong viewport.
- Browser console: không có warning/error.
