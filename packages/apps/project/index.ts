import { registerModelHooks, type Values } from '../../engine/orm/hooks.js';
import type { Environment } from '../../engine/orm/env.js';
import { UserError } from '../../engine/orm/errors.js';
import { nextByCode } from '../../engine/orm/sequence.js';
import { addDays, ensureSequence, m2o, note, notify, now, openRecords, today, windowAction } from '../common.js';

/**
 * D-5 / D-6 — Project, To-do and Helpdesk: stages and states of tasks
 * (closing stages close the task, personal stages for private to-dos,
 * "Convert to Task"), project smart buttons and templates; ticket
 * numbering (#1, #2…), assignment, closing, SLA deadlines and statuses,
 * team dashboards.
 */

function doneState(env: Environment): string {
  const values = env.registry.models['project.task']?.fields.state?.selection?.map((s) => s.value) ?? [];
  return values.find((v) => /done/.test(v)) ?? '1_done';
}
function progressState(env: Environment): string {
  const values = env.registry.models['project.task']?.fields.state?.selection?.map((s) => s.value) ?? [];
  return values.find((v) => /in_progress/.test(v)) ?? '01_in_progress';
}

async function stageFold(env: Environment, model: string, stageId: number | false): Promise<boolean> {
  if (!stageId) return false;
  const table = model === 'project.task' ? 'project_task_type' : 'helpdesk_stage';
  const row = await env.cr.query<{ fold: boolean | null }>(`SELECT fold FROM ${table} WHERE id = $1`, [stageId]);
  return Boolean(row.rows[0]?.fold);
}

/* ---------- helpdesk SLA ---------- */

async function applySla(env: Environment, ticketId: number): Promise<void> {
  if (!env.registry.models['helpdesk.sla'] || !env.registry.models['helpdesk.sla.status']) return;
  const [ticket] = await env.model('helpdesk.ticket').read(ticketId, ['team_id', 'stage_id', 'create_date', 'priority', 'sla_status_ids']);
  const teamId = m2o(ticket.team_id);
  if (!teamId) return;
  const policies = await env.model('helpdesk.sla').searchRead([['team_id', '=', teamId]], ['stage_id', 'time', 'exclude_stage_ids', 'name']);
  const existing = await env.model('helpdesk.sla.status').searchRead([['ticket_id', '=', ticketId]], ['sla_id', 'status', 'deadline', 'reached_datetime']);
  const created = String(ticket.create_date ?? now()).replace('T', ' ').slice(0, 19);
  const stageId = m2o(ticket.stage_id);
  let earliest: string | null = null;
  for (const policy of policies) {
    const deadlineMs = Date.parse(`${created.replace(' ', 'T')}Z`) + Number(policy.time ?? 0) * 3_600_000;
    const deadline = new Date(deadlineMs).toISOString().slice(0, 19).replace('T', ' ');
    const targetStage = m2o(policy.stage_id);
    // Reached when the ticket is at (or past, by sequence) the target stage.
    let reached = false;
    if (stageId && targetStage) {
      const seq = await env.cr.query<{ id: number; sequence: number }>(`SELECT id, sequence FROM helpdesk_stage WHERE id = ANY($1)`, [[stageId, targetStage]]);
      const current = seq.rows.find((r) => Number(r.id) === stageId)?.sequence ?? 0; const target = seq.rows.find((r) => Number(r.id) === targetStage)?.sequence ?? 0;
      reached = stageId === targetStage || current > target;
    }
    const status = reached ? (Date.now() > deadlineMs ? 'failed' : 'reached') : Date.now() > deadlineMs ? 'failed' : 'ongoing';
    const row = existing.find((e) => m2o(e.sla_id) === policy.id);
    const vals: Values = { ticket_id: ticketId, sla_id: policy.id, sla_stage_id: targetStage || false, deadline, status, reached_datetime: reached ? (row?.reached_datetime || now()) : false, exceeded_hours: status === 'failed' ? Math.round((Date.now() - deadlineMs) / 36_000) / 100 : 0 };
    if (row) await env.model('helpdesk.sla.status').write(row.id as number, vals); else await env.model('helpdesk.sla.status').create(vals);
    if (!reached && (!earliest || deadline < earliest)) earliest = deadline;
  }
  await env.cr.query(`UPDATE helpdesk_ticket SET sla_deadline = $2 WHERE id = $1`, [ticketId, earliest]).catch(() => undefined);
}

