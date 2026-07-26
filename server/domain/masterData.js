const REGION_OPTIONS = Object.freeze(['MB', 'MN']);

const PROVINCES_BY_REGION = Object.freeze({
  MB: Object.freeze([
    'Tỉnh Tuyên Quang',
    'Tỉnh Lào Cai',
    'Tỉnh Thái Nguyên',
    'Tỉnh Phú Thọ',
    'Tỉnh Bắc Ninh',
    'Tỉnh Hưng Yên',
    'Thành phố Hải Phòng',
    'Tỉnh Ninh Bình',
    'Thành phố Hà Nội',
    'Tỉnh Lai Châu',
    'Tỉnh Điện Biên',
    'Tỉnh Sơn La',
    'Tỉnh Lạng Sơn',
    'Tỉnh Quảng Ninh',
    'Tỉnh Thanh Hóa',
    'Tỉnh Nghệ An',
    'Tỉnh Hà Tĩnh',
    'Tỉnh Cao Bằng',
  ]),
  MN: Object.freeze([
    'Tỉnh Quảng Trị',
    'Thành phố Đà Nẵng',
    'Tỉnh Quảng Ngãi',
    'Tỉnh Gia Lai',
    'Tỉnh Khánh Hòa',
    'Tỉnh Lâm Đồng',
    'Tỉnh Đắk Lắk',
    'Thành phố Hồ Chí Minh',
    'Tỉnh Đồng Nai',
    'Tỉnh Tây Ninh',
    'Thành phố Cần Thơ',
    'Tỉnh Vĩnh Long',
    'Tỉnh Đồng Tháp',
    'Tỉnh Cà Mau',
    'Tỉnh An Giang',
    'Thành phố Huế',
  ]),
});

const BUSINESS_TYPE_OPTIONS = Object.freeze([
  'Tự sản xuất',
  'Kinh doanh',
  'Sản xuất và kinh doanh',
]);

function normalizeMasterDataText(value) {
  return String(value == null ? '' : value).trim();
}

function isValidRegion(value) {
  const region = normalizeMasterDataText(value);
  return !region || REGION_OPTIONS.includes(region);
}

function isValidBusinessType(value) {
  const businessType = normalizeMasterDataText(value);
  return !businessType || BUSINESS_TYPE_OPTIONS.includes(businessType);
}

function isValidProvinceForRegion(regionValue, provinceValue) {
  const region = normalizeMasterDataText(regionValue);
  const province = normalizeMasterDataText(provinceValue);
  if (!province) return true;
  return !!region && (PROVINCES_BY_REGION[region] || []).includes(province);
}

function validateSupplierMasterData(fields) {
  const region = normalizeMasterDataText(fields?.region);
  const province = normalizeMasterDataText(fields?.province);
  const businessType = normalizeMasterDataText(fields?.business_type);
  const errors = {};
  if (!isValidRegion(region)) errors.region = 'invalid';
  if (!isValidProvinceForRegion(region, province)) errors.province = 'invalid';
  if (!isValidBusinessType(businessType)) errors.business_type = 'invalid';
  return errors;
}

function supplierMasterDataErrorCodes(fields) {
  return Object.keys(validateSupplierMasterData(fields)).map((field) => `${field}_invalid`);
}

module.exports = {
  BUSINESS_TYPE_OPTIONS,
  PROVINCES_BY_REGION,
  REGION_OPTIONS,
  isValidBusinessType,
  isValidProvinceForRegion,
  isValidRegion,
  normalizeMasterDataText,
  supplierMasterDataErrorCodes,
  validateSupplierMasterData,
};
