# RUN-23 — Pilot và rollback runbook

Trạng thái rehearsal: **NO-GO** cho staging/production cho đến khi IT Ops hoàn thành diễn tập. Mọi incident ghi environment, app commit, migration, actor synthetic, `request_id`, correlation ID, expected/actual và owner; không ghi secret/PII.

## Trước pilot

1. Xác nhận manifest/checksum/SBOM và clean Node 20 package.
2. Backup → verify → migrate → reconcile; giữ đường restore đã thử thành công.
3. Feature flag giữ OFF nếu decision chưa duyệt; không bật production bằng một boolean ngoài contract.
4. Chạy smoke read-only trước, sau đó mutation fixture theo change window.

## Kịch bản rehearsal

### Wrong permission exposure

Dừng pilot, thu hồi phiên/role bị ảnh hưởng, giữ audit, kiểm backend policy và direct API. Không chỉ ẩn nút. Escalate Security; release rollback nếu API cho phép ngoài scope.

### Migration failure

Không khởi động app commit mới. Giữ active DB/backup, thu thập migration ID/checksum, restore bản verified bằng runbook và verify audit/FK/reconciliation.

### OTP incident/disable

Tắt exact screen acknowledgement/config, giữ readiness degraded, chuyển email nếu sẵn sàng. Thu hồi degraded sessions khi cần; không log/screenshot code.

### Import incident

Dừng commit/publish, giữ batch metadata, rollback Draft snapshot nếu lock cho phép. Không sửa Published hoặc upload workbook thật vào evidence.

### Report mismatch

Dừng export/publish mới, đối chiếu template/question/scoring/context/semantic checksum giữa Preview/HTML/PDF/XLSX. Rollback default; không recalculate history.

### Stuck job

Kiểm worker/readiness/attempt/idempotency. Chỉ recovery `RUNNING/FAILED` theo policy; không tạo duplicate job/artifact hoặc `COMPLETED` giả.

### Missing artifact

Đánh dấu `MISSING/QUARANTINED`, chặn link giả và kiểm storage key/hash/MIME. Regenerate chỉ khi policy duyệt, tạo artifact mới có provenance.

### Template/policy rollback

Đổi default về Published/Retired đã duyệt cho tác vụ mới, chạy impact/smoke; giữ ticket/result/history pin cũ.

### Release rollback

Rollback application về app commit đã duyệt, giữ migration expand-only. Restore DB chỉ khi migration/data verification yêu cầu và backup đã được rehearsal; không dùng `git reset --hard` hoặc xóa DB thủ công.

## Pilot monitoring

Theo dõi auth failure/rate limit, permission deny, audit append/parse, migration/readiness, import batch, report job/artifact và request latency theo target NFR đã chốt trước đo. Mọi High/Critical không có exception hợp lệ chuyển ngay **NO-GO**.

## Tiêu chí kết thúc

GO sau cửa sổ pilot khi không P0/High mở, sign-off đủ bốn nhóm, restore thành công, artifacts tải lại sau restart và machine reports checksum khớp manifest. Nếu thiếu một mục, giữ NO-GO và escalation đúng owner.

