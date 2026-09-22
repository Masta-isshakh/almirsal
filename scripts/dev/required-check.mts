/**
 * Required fields a user could never fill: for every model with a form view,
 * the required fields that have no default and do not appear in the form.
 *
 *   npx tsx scripts/dev/required-check.mts
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

function archFields(node: unknown, model: string, out: Set<string>, depth = 0): void {
  if (!node || typeof node !== 'object' || depth > 14) return;
  if (Array.isArray(node)) { for (const n of node) archFields(n, model, out, depth + 1); return; }
  const obj = node as Record<string, unknown>;
  if (obj.kind === 'field' && typeof obj.name === 'string') {
    const inv = obj.invisible;
    const hiddenOnNew = inv === true || inv === '1' || inv === 'True' || inv === 'not id' || inv === '1 == 1';
    if (!hiddenOnNew) out.add(obj.name);
    return; // sub-views belong to the comodel
  }
  for (const value of Object.values(obj)) if (value && typeof value === 'object') archFields(value, model, out, depth + 1);
}

const models = new Set<string>(Object.values(registry.views).filter((v) => v.type === 'form').map((v) => v.model));
let problems = 0;
for (const model of [...models].sort()) {
  const def = registry.models[model];
  if (!def || def.transient || def.sqlView) continue;
  const forms = Object.values(registry.views).filter((v) => v.model === model && v.type === 'form');
  if (!forms.length) continue;
  const inForm = new Set<string>();
  for (const view of forms) archFields(view.arch, model, inForm);
  let defaults: Record<string, unknown> = {};
  try { defaults = await env.model(model).defaultGet(); } catch (e) { console.log(`${model}: defaultGet failed ${String((e as Error).message).slice(0, 100)}`); continue; }
  const missing = Object.values(def.fields).filter((f) => f.required === true && !f.sqlExpr && !(f as { readonly?: boolean }).readonly && !(defaults[f.name] !== undefined && defaults[f.name] !== null && defaults[f.name] !== false) && !inForm.has(f.name) && f.name !== 'id');
  const readonlyRequired = Object.values(def.fields).filter((f) => f.required === true && (f as { readonly?: boolean }).readonly === true && !f.sqlExpr && !(defaults[f.name] !== undefined && defaults[f.name] !== null && defaults[f.name] !== false));
  if (readonlyRequired.length) console.log(`${model}: READONLY+REQUIRED without default: ${readonlyRequired.map((f) => f.name).join(', ')}`);
  if (missing.length) { problems++; console.log(`${model}: ${missing.map((f) => `${f.name}(${f.type}${f.relation ? '→' + f.relation : ''})`).join(', ')}`); }
}
console.log(`${problems} model(s) with unfillable required fields`);
await db.close?.();
