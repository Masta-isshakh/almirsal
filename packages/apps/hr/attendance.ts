import type { Environment } from '../../engine/orm/env.js';
import { UserError } from '../../engine/orm/errors.js';
import { getSetting } from '../base/settings.js';
import { currentEmployee, kioskKey } from '../common.js';
import { toggleAttendance } from './index.js';

export { kioskKey };

/**
 * Attendance entry points (D-8): the navbar systray check-in / check-out of
 * the current user's employee, and the public kiosk (badge scan, manual
 * identification with optional PIN) reached through a secret URL that
 * Settings › Attendances can regenerate.
 */

export interface AttendanceStatus {
  enabled: boolean;
  employeeId: number | null;
  name: string;
  state: 'checked_in' | 'checked_out';
  /** Check-in stamp of the open attendance (UTC `YYYY-MM-DD HH:MM:SS`). */
  since: string | null;
  hoursToday: number;
  hoursThisWeek: number;
}

function hoursOf(rows: { check_in: string; check_out: string | null }[], from: Date): number {
  let total = 0;
  for (const row of rows) {
    const start = Math.max(Date.parse(row.check_in.replace(' ', 'T') + 'Z'), from.getTime());
    const end = row.check_out ? Date.parse(row.check_out.replace(' ', 'T') + 'Z') : Date.now();
    total += Math.max(0, end - start) / 3_600_000;
  }
  return Math.round(total * 100) / 100;
}

async function summary(env: Environment, employeeId: number): Promise<Pick<AttendanceStatus, 'state' | 'since' | 'hoursToday' | 'hoursThisWeek'>> {
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  const weekStart = new Date(dayStart); weekStart.setUTCDate(weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7));
  const rows = await env.cr.query<{ check_in: string; check_out: string | null }>(
    `SELECT to_char(check_in, 'YYYY-MM-DD HH24:MI:SS') AS check_in, to_char(check_out, 'YYYY-MM-DD HH24:MI:SS') AS check_out
     FROM hr_attendance WHERE employee_id = $1 AND (check_out IS NULL OR check_out >= $2::timestamp) ORDER BY check_in`,
    [employeeId, weekStart.toISOString().slice(0, 19).replace('T', ' ')]);
  const open = rows.rows.find((row) => !row.check_out) ?? null;
  return {
    state: open ? 'checked_in' : 'checked_out',
    since: open?.check_in ?? null,
    hoursToday: hoursOf(rows.rows.filter((row) => !row.check_out || row.check_out >= dayStart.toISOString().slice(0, 19).replace('T', ' ')), dayStart),
    hoursThisWeek: hoursOf(rows.rows, weekStart),
  };
}

/** The systray state of the current user's employee (`enabled` false when there is none or the setting is off). */
export async function attendanceStatus(env: Environment): Promise<AttendanceStatus> {
  const off: AttendanceStatus = { enabled: false, employeeId: null, name: '', state: 'checked_out', since: null, hoursToday: 0, hoursThisWeek: 0 };
  if (!env.registry.models['hr.attendance']) return off;
  const employeeId = await currentEmployee(env);
  if (!employeeId) return off;
  const fromSystray = await getSetting<boolean>(env, 'attendance_from_systray', true);
  if (!fromSystray) return off;
  const [employee] = await env.sudo().model('hr.employee').read(employeeId, ['name']);
  return { enabled: true, employeeId, name: String(employee?.name ?? ''), ...(await summary(env.sudo(), employeeId)) };
}

/** Systray click: check the current user's employee in or out. */
export async function attendanceToggle(env: Environment, geo?: { latitude?: number; longitude?: number }): Promise<AttendanceStatus> {
  const employeeId = await currentEmployee(env);
  if (!employeeId) throw new UserError({ en: 'You are not linked to an employee.', ar: 'لست مرتبطاً بموظف.' });
  await toggleAttendance(env.sudo(), employeeId, 'systray', geo);
  return attendanceStatus(env);
}

export interface KioskSettings { mode: 'barcode' | 'manual' | 'barcode_manual'; usePin: boolean; delay: number; company: string }

export async function kioskSettings(env: Environment): Promise<KioskSettings> {
  const company = await env.sudo().model('res.company').read(env.companyId, ['name']).catch(() => []);
  return {
    mode: await getSetting<KioskSettings['mode']>(env, 'attendance_kiosk_mode', 'barcode_manual'),
    usePin: await getSetting<boolean>(env, 'attendance_kiosk_use_pin', false),
    delay: Number(await getSetting<number>(env, 'attendance_kiosk_delay', 10)) || 10,
    company: String(company[0]?.name ?? 'Almirsal'),
  };
}

export interface KioskEmployee { id: number; name: string; department: string; state: 'checked_in' | 'checked_out' }

/** Manual identification: the employees, optionally filtered by name. */
export async function kioskEmployees(env: Environment, search = ''): Promise<KioskEmployee[]> {
  const rows = await env.sudo().model('hr.employee').searchRead(
    search ? [['name', 'ilike', search]] : [], ['name', 'department_id', 'attendance_state'], { order: 'name asc', limit: 200 });
  return rows.map((row) => ({
    id: Number(row.id), name: String(row.name ?? ''),
    department: Array.isArray(row.department_id) ? String(row.department_id[1]) : '',
    state: row.attendance_state === 'checked_in' ? 'checked_in' : 'checked_out',
  }));
}

export interface KioskResult { employeeId: number; name: string; state: 'checked_in' | 'checked_out'; hoursToday: number; since: string | null }

/** Badge scan or manual pick (+ PIN when the setting asks for it): check the employee in or out. */
export async function kioskCheck(env: Environment, input: { employeeId?: number; barcode?: string; pin?: string }): Promise<KioskResult> {
  const sudo = env.sudo();
  let employeeId = input.employeeId ?? 0;
  if (!employeeId && input.barcode) {
    const found = await sudo.model('hr.employee').search([['barcode', '=', input.barcode.trim()]], { limit: 1 });
    if (!found.length) throw new UserError({ en: 'No employee corresponding to Badge ID ' + input.barcode, ar: 'لا يوجد موظف يطابق رقم الشارة ' + input.barcode });
    employeeId = found[0];
  }
  if (!employeeId) throw new UserError({ en: 'Select an employee.', ar: 'اختر موظفاً.' });
  const [employee] = await sudo.model('hr.employee').read(employeeId, ['name', 'pin']);
  if (!employee) throw new UserError({ en: 'Unknown employee.', ar: 'موظف غير معروف.' });
  if (input.employeeId && !input.barcode) {
    const usePin = await getSetting<boolean>(env, 'attendance_kiosk_use_pin', false);
    if (usePin && String(employee.pin || '') !== String(input.pin ?? '')) throw new UserError({ en: 'Wrong PIN.', ar: 'رمز PIN غير صحيح.' });
  }
  const result = await toggleAttendance(sudo, employeeId, 'kiosk');
  const state = await summary(sudo, employeeId);
  return { employeeId, name: String(employee.name ?? ''), state: result.state, hoursToday: state.hoursToday, since: state.since };
}
