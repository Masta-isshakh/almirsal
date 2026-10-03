/**
 * Can each model be created the way a form creates it — a name and whatever
 * the model fills in itself? Anything else means a person pressing New and
 * Save is told about a field they cannot see.
 *
 *   npx tsx scripts/dev/create-probe.mts
 *
 * Models that exist only as lines of a parent record (loan lines, survey
 * answers) are listed apart: they are never created from their own screen.
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

/** Where a field sits in a form: on the sheet, behind a tab, hidden, absent. */
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

/** Records a screen never creates on its own: they belong to a parent. */
const LINE_MODELS = /\.(line|lines|item|items|value|values|tag|answer|attendee|message)$/;

const models = [...new Set(Object.values(registry.views).filter((v) => v.type === 'form').map((v) => v.model))].sort();
const blocked: { model: string; message: string; unreachable?: string[] }[] = [];
const lines: string[] = [];
let created = 0;

for (const model of models) {
  const def = registry.models[model];
  if (!def || def.sqlView) continue;
  const values: Record<string, unknown> = {};
  if (def.fields.name && ['char', 'text'].includes(def.fields.name.type)) values.name = `Probe ${model}`;
  try {
    const id = await env.model(model).create(values);
    created += 1;
    await env.model(model).unlink([id]).catch(() => undefined);
  } catch (error) {
    const message = String((error as { i18n?: { en?: string }; message?: string }).i18n?.en ?? (error as Error).message ?? error).replace(/\s+/g, ' ').slice(0, 120);
    const refused = ((error as { data?: { fields?: unknown } }).data?.fields ?? []) as string[];
    const place = new Map<string, string>();
    for (const view of Object.values(registry.views)) {
      if (view.model === model && view.type === 'form') placeInForm(view.arch, place);
    }
    // A field the person can see and fill is theirs to fill; anything else
    // makes the screen refuse to save for a reason they cannot act on.
    const unreachable = refused.filter((name) => (place.get(name) ?? 'absent') !== 'sheet')
      .map((name) => `${name}(${place.get(name) ?? 'absent'})`);
    if (LINE_MODELS.test(model)) lines.push(`${model}: ${message}`);
    else blocked.push({ model, message, unreachable });
  }
}

const unreachable = blocked.filter((row) => row.unreachable?.length);
console.log(`${models.length} models with a form: ${created} create from a name alone, ${blocked.length} ask for more, ${lines.length} are lines of a parent`);
console.log(`${unreachable.length} ask for a field the form does not show:`);
for (const row of unreachable) console.log(`  ${row.model}: ${row.unreachable!.join(', ')} — ${row.message}`);
if (process.argv.includes('--all')) for (const row of blocked) console.log(`  (asks) ${row.model}: ${row.message}`);
if (lines.length) console.log(`\nlines of a parent (expected):\n  ${lines.join('\n  ')}`);
await db.close?.();
