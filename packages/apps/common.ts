import type { Environment } from '../engine/orm/env.js';
import { getParameter, setParameter } from '../engine/schema/ddl.js';
import type { ActionResult, Values } from '../engine/orm/hooks.js';
import type { Domain } from '../engine/registry/types.js';
import type { I18n } from '../engine/i18n/types.js';
import { UserError } from '../engine/orm/errors.js';
import { postMessage } from '../engine/orm/mail.js';

/** Helpers shared by the app modules (Part D): dates, action results, chatter notes. */

export type Row = Record<string, unknown>;

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function now(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function m2o(value: unknown): number | false {
  if (Array.isArray(value)) return typeof value[0] === 'number' ? value[0] : false;
  if (value && typeof value === 'object' && 'id' in (value as object)) return Number((value as { id: number }).id) || false;
  return typeof value === 'number' && value > 0 ? value : false;
}

export function windowAction(model: string, name: I18n, options: { domain?: Domain; resId?: number; viewMode?: string; context?: Values; target?: 'current' | 'new' } = {}): ActionResult {
  return {
    type: 'ir.actions.act_window', res_model: model, name, view_mode: options.viewMode ?? (options.resId ? 'form' : 'list,form'),
    target: options.target ?? 'current', ...(options.resId ? { res_id: options.resId } : {}), ...(options.domain ? { domain: options.domain } : {}), ...(options.context ? { context: options.context } : {}),
  };
}

/** A list (or the single form) of the records with these ids. */
export function openRecords(model: string, name: I18n, ids: number[], options: { context?: Values; viewMode?: string } = {}): ActionResult {
  if (ids.length === 1) return windowAction(model, name, { resId: ids[0], context: options.context });
  return windowAction(model, name, { domain: [['id', 'in', ids]], context: options.context, viewMode: options.viewMode });
}

export function notify(message: I18n, type: 'success' | 'warning' | 'danger' | 'info' = 'success', options: { sticky?: boolean; title?: I18n; next?: ActionResult } = {}): ActionResult {
  return { type: 'ir.actions.client', tag: 'display_notification', params: { type, message, sticky: options.sticky ?? false, title: options.title, next: options.next } };
}

export function closeDialog(): ActionResult {
  return { type: 'ir.actions.act_window_close' };
}

export function urlAction(url: string, target: 'new' | 'self' = 'new'): ActionResult {
  return { type: 'ir.actions.act_url', url, target };
}

/** Chatter note in both languages (the viewer's language is picked at render time by the client's i18n). */
export async function note(env: Environment, model: string, id: number, text: I18n): Promise<void> {
  await postMessage(env, model, id, { body: `<p>${env.lang === 'ar_001' ? text.ar : text.en}</p>`, messageType: 'notification' }).catch(() => undefined);
}

export function requireState(record: Row, allowed: string[], message: I18n): void {
  if (!allowed.includes(String(record.state ?? record.request_status ?? ''))) throw new UserError(message);
}

/** The `ir.sequence` row for a code, created on demand with the given prefix. */
export async function ensureSequence(env: Environment, code: string, prefix: string, padding = 5): Promise<void> {
  const found = await env.cr.query<{ id: number }>(`SELECT id FROM ir_sequence WHERE code = $1 LIMIT 1`, [code]);
  if (found.rows.length) return;
  await env.cr.query(
    `INSERT INTO ir_sequence (name, code, prefix, padding, number_next_actual, number_increment, use_date_range, implementation, active, create_date, write_date) VALUES ($1, $1, $2, $3, 1, 1, false, 'standard', true, now(), now())`,
    [code, prefix, padding],
  );
}

/** Ids of the records of `model` linked to `id` through a many2one `field` (for smart buttons). */
export async function linkedIds(env: Environment, model: string, field: string, id: number): Promise<number[]> {
  const def = env.registry.models[model];
  if (!def?.fields[field]) return [];
  return env.model(model).search([[field, '=', id]], { activeTest: false });
}

/** The employee of the current user, if any. */
export async function currentEmployee(env: Environment): Promise<number | null> {
  if (!env.registry.models['hr.employee']) return null;
  const row = await env.cr.query<{ id: number }>(`SELECT id FROM hr_employee WHERE user_id = $1 AND coalesce(active, true) ORDER BY id LIMIT 1`, [env.uid]);
  return row.rows[0] ? Number(row.rows[0].id) : null;
}

/** The attendance kiosk secret (`/kiosk/<key>`), created on first use. */
export async function kioskKey(env: Environment): Promise<string> {
  const existing = await getParameter(env.cr, 'rodeo.attendance.kiosk_key');
  if (existing) return existing;
  const key = randomToken(40);
  await setParameter(env.cr, 'rodeo.attendance.kiosk_key', key);
  return key;
}

export function randomToken(length = 32): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
