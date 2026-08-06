# RUN-05 — Sửa hiển thị điểm không phù hợp khi chấm điểm

## Phạm vi

- Màn hình: `/qlcl/#/evaluations/scoring`.
- Sửa lớp tổng hợp/render KPH và việc chuyển dữ liệu yêu cầu/thời hạn từ dòng tạm sang KPH đã lưu.
- Tách lỗi tải API khỏi lỗi render giao diện.
- Không thay đổi công thức điểm, quy tắc NA, schema, contract API, workflow phê duyệt hoặc dữ liệu live.
- Hai tệp được yêu cầu đọc là `AGENTS.md` và `CONTEXT.md` không tồn tại trong snapshot/repository hiện tại. Các tệp nguồn bắt buộc còn lại và test scoring/nonconformity liên quan đã được đọc trước khi sửa.

## Nguyên nhân

1. Dòng KPH tính tạm mang cả `id` và `question_item_id`, nên điều kiện cũ nhận nhầm là KPH đã persist. Vì vậy khóa draft không được tạo đúng và dữ liệu yêu cầu/thời hạn không được nối sang response sau khi lưu.
2. Danh sách đã lưu được ưu tiên toàn bộ so với kết quả B/C/D hiện tại, nên không bảo đảm số dòng đúng bằng B/C/D của vòng đang chấm và có thể giữ dòng đã chuyển về A/NA.
3. `applyDraftNonconformityRequirements` lọc theo `question_id`, trong khi response chuẩn hiện tại dùng `evaluation_answer_id` và `question_item_id`.
4. Promise tải vòng gọi `renderScoring()` trong cùng chuỗi `.catch()`, khiến ngoại lệ render bị hiển thị sai thành lỗi tải API.

## Thay đổi

- Xác định ngày nghiệp vụ tại `evaluationDateForNonconformities`: `actual_evaluation_date_iso` → `planned_iso` → ngày nghiệp vụ hiện tại.
- Dùng ngày vừa xác định ngay trong scope render để thiết lập `min`; vòng 1 mặc định hạn +7 ngày và input vẫn chỉnh sửa được.
- Tổng hợp đúng các câu B/C/D của vòng hiện tại; A/NA không tạo KPH. Dữ liệu KPH đã lưu được ghép theo câu hỏi để giữ `id`, yêu cầu, thời hạn và trạng thái mà không tạo trùng.
- Nhận diện KPH đã lưu bằng `id + evaluation_answer_id`; dòng tính tạm tiếp tục dùng draft key và cho phép nhập khi còn quyền chấm.
- Sau PUT lưu nháp, mảng `nonconformities` trong response là dữ liệu chính thức; yêu cầu/thời hạn draft được cập nhật vào đúng bản ghi rồi xóa khỏi draft store.
- Vòng đã khóa làm cả KPH tạm và KPH đã lưu thành chỉ đọc.
- `loadScoringRoundAndRender` chỉ hiển thị “Không tải được dữ liệu chấm điểm.” khi API thất bại. Lỗi render được ghi bằng event console `[scoring.render_failed]`, có thông báo riêng và để lại một dòng trạng thái giải thích trong bảng.

## Evidence đỏ

Lệnh trước implementation:

```text
node --test test/scoringNonconformityRender.test.js
```

Kết quả: exit 1, `0 pass / 5 fail`. Cả năm tình huống dừng ở việc thiếu `evaluationDateForNonconformities` hoặc `loadScoringRoundAndRender`, chứng minh regression test đỏ trước bản vá.

## Evidence xanh

| Gate | Lệnh | Kết quả |
|---|---|---|
| Focused regression | `node --test test/scoringNonconformityRender.test.js` | PASS, 6/6 |
| Focused scoring/backend | `node --test test/scoringNonconformityRender.test.js test/evaluationTickets.test.js test/evaluationRules.test.js test/scoringValidationUx.test.js test/prompt124EvaluationUi.test.js` | PASS, 40/40; case fallback ngày bổ sung sau đó PASS trong focused và full test cuối |
| Full test | `npm test` | PASS, 382 pass, 0 fail, 1 skip (383 test) |
| Lint | `npm run lint` | PASS, 260 tệp, 0 lỗi |
| Build | `npm run build` | PASS |
| UAT smoke | `npm run uat:smoke` | PASS, 6/6 scenario |

## UAT synthetic

- UAT_RUN_ID: `28372a8f-c8e9-4258-b978-d179e397b307`.
- Evidence: `artifacts/uat-runs/28372a8f-c8e9-4258-b978-d179e397b307/`.
- Chạy trên database tạm cô lập do UAT harness tạo; không dùng hoặc sửa dữ liệu live.
- Luồng: đăng nhập admin synthetic → tạo NCC/phiếu BM01 → hoàn thành câu hỏi với đúng một câu D → xác nhận một KPH tạm và input sửa được → đổi hạn từ mặc định +7 → lưu nháp → reload vẫn đúng một KPH, không mất yêu cầu/thời hạn → chuyển D về A → lưu/reload còn 0 KPH.
- Kết quả console: không có `ReferenceError`, `pageerror` hoặc `console.error` trong luồng bình thường.

## An toàn và rollback

- Không có migration, thay đổi API, mock data trong implementation hoặc ghi dữ liệu live.
- Synthetic data chỉ nằm trong database UAT tạm.
- Rollback: hoàn nguyên thay đổi trong `public/app.js` và xóa regression/UAT RUN-05; không cần phục hồi CSDL.
