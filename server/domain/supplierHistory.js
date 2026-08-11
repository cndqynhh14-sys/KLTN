const SUPPLIER_HISTORY_FIELDS = [
  ['supplier_code', 'Mã NCC'],
  ['supplier_name', 'Tên NCC'],
  ['tax_code', 'Mã số thuế'],
  ['address', 'Địa chỉ'],
  ['region', 'Khu vực'],
  ['province', 'Tỉnh'],
  ['business_type', 'Loại hình kinh doanh'],
  ['status', 'Trạng thái'],
  ['contact_name', 'Người liên hệ'],
  ['contact_email', 'Email liên hệ'],
  ['contact_phone', 'SĐT liên hệ'],
  ['source_type', 'Nguồn dữ liệu'],
];

function cleanHistoryValue(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function supplierChangeEntries(before, after) {
  return SUPPLIER_HISTORY_FIELDS
    .map(([key, label]) => {
      const previousValue = cleanHistoryValue(before && before[key]);
      const newValue = cleanHistoryValue(after && after[key]);
      if (previousValue === newValue) return null;
      return {
        field_name: label,
        comment: label,
        previous_value: previousValue || null,
        new_value: newValue || null,
      };
    })
    .filter(Boolean);
}

function insertSupplierHistory(db, row) {
  db.prepare(`
    INSERT INTO supplier_master_history (
      supplier_id, supplier_code, actor_user_id, action,
      comment, field_name, previous_value, new_value, payload_json
    )
    VALUES (
      @supplier_id, @supplier_code, @actor_user_id, @action,
      @comment, @field_name, @previous_value, @new_value, @payload_json
    )
  `).run({
    supplier_id: row.supplier_id || null,
    supplier_code: row.supplier_code || '',
    actor_user_id: row.actor_user_id || null,
    action: row.action || 'Cập nhật NCC',
    comment: row.comment || null,
    field_name: row.field_name || null,
    previous_value: row.previous_value || null,
    new_value: row.new_value || null,
    payload_json: row.payload_json || null,
  });
}

function recordSupplierHistory(db, { before, after, actorUserId, action, comment }) {
  if (!after) return;
  const base = {
    supplier_id: after.id,
    supplier_code: after.supplier_code,
    actor_user_id: actorUserId,
    action,
  };
  if (!before) {
    insertSupplierHistory(db, {
      ...base,
      comment,
      field_name: 'NCC',
      previous_value: null,
      new_value: [after.supplier_code, after.supplier_name].filter(Boolean).join(' - ') || after.supplier_code,
    });
    return;
  }
  const changes = supplierChangeEntries(before, after);
  if (!changes.length) {
    insertSupplierHistory(db, {
      ...base,
      comment: comment || 'Không có thay đổi dữ liệu',
      field_name: null,
      previous_value: null,
      new_value: null,
    });
    return;
  }
  changes.forEach((change) => insertSupplierHistory(db, {
    ...base,
    ...change,
  }));
}

module.exports = {
  SUPPLIER_HISTORY_FIELDS,
  supplierChangeEntries,
  recordSupplierHistory,
};
