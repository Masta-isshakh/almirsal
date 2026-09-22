import type { FieldDef, ModelDef, Registry } from '../registry/types.js';
import type { Database, Queryable } from '../db/types.js';
import { getParameter, quoteIdent, setParameter } from '../schema/ddl.js';
import { toSql } from '../orm/values.js';

/**
 * Loads Part I — the default records captured from the live instance — into
 * a synced database.
 *
 * The capture references other records by display name (`"currency_id":
 * "QAR"`, `"default_account_id": "400101 Sales Account"`) and sometimes by
 * id (`"team_ids": [1]`), carries `name_ar` translations, and has cycles
 * (a company's partner, an article's parent). So:
 *
 *   pass 1  insert every record with its explicit id and scalar values,
 *           numeric many2one included, all foreign keys deferred
 *   pass 2  resolve name references and x2many links now that every row
 *           exists; `name_ar` goes to `ir_translation`
 *   finally reset identity sequences past the explicit ids
 *
 * Everything is batched — multi-row INSERTs, VALUES-joined UPDATEs — because
 * over the Aurora Data API each statement is an HTTPS round-trip: ~150 calls
 * instead of ~3,400. A marker in `ir_config_parameter` makes later runs a
 * single query.
 */

export interface SeedReport {
  inserted: Record<string, number>;
  skipped: Record<string, number>;
  unresolved: string[];
  ignoredFields: string[];
  /** True when the seed marker was present and nothing was loaded. */
  alreadyLoaded: boolean;
}

const SEED_KEY = 'rodeo.seed.version';
const SEED_VERSION = '1';
const X2MANY = new Set(['one2many', 'many2many']);
const AUDIT = new Set(['create_uid', 'create_date', 'write_uid', 'write_date']);
/** Keep each statement well under the Data API's 64 KB SQL limit. */
const CHUNK_BYTES = 40_000;

interface Pending {
  model: ModelDef;
  id: number;
  field: FieldDef;
  value: unknown;
}

