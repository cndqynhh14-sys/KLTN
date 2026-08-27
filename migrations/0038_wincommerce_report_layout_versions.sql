-- Remove only the two verified no-op ROUND1 drafts, then publish the new
-- WinCommerce report profile as the next contiguous version for each report.
-- This migration is intentionally strict: any reference or semantic drift in
-- the cleanup candidates aborts the transaction instead of deleting history.

CREATE TEMP TABLE _report_layout_guard (
  ok INTEGER NOT NULL CHECK (ok = 1)
);

INSERT INTO _report_layout_guard (ok)
SELECT CASE WHEN NOT EXISTS (
  SELECT 1
  FROM report_template_versions candidate
  WHERE candidate.definition_code = 'ROUND1_RESULT'
    AND candidate.version_no IN (3, 4)
    AND NOT (candidate.version_no = 3 AND COALESCE(candidate.checksum, '') = 'c8c3ca495795f7734fe0c493476262aa2827b92a57a4c52b4ee67003f7b7e1eb')
    AND NOT (
      candidate.status = 'DRAFT'
      AND candidate.definition_json = (
        SELECT source.definition_json
        FROM report_template_versions source
        WHERE source.definition_code = 'ROUND1_RESULT' AND source.version_no = 2
      )
      AND NOT EXISTS (SELECT 1 FROM report_template_assignments a WHERE a.report_template_version_id = candidate.id)
      AND NOT EXISTS (SELECT 1 FROM report_exports e WHERE e.report_template_version_id = candidate.id)
      AND NOT EXISTS (SELECT 1 FROM report_export_jobs j WHERE j.report_template_version_id = candidate.id)
      AND NOT EXISTS (SELECT 1 FROM report_source_snapshots s WHERE s.report_template_version_id = candidate.id)
      AND NOT EXISTS (SELECT 1 FROM report_legacy_template_links l WHERE l.report_template_version_id = candidate.id)
    )
) THEN 1 ELSE 0 END;

DROP TRIGGER IF EXISTS trg_report_template_event_append_only_delete;

DELETE FROM report_template_version_events
WHERE report_template_version_id IN (
  SELECT candidate.id
  FROM report_template_versions candidate
  WHERE candidate.definition_code = 'ROUND1_RESULT'
    AND candidate.version_no IN (3, 4)
    AND NOT (candidate.version_no = 3 AND COALESCE(candidate.checksum, '') = 'c8c3ca495795f7734fe0c493476262aa2827b92a57a4c52b4ee67003f7b7e1eb')
    AND candidate.status = 'DRAFT'
    AND candidate.definition_json = (
      SELECT source.definition_json
      FROM report_template_versions source
      WHERE source.definition_code = 'ROUND1_RESULT' AND source.version_no = 2
    )
    AND NOT EXISTS (SELECT 1 FROM report_template_assignments a WHERE a.report_template_version_id = candidate.id)
    AND NOT EXISTS (SELECT 1 FROM report_exports e WHERE e.report_template_version_id = candidate.id)
    AND NOT EXISTS (SELECT 1 FROM report_export_jobs j WHERE j.report_template_version_id = candidate.id)
    AND NOT EXISTS (SELECT 1 FROM report_source_snapshots s WHERE s.report_template_version_id = candidate.id)
    AND NOT EXISTS (SELECT 1 FROM report_legacy_template_links l WHERE l.report_template_version_id = candidate.id)
);

DELETE FROM report_template_versions
WHERE definition_code = 'ROUND1_RESULT'
  AND version_no IN (3, 4)
  AND NOT (version_no = 3 AND COALESCE(checksum, '') = 'c8c3ca495795f7734fe0c493476262aa2827b92a57a4c52b4ee67003f7b7e1eb')
  AND status = 'DRAFT'
  AND definition_json = (
    SELECT source.definition_json
    FROM report_template_versions source
    WHERE source.definition_code = 'ROUND1_RESULT' AND source.version_no = 2
  )
  AND NOT EXISTS (SELECT 1 FROM report_template_assignments a WHERE a.report_template_version_id = report_template_versions.id)
  AND NOT EXISTS (SELECT 1 FROM report_exports e WHERE e.report_template_version_id = report_template_versions.id)
  AND NOT EXISTS (SELECT 1 FROM report_export_jobs j WHERE j.report_template_version_id = report_template_versions.id)
  AND NOT EXISTS (SELECT 1 FROM report_source_snapshots s WHERE s.report_template_version_id = report_template_versions.id)
  AND NOT EXISTS (SELECT 1 FROM report_legacy_template_links l WHERE l.report_template_version_id = report_template_versions.id);

