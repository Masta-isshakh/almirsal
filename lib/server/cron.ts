import type { Environment } from '@engine/orm/env';
import { getParameter, setParameter } from '@engine/schema/ddl';
import { postMessage } from '@engine/orm/mail';
import { sendPlainMail } from './mail';
import { refreshAttendance } from '@/packages/apps/hr/index';

/**
 * Scheduled actions (`ir.cron`, A-3): the jobs run by `/api/cron`, which an
 * EventBridge schedule (backend.ts) calls every 15 minutes in production;
 * locally `curl -X POST localhost:3000/api/cron -H 'x-cron-key: …'`. Each
 * job records its last run in `ir_cron` so Settings › Technical shows it,
 * and only runs again once its interval has elapsed.
 */
export interface CronJob {
  xmlId: string;
  name: string;
  model: string;
  /** Minutes between runs. */
  interval: number;
  run(env: Environment): Promise<string>;
}

const stamp = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

/** Digests (Settings › Statistics › Digest Emails): KPI mail to the subscribers on the periodicity. */
async function sendDigests(env: Environment): Promise<string> {
  if (!env.registry.models['digest.digest']) return 'no digest model';
  const today = stamp(new Date()).slice(0, 10);
  const digests = await env.model('digest.digest').searchRead([['state', '=', 'activated'], '|', ['next_run_date', '<=', today], ['next_run_date', '=', false]], ['name', 'periodicity', 'user_ids', 'company_id']);
  let sent = 0;
  for (const digest of digests) {
    const days = digest.periodicity === 'daily' ? 1 : digest.periodicity === 'monthly' ? 30 : digest.periodicity === 'quarterly' ? 90 : 7;
    const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const q = async (sql: string) => num((await env.cr.query<{ v: unknown }>(sql, [from]).catch(() => ({ rows: [{ v: 0 }] }))).rows[0]?.v);
    const kpis: [string, number, string][] = [
      ['Connected Users', await q(`SELECT count(*) AS v FROM res_users WHERE coalesce(active, true) AND login_date >= $1::date`), 'int'],
      ['Messages', await q(`SELECT count(*) AS v FROM mail_message WHERE create_date >= $1::date`), 'int'],
      ['All Sales', await q(`SELECT coalesce(sum(amount_untaxed), 0) AS v FROM sale_order WHERE state IN ('sale', 'done') AND date_order >= $1::date`), 'money'],
      ['Revenue', await q(`SELECT coalesce(sum(amount_untaxed_signed), 0) AS v FROM account_move WHERE state = 'posted' AND move_type IN ('out_invoice', 'out_refund') AND invoice_date >= $1::date`), 'money'],
      ['Bank & Cash Moves', await q(`SELECT coalesce(sum(l.balance), 0) AS v FROM account_move_line l JOIN account_account a ON a.id = l.account_id JOIN account_move m ON m.id = l.move_id WHERE a.account_type = 'asset_cash' AND m.state = 'posted' AND m.date >= $1::date`), 'money'],
      ['Open Tasks', await q(`SELECT count(*) AS v FROM project_task WHERE coalesce(active, true) AND create_date >= $1::date`), 'int'],
      ['Tickets Closed', await q(`SELECT count(*) AS v FROM helpdesk_ticket t JOIN helpdesk_stage s ON s.id = t.stage_id WHERE coalesce(s.fold, false) AND t.write_date >= $1::date`), 'int'],
    ];
    const rows = kpis.map(([label, value, kind]) => `<tr><td style="padding:6px 12px;color:#6b7280">${label}</td><td style="padding:6px 12px;text-align:right;font-weight:700">${kind === 'money' ? value.toLocaleString('en-US', { minimumFractionDigits: 2 }) : value}</td></tr>`).join('');
    const html = `<h2 style="margin:0 0 12px">${String(digest.name)}</h2><p style="color:#6b7280">Since ${from}</p><table style="border-collapse:collapse">${rows}</table>`;
    const userIds = (digest.user_ids as number[]) ?? [];
    if (userIds.length) {
      const users = await env.model('res.users').read(userIds, ['name', 'email', 'login']);
      for (const user of users) {
        const to = String(user.email || user.login || '');
        if (to.includes('@') && (await sendPlainMail(env, { to, name: String(user.name ?? ''), subject: String(digest.name), html }))) sent++;
      }
    }
    const next = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
    await env.model('digest.digest').write(Number(digest.id), { next_run_date: next });
  }
  return `${digests.length} digest(s), ${sent} mail(s)`;
}

