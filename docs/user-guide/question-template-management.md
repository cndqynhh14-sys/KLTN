<a id="question-template-management"></a>
# Quản lý bộ câu hỏi theo phiên bản

Vòng đời chuẩn là `DRAFT → IN_REVIEW → PUBLISHED → RETIRED`. Published/Retired là bất biến; ticket giữ version đã pin trong suốt vòng đời.

<a id="prerequisites"></a>
## Điều kiện trước khi làm

- Xác định template code, facility type, supplier scale, version nguồn và owner nội dung.
- Có fixture ticket tổng hợp để kiểm tra impact; không dùng ticket thật trong tài liệu/evidence.
- Cờ publish và quyết định publisher phải được duyệt; nếu đang OFF, chỉ làm Draft/Review.

<a id="permissions"></a>
## Quyền cần có

- `EVALUATION.READ` để đọc catalog/version.
- `QUESTION_TEMPLATE.MANAGE` để tạo, Clone, sửa Draft, import, submit, publish/retire/rollback.
- Action cuối cùng vẫn bị backend kiểm tra `allowed_actions`, trạng thái, lock version và gate triển khai.

<a id="quick-start-designer"></a>
<a id="steps"></a>
## Các bước vận hành

### Tạo hoặc Clone Draft

1. Mở **Quản trị → Bộ câu hỏi**, lọc theo status/version/facility/scale.
2. Chọn template/version. Published chỉ có CTA **Clone Draft**, không có edit controls.
3. Tạo mới luôn sinh Draft v1; hoặc Clone version nguồn thành Draft mới.
4. Ở các tab **Tổng quan, Câu hỏi, Biến thể**, chỉnh mã stable, text, category, score, weight, order và active.
5. Dùng reorder/bulk action chỉ trong Draft. Bấm **Lưu nháp**; đây không phải Review hoặc Publish.
6. Khi conflict optimistic lock, giữ nguyên form, tải version mới và so diff trước khi áp lại.

### Validate, Review và Published

1. Sửa toàn bộ validation summary; focus phải tới lỗi đầu tiên và dữ liệu chưa lưu còn nguyên.
2. Xem diff/impact, ticket pin counts, effective dates và default scope.
3. **Gửi duyệt** chuyển Draft sang Review và đóng sửa nội dung.
4. Publisher đọc diff/impact rồi thực hiện Publish riêng. Không dùng Save Draft như publish.

<a id="publish-and-pin"></a>
### Publish, pin và rollback

- Ticket mới resolve Published version đang default/effective rồi lưu `question_template_version_id`.
- Ticket cũ, scoring và report luôn đọc pinned version; publish v2 không đổi hash/history của ticket v1.
- Retired version vẫn đọc được cho ticket cũ.
- Rollback chỉ đổi default cho ticket mới, không ghi đè pin cũ và không xóa Published.

Nếu cần workbook, dùng [quy trình import hai pha](question-template-import.md#download-sample).

<a id="expected-result"></a>
## Kết quả mong đợi

- URL giữ template/version/tab sau refresh/back; status/version/scope hiển thị rõ.
- Draft chứa thay đổi; Review đóng sửa; Published không có edit controls.
- Ticket cũ giữ checksum/version cũ, ticket mới dùng đúng default Published theo scope/effective window.

<a id="rollback"></a>
## Hoàn tác

- Draft chưa submit: bỏ thay đổi hoặc Clone lại từ version đúng.
- Review sai: không publish; tạo Draft sửa theo policy hiện hành.
- Published sai: dùng rollback/default assignment về version Published/Retired đã duyệt cho ticket mới. Không sửa Published JSON, không xóa version và không repin ticket cũ.

<a id="escalation"></a>
## Escalation

Ghi template code, version ID/status, lock version, tab, action, warning, expected/actual, `request_id` và correlation ID. Escalate Content Owner nếu câu/điểm sai; Publisher nếu gate/assignment/default sai; Platform nếu checksum/orphan/duplicate reconciliation không sạch. Không đính kèm câu hỏi thật hoặc ảnh chứa dữ liệu thật.

