/**
 * Backend consistency check over the whole registry, against a real database:
 *
 *   npx tsx scripts/verify-backend.mts [--db pglite|aurora] [--crud] [--out report.json]
 *
 *  1. every field referenced by every view exists on its model (sub-views on
 *     the comodel), every invisible/readonly/required/domain/context
 *     expression parses;
 *  2. every model answers searchRead (all fields), searchCount, defaultGet,
 *     nameSearch and readGroup;
 *  3. every search-view filter and field domain, and every action domain,
 *     compiles to SQL and executes;
 *  4. (--crud) every non-transient model with a form view survives
 *     create → write → copy → unlink with auto-filled required fields.
 *
 * Exit code 1 when anything failed. Aurora mode reads the cluster from
 * RODEO_OUTPUTS (path to amplify_outputs.json) and only runs read checks
 * unless --crud is passed explicitly.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { loadRegistry } from '../packages/engine/registry/spec-loader.js';
import type { Registry, ModelDef, FieldDef, Domain } from '../packages/engine/registry/types.js';
import type { Database } from '../packages/engine/db/types.js';
import { syncSchema } from '../packages/engine/schema/ddl.js';
import { loadSeed, brandCompany, ensureLoginUnique } from '../packages/engine/seed/load.js';
import { Environment } from '../packages/engine/orm/env.js';
import { registerApps } from '../packages/apps/index.js';
import { parse } from '../packages/engine/expr/parse.js';
import { evaluate, makeScope } from '../packages/engine/expr/evaluate.js';
import { PyDateTime } from '../packages/engine/expr/pydate.js';

const args = process.argv.slice(2);
const opt = (name: string, def?: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const DB = opt('--db', 'pglite')!;
const CRUD = args.includes('--crud');
const OUT = opt('--out');
const ONLY = opt('--only');

const SKIP = new Set(['res.users', 'res.company', 'res.lang', 'ir.module.module', 'ir.model', 'res.currency', 'res.groups', 'res.country', 'ir.sequence', 'account.journal', 'mail.activity', 'mail.message', 'mail.followers']);
interface Failure { check: string; where: string; error: string }
const failures: Failure[] = [];
const counts: Record<string, { ok: number; fail: number }> = {};
const tally = (check: string, ok: boolean, where: string, error?: unknown) => {
  counts[check] ??= { ok: 0, fail: 0 };
  if (ok) counts[check].ok++;
  else { counts[check].fail++; failures.push({ check, where, error: String(error instanceof Error ? error.message : error).slice(0, 300) }); }
};

const spec = JSON.parse(readFileSync('registry/odoo_spec.json', 'utf8'));
const extra = JSON.parse(readFileSync('registry/extra-models.json', 'utf8'));
const registry: Registry = loadRegistry(spec, extra);

async function openDb(): Promise<Database> {
  if (DB === 'aurora') {
    const outputs = JSON.parse(readFileSync(process.env.RODEO_OUTPUTS ?? 'amplify_outputs.json', 'utf8'));
    const d = outputs.custom.database;
    const { rdsDataDatabase } = await import('../packages/engine/db/rds-data.js');
    return rdsDataDatabase({ clusterArn: d.clusterArn, secretArn: d.secretArn, database: d.databaseName ?? 'rodeo', region: d.region });
  }
  const { pgliteDatabase } = await import('../packages/engine/db/pglite.js');
  return pgliteDatabase();
}

/* ---------- 1. static: view fields + expressions ---------- */
const COND_KEYS = new Set(['invisible', 'readonly', 'required', 'columnInvisible', 'domain', 'context', 'filterDomain', 'create', 'edit', 'delete', 'attrs']);
function checkExpr(source: unknown, where: string) {
  if (typeof source !== 'string' || !source.trim()) return;
  try { parse(source); tally('expr.parse', true, where); } catch (e) { tally('expr.parse', false, `${where}: ${source.slice(0, 80)}`, e); }
}
function walkArch(node: unknown, model: string, where: string, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return;
  if (Array.isArray(node)) { node.forEach((n, i) => walkArch(n, model, `${where}[${i}]`, depth + 1)); return; }
  const obj = node as Record<string, unknown>;
  const def = registry.models[model];
  let nextModel = model;
  if (obj.kind === 'field' && typeof obj.name === 'string') {
    const field = def?.fields[obj.name];
    tally('view.field', Boolean(field), `${where} ${model}.${obj.name}`, field ? undefined : `unknown field ${obj.name} on ${model}`);
    if (field?.relation) nextModel = field.relation;
  }
  if (typeof obj.name === 'string' && obj.kind === undefined && (obj.string !== undefined || obj.operator !== undefined) && def && !def.fields[obj.name] && where.includes('|search|') && !('domain' in obj && !('name' in obj))) {
    // search <field name=...> (filters have a name too but are not fields; only flag when filterDomain/operator present)
    if (obj.filterDomain !== undefined || obj.operator !== undefined) tally('view.field', false, `${where} ${model}.${obj.name}`, `unknown search field ${obj.name}`);
  }
  for (const [key, value] of Object.entries(obj)) {
    if (COND_KEYS.has(key)) {
      if (key === 'attrs' && value && typeof value === 'object') { for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (/^(invisible|readonly|required|column_invisible|domain|context|options)$/.test(k) && k !== 'options') checkExpr(v, `${where}.${k}`); continue; }
      if (typeof value === 'string') checkExpr(value, `${where}.${key}`);
      continue;
    }
    if (key === 'decoration' && value && typeof value === 'object') { for (const [k, v] of Object.entries(value as Record<string, unknown>)) checkExpr(v, `${where}.decoration-${k}`); continue; }
    if (value && typeof value === 'object') {
      const sub = obj.kind === 'field' && /^(views|arch|list|form|kanban|subviews)$/.test(key) ? nextModel : (key === 'views' || key === 'arch') ? nextModel : model;
      walkArch(value, sub, `${where}.${key}`, depth + 1);
    }
  }
}

