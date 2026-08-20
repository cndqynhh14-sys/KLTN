# Menu and action matrix

Generated from `public/js/navigation-manifest.js`. Navigation manifest version: `9`.

| ID | Parent | Route | View | Label | Permissions | Feature | Mobile | Sidebar | Sidebar active | Contextual |
|---|---|---|---|---|---|---|---:|---:|---|---:|
| `work` | — | — | — | Công việc | — | ON | — | yes | — | no |
| `workspace` | `work` | `/workspace` | `view-workspace` | Không gian làm việc | `EVALUATION.READ` | ON | 1 | yes | — | no |
| `approvals` | `work` | `/approvals` | `view-approvals` | Việc cần phê duyệt | `EVALUATION.APPROVE_LEAD`<br>`EVALUATION.APPROVE_TBP`<br>`EVALUATION.APPROVE_GDK` | ON | 2 | yes | — | no |
| `supplier-business` | — | — | — | Nghiệp vụ NCC | — | ON | — | yes | — | no |
| `evaluations` | `supplier-business` | `/evaluations` | `view-evaluations` | Phiếu đánh giá | `EVALUATION.READ` | ON | 4 | yes | — | no |
| `evaluation-new` | `evaluations` | `/evaluations/new` | `view-evaluation-new` | Tạo phiếu đánh giá | `EVALUATION.CREATE` | ON | — | yes | — | yes |
| `scoring` | `evaluations` | `/evaluations/scoring` | `view-scoring` | Chấm điểm | `EVALUATION.SCORE` | ON | — | yes | — | yes |
| `suppliers` | `supplier-business` | `/suppliers` | `view-suppliers` | Danh mục NCC | `SUPPLIER.READ` | ON | 20 | yes | — | no |
| `analytics` | — | — | — | Báo cáo & phân tích | — | ON | — | yes | — | no |
| `overview` | `analytics` | `/dashboard` | `view-overview` | Báo cáo thống kê | `DASHBOARD.READ` | ON | 30 | yes | — | no |
| `reports` | `evaluations` | `/reports` | `view-reports` | Báo cáo | `REPORT.READ` | ON | — | yes | — | yes |
| `administration` | — | — | — | Quản trị | — | ON | — | yes | — | no |
| `admin` | `administration` | `/admin` | `view-admin` | Trung tâm quản trị | `SYSTEM.ADMIN`<br>`USER.MANAGE`<br>`AUDIT.READ`<br>`AUDIT.EXPORT`<br>`REPORT_TEMPLATE.MANAGE`<br>`REPORT_TEMPLATE.PUBLISH`<br>`REPORT_TEMPLATE.ADVANCED`<br>`QUESTION_TEMPLATE.MANAGE`<br>`SCORING_POLICY.MANAGE`<br>`SCORING_POLICY.PUBLISH` | ON | 40 | yes | — | no |
| `admin-people-access` | `admin` | — | — | Nhân sự & phân quyền | — | ON | — | yes | — | no |
| `admin-users` | `admin-people-access` | `/admin/users` | `view-admin` | Danh sách nhân sự | `USER.MANAGE` | ON | — | yes | — | no |
| `admin-roles` | `admin-people-access` | `/admin/roles` | `view-admin` | Vai trò công việc | `USER.MANAGE` | ON | — | yes | — | no |
| `admin-personnel-import` | `admin-people-access` | `/admin/personnel-import` | `view-admin` | Nhập danh sách nhân sự | `USER.MANAGE` | ON | — | yes | — | no |
| `admin-approval-assignments` | `admin-people-access` | `/admin/approval-assignments` | `view-admin` | Người phê duyệt | `USER.MANAGE` | ON | — | yes | — | no |
| `admin-business-config` | `admin` | — | — | Cấu hình nghiệp vụ | — | ON | — | yes | — | no |
| `admin-question-templates` | `admin-business-config` | `/admin/question-templates` | `view-admin` | Bộ câu hỏi đánh giá | `QUESTION_TEMPLATE.MANAGE` | ON | — | yes | — | no |
| `admin-report-templates` | `admin-business-config` | `/admin/report-templates` | `view-admin` | Mẫu báo cáo | `REPORT_TEMPLATE.MANAGE` | ON | — | yes | — | no |
| `admin-scoring-policies` | `admin-business-config` | `/admin/scoring-policies` | `view-admin` | Chính sách tính điểm | `SCORING_POLICY.MANAGE` | ON | — | yes | — | no |
| `admin-system-operations` | `admin` | — | — | Vận hành hệ thống | — | ON | — | yes | — | no |
| `admin-system-logs` | `admin-system-operations` | `/admin/system-logs` | `view-admin` | Nhật ký hệ thống | `AUDIT.READ` | ON | — | yes | — | no |
| `admin-uat-runs` | `admin-system-operations` | `/admin/uat-runs` | `view-admin-uat-runs` | UAT runs | `SYSTEM.ADMIN` | `ADMIN_UAT_RUNS` (OFF) | — | yes | — | no |

## Contextual actions

| ID | Placement | Required permission |
|---|---|---|
| `evaluation-new` | `evaluations` | `EVALUATION.CREATE` |
| `scoring` | `evaluations` | `EVALUATION.SCORE` |
| `reports` | `evaluations` | `REPORT.READ` |

## Orphan report

- Enabled orphan routes: `0`
- Enabled orphan views: `0`
- Unknown permissions: `0`
- Manifest contract test gaps: `0`
- Feature-OFF routes: `1` — `/admin/uat-runs` (`ADMIN_UAT_RUNS`)

The generator fails the RUN-11 contract test when an enabled route has no loader/view, a rendered view has no route, a permission is unknown, or the manifest-wide contract test is removed.
