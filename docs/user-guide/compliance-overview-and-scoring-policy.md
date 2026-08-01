<a id="compliance-overview-and-scoring-policy"></a>
# Compliance Overview và Chính sách tính điểm

Hai khu vực dùng chung dữ liệu nhưng có trách nhiệm khác nhau: Overview quyết định cách trình bày; Scoring Policy quyết định điểm, band, kết luận, penalty, elimination và ngày đánh giá tiếp theo.

<a id="prerequisites"></a>
## Điều kiện trước khi làm

- Xác định yêu cầu là **đổi cách hiển thị** hay **đổi kết quả nghiệp vụ**.
- Có fixture tổng hợp gồm các boundary/critical/elimination/category động để chạy preview hoặc impact.
- Với thay đổi policy, có owner, maker/checker độc lập, Decision ID và exact acknowledgement triển khai.

<a id="permissions"></a>
## Quyền cần có

- `REPORT_TEMPLATE.MANAGE` để đổi component `compliance_overview` trong report Draft.
- `REPORT_TEMPLATE.PUBLISH` để publish/default layout report.
- `SCORING_POLICY.MANAGE` để Clone, sửa, validate, simulate/impact và submit policy Draft.
- `SCORING_POLICY.PUBLISH` để four-eyes publish/rollback policy. Report permission không cấp quyền sửa công thức.

<a id="layout-vs-score"></a>
<a id="steps"></a>
## Các bước xác định và thay đổi

### Thay Overview display

1. Clone report template thành Draft.
2. Chỉ chỉnh title, category/order, grade columns, NA/totals/percentage, chart, legend hoặc layout component.
3. Preview cùng một pinned context trước/sau và so semantic totals/conclusion giữa HTML/PDF/XLSX.
4. Đổi biểu đồ hoặc chart không đổi công thức hay policy; formula checksum phải giữ nguyên.
5. Nếu category vượt tám trục, chấp nhận fallback bar/table cùng warning, không bỏ category.
6. Validate, Review và publish report theo [hướng dẫn mẫu báo cáo](report-template-management.md#publish-impact).

### Thay Scoring Policy

1. Clone Published policy thành Draft; không sửa Published/Retired.
2. Chỉnh A/B/C/D/NA, band, rounding, next-evaluation months, penalty, elimination hoặc category stable code theo quyết định nghiệp vụ.
3. Validate chặn band gap/overlap, thiếu grade/category hoặc chart config sai.
4. Chạy simulate/impact trên boundary `59.999`, `60`, `75`, `75.000001`, `90`, `90.000001` và fixture critical/elimination.
5. Ví dụ: đổi điểm C bắt buộc sửa policy, đọc impact/tác động tới score band, conclusion, next date/category, rồi có phê duyệt/approval four-eyes và Decision ID; không chỉnh chart để đạt kết quả đó.
6. Submit Review; người publish phải khác người submit. Publish chỉ khi exact acknowledgement đã bật.
7. Kiểm ticket mới pin policy mới; ticket/round/result snapshot/report history cũ giữ version/checksum cũ.

### Category chưa map

Question item phải có `category_code` stable và label snapshot. Row chưa map vẫn hiện với reconciliation warning, không silently drop. Readiness degraded cho đến khi catalog/mapping được owner xử lý.

<a id="expected-result"></a>
## Kết quả mong đợi

- Đổi Overview làm thay layout/chart nhưng giữ score, conclusion và formula checksum.
- Công thức chỉ đổi qua Published policy; impact/approval/audit truy nguyên được.
- HTML/PDF/XLSX dùng cùng compliance view model; policy version/checksum xuất hiện trong provenance.

<a id="rollback"></a>
## Hoàn tác

Layout sai: rollback report template default. Công thức sai: rollback policy default về version Published/Retired đã duyệt cho ticket mới. Không recalculate ticket cũ, không sửa snapshot/artifact và không update JSON Published. Sau rollback chạy lại fixture boundary và report smoke.

<a id="escalation"></a>
## Escalation

Ghi report/policy code, version và checksum, formula checksum, fixture ID, boundary, before/after score-band-conclusion, category warning, Decision ID, `request_id` và correlation ID. Escalate Report Owner cho layout; Scoring Owner cho formula; Publisher/Security Owner cho four-eyes hoặc acknowledgement; Data Owner cho unmapped category.

