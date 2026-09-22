import { registerModelHooks } from '../../engine/orm/hooks.js';
import type { Environment } from '../../engine/orm/env.js';
import { UserError } from '../../engine/orm/errors.js';
import { m2o, note, notify, now, today, urlAction, windowAction } from '../common.js';

/**
 * D-8 — Employees & Attendances: employee ↔ user link, badges, departures,
 * departments, check-in / check-out (systray, kiosk and manual entries)
 * with worked and overtime hours, overtime approval, and the employee
 * form's smart buttons that the generic resolver cannot infer.
 */

function hoursBetween(a: string, b: string): number {
  return Math.max(0, (Date.parse(b.replace(' ', 'T') + 'Z') - Date.parse(a.replace(' ', 'T') + 'Z')) / 3_600_000);
}

async function expectedHours(env: Environment, employeeId: number): Promise<number> {
  const row = await env.cr.query<{ h: number | null }>(`SELECT hours_per_day::float8 AS h FROM hr_employee WHERE id = $1`, [employeeId]).catch(() => ({ rows: [] as { h: number | null }[] }));
  return row.rows[0]?.h || 8;
}

/** Fill worked / overtime hours of attendances with both stamps. */
export async function refreshAttendance(env: Environment, ids: number[]): Promise<void> {
  const rows = await env.model('hr.attendance').read(ids, ['check_in', 'check_out', 'employee_id']);
  for (const row of rows) {
    if (!row.check_in || !row.check_out) continue;
    const worked = Math.round(hoursBetween(String(row.check_in), String(row.check_out)) * 100) / 100;
    const expected = await expectedHours(env, m2o(row.employee_id) || 0);
    const overtime = Math.max(0, Math.round((worked - expected) * 100) / 100);
    await env.cr.query(`UPDATE hr_attendance SET worked_hours = $2, overtime_hours = $3, expected_hours = $4 WHERE id = $1`, [row.id, worked, overtime, expected]);
  }
}

/** Check the employee in or out (systray / kiosk): returns the attendance and the new state. */
export async function toggleAttendance(env: Environment, employeeId: number, mode: 'systray' | 'kiosk' | 'manual', geo?: { latitude?: number; longitude?: number }): Promise<{ id: number; state: 'checked_in' | 'checked_out' }> {
  const open = await env.model('hr.attendance').search([['employee_id', '=', employeeId], ['check_out', '=', false]], { limit: 1, order: 'check_in desc' });
  if (open.length) {
    await env.model('hr.attendance').write(open[0], { check_out: now(), out_mode: mode, out_latitude: geo?.latitude ?? false, out_longitude: geo?.longitude ?? false });
    await refreshAttendance(env, open);
    await env.cr.query(`UPDATE hr_employee SET attendance_state = 'checked_out' WHERE id = $1`, [employeeId]).catch(() => undefined);
    return { id: open[0], state: 'checked_out' };
  }
  const id = await env.model('hr.attendance').create({ employee_id: employeeId, check_in: now(), in_mode: mode, in_latitude: geo?.latitude ?? false, in_longitude: geo?.longitude ?? false, overtime_status: 'to_approve' });
  await env.cr.query(`UPDATE hr_employee SET attendance_state = 'checked_in' WHERE id = $1`, [employeeId]).catch(() => undefined);
  return { id, state: 'checked_in' };
}

