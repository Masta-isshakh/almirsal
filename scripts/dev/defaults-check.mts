/**
 * Required fields with no default: the reason a form can refuse to save with
 * a message about a field the person never saw. Odoo gives such fields a
 * default in the model; this lists the ones we still have to.
 *
 *   npx tsx scripts/dev/defaults-check.mts          # the ones a form can't fill
 *   npx tsx scripts/dev/defaults-check.mts --all    # every required field with no default
 */
import { readFileSync } from 'node:fs';
import { loadRegistry } from '../../packages/engine/registry/spec-loader.js';
import { pgliteDatabase } from '../../packages/engine/db/pglite.js';
import { syncSchema } from '../../packages/engine/schema/ddl.js';
import { loadSeed } from '../../packages/engine/seed/load.js';
import { Environment } from '../../packages/engine/orm/env.js';
import { registerApps } from '../../packages/apps/index.js';

const registry = loadRegistry(JSON.parse(readFileSync('registry/odoo_spec.json', 'utf8')), JSON.parse(readFileSync('registry/extra-models.json', 'utf8')));
const db = pgliteDatabase();
await syncSchema(db, registry);
await loadSeed(db, registry);
registerApps(registry);
const env = new Environment({ registry, db, uid: 2, companyIds: [1], superuser: true });
const all = process.argv.includes('--all');

/** Where a field sits in a form: on the sheet, behind a tab, hidden, or absent. */
function placeInForm(node: unknown, out: Map<string, string>, where = 'sheet', depth = 0): void {
  if (!node || typeof node !== 'object' || depth > 16) return;
  if (Array.isArray(node)) { for (const item of node) placeInForm(item, out, where, depth + 1); return; }
  const obj = node as Record<string, unknown>;
  if (obj.kind === 'field' && typeof obj.name === 'string') {
    const invisible = obj.invisible;
    const hidden = obj.hidden === true || invisible === true || invisible === '1' || invisible === 'True';
    const place = hidden ? 'hidden' : where;
    if (!out.has(obj.name) || out.get(obj.name) === 'hidden') out.set(obj.name, place);
    return;
  }
  const next = obj.kind === 'notebook' || obj.tag === 'notebook' || obj.kind === 'page' ? 'tab' : where;
  for (const value of Object.values(obj)) if (value && typeof value === 'object') placeInForm(value, out, next, depth + 1);
}

const models = [...new Set(Object.values(registry.views).filter((v) => v.type === 'form').map((v) => v.model))].sort();
const rows: { model: string; field: string; type: string; place: string; options?: string }[] = [];

for (const model of models) {
  const def = registry.models[model];
  if (!def || def.sqlView) continue;
  const place = new Map<string, string>();
  for (const view of Object.values(registry.views)) {
    if (view.model === model && view.type === 'form') placeInForm(view.arch, place);
  }
  let defaults: Record<string, unknown> = {};
  try { defaults = await env.model(model).defaultGet(); } catch { continue; }
  const hasDefault = (name: string) => {
    const value = defaults[name];
    return value !== undefined && value !== null && value !== false && value !== '';
  };
  for (const field of Object.values(def.fields)) {
    if (field.required !== true || field.sqlExpr || field.name === 'id') continue;
    if (hasDefault(field.name) || field.default !== undefined) continue;
    const spot = place.get(field.name) ?? 'absent';
    // A field the person can see and type into is theirs to fill.
    if (!all && spot === 'sheet') continue;
    rows.push({
      model, field: field.name, type: field.type, place: spot,
      options: field.selection?.map((o) => o.value).join('|').slice(0, 60),
    });
  }
}

const byPlace = rows.reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.place]: (acc[row.place] ?? 0) + 1 }), {});
console.log(`${rows.length} required field(s) with no default`, JSON.stringify(byPlace));
for (const row of rows) console.log(`  ${row.model}.${row.field} (${row.type}${row.options ? ': ' + row.options : ''}) — ${row.place}`);
await db.close?.();
