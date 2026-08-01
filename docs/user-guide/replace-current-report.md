<a id="replace-current-report"></a>
# Thay mẫu báo cáo hiện hành an toàn

Quy trình này thay Published default bằng một canonical version mới mà vẫn giữ history, artifact và đường quay lại. Không tạo mới `INTERNAL`/`NCC` và không tự suy đoán alias.

<a id="prerequisites"></a>
## Điều kiện trước khi làm

- Xác định đúng definition, round, Published default hiện tại và version thay thế.
- Có owner, publisher độc lập, maintenance window, fixture/sample ticket, smoke checklist và rollback owner.
- Với legacy, cả approval gate và mapping phải không mơ hồ; nếu chưa duyệt, để flag OFF và đưa item vào review queue.

<a id="permissions"></a>
## Quyền cần có

- `REPORT.READ` để đọc catalog/preview/history.
- `REPORT_TEMPLATE.MANAGE` để backup/Clone/validate/submit Draft.
- `REPORT_TEMPLATE.PUBLISH` để publish, đổi default và rollback.
- `REPORT.EXPORT` cùng ticket scope để smoke export/download; không mượn quyền global chỉ để test.

<a id="safe-replacement"></a>
<a id="steps"></a>
## Các bước thay thế

1. **Chụp baseline an toàn:** ghi default version/checksum/scope/effective window và một bộ semantic expected từ fixture; không lưu dữ liệu ticket thật.
2. **Backup:** tải definition package của current Published. Kiểm checksum và cất theo quy trình quản trị cấu hình.
3. **Tạo Draft:** Clone exact current version hoặc import package đã kiểm tra. Import chỉ tạo Draft.
4. **Chỉnh sửa:** dùng component/binding/style allowlist. Không sửa scoring formula trong report builder.
5. **Preview edge cases:** round thiếu/chưa hoàn tất, bảng rỗng/dài, category động, quá tám trục, ký tự dài và missing optional data.
6. **Compare:** đối chiếu before/after và HTML/PDF/XLSX về title, totals, conclusion, category/order và provenance.
7. **Validate/Review:** xử lý lỗi, ghi warning/impact rồi submit. Publisher kiểm tra lại version/checksum và scope.
8. **Publish/default:** publish version Review và gán default đúng scope/effective window. Chỉ bước này ảnh hưởng output mới.
9. **Smoke:** tạo preview/export mới, tải immediate/history, kiểm sau restart nếu deployment yêu cầu; artifact phải có storage key tương đối, hash/MIME/size và provenance đầy đủ.
10. **Theo dõi:** kiểm failed jobs, missing/quarantined artifact và error rate. Không đánh dấu `COMPLETED` nếu persist lỗi.

Legacy migration phải chạy dry-run counts mapped/skipped/conflict/missing/ambiguous. Ambiguous ở review queue; apply chỉ liên kết Published v1 sau exact acknowledgement và luôn idempotent.

<a id="expected-result"></a>
## Kết quả mong đợi

- New render dùng version mới; Draft trước publish không ảnh hưởng production.
- Ticket cũ vẫn pin question/scoring context; artifact/history cũ không bị tái tính hoặc ghi đè.
- Alias response có canonical code, legacy source, mapping version và deprecation; không silent fallback round.

<a id="rollback"></a>
## Hoàn tác

Đổi default về version Published/Retired trước đó bằng action rollback, smoke lại mọi format và xác nhận new render quay về semantic expected. Không xóa version, assignment history, export job hoặc artifact. Nếu lỗi do deployment/config, làm theo [runbook rollback](../admin-runbook/configuration-rollback.md#report-template).

<a id="escalation"></a>
## Escalation

Dừng publish/export mới khi totals/conclusion/round sai hoặc storage lỗi. Ghi definition/version/checksum, old/new default, scope, round, format, job/artifact, error code, `request_id`, correlation ID và kết quả smoke. Escalate Report Owner cho layout/binding, Scoring Owner cho conclusion, Platform cho artifact/worker, Security cho IDOR/path/content spoofing.

