const tickets = [
  { ticket_code: '260119-2060603-001', supplier: { code: '2060603', name: 'An Minh Food' }, evaluation_type: 'Đánh giá NCC mới', merchandising: { mch2: 'Rau củ quả', mch3: 'Trái cây' }, template_code: 'BM01', dates: { created: '2026-06-01', planned: '2026-06-15' }, assignee_name: 'Nguyễn An', workflow_status: 'Khởi tạo', score_percent: null, grade_code: null },
  { ticket_code: '260120-2060456-002', supplier: { code: '2060456', name: 'WinEco Lạc Dương' }, evaluation_type: 'Đánh giá định kỳ', merchandising: { mch2: 'Rau củ quả', mch3: 'Rau ăn lá' }, template_code: 'BM01', dates: { created: '2026-06-02', planned: '2026-06-16' }, assignee_name: 'Trần Bình', workflow_status: 'Đang xử lý', score_percent: 68, grade_code: 'C' },
  { ticket_code: '260121-2060788-003', supplier: { code: '2060788', name: 'Hải Sản Minh Phú' }, evaluation_type: 'Đánh giá đột xuất', merchandising: { mch2: 'Thủy hải sản', mch3: 'Tôm' }, template_code: 'BM03', dates: { created: '2026-06-03', planned: '2026-06-17' }, assignee_name: 'Lê Chi', workflow_status: 'Chờ duyệt (Lead)', score_percent: 58, grade_code: 'D' },
  { ticket_code: '260122-2060991-004', supplier: { code: '2060991', name: 'Tân Phát Meat' }, evaluation_type: 'Đánh giá định kỳ', merchandising: { mch2: 'Thịt', mch3: 'Thịt heo' }, template_code: 'BM02', dates: { created: '2026-06-04', planned: '2026-06-18' }, assignee_name: 'Phạm Dũng', workflow_status: 'Chờ duyệt (TBP)', score_percent: 76, grade_code: 'B' },
  { ticket_code: '260123-2060112-005', supplier: { code: '2060112', name: 'Green Farm' }, evaluation_type: 'Đánh giá NCC mới', merchandising: { mch2: 'Rau củ quả', mch3: 'Củ quả' }, template_code: 'BM01', dates: { created: '2026-06-05', planned: '2026-06-19' }, assignee_name: 'Hoàng Hà', workflow_status: 'Hoàn thành', score_percent: 92, grade_code: 'A' },
  { ticket_code: '260124-2060224-006', supplier: { code: '2060224', name: 'Việt Đức Foods' }, evaluation_type: 'Đánh giá định kỳ', merchandising: { mch2: 'Thực phẩm chế biến', mch3: 'Đồ chế biến' }, template_code: 'BM04', dates: { created: '2026-06-06', planned: '2026-06-20' }, assignee_name: 'Ngô Lan', workflow_status: 'Khởi tạo', score_percent: null, grade_code: null },
  { ticket_code: '260125-2060335-007', supplier: { code: '2060335', name: 'Nam Việt Seafood' }, evaluation_type: 'Đánh giá định kỳ', merchandising: { mch2: 'Thủy hải sản', mch3: 'Cá tươi' }, template_code: 'BM03', dates: { created: '2026-06-07', planned: '2026-06-21' }, assignee_name: 'Vũ Minh', workflow_status: 'Đang xử lý', score_percent: 73, grade_code: 'C' },
  { ticket_code: '260126-2060446-008', supplier: { code: '2060446', name: 'Sài Gòn Meat' }, evaluation_type: 'Đánh giá đột xuất', merchandising: { mch2: 'Thịt', mch3: 'Gia cầm' }, template_code: 'BM02', dates: { created: '2026-06-08', planned: '2026-06-22' }, assignee_name: 'Đỗ Nam', workflow_status: 'Chờ duyệt (GĐK)', score_percent: 55, grade_code: 'D' },
  { ticket_code: '260127-2060557-009', supplier: { code: '2060557', name: 'Fresh Pack' }, evaluation_type: 'Đánh giá NCC mới', merchandising: { mch2: 'Thực phẩm chế biến', mch3: 'Đóng gói' }, template_code: 'BM04', dates: { created: '2026-06-09', planned: '2026-06-23' }, assignee_name: 'Mai Oanh', workflow_status: 'Hoàn thành', score_percent: 84, grade_code: 'B' },
  { ticket_code: '260128-2060668-010', supplier: { code: '2060668', name: 'Đà Lạt Fresh' }, evaluation_type: 'Đánh giá định kỳ', merchandising: { mch2: 'Rau củ quả', mch3: 'Trái cây' }, template_code: 'BM01', dates: { created: '2026-06-10', planned: '2026-06-24' }, assignee_name: 'Bùi Quân', workflow_status: 'Khởi tạo', score_percent: null, grade_code: null },
  { ticket_code: '260129-2060779-011', supplier: { code: '2060779', name: 'Blue Ocean' }, evaluation_type: 'Đánh giá NCC mới', merchandising: { mch2: 'Thủy hải sản', mch3: 'Hải sản sơ chế' }, template_code: 'BM03', dates: { created: '2026-06-11', planned: '2026-06-25' }, assignee_name: 'Đặng Sơn', workflow_status: 'Đang xử lý', score_percent: 61, grade_code: 'C' },
  { ticket_code: '260130-2060880-012', supplier: { code: '2060880', name: 'Mộc Châu Farm' }, evaluation_type: 'Đánh giá định kỳ', merchandising: { mch2: 'Thịt', mch3: 'Thịt bò' }, template_code: 'BM02', dates: { created: '2026-06-12', planned: '2026-06-26' }, assignee_name: 'Tạ Tâm', workflow_status: 'Chờ duyệt (Lead)', score_percent: 59, grade_code: 'D' },
  { ticket_code: '260131-2060992-013', supplier: { code: '2060992', name: 'Lotus Foods' }, evaluation_type: 'Đánh giá NCC mới', merchandising: { mch2: 'Thực phẩm chế biến', mch3: 'Sơ chế' }, template_code: 'BM04', dates: { created: '2026-06-13', planned: '2026-06-27' }, assignee_name: 'Cao Uyên', workflow_status: 'Hoàn thành', score_percent: 91, grade_code: 'A' },
  { ticket_code: '260201-2061003-014', supplier: { code: '2061003', name: 'Gia Phát Produce' }, evaluation_type: 'Đánh giá đột xuất', merchandising: { mch2: 'Rau củ quả', mch3: 'Rau ăn lá' }, template_code: 'BM01', dates: { created: '2026-06-14', planned: '2026-06-28' }, assignee_name: 'Võ Việt', workflow_status: 'Chờ duyệt (TBP)', score_percent: 62, grade_code: 'C' },
  { ticket_code: '260202-2061114-015', supplier: { code: '2061114', name: 'An Khang Foods' }, evaluation_type: 'Đánh giá định kỳ', merchandising: { mch2: 'Thực phẩm chế biến', mch3: 'Đồ chế biến' }, template_code: 'BM04', dates: { created: '2026-06-15', planned: '2026-06-29' }, assignee_name: 'Lý Xuân', workflow_status: 'Khởi tạo', score_percent: null, grade_code: null },
  { ticket_code: '260203-2061225-016', supplier: { code: '2061225', name: 'Biển Đông Seafood' }, evaluation_type: 'Đánh giá định kỳ', merchandising: { mch2: 'Thủy hải sản', mch3: 'Cá tươi' }, template_code: 'BM03', dates: { created: '2026-06-16', planned: '2026-06-30' }, assignee_name: 'Hồ Yến', workflow_status: 'Đang xử lý', score_percent: 79, grade_code: 'B' },
];

