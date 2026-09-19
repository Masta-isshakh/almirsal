import type { I18n } from '../i18n/types.js';
import type { FieldDef } from '../registry/types.js';
import { quoteIdent } from '../schema/ddl.js';
import type { Environment } from './env.js';
import { nowSql } from './values.js';

/**
 * The `mail.thread` primitives the ORM itself needs: a system message when a
 * record is created, tracking values when a tracked field changes, and
 * cleanup when a record is deleted. The full chatter (composer, followers,
 * notifications, activities) lives in the mail app module and builds on the
 * same `postMessage`.
 */

export interface TrackingChange {
  field: FieldDef;
  oldValue: unknown;
  newValue: unknown;
}

export interface PostMessageOptions {
  body?: string;
  subject?: string;
  messageType?: 'email' | 'comment' | 'notification' | 'user_notification' | 'sms' | 'auto_comment';
  isInternal?: boolean;
  authorId?: number | null;
  partnerIds?: number[];
  parentId?: number;
}

const authorCache = new WeakMap<Environment, Map<number, number | null>>();

/** The partner behind a user (message author). */
export async function partnerOfUser(env: Environment, uid: number): Promise<number | null> {
  let cache = authorCache.get(env);
  if (!cache) { cache = new Map(); authorCache.set(env, cache); }
  if (cache.has(uid)) return cache.get(uid) ?? null;
  let partnerId: number | null = null;
  if (env.registry.models['res.users']?.fields.partner_id) {
    const row = await env.cr.query<{ partner_id: number | null }>(`SELECT partner_id FROM res_users WHERE id = $1`, [uid]);
    partnerId = row.rows[0]?.partner_id == null ? null : Number(row.rows[0].partner_id);
  }
  cache.set(uid, partnerId);
  return partnerId;
}

/** Insert a `mail.message` on a record and return its id. */
export async function postMessage(env: Environment, model: string, resId: number, options: PostMessageOptions = {}): Promise<number> {
  const message = env.registry.models['mail.message'];
  if (!message) return 0;
  const authorId = options.authorId === undefined ? await partnerOfUser(env, env.uid) : options.authorId;
  const names = await env.model(model).displayNames([resId]);

  const columns: Record<string, unknown> = {
    model,
    res_id: resId,
    body: options.body ?? '',
    subject: options.subject ?? null,
    message_type: options.messageType ?? 'notification',
    is_internal: options.isInternal ?? false,
    author_id: authorId,
    date: nowSql(),
    record_name: names.get(resId) ?? null,
    parent_id: options.parentId ?? null,
    create_uid: env.uid,
    create_date: nowSql(),
    write_uid: env.uid,
    write_date: nowSql(),
  };
  const present = Object.entries(columns).filter(([name]) => message.fields[name] || ['create_uid', 'create_date', 'write_uid', 'write_date'].includes(name));
  const placeholders = present.map(([name], index) => (name.endsWith('_date') || name === 'date' ? `$${index + 1}::timestamp` : `$${index + 1}`));
  const inserted = await env.cr.query<{ id: number }>(
    `INSERT INTO mail_message (${present.map(([name]) => quoteIdent(name)).join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`,
    present.map(([, value]) => value),
  );
  const messageId = Number(inserted.rows[0].id);

  if (options.partnerIds?.length && message.fields.partner_ids?.m2mTable) {
    const rel = message.fields.partner_ids;
    for (const partnerId of options.partnerIds) {
      await env.cr.query(
        `INSERT INTO ${quoteIdent(rel.m2mTable!)} (${quoteIdent(rel.m2mColumn1!)}, ${quoteIdent(rel.m2mColumn2!)}) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [messageId, partnerId],
      );
    }
  }
  return messageId;
}

export async function postCreationMessage(env: Environment, model: string, resId: number, text: I18n): Promise<void> {
  await postMessage(env, model, resId, { body: `<p>${text.en}</p>`, messageType: 'notification' });
}

function trackingColumns(field: FieldDef, value: unknown, prefix: 'old' | 'new'): Record<string, unknown> {
  const empty = value === false || value === null || value === undefined;
  switch (field.type) {
    case 'integer':
    case 'many2one':
      return { [`${prefix}_value_integer`]: empty ? null : Array.isArray(value) ? value[0] : Number(value),
        [`${prefix}_value_char`]: Array.isArray(value) ? String(value[1]) : null };
    case 'float':
    case 'monetary':
      return { [`${prefix}_value_float`]: empty ? null : Number(value) };
    case 'boolean':
      return { [`${prefix}_value_integer`]: value ? 1 : 0 };
    case 'date':
    case 'datetime':
      return { [`${prefix}_value_datetime`]: empty ? null : String(value) };
    case 'text':
    case 'html':
      return { [`${prefix}_value_text`]: empty ? null : String(value) };
    case 'selection': {
      const label = field.selection?.find((option) => option.value === value)?.label.en;
      return { [`${prefix}_value_char`]: empty ? null : String(label ?? value) };
    }
    default:
      return { [`${prefix}_value_char`]: empty ? null : String(value) };
  }
}

/** Post a "Changed X: old → new" message with its tracking values. */
export async function postTracking(env: Environment, model: string, resId: number, changes: TrackingChange[]): Promise<void> {
  if (!env.registry.models['mail.tracking.value'] || changes.length === 0) return;
  const messageId = await postMessage(env, model, resId, { body: '', messageType: 'notification' });
  if (!messageId) return;
  for (const change of changes) {
    const columns: Record<string, unknown> = {
      mail_message_id: messageId,
      field_name: change.field.name,
      field_type: change.field.type,
      ...trackingColumns(change.field, change.oldValue, 'old'),
      ...trackingColumns(change.field, change.newValue, 'new'),
      create_uid: env.uid,
      create_date: nowSql(),
    };
    const entries = Object.entries(columns);
    await env.cr.query(
      `INSERT INTO mail_tracking_value (${entries.map(([name]) => quoteIdent(name)).join(', ')}) VALUES (${entries.map(([name], index) => (name.endsWith('_datetime') || name === 'create_date' ? `$${index + 1}::timestamp` : `$${index + 1}`)).join(', ')})`,
      entries.map(([, value]) => value),
    );
  }
}

/** Remove messages, followers, activities and attachments of deleted records. */
export async function unlinkThreadData(env: Environment, model: string, ids: number[]): Promise<void> {
  const cleanups: [string, string, string][] = [
    ['mail.message', 'model', 'res_id'],
    ['mail.followers', 'res_model', 'res_id'],
    ['mail.activity', 'res_model', 'res_id'],
    ['ir.attachment', 'res_model', 'res_id'],
  ];
  for (const [modelName, modelColumn, idColumn] of cleanups) {
    const def = env.registry.models[modelName];
    if (!def?.fields[modelColumn] || !def.fields[idColumn]) continue;
    await env.cr.query(
      `DELETE FROM ${quoteIdent(def.table)} WHERE ${quoteIdent(modelColumn)} = $1 AND ${quoteIdent(idColumn)} = ANY($2)`,
      [model, ids],
    );
  }
}
