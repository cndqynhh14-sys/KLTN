# RUN-32 — Thu gọn và chuẩn hóa Danh mục Nhà cung cấp

## Kết quả

RUN-32 đã chuyển `supplier_master` về đúng vai trò danh mục NCC duy nhất. `supplier_code`
được trim, chuẩn hóa chữ hoa và dùng làm business key duy nhất. Mã số thuế chỉ còn là
thông tin đối soát.

Không tạo bảng quản lý đơn vị liên kết/gia công. Các trường snapshot phục vụ từng lần
đánh giá vẫn được giữ nguyên trong `evaluation_tickets`.

## Schema trước và sau

Trước RUN-32, `supplier_master` có 33 cột. Sau migration `0031_simplify_supplier_master.sql`,
bảng còn 18 cột:

`id`, `supplier_code`, `supplier_name`, `tax_code`, `address`, `region`, `province`,
`business_type`, `status`, `contact_name`, `contact_email`, `contact_phone`, `source_type`,
`import_batch_id`, `created_at`, `created_by`, `updated_at`, `updated_by`.

15 cột đã drop vật lý:

- `production_address`
- `evaluation_address`
- `linked_facility_code`
- `linked_facility_name`
- `linked_facility_address`
- `linked_facility_type`
- `mch2`
- `mch3`
- `product_group`
- `product_name`
- `cmc_owner`
- `cmc_head`
- `business_license_file`
- `attp_certificate_type`
- `attp_certificate_file`

Migration tạo unique expression index trên `UPPER(TRIM(supplier_code))`. API và importer
cùng dùng helper `normalizeSupplierCode`, do đó mã có khác khoảng trắng/chữ hoa-thường
vẫn được nhận diện là cùng một NCC.

Compatibility adapter chỉ chuẩn hóa metadata không hợp lệ của database legacy trong
luồng forward-repair trước migration; startup bình thường không tái tạo cột deprecated.

## Dependency đã xử lý

- CRUD/list/detail/history NCC chỉ đọc/ghi bộ trường mới.
- Bỏ filter MCH2/MCH3 khỏi Danh mục NCC.
- Import NCC chỉ nhận 11 cột mới; kiểm tra mã trùng theo mã đã normalize, email, điện
  thoại, khu vực, tỉnh, loại hình kinh doanh và trạng thái.
- Template `database/templates/supplier-import-template.xlsx` được tạo lại với ba sheet
  `Danh sách NCC`, `Hướng dẫn`, `Danh mục`, có 11 cột và dropdown chuẩn.
- Export tổng hợp không còn SQL fallback vào cột deprecated của `supplier_master`.
- Khi chọn NCC để lập phiếu, frontend/backend không còn lấy địa điểm đánh giá, MCH,
  sản phẩm, CMC hoặc hồ sơ pháp lý từ NCC master. Dữ liệu này tiếp tục được lưu trên
  `evaluation_tickets`; chưa redesign nghiệp vụ địa điểm trong RUN-32.
- Dashboard vẫn đếm theo `supplier_id`/`supplier_code` và không phụ thuộc địa điểm master.
- Migration rehearsal từ snapshot 0029 được cập nhật để áp dụng `0030`, `0031`.

## UI

Popup Thêm/Sửa/Xem NCC chỉ còn hai nhóm và 11 trường:

1. Thông tin nhà cung cấp: Mã NCC, Tên NCC, Mã số thuế, Địa chỉ, Khu vực, Tỉnh,
   Loại hình kinh doanh, Trạng thái.
2. Thông tin liên hệ: Người liên hệ, Email liên hệ, Số điện thoại.

Bảng Danh mục NCC hiển thị: STT, Mã NCC, Tên NCC, Mã số thuế, Địa chỉ, Khu vực,
Tỉnh, Loại hình kinh doanh, Trạng thái, Thao tác. Tên NCC và Địa chỉ được ưu tiên
chiều rộng; text dài có ellipsis/tooltip; desktop không có horizontal scrollbar.

## Database hiện tại

- Migration ledger: 31 migration, pending 0, checksum không bị thay đổi.
- `supplier_master`: 0 record.
- `evaluation_tickets`: 0 record.
- `supplier_master_history`: 0 record.
- `supplier_import_batches`: 0 record.
- `PRAGMA foreign_key_check`: 0 vi phạm.
- `PRAGMA integrity_check`: `ok`.
- Toàn bộ 15 cột snapshot tương ứng vẫn tồn tại trong `evaluation_tickets`.
- Chưa import danh sách NCC chuẩn.

## Verification

- Focused regression cuối: 49/49 pass.
- Full test: 396 pass, 0 fail, 1 skip có chủ đích cho web E2E riêng.
- Lint: 267 file, 0 lỗi.
- Build CSS: pass.
- Migration rehearsal: pass.
- UAT desktop 1440×900: danh mục rỗng hợp lệ, bảng đúng cột, popup đúng 11 trường,
  `viewScrollWidth = viewClientWidth = 1173`.
- UAT mobile 390×844: mobile card empty state hợp lệ, popup rộng 375px trong viewport
  390px, không tràn ngang.
- Browser console: 0 error.
- UAT smoke synthetic: 6/6 pass, run ID `408d2833-4710-4315-ac6f-a20d8fdd7112`.
  Fixture Phiếu đánh giá nhập địa điểm/MCH/sản phẩm trực tiếp trên phiếu và xác nhận không
  còn fallback các giá trị này từ NCC master.
- UAT không lưu NCC và không import dữ liệu.

## Gate

PASS. Frontend/API/repository/schema/import đã đồng bộ; không còn runtime SQL tới cột
đã drop; không thêm bảng đơn vị liên kết/gia công; không thay đổi module Quản trị hoặc
master data nền; nghiệp vụ Phiếu đánh giá chỉ thay dependency bắt buộc.
