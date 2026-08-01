<a id="configuration-rollback"></a>
# Runbook rollback cấu hình

Rollback là một thay đổi được audit, không phải sửa/xóa lịch sử. Mục tiêu là đưa default/assignment về version đã duyệt cho tác vụ mới, giữ mọi ticket, snapshot và artifact cũ bất biến.

<a id="prerequisites"></a>
## Điều kiện trước khi rollback

- Có incident/change ID, owner, phạm vi ảnh hưởng, version/config trước-sau và tiêu chí thành công.
- Xác định lỗi nằm ở authorization, question template, report template, scoring policy hay deployment config.
- Có fixture tổng hợp, smoke checklist, người phê duyệt độc lập và kế hoạch truyền thông.
- Thu thập `request_id`/correlation ID, không thu thập secret, cookie, OTP hoặc customer data.

<a id="permissions"></a>
## Quyền cần có

- Authorization: `USER.MANAGE`, kèm exact confirm cho thay đổi nhạy cảm.
- Question: `QUESTION_TEMPLATE.MANAGE` và gate publisher hiện hành.
- Report: `REPORT_TEMPLATE.PUBLISH`; smoke export cần `REPORT.READ/EXPORT` đúng scope.
- Scoring: `SCORING_POLICY.PUBLISH`, exact acknowledgement, Decision ID và four-eyes.
- Deployment config chỉ do Deployment Owner thay theo change đã duyệt; một boolean không được mở gate production.

<a id="steps"></a>
## Các bước chung

1. Dừng thao tác publish/export mới nếu dữ liệu hoặc kết luận có nguy cơ sai; không chặn history download hợp lệ.
2. Ghi baseline an toàn: current version/default/checksum/scope, readiness, error rate và một smoke fixture.
3. Chọn target đã Published/Retired và được duyệt; không tạo/sửa JSON trực tiếp trong DB.
4. Preview/impact target và xác nhận ticket/history pin cũ không đổi.
5. Thực hiện rollback action với reason/Decision ID/exact confirm theo module.
6. Smoke UI/API, allowed actions, preview/export/download và readiness; kiểm audit before/after.
7. Theo dõi trong cửa sổ đã định và đóng incident chỉ khi tiêu chí thành công đạt.

<a id="authorization"></a>
## Rollback authorization

Khôi phục role-permission/scope/approval assignment bằng một mutation mới; preview effective rights trước lưu. Không tự cấp quyền, không loại last `SYS_ADMIN`. Thay đổi phải tăng `authz_version` và thu hồi phiên user bị ảnh hưởng.

<a id="question-template"></a>
## Rollback question template

Đổi default assignment về Published/Retired version trước cho ticket mới. Ticket cũ giữ `question_template_version_id`; không update/delete Published hoặc repin/recalculate history. Smoke tạo một ticket fixture mới và mở một ticket fixture cũ.

<a id="report-template"></a>
## Rollback report template

1. Chọn canonical definition và version Published/Retired trước đó.
2. So package checksum, scope/effective window và preview fixture với baseline.
3. Chạy action **Rollback/Đặt lại mặc định**; không import package trực tiếp vào Published.
4. Smoke Preview/HTML/PDF/XLSX, immediate/history download, round guards và provenance.
5. Giữ job/artifact/source snapshot cũ; không regenerate hoặc overwrite history.

<a id="scoring-policy"></a>
## Rollback scoring policy

Chạy policy rollback với `SCORING_POLICY.PUBLISH`, Decision ID và maker/checker độc lập. Việc này chỉ đổi default cho ticket mới; không recalculate result snapshot/report history. Chạy boundary và impact fixtures sau rollback.

<a id="deployment-config"></a>
## Rollback deployment/config gate

Tắt exact acknowledgement để ngăn publish/mapping mới, kiểm readiness rồi rollback application theo bản đã phê duyệt. Giữ migrations expand-only; không drop table/column/version/history. Storage production phải giữ adapter/volume được phê duyệt; không đổi sang local tạm để “chạy được”.

<a id="expected-result"></a>
## Kết quả mong đợi

Tác vụ mới dùng target default đúng; ticket/round/history/artifact cũ giữ version/checksum/bytes. Audit có before/after, actor, reason, decision, request/correlation ID; readiness và smoke xanh.

<a id="rollback"></a>
## Hoàn tác một rollback

Nếu target rollback cũng sai, không xóa audit hoặc sửa assignment trực tiếp. Mở change mới, chọn version khác đã duyệt, chạy lại impact/smoke và thực hiện một rollback/default mutation mới có lý do.

<a id="escalation"></a>
## Escalation

Gửi incident ID, module, old/current/target version và checksum, scope, effective window, readiness/error code, smoke expected/actual, `request_id`, correlation ID và owner. Escalate Security cho auth/gate; Content Owner cho question; Report/Scoring Owner cho semantic result; Platform cho worker/storage/deploy. Không gửi PII, report bytes hoặc credential.