function nowSql(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/** SQL literal for a seed value (seed data is ours, never user input). */
export function literal(value: unknown, field?: FieldDef): string {
  const sql = field ? toSql(field, value) : value;
  if (sql === null || sql === undefined) return 'NULL';
  if (typeof sql === 'boolean') return sql ? 'TRUE' : 'FALSE';
  if (typeof sql === 'number') return Number.isFinite(sql) ? String(sql) : 'NULL';
  const text = `'${String(sql).replace(/'/g, "''")}'`;
  switch (field?.type) {
    case 'date': return `${text}::date`;
    case 'datetime': return `${text}::timestamp`;
    case 'json': case 'properties': case 'properties_definition': return `${text}::jsonb`;
    default: return text;
  }
}

/** Run one INSERT per chunk of rows; rows are pre-rendered `(…)` tuples. */
async function insertRows(cr: Queryable, table: string, columns: string[], tuples: string[], suffix = ''): Promise<void> {
  if (tuples.length === 0) return;
  const head = `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')}) VALUES `;
  let batch: string[] = [];
  let size = head.length;
  const flush = async () => {
    if (batch.length) await cr.query(`${head}${batch.join(', ')}${suffix}`);
    batch = [];
    size = head.length;
  };
  for (const tuple of tuples) {
    if (size + tuple.length + 2 > CHUNK_BYTES && batch.length) await flush();
    batch.push(tuple);
    size += tuple.length + 2;
  }
  await flush();
}

/** `UPDATE t SET col = v.value FROM (VALUES …) v(id, value) WHERE t.id = v.id`, chunked. */
async function updateColumn(cr: Queryable, table: string, column: string, pairs: [number, number][]): Promise<void> {
  for (let i = 0; i < pairs.length; i += 500) {
    const chunk = pairs.slice(i, i + 500);
    await cr.query(
      `UPDATE ${quoteIdent(table)} t SET ${quoteIdent(column)} = v.value FROM (VALUES ${chunk.map(([id, value]) => `(${id}, ${value})`).join(', ')}) AS v(id, value) WHERE t."id" = v.id`,
    );
  }
}

/** Resolve a display-name reference to an id on the comodel. */
async function resolveReference(cr: Queryable, comodel: ModelDef, value: string, cache: Map<string, number | null>, seeded: Set<string>): Promise<number | null> {
  const key = `${comodel.name}:${value}`;
  if (cache.has(key)) return cache.get(key) ?? null;

  const candidates: string[] = [];
  const has = (name: string) => Boolean(comodel.fields[name]) && !comodel.fields[name].sqlExpr;
  if (has('name')) candidates.push(`"name" = $1`);
  if (has('complete_name')) candidates.push(`"complete_name" = $1`);
  if (has('code') && has('name')) candidates.push(`("code" || ' ' || "name") = $1`);
  if (has('code')) candidates.push(`"code" = $1`);
  if (has('login')) candidates.push(`"login" = $1`);
  if (has('full_name')) candidates.push(`"full_name" = $1`);
  if (has('title')) candidates.push(`"title" = $1`);
  // Knowledge articles are referenced as "<icon> <name>".
  if (has('icon') && has('name')) candidates.push(`(coalesce("icon", '') || ' ' || coalesce("name", '')) = $1`);

  let found: number | null = null;
  if (candidates.length) {
    const result = await cr.query<{ id: number }>(
      `SELECT "id" FROM ${quoteIdent(comodel.table)} WHERE ${candidates.join(' OR ')} ORDER BY "id" LIMIT 1`, [value],
    );
    if (result.rows.length) found = Number(result.rows[0].id);
  }
  // A comodel that needs nothing but a name (paper formats, template
  // categories) is created on the fly, as Odoo's data files would have.
  if (found === null && !seeded.has(comodel.name) && has('name')) {
    const required = Object.values(comodel.fields).filter((field) => field.required === true && !field.inferred);
    if (required.every((field) => field.name === 'name')) {
      const inserted = await cr.query<{ id: number }>(
        `INSERT INTO ${quoteIdent(comodel.table)} ("name", "create_date", "write_date") VALUES ($1, now(), now()) RETURNING "id"`, [value],
      );
      found = Number(inserted.rows[0].id);
    }
  }
  cache.set(key, found);
  return found;
}

export async function loadSeed(db: Database, registry: Registry, options: { uid?: number; force?: boolean } = {}): Promise<SeedReport> {
  const uid = options.uid ?? 1;
  const report: SeedReport = { inserted: {}, skipped: {}, unresolved: [], ignoredFields: [], alreadyLoaded: false };
  if (!options.force && (await getParameter(db, SEED_KEY)) === SEED_VERSION) {
    report.alreadyLoaded = true;
    return report;
  }
  const ignored = new Set<string>();

  await db.transaction(async (cr) => {
    await cr.query('SET CONSTRAINTS ALL DEFERRED');
    const pending: Pending[] = [];
    const translations: { model: ModelDef; id: number; field: string; value: string }[] = [];
    const now = nowSql();

    // Pass 1: scalar values, one multi-row INSERT per model (chunked).
    for (const [modelName, records] of Object.entries(registry.seed)) {
      const model = registry.models[modelName];
      if (!model) { ignored.add(`${modelName} (model not in registry)`); continue; }
      report.inserted[modelName] = 0;
      report.skipped[modelName] = 0;

      const existing = new Set(
        (await cr.query<{ id: number }>(`SELECT "id" FROM ${quoteIdent(model.table)}`)).rows.map((row) => Number(row.id)),
      );

      // Column set = union of scalar columns used by any record of the model.
      const columns = new Set<string>();
      const prepared: { id: number; values: Record<string, string> }[] = [];
      for (const record of records) {
        const id = Number(record.id);
        if (!id || existing.has(id)) { report.skipped[modelName] += 1; continue; }
        const values: Record<string, string> = {};
        for (const [key, value] of Object.entries(record)) {
          if (key === 'id' || AUDIT.has(key)) continue;
          if (key.endsWith('_ar')) {
            const base = key.slice(0, -3);
            if (typeof value === 'string' && value && model.fields[base]) translations.push({ model, id, field: base, value });
            continue;
          }
          const field = model.fields[key];
          if (!field) { ignored.add(`${modelName}.${key}`); continue; }
          if (field.name === 'display_name') continue;
          if (X2MANY.has(field.type)) {
            if (Array.isArray(value) && value.length) pending.push({ model, id, field, value });
            continue;
          }
          if (field.type === 'many2one' && typeof value === 'string' && value) { pending.push({ model, id, field, value }); continue; }
          if (field.type === 'many2one' && Array.isArray(value)) { values[key] = String(Number(value[0])); columns.add(key); continue; }
          values[key] = literal(value, field);
          columns.add(key);
        }
        prepared.push({ id, values });
        existing.add(id);
        report.inserted[modelName] += 1;
      }

      const columnList = ['id', 'create_uid', 'create_date', 'write_uid', 'write_date', ...columns];
      const tuples = prepared.map(({ id, values }) =>
        `(${[String(id), String(uid), `'${now}'::timestamp`, String(uid), `'${now}'::timestamp`, ...[...columns].map((column) => values[column] ?? 'NULL')].join(', ')})`);
      await insertRows(cr, model.table, columnList, tuples);
    }

    // Pass 2: references and links, grouped into batched statements.
    const cache = new Map<string, number | null>();
    const seeded = new Set(Object.keys(registry.seed));
    const columnUpdates = new Map<string, { table: string; column: string; pairs: [number, number][] }>();
    const m2mRows = new Map<string, { table: string; c1: string; c2: string; rows: [number, number][] }>();
    const o2mUpdates = new Map<string, { table: string; column: string; pairs: [number, number][]; polymorphic?: string }>();

    for (const { model, id, field, value } of pending) {
      const comodel = field.relation ? registry.models[field.relation] : undefined;
      if (!comodel) continue;

      if (field.type === 'many2one') {
        const target = await resolveReference(cr, comodel, String(value), cache, seeded);
        if (target === null) { report.unresolved.push(`${model.name}#${id}.${field.name} = ${JSON.stringify(value)}`); continue; }
        const key = `${model.table}.${field.name}`;
        if (!columnUpdates.has(key)) columnUpdates.set(key, { table: model.table, column: field.name, pairs: [] });
        columnUpdates.get(key)!.pairs.push([id, target]);
        continue;
      }

      const targets: number[] = [];
      for (const entry of value as unknown[]) {
        if (typeof entry === 'number') targets.push(entry);
        else if (typeof entry === 'string') {
          const target = await resolveReference(cr, comodel, entry, cache, seeded);
          if (target === null) report.unresolved.push(`${model.name}#${id}.${field.name} ∋ ${JSON.stringify(entry)}`);
          else targets.push(target);
        }
      }
      if (field.type === 'many2many' && field.m2mTable && field.m2mColumn1 && field.m2mColumn2) {
        // Both ends of a symmetric pair share a table with swapped columns.
        const key = `${field.m2mTable}:${field.m2mColumn1}:${field.m2mColumn2}`;
        if (!m2mRows.has(key)) m2mRows.set(key, { table: field.m2mTable, c1: field.m2mColumn1, c2: field.m2mColumn2, rows: [] });
        for (const target of targets) m2mRows.get(key)!.rows.push([id, target]);
      } else if (field.type === 'one2many' && field.inverse && targets.length) {
        const key = `${comodel.table}.${field.inverse}`;
        if (!o2mUpdates.has(key)) o2mUpdates.set(key, { table: comodel.table, column: field.inverse, pairs: [], polymorphic: field.inverse === 'res_id' ? model.name : undefined });
        for (const target of targets) o2mUpdates.get(key)!.pairs.push([target, id]);
      }
    }

    for (const update of columnUpdates.values()) await updateColumn(cr, update.table, update.column, update.pairs);
    for (const link of m2mRows.values()) {
      await insertRows(cr, link.table, [link.c1, link.c2], link.rows.map(([a, b]) => `(${a}, ${b})`), ' ON CONFLICT DO NOTHING');
    }
    for (const update of o2mUpdates.values()) {
      await updateColumn(cr, update.table, update.column, update.pairs);
      if (update.polymorphic) {
        await cr.query(`UPDATE ${quoteIdent(update.table)} SET "res_model" = $1 WHERE "id" = ANY($2)`, [update.polymorphic, update.pairs.map(([id]) => id)]);
      }
    }

    // Translations (idempotent per model/field/lang).
    if (registry.models['ir.translation'] && translations.length) {
      const present = await cr.query<{ res_model: string; res_id: number; field_name: string }>(
        `SELECT res_model, res_id, field_name FROM ir_translation WHERE lang = 'ar_001'`,
      );
      const known = new Set(present.rows.map((row) => `${row.res_model}#${row.res_id}.${row.field_name}`));
      const tuples = translations
        .filter((item) => !known.has(`${item.model.name}#${item.id}.${item.field}`))
        .map((item) => `(${literal(item.model.name)}, ${item.id}, ${literal(item.field)}, 'ar_001', ${literal(item.value)}, ${uid}, '${now}'::timestamp, ${uid}, '${now}'::timestamp)`);
      await insertRows(cr, 'ir_translation', ['res_model', 'res_id', 'field_name', 'lang', 'value', 'create_uid', 'create_date', 'write_uid', 'write_date'], tuples);
    }

    // A record that lists companies but names no current one gets the first.
    for (const modelName of Object.keys(registry.seed)) {
      const model = registry.models[modelName];
      const companies = model?.fields.company_ids;
      if (!model?.fields.company_id || !companies?.m2mTable) continue;
      await cr.query(
        `UPDATE ${quoteIdent(model.table)} t SET "company_id" = (SELECT min(${quoteIdent(companies.m2mColumn2!)}) FROM ${quoteIdent(companies.m2mTable)} r WHERE r.${quoteIdent(companies.m2mColumn1!)} = t."id")
         WHERE t."company_id" IS NULL`,
      );
    }

    // Identity sequences must continue past the explicit ids — one statement.
    const seededTables = Object.keys(registry.seed).map((name) => registry.models[name]?.table).filter((table): table is string => Boolean(table));
    await cr.query(
      `DO $seq$ BEGIN ${seededTables.map((table) =>
        `PERFORM setval(pg_get_serial_sequence('${table}', 'id'), GREATEST((SELECT coalesce(max("id"), 0) FROM ${quoteIdent(table)}), 1));`).join(' ')} END $seq$`,
    );

    await setParameter(cr, SEED_KEY, SEED_VERSION);
  });

  report.ignoredFields = [...ignored].sort();
  return report;
}

/**
 * The export's company is the demo user's own name ("masta"); the deployment
 * is Almirsal's, so the company (and its partner) is named once, then the
 * marker keeps every later start from touching what the user may have edited.
 */
export async function brandCompany(db: Queryable, name = 'Almirsal'): Promise<boolean> {
  const marker = 'rodeo.company.branded';
  if (await getParameter(db, marker)) return false;
  await db.query(`UPDATE res_company SET name = $1 WHERE id = 1 AND name = 'masta'`, [name]);
  await db.query(`UPDATE res_partner SET name = $1 WHERE name = 'masta' AND id = (SELECT partner_id FROM res_company WHERE id = 1)`, [name]).catch(() => undefined);
  await setParameter(db, marker, name);
  return true;
}

/**
 * Logins are unique whatever the case (`Jane@x` = `jane@x`): a functional
 * unique index the schema generator does not know about. Existing duplicates
 * (older provisioning races) are merged onto the lowest id first.
 */
export async function ensureLoginUnique(db: Queryable): Promise<void> {
  await db.query(`DELETE FROM res_users u USING res_users k WHERE lower(u.login) = lower(k.login) AND u.id > k.id`).catch(() => undefined);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS res_users_login_unique ON res_users (lower(login))`).catch(() => undefined);
}
