import { registerModelHooks, type Values } from '../../engine/orm/hooks.js';
import type { Environment } from '../../engine/orm/env.js';
import { UserError } from '../../engine/orm/errors.js';
import { partnerOfUser } from '../../engine/orm/mail.js';
import { addDays, m2o, note, notify, now, openRecords, randomToken, today, urlAction, windowAction } from '../common.js';

/**
 * D-9 / D-7 — Calendar, Appointments and Planning: attendees with their
 * answer, invitations, video-call links, appointment statuses; appointment
 * types with share links and previews; planning shifts published and sent
 * to the employees, self-unassignment, "My Planning".
 */

async function syncAttendees(env: Environment, eventId: number): Promise<void> {
  if (!env.registry.models['calendar.attendee']) return;
  const [event] = await env.model('calendar.event').read(eventId, ['partner_ids', 'user_id', 'attendee_ids']);
  const partners = (event.partner_ids as number[]) ?? [];
  const attendees = await env.model('calendar.attendee').read((event.attendee_ids as number[]) ?? [], ['partner_id', 'state']);
  const organizer = m2o(event.user_id) ? await partnerOfUser(env, m2o(event.user_id) as number) : null;
  for (const pid of partners) {
    if (attendees.some((a) => m2o(a.partner_id) === pid)) continue;
    const contact = await env.cr.query<{ email: string | null; phone: string | null }>(`SELECT email, phone FROM res_partner WHERE id = $1`, [pid]);
    await env.model('calendar.attendee').create({ calendar_event_id: eventId, partner_id: pid, state: pid === organizer ? 'accepted' : 'needsAction', email: contact.rows[0]?.email ?? false, phone: contact.rows[0]?.phone ?? false });
  }
  const stale = attendees.filter((a) => !partners.includes(m2o(a.partner_id) as number)).map((a) => a.id as number);
  if (stale.length) await env.model('calendar.attendee').unlink(stale);
  await refreshCounts(env, eventId);
}

async function refreshCounts(env: Environment, eventId: number): Promise<void> {
  const rows = await env.cr.query<{ state: string; n: number }>(`SELECT state, count(*)::int AS n FROM calendar_attendee WHERE calendar_event_id = $1 GROUP BY state`, [eventId]).catch(() => ({ rows: [] as { state: string; n: number }[] }));
  const count = (s: string) => rows.rows.find((r) => r.state === s)?.n ?? 0;
  await env.cr.query(`UPDATE calendar_event SET attendees_count = $2, accepted_count = $3, declined_count = $4 WHERE id = $1`, [eventId, rows.rows.reduce((s, r) => s + r.n, 0), count('accepted'), count('declined')]).catch(() => undefined);
}

