# Registry generation report

Source: `registry/odoo_spec.json` (saas~19.4+e, db `masta`)

| Item | Count |
|---|---|
| Apps (root menus) | 22 |
| Menus | 330 |
| Actions | 277 |
| Views | 668 (kanban 80, list 161, form 144, search 163, pivot 37, graph 37, activity 17, grid 1, map 2, calendar 11, hierarchy 4, gantt 8, cohort 3) |
| Models | 201 |
| Fields captured | 3980 |
| Fields synthesized (one2many back-references) | 52 |
| Distinct field widgets | 169 |
| Groups | 89 |
| Printable reports | 29 |
| Financial reports | 19 |
| Seed models | 88 |
| i18n pairs (EN → AR) | 5506 |

## Relations to models the export did not capture (70)

These comodels are referenced by a many2one/x2many but have no field list in the export. They need their fields added from Part H or from Odoo's own definitions before the ORM can traverse them.

- `account.account.tag`
- `account.analytic.account`
- `account.asset.group`
- `account.bank.statement`
- `account.fiscal.category`
- `account.full.reconcile`
- `account.incoterms`
- `account.lock_exception`
- `account.online.account`
- `account.partial.reconcile`
- `account.payment.method`
- `account.report`
- `account.return.audit.cycle`
- `account.root`
- `account.tax.group`
- `base.geo_provider`
- `calendar.event.type`
- `calendar.recurrence`
- `crm.tag`
- `documents.access`
- `fleet.vehicle.assignation.log`
- `gamification.goal.definition`
- `helpdesk.sla.status`
- `helpdesk.tag`
- `hr.employee.category`
- `hr.employee.departure`
- `hr.payroll.structure.type`
- `hr.resume.line.type`
- `iap.service`
- `ir.actions.actions`
- `ir.actions.report`
- `ir.attachment`
- `ir.embedded.actions`
- `ir.model`
- `ir.module.category`
- `ir.ui.view`
- `knowledge.cover`
- `mail.alias`
- `mail.alias.domain`
- `mail.guest`
- `mail.message.subtype`
- `mail.template`
- `planning.recurrency`
- `product.document`
- `product.product`
- `product.tag`
- `product.template.attribute.value`
- `project.milestone`
- `project.task.recurrence`
- `project.task.stage.personal`
- `project.task.type`
- `properties.base.definition`
- `purchase.bill.union`
- `report.layout`
- `report.paperformat`
- `res.country`
- `res.country.group`
- `res.country.state`
- `res.groups`
- `res.partner.bank`
- `res.partner.industry`
- `resource.calendar.attendance`
- `sale.order.spreadsheet`
- `sale.pdf.form.field`
- `sign.completed.document`
- `sign.document`
- `sms.template`
- `utm.campaign`
- `utm.medium`
- `utm.source`

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
- `hr.skill.type` ← `hr_skill_type_id`
- `hr.skill.type` ← `hr_skill_type_id`
- `ir.exports` ← `ir_exports_id`
- `ir.module.module` ← `ir_module_module_id`
- `ir.module.module` ← `ir_module_module_id`
- `mail.activity.plan` ← `mail_activity_plan_id`
- `mail.activity.schedule` ← `mail_activity_schedule_id`
- `mail.message` ← `mail_message_id`
- `mail.message` ← `mail_message_id`
- `planning.analysis.report` ← `planning_analysis_report_id`
- `planning.slot` ← `planning_slot_id`
- `product.attribute` ← `product_attribute_id`
- `product.combo` ← `product_combo_id`
- `product.template` ← `product_template_id`
- `project.task` ← `project_task_id`
- `report.project.task.user` ← `report_project_task_user_id`
- `res.users.settings` ← `res_users_settings_id`
- `res.users` ← `res_users_id`
- `res.users` ← `res_users_id`
- `resource.resource` ← `resource_resource_id`
- `sale.order.line` ← `sale_order_line_id`
- `sale.order.template` ← `sale_order_template_id`
- `sign.request` ← `sign_request_id`
- `sign.request` ← `sign_request_id`
- `sign.template` ← `sign_template_id`
