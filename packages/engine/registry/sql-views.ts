import type { ModelDef } from './types.js';
import { quoteIdent, sqlTypeOf } from '../schema/ddl.js';

/**
 * Reporting models (`sale.report`, `account.invoice.report`, …) are SQL views
 * over the business tables, as in Odoo (`_auto = False` + `init()`). Each
 * definition names its FROM clause and an expression per column; every
 * stored field of the model is emitted (missing ones as typed NULLs) so the
 * ORM can read, search, group and sort them like any table. Expressions
 * that reference a column the registry does not have degrade to NULL
 * instead of breaking the view.
 */

type Col = string | [alias: string, model: string, field: string];

interface ViewDef {
  /** `FROM … JOIN …` clause; the first alias carries the row id. */
  from: string;
  where?: string;
  /** Column expressions; a tuple is validated against the registry. */
  columns: Record<string, Col>;
  /** Row id expression (default: `<first alias>."id"`). */
  id?: string;
  /** Models whose tables the view needs; the view is skipped when one is missing. */
  requires: string[];
}

const defs: Record<string, ViewDef> = {
  'sale.report': {
    requires: ['sale.order.line', 'sale.order'],
    from: `sale_order_line l JOIN sale_order o ON o.id = l.order_id LEFT JOIN res_partner rp ON rp.id = o.partner_id LEFT JOIN product_product p ON p.id = l.product_id LEFT JOIN product_template tp ON tp.id = p.product_tmpl_id`,
    where: `coalesce(l.display_type, 'product') = 'product'`,
    columns: {
      date: ['o', 'sale.order', 'date_order'], name: ['o', 'sale.order', 'name'], state: ['o', 'sale.order', 'state'], team_id: ['o', 'sale.order', 'team_id'],
      partner_id: ['o', 'sale.order', 'partner_id'], user_id: ['o', 'sale.order', 'user_id'], pricelist_id: ['o', 'sale.order', 'pricelist_id'], currency_id: ['o', 'sale.order', 'currency_id'],
      company_id: ['o', 'sale.order', 'company_id'], invoice_status: ['o', 'sale.order', 'invoice_status'], campaign_id: ['o', 'sale.order', 'campaign_id'], source_id: ['o', 'sale.order', 'source_id'],
      medium_id: ['o', 'sale.order', 'medium_id'], utm_reference: ['o', 'sale.order', 'utm_reference'], project_id: ['o', 'sale.order', 'project_id'],
      product_uom_qty: ['l', 'sale.order.line', 'product_uom_qty'], price_subtotal: ['l', 'sale.order.line', 'price_subtotal'], price_total: ['l', 'sale.order.line', 'price_total'], price_unit: ['l', 'sale.order.line', 'price_unit'],
      line_invoice_status: ['l', 'sale.order.line', 'invoice_status'], line_name: ['l', 'sale.order.line', 'name'], product_id: ['l', 'sale.order.line', 'product_id'], product_uom_id: ['l', 'sale.order.line', 'product_uom_id'],
      qty_to_invoice: ['l', 'sale.order.line', 'qty_to_invoice'], qty_delivered: ['l', 'sale.order.line', 'qty_delivered'], qty_invoiced: ['l', 'sale.order.line', 'qty_invoiced'], discount: ['l', 'sale.order.line', 'discount'],
      untaxed_amount_to_invoice: ['l', 'sale.order.line', 'untaxed_amount_to_invoice'], untaxed_amount_invoiced: ['l', 'sale.order.line', 'untaxed_amount_invoiced'],
      qty_to_deliver: `coalesce(l.product_uom_qty, 0) - coalesce(l.qty_delivered, 0)`,
      untaxed_delivered_amount: `coalesce(l.price_unit, 0) * coalesce(l.qty_delivered, 0) * (1 - coalesce(l.discount, 0) / 100.0)`,
      discount_amount: `coalesce(l.price_unit, 0) * coalesce(l.product_uom_qty, 0) * coalesce(l.discount, 0) / 100.0`,
      nbr: `1`, order_reference: `'sale.order,' || o.id`, commercial_partner_id: `coalesce(rp.commercial_partner_id, o.partner_id)`,
      industry_id: ['rp', 'res.partner', 'industry_id'], state_id: ['rp', 'res.partner', 'state_id'], country_id: ['rp', 'res.partner', 'country_id'], partner_zip: ['rp', 'res.partner', 'zip'],
      categ_id: ['tp', 'product.template', 'categ_id'], product_tmpl_id: ['p', 'product.product', 'product_tmpl_id'], weight: ['tp', 'product.template', 'weight'], volume: ['tp', 'product.template', 'volume'],
      create_date: ['o', 'sale.order', 'create_date'], write_date: ['o', 'sale.order', 'write_date'], create_uid: ['o', 'sale.order', 'create_uid'], write_uid: ['o', 'sale.order', 'write_uid'],
    },
  },
  'sale.rental.report': {
    requires: ['sale.order.line', 'sale.order'],
    from: `sale_order_line l JOIN sale_order o ON o.id = l.order_id LEFT JOIN product_product p ON p.id = l.product_id LEFT JOIN product_template tp ON tp.id = p.product_tmpl_id`,
    where: `coalesce(l.is_rental, false) = true AND coalesce(l.display_type, 'product') = 'product'`,
    columns: {
      state: ['o', 'sale.order', 'state'], date: `coalesce(l.start_date, o.date_order)::date`, quantity: ['l', 'sale.order.line', 'product_uom_qty'], qty_delivered: ['l', 'sale.order.line', 'qty_delivered'],
      price: ['l', 'sale.order.line', 'price_subtotal'], product_id: ['l', 'sale.order.line', 'product_id'], categ_id: ['tp', 'product.template', 'categ_id'], partner_id: ['o', 'sale.order', 'partner_id'], user_id: ['o', 'sale.order', 'user_id'],
      create_date: ['o', 'sale.order', 'create_date'], write_date: ['o', 'sale.order', 'write_date'],
    },
  },
  'account.invoice.report': {
    requires: ['account.move.line', 'account.move'],
    from: `account_move_line l JOIN account_move m ON m.id = l.move_id LEFT JOIN product_product p ON p.id = l.product_id LEFT JOIN product_template tp ON tp.id = p.product_tmpl_id`,
    where: `coalesce(l.display_type, 'product') = 'product' AND m.move_type IN ('out_invoice', 'out_refund', 'in_invoice', 'in_refund', 'out_receipt', 'in_receipt')`,
    columns: {
      state: ['m', 'account.move', 'state'], move_type: ['m', 'account.move', 'move_type'], invoice_date: ['m', 'account.move', 'invoice_date'], invoice_date_due: ['m', 'account.move', 'invoice_date_due'],
      partner_id: ['m', 'account.move', 'partner_id'], invoice_user_id: ['m', 'account.move', 'invoice_user_id'], team_id: ['m', 'account.move', 'team_id'], source_id: ['m', 'account.move', 'source_id'],
      product_id: ['l', 'account.move.line', 'product_id'], product_categ_id: ['tp', 'product.template', 'categ_id'],
      price_subtotal: `CASE WHEN m.move_type IN ('out_refund', 'in_refund') THEN -coalesce(l.price_subtotal, 0) ELSE coalesce(l.price_subtotal, 0) END`,
      create_date: ['m', 'account.move', 'create_date'], write_date: ['m', 'account.move', 'write_date'], create_uid: ['m', 'account.move', 'create_uid'], write_uid: ['m', 'account.move', 'write_uid'],
    },
  },
  'purchase.report': {
    requires: ['purchase.order.line', 'purchase.order'],
    from: `purchase_order_line l JOIN purchase_order o ON o.id = l.order_id LEFT JOIN res_partner rp ON rp.id = o.partner_id LEFT JOIN product_product p ON p.id = l.product_id LEFT JOIN product_template tp ON tp.id = p.product_tmpl_id`,
    where: `coalesce(l.display_type, 'product') = 'product'`,
    columns: {
      state: ['o', 'purchase.order', 'state'], date_order: ['o', 'purchase.order', 'date_order'], date_approve: ['o', 'purchase.order', 'date_approve'], user_id: ['o', 'purchase.order', 'user_id'],
      partner_id: ['o', 'purchase.order', 'partner_id'], order_id: `o.id`, country_id: ['rp', 'res.partner', 'country_id'],
      untaxed_total: ['l', 'purchase.order.line', 'price_subtotal'], price_total: ['l', 'purchase.order.line', 'price_total'], product_id: ['l', 'purchase.order.line', 'product_id'], category_id: ['tp', 'product.template', 'categ_id'],
      create_date: ['o', 'purchase.order', 'create_date'], write_date: ['o', 'purchase.order', 'write_date'], create_uid: ['o', 'purchase.order', 'create_uid'], write_uid: ['o', 'purchase.order', 'write_uid'],
    },
  },
  'report.project.task.user': {
    requires: ['project.task'],
    from: `project_task t`,
    columns: {
      name: ['t', 'project.task', 'name'], project_id: ['t', 'project.task', 'project_id'], stage_id: ['t', 'project.task', 'stage_id'], partner_id: ['t', 'project.task', 'partner_id'], priority: ['t', 'project.task', 'priority'],
      is_closed: ['t', 'project.task', 'is_closed'], has_template_ancestor: ['t', 'project.task', 'has_template_ancestor'], has_project_template: ['t', 'project.task', 'has_project_template'],
      working_hours_open: ['t', 'project.task', 'working_hours_open'], working_hours_close: ['t', 'project.task', 'working_hours_close'], rating_avg: ['t', 'project.task', 'rating_avg'], nbr: `1`,
      create_date: ['t', 'project.task', 'create_date'], write_date: ['t', 'project.task', 'write_date'], create_uid: ['t', 'project.task', 'create_uid'], write_uid: ['t', 'project.task', 'write_uid'],
    },
  },
  'helpdesk.ticket.report.analysis': {
    requires: ['helpdesk.ticket'],
    from: `helpdesk_ticket h LEFT JOIN res_partner rp ON rp.id = h.partner_id`,
    columns: {
      name: ['h', 'helpdesk.ticket', 'name'], team_id: ['h', 'helpdesk.ticket', 'team_id'], stage_id: ['h', 'helpdesk.ticket', 'stage_id'], user_id: ['h', 'helpdesk.ticket', 'user_id'], partner_id: ['h', 'helpdesk.ticket', 'partner_id'],
      priority: ['h', 'helpdesk.ticket', 'priority'], kanban_state: ['h', 'helpdesk.ticket', 'kanban_state'], ticket_ref: ['h', 'helpdesk.ticket', 'ticket_ref'], sla_deadline: ['h', 'helpdesk.ticket', 'sla_deadline'],
      company_id: ['h', 'helpdesk.ticket', 'company_id'], active: ['h', 'helpdesk.ticket', 'active'], sale_order_id: ['h', 'helpdesk.ticket', 'sale_order_id'], close_date: ['h', 'helpdesk.ticket', 'close_date'],
      partner_email: `coalesce(h.partner_email, rp.email)`, partner_name: `coalesce(rp.name, h.partner_name)`, partner_phone: `coalesce(rp.phone, h.partner_phone)`,
      rating_avg: ['h', 'helpdesk.ticket', 'rating_avg'], first_response_hours: ['h', 'helpdesk.ticket', 'first_response_hours'], avg_response_hours: ['h', 'helpdesk.ticket', 'avg_response_hours'],
      ticket_close_hours: `CASE WHEN h.close_date IS NOT NULL THEN EXTRACT(EPOCH FROM (h.close_date - h.create_date)) / 3600.0 END`,
      ticket_open_hours: `EXTRACT(EPOCH FROM (coalesce(h.close_date, now()) - h.create_date)) / 3600.0`,
      ticket_assignation_hours: ['h', 'helpdesk.ticket', 'assign_hours'], ticket_deadline_hours: ['h', 'helpdesk.ticket', 'sla_deadline_hours'],
      create_date: ['h', 'helpdesk.ticket', 'create_date'], write_date: ['h', 'helpdesk.ticket', 'write_date'], create_uid: ['h', 'helpdesk.ticket', 'create_uid'], write_uid: ['h', 'helpdesk.ticket', 'write_uid'],
    },
  },
  'helpdesk.sla.report.analysis': {
    requires: ['helpdesk.ticket', 'helpdesk.sla.status'],
    from: `helpdesk_sla_status s JOIN helpdesk_ticket h ON h.id = s.ticket_id LEFT JOIN res_partner rp ON rp.id = h.partner_id`,
    columns: {
      name: ['h', 'helpdesk.ticket', 'name'], team_id: ['h', 'helpdesk.ticket', 'team_id'], stage_id: ['h', 'helpdesk.ticket', 'stage_id'], user_id: ['h', 'helpdesk.ticket', 'user_id'], partner_id: ['h', 'helpdesk.ticket', 'partner_id'],
      priority: ['h', 'helpdesk.ticket', 'priority'], kanban_state: ['h', 'helpdesk.ticket', 'kanban_state'], ticket_ref: ['h', 'helpdesk.ticket', 'ticket_ref'], sla_deadline: ['s', 'helpdesk.sla.status', 'deadline'],
      company_id: ['h', 'helpdesk.ticket', 'company_id'], active: ['h', 'helpdesk.ticket', 'active'], sale_order_id: ['h', 'helpdesk.ticket', 'sale_order_id'], close_date: ['h', 'helpdesk.ticket', 'close_date'],
      partner_email: `coalesce(h.partner_email, rp.email)`, partner_name: `coalesce(rp.name, h.partner_name)`, partner_phone: `coalesce(rp.phone, h.partner_phone)`,
      sla_id: ['s', 'helpdesk.sla.status', 'sla_id'], sla_status: ['s', 'helpdesk.sla.status', 'status'], sla_status_failed: `CASE WHEN s.status = 'failed' THEN 1 ELSE 0 END`, sla_exceeded_hours: ['s', 'helpdesk.sla.status', 'exceeded_hours'],
      rating_avg: ['h', 'helpdesk.ticket', 'rating_avg'], first_response_hours: ['h', 'helpdesk.ticket', 'first_response_hours'], avg_response_hours: ['h', 'helpdesk.ticket', 'avg_response_hours'],
      ticket_close_hours: `CASE WHEN h.close_date IS NOT NULL THEN EXTRACT(EPOCH FROM (h.close_date - h.create_date)) / 3600.0 END`,
      ticket_open_hours: `EXTRACT(EPOCH FROM (coalesce(h.close_date, now()) - h.create_date)) / 3600.0`,
      ticket_assignation_hours: ['h', 'helpdesk.ticket', 'assign_hours'],
      create_date: ['h', 'helpdesk.ticket', 'create_date'], write_date: ['h', 'helpdesk.ticket', 'write_date'], create_uid: ['h', 'helpdesk.ticket', 'create_uid'], write_uid: ['h', 'helpdesk.ticket', 'write_uid'],
    },
  },
  'planning.analysis.report': {
    requires: ['planning.slot'],
    from: `planning_slot s LEFT JOIN sale_order_line sol ON sol.id = s.sale_line_id`,
    columns: {
      start_datetime: ['s', 'planning.slot', 'start_datetime'], end_datetime: ['s', 'planning.slot', 'end_datetime'], allocated_hours: ['s', 'planning.slot', 'allocated_hours'], allocated_percentage: ['s', 'planning.slot', 'allocated_percentage'],
      role_id: ['s', 'planning.slot', 'role_id'], sale_line_id: ['s', 'planning.slot', 'sale_line_id'], sale_order_id: ['sol', 'sale.order.line', 'order_id'], partner_id: ['sol', 'sale.order.line', 'order_partner_id'],
      department_id: ['s', 'planning.slot', 'department_id'], manager_id: ['s', 'planning.slot', 'manager_id'], name: ['s', 'planning.slot', 'name'], request_to_switch: ['s', 'planning.slot', 'request_to_switch'],
      create_date: ['s', 'planning.slot', 'create_date'], write_date: ['s', 'planning.slot', 'write_date'], create_uid: ['s', 'planning.slot', 'create_uid'], write_uid: ['s', 'planning.slot', 'write_uid'],
    },
  },
  'planning.attendance.analysis.report': {
    requires: ['planning.slot', 'hr.attendance', 'hr.employee'],
    id: `row_number() OVER (ORDER BY x.employee_id, x.entry_date)`,
    from: `(SELECT employee_id, entry_date, sum(planned_hours) AS planned_hours, sum(effective_hours) AS effective_hours FROM (
              SELECT e.id AS employee_id, s.start_datetime::date AS entry_date, coalesce(s.allocated_hours, 0) AS planned_hours, 0::float8 AS effective_hours
                FROM planning_slot s JOIN hr_employee e ON e.resource_resource_id IS NOT DISTINCT FROM NULL OR e.id = e.id WHERE s.start_datetime IS NOT NULL AND FALSE
              UNION ALL
              SELECT a.employee_id, a.check_in::date, 0::float8, coalesce(a.worked_hours, 0) FROM hr_attendance a WHERE a.check_in IS NOT NULL
            ) rows GROUP BY employee_id, entry_date) x LEFT JOIN hr_employee e ON e.id = x.employee_id`,
    columns: {
      employee_id: `x.employee_id`, entry_date: `x.entry_date`, planned_hours: `x.planned_hours`, effective_hours: `x.effective_hours`, time_difference: `x.effective_hours - x.planned_hours`,
      department_id: ['e', 'hr.employee', 'department_id'], planned_costs: `x.planned_hours * coalesce(e.hourly_cost, 0)`, effective_costs: `x.effective_hours * coalesce(e.hourly_cost, 0)`,
      cost_difference: `(x.effective_hours - x.planned_hours) * coalesce(e.hourly_cost, 0)`,
    },
  },
  'hr.employee.skill.report': {
    requires: ['hr.employee.skill', 'hr.employee'],
    from: `hr_employee_skill es JOIN hr_employee e ON e.id = es.hr_employee_id LEFT JOIN hr_skill_level lvl ON lvl.id = es.skill_level_id`,
    where: `es.hr_employee_id IS NOT NULL`,
    columns: {
      employee_id: `es.hr_employee_id`, skill_type_id: ['es', 'hr.employee.skill', 'skill_type_id'], skill_id: ['es', 'hr.employee.skill', 'skill_id'], skill_level: ['lvl', 'hr.skill.level', 'name'],
      level_progress: `coalesce(es.level_progress, lvl.level_progress)`, department_id: ['e', 'hr.employee', 'department_id'], job_id: ['e', 'hr.employee', 'job_id'], active: ['e', 'hr.employee', 'active'],
      create_date: ['es', 'hr.employee.skill', 'create_date'], write_date: ['es', 'hr.employee.skill', 'write_date'], create_uid: ['es', 'hr.employee.skill', 'create_uid'], write_uid: ['es', 'hr.employee.skill', 'write_uid'],
    },
  },
  'fleet.vehicle.cost.report': {
    requires: ['fleet.vehicle.log.contract', 'fleet.vehicle.log.services', 'fleet.vehicle'],
    id: `row_number() OVER (ORDER BY x.cost_type, x.src_id)`,
    from: `(SELECT 'contract' AS cost_type, c.id AS src_id, c.vehicle_id, c.name, coalesce(c.start_date, c.date) AS date_start, coalesce(c.cost_generated, c.amount, 0)::float8 AS cost, NULL::integer AS service_type
              FROM fleet_vehicle_log_contract c
            UNION ALL
            SELECT 'service', s.id, s.vehicle_id, s.description, s.date_from, coalesce(s.amount, 0)::float8, s.service_type_id FROM fleet_vehicle_log_services s) x
           LEFT JOIN fleet_vehicle v ON v.id = x.vehicle_id`,
    columns: {
      cost_type: `x.cost_type`, vehicle_id: `x.vehicle_id`, name: `x.name`, date_start: `x.date_start`, cost: `x.cost`, service_type: `x.service_type`, driver_id: ['v', 'fleet.vehicle', 'driver_id'],
    },
  },
  'fleet.vehicle.odometer.report': {
    requires: ['fleet.vehicle.odometer', 'fleet.vehicle'],
    from: `fleet_vehicle_odometer o LEFT JOIN fleet_vehicle v ON v.id = o.vehicle_id`,
    columns: {
      odometer_value: ['o', 'fleet.vehicle.odometer', 'value'], recorded_date: ['o', 'fleet.vehicle.odometer', 'date'], vehicle_id: ['o', 'fleet.vehicle.odometer', 'vehicle_id'],
      mileage_delta: `coalesce(o.value, 0) - coalesce(lag(o.value) OVER (PARTITION BY o.vehicle_id ORDER BY o.date, o.id), 0)`,
      category_id: ['v', 'fleet.vehicle', 'category_id'], model_id: ['v', 'fleet.vehicle', 'model_id'], fuel_type: ['v', 'fleet.vehicle', 'fuel_type'],
      create_date: ['o', 'fleet.vehicle.odometer', 'create_date'], write_date: ['o', 'fleet.vehicle.odometer', 'write_date'], create_uid: ['o', 'fleet.vehicle.odometer', 'create_uid'], write_uid: ['o', 'fleet.vehicle.odometer', 'write_uid'],
    },
  },
};