export function registerCalendar(): void {
  registerModelHooks('calendar.event', {
    defaults: (env) => {
      const start = new Date(); start.setUTCMinutes(0, 0, 0); start.setUTCHours(start.getUTCHours() + 1);
      const stop = new Date(start.getTime() + 3_600_000);
      return { user_id: env.uid, active: true, privacy: 'public', show_as: 'busy', allday: false, duration: 1, start: start.toISOString().slice(0, 19).replace('T', ' '), stop: stop.toISOString().slice(0, 19).replace('T', ' '), recurrency: false };
    },
    tracked: ['start', 'stop', 'location', 'partner_ids'],
    searchFields: ['location', 'description'],
    beforeCreate: async (env, vals) => {
      const out = { ...vals };
      if (out.start && !out.stop) { const d = new Date(String(out.start).replace(' ', 'T') + 'Z'); d.setUTCHours(d.getUTCHours() + Number(out.duration ?? 1)); out.stop = d.toISOString().slice(0, 19).replace('T', ' '); }
      if (out.start && out.stop && out.duration === undefined) out.duration = Math.round(((Date.parse(String(out.stop).replace(' ', 'T') + 'Z') - Date.parse(String(out.start).replace(' ', 'T') + 'Z')) / 3_600_000) * 100) / 100;
      if (out.allday && out.start) { out.start_date = String(out.start).slice(0, 10); out.stop_date = String(out.stop ?? out.start).slice(0, 10); }
      // The organizer attends their own meeting.
      const organizer = await partnerOfUser(env, m2o(out.user_id) || env.uid);
      const partners = Array.isArray(out.partner_ids) && Array.isArray(out.partner_ids[0]) && (out.partner_ids[0] as unknown[])[0] === 6 ? ((out.partner_ids[0] as unknown[])[2] as number[]) : [];
      if (organizer && !partners.includes(organizer)) out.partner_ids = [[6, 0, [...partners, organizer]]];
      if (m2o(out.appointment_type_id) && !out.appointment_status) out.appointment_status = 'booked';
      return out;
    },
    onCreate: async (env, ids) => { for (const id of ids) await syncAttendees(env, id); },
    onWrite: async (env, ids, vals) => { if ('partner_ids' in vals || 'user_id' in vals) for (const id of ids) await syncAttendees(env, id); },
    onchange: {
      start: async (_env, values) => {
        if (!values.start) return {};
        const d = new Date(String(values.start).replace(' ', 'T') + 'Z'); d.setUTCHours(d.getUTCHours() + Number(values.duration ?? 1));
        return { value: { stop: d.toISOString().slice(0, 19).replace('T', ' ') } };
      },
      duration: async (_env, values) => {
        if (!values.start) return {};
        const d = new Date(String(values.start).replace(' ', 'T') + 'Z'); d.setUTCHours(d.getUTCHours() + Number(values.duration ?? 1));
        return { value: { stop: d.toISOString().slice(0, 19).replace('T', ' ') } };
      },
    },
    methods: {
      action_open_composer: async (_env, ids) => ({ type: 'ir.actions.client', tag: 'mail.compose', params: { model: 'calendar.event', res_id: ids[0] } }),
      action_sendmail: async (env, ids) => { for (const id of ids) await note(env, 'calendar.event', id, { en: 'Invitations sent to the attendees.', ar: 'تم إرسال الدعوات إلى الحاضرين.' }); return notify({ en: 'Invitations sent.', ar: 'تم إرسال الدعوات.' }); },
      action_send_sms: async () => notify({ en: 'SMS sending is not configured on this instance.', ar: 'إرسال الرسائل النصية غير مهيأ في هذه النسخة.' }, 'warning'),
      action_set_appointment_booked: async (env, ids) => { await env.model('calendar.event').write(ids, { appointment_status: 'booked' }); },
      action_set_appointment_attended: async (env, ids) => { await env.model('calendar.event').write(ids, { appointment_status: 'attended' }); },
      action_set_appointment_no_show: async (env, ids) => { await env.model('calendar.event').write(ids, { appointment_status: 'no_show' }); },
      action_set_appointment_cancelled: async (env, ids) => { await env.model('calendar.event').write(ids, { appointment_status: 'cancelled', active: false }); },
      set_discuss_videocall_location: async (env, ids) => { for (const id of ids) await env.model('calendar.event').write(id, { videocall_location: `/odoo/discuss?call=${randomToken(12)}`, videocall_source: 'discuss' }); },
      clear_videocall_location: async (env, ids) => { await env.model('calendar.event').write(ids, { videocall_location: false, videocall_source: false }); },
      action_join_video_call: async (env, ids) => { const [e] = await env.model('calendar.event').read(ids[0], ['videocall_location']); return e.videocall_location ? urlAction(String(e.videocall_location), 'self') : notify({ en: 'No video call link on this meeting.', ar: 'لا يوجد رابط مكالمة فيديو لهذا الاجتماع.' }, 'info'); },
      /** "Going?" answers of the current user. */
      action_accept: async (env, ids) => { const pid = await partnerOfUser(env, env.uid); await env.cr.query(`UPDATE calendar_attendee SET state = 'accepted' WHERE calendar_event_id = ANY($1) AND partner_id = $2`, [ids, pid]); for (const id of ids) await refreshCounts(env, id); },
      action_decline: async (env, ids) => { const pid = await partnerOfUser(env, env.uid); await env.cr.query(`UPDATE calendar_attendee SET state = 'declined' WHERE calendar_event_id = ANY($1) AND partner_id = $2`, [ids, pid]); for (const id of ids) await refreshCounts(env, id); },
      action_tentative: async (env, ids) => { const pid = await partnerOfUser(env, env.uid); await env.cr.query(`UPDATE calendar_attendee SET state = 'tentative' WHERE calendar_event_id = ANY($1) AND partner_id = $2`, [ids, pid]); for (const id of ids) await refreshCounts(env, id); },
    },
  });
  registerModelHooks('calendar.attendee', {
    defaults: () => ({ state: 'needsAction' }),
    onWrite: async (env, ids) => { const rows = await env.cr.query<{ e: number }>(`SELECT DISTINCT calendar_event_id AS e FROM calendar_attendee WHERE id = ANY($1)`, [ids]); for (const r of rows.rows) await refreshCounts(env, Number(r.e)); },
    methods: {
      do_accept: async (env, ids) => { await env.model('calendar.attendee').write(ids, { state: 'accepted' }); },
      do_decline: async (env, ids) => { await env.model('calendar.attendee').write(ids, { state: 'declined' }); },
      do_tentative: async (env, ids) => { await env.model('calendar.attendee').write(ids, { state: 'tentative' }); },
    },
  });

  /* ---------- Appointments ---------- */
  registerModelHooks('appointment.type', {
    defaults: (env) => ({ active: true, category: 'recurring', schedule_based_on: 'users', appointment_duration: 1, min_schedule_hours: 1, max_schedule_days: 15, min_cancellation_hours: 1, appointment_tz: 'Asia/Riyadh', auto_confirm: true, assign_method: 'resource_time', sequence: 10, staff_user_ids: [[6, 0, [env.uid]]] }),
    methods: {
      action_share_invite: async (env, ids) => {
        const created: number[] = [];
        for (const id of ids) {
          const code = randomToken(8);
          created.push(await env.model('appointment.invite').create({ appointment_type_ids: [[6, 0, [id]]], short_code: code, book_url: `/appointment/${id}?invite=${code}` }));
        }
        return windowAction('appointment.invite', { en: 'Share Availabilities', ar: 'مشاركة الأوقات المتاحة' }, { resId: created[0], viewMode: 'form', target: 'new' });
      },
      action_customer_preview: async (_env, ids) => urlAction(`/appointment/${ids[0]}`),
      action_calendar_meetings: async (_env, ids) => windowAction('calendar.event', { en: 'Meetings', ar: 'الاجتماعات' }, { domain: [['appointment_type_id', 'in', ids]], viewMode: 'calendar,list,form,gantt', context: { default_appointment_type_id: ids[0] } }),
      action_appointment_leaves: async (_env, ids) => windowAction('appointment.leave', { en: 'Closing Days', ar: 'أيام الإغلاق' }, { domain: [['appointment_type_ids', 'in', ids]], context: { default_appointment_type_ids: [[6, 0, ids]] } }),
      add_videocall_source: async () => notify({ en: 'Meetings booked on this type get a video call link automatically.', ar: 'تحصل الاجتماعات المحجوزة على هذا النوع على رابط مكالمة فيديو تلقائياً.' }, 'info'),
    },
  });
  registerModelHooks('appointment.invite', {
    defaults: () => ({ short_code: randomToken(8) }),
    beforeCreate: async (_env, vals) => { const out = { ...vals }; if (!out.short_code) out.short_code = randomToken(8); if (!out.book_url) out.book_url = `/appointment?invite=${out.short_code}`; return out; },
  });
  registerModelHooks('appointment.question', { methods: { action_view_appointment_types: async (_env, ids) => windowAction('appointment.type', { en: 'Appointment Types', ar: 'أنواع المواعيد' }, { domain: [['question_ids', 'in', ids]], viewMode: 'kanban,list,form' }) } });

  /* ---------- Planning (D-7) ---------- */
  registerModelHooks('planning.slot', {
    defaults: (env) => {
      const start = new Date(); start.setUTCHours(8, 0, 0, 0);
      const end = new Date(start.getTime() + 8 * 3_600_000);
      return { state: '1_draft', company_id: env.companyId, allocated_hours: 8, allocated_percentage: 100, start_datetime: start.toISOString().slice(0, 19).replace('T', ' '), end_datetime: end.toISOString().slice(0, 19).replace('T', ' '), repeat: false, allow_self_unassign: false, is_hatched: true };
    },
    tracked: ['state', 'start_datetime', 'end_datetime', 'role_id'],
    beforeCreate: async (env, vals) => {
      const out = { ...vals };
      if (out.start_datetime && out.end_datetime && out.allocated_hours === undefined) out.allocated_hours = Math.round(((Date.parse(String(out.end_datetime).replace(' ', 'T') + 'Z') - Date.parse(String(out.start_datetime).replace(' ', 'T') + 'Z')) / 3_600_000) * 100) / 100;
      const templateId = m2o(out.template_id);
      if (templateId && env.registry.models['planning.slot.template']) {
        const [t] = await env.model('planning.slot.template').read(templateId, ['start_time', 'duration', 'role_id']).catch(() => [] as Values[]);
        if (t) { if (!m2o(out.role_id) && m2o(t.role_id)) out.role_id = m2o(t.role_id); if (t.duration) out.allocated_hours = t.duration; }
      }
      out.is_hatched = out.state !== '2_published';
      return out;
    },
    beforeWrite: async (_env, _ids, vals) => { const out = { ...vals }; if ('state' in out) out.is_hatched = out.state !== '2_published'; return out; },
    methods: {
      action_send: async (env, ids) => { await env.model('planning.slot').write(ids, { state: '2_published', publication_warning: false }); for (const id of ids) await note(env, 'planning.slot', id, { en: 'Shift published and sent to the employee.', ar: 'تم نشر المناوبة وإرسالها إلى الموظف.' }); return notify({ en: `${ids.length} shift(s) published.`, ar: `تم نشر ${ids.length} مناوبة.` }); },
      action_planning_publish_and_send: async (env, ids) => env.model('planning.slot').callButton(ids, 'action_send'),
      action_self_unassign: async (env, ids) => {
        const employee = await env.cr.query<{ r: number | null }>(`SELECT resource_resource_id AS r FROM hr_employee WHERE user_id = $1 LIMIT 1`, [env.uid]).catch(() => ({ rows: [] as { r: number | null }[] }));
        const resource = employee.rows[0]?.r;
        for (const id of ids) {
          const [slot] = await env.model('planning.slot').read(id, ['allow_self_unassign', 'resource_ids']);
          if (!slot.allow_self_unassign) throw new UserError({ en: 'This shift does not allow unassignment.', ar: 'لا تسمح هذه المناوبة بإلغاء الإسناد.' });
          await env.model('planning.slot').write(id, { resource_ids: resource ? [[3, resource]] : [[5]], request_to_switch: false });
          await note(env, 'planning.slot', id, { en: 'The employee marked themselves unavailable; the shift is open again.', ar: 'حدد الموظف نفسه غير متاح؛ المناوبة مفتوحة مجدداً.' });
        }
      },
      action_self_assign: async (env, ids) => {
        const employee = await env.cr.query<{ r: number | null }>(`SELECT resource_resource_id AS r FROM hr_employee WHERE user_id = $1 LIMIT 1`, [env.uid]).catch(() => ({ rows: [] as { r: number | null }[] }));
        if (!employee.rows[0]?.r) throw new UserError({ en: 'Your user is not linked to an employee.', ar: 'مستخدمك غير مرتبط بموظف.' });
        for (const id of ids) await env.model('planning.slot').write(id, { resource_ids: [[4, employee.rows[0].r]] });
      },
      action_view_sale_order: async (env, ids) => { const [s] = await env.model('planning.slot').read(ids[0], ['sale_order_id', 'sale_line_id']); const so = m2o(s.sale_order_id); return so ? windowAction('sale.order', { en: 'Sales Order', ar: 'أمر البيع' }, { resId: so }) : notify({ en: 'No sales order is linked to this shift.', ar: 'لا يوجد أمر بيع مرتبط بهذه المناوبة.' }, 'info'); },
      action_unschedule: async (env, ids) => { await env.model('planning.slot').write(ids, { resource_ids: [[5]], state: '1_draft' }); },
    },
  });
  registerModelHooks('planning.role', { defaults: () => ({ color: 1, sequence: 10 }) });
  void addDays; void today; void now; void openRecords;
}