/** Calendar email alarms: attendees get a reminder when an event's "Email - N hours" alarm falls due. */
async function calendarReminders(env: Environment): Promise<string> {
  if (!env.registry.models['calendar.event'] || !env.registry.models['calendar.alarm']) return 'no calendar model';
  const alarms = await env.model('calendar.alarm').searchRead([['alarm_type', '=', 'email']], ['duration', 'interval']);
  if (!alarms.length) return 'no email alarms';
  const now = Date.now();
  const horizon = new Date(now + 7 * 86_400_000);
  const events = await env.model('calendar.event').searchRead([['start', '>=', stamp(new Date(now))], ['start', '<=', stamp(horizon)], ['alarm_ids', 'in', alarms.map((a) => Number(a.id))]], ['name', 'start', 'alarm_ids', 'partner_ids']);
  let sent = 0;
  for (const event of events) {
    const start = Date.parse(String(event.start).replace(' ', 'T') + 'Z');
    for (const alarm of alarms) {
      if (!((event.alarm_ids as number[]) ?? []).includes(Number(alarm.id))) continue;
      const minutes = num(alarm.duration) * (alarm.interval === 'days' ? 1440 : alarm.interval === 'hours' ? 60 : 1);
      if (start - minutes * 60_000 > now) continue;
      const key = `rodeo.cron.alarm.${event.id}.${alarm.id}`;
      if (await getParameter(env.cr, key)) continue;
      const partners = await env.model('res.partner').read((event.partner_ids as number[]) ?? [], ['name', 'email']);
      const when = new Date(start).toUTCString();
      for (const partner of partners) {
        const to = String(partner.email || '');
        if (to.includes('@') && (await sendPlainMail(env, { to, name: String(partner.name ?? ''), subject: `Reminder: ${String(event.name)}`, html: `<p>Your event <b>${String(event.name)}</b> starts on ${when}.</p>` }))) sent++;
      }
      await setParameter(env.cr, key, stamp(new Date()));
    }
  }
  return `${events.length} event(s), ${sent} mail(s)`;
}

/** Attendances left open for more than a day are closed at the expected daily hours (Odoo's automatic check-out). */
async function autoCheckOut(env: Environment): Promise<string> {
  if (!env.registry.models['hr.attendance']) return 'no attendance model';
  const rows = await env.cr.query<{ id: number; check_in: string; hours: number | null }>(
    `SELECT a.id, to_char(a.check_in, 'YYYY-MM-DD HH24:MI:SS') AS check_in, e.hours_per_day::float8 AS hours FROM hr_attendance a JOIN hr_employee e ON e.id = a.employee_id
     WHERE a.check_out IS NULL AND a.check_in < now() - interval '24 hours'`);
  for (const row of rows.rows) {
    const out = new Date(Date.parse(row.check_in.replace(' ', 'T') + 'Z') + (row.hours || 8) * 3_600_000);
    await env.model('hr.attendance').write(row.id, { check_out: stamp(out), out_mode: 'technical' });
    await refreshAttendance(env, [row.id]);
  }
  if (rows.rows.length) await env.cr.query(`UPDATE hr_employee SET attendance_state = 'checked_out' WHERE id NOT IN (SELECT employee_id FROM hr_attendance WHERE check_out IS NULL)`).catch(() => undefined);
  return `${rows.rows.length} attendance(s) closed`;
}