/** True when `field` is a real column of `model` in the registry. */
function hasColumn(models: Record<string, ModelDef>, model: string, field: string): boolean {
  const def = models[model]?.fields[field];
  return Boolean(def && sqlTypeOf(def) && field !== 'display_name');
}

/** The models that are SQL views in this registry. */
export function sqlViewModels(): string[] {
  return Object.keys(defs);
}

/** `CREATE VIEW` body for a reporting model, or null when its sources are missing. */
export function sqlViewFor(model: string, models: Record<string, ModelDef>): string | null {
  const def = defs[model];
  const target = models[model];
  if (!def || !target || def.requires.some((name) => !models[name])) return null;
  const firstAlias = def.from.trim().split(/\s+/)[def.from.trim().startsWith('(') ? def.from.trim().split(/\s+/).findIndex((tok, i) => i > 0 && tok.endsWith(')')) + 1 : 1] ?? 't';
  const idExpr = def.id ?? `${firstAlias}."id"`;
  const selects = [`${idExpr}::integer AS "id"`];
  for (const field of Object.values(target.fields)) {
    if (field.name === 'id' || field.name === 'display_name') continue;
    const type = sqlTypeOf(field);
    if (!type) continue; // x2many / SQL-computed fields are not columns
    const spec = def.columns[field.name];
    let expr: string;
    if (spec === undefined) expr = `NULL::${type}`;
    else if (typeof spec === 'string') expr = spec;
    else expr = hasColumn(models, spec[1], spec[2]) ? `${spec[0]}.${quoteIdent(spec[2])}` : `NULL::${type}`;
    selects.push(`(${expr})::${type} AS ${quoteIdent(field.name)}`);
  }
  return `SELECT ${selects.join(', ')} FROM ${def.from}${def.where ? ` WHERE ${def.where}` : ''}`;
}

