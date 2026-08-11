# RUN-33 — Chuẩn hóa Phiếu đánh giá và địa điểm đánh giá

## Kết quả

- Form lập Phiếu đánh giá được tổ chức thành 6 nhóm nghiệp vụ theo yêu cầu. Thứ tự hiển thị: Đánh giá, Ngành hàng, Nhà cung cấp, Liên hệ NCC, Đơn vị liên kết/gia công, Bộ tiêu chí.
- Phiếu có thể chọn NCC hiện có hoặc nhập NCC mới. `supplier_code` được normalize; NCC trùng mã được tái sử dụng và NCC mới được tạo cùng transaction với phiếu.
- Mỗi phiếu lưu snapshot NCC, liên hệ, ngành hàng, sản phẩm và địa điểm độc lập. Không lấy fallback địa điểm từ `supplier_master`.
- Ba trường hợp địa điểm hợp lệ: chỉ NCC, chỉ đơn vị liên kết/gia công, hoặc cả hai. Tên và địa chỉ đơn vị liên kết phải đi theo cặp.
- Không tạo bảng đơn vị liên kết/gia công và không thêm trường phạm vi đánh giá.
- Phần điểm số, vòng đánh giá, workflow, phê duyệt, lịch sử và action hiện hành được giữ nguyên.
- Chưa import dữ liệu lịch sử.

## Schema và migration

- `0032_normalize_evaluation_ticket_locations.sql` đổi tên:
  - `evaluation_address` → `snapshot_evaluation_address`
  - `linked_facility_name` → `snapshot_linked_facility_name`
  - `linked_facility_address` → `snapshot_linked_facility_address`
- `0033_normalize_evaluation_ticket_product_snapshot.sql` đổi `product_name` → `snapshot_product_name`.
- `supplier_id` tiếp tục `NOT NULL`.
- Giữ `supplier_introduction` vì màn chấm điểm đang sử dụng.
- Giữ `evaluation_department` vì vẫn có dependency hợp lệ trong reporting/export và test tương thích.

## Đồng bộ implementation

- Repository create/update dùng các cột snapshot chuẩn hóa.
- Service xác thực snapshot NCC, CMC/MCH, sản phẩm, email/điện thoại và quy tắc địa điểm; resolve scoring policy ở backend.
- API trả các field snapshot chuẩn và giữ alias response cũ tại biên tương thích.
- Frontend gửi payload snapshot chuẩn; popup chi tiết chỉ tái cấu trúc vùng thông tin phiếu.
- Report và export đọc cột snapshot mới, không thay đổi contract báo cáo bên ngoài.

## Evidence

- Red regression ban đầu: 0/3 PASS do thiếu cột snapshot, form chưa đủ 6 nhóm và SQL chưa dùng snapshot.
- Focused regression cuối: 38/38 PASS.
- Full test: 400 test; 399 PASS, 1 E2E được skip trong full suite và chạy riêng bằng `npm run test:webapp`.
- Lint: 268 tệp, 0 lỗi.
- Build: PASS.
- UAT synthetic: 6/6 PASS, run `ffddb4f3-21d0-4594-9cb2-7948060e891d`.
- SQLite `integrity_check`: `ok`; `foreign_key_check`: 0 vi phạm.
- Sau cleanup của UAT: `supplier_master = 0`, `evaluation_tickets = 0`.

Chi tiết máy đọc được lưu tại `artifacts/run33-evaluation-tickets/verification.json`.
