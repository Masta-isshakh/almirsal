import { registerModelHooks } from '../../engine/orm/hooks.js';
import type { Environment } from '../../engine/orm/env.js';
import { UserError } from '../../engine/orm/errors.js';
import { postMessage } from '../../engine/orm/mail.js';
import { PyDate, applyRelativeDelta, RelativeDelta } from '../../engine/expr/pydate.js';
import { quoteIdent } from '../../engine/schema/ddl.js';
import { paramExpr } from '../../engine/orm/values.js';
import { m2oId } from './index.js';

/**
 * Activities (Part G / A-4 §17): `mail.activity` defaults from the activity
 * type, "Mark Done" posts a note in the record's chatter and can chain the
 * next activity, and the `activity_state` / `activity_date_deadline` /
 * `activity_user_id` columns of the document are kept up to date.
 */

/** Date column value (string or Date, depending on the driver) → YYYY-MM-DD. */
export function isoDate(value: unknown): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

export function today(env: Environment): PyDate {
  void env;
  return PyDate.parse(new Date().toISOString().slice(0, 10))!;
}

async function irModelId(env: Environment, model: string): Promise<number | null> {
  if (!env.registry.models['ir.model']) return null;
  const row = await env.cr.query<{ id: number }>(`SELECT id FROM ir_model WHERE model = $1 LIMIT 1`, [model]);
  return row.rows[0] ? Number(row.rows[0].id) : null;
}

async function irModelName(env: Environment, id: number): Promise<string | null> {
  const row = await env.cr.query<{ model: string }>(`SELECT model FROM ir_model WHERE id = $1`, [id]);
  return row.rows[0]?.model ?? null;
}

/** Deadline from an activity type's delay (count + unit) counted from today or the previous deadline. */
async function deadlineFor(env: Environment, typeId: number | false, from: PyDate): Promise<string> {
  if (!typeId) return from.toString();
  const row = await env.cr.query<{ delay_count: number | null; delay_unit: string | null }>(`SELECT delay_count, delay_unit FROM mail_activity_type WHERE id = $1`, [typeId]);
  const type = row.rows[0];
  if (!type) return from.toString();
  const count = Number(type.delay_count ?? 0);
  const unit = type.delay_unit ?? 'days';
  const delta = unit === 'weeks' ? new RelativeDelta({ weeks: count }) : unit === 'months' ? new RelativeDelta({ months: count }) : new RelativeDelta({ days: count });
  return applyRelativeDelta(from, delta).toString();
}

/** Recompute the document's activity summary columns after any change to its activities. */
export async function refreshActivityState(env: Environment, model: string, resIds: number[]): Promise<void> {
  const def = env.registry.models[model];
  if (!def || !def.fields.activity_state || resIds.length === 0) return;
  const now = today(env).toString();
  const rows = await env.cr.query<{ res_id: number; date_deadline: string; user_id: number | null; activity_type_id: number | null }>(
    `SELECT DISTINCT ON (res_id) res_id, date_deadline, user_id, activity_type_id FROM mail_activity
     WHERE res_model = $1 AND res_id = ANY($2) AND coalesce(active, true) ORDER BY res_id, date_deadline ASC, id ASC`,
    [model, resIds],
  );
  const byId = new Map(rows.rows.map((row) => [Number(row.res_id), row]));
  const cols = ['activity_state', 'activity_date_deadline', 'activity_user_id', 'activity_type_id'].filter((name) => def.fields[name]);
  for (const id of resIds) {
    const next = byId.get(id);
    const deadline = next ? isoDate(next.date_deadline) : null;
    const state = !deadline ? null : deadline < now ? 'overdue' : deadline === now ? 'today' : 'planned';
    const values: Record<string, unknown> = {
      activity_state: state, activity_date_deadline: deadline, activity_user_id: next?.user_id ?? null, activity_type_id: next?.activity_type_id ?? null,
    };
    const sets = cols.map((name, index) => `${quoteIdent(name)} = ${paramExpr(def.fields[name], `$${index + 2}`)}`);
    if (sets.length) await env.cr.query(`UPDATE ${quoteIdent(def.table)} SET ${sets.join(', ')} WHERE id = $1`, [id, ...cols.map((name) => values[name])]);
  }
}

