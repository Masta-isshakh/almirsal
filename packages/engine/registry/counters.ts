import type { FieldDef, ModelDef } from './types.js';
import { stemsOf } from './stems.js';

/**
 * The counters beside a smart button ("3 Contracts", "5 Variants") and in the
 * conditions that hide it (`invisible="contract_count == 0"`). Odoo computes one
 * per counter; what they have in common is the thing they count, which is the
 * relation the button opens — so the count is read from that relation, as a SQL
 * expression, and is therefore never stale.
 *
 * A counter the export already computes in SQL is left alone, and so is one
 * whose name says it counts a subset ("closed_subtask_count") or belongs to a
 * related record ("partner_bill_count"), because a count of everything would put
 * a wrong number on the screen.
 */

/** A word like this means a subset, which a plain count cannot express. */
const QUALIFIERS = new Set([
  'closed', 'open', 'opened', 'active', 'inactive', 'granted', 'success', 'successful', 'failed', 'failure', 'tentative',
  'awaiting', 'overlap', 'answered', 'random', 'unread', 'needaction', 'correct', 'incorrect', 'late', 'overdue',
  'remaining', 'total', 'declined', 'accepted', 'draft', 'posted', 'paid', 'unpaid', 'done', 'todo', 'expired', 'valid',
  'without', 'with', 'non', 'not', 'my',
]);

/** What a counter counts, or null when nothing can be said for certain. */
export function counterSource(models: Record<string, ModelDef>, model: ModelDef, counter: string): string | null {
  const stem = counter.slice(0, -'_count'.length);
  if (!stem) return null;
  const words = stem.split('_');
  if (words.some((word) => QUALIFIERS.has(word))) return null;
  // `partner_bill_count` counts the partner's bills, not this record's.
  if (words.length > 1 && model.fields[`${words[0]}_id`]?.type === 'many2one') return null;
  const stems = stemsOf(stem);

  // 1. A list on this model whose name is the thing counted. The match is
  // exact: a counter of alias domains must not count alias tags.
  for (const candidate of stems) {
    const field = model.fields[`${candidate}_ids`];
    if (!field?.relation || field.sqlExpr || field.type === 'many2one') continue;
    if (/^(message|activity|website_message)_/.test(field.name)) continue;
    const target = models[field.relation];
    if (!target || target.sqlView) continue;
    // A polymorphic link (res_model + res_id) cannot be counted by id alone.
    if (field.type === 'one2many' && field.inverse && field.inverse !== 'res_id') {
      return `SELECT count(*) FROM "${target.table}" WHERE "${field.inverse}" = {alias}."id"`;
    }
    if (field.type === 'many2many' && field.m2mTable) {
      return `SELECT count(*) FROM "${field.m2mTable}" WHERE "${field.m2mColumn1}" = {alias}."id"`;
    }
  }

  // 2. Else the model the counter names, counted through its link back here.
  // The model's last name has to be the thing counted: `fleet.vehicle` counts
  // for a model's vehicles, `fleet.vehicle.log.services` does not. A model of
  // the same family comes first, so a work calendar counts `resource.resource`
  // rather than `appointment.resource`.
  const family = model.name.split('.')[0];
  const candidates = Object.values(models)
    .filter((target) => !target.sqlView && !target.transient)
    .sort((a, b) => Number(b.name.startsWith(`${family}.`)) - Number(a.name.startsWith(`${family}.`)) || a.name.length - b.name.length);
  for (const candidate of stems) {
    if (candidate.length < 4) continue;
    for (const target of candidates) {
      if (target.name.split('.').pop() !== candidate.replace(/_/g, '.').split('.').pop()) continue;
      const back = Object.values(target.fields).find((field) => field.type === 'many2one' && field.relation === model.name && !field.sqlExpr && field.name !== 'res_id');
      if (!back) continue;
      return `SELECT count(*) FROM "${target.table}" WHERE "${back.name}" = {alias}."id"`;
    }
  }
  return null;
}

/** Give every counter that nothing else fills its counting expression. */
export function addCounterExpressions(models: Record<string, ModelDef>): number {
  let filled = 0;
  for (const model of Object.values(models)) {
    if (model.sqlView || model.transient) continue;
    for (const field of Object.values(model.fields) as FieldDef[]) {
      if (!/_count$/.test(field.name) || field.type !== 'integer' || field.sqlExpr || field.related) continue;
      const source = counterSource(models, model, field.name);
      if (!source) continue;
      field.sqlExpr = source;
      field.store = false;
      field.readonly = true;
      filled += 1;
    }
  }
  return filled;
}
