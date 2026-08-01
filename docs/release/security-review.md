# RUN-23 — Security review

Kết luận hiện tại: **NO-GO**, chờ Node 20 clean run, `npm audit`, decision production và Security sign-off. Không có exception hợp lệ được ghi nhận. Sự cố phải truy từ UI `request_id` → HTTP log → audit → entity mà không chứa PII/secret.

## Threat matrix

| Threat | Guard/test bắt buộc | Kết quả cần có |
|---|---|---|
| privilege escalation / display-role authorization | backend permission/scope, self-escalation, last admin, policy static gate | API 403; UI không phải boundary |
| mass assignment | route allowlist/service mapping | field ngoài contract không mutate |
| stale token/cache/session | `authz_version`, session revoke, role expiry | token cũ bị chặn |
| cross-scope IDOR | list/detail/export/download cùng scope | 403/404 an toàn, không flash data |
| malicious XLSX/ZIP bomb | MIME/signature/entry/ratio/row/cell limit | reject; không evaluate formula |
| formula/external link/macro/object | question importer security checks | reject, không log workbook body |
| unsafe report definition | schema/binding allowlist/sanitizer | script/event/raw HTML bị chặn |
| traversal/MIME/disposition | relative storage key, signature/hash/MIME, safe filename | download fail closed |
| OTP unknown/disabled/expired/max/rate/resend | equivalent response, HMAC verifier, constant-time/one-time | không plaintext code |
| UAT production bypass | production-readonly mutation guard | mọi mutation bị chặn |
| PII logging/log injection | central redactor, newline sanitization, parseable JSON | 100% log parse, không PII |
| audit access | `AUDIT.READ/EXPORT`, GLOBAL scope, self-audit | detail/export access phát audit event |

## Secret và package scan

`node scripts/security-scan.js` scan ba scope:

1. source trong package allowlist;
2. Git history patch với pattern credential mạnh;
3. release artifacts text và danh sách entry trong tarball.

Package tuyệt đối không có `.env`, `.git`, DB/WAL/SHM/backup, upload, report thật, log hoặc `node_modules`. SBOM không chứa credential. Scan pattern không thay thế review của Security.

## Observability review

- Chạy success/failure ở auth, RBAC, dossier, evaluation, question import, report và audit.
- Đối chiếu `request_id`, correlation ID, actor/entity/outcome; không lưu request body, OTP, cookie hoặc authorization value.
- Test concurrency, audit chain, redaction nested object và log injection.
- Parser failure, missing request trace hoặc audit-access không tự audit là High blocker.

## Risk còn mở

- **RUN23-SEC-001 — High, OPEN, NO-GO:** sau khi identity phía client chỉ còn `DASHBOARD.READ`, deep link `/admin/report-templates` hiển thị denied nhưng vẫn khởi chạy loader. Endpoint `/qlcl/api/report-templates/definitions` trả 200, sau đó còn phát sinh request version/preview. Evidence gate cuối: UAT `a593b028-0391-4143-8b59-0d4c82900a6b`, `request_id=4b16def1-51e5-470a-9431-4e5294f257cb`. Owner: Security + Frontend/Authz; expiry: chưa có. Phải fail closed loader trước khi tải dữ liệu và bổ sung test với session backend thực sự ít quyền.
- Decision AUTHZ/OTP/OBS/REPORT/SCORE/QTV/UAT chưa đóng.
- npm registry hiện chưa trả kết quả Node-20 package/audit trên máy này.
- Release candidate còn uncommitted nên source ↔ app commit chưa bất biến.

Security chỉ ký GO sau khi machine scan sạch, `npm audit` không còn High/Critical, role/API negative pass và exception (nếu có) đủ owner + expiry.
