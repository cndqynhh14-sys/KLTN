<a id="role-permission-management"></a>
# Quản lý user, role, permission, scope và approver

Tài liệu dành cho Admin được ủy quyền. Hệ thống dùng mã bất biến để ra quyết định; label chỉ để hiển thị.

## Khái niệm cần biết

- **user** là tài khoản; một user có thể có nhiều role theo thời hạn.
- **role** là tập quyền có mã ổn định. Đổi nhãn không đổi `role_code`.
- **permission** là capability như `USER.MANAGE`, `SYSTEM.ADMIN`; UI không dựa vào tên role.
- **scope** giới hạn dữ liệu như GLOBAL, REGION, MCH2, ASSIGNED, OWN hoặc SUPPLIER.
- **approval assignment** gán người/role vào workflow, stage, scope và priority.
- **effective rights** là kết quả sau khi kết hợp role đang hiệu lực, thời gian, scope và quy tắc `DENY` thắng `ALLOW`.

<a id="prerequisites"></a>
## Điều kiện trước khi làm

- Đăng nhập bằng tài khoản thử được ủy quyền, có owner và ticket thay đổi.
- Có mã role/scope mục tiêu, `valid_from`, `valid_to`, lý do nghiệp vụ và người phê duyệt.
- Biết ai là super-admin cuối cùng; không thử vô hiệu hóa người này.
- Dùng fixture như `user.fixture@qlcl.invalid`; không dùng user production cho smoke.

<a id="permissions"></a>
## Quyền cần có

- `USER.MANAGE` để mở và thay đổi Tài khoản & phân quyền.
- `SYSTEM.ADMIN` là quyền nhạy cảm, không được tự cấp. Gán role `SYS_ADMIN`, GLOBAL scope hoặc quyền audit/export cần reason và exact confirm.
- Người thiếu permission không thấy action; người có permission nhưng thiếu điều kiện sẽ thấy disabled reason.

<a id="quick-start-admin"></a>
<a id="steps"></a>
## Các bước vận hành

### Clone vai trò và preview quyền

1. Mở **Quản trị → Tài khoản & phân quyền → Vai trò**.
2. Chọn role nguồn, bấm **Clone vai trò**; đặt mã custom mới. Không tái sử dụng mã hệ thống.
3. Chỉnh label/mô tả, thêm permission theo module/risk. Đọc cảnh báo với publish, admin, global export và audit.
4. Chọn scope mặc định, mở **Effective preview**, nhập user fixture và ngày kiểm tra.
5. Xác nhận bảng ALLOW/DENY, nguồn role và conflict explanation. Một `DENY` phù hợp phải thắng mọi `ALLOW`.
6. Nhập reason/exact confirm khi UI yêu cầu, rồi lưu. Đổi label sau này không được đổi code hoặc workflow.

### Gán role có thời hạn và scope

1. Mở **Người dùng**, chọn user, thêm nhiều role nếu cần.
2. Đặt `valid_from` và `valid_to`; không để thời hạn mơ hồ cho quyền tạm thời.
3. Chọn scope override. MCH2 phải dùng ID catalog, không nhập nhãn tự do.
4. Preview effective rights tại đầu, giữa và sau ngày hết hạn; giải quyết conflict trước khi lưu.
5. Lưu và xác nhận hệ thống tăng `authz_version`, **thu hồi phiên** đang mở. User phải đăng nhập lại.

### Phân công approver

1. Mở **Phân công phê duyệt**, chọn workflow/stage, user hoặc role, scope và priority.
2. Chạy preview trên fixture. Không publish stage nếu thiếu candidate hoặc hai assignment xung đột cùng priority/scope.
3. Nhập reason/exact confirm, publish rồi kiểm tra lịch sử before/after và correlation ID.

### Guard bắt buộc

- Self-escalation bị chặn: người thao tác không thể làm tăng quyền/scope hiệu lực của chính mình.
- Last super-admin bị chặn ở service và database.
- Role hệ thống không xóa; custom role đang dùng phải được gỡ assignment có kiểm soát.

<a id="expected-result"></a>
## Kết quả mong đợi

- Catalog hiển thị đúng user count, permission count, trạng thái và version cập nhật.
- Effective rights giải thích được permission đến từ đâu, scope nào và DENY/conflict nào chi phối.
- Session cũ không tiếp tục dùng quyền trước thay đổi; mọi thay đổi có before/after, reason, correlation và `authz_version`.

<a id="rollback"></a>
## Hoàn tác

Tạo một thay đổi quản trị mới: khôi phục permission/scope/assignment trước đó, nhập lý do và exact confirm. Không sửa `roles`, `user_roles` hoặc audit bằng SQL. Nếu thay đổi ảnh hưởng nhiều user, thu hồi phiên của toàn bộ user bị tác động rồi smoke lại bằng fixture.

<a id="escalation"></a>
## Escalation

Nếu gặp `forbidden_permission`, `forbidden_scope`, `assignment_expired` hoặc `approval_assignment_missing`, ghi role/user fixture, stage, scope, thời điểm, route, expected/actual, `request_id` và correlation ID. Không gửi cookie, OTP hoặc nội dung dữ liệu. Escalate Security Owner khi liên quan `SYSTEM.ADMIN`/GLOBAL/audit; Workflow Owner khi candidate/stage sai.

Xem thêm [quick start theo vai trò](README.md#quick-start-admin) và [rollback cấu hình](../admin-runbook/configuration-rollback.md#authorization).