/** Attach the view SQL to every reporting model present in the registry. */
export function applySqlViews(models: Record<string, ModelDef>): void {
  for (const name of Object.keys(defs)) {
    const sql = sqlViewFor(name, models);
    if (sql && models[name]) models[name].sqlView = sql;
  }
  applyFieldSqlOverrides(models);
}

/**
 * Captured fields that are really per-user computations in Odoo: they
 * become SQL expressions so every user sees their own value (e.g. an
 * approver's status on a request), instead of a stored column shared by all.
 */
const FIELD_SQL: Record<string, Record<string, string>> = {
  'approval.request': {
    user_status: `(SELECT ap.status FROM approval_approver ap WHERE ap.approval_request_id = {alias}."id" AND ap.user_id = {uid} ORDER BY ap.sequence, ap.id LIMIT 1)`,
    has_access_to_request: `TRUE`,
  },
  'approval.approver': {
    can_edit: `TRUE`,
    can_edit_user_id: `({alias}.status IN ('new', 'pending', 'waiting'))`,
  },
  'knowledge.article': {
    is_user_favorite: `EXISTS (SELECT 1 FROM knowledge_article_favorite f WHERE f.article_id = {alias}."id" AND f.user_id = {uid})`,
    user_can_write: `TRUE`,
    user_permission: `'write'`,
  },
  'sign.request': {
    need_my_signature: `EXISTS (SELECT 1 FROM sign_request_item i JOIN res_users u ON u.partner_id = i.partner_id WHERE i.sign_request_id = {alias}."id" AND u.id = {uid} AND i.state = 'sent')`,
  },
  'planning.slot': {
    is_users_role: `TRUE`,
    can_edit: `TRUE`,
  },
  'hr.attendance': {
    is_manager: `EXISTS (SELECT 1 FROM hr_employee e JOIN hr_employee m ON m.id = e.parent_id WHERE e.id = {alias}.employee_id AND m.user_id = {uid})`,
    can_edit: `TRUE`,
  },
  // Dashboard counters (C-8.8): live numbers instead of columns nobody maintains.
  'helpdesk.team': {
    open_ticket_count: `(SELECT count(*) FROM helpdesk_ticket t LEFT JOIN helpdesk_stage s ON s.id = t.stage_id WHERE t.team_id = {alias}."id" AND coalesce(t.active, true) AND coalesce(s.fold, false) = false)`,
    unassigned_tickets: `(SELECT count(*) FROM helpdesk_ticket t LEFT JOIN helpdesk_stage s ON s.id = t.stage_id WHERE t.team_id = {alias}."id" AND coalesce(t.active, true) AND t.user_id IS NULL AND coalesce(s.fold, false) = false)`,
    urgent_ticket: `(SELECT count(*) FROM helpdesk_ticket t LEFT JOIN helpdesk_stage s ON s.id = t.stage_id WHERE t.team_id = {alias}."id" AND coalesce(t.active, true) AND t.priority = '3' AND coalesce(s.fold, false) = false)`,
    sla_failed: `(SELECT count(DISTINCT t.id) FROM helpdesk_ticket t JOIN helpdesk_sla_status st ON st.ticket_id = t.id WHERE t.team_id = {alias}."id" AND st.status = 'failed')`,
    ticket_closed: `(SELECT count(*) FROM helpdesk_ticket t WHERE t.team_id = {alias}."id" AND t.close_date >= now() - interval '7 days')`,
    success_rate: `coalesce((SELECT round(100.0 * sum(CASE WHEN st.status = 'reached' THEN 1 ELSE 0 END) / nullif(count(*), 0), 1) FROM helpdesk_sla_status st JOIN helpdesk_ticket t ON t.id = st.ticket_id WHERE t.team_id = {alias}."id" AND st.status IN ('reached', 'failed')), 0)`,
    rating_count: `(SELECT count(*) FROM rating_rating r WHERE r.res_model = 'helpdesk.ticket' AND r.res_id IN (SELECT id FROM helpdesk_ticket t WHERE t.team_id = {alias}."id"))`,
  },
  'approval.category': {
    request_to_validate_count: `(SELECT count(*) FROM approval_request r JOIN approval_approver a ON a.approval_request_id = r.id WHERE r.category_id = {alias}."id" AND r.request_status = 'pending' AND a.user_id = {uid} AND a.status = 'pending')`,
  },
  'project.project': {
    rating_count: `(SELECT count(*) FROM rating_rating r WHERE r.parent_res_model = 'project.project' AND r.parent_res_id = {alias}."id")`,
    is_favorite: `EXISTS (SELECT 1 FROM project_project_favorite_user_ids_rel f WHERE f.project_project_id = {alias}."id" AND f.res_users_id = {uid})`,
  },
  'crm.team': {
    invoiced: `coalesce((SELECT sum(m.amount_untaxed_signed) FROM account_move m WHERE m.team_id = {alias}."id" AND m.state = 'posted' AND m.move_type IN ('out_invoice', 'out_refund') AND date_trunc('month', coalesce(m.invoice_date, m.date)) = date_trunc('month', CURRENT_DATE)), 0)`,
    quotations_count: `(SELECT count(*) FROM sale_order o WHERE o.team_id = {alias}."id" AND o.state IN ('draft', 'sent'))`,
    quotations_amount: `coalesce((SELECT sum(o.amount_untaxed) FROM sale_order o WHERE o.team_id = {alias}."id" AND o.state IN ('draft', 'sent')), 0)`,
    sales_to_invoice_count: `(SELECT count(*) FROM sale_order o WHERE o.team_id = {alias}."id" AND o.state = 'sale' AND o.invoice_status = 'to invoice')`,
  },
};

export function applyFieldSqlOverrides(models: Record<string, ModelDef>): void {
  // Every table the schema will have: model tables and many2many relation tables.
  const known = new Set<string>();
  for (const m of Object.values(models)) {
    known.add(m.table);
    for (const f of Object.values(m.fields)) if (f.m2mTable) known.add(f.m2mTable);
  }
  for (const [model, fields] of Object.entries(FIELD_SQL)) {
    const def = models[model];
    if (!def) continue;
    for (const [name, sql] of Object.entries(fields)) {
      const field = def.fields[name];
      if (!field) continue;
      // Tables the expression needs must exist in this registry.
      const tables = [...sql.matchAll(/FROM ([a-z_]+)/g)].map((m) => m[1]);
      if (tables.some((table) => !known.has(table))) continue;
      field.sqlExpr = sql;
      field.readonly = true;
      field.store = false;
    }
  }
}