export function registerProject(): void {
  registerModelHooks('project.project', {
    defaults: (env) => ({ active: true, company_id: env.companyId, user_id: env.uid, privacy_visibility: 'employees', allow_milestones: true, allow_recurring_tasks: false, allow_task_dependencies: false, last_update_status: 'to_define', label_tasks: 'Tasks', date_start: today(), sequence: 10, color: 0 }),
    tracked: ['user_id', 'partner_id', 'last_update_status', 'date'],
    creationMessage: { en: 'Project created', ar: 'تم إنشاء المشروع' },
    onCreate: async (env, ids) => {
      // Every project gets the standard stages unless it already has some.
      if (!env.registry.models['project.task.type']) return;
      const rel = env.registry.models['project.task.type'].fields.project_ids;
      if (!rel?.m2mTable) return;
      for (const id of ids) {
        const has = await env.cr.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${rel.m2mTable}" WHERE "${rel.m2mColumn2}" = $1`, [id]);
        if (has.rows[0]?.n) continue;
        const stages = await env.cr.query<{ id: number }>(`SELECT id FROM project_task_type WHERE coalesce(active, true) AND user_id IS NULL ORDER BY sequence, id LIMIT 6`);
        for (const s of stages.rows) await env.cr.query(`INSERT INTO "${rel.m2mTable}" ("${rel.m2mColumn1}", "${rel.m2mColumn2}") VALUES ($1, $2) ON CONFLICT DO NOTHING`, [s.id, id]);
      }
    },
    methods: {
      action_view_tasks: async (_env, ids) => windowAction('project.task', { en: 'Tasks', ar: 'المهام' }, { domain: [['project_id', 'in', ids]], viewMode: 'kanban,list,form,calendar,pivot,graph,activity', context: { default_project_id: ids[0] } }),
      action_view_sos: async (env, ids) => { const [p] = await env.model('project.project').read(ids[0], ['sale_order_id', 'reinvoiced_sale_order_id']); const so = [m2o(p.sale_order_id), m2o(p.reinvoiced_sale_order_id)].filter(Boolean) as number[]; return windowAction('sale.order', { en: 'Sales Orders', ar: 'أوامر البيع' }, { domain: ['|', ['id', 'in', so], ['order_line.task_id.project_id', 'in', ids]] }); },
      action_view_sols: async (_env, ids) => windowAction('sale.order.line', { en: 'Sales Order Items', ar: 'بنود أوامر البيع' }, { domain: [['order_id.project_id', 'in', ids]], viewMode: 'list' }),
      action_real_margin: async (_env, ids) => windowAction('account.analytic.line', { en: 'Margins', ar: 'الهوامش' }, { domain: [['account_id.name', 'in', []]], viewMode: 'pivot,graph,list', context: { search_default_project_id: ids[0] } }),
      project_update_all_action: async (_env, ids) => windowAction('project.update', { en: 'Updates', ar: 'التحديثات' }, { domain: [['project_id', 'in', ids]], viewMode: 'kanban,list,form', context: { default_project_id: ids[0] } }),
      action_open_project_invoices: async (_env, ids) => windowAction('account.move', { en: 'Invoices', ar: 'الفواتير' }, { domain: [['move_type', 'in', ['out_invoice', 'out_refund']], ['invoice_origin', 'in', []]], context: { default_move_type: 'out_invoice', search_default_project: ids[0] } }),
      action_open_project_vendor_bills: async (_env, ids) => windowAction('account.move', { en: 'Vendor Bills', ar: 'فواتير الموردين' }, { domain: [['move_type', 'in', ['in_invoice', 'in_refund']], ['purchase_id.project_id', 'in', ids]], context: { default_move_type: 'in_invoice' } }),
      action_open_project_purchase_orders: async (_env, ids) => windowAction('purchase.order', { en: 'Purchase Orders', ar: 'أوامر الشراء' }, { domain: [['project_id', 'in', ids]] }),
      action_open_project_assets: async (_env, ids) => windowAction('account.asset', { en: 'Assets', ar: 'الأصول' }, { domain: [['id', 'in', []]], context: { search_default_project: ids[0] } }),
      action_open_documents: async (_env, ids) => windowAction('ir.attachment', { en: 'Documents', ar: 'المستندات' }, { domain: ['|', '&', ['res_model', '=', 'project.project'], ['res_id', 'in', ids], '&', ['res_model', '=', 'project.task'], ['res_id', 'in', []]], viewMode: 'kanban,list' }),
      action_project_task_burndown_chart_report: async (_env, ids) => windowAction('project.task', { en: 'Burndown Chart', ar: 'مخطط الإنجاز' }, { domain: [['project_id', 'in', ids]], viewMode: 'graph,pivot', context: { graph_groupbys: ['date_deadline:week', 'stage_id'] } }),
      action_view_all_rating: async (_env, ids) => windowAction('rating.rating', { en: 'Ratings', ar: 'التقييمات' }, { domain: [['parent_res_model', '=', 'project.project'], ['parent_res_id', 'in', ids]], viewMode: 'kanban,list,graph' }),
      action_customer_preview: async (_env, ids) => notify({ en: `The customer portal for project ${ids[0]} is not published yet.`, ar: `لم يتم نشر بوابة العملاء للمشروع ${ids[0]} بعد.` }, 'info'),
    },
  });

  registerModelHooks('project.task', {
    defaults: (env) => ({ active: true, company_id: env.companyId, priority: '0', state: progressState(env), sequence: 10, allocated_hours: 0, display_in_project: true, color: 0 }),
    tracked: ['stage_id', 'state', 'user_ids', 'date_deadline', 'project_id'],
    creationMessage: { en: 'Task created', ar: 'تم إنشاء المهمة' },
    searchFields: ['description'],
    beforeCreate: async (env, vals) => {
      const out = { ...vals };
      const projectId = m2o(out.project_id);
      if (projectId && !m2o(out.stage_id)) {
        const rel = env.registry.models['project.task.type']?.fields.project_ids;
        const stage = rel?.m2mTable ? await env.cr.query<{ id: number }>(`SELECT t.id FROM project_task_type t JOIN "${rel.m2mTable}" r ON r."${rel.m2mColumn1}" = t.id WHERE r."${rel.m2mColumn2}" = $1 ORDER BY t.sequence, t.id LIMIT 1`, [projectId]) : { rows: [] as { id: number }[] };
        if (stage.rows[0]) out.stage_id = Number(stage.rows[0].id);
      }
      if (!projectId && !m2o(out.personal_stage_type_id) && env.registry.models['project.task.type']) {
        // Private to-dos live in the user's personal stages (Inbox first).
        const personal = await env.cr.query<{ id: number }>(`SELECT id FROM project_task_type WHERE user_id = $1 ORDER BY sequence, id LIMIT 1`, [env.uid]);
        if (personal.rows[0]) out.personal_stage_type_id = Number(personal.rows[0].id);
        else {
          const any = await env.cr.query<{ id: number }>(`SELECT id FROM project_task_type WHERE user_id IS NOT NULL ORDER BY sequence, id LIMIT 1`);
          if (any.rows[0]) out.personal_stage_type_id = Number(any.rows[0].id);
        }
      }
      if (m2o(out.stage_id)) out.date_last_stage_update = now();
      return out;
    },
    beforeWrite: async (env, ids, vals) => {
      const out = { ...vals };
      if ('stage_id' in out) {
        out.date_last_stage_update = now();
        const folded = await stageFold(env, 'project.task', m2o(out.stage_id));
        if (folded) { out.state = doneState(env); out.date_end = now(); out.is_closed = true; }
        else if (out.state === undefined) { out.is_closed = false; out.date_end = false; }
      }
      if ('state' in out) {
        const closed = String(out.state).startsWith('1_');
        out.is_closed = closed;
        if (closed && !out.date_end) out.date_end = now();
        if (!closed) out.date_end = false;
      }
      if ('user_ids' in out && !out.date_assign) out.date_assign = now();
      return out;
    },
    methods: {
      action_convert_to_task: async (env, ids) => windowAction('project.task', { en: 'Convert to Task', ar: 'تحويل إلى مهمة' }, { resId: ids[0], viewMode: 'form', context: { form_view_ref: 'project.view_task_form2' } }),
      action_open_parent_task: async (env, ids) => { const [t] = await env.model('project.task').read(ids[0], ['parent_id']); const pid = m2o(t.parent_id); return pid ? windowAction('project.task', { en: 'Parent Task', ar: 'المهمة الأصلية' }, { resId: pid }) : notify({ en: 'This task has no parent task.', ar: 'ليس لهذه المهمة مهمة أصلية.' }, 'info'); },
      action_open_subtasks: async (_env, ids) => windowAction('project.task', { en: 'Sub-tasks', ar: 'المهام الفرعية' }, { domain: [['parent_id', 'in', ids]], viewMode: 'kanban,list,form', context: { default_parent_id: ids[0] } }),
      action_view_so: async (env, ids) => { const [t] = await env.model('project.task').read(ids[0], ['sale_order_id', 'sale_line_id']); const so = m2o(t.sale_order_id); return so ? windowAction('sale.order', { en: 'Sales Order', ar: 'أمر البيع' }, { resId: so }) : notify({ en: 'No sales order is linked to this task.', ar: 'لا يوجد أمر بيع مرتبط بهذه المهمة.' }, 'info'); },
      action_open_ratings: async (_env, ids) => windowAction('rating.rating', { en: 'Ratings', ar: 'التقييمات' }, { domain: [['res_model', '=', 'project.task'], ['res_id', 'in', ids]], viewMode: 'kanban,list' }),
      action_open_documents: async (_env, ids) => windowAction('ir.attachment', { en: 'Documents', ar: 'المستندات' }, { domain: [['res_model', '=', 'project.task'], ['res_id', 'in', ids]], viewMode: 'kanban,list' }),
      action_assign_to_me: async (env, ids) => { for (const id of ids) await env.model('project.task').write(id, { user_ids: [[4, env.uid]] }); },
    },
  });

  registerModelHooks('project.task.type', { defaults: () => ({ sequence: 10, fold: false, active: true, auto_validation_state: false }) });

  /* ---------- Helpdesk (D-6) ---------- */

  registerModelHooks('helpdesk.ticket', {
    defaults: async (env) => {
      const team = await env.cr.query<{ id: number }>(`SELECT id FROM helpdesk_team WHERE coalesce(active, true) ORDER BY sequence, id LIMIT 1`).catch(() => ({ rows: [] as { id: number }[] }));
      return { active: true, company_id: env.companyId, priority: '0', kanban_state: 'normal', team_id: team.rows[0]?.id ?? false, use_sla: true, use_rating: true };
    },
    tracked: ['stage_id', 'user_id', 'team_id', 'priority', 'kanban_state'],
    creationMessage: { en: 'Ticket created', ar: 'تم إنشاء التذكرة' },
    searchFields: ['ticket_ref', 'partner_email', 'description'],
    displayName: (_env, record) => String(record.ticket_ref ? `${record.name} (#${record.ticket_ref})` : record.name ?? ''),
    displayNameFields: ['name', 'ticket_ref'],
    beforeCreate: async (env, vals) => {
      const out = { ...vals };
      await ensureSequence(env, 'helpdesk.ticket', '', 1);
      if (!out.ticket_ref) out.ticket_ref = String(Number(await nextByCode(env, 'helpdesk.ticket')));
      const teamId = m2o(out.team_id);
      if (teamId && !m2o(out.stage_id)) {
        const rel = env.registry.models['helpdesk.stage']?.fields.team_ids;
        const stage = rel?.m2mTable ? await env.cr.query<{ id: number }>(`SELECT s.id FROM helpdesk_stage s JOIN "${rel.m2mTable}" r ON r."${rel.m2mColumn1}" = s.id WHERE r."${rel.m2mColumn2}" = $1 ORDER BY s.sequence, s.id LIMIT 1`, [teamId]) : { rows: [] as { id: number }[] };
        const fallback = stage.rows[0] ? null : await env.cr.query<{ id: number }>(`SELECT id FROM helpdesk_stage WHERE coalesce(active, true) ORDER BY sequence, id LIMIT 1`);
        out.stage_id = stage.rows[0]?.id ?? fallback?.rows[0]?.id ?? false;
      }
      const partnerId = m2o(out.partner_id);
      if (partnerId && (!out.partner_email || !out.partner_name)) {
        const p = await env.cr.query<{ name: string; email: string | null; phone: string | null }>(`SELECT name, email, phone FROM res_partner WHERE id = $1`, [partnerId]);
        if (p.rows[0]) { out.partner_name ??= p.rows[0].name; out.partner_email ??= p.rows[0].email ?? false; out.partner_phone ??= p.rows[0].phone ?? false; }
      }
      // Auto-assignment: the team's members in turn.
      if (teamId && !m2o(out.user_id)) {
        const team = await env.cr.query<{ auto: boolean | null; method: string | null }>(`SELECT auto_assignment AS auto, assign_method AS method FROM helpdesk_team WHERE id = $1`, [teamId]);
        const rel = env.registry.models['helpdesk.team']?.fields.member_ids;
        if (team.rows[0]?.auto && rel?.m2mTable) {
          const members = await env.cr.query<{ uid: number; n: number }>(`SELECT r."${rel.m2mColumn2}" AS uid, (SELECT count(*) FROM helpdesk_ticket t JOIN helpdesk_stage s ON s.id = t.stage_id WHERE t.user_id = r."${rel.m2mColumn2}" AND coalesce(s.fold, false) = false)::int AS n FROM "${rel.m2mTable}" r WHERE r."${rel.m2mColumn1}" = $1 ORDER BY n, uid`, [teamId]);
          if (members.rows[0]) out.user_id = team.rows[0].method === 'randomly' ? Number(members.rows[Math.floor(Math.random() * members.rows.length)].uid) : Number(members.rows[0].uid);
        }
      }
      return out;
    },
    onCreate: async (env, ids) => { for (const id of ids) await applySla(env, id); },
    beforeWrite: async (env, ids, vals) => {
      const out = { ...vals };
      if ('stage_id' in out) {
        const folded = await stageFold(env, 'helpdesk.ticket', m2o(out.stage_id));
        out.close_date = folded ? now() : false;
        if (folded) out.kanban_state = 'done';
      }
      if ('user_id' in out && m2o(out.user_id)) {
        for (const id of ids) {
          const [t] = await env.model('helpdesk.ticket').read(id, ['create_date']);
          const hours = Math.round(Math.max(0, (Date.now() - Date.parse(String(t.create_date).replace(' ', 'T') + 'Z')) / 36_000)) / 100;
          await env.cr.query(`UPDATE helpdesk_ticket SET assign_hours = coalesce(assign_hours, $2) WHERE id = $1`, [id, hours]).catch(() => undefined);
        }
      }
      return out;
    },
    onWrite: async (env, ids, vals) => {
      if ('stage_id' in vals || 'team_id' in vals || 'priority' in vals) for (const id of ids) await applySla(env, id);
      if ('stage_id' in vals) for (const id of ids) {
        const [t] = await env.model('helpdesk.ticket').read(id, ['close_date', 'create_date']);
        if (t.close_date) await env.cr.query(`UPDATE helpdesk_ticket SET close_hours = $2 WHERE id = $1`, [id, Math.round((Date.parse(String(t.close_date).replace(' ', 'T') + 'Z') - Date.parse(String(t.create_date).replace(' ', 'T') + 'Z')) / 36_000) / 100]).catch(() => undefined);
      }
    },
    methods: {
      action_open_helpdesk_ticket: async (env, ids) => { const [t] = await env.model('helpdesk.ticket').read(ids[0], ['partner_id']); return windowAction('helpdesk.ticket', { en: 'Tickets', ar: 'التذاكر' }, { domain: [['partner_id', '=', m2o(t.partner_id) || 0]], viewMode: 'kanban,list,form' }); },
      assign_ticket_to_self: async (env, ids) => { await env.model('helpdesk.ticket').write(ids, { user_id: env.uid }); },
      action_assign_to_me: async (env, ids) => { await env.model('helpdesk.ticket').write(ids, { user_id: env.uid }); },
    },
  });
  registerModelHooks('helpdesk.team', {
    defaults: (env) => ({ active: true, company_id: env.companyId, sequence: 10, use_sla: true, use_rating: true, auto_assignment: false, assign_method: 'randomly', privacy_visibility: 'internal' }),
    methods: {
      action_view_open_ticket_view: async (_env, ids) => windowAction('helpdesk.ticket', { en: 'Tickets', ar: 'التذاكر' }, { domain: [['team_id', 'in', ids], ['stage_id.fold', '=', false]], viewMode: 'kanban,list,form', context: { default_team_id: ids[0] } }),
      action_view_sla_policy: async (_env, ids) => windowAction('helpdesk.sla', { en: 'SLA Policies', ar: 'سياسات اتفاقية مستوى الخدمة' }, { domain: [['team_id', 'in', ids]], context: { default_team_id: ids[0] } }),
      action_view_all_tickets: async (_env, ids) => windowAction('helpdesk.ticket', { en: 'Tickets', ar: 'التذاكر' }, { domain: [['team_id', 'in', ids]], viewMode: 'kanban,list,form', context: { default_team_id: ids[0] } }),
      action_unassigned_tickets: async (_env, ids) => windowAction('helpdesk.ticket', { en: 'Unassigned Tickets', ar: 'التذاكر غير المسندة' }, { domain: [['team_id', 'in', ids], ['user_id', '=', false], ['stage_id.fold', '=', false]], viewMode: 'kanban,list,form' }),
      action_urgent_tickets: async (_env, ids) => windowAction('helpdesk.ticket', { en: 'Urgent Tickets', ar: 'التذاكر العاجلة' }, { domain: [['team_id', 'in', ids], ['priority', '=', '3'], ['stage_id.fold', '=', false]], viewMode: 'kanban,list,form' }),
      action_view_failed_sla: async (_env, ids) => windowAction('helpdesk.ticket', { en: 'Failed SLA', ar: 'اتفاقيات مستوى خدمة فاشلة' }, { domain: [['team_id', 'in', ids], ['sla_status_ids.status', '=', 'failed']], viewMode: 'kanban,list,form' }),
    },
  });
  registerModelHooks('helpdesk.stage', { defaults: () => ({ sequence: 10, fold: false, active: true, rotting_threshold_days: 0 }), methods: { action_open_helpdesk_ticket: async (_env, ids) => windowAction('helpdesk.ticket', { en: 'Tickets', ar: 'التذاكر' }, { domain: [['stage_id', 'in', ids]], viewMode: 'kanban,list,form' }) } });
  registerModelHooks('helpdesk.sla', { defaults: (env) => ({ active: true, company_id: env.companyId, time: 8 }), methods: { action_open_helpdesk_ticket: async (_env, ids) => windowAction('helpdesk.ticket', { en: 'Tickets', ar: 'التذاكر' }, { domain: [['sla_status_ids.sla_id', 'in', ids]], viewMode: 'kanban,list,form' }) } });
  registerModelHooks('helpdesk.sla.status', { defaults: () => ({ status: 'ongoing' }) });
  void addDays; void openRecords; void UserError;
}