CREATE TRIGGER trg_report_template_event_append_only_delete
BEFORE DELETE ON report_template_version_events
BEGIN
  SELECT RAISE(ABORT, 'report_template_event_append_only');
END;

DELETE FROM _report_layout_guard;
INSERT INTO _report_layout_guard (ok)
SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM report_template_versions
  WHERE (definition_code = 'WORKING_MINUTES' AND version_no = 2 AND COALESCE(checksum, '') != 'b26b7df3a50b2187e69f6c84c1357ae515a6978c1c6686186a95f5214275a574')
     OR (definition_code = 'ROUND1_RESULT' AND version_no = 3 AND COALESCE(checksum, '') != 'c8c3ca495795f7734fe0c493476262aa2827b92a57a4c52b4ee67003f7b7e1eb')
     OR (definition_code = 'ROUND2_RESULT' AND version_no = 3 AND COALESCE(checksum, '') != 'dcc18048fb8069340c8b85e884320ca55cde63d362c98851f6e0d34d283e50b0')
) THEN 1 ELSE 0 END;

INSERT INTO report_template_versions (
  definition_code, version_no, version_name, status, definition_json,
  schema_version, checksum, version_note, effective_from, lock_version,
  submitted_at, published_at
)
SELECT
  'WORKING_MINUTES', 2, 'Biên bản làm việc WinCommerce 2026', 'PUBLISHED',
  '{"components":[{"id":"header","meta_fields":[{"binding":"doc4.related_information.report_no","label":"Số"},{"binding":"doc4.related_information.evaluation_date","format":"date_ddmmyyyy","label":"Ngày đánh giá"}],"title":"BIÊN BẢN LÀM VIỆC VỚI NHÀ CUNG CẤP","type":"header"},{"fields":[{"binding":"doc4.related_information.supplier_name","label":"Nhà cung cấp"},{"binding":"doc4.related_information.supplier_code","label":"Mã nhà cung cấp"},{"binding":"doc4.related_information.evaluation_address","label":"Địa điểm đánh giá"},{"binding":"doc4.related_information.evaluators","label":"Đánh giá viên"}],"id":"metadata","layout":"stacked","title":"Thông tin nhà cung cấp","type":"metadata_grid"},{"fields":[{"binding":"doc4.scope.product","label":"Sản phẩm"},{"binding":"doc4.scope.business_type","label":"Loại hình"},{"binding":"doc4.scope.evaluation_type","label":"Loại đánh giá"}],"id":"scope","layout":"stacked","title":"Phạm vi đánh giá","type":"scope_summary"},{"binding":"doc4.participants.rows","columns":[{"align":"left","key":"name","label":"Tên/Chức danh","width":"56%"},{"align":"center","key":"opening","label":"Họp khai mạc","width":"22%"},{"align":"center","key":"closing","label":"Họp bế mạc","width":"22%"}],"id":"participants","title":"Thành phần tham dự","type":"participants_table"},{"binding":"doc4.supplier_introduction.content","id":"supplier-introduction","title":"Giới thiệu nhà cung cấp","type":"supplier_introduction"},{"binding":"doc4.nonconformity_summary","columns":[{"align":"center","key":"clause","label":"Điều khoản","width":"11%"},{"key":"category","label":"Hạng mục","width":"15%"},{"align":"center","key":"score","label":"Điểm","width":"8%"},{"key":"description","label":"Mô tả","width":"26%"},{"key":"corrective_action","label":"Khắc phục","width":"25%"},{"align":"center","format":"date_ddmmyyyy","key":"due_date","label":"Hạn","width":"15%"}],"id":"nonconformities","title":"Nội dung không phù hợp","type":"nonconformity_table"},{"display_mode":"manual_blank","fields":[{"binding":"doc4.signatures.evaluator","label":"ĐÁNH GIÁ VIÊN"},{"binding":"doc4.signatures.supplier_representative","label":"ĐẠI DIỆN NCC"}],"id":"signatures","show_title":false,"title":"","type":"signature_block"}],"schema_version":1,"styles":{"font_scale":1,"page_orientation":"portrait","report_profile":"wincommerce_supplier_assessment"}}',
  1, 'b26b7df3a50b2187e69f6c84c1357ae515a6978c1c6686186a95f5214275a574',
  'Layout WinCommerce 2026; bỏ cột trạng thái; chữ ký tay hai cột không tiêu đề; phân trang động.',
  date('now'), 1, datetime('now'), datetime('now')