/** Overdue customer invoices get `last_reminder` stamped and a chatter note once a day, so the follow-up report moves on. */
async function overdueInvoices(env: Environment): Promise<string> {
  if (!env.registry.models['account.move']) return 'no account model';
  const hasReminder = Boolean(env.registry.models['account.move'].fields.last_reminder?.store);
  const rows = await env.cr.query<{ id: number; name: string; due: string }>(
    `SELECT id, name, to_char(invoice_date_due, 'YYYY-MM-DD') AS due FROM account_move WHERE state = 'posted' AND move_type = 'out_invoice' AND payment_state IN ('not_paid', 'partial')
     AND invoice_date_due < current_date ${hasReminder ? "AND (last_reminder IS NULL OR last_reminder < current_date)" : ''} ORDER BY id LIMIT 200`);
  for (const row of rows.rows) {
    await postMessage(env, 'account.move', row.id, { body: `Payment overdue since ${row.due}.`, messageType: 'notification' }).catch(() => undefined);
    if (hasReminder) await env.cr.query(`UPDATE account_move SET last_reminder = current_date WHERE id = $1`, [row.id]).catch(() => undefined);
  }
  return `${rows.rows.length} overdue invoice(s) reminded`;
}

export const CRON_JOBS: CronJob[] = [
  { xmlId: 'digest.digest_cron', name: 'Digest Emails', model: 'digest.digest', interval: 60, run: sendDigests },
  { xmlId: 'calendar.ir_cron_scheduler_alarm', name: 'Calendar: Event Reminder', model: 'calendar.alarm', interval: 15, run: calendarReminders },
  { xmlId: 'hr_attendance.hr_attendance_cron_auto_check_out', name: 'Attendance: Automatic Check-Out', model: 'hr.attendance', interval: 60, run: autoCheckOut },
  { xmlId: 'account_followup.ir_cron_auto_post_draft_entry', name: 'Accounting: Overdue Invoices', model: 'account.move', interval: 60 * 24, run: overdueInvoices },
];

export interface CronRunResult { job: string; ran: boolean; detail: string; ms: number }

/** Run every due job (or all with `force`) and record the run in `ir_cron`. */
export async function runCron(env: Environment, options: { force?: boolean; only?: string } = {}): Promise<CronRunResult[]> {
  const hasTable = Boolean(env.registry.models['ir.cron']);
  const results: CronRunResult[] = [];
  for (const job of CRON_JOBS) {
    if (options.only && options.only !== job.xmlId) continue;
    const started = Date.now();
    let row: { id: number; nextcall: string | null } | undefined;
    if (hasTable) {
      const found = await env.cr.query<{ id: number; nextcall: string | null }>(`SELECT id, to_char(nextcall, 'YYYY-MM-DD HH24:MI:SS') AS nextcall FROM ir_cron WHERE cron_name = $1 LIMIT 1`, [job.xmlId]);
      row = found.rows[0];
      if (!row) {
        const id = await env.model('ir.cron').create({ cron_name: job.xmlId, name: job.name, active: true, interval_number: job.interval >= 1440 ? job.interval / 1440 : job.interval >= 60 ? job.interval / 60 : job.interval, interval_type: job.interval >= 1440 ? 'days' : job.interval >= 60 ? 'hours' : 'minutes', nextcall: stamp(new Date()), user_id: env.uid, priority: 5 });
        row = { id, nextcall: null };
      }
    }
    const due = options.force || !row?.nextcall || Date.parse(row.nextcall.replace(' ', 'T') + 'Z') <= started;
    if (!due) { results.push({ job: job.xmlId, ran: false, detail: `next ${row?.nextcall}`, ms: 0 }); continue; }
    let detail: string;
    try { detail = await job.run(env); }
    catch (error) {
      detail = `failed: ${error instanceof Error ? error.message : String(error)}`;
      if (row) await env.cr.query(`UPDATE ir_cron SET failure_count = coalesce(failure_count, 0) + 1 WHERE id = $1`, [row.id]).catch(() => undefined);
    }
    if (row) await env.cr.query(`UPDATE ir_cron SET lastcall = $2::timestamp, nextcall = $3::timestamp WHERE id = $1`, [row.id, stamp(new Date(started)), stamp(new Date(started + job.interval * 60_000))]).catch(() => undefined);
    results.push({ job: job.xmlId, ran: true, detail, ms: Date.now() - started });
  }
  return results;
}