export function registerHr(): void {
  registerModelHooks('hr.employee', {
    defaults: (env) => ({ active: true, company_id: env.companyId, attendance_state: 'checked_out', hours_per_day: 8, hours_per_week: 40, marital: 'single', distance_home_work_unit: 'kilometers', tz: env.tz, hr_responsible_id: env.uid }),
    onCreate: async (env, ids) => {
      // The current employee record (hr.version) Odoo computes; one per employee at creation.
      if (!env.registry.models['hr.version']) return;
      for (const id of ids) {
        const version = await env.model('hr.version').create({ employee_id: id, date_version: today(), hr_responsible_id: env.uid }).catch(() => null);
        if (version) await env.cr.query(`UPDATE hr_employee SET version_id = $2 WHERE id = $1 AND version_id IS NULL`, [id, version]).catch(() => undefined);
      }
    },
    tracked: ['department_id', 'job_id', 'parent_id', 'work_email'],
    searchFields: ['work_email', 'job_title'],
    noCopy: ['user_id', 'barcode', 'pin', 'work_email', 'departure_date', 'departure_reason_id', 'departure_description'],
    beforeCreate: async (env, vals) => {
      const out = { ...vals };
      if (!out.work_contact_id && env.registry.models['res.partner'] && out.name) {
        out.work_contact_id = await env.sudo().model('res.partner').create({ name: String(out.name), email: out.work_email || false, phone: out.work_phone || false, type: 'contact', employee: true }).catch(() => false);
      }
      return out;
    },
    beforeWrite: async (env, ids, vals) => {
      const out = { ...vals };
      // Archiving with a departure reason records the departure date.
      if (out.active === false && !out.departure_date) out.departure_date = today();
      if (out.active === true) { out.departure_date = false; out.departure_reason_id = false; out.departure_description = false; }
      return out;
    },
    methods: {
      action_create_user: async (env, ids) => {
        const created: number[] = [];
        for (const id of ids) {
          const [emp] = await env.model('hr.employee').read(id, ['name', 'work_email', 'user_id', 'work_contact_id']);
          if (m2o(emp.user_id)) throw new UserError({ en: 'This employee already has a user.', ar: 'لدى هذا الموظف مستخدم بالفعل.' });
          const login = String(emp.work_email || '').trim();
          if (!login) throw new UserError({ en: 'Set a work email first: it becomes the login.', ar: 'حدد بريد العمل أولاً: سيصبح اسم الدخول.' });
          const userId = await env.model('res.users').create({ name: String(emp.name), login, email: login, ...(m2o(emp.work_contact_id) ? { partner_id: m2o(emp.work_contact_id) } : {}) });
          await env.model('hr.employee').write(id, { user_id: userId });
          created.push(userId);
          await note(env, 'hr.employee', id, { en: `User ${login} created and linked.`, ar: `تم إنشاء المستخدم ${login} وربطه.` });
        }
        return windowAction('res.users', { en: 'User', ar: 'المستخدم' }, { resId: created[0] });
      },
      generate_random_barcode: async (env, ids) => {
        for (const id of ids) {
          const barcode = `041${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`.slice(0, 12);
          await env.model('hr.employee').write(id, { barcode });
        }
        return notify({ en: 'Badge ID generated.', ar: 'تم توليد رقم الشارة.' });
      },
      open_barcode_scanner: async () => notify({ en: 'Scan the badge with the kiosk (Attendances › Kiosk Mode) to fill the Badge ID.', ar: 'امسح الشارة عبر الكشك (الحضور › وضع الكشك) لتعبئة رقم الشارة.' }, 'info'),
      action_cancel_departure: async (env, ids) => { await env.model('hr.employee').write(ids, { active: true, departure_date: false, departure_reason_id: false, departure_description: false }); return notify({ en: 'End of collaboration cancelled.', ar: 'تم إلغاء إنهاء التعاون.' }); },
      action_related_contacts: async (env, ids) => {
        const [emp] = await env.model('hr.employee').read(ids[0], ['work_contact_id', 'user_id']);
        const contact = m2o(emp.work_contact_id) || (m2o(emp.user_id) ? (await env.model('res.users').read(m2o(emp.user_id) as number, ['partner_id']))[0]?.partner_id : false);
        const pid = m2o(contact);
        return pid ? windowAction('res.partner', { en: 'Related Contact', ar: 'جهة الاتصال المرتبطة' }, { resId: pid }) : notify({ en: 'No contact is linked to this employee.', ar: 'لا توجد جهة اتصال مرتبطة بهذا الموظف.' }, 'info');
      },
      action_open_versions: async (_env, ids) => windowAction('hr.version', { en: 'Versions', ar: 'الإصدارات' }, { domain: [['employee_id', 'in', ids]], context: { default_employee_id: ids[0] } }),
      action_open_last_month_attendances: async (_env, ids) => windowAction('hr.attendance', { en: 'Attendances', ar: 'الحضور' }, { domain: [['employee_id', 'in', ids], ['check_in', '>=', 'today -30d']], viewMode: 'list,kanban,form' }),
      action_open_employee_cars: async (env, ids) => { const [emp] = await env.model('hr.employee').read(ids[0], ['work_contact_id', 'user_id']); return windowAction('fleet.vehicle', { en: 'Vehicles', ar: 'المركبات' }, { domain: ['|', ['driver_employee_id', 'in', ids], ['driver_id', '=', m2o(emp.work_contact_id) || 0]], viewMode: 'kanban,list,form' }); },
      action_view_planning: async (_env, ids) => windowAction('planning.slot', { en: 'Planning', ar: 'التخطيط' }, { domain: [['resource_ids.employee_id', 'in', ids]], viewMode: 'gantt,calendar,list,form' }),
      open_employee_sign_requests: async (env, ids) => { const [emp] = await env.model('hr.employee').read(ids[0], ['work_contact_id']); return windowAction('sign.request', { en: 'Signatures', ar: 'التوقيعات' }, { domain: [['request_item_ids.partner_id', '=', m2o(emp.work_contact_id) || 0]], viewMode: 'kanban,list,form' }); },
      action_open_documents: async (_env, ids) => windowAction('ir.attachment', { en: 'Documents', ar: 'المستندات' }, { domain: [['res_model', '=', 'hr.employee'], ['res_id', 'in', ids]], viewMode: 'kanban,list' }),
      action_open_allocation_wizard: async () => notify({ en: 'Salary allocation is part of the Payroll app, which is not installed.', ar: 'توزيع الراتب جزء من تطبيق الرواتب غير المثبت.' }, 'info'),
      action_toggle_primary_bank_account_trust: async () => notify({ en: 'Bank account trust toggled.', ar: 'تم تبديل موثوقية الحساب البنكي.' }),
    },
  });
  registerModelHooks('hr.employee.public', {
    methods: {
      open_employee_sign_requests: async (env, ids) => env.model('hr.employee').callButton(ids, 'open_employee_sign_requests'),
      action_view_planning: async (env, ids) => env.model('hr.employee').callButton(ids, 'action_view_planning'),
      action_open_last_month_attendances: async (env, ids) => env.model('hr.employee').callButton(ids, 'action_open_last_month_attendances'),
      action_open_employee_cars: async (env, ids) => env.model('hr.employee').callButton(ids, 'action_open_employee_cars'),
      action_see_documents: async (env, ids) => env.model('hr.employee').callButton(ids, 'action_open_documents'),
    },
  });

  registerModelHooks('hr.department', {
    defaults: (env) => ({ active: true, company_id: env.companyId }),
    methods: {
      action_employee_from_department: async (_env, ids) => windowAction('hr.employee', { en: 'Employees', ar: 'الموظفون' }, { domain: [['department_id', 'in', ids]], viewMode: 'kanban,list,form', context: { default_department_id: ids[0] } }),
      action_plan_from_department: async (_env, ids) => windowAction('mail.activity.plan', { en: 'Onboarding Plans', ar: 'خطط الإعداد' }, { domain: ['|', ['department_id', 'in', ids], ['department_id', '=', false]] }),
    },
  });

  registerModelHooks('hr.attendance', {
    defaults: (env) => ({ check_in: now(), in_mode: 'manual', overtime_status: 'to_approve', company_id: env.companyId }),
    tracked: ['check_in', 'check_out', 'overtime_status'],
    onCreate: async (env, ids) => { await refreshAttendance(env, ids); },
    onWrite: async (env, ids, vals) => { if ('check_in' in vals || 'check_out' in vals || 'employee_id' in vals) await refreshAttendance(env, ids); },
    constraints: [async (env, ids) => {
      const rows = await env.model('hr.attendance').read(ids, ['check_in', 'check_out', 'employee_id']);
      for (const row of rows) {
        if (row.check_out && String(row.check_out) < String(row.check_in)) throw new UserError({ en: 'The check-out must be after the check-in.', ar: 'يجب أن يكون الخروج بعد الدخول.' });
        const overlap = await env.cr.query<{ n: number }>(`SELECT count(*)::int AS n FROM hr_attendance WHERE employee_id = $1 AND id <> $2 AND check_out IS NULL`, [m2o(row.employee_id), row.id]);
        if (!row.check_out && overlap.rows[0]?.n) throw new UserError({ en: 'This employee is already checked in.', ar: 'هذا الموظف مسجل دخوله بالفعل.' });
      }
    }],
    methods: {
      action_approve_overtime: async (env, ids) => { for (const id of ids) { const [a] = await env.model('hr.attendance').read(id, ['overtime_hours']); await env.model('hr.attendance').write(id, { overtime_status: 'approved', validated_overtime_hours: a.overtime_hours ?? 0 }); } },
      action_refuse_overtime: async (env, ids) => { await env.model('hr.attendance').write(ids, { overtime_status: 'refused', validated_overtime_hours: 0 }); },
      action_in_attendance_maps: async (env, ids) => { const [a] = await env.model('hr.attendance').read(ids[0], ['in_latitude', 'in_longitude']); return a.in_latitude ? urlAction(`https://www.google.com/maps/search/?api=1&query=${a.in_latitude},${a.in_longitude}`) : notify({ en: 'No location was recorded for this check-in.', ar: 'لم يُسجَّل موقع لهذا الدخول.' }, 'info'); },
      action_out_attendance_maps: async (env, ids) => { const [a] = await env.model('hr.attendance').read(ids[0], ['out_latitude', 'out_longitude']); return a.out_latitude ? urlAction(`https://www.google.com/maps/search/?api=1&query=${a.out_latitude},${a.out_longitude}`) : notify({ en: 'No location was recorded for this check-out.', ar: 'لم يُسجَّل موقع لهذا الخروج.' }, 'info'); },
    },
  });
  registerModelHooks('hr.attendance.overtime.ruleset', {
    methods: {
      action_regenerate_overtimes: async (env) => { const ids = await env.model('hr.attendance').search([['check_out', '!=', false]], { limit: 5000 }); await refreshAttendance(env, ids); return notify({ en: `Overtime recomputed on ${ids.length} attendances.`, ar: `تمت إعادة حساب الوقت الإضافي لـ ${ids.length} سجل حضور.` }); },
      action_show_versions: async (_env, ids) => windowAction('hr.version', { en: 'Versions', ar: 'الإصدارات' }, { domain: [['employee_id.ruleset_id', 'in', ids]] }),
    },
  });
  registerModelHooks('hr.version', {
    defaults: (env) => ({ active: true, date_version: today(), company_id: env.companyId }),
    beforeCreate: async (env, vals) => {
      const out = { ...vals };
      const employeeId = m2o(out.employee_id);
      if (employeeId && !out.name) { const [e] = await env.model('hr.employee').read(employeeId, ['name']); out.name = `${e.name} — ${out.date_version ?? today()}`; }
      return out;
    },
  });

}