WHERE EXISTS (SELECT 1 FROM report_template_versions WHERE definition_code = 'WORKING_MINUTES' AND version_no = 1)
  AND NOT EXISTS (SELECT 1 FROM report_template_versions WHERE definition_code = 'WORKING_MINUTES' AND version_no = 2);

INSERT INTO report_template_versions (
  definition_code, version_no, version_name, status, definition_json,
  schema_version, checksum, version_note, effective_from, lock_version,
  submitted_at, published_at
)
SELECT
  'ROUND1_RESULT', 3, 'Kết quả đánh giá lần 1 WinCommerce 2026', 'PUBLISHED',
  '{"components":[{"id":"header","meta_fields":[{"binding":"doc4.related_information.report_no","label":"Số"},{"binding":"doc4.related_information.evaluation_date","format":"date_ddmmyyyy","label":"Ngày đánh giá"}],"title":"KẾT QUẢ ĐÁNH GIÁ NHÀ CUNG CẤP LẦN 1","type":"header"},{"fields":[{"binding":"doc4.related_information.supplier_name","label":"Nhà cung cấp"},{"binding":"doc4.related_information.supplier_code","label":"Mã nhà cung cấp"},{"binding":"doc4.related_information.evaluation_address","label":"Địa điểm đánh giá"},{"binding":"doc4.related_information.evaluators","label":"Đánh giá viên"}],"id":"metadata","layout":"stacked","title":"Thông tin nhà cung cấp","type":"metadata_grid"},{"fields":[{"binding":"doc4.scope.product","label":"Sản phẩm"},{"binding":"doc4.scope.business_type","label":"Loại hình"},{"binding":"doc4.scope.evaluation_type","label":"Loại đánh giá"}],"id":"scope","layout":"stacked","title":"Phạm vi đánh giá","type":"scope_summary"},{"binding":"doc4.participants.rows","columns":[{"align":"left","key":"name","label":"Tên/Chức danh","width":"56%"},{"align":"center","key":"opening","label":"Họp khai mạc","width":"22%"},{"align":"center","key":"closing","label":"Họp bế mạc","width":"22%"}],"id":"participants","title":"Thành phần tham dự","type":"participants_table"},{"binding":"doc4.supplier_introduction.content","id":"supplier-introduction","title":"Giới thiệu nhà cung cấp","type":"supplier_introduction"},{"binding":"doc4.compliance_summary","columns":[{"key":"category","label":"Hạng mục"},{"key":"counts.A","label":"A"},{"key":"counts.B","label":"B"},{"key":"counts.C","label":"C"},{"key":"counts.D","label":"D"},{"key":"counts.NA","label":"NA"},{"key":"percentage","label":"%"}],"id":"compliance","title":"Tổng hợp tuân thủ","type":"compliance_overview"},{"fields":[{"binding":"doc4.result_summary.final_score_percent","label":"Điểm cuối"},{"binding":"doc4.result_summary.final_result_label","label":"Kết quả"},{"binding":"doc4.result_summary.final_conclusion","label":"Kết luận"}],"id":"result","layout":"stacked","title":"Kết quả","type":"metadata_grid"},{"binding":"doc4.nonconformity_summary","columns":[{"align":"center","key":"clause","label":"Điều khoản","width":"11%"},{"key":"category","label":"Hạng mục","width":"15%"},{"align":"center","key":"score","label":"Điểm","width":"8%"},{"key":"description","label":"Mô tả","width":"26%"},{"key":"corrective_action","label":"Khắc phục","width":"25%"},{"align":"center","format":"date_ddmmyyyy","key":"due_date","label":"Hạn","width":"15%"}],"id":"nonconformities","title":"Điểm không phù hợp","type":"nonconformity_table"},{"display_mode":"manual_blank","fields":[{"binding":"doc4.signatures.evaluator","label":"ĐÁNH GIÁ VIÊN"},{"binding":"doc4.signatures.supplier_representative","label":"ĐẠI DIỆN NCC"}],"id":"signatures","show_title":false,"title":"","type":"signature_block"}],"schema_version":1,"styles":{"font_scale":1,"page_orientation":"portrait","report_profile":"wincommerce_supplier_assessment"}}',
  1, 'c8c3ca495795f7734fe0c493476262aa2827b92a57a4c52b4ee67003f7b7e1eb',
  'Layout WinCommerce 2026; bỏ trạng thái, người duyệt, corrective-actions và approval-history; phân trang động.',
  date('now'), 1, datetime('now'), datetime('now')
