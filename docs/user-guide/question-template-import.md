<a id="question-template-import"></a>
# Import bộ câu hỏi hai pha

Import chỉ thay đổi một version `DRAFT` sau khi người dùng đã xem preview/diff và xác nhận commit. Preview không mutate Draft; commit không publish.

<a id="prerequisites"></a>
## Điều kiện trước khi làm

- Chọn đúng stable template và đúng version Draft; Published không nhận import.
- Chuẩn bị dữ liệu theo stable code cho template, variant, category, question, clause, score, order và active.
- Xác nhận Draft không đang được người khác chỉnh; ghi lại lock version trước preview.

<a id="permissions"></a>
## Quyền cần có

- `QUESTION_TEMPLATE.MANAGE` cho download mẫu, preview, đọc batch/lỗi, commit và rollback.
- Permission không thay thế kiểm tra trạng thái Draft, confirmation, idempotency và optimistic lock ở backend.

<a id="download-sample"></a>
<a id="steps"></a>
## Các bước vận hành

### 1. Chọn file mẫu

1. Trong workspace Bộ câu hỏi, chọn tab **Import history** và version Draft.
2. Bấm **Tải file mẫu** để lấy canonical workbook có các sheet `README`, `Data Dictionary`, `Questions`.
3. Không thêm macro, object, external link, formula hoặc hyperlink. Không đổi header/code tùy ý.
4. Legacy BM01…BM04 được adapter chuyển sang canonical model trước validation; không phụ thuộc format legacy cho file mới.

### 2. Kiểm tra và so sánh

1. Wizard **Chọn file → Kiểm tra** kiểm MIME, ZIP signature và giới hạn workbook.
2. Đọc row error theo sheet/row/column/code; tải error CSV/XLSX nếu cần.
3. Ở bước **So sánh**, lọc `ADDED`, `CHANGED`, `REMOVED`, `UNCHANGED`, `DUPLICATE`, `INVALID`.
4. Kiểm tra before/after từng thay đổi. `REMOVED` trong preview hợp lệ có thể xóa item khỏi Draft khi commit.
5. Nếu có invalid/duplicate, sửa file và preview lại. Chỉ dùng partial acceptance khi owner duyệt rõ phạm vi giữ/bỏ.

### 3. Xác nhận và commit

1. Xác nhận batch, counts, Draft version và expected lock version.
2. Bấm **Commit vào Draft** một lần. Client gửi confirmation verifier và idempotency key; không copy các giá trị này vào log/evidence.
3. Commit chạy transaction: hoặc toàn bộ thay đổi hợp lệ được áp dụng, hoặc không có half-write.
4. Mở tab Câu hỏi kiểm tra lại counts/order, sau đó Save/Review/Publish theo [lifecycle version](question-template-management.md#publish-and-pin).

<a id="expected-result"></a>
## Kết quả mong đợi

- Preview tạo import batch và diff nhưng checksum/lock/content Draft chưa đổi.
- Commit thành công tăng lock version, liên kết batch tới từng change và giữ Published nguyên trạng.
- Retry cùng idempotency không tạo commit/batch change trùng; import history truy được người, thời điểm và outcome.

<a id="rollback"></a>
## Hoàn tác

Chọn batch đã commit và **Rollback batch** khi Draft chưa có chỉnh sửa mới. Hệ thống phục hồi snapshot Draft trong transaction. Nếu lock đã đổi, không ép rollback; Clone version nguồn hoặc áp một import sửa lỗi mới. Rollback import không thay Published và không repin ticket.

<a id="escalation"></a>
## Escalation

Ghi template/version, batch ID, trạng thái, counts theo mã diff, sheet/row/column/error code, lock version, `request_id` và correlation ID. Không gửi cả workbook hoặc nội dung câu hỏi. Escalate Security khi file bị chặn vì metadata; Content Owner khi mapping/code mơ hồ; Platform khi preview mutate dữ liệu, commit half-write hoặc temp cleanup lỗi.