const questions = [
  { question_id: 'legal-1', section_name: 'Hồ sơ pháp lý', text: 'Giấy chứng nhận đăng ký kinh doanh còn hiệu lực', clause_type: 'normal', is_critical: false },
  { question_id: 'legal-2', section_name: 'Hồ sơ pháp lý', text: 'Giấy chứng nhận đủ điều kiện ATTP còn hiệu lực', clause_type: 'exclusion', is_critical: false },
  { question_id: 'quality-1', section_name: 'Kiểm soát chất lượng', text: 'Có quy trình kiểm soát nguyên liệu đầu vào', clause_type: 'normal', is_critical: true },
  { question_id: 'quality-2', section_name: 'Kiểm soát chất lượng', text: 'Có hồ sơ kiểm tra định kỳ dụng cụ đo lường', clause_type: 'normal', is_critical: false },
  { question_id: 'trace-1', section_name: 'Truy xuất nguồn gốc', text: 'Có hồ sơ truy xuất theo lô sản xuất', clause_type: 'normal', is_critical: true },
  { question_id: 'trace-2', section_name: 'Truy xuất nguồn gốc', text: 'Lưu mẫu/hồ sơ lô đáp ứng thời hạn quy định', clause_type: 'normal', is_critical: false },
  { question_id: 'food-1', section_name: 'Kiểm soát ATVSTP', text: 'Điều khoản loại: không có vi phạm nghiêm trọng ATVSTP', clause_type: 'exclusion', is_critical: false },
  { question_id: 'food-2', section_name: 'Kiểm soát ATVSTP', text: 'Khu vực sản xuất được vệ sinh và phân tách nguy cơ nhiễm chéo', clause_type: 'normal', is_critical: true },
];

const answers = {};

tickets.forEach((ticket, index) => {
  const pairs = [
    ['Thực phẩm tươi sống, chế biến', 'Trái cây'],
    ['Thực phẩm tươi sống, chế biến', 'Rau củ'],
    ['Thực phẩm tươi sống, chế biến', 'Thủy hải sản'],
    ['Thực phẩm tươi sống, chế biến', 'Thịt'],
    ['Thực phẩm công nghệ', 'Thực phẩm khô'],
    ['Thực phẩm công nghệ', 'Đông lạnh'],
    ['Homeline', 'Đồ dùng dân dụng/Trang trí'],
    ['Hóa mỹ phẩm', 'Hóa phẩm'],
    ['Dệt may', 'Thời trang'],
  ];
  const [mch2, mch3] = pairs[index % pairs.length];
  ticket.merchandising = { mch2, mch3 };
});

module.exports = { tickets, questions, answers };