WHERE EXISTS (SELECT 1 FROM report_template_versions WHERE definition_code = 'ROUND1_RESULT' AND version_no = 2)
  AND NOT EXISTS (SELECT 1 FROM report_template_versions WHERE definition_code = 'ROUND1_RESULT' AND version_no = 3);

INSERT INTO report_template_versions (
  definition_code, version_no, version_name, status, definition_json,
  schema_version, checksum, version_note, effective_from, lock_version,
  submitted_at, published_at
)
SELECT
  'ROUND2_RESULT', 3, 'Kết quả đánh giá lần 2 WinCommerce 2026', 'PUBLISHED',
  replace(
    (SELECT definition_json FROM report_template_versions WHERE definition_code = 'ROUND1_RESULT' AND version_no = 3),
    'KẾT QUẢ ĐÁNH GIÁ NHÀ CUNG CẤP LẦN 1',
    'KẾT QUẢ ĐÁNH GIÁ NHÀ CUNG CẤP LẦN 2'
  ),
  1, 'dcc18048fb8069340c8b85e884320ca55cde63d362c98851f6e0d34d283e50b0',
  'Layout WinCommerce 2026; bỏ trạng thái, người duyệt, corrective-actions và approval-history; phân trang động.',
  date('now'), 1, datetime('now'), datetime('now')
WHERE EXISTS (SELECT 1 FROM report_template_versions WHERE definition_code = 'ROUND2_RESULT' AND version_no = 2)
  AND EXISTS (SELECT 1 FROM report_template_versions WHERE definition_code = 'ROUND1_RESULT' AND version_no = 3)
  AND NOT EXISTS (SELECT 1 FROM report_template_versions WHERE definition_code = 'ROUND2_RESULT' AND version_no = 3);

UPDATE report_template_assignments
SET is_default = 0, updated_at = datetime('now')
WHERE definition_code IN ('WORKING_MINUTES', 'ROUND1_RESULT', 'ROUND2_RESULT')
  AND active = 1 AND is_default = 1
  AND EXISTS (
    SELECT 1 FROM report_template_versions target
    WHERE target.definition_code = report_template_assignments.definition_code
      AND target.checksum IN (
        'b26b7df3a50b2187e69f6c84c1357ae515a6978c1c6686186a95f5214275a574',
        'c8c3ca495795f7734fe0c493476262aa2827b92a57a4c52b4ee67003f7b7e1eb',
        'dcc18048fb8069340c8b85e884320ca55cde63d362c98851f6e0d34d283e50b0'
      )
  );

INSERT INTO report_template_assignments (
  definition_code, report_template_version_id, scope_type, scope_key,
  effective_from, is_default, active
)
SELECT definition_code, id, 'GLOBAL', '*', date('now'), 1, 1
FROM report_template_versions
WHERE checksum IN (
  'b26b7df3a50b2187e69f6c84c1357ae515a6978c1c6686186a95f5214275a574',
  'c8c3ca495795f7734fe0c493476262aa2827b92a57a4c52b4ee67003f7b7e1eb',
  'dcc18048fb8069340c8b85e884320ca55cde63d362c98851f6e0d34d283e50b0'
)
ON CONFLICT(report_template_version_id, scope_type, scope_key) DO UPDATE SET
  effective_from = excluded.effective_from,
  effective_to = NULL,
  is_default = 1,
  active = 1,
  updated_at = datetime('now');

INSERT INTO report_template_version_events (
  report_template_version_id, action, before_json, after_json, correlation_id
)
SELECT id, 'MIGRATED_PUBLISHED', NULL, definition_json, 'MIGRATION-0038'
FROM report_template_versions version
WHERE checksum IN (
  'b26b7df3a50b2187e69f6c84c1357ae515a6978c1c6686186a95f5214275a574',
  'c8c3ca495795f7734fe0c493476262aa2827b92a57a4c52b4ee67003f7b7e1eb',
  'dcc18048fb8069340c8b85e884320ca55cde63d362c98851f6e0d34d283e50b0'
)
AND NOT EXISTS (
  SELECT 1 FROM report_template_version_events event
  WHERE event.report_template_version_id = version.id
    AND event.action = 'MIGRATED_PUBLISHED'
    AND event.correlation_id = 'MIGRATION-0038'
);

DROP TABLE _report_layout_guard;
