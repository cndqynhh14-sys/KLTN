# RUN-31 — Audit và cleanup dữ liệu test/demo NCC, Phiếu đánh giá

Ngày thực hiện: 2026-08-09
Database: `data/qlcl.db`
Run evidence: `artifacts/run31-cleanup/run31-2026-08-09T09-47-13-062Z`

## Kết luận

RUN-31 PASS. Toàn bộ dữ liệu nghiệp vụ NCC/Phiếu đánh giá và dependency đã được xóa. Database còn nguyên schema, master data, cấu hình câu hỏi/scoring/workflow/report, user, role và permission.

- `integrity_check`: `ok`.
- Foreign-key violation: `0`.
- Schema fingerprint trước/sau: không đổi.
- Bảng KEEP thay đổi fingerprint: `0`.
- File attachment/report đã backup: `6`; đã xóa khỏi runtime: `6`; còn lại: `0`.

## Backup trước cleanup

- File: `data/backups/run31/run31-2026-08-09T09-47-13-062Z/qlcl-pre-cleanup.db`.
- Kích thước: `3,829,760` bytes.
- SHA-256: `7cd16e8d20a18992a50f795366448cf56e0bff085ce7943951f76c54e342b1e1`.
- Backup integrity: `ok`; foreign-key violation: `0`; record count khớp database nguồn.
- Sáu file attachment/report được sao lưu dưới thư mục `files/` cùng run backup trước khi xóa khỏi runtime.

## Dependency và thứ tự xóa

Schema có 61 bảng. Không có bảng chưa phân loại và không có dependency ngoài kế hoạch trỏ vào bảng DELETE.

1. Report artifact: `report_artifact_events` → `report_exports` → `report_artifacts` → `report_source_snapshots` → `report_export_jobs`.
2. Workflow/phê duyệt: `approval_tasks`, `notifications`, `workflow_history`, `correction_extensions`.
3. Chi tiết đánh giá: `evaluation_nonconformities`, `evaluation_attachments`, `evaluation_participants`, `evaluation_answers`.
4. Phiếu đánh giá: `evaluation_rounds` → `evaluation_tickets`.
5. NCC: `supplier_master_history` → `supplier_master` → `supplier_import_batches`.

Các trigger immutable của riêng report artifact được tạm tháo trong cùng transaction bảo trì và được tạo lại nguyên văn. Schema fingerprint xác nhận không có thay đổi sau transaction. `audit_events` và `access_log` không bị xóa vì là nhật ký bảo mật/tuân thủ bất biến, không phải dữ liệu nghiệp vụ được dashboard hoặc màn hình NCC/Phiếu sử dụng.

## Record count trước/sau

| Bảng | Trước | Sau |
|---|---:|---:|
| report_artifact_events | 14 | 0 |
| report_exports | 85 | 0 |
| report_artifacts | 7 | 0 |
| report_source_snapshots | 7 | 0 |
| report_export_jobs | 7 | 0 |
| approval_tasks | 25 | 0 |
| notifications | 11 | 0 |
| workflow_history | 656 | 0 |
| correction_extensions | 0 | 0 |
| evaluation_nonconformities | 328 | 0 |
| evaluation_attachments | 14 | 0 |
| evaluation_participants | 184 | 0 |
| evaluation_answers | 1.727 | 0 |
| evaluation_rounds | 55 | 0 |
| evaluation_tickets | 37 | 0 |
| supplier_master_history | 0 | 0 |
| supplier_master | 19 | 0 |
| supplier_import_batches | 2 | 0 |

## Master/configuration được giữ nguyên

- Identity/RBAC: 13 user, 9 role, 23 permission, 62 role-permission, 13 user-role, 17 scope assignment và 42 auth session.
- Master data: 1 catalog, 56 dòng merchandise hierarchy.
- Question configuration: 4 template, 4 version, 835 question item, 17 variant và 17 assignment.
- Scoring configuration: 1 policy, 1 version và 1 assignment.
- Workflow configuration: 3 approval-stage assignment; workflow definition không thay đổi.
- Report configuration: 3 definition, 5 template, 6 version và 5 assignment.
- Platform: 30 schema migration; module Quản trị và cấu hình liên quan giữ nguyên.
- Security/compliance: 493 access log, 160 audit event và 4 retention policy giữ nguyên trong transaction cleanup.

## Evidence

- `dependency-audit.json`: toàn bộ FK, classification DELETE/KEEP và dependency closure.
- `pre-cleanup-counts.json`: count nghiệp vụ cùng fingerprint KEEP trước cleanup.
- `backup-verification.json`: checksum, integrity và count của backup.
- `business-file-backup-manifest.json`: manifest file attachment/report đã backup.
- `post-cleanup-verification.json`: count sau, fingerprint, schema, FK, integrity và file runtime.
- `quality-gates.json`: lệnh, số test và kết quả lint/build/diff check.
- `uat-evidence.json`: kết quả UAT các màn hình NCC, Phiếu đánh giá, Phê duyệt và Dashboard.

## Quality gate và UAT

- Focused regression: `30/30` PASS, gồm cleanup graph, idempotence, backup phục hồi được, RBAC, import template và dashboard aggregate.
- Full test: `393` PASS, `0` FAIL, `1` SKIP có chủ đích (`test:webapp` chỉ chạy khi bật `RUN_WEBAPP_E2E=1`).
- Lint: `265` file được kiểm tra, `0` lỗi.
- Build CSS: PASS.
- UAT trên `http://127.0.0.1:3005/qlcl` với phiên chuyên viên hiện tại:
  - Danh mục NCC hiển thị `0 NCC` và empty state hợp lệ; danh mục MCH2 vẫn còn nguyên.
  - Phiếu đánh giá hiển thị `0 phiếu`, mọi KPI trạng thái bằng `0` và empty state hợp lệ.
  - Dashboard kỳ tháng 08/2026 có bốn KPI bằng `0`; cả Tổng quan và Chi tiết đều hiển thị empty state đúng, không lỗi render.
  - Route Phê duyệt vẫn chặn tài khoản chuyên viên đúng RBAC; DB xác nhận `approval_tasks = 0`.
  - Console trình duyệt: `0` error, `0` warning.

## Cách chạy lại

Audit không thay đổi dữ liệu:

```text
node scripts/cleanup-ncc-evaluation-test-data.js
```

Backup và cleanup idempotent:

```text
node scripts/cleanup-ncc-evaluation-test-data.js --execute
```

Script luôn backup database trước, kiểm tra dependency closure, bật foreign key, chạy transaction child → parent và fail-closed nếu xuất hiện schema/dependency chưa được phân loại an toàn.
