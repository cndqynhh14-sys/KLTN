# RUN-23 — Traceability release

Trạng thái hiện tại: **NO-GO**. Ma trận này nối RUN → commit → migration → API → UI → test → decision → evidence. `request_id` của UAT chỉ được lưu trong safe trace đã redaction.

## Quy ước

- `working-tree` nghĩa là thay đổi chưa có commit riêng, không đủ điều kiện package release.
- `M0` không có migration; `Mxxxx` chỉ migration chính, không phải danh sách đầy đủ phụ thuộc.
- Evidence ID lấy từ change note. Thiếu change note/evidence/commit là blocker, không suy đoán.

## Ma trận RUN-00…23

| RUN | Commit / trạng thái | Migration | API chính | UI chính | Test/evidence | Decision | Gate |
|---|---|---|---|---|---|---|---|
| RUN-00 | baseline trước `1587e738` | M0 | baseline inventory | baseline inventory | failure baseline; change note riêng chưa có | decision register | REVIEW |
| RUN-01 | chưa có commit/change note tách biệt | M0001 | schema/bootstrap | nền SPA | evidence riêng chưa truy được | baseline | NO-GO |
| RUN-02 | chưa có commit/change note tách biệt | M0 | redaction/evidence | không UI | evidence protocol tests | security redactor | REVIEW |
| RUN-03 | chưa có commit/change note tách biệt | M0 | backup/deploy | không UI | restore/deploy tests | deploy safety | REVIEW |
| RUN-04 | chưa có commit/change note tách biệt | M0 | UAT harness | desktop/mobile smoke | UAT harness | UAT-001 PENDING | NO-GO |
| RUN-05 | base `ec57dee9`; dirty integration | M0002 | RBAC foundation | capability envelope | RUN-05 note | AUTHZ-001 PENDING | NO-GO |
| RUN-06 | base `ec57dee9`; dirty integration | M0003 | policy/scope/allowed_actions | guarded routes/actions | `44854141-a9ae-4c5a-829c-a55469405271` | AUTHZ-001 PENDING | NO-GO |
| RUN-07 | base `ec57dee9`; dirty integration | M0004 | append-only audit/restore | audit trace | `d4c10ed6-e8ab-4079-8d39-0e1a05b3d0ed` | OBS/UAT pending | NO-GO |
| RUN-08 | base `66e43c61`; working-tree | M0005 | audit list/detail/export/retention dry-run | system logs | change note RUN-08 | OBS-001 PENDING | NO-GO |
| RUN-09 | base `66e43c61`; working-tree | M0 | OTP delivery/session guards | temporary screen OTP | change note RUN-09 | OTP-001 PENDING-GUARDED | NO-GO |
| RUN-10 | base `66e43c61`; working-tree | M0006 | authorization admin | RBAC workspace | change note RUN-10 | AUTHZ-001 PENDING | NO-GO |
| RUN-11 | base `66e43c61`; working-tree | M0 | manifest identity | navigation/breadcrumb | change note RUN-11 | feature flag guards | REVIEW |
| RUN-12 | base `66e43c61`; working-tree | M0 | action envelope | action registry/bars | `96b27476-2cc7-46f6-8704-066f12ec9d28` | RUN-06 contract | REVIEW |
| RUN-13 | base `66e43c61`; working-tree | M0007 | MCH catalog/validation | MCH3 selector | `68d9e901-5722-4aa6-9371-78db270780f7` | MCH-01 APPROVED | REVIEW |
| RUN-14 | base `66e43c61`; working-tree | M0008 | question versions/pin | lifecycle read-only | `de4d5a01-019f-4c17-b38c-3b6bf251e3e8` | QTV-001 PENDING-GUARDED | NO-GO |
| RUN-15 | base RUN-14 working-tree | M0009 | import preview/commit/rollback | import wizard | `44273f5e-0ad7-4eb7-9dfb-64b723ae8083` | publish vẫn guarded | REVIEW |
| RUN-16 | base `66e43c61`; working-tree | M0 | management APIs | question workspace | `c0675962-2895-4d3e-a503-7e123287db23` | QTV-001 pending | NO-GO |
| RUN-17 | base `66e43c61`; working-tree | M0010 | canonical report engine | preview flow | `b082632c-8c17-4f9d-854e-1fbaf53f0c67` | APV/REPORT/SCORE pending | NO-GO |
| RUN-18 | base `66e43c61`; working-tree | M0011 | export jobs/artifacts | history/download | `35ebedd4-5cd8-41ff-8ac8-9c70e7f6c944` | REPORT-001 PENDING | NO-GO |
| RUN-19 | base `66e43c61`; working-tree | M0012 | scoring policies | Overview/policy separation | `5ff69188-9579-4d16-91e3-284c0d34401d` | SCORE-001 PENDING | NO-GO |
| RUN-20 | base `1587e738`; working-tree | M0013 | builder/package/preview | report builder | `d66a468f-3684-467d-af2c-ae0c960def97` | canonical only | REVIEW |
| RUN-21 | base `1587e738`; working-tree | M0014 | alias/migration/error guards | legacy archived | `ccca60a3-12c3-4fdb-bef5-14421d4293bf` | REPORT-002 BLOCKED | NO-GO |
| RUN-22 | base `1587e738`; working-tree | M0 | authenticated help | contextual help | `0f979848-f72e-4dbe-af74-7e1dea02d573` | gates giữ nguyên | REVIEW |
| RUN-23 | base `1587e738`; working-tree | M0 | release gate only | UAT only | `faa5c6ac-2ecb-4314-ba26-afd6a14c746c`; UAT `a593b028-0391-4143-8b59-0d4c82900a6b`; machine reports dưới `artifacts/release/run23` | sign-off pending; RUN23-SEC-001 High OPEN | NO-GO |

## Điều kiện đóng traceability

1. Tổng hợp RUN-05…23 vào một commit/release candidate rõ ràng; map RUN-00…04 vào commit/evidence thật.
2. Đóng decision production hoặc tạo exception có owner, phạm vi, lý do và expiry tương lai.
3. Chạy `npm run release:gate` trên Node 20 từ clean checkout; lưu evidence RUN_ID.
4. Cập nhật manifest bằng app commit thực, ký UAT và đối chiếu mọi HTTP failure/success bằng `request_id`.

GO chỉ khi mọi dòng NO-GO được đóng bằng evidence; không đổi nhãn bảng để bỏ qua blocker.
