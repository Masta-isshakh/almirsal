# Registry generation report

Source: `registry/odoo_spec.json` (saas~19.4+e, db `masta`)

| Item | Count |
|---|---|
| Apps (root menus) | 22 |
| Menus | 330 |
| Actions | 277 |
| Views | 668 (kanban 80, list 161, form 144, search 163, pivot 37, graph 37, activity 17, grid 1, map 2, calendar 11, hierarchy 4, gantt 8, cohort 3) |
| Models | 288 |
| Fields captured | 4660 |
| Fields synthesized (one2many back-references) | 50 |
| Distinct field widgets | 169 |
| Groups | 89 |
| Printable reports | 29 |
| Financial reports | 19 |
| Seed models | 88 |
| i18n pairs (EN → AR) | 5506 |

## Relations to models the export did not capture (0)

These comodels are referenced by a many2one/x2many but have no field list in the export. They need their fields added from Part H or from Odoo's own definitions before the ORM can traverse them.


## Synthesized one2many back-references

- `account.account` ← `account_account_id`
- `account.fiscal.position` ← `account_fiscal_position_id`
- `account.journal` ← `account_journal_id`
- `account.move` ← `account_move_id`
- `account.payment.term` ← `account_payment_term_id`
- `account.reconcile.model` ← `account_reconcile_model_id`
- `account.tax` ← `account_tax_id`
- `appointment.question` ← `appointment_question_id`
- `appointment.type` ← `appointment_type_id`
- `approval.category` ← `approval_category_id`
- `approval.request` ← `approval_request_id`
- `approval.request` ← `approval_request_id`
- `calendar.event` ← `calendar_event_id`
- `calendar.event` ← `calendar_event_id`
- `crm.team` ← `crm_team_id`
- `discuss.channel` ← `discuss_channel_id`
- `fleet.vehicle` ← `fleet_vehicle_id`
- `gamification.challenge` ← `gamification_challenge_id`
- `hr.attendance.overtime.ruleset` ← `hr_attendance_overtime_ruleset_id`
- `hr.attendance` ← `hr_attendance_id`
- `hr.employee.public` ← `hr_employee_public_id`
- `hr.employee.public` ← `hr_employee_public_id`
- `hr.employee.public` ← `hr_employee_public_id`
- `hr.employee.public` ← `hr_employee_public_id`
- `hr.employee` ← `hr_employee_id`
- `hr.employee` ← `hr_employee_id`
- `hr.job` ← `hr_job_id`
- `ir.exports` ← `ir_exports_id`
- `ir.module.module` ← `ir_module_module_id`
- `ir.module.module` ← `ir_module_module_id`
- `mail.activity.plan` ← `mail_activity_plan_id`
- `mail.activity.schedule` ← `mail_activity_schedule_id`
- `mail.message` ← `mail_message_id`
- `planning.analysis.report` ← `planning_analysis_report_id`
- `planning.slot` ← `planning_slot_id`
- `product.attribute` ← `product_attribute_id`
- `product.combo` ← `product_combo_id`
- `product.template` ← `product_template_id`
- `project.task` ← `project_task_id`
- `report.project.task.user` ← `report_project_task_user_id`
- `res.partner` ← `res_partner_id`
- `res.users.settings` ← `res_users_settings_id`
- `res.users` ← `res_users_id`
- `res.users` ← `res_users_id`
- `resource.resource` ← `resource_resource_id`
- `sale.order.line` ← `sale_order_line_id`
- `sale.order.template` ← `sale_order_template_id`
- `sign.request` ← `sign_request_id`
- `sign.request` ← `sign_request_id`
- `sign.template` ← `sign_template_id`
