# RUN-23 — UAT sign-off

Quyết định hiện tại: **NO-GO**. Đây là phiếu ký, không phải bằng chứng tự động. Mỗi người ký phải ghi evidence RUN_ID, UAT_RUN_ID, `request_id` đại diện, ngày và phạm vi.

Blocker UAT hiện tại: `RUN23-SEC-001` (High, OPEN). Deep link bị denied vẫn tải report-template data; UAT `a593b028-0391-4143-8b59-0d4c82900a6b`, `request_id=4b16def1-51e5-470a-9431-4e5294f257cb`. Không nhóm nào được ký GO trước khi test âm tính này pass.

## Role × route × action

| Role | Phạm vi cần ký | Trạng thái | Owner | Expiry/exception |
|---|---|---|---|---|
| SYS_ADMIN | toàn bộ admin, direct API negative, last-admin | PENDING | Security | — |
| Role Admin | user/role/permission/scope/approver/session revoke | PENDING | QLCL Admin | — |
| Auditor | audit search/detail/export, self-audit, provenance | PENDING | Audit Owner | — |
| Specialist | evaluation create/edit/score trong scope | PENDING | QLCL | — |
| Lead | approval queue/transition đúng stage và scope | PENDING | QLCL | — |
| TBP | approval/return/reason/history/audit | PENDING | QLCL | — |
| GDK | terminal approval/deny và scope | PENDING | QLCL | — |
| Question Designer | Draft/edit/import preview-diff-commit | PENDING | Content Owner | — |
| Question Publisher | Review/publish/pin/rollback/four-eyes gate | PENDING | Product | — |
| Report Designer | Draft/component/binding/preview/three formats | PENDING | Report Owner | — |
| Report Publisher | publish/default/history/download/rollback | PENDING | Product | — |
| custom scoped role | menu/deep link/action/direct API/IDOR/session refresh | PENDING | Security | — |

## Nghiệp vụ cần ký

- Evaluation: round 1 → approval → correction/extension → round 2 → final close → report; invalid transition 409 và terminal protection.
- Question: Draft/import/diff/commit/Review/Published/pin/rollback; Published bất biến.
- Report: Draft/preview/publish/HTML/PDF/XLSX/history/restart download/legacy/hai case fixed; ROUND2 không fallback ROUND1.
- Authorization/audit: custom role/scope/approver/effective rights/session revoke và audit bounded export.

## UX/a11y cần ký

Desktop/mobile, keyboard, focus return/trap, 200% zoom/reflow, target 40/44, one-primary-per-region, loading/empty/error/denied/disabled reason và không có console/network error không giải thích.

## Chữ ký GO/NO-GO

| Nhóm ký | Người ký | Evidence | Quyết định | Ngày |
|---|---|---|---|---|
| Security | — | — | NO-GO | — |
| QLCL | — | — | NO-GO | — |
| Product | — | — | NO-GO | — |
| IT Ops | — | — | NO-GO | — |

Không chuyển `PENDING/NO-GO` thành PASS bằng automation. Chỉ owner thật được ký; exception phải có expiry tương lai và phạm vi hẹp.