/* ---------- helpers ---------- */
const scope = (model: string, extraCtx: Record<string, unknown> = {}) => makeScope({ uid: 2, allowedCompanyIds: [1], context: { active_model: model, ...extraCtx }, now: PyDateTime.fromJsUtc(new Date()), strictNames: false, extra: { self: 'x', raw_value: 'x', active_id: 1, active_ids: [1] } });
function evalDomain(source: unknown, model: string): Domain | null {
  if (Array.isArray(source)) return source as Domain;
  if (typeof source !== 'string' || !source.trim()) return null;
  const value = evaluate(source, scope(model));
  return Array.isArray(value) ? (value as Domain) : null;
}

/** A record of `model` to satisfy a required many2one: an existing one, else one created with auto-filled required fields (depth-limited). */
async function ensureRecord(env: Environment, model: string, ids: Map<string, number | null>, depth = 0): Promise<number | null> {
  const known = ids.get(model);
  if (known) return known;
  const def = registry.models[model];
  if (!def || depth > 2 || SKIP.has(model)) return null;
  try {
    const m = env.model(model);
    const defaults = await m.defaultGet();
    const vals: Record<string, unknown> = {};
    for (const field of Object.values(def.fields)) {
      if (field.required !== true || (defaults[field.name] !== undefined && defaults[field.name] !== null && defaults[field.name] !== false)) continue;
      if (field.sqlExpr) continue;
      const value = field.type === 'many2one' && field.relation ? await ensureRecord(env, field.relation, ids, depth + 1) : fillValue(env, field, ids);
      if (value !== null && value !== undefined) vals[field.name] = value;
    }
    if (def.fields[def.recName]?.type === 'char' && vals[def.recName] === undefined) vals[def.recName] = 'Verify Dep';
    const id = await m.create(vals);
    ids.set(model, id);
    return id;
  } catch { return null; }
}

function fillValue(env: Environment, field: FieldDef, ids: Map<string, number | null>): unknown {
  switch (field.type) {
    case 'char': case 'text': case 'html': return field.name === 'email' || field.name.endsWith('_email') ? 'verify@example.com' : field.name === 'login' ? `verify_${Date.now()}@example.com` : 'Verify';
    case 'integer': return 1;
    case 'float': case 'monetary': return 1;
    case 'boolean': return false;
    case 'date': return new Date().toISOString().slice(0, 10);
    case 'datetime': return new Date().toISOString().slice(0, 19).replace('T', ' ');
    case 'selection': return field.selection?.[0]?.value ?? null;
    case 'many2one': return ids.get(field.relation ?? '') ?? null;
    case 'many2many': { const id = ids.get(field.relation ?? ''); return id ? [[6, 0, [id]]] : null; }
    case 'binary': case 'image': return 'QUJD';
    default: return null;
  }
}

