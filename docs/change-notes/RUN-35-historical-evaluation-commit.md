# RUN-35 — Commit dữ liệu Phiếu đánh giá lịch sử

## Kết quả

RUN-35 đã commit thành công workbook `Data Phieu danh gia NCC.xlsx` vào database thật. Import chạy trong một transaction, không phát sinh rollback và lần chạy thứ hai tạo mới 0 bản ghi.

Workbook được khóa theo SHA-256:

`c13494cc5d7c1efc3180660114b486f64256edbf8c02b6adfa4b661ccf898f7e`

## Trạng thái migration

Preflight phát hiện database thật đã ở migration `0034`, thay vì `0033` như baseline dự kiến. Nguyên nhân là lần khởi động localhost trước RUN-35 đã áp dụng migration tự động. Ledger migration và checksum của `0034` khớp với file migration hiện hành; tại thời điểm kiểm tra chưa có dữ liệu đánh giá lịch sử.

RUN-35 vì vậy không hạ schema về `0033` để chạy lại. Runner xác nhận `0034` hợp lệ rồi tiếp tục import.

## Backup

Backup được tạo khi server đã dừng, gồm:

- Bản database raw: `qlcl.db`.
- WAL raw: `qlcl.db-wal`.
- SHM raw: `qlcl.db-shm`.
- Bản SQLite nhất quán: `qlcl-consistent.db`.
- Manifest chứa kích thước và SHA-256 của từng file.

Manifest: `data/backups/run35/run35-2026-08-11T03-13-52-537Z/backup-manifest.json`.

## Đối soát trước và sau

| Chỉ số | Trước | Sau |
|---|---:|---:|
| Phiếu HISTORICAL | 0 | 370 |
| Round 1 | 0 | 370 |
| Round 2 | 0 | 107 |
| Phiếu chỉ có round 1 | 0 | 263 |
| KPH lịch sử | 0 | 832 |
| Answer lịch sử | 0 | 0 |
| Workflow history mới | 0 | 0 |
| Approval task mới | 0 | 0 |
| Notification mới | 0 | 0 |

Các chỉ số dữ liệu nguồn giữ đúng baseline:

- 5 phiếu thiếu điểm round 1; không tự gán điểm 0.
- 37 round 2 thiếu ngày khắc phục; không tự sinh hoặc fallback ngày.
- 370/370 dòng map đúng NCC theo `supplier_code`.
- Không có ticket thiếu `supplier_id` hợp lệ.

## Idempotency và toàn vẹn

Lần import thứ hai nhận diện 370 dòng là duplicate và tạo mới:

- 0 ticket.
- 0 round.
- 0 KPH.
- 0 participant snapshot.

`PRAGMA foreign_key_check` trả 0 lỗi và `PRAGMA integrity_check` trả `ok` sau commit và sau khi hoàn tất test/UAT.

## Điều chỉnh runtime phát hiện trong UAT

Sau khi có phiếu HISTORICAL, startup question reconciliation ban đầu coi các ticket không pin question version là orphan và chặn server khởi động. Đây là trạng thái hợp lệ của phiếu lịch sử.

`QuestionVersionService` đã được giới hạn để reconciliation và canonical V1 chỉ xử lý ticket `NATIVE`. Regression test xác nhận phiếu HISTORICAL vẫn giữ `template_id` và `question_template_version_id` rỗng mà startup reconciliation ở trạng thái sạch. Business rule của phiếu NATIVE không đổi.

## UAT

UAT bằng tài khoản quản trị đã PASS cho:

- Phiếu chỉ có round 1: `HIST-AFD69F8F-0353`.
- Phiếu có round 2: `HIST-19973DA1-0375`.
- Phiếu round 2 thiếu ngày khắc phục: `HIST-B946E933-0379`.
- Phiếu có KPH lịch sử: `HIST-9CAFF22E-0383`.
- NCC `2010909` có 15 phiếu lịch sử nhưng vẫn là một NCC.
- Dashboard tháng 07/2026: 11 NCC duy nhất, 28 phiếu, 27 đạt và 1 không đạt.

Tất cả phiếu HISTORICAL được hiển thị `Phiếu lịch sử`/`Chỉ đọc`. Menu dòng chỉ có xem chi tiết và xem lịch sử; không có chấm điểm, phê duyệt, khắc phục hoặc tạo round mới.

Evidence máy đọc: `artifacts/run35-historical-evaluations/uat-evidence.json`.

## Test và build

- Focused test: 6 pass, 0 fail.
- Full test trên database tạm tách biệt: 406 pass, 0 fail, 1 skip có chủ đích cho webapp E2E; UAT web đã được chạy thủ công trên localhost.
- Lint: 274 file được kiểm tra, 0 lỗi.
- Build: PASS. Có cảnh báo metadata `caniuse-lite` cũ, không làm build thất bại.

## Artifact

- Commit report: `artifacts/run35-historical-evaluations/commit-report.json`.
- UAT evidence: `artifacts/run35-historical-evaluations/uat-evidence.json`.
- Backup manifest: `data/backups/run35/run35-2026-08-11T03-13-52-537Z/backup-manifest.json`.

Kết luận: database thật đã commit thành công; không rollback.
