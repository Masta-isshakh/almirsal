import type { Environment } from '../../engine/orm/env.js';
import type { ActionResult, Values } from '../../engine/orm/hooks.js';
import { setMethodFallback } from '../../engine/orm/hooks.js';
import type { FieldDef, ModelDef } from '../../engine/registry/types.js';
import { BUTTON_PREFIXES as PREFIXES, stemsOf } from '../../engine/registry/stems.js';
import { openRecords, windowAction } from '../common.js';

/**
 * Generic smart buttons (Part E "smart buttons" boxes): `action_view_X`,
 * `action_open_X`, `open_X`, `action_see_X`, `button_open_X` on any model
 * open the related records without a hand-written method per button. The
 * target is found from the button name:
 *
 *  1. a relational field of the model whose name matches the stem
 *     (`action_view_invoice` → `invoice_ids`), opened by ids;
 *  2. else a model matching the stem that has a many2one back to this
 *     model (`open_payments` on a partner → account.payment.partner_id),
 *     opened by that link;
 *  3. else nothing, and the ORM reports the method as not implemented.
 */

export function matchField(def: ModelDef, stems: string[]): FieldDef | null {
  const relational = Object.values(def.fields).filter((f) => f.relation && ['one2many', 'many2many', 'many2one'].includes(f.type) && !f.sqlExpr);
  for (const stem of stems) {
    const exact = relational.find((f) => f.name === `${stem}_ids` || f.name === `${stem}_id`);
    if (exact) return exact;
  }
  for (const stem of stems) {
    // Substring matches need a meaningful stem: "do" would match "document".
    if (stem.length < 4) continue;
    const partial = relational.filter((f) => f.name.includes(stem) && !/^(message|activity|rating|website_message|create|write)_/.test(f.name));
    const x2many = partial.find((f) => f.type !== 'many2one');
    if (x2many) return x2many;
    if (partial[0]) return partial[0];
  }
  return null;
}

export function matchModel(registry: Environment['registry'], model: string, stems: string[]): { target: string; inverse: string } | null {
  for (const stem of stems) {
    if (stem.length < 4) continue;
    const table = stem.replace(/_/g, '.');
    for (const candidate of Object.values(registry.models)) {
      if (candidate.sqlView || candidate.transient) continue;
      const cname = candidate.name;
      if (!(cname === table || cname.endsWith(`.${stem.replace(/_/g, '.')}`) || cname.replace(/\./g, '_').includes(stem))) continue;
      const back = Object.values(candidate.fields).find((f) => f.type === 'many2one' && f.relation === model && !f.sqlExpr);
      if (back) return { target: cname, inverse: back.name };
    }
  }
  return null;
}

async function resolveSmartButton(env: Environment, model: string, ids: number[], method: string, _context: Values): Promise<ActionResult | void | undefined> {
  if (!PREFIXES.some((p) => method.startsWith(p)) || ids.length === 0) return undefined;
  const def = env.registry.models[model];
  if (!def) return undefined;
  const stems = stemsOf(method);
  const field = matchField(def, stems);
  if (field?.relation && env.registry.models[field.relation]) {
    const target = env.registry.models[field.relation];
    const records = await env.model(model).read(ids, [field.name]);
    if (field.type === 'many2one') {
      const targetIds = [...new Set(records.map((r) => (Array.isArray(r[field.name]) ? Number((r[field.name] as unknown[])[0]) : Number(r[field.name] || 0))).filter(Boolean))];
      if (!targetIds.length) return windowAction(field.relation, target.description, { domain: [['id', 'in', []]] });
      return openRecords(field.relation, target.description, targetIds);
    }
    const targetIds = [...new Set(records.flatMap((r) => (Array.isArray(r[field.name]) ? (r[field.name] as number[]) : [])))];
    return windowAction(field.relation, target.description, { domain: [['id', 'in', targetIds]], viewMode: viewModeFor(env, field.relation), context: field.inverse ? { [`default_${field.inverse}`]: ids[0] } : undefined });
  }
  const link = matchModel(env.registry, model, stems);
  if (link) {
    const target = env.registry.models[link.target];
    return windowAction(link.target, target.description, { domain: [[link.inverse, 'in', ids]], viewMode: viewModeFor(env, link.target), context: { [`default_${link.inverse}`]: ids[0] } });
  }
  return undefined;
}

/** The registry's first window action for the model decides the default views. */
function viewModeFor(env: Environment, model: string): string {
  const action = Object.values(env.registry.actions).find((a) => a.type === 'act_window' && a.model === model && a.viewMode?.length);
  const modes = action?.viewMode ?? ['list', 'form'];
  const ordered = [...modes.filter((m) => m !== 'form'), 'form'];
  return ordered.join(',');
}

export function registerSmartButtons(): void {
  setMethodFallback(resolveSmartButton);
}
