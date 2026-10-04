/**
 * Fields a screen shows that nothing ever fills. Odoo computes them in Python;
 * the export carries the field and the view but not the compute, so unless this
 * build supplies one — a compute hook, a SQL expression, a related path, or code
 * that writes it — the column stays blank and every condition that reads it
 * sees False (a Confirm button on a posted invoice, a Reset to Draft that never
 * shows).
 *
 *   npx tsx scripts/dev/dead-fields.mts [model-prefix ...]
 *
 * With no argument every model is checked; `account res.partner` narrows it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getRegistry } from '../../lib/server/registry.js';
import { hooksFor } from '../../packages/engine/orm/hooks.js';
import { registerApps } from '../../packages/apps/index.js';

const registry = getRegistry();
registerApps(registry);
const prefixes = process.argv.slice(2);

/** Every app source, to find fields some code writes by name. */
const sources: string[] = [];
const walkFiles = (dir: string): void => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { walkFiles(path); continue; }
    if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name)) sources.push(readFileSync(path, 'utf8'));
  }
};
walkFiles('packages/apps');
walkFiles('lib/server');
const source = sources.join('\n');

/** Where each field is read by a view: as a column, a form field, or inside a condition. */
const uses = new Map<string, Set<string>>();
const note = (model: string, field: string, how: string): void => {
  const key = `${model}.${field}`;
  if (!uses.has(key)) uses.set(key, new Set());
  uses.get(key)!.add(how);
};
const CONDITION_KEYS = ['invisible', 'readonly', 'required', 'columnInvisible', 'column_invisible'];
const identifiers = (expr: string): string[] => [...expr.matchAll(/\b([a-z_][a-z0-9_]*)\b/g)].map((m) => m[1]);

const walk = (node: unknown, model: string, where: string): void => {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((item) => walk(item, model, where)); return; }
  const obj = node as Record<string, unknown>;
  if (obj.kind === 'field' && typeof obj.name === 'string') note(model, obj.name, where);
  for (const key of CONDITION_KEYS) {
    const expr = obj[key];
    if (typeof expr === 'string') for (const name of identifiers(expr)) if (registry.models[model]?.fields[name]) note(model, name, `${where} condition`);
  }
  // A nested list reads against its own model.
  const nested = obj.views as Record<string, unknown> | undefined;
  if (nested && obj.kind === 'field' && typeof obj.name === 'string') {
    const relation = registry.models[model]?.fields[obj.name]?.relation;
    if (relation) { for (const view of Object.values(nested)) walk(view, relation, 'embedded'); return; }
  }
  for (const value of Object.values(obj)) if (value && typeof value === 'object') walk(value, model, where);
};
for (const view of Object.values(registry.views)) {
  if (!['list', 'form', 'kanban'].includes(view.type)) continue;
  walk(view.arch, view.model, view.type);
}

const computed = (model: string): Set<string> => new Set((hooksFor(model).computes ?? []).flatMap((compute) => compute.fields));
const dead: { model: string; field: string; type: string; how: string }[] = [];
for (const [key, how] of uses) {
  const [model, field] = [key.slice(0, key.lastIndexOf('.')), key.slice(key.lastIndexOf('.') + 1)];
  if (prefixes.length && !prefixes.some((prefix) => model.startsWith(prefix))) continue;
  const def = registry.models[model]?.fields[field];
  if (!def || !def.readonly) continue;                      // editable: a person fills it
  if (def.sqlExpr || def.related) continue;                 // filled by the reader
  if (['one2many', 'many2many'].includes(def.type) && def.inverse) continue; // read through the link
  if (['id', 'display_name', 'create_date', 'write_date', 'create_uid', 'write_uid'].includes(field)) continue;
  if (computed(model).has(field)) continue;                 // an app computes it
  if (new RegExp(`['"\`]${field}['"\`]|\\b${field}\\s*:`).test(source)) continue; // some code writes it by name
  dead.push({ model, field, type: def.type, how: [...how].join(', ') });
}

dead.sort((a, b) => a.model.localeCompare(b.model) || a.field.localeCompare(b.field));
const byModel = new Map<string, typeof dead>();
for (const row of dead) { if (!byModel.has(row.model)) byModel.set(row.model, []); byModel.get(row.model)!.push(row); }
console.log(`${dead.length} fields shown or read by a view that nothing fills`);
for (const [model, rows] of byModel) {
  console.log(`\n${model} (${rows.length})`);
  for (const row of rows) console.log(`  ${row.field.padEnd(42)} ${row.type.padEnd(10)} ${row.how}`);
}
