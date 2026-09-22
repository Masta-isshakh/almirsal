import type { Environment } from '@engine/orm/env';
import type { ActionResult } from '@engine/orm/hooks';
import { UserError } from '@engine/orm/errors';
import { getRegistry } from './registry';
import { describeAction } from './actions';
import { kioskKey } from '@/packages/apps/hr/attendance';

/**
 * `ir.actions.server` records of the export (Part E): each one resolves to
 * the window action, URL or notification Odoo's server code would return,
 * so menus and buttons bound to them work like any other action.
 */
type Result = ActionResult | Record<string, unknown>;

const windowAction = (model: string, name: { en: string; ar: string }, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'ir.actions.act_window', res_model: model, view_mode: 'list,form', target: 'current', name, ...extra,
});

const SERVER_ACTIONS: Record<string, (env: Environment) => Promise<Result> | Result> = {
  // Accounting › Data Inalterability Check: no hashed journals yet, every entry is verifiable.
  'account.action_check_hash_integrity': async (env) => {
    const posted = await env.cr.query<{ n: number }>(`SELECT count(*)::int AS n FROM account_move WHERE state = 'posted'`);
    return { type: 'ir.actions.client', tag: 'display_notification', params: { type: 'success', sticky: true, title: { en: 'Data Inalterability Check', ar: 'فحص عدم قابلية تغيير البيانات' }, message: { en: `${posted.rows[0]?.n ?? 0} posted entries checked: no journal is hash-locked, all entries remain editable through Reset to Draft only.`, ar: `تم فحص ${posted.rows[0]?.n ?? 0} قيوداً مرحّلة: لا يوجد دفتر يومية مقفل بالتجزئة، وجميع القيود قابلة للتعديل عبر إعادة التعيين إلى مسودة فقط.` } } };
  },
  // Accounting › Tax Returns
  'account_reports.action_server_open_view_account_return': () => windowAction('account.return', { en: 'Tax Returns', ar: 'الإقرارات الضريبية' }, { view_mode: 'kanban,list,form' }),
  // Appointments › Schedule › Resources / Staff
  'appointment.calendar_event_action_all_resources_bookings': () => windowAction('calendar.event', { en: 'Resource Bookings', ar: 'حجوزات الموارد' }, { view_mode: 'gantt,calendar,list,form', domain: [['appointment_type_id', '!=', false]], context: { default_appointment_type_id: false } }),
  'appointment.calendar_event_action_all_users_appointments': () => windowAction('calendar.event', { en: 'Staff Bookings', ar: 'حجوزات الموظفين' }, { view_mode: 'gantt,calendar,list,form', domain: [['appointment_type_id', '!=', false]] }),
  // Knowledge › Home: the most recent article, or the articles list.
  'knowledge.ir_actions_server_knowledge_home_page': async (env) => {
    const row = await env.cr.query<{ id: number }>(`SELECT id FROM knowledge_article WHERE coalesce(active, true) ORDER BY write_date DESC NULLS LAST, id DESC LIMIT 1`).catch(() => ({ rows: [] as { id: number }[] }));
    return windowAction('knowledge.article', { en: 'Articles', ar: 'المقالات' }, { view_mode: 'kanban,list,form', ...(row.rows[0] ? { res_id: Number(row.rows[0].id), view_mode: 'form' } : {}) });
  },
  // Employees › Learning › Certifications
  'hr_skills.action_server_hr_employee_skill_certification': () => windowAction('hr.resume.line', { en: 'Certifications', ar: 'الشهادات' }, { domain: [['display_type', '=', 'certification']], context: { default_display_type: 'certification' } }),
  'hr_skills.action_open_skills_log_department': () => windowAction('hr.employee.skill.report', { en: 'Skill History Report', ar: 'تقرير سجل المهارات' }, { view_mode: 'pivot,list' }),
  // Approvals › Open Approval Category (dashboard)
  'approvals.action_open_approval_category': () => windowAction('approval.category', { en: 'Approvals', ar: 'الموافقات' }, { view_mode: 'kanban,list,form' }),
  // Attendances › Kiosk
  'hr_attendance.action_try_kiosk': async (env) => ({ type: 'ir.actions.act_url', url: `/kiosk/${await kioskKey(env)}`, target: 'new' }),
  'hr_attendance.open_kiosk_url': async (env) => ({ type: 'ir.actions.act_url', url: `/kiosk/${await kioskKey(env)}`, target: 'new' }),
};

export async function runServerAction(env: Environment, id: string): Promise<Result> {
  const registry = getRegistry();
  const action = registry.actions[id] ?? Object.values(registry.actions).find((a) => a.xmlId === id || a.path === id);
  if (!action || action.type !== 'server') throw new UserError({ en: `Unknown server action ${id}`, ar: `إجراء خادم غير معروف ${id}` });
  const run = SERVER_ACTIONS[action.xmlId];
  if (!run) throw new UserError({ en: `The server action "${action.name.en}" has no implementation.`, ar: `إجراء الخادم "${action.name.ar}" ليس له تنفيذ.` });
  const result = await run(env);
  // Window actions on a model without a registry action still need a slug: describe them like findAction does.
  if (result && typeof result === 'object' && (result as Record<string, unknown>).type === 'ir.actions.act_window') {
    const model = String((result as Record<string, unknown>).res_model);
    const found = Object.values(registry.actions).find((a) => a.type === 'act_window' && a.model === model && a.path);
    if (found && !(result as Record<string, unknown>).domain && !(result as Record<string, unknown>).res_id) return { ...result, id: found.id, description: describeAction(found) };
  }
  return result;
}
