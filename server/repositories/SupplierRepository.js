const FILTERS = {
  q: {
    condition: '(supplier_code LIKE @q OR supplier_name LIKE @q OR tax_code LIKE @q)',
    value: (value) => `%${value}%`,
  },
  mch2: { condition: 'mch2 = @mch2', value: (value) => value },
  mch3: { condition: 'mch3 = @mch3', value: (value) => value },
  status: { condition: 'status = @status', value: (value) => value },
};

class SupplierRepository {
  constructor(db) {
    this.db = db;
    this.listStatementCache = new Map();
    const detailSelect = `
      SELECT
        sm.*,
        created_user.display_name AS created_by_display_name,
        updated_user.display_name AS updated_by_display_name
      FROM supplier_master sm
      LEFT JOIN users created_user ON created_user.email = sm.created_by
      LEFT JOIN users updated_user ON updated_user.email = sm.updated_by
    `;
    this.statements = {
      getById: db.prepare(`${detailSelect} WHERE sm.id = ?`),
      getByCode: db.prepare(`${detailSelect} WHERE sm.supplier_code = ?`),
      update: db.prepare(`
        UPDATE supplier_master SET
          supplier_code = @supplier_code,
          supplier_name = @supplier_name,
          tax_code = @tax_code,
          address = @address,
          production_address = @production_address,
          evaluation_address = @evaluation_address,
          linked_facility_code = @linked_facility_code,
          linked_facility_name = @linked_facility_name,
          linked_facility_address = @linked_facility_address,
          linked_facility_type = @linked_facility_type,
          region = @region,
          province = @province,
          business_type = @business_type,
          cmc_owner = @cmc_owner,
          cmc_head = @cmc_head,
          business_license_file = @business_license_file,
          attp_certificate_type = @attp_certificate_type,
          attp_certificate_file = @attp_certificate_file,
          contact_name = @contact_name,
          contact_email = @contact_email,
          contact_phone = @contact_phone,
          mch2 = @mch2,
          mch3 = @mch3,
          product_group = @product_group,
          product_name = @product_name,
          status = @status,
          source_type = @source_type,
          updated_at = datetime('now'),
          updated_by = @updated_by
        WHERE id = @id
      `),
      insertImportBatch: db.prepare(`
        INSERT INTO supplier_import_batches
          (file_name, uploaded_by, total_rows, success_rows, failed_rows, status, error_summary)
        VALUES
          (@file_name, @uploaded_by, @total_rows, @success_rows, @failed_rows, @status, @error_summary)
      `),
      getImportBatch: db.prepare('SELECT * FROM supplier_import_batches WHERE id = ?'),
      listHistoryBySupplier: db.prepare(`
        SELECT
          h.*,
          actor.display_name AS actor_user_id_display_name
        FROM supplier_master_history h
        LEFT JOIN users actor ON actor.email = h.actor_user_id
        WHERE h.supplier_id = @supplier_id OR h.supplier_code = @supplier_code
        ORDER BY h.created_at DESC, h.id DESC
        LIMIT 100
      `),
    };
  }

  list({ q, mch2, mch3, status, pageSize, offset, scopeFilter = null }) {
    const where = [];
    const params = { pageSize, offset };
    const values = { q, mch2, mch3, status };

    Object.entries(values).forEach(([key, raw]) => {
      if (!raw || !FILTERS[key]) return;
      where.push(FILTERS[key].condition);
      params[key] = FILTERS[key].value(raw);
    });

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const cacheKey = where.join('|') || 'all';
    let cached = this.listStatementCache.get(cacheKey);
    if (!cached) {
      cached = {
        count: this.db.prepare(`SELECT COUNT(*) AS total FROM supplier_master ${whereSql}`),
        all: this.db.prepare(`
          SELECT *
          FROM supplier_master
          ${whereSql}
          ORDER BY COALESCE(updated_at, created_at) DESC, supplier_name ASC
        `),
        list: this.db.prepare(`
          SELECT *
          FROM supplier_master
          ${whereSql}
          ORDER BY COALESCE(updated_at, created_at) DESC, supplier_name ASC
          LIMIT @pageSize OFFSET @offset
        `),
      };
      this.listStatementCache.set(cacheKey, cached);
    }

    if (scopeFilter) {
      const scopedItems = scopeFilter(cached.all.all(params));
      return {
        total: scopedItems.length,
        items: scopedItems.slice(offset, offset + pageSize),
      };
    }

    return {
      total: cached.count.get(params).total,
      items: cached.list.all(params),
    };
  }

  getById(id) {
    return this.statements.getById.get(id);
  }

  getByCode(code) {
    return this.statements.getByCode.get(code);
  }

  getByIdOrCode(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) {
      const byId = this.getById(Number(raw));
      if (byId) return byId;
    }
    return this.getByCode(raw);
  }

  update(payload) {
    return this.statements.update.run(payload);
  }

  listHistory(supplier) {
    if (!supplier) return [];
    return this.statements.listHistoryBySupplier.all({
      supplier_id: supplier.id,
      supplier_code: supplier.supplier_code,
    });
  }

  importExcel({ fileName, userEmail, totalRows, successRows, failedRows, status, errors, rows, upsertSupplier }) {
    const run = this.db.transaction(() => {
      const batch = this.statements.insertImportBatch.run({
        file_name: fileName,
        uploaded_by: userEmail,
        total_rows: totalRows,
        success_rows: successRows,
        failed_rows: failedRows,
        status,
        error_summary: errors.length ? JSON.stringify(errors.slice(0, 50)) : null,
      });
      for (const row of rows) {
        upsertSupplier(this.db, row, userEmail, 'EXCEL_UPLOAD', batch.lastInsertRowid);
      }
      return batch.lastInsertRowid;
    });

    return run();
  }

  getImportBatch(id) {
    return this.statements.getImportBatch.get(id);
  }
}

module.exports = SupplierRepository;
