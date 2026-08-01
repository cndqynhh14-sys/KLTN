# RUN-23 — Migration rehearsal

Trạng thái: **NO-GO cho production** cho tới khi rehearsal chạy trên Node 20 clean checkout và IT Ops ký. Rehearsal hiện dùng fixture tổng hợp, không sao chép DB production. Mọi lỗi phải giữ `request_id`/run ID an toàn.

## Target và phạm vi

- Fresh DB áp toàn bộ migration theo thứ tự và foreign-key reconciliation sạch.
- Upgrade fixture pre-ledger/pre-RUN giữ nguyên synthetic row, adopt baseline rồi chạy phần còn lại.
- Retry không tạo ledger trùng; checksum/file missing fail closed.
- Backup → migrate → verify → restore/rollback → verify phải đọc lại được fixture và audit chain.
- Reconciliation không orphan question version/report artifact và không unexpected duplicate.

## Lệnh rehearsal

```powershell
node --version
npm ci
npm run test:migrations
node scripts/release-migration-rehearsal.js
npm run release:prepare
```

Node phải là `20.x`. Không dùng Node mới hơn để ký mục Node-20. Output machine-readable nằm ở `artifacts/release/run23/migration-rehearsal.json`.

## Các bước

1. **Fresh:** tạo SQLite tạm, bật foreign keys, áp M0001…migration cuối, kiểm ledger/checksum/table/FK.
2. **Upgrade:** dựng baseline pre-ledger và synthetic user `upgrade.run23@example.invalid`, migrate, kiểm row không đổi.
3. **Retry/checksum:** rerun toàn bộ; dùng migration sandbox để chứng minh lỗi transaction rollback và checksum mismatch bị chặn.
4. **Backup/restore:** backup database đã migrate, thay đổi fixture sau backup, restore bản backup sang path mới và verify ledger/FK/row.
5. **Rollback restore:** xác nhận thay đổi sau backup biến mất; production rehearsal phải dùng service restore có CRITICAL audit và chain verification.
6. **Reconciliation:** đếm orphan, duplicate, pin null và migration pending; count khác zero phải vào review queue hoặc blocker có owner/expiry.

## Failure và rollback

- Migration failure: dừng deploy, không restart app mới, giữ DB gốc và backup verified.
- Checksum mismatch: không sửa ledger; khôi phục source migration đúng commit.
- Restore failure: giữ active DB, không move/delete bằng lệnh thủ công; escalate IT Ops/DB Owner.
- Rollback application giữ schema expand-only; không drop Published/history/artifact.

GO khi fresh/upgrade/retry/checksum/backup/restore/rollback/reconciliation đều PASS trên Node 20 và evidence verify sạch. Nếu backup chưa restore thành công: **NO-GO**.