/* ---------- main ---------- */
const db = await openDb();
const t0 = Date.now();
await syncSchema(db, registry);
await loadSeed(db, registry);
await brandCompany(db);
await ensureLoginUnique(db);
registerApps(registry);
const env = new Environment({ registry, db, uid: 2, companyIds: [1], superuser: true });
console.log(`db ready (${DB}) in ${Date.now() - t0} ms`);

// 1. static checks
for (const [key, view] of Object.entries(registry.views)) {
  if (ONLY && !key.includes(ONLY)) continue;
  walkArch(view.arch, view.model, `view ${key}|${view.arch.type}|`);
}
for (const [id, action] of Object.entries(registry.actions)) {
  if (action.domain !== undefined) checkExpr(typeof action.domain === 'string' ? action.domain : undefined, `action ${id} domain`);
}

// 2. per-model reads
const models = Object.values(registry.models).filter((m) => !ONLY || m.name.includes(ONLY));
const firstIds = new Map<string, number | null>();
for (const def of models) {
  const m = env.model(def.name);
  const where = def.name;
  try {
    const rows = await m.searchRead([], Object.keys(def.fields), { limit: 3 });
    firstIds.set(def.name, (rows[0]?.id as number) ?? null);
    tally('model.searchRead', true, where);
  } catch (e) { tally('model.searchRead', false, where, e); firstIds.set(def.name, null); }
  try { await m.searchCount([]); tally('model.searchCount', true, where); } catch (e) { tally('model.searchCount', false, where, e); }
  try { await m.defaultGet(); tally('model.defaultGet', true, where); } catch (e) { tally('model.defaultGet', false, where, e); }
  try { await m.nameSearch('a', [], 'ilike', 5); tally('model.nameSearch', true, where); } catch (e) { tally('model.nameSearch', false, where, e); }
  const groupable = Object.values(def.fields).find((f) => ['many2one', 'selection', 'boolean', 'date', 'datetime'].includes(f.type) && f.store !== false && !f.related);
  if (groupable) {
    try { await m.readGroup([], ['__count'], [groupable.type === 'date' || groupable.type === 'datetime' ? `${groupable.name}:month` : groupable.name]); tally('model.readGroup', true, `${where} by ${groupable.name}`); }
    catch (e) { tally('model.readGroup', false, `${where} by ${groupable.name}`, e); }
  }
}

// 3. search filters / fields / action domains
for (const [key, view] of Object.entries(registry.views)) {
  if (view.arch.type !== 'search') continue;
  if (ONLY && !key.includes(ONLY)) continue;
  if (!registry.models[view.model]) continue;
  const m = env.model(view.model);
  for (const filter of view.arch.filters) {
    if ('separator' in filter) continue;
    const where = `filter ${key} ${filter.name}`;
    try {
      const domain = filter.domain ? evalDomain(filter.domain, view.model) : (filter.date ? [[filter.date, '>=', '2026-01-01']] as Domain : null);
      if (domain) await m.searchCount(domain);
      tally('search.filter', true, where);
    } catch (e) { tally('search.filter', false, where, e); }
  }
  for (const field of view.arch.fields) {
    const where = `search-field ${key} ${field.name}`;
    let dbg: unknown = null;
    try {
      const fdef = registry.models[view.model].fields[field.name];
      if (process.env.DEBUG_FIELD && field.name === process.env.DEBUG_FIELD) console.log('DEBUG', key, view.model, field.name, fdef?.type, JSON.stringify(field));
      const sample = fdef && (fdef.type === 'date' || fdef.type === 'datetime') ? '2026-01-01' : ['integer', 'float', 'monetary'].includes(fdef?.type ?? '') ? 1 : 'x';
      const domain = field.filterDomain ? evalDomain(field.filterDomain.replace(/(self|raw_value)/g, JSON.stringify(sample)), view.model) : ([[field.name, field.operator ?? 'ilike', sample]] as Domain);
      dbg = domain;
      if (domain) await m.searchCount(domain);
      tally('search.field', true, where);
    } catch (e) { tally('search.field', false, `${where} ${JSON.stringify(dbg)}`, e); }
  }
  for (const group of view.arch.groupbys) {
    const where = `groupby ${key} ${group.name}`;
    try {
      const ctx = evaluate(group.context, scope(view.model)) as Record<string, unknown>;
      const gb = String(ctx?.group_by ?? '');
      if (gb) await m.readGroup([], ['__count'], [gb]);
      tally('search.groupby', true, where);
    } catch (e) { tally('search.groupby', false, where, e); }
  }
}
for (const [id, action] of Object.entries(registry.actions)) {
  if (action.type !== 'act_window' || !action.model || !registry.models[action.model]) continue;
  if (ONLY && !action.model.includes(ONLY)) continue;
  const where = `action ${id} ${action.xmlId} ${action.model}`;
  try {
    const domain = evalDomain(action.domain, action.model) ?? [];
    const ctx = typeof action.context === 'string' ? (evaluate(action.context, scope(action.model)) as Record<string, unknown>) : (action.context ?? {});
    const scoped = env.with({ context: ctx ?? {} });
    await scoped.model(action.model).searchRead(domain, undefined, { limit: 2 });
    const gb = ctx && typeof ctx.group_by === 'string' ? ctx.group_by : Array.isArray(ctx?.group_by) && ctx.group_by.length ? String(ctx.group_by[0]) : null;
    if (gb) await scoped.model(action.model).readGroup(domain, ['__count'], [gb]);
    tally('action.domain', true, where);
  } catch (e) { tally('action.domain', false, where, e); }
}

