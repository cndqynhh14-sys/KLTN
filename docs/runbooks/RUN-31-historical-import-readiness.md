# RUN-31 — Checklist sẵn sàng import dữ liệu lịch sử

## Trạng thái hiện tại

- [x] Database nghiệp vụ NCC/Phiếu đánh giá đã sạch.
- [x] Backup trước cleanup đã kiểm tra khả năng đọc, integrity và foreign key.
- [x] Master data, câu hỏi, scoring policy, workflow definition và RBAC còn nguyên.
- [x] Không còn report artifact/cache/materialized data nghiệp vụ cũ.
- [x] Dashboard dùng dữ liệu tính động; không cần rebuild cache trong RUN-31.
- [x] Chưa import NCC hoặc Phiếu đánh giá lịch sử trong RUN-31.

## Thứ tự thực hiện bắt buộc ở RUN import tiếp theo

1. Chốt file danh sách NCC chuẩn đúng 26 cột import.
2. Validate mã NCC duy nhất, trường bắt buộc, email/điện thoại dạng text, region–province và MCH2–MCH3.
3. Lập mapping mã NCC lịch sử → `supplier_master.id`; không map bằng tên khi đã có mã.
4. Import NCC bằng batch có transaction, row-level error và khả năng chạy lại theo `supplier_code`.
5. Đối soát tổng dòng nguồn, dòng hợp lệ, insert/update/fail, mã trùng và catalog mismatch.
6. Backup database lần nữa trước khi import Phiếu đánh giá lịch sử.
7. Validate ticket code, supplier mapping, ngày nghiệp vụ, phiên bản câu hỏi/scoring và dữ liệu vòng 1/vòng 2.
8. Import Phiếu đánh giá lịch sử theo transaction và provenance riêng.
9. Đối soát phiếu, vòng, câu trả lời, KPH, điểm, kết quả, trạng thái và ngày hoàn thành.
10. Mở dashboard/báo cáo để tái tổng hợp trực tiếp từ dữ liệu nghiệp vụ đã import.

## Nguyên tắc giữ nguyên lịch sử

- Giữ nguyên `current_status`, `current_round_no`, điểm, xếp loại, kết luận và các trường ngày từ dữ liệu lịch sử đã được duyệt.
- Pin đúng question-template version và scoring-policy version; không tự chấm lại bằng policy hiện tại.
- Không gọi API transition/phê duyệt hiện tại cho dữ liệu lịch sử.
- Không tự sinh notification, approval task hoặc replay workflow hiện hành.
- Nếu nhập lịch sử phê duyệt, ghi snapshot/history có provenance `HISTORICAL_IMPORT`; không giả lập actor hoặc thời điểm hiện tại.
- KPH/khắc phục phải gắn đúng ticket, round và answer; không tạo KPH từ A/NA.
- Mọi record không map chắc chắn phải vào hàng chờ xử lý, không tự suy đoán hoặc ghi vào live.

## Gate cho RUN import NCC

- [ ] File nguồn và checksum được chốt.
- [ ] Mapping danh mục không còn giá trị ngoài catalog.
- [ ] Mã NCC trùng hoặc `NCC mới` đã có quyết định rõ ràng.
- [ ] Dry-run count được duyệt.
- [ ] Backup pre-import PASS.
- [ ] Import NCC và đối soát PASS trước khi mở bước Phiếu đánh giá.

## Gate cho RUN import Phiếu lịch sử

- [ ] 100% mã NCC trên phiếu map được hoặc được loại có lý do.
- [ ] Question/scoring version mapping được chốt.
- [ ] Không replay workflow/phê duyệt hiện tại.
- [ ] Record count và điểm/kết quả khớp nguồn.
- [ ] Không orphan; `foreign_key_check = 0`; `integrity_check = ok`.
- [ ] Dashboard/Báo cáo tái tổng hợp đúng sau import.
