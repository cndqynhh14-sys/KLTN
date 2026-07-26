-- RUN-09: approver roles keep workflow permissions, but do not inherit
-- administration capabilities. Delete legacy/manual ALLOW or DENY rows rather
-- than adding a DENY so a separately approved administration role can still
-- grant access to a multi-role user.
DELETE FROM role_permissions
WHERE role_id IN (
  SELECT id FROM roles WHERE role_code IN (
    'REGIONAL_LEAD_APPROVER',
    'DEPARTMENT_HEAD_APPROVER',
    'BLOCK_DIRECTOR_APPROVER'
  )
)
AND permission_code IN (
  'SYSTEM.ADMIN',
  'USER.MANAGE',
  'UPLOAD.MANAGE',
  'AUDIT.READ',
  'AUDIT.EXPORT',
  'REPORT_TEMPLATE.MANAGE',
  'REPORT_TEMPLATE.PUBLISH',
  'REPORT_TEMPLATE.ADVANCED',
  'QUESTION_TEMPLATE.MANAGE',
  'SCORING_POLICY.MANAGE',
  'SCORING_POLICY.PUBLISH'
);