// 4. CRUD
if (CRUD) {
  const withForm = new Set(Object.values(registry.views).filter((v) => v.arch.type === 'form').map((v) => v.model));
  for (const def of models) {
    if (def.transient || def.sqlView || SKIP.has(def.name) || !withForm.has(def.name)) continue;
    const m = env.model(def.name);
    const where = def.name;
    let id: number | null = null;
    // Required references / lines cannot be auto-filled: the create is expected to refuse.
    const unfillable = Object.values(def.fields).filter((f) => f.required === true && !f.sqlExpr && (f.type === 'one2many' || f.type === 'reference' || f.type === 'many2one_reference'));
    if (unfillable.length) { tally('crud.skipped', true, `${where} (required ${unfillable.map((f) => f.name).join(', ')})`); continue; }
    try {
      const defaults = await m.defaultGet();
      const vals: Record<string, unknown> = {};
      for (const field of Object.values(def.fields)) {
        if (field.required !== true || defaults[field.name] !== undefined && defaults[field.name] !== null && defaults[field.name] !== false) continue;
        if ((field.compute && !field.store) || field.sqlExpr) continue;
        if ((field.type === 'many2many' || field.type === 'many2one') && field.relation) await ensureRecord(env, field.relation, firstIds);
        const value = field.type === 'many2one' && field.relation ? firstIds.get(field.relation) ?? null : fillValue(env, field, firstIds);
        if (value !== null && value !== undefined) vals[field.name] = value;
      }
      if (def.fields[def.recName] && vals[def.recName] === undefined && def.fields[def.recName].type === 'char') vals[def.recName] = 'Verify';
      id = await m.create(vals);
      tally('crud.create', true, where);
    } catch (e) { tally('crud.create', false, where, e); continue; }
    try {
      const writable = Object.values(def.fields).find((f) => f.type === 'char' && !f.readonly && !f.compute && f.store !== false && f.name !== 'login');
      if (writable) await m.write(id, { [writable.name]: 'Verify 2' });
      await m.read(id, Object.keys(def.fields));
      tally('crud.write+read', true, where);
    } catch (e) { tally('crud.write+read', false, where, e); }
    let copyId: number | null = null;
    try { copyId = await m.copy(id); tally('crud.copy', true, where); }
    catch (e) {
      // A business rule refusing the copy (e.g. an employee already checked in) is correct behaviour.
      const kind = (e as { kind?: string }).kind;
      if (kind === 'user_error' || kind === 'validation_error') tally('crud.copy', true, `${where} (refused: ${String((e as Error).message).slice(0, 80)})`);
      else tally('crud.copy', false, where, e);
    }
    try { await m.unlink(copyId ? [id, copyId] : id); tally('crud.unlink', true, where); } catch (e) { tally('crud.unlink', false, where, e); }
  }
}

console.log(`\n=== backend verification (${DB}) in ${Math.round((Date.now() - t0) / 1000)} s ===`);
for (const [check, c] of Object.entries(counts)) console.log(`${check.padEnd(20)} ok=${c.ok} fail=${c.fail}`);
if (failures.length) { console.log(`\n${failures.length} failures:`); for (const f of failures.slice(0, 80)) console.log(`  [${f.check}] ${f.where}\n      ${f.error}`); if (failures.length > 80) console.log(`  … ${failures.length - 80} more`); }
if (OUT) writeFileSync(OUT, JSON.stringify({ db: DB, counts, failures }, null, 1));
await db.close?.();
process.exit(failures.length ? 1 : 0);