/** Refresh the documents behind a set of activities. */
async function refreshDocuments(env: Environment, ids: number[]): Promise<void> {
  const rows = await env.cr.query<{ res_model: string; res_id: number }>(`SELECT res_model, res_id FROM mail_activity WHERE id = ANY($1)`, [ids]);
  const byModel = new Map<string, Set<number>>();
  for (const row of rows.rows) { const set = byModel.get(row.res_model) ?? new Set<number>(); set.add(Number(row.res_id)); byModel.set(row.res_model, set); }
  for (const [model, docIds] of byModel) await refreshActivityState(env, model, [...docIds]);
}

export function registerActivities(): void {
  registerModelHooks('mail.activity', {
    defaults: async (env) => {
      const context = env.context;
      const model = typeof context.default_res_model === 'string' ? context.default_res_model : typeof context.active_model === 'string' ? context.active_model : null;
      const resId = typeof context.default_res_id === 'number' ? context.default_res_id : typeof context.active_id === 'number' ? context.active_id : null;
      const todo = await env.cr.query<{ id: number }>(`SELECT id FROM mail_activity_type WHERE coalesce(active, true) ORDER BY CASE WHEN name = 'To-Do' THEN 0 ELSE 1 END, id LIMIT 1`);
      const typeId = todo.rows[0] ? Number(todo.rows[0].id) : false;
      return {
        user_id: env.uid,
        activity_type_id: typeId,
        date_deadline: await deadlineFor(env, typeId, today(env)),
        res_model: model ?? false,
        res_model_id: model ? await irModelId(env, model) ?? false : false,
        res_id: resId ?? false,
        active: true,
      };
    },
    displayName: (_env, record) => String(record.summary || record.res_name || 'Activity'),
    displayNameFields: ['summary', 'res_name'],
    onchange: {
      activity_type_id: async (env, values) => {
        const typeId = m2oId(values.activity_type_id);
        if (!typeId) return {};
        const row = await env.cr.query<{ summary: string | null; default_note: string | null }>(`SELECT summary, default_note FROM mail_activity_type WHERE id = $1`, [typeId]);
        const type = row.rows[0];
        return { value: { date_deadline: await deadlineFor(env, typeId, today(env)), ...(type?.summary && !values.summary ? { summary: type.summary } : {}), ...(type?.default_note && !values.note ? { note: type.default_note } : {}) } };
      },
    },
    beforeCreate: async (env, vals) => {
      const out = { ...vals };
      if (!out.res_model && out.res_model_id) out.res_model = await irModelName(env, Number(m2oId(out.res_model_id)));
      if (out.res_model && !out.res_model_id) out.res_model_id = (await irModelId(env, String(out.res_model))) ?? false;
      if (!out.res_model || !out.res_id) throw new UserError({ en: 'An activity must be linked to a document.', ar: 'يجب ربط النشاط بمستند.' });
      if (!out.date_deadline) out.date_deadline = await deadlineFor(env, m2oId(out.activity_type_id), today(env));
      if (!out.user_id) out.user_id = env.uid;
      if (out.active === undefined) out.active = true;
      const model = String(out.res_model);
      if (env.registry.models[model]) {
        const names = await env.model(model).displayNames([Number(out.res_id)]);
        out.res_name = names.get(Number(out.res_id)) ?? '';
      }
      return out;
    },
    onCreate: async (env, ids) => refreshDocuments(env, ids),
    onWrite: async (env, ids) => refreshDocuments(env, ids),
    onUnlink: async (env, ids) => {
      const rows = await env.cr.query<{ res_model: string; res_id: number }>(`SELECT res_model, res_id FROM mail_activity WHERE id = ANY($1)`, [ids]);
      // Refresh after the delete: mark them deleted first so the refresh ignores them.
      await env.cr.query(`UPDATE mail_activity SET active = false WHERE id = ANY($1)`, [ids]);
      const byModel = new Map<string, Set<number>>();
      for (const row of rows.rows) { const set = byModel.get(row.res_model) ?? new Set<number>(); set.add(Number(row.res_id)); byModel.set(row.res_model, set); }
      for (const [model, docIds] of byModel) await refreshActivityState(env, model, [...docIds]);
    },
    methods: {
      /** Mark done: log the feedback in the chatter, archive the activity, chain the next one if the type says so. */
      action_done: async (env, ids, context) => {
        const feedback = typeof context.feedback === 'string' ? context.feedback : '';
        const rows = await env.model('mail.activity').read(ids, ['res_model', 'res_id', 'summary', 'activity_type_id', 'user_id', 'date_deadline', 'note']);
        for (const row of rows) {
          const model = String(row.res_model);
          const resId = Number(row.res_id);
          const typeName = Array.isArray(row.activity_type_id) ? String(row.activity_type_id[1]) : '';
          const body = `<div class="o_mail_activity_done"><span class="fw-bold">${escapeHtml(String(row.summary || typeName || 'Activity'))}</span> done${feedback ? `<br/><em>${escapeHtml(feedback)}</em>` : ''}</div>`;
          if (env.registry.models[model]) await postMessage(env, model, resId, { body, messageType: 'comment', isInternal: true, subject: 'Activity done' });
          await env.cr.query(`UPDATE mail_activity SET active = false, date_done = $2::date WHERE id = $1`, [row.id, today(env).toString()]);
          // Chain the next activity (type.triggered_next_type_id) when configured.
          const typeId = m2oId(row.activity_type_id);
          if (typeId && env.registry.models['mail.activity.type']?.fields.triggered_next_type_id) {
            const next = await env.cr.query<{ triggered_next_type_id: number | null; chaining_type: string | null }>(`SELECT triggered_next_type_id, chaining_type FROM mail_activity_type WHERE id = $1`, [typeId]);
            const nextType = next.rows[0]?.triggered_next_type_id;
            if (nextType && (next.rows[0]?.chaining_type ?? 'suggest') === 'trigger') {
              await env.model('mail.activity').create({ res_model: model, res_id: resId, activity_type_id: Number(nextType), user_id: m2oId(row.user_id) || env.uid, date_deadline: await deadlineFor(env, Number(nextType), PyDate.parse(isoDate(row.date_deadline)) ?? today(env)) });
            }
          }
          await refreshActivityState(env, model, [resId]);
        }
        return { type: 'ir.actions.act_window_close' };
      },
      action_close_dialog: async () => ({ type: 'ir.actions.act_window_close' }),
      action_open_document: async (env, ids) => {
        const rows = await env.model('mail.activity').read(ids, ['res_model', 'res_id']);
        const first = rows[0];
        if (!first?.res_model || !first.res_id) return { type: 'ir.actions.act_window_close' };
        return { type: 'ir.actions.act_window', res_model: String(first.res_model), res_id: Number(first.res_id), view_mode: 'form', target: 'current' };
      },
      action_create_calendar_event: async () => {
        throw new UserError({ en: 'Meetings need the Calendar app; schedule the activity as a To-Do or Call instead.', ar: 'تتطلب الاجتماعات تطبيق التقويم؛ قم بجدولة النشاط كمهمة أو مكالمة بدلاً من ذلك.' });
      },
      action_done_schedule_next: async (env, ids, context) => {
        const rows = await env.model('mail.activity').read(ids, ['res_model', 'res_id']);
        await env.model('mail.activity').callButton(ids, 'action_done', context);
        const first = rows[0];
        if (!first) return { type: 'ir.actions.act_window_close' };
        return {
          type: 'ir.actions.act_window', res_model: 'mail.activity', view_mode: 'form', target: 'new', name: { en: 'Schedule Activity', ar: 'جدولة نشاط' },
          context: { default_res_model: first.res_model, default_res_id: first.res_id },
        };
      },
    },
  });
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
