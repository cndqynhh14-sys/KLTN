const MCH3_BY_MCH2 = Object.freeze({
  'Dệt may': Object.freeze(['Bông vải sợi', 'Thời trang']),
  'Hóa mỹ phẩm': Object.freeze(['Giấy và bông', 'Hóa phẩm', 'Mỹ phẩm, chăm sóc cá nhân']),
  Homeline: Object.freeze(['Đồ chơi/Giải trí thể thao', 'Đồ dùng dân dụng/Trang trí', 'Văn phòng phẩm']),
  'Thực phẩm công nghệ': Object.freeze(['Bánh kẹo', 'Bơ, sữa, trứng', 'Đồ uống, thuốc lá', 'Đông lạnh', 'Thịt nguội, xúc xích, hàng chua', 'Thực phẩm khô']),
  'Thực phẩm tươi sống, chế biến': Object.freeze(['Bánh mì', 'Rau củ', 'Thịt', 'Thức ăn nấu sẵn', 'Thủy hải sản', 'Trái cây']),
});

const MCH2_VALUES = Object.freeze(Object.keys(MCH3_BY_MCH2));

function isValidMch2(mch2) {
  return MCH2_VALUES.includes(String(mch2 || '').trim());
}

function isValidMch3ForMch2(mch2, mch3) {
  const parent = String(mch2 || '').trim();
  const child = String(mch3 || '').trim();
  return !!parent && !!child && (MCH3_BY_MCH2[parent] || []).includes(child);
}

function validateMerchandising(mch2, mch3, options = {}) {
  const required = options.required !== false;
  const parent = String(mch2 || '').trim();
  const child = String(mch3 || '').trim();
  const errors = [];

  if (!parent) {
    if (required || child) errors.push('mch2_required');
    return errors;
  }
  if (!isValidMch2(parent)) errors.push('mch2_invalid');

  if (!child) {
    if (required) errors.push('mch3_required');
    return errors;
  }
  if (!isValidMch3ForMch2(parent, child)) errors.push('mch3_invalid_for_mch2');

  return errors;
}

module.exports = {
  MCH2_VALUES,
  MCH3_BY_MCH2,
  isValidMch2,
  isValidMch3ForMch2,
  validateMerchandising,
};
