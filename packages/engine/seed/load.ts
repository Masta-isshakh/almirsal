import type { FieldDef, ModelDef, Registry } from '../registry/types.js';
import type { Database, Queryable } from '../db/types.js';
import { quoteIdent } from '../schema/ddl.js';
import { paramExpr, toSql } from '../orm/values.js';

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
 * Idempotent: a record whose id already exists is skipped.
 */

export interface SeedReport {
  inserted: Record<string, number>;
  skipped: Record<string, number>;
  unresolved: string[];
  ignoredFields: string[];
}

const X2MANY = new Set(['one2many', 'many2many']);
const AUDIT = new Set(['create_uid', 'create_date', 'write_uid', 'write_date']);

interface Pending {
  model: ModelDef;
  id: number;
  field: FieldDef;
  value: unknown;
}

function nowSql(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/** Resolve a display-name reference to an id on the comodel. */
async function resolveReference(cr: Queryable, comodel: ModelDef, value: string, cache: Map<string, number | null>, seeded: Set<string>): Promise<number | null> {
  const key = `${comodel.name}:${value}`;
  if (cache.has(key)) return cache.get(key) ?? null;

  const candidates: string[] = [];
  const has = (name: string) => Boolean(comodel.fields[name]);
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
  for (const condition of candidates) {
    const result = await cr.query<{ id: number }>(
      `SELECT "id" FROM ${quoteIdent(comodel.table)} WHERE ${condition} ORDER BY "id" LIMIT 1`, [value],
    );
    if (result.rows.length) { found = Number(result.rows[0].id); break; }
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

export async function loadSeed(db: Database, registry: Registry, options: { uid?: number } = {}): Promise<SeedReport> {
  const uid = options.uid ?? 1;
  const report: SeedReport = { inserted: {}, skipped: {}, unresolved: [], ignoredFields: [] };
  const ignored = new Set<string>();

  await db.transaction(async (cr) => {
    await cr.query('SET CONSTRAINTS ALL DEFERRED');
    const pending: Pending[] = [];
    const translations: { model: string; id: number; field: string; value: string }[] = [];
    const now = nowSql();

    // Pass 1: scalar values.
    for (const [modelName, records] of Object.entries(registry.seed)) {
      const model = registry.models[modelName];
      if (!model) { ignored.add(`${modelName} (model not in registry)`); continue; }
      report.inserted[modelName] = 0;
      report.skipped[modelName] = 0;

      const existing = new Set(
        (await cr.query<{ id: number }>(`SELECT "id" FROM ${quoteIdent(model.table)}`)).rows.map((row) => Number(row.id)),
      );

      for (const record of records) {
        const id = Number(record.id);
        if (!id || existing.has(id)) { report.skipped[modelName] += 1; continue; }

        const columns: string[] = ['id', 'create_uid', 'create_date', 'write_uid', 'write_date'];
        const params: unknown[] = [id, uid, now, uid, now];
        const placeholders = ['$1', '$2', '$3::timestamp', '$4', '$5::timestamp'];

        for (const [key, value] of Object.entries(record)) {
          if (key === 'id' || AUDIT.has(key)) continue;
          if (key.endsWith('_ar')) {
            const base = key.slice(0, -3);
            if (typeof value === 'string' && value && model.fields[base]) translations.push({ model: modelName, id, field: base, value });
            continue;
          }
          const field = model.fields[key];
          if (!field) { ignored.add(`${modelName}.${key}`); continue; }
          if (field.name === 'display_name') continue;

          if (X2MANY.has(field.type)) {
            if (Array.isArray(value) && value.length) pending.push({ model, id, field, value });
            continue;
          }
          if (field.type === 'many2one' && typeof value === 'string' && value) {
            pending.push({ model, id, field, value });
            continue;
          }
          if (field.type === 'many2one' && Array.isArray(value)) {
            // [id, name] form
            columns.push(key); params.push(Number(value[0])); placeholders.push(`$${params.length}`);
            continue;
          }
          columns.push(key);
          params.push(toSql(field, value));
          placeholders.push(paramExpr(field, `$${params.length}`));
        }

        await cr.query(
          `INSERT INTO ${quoteIdent(model.table)} (${columns.map(quoteIdent).join(', ')}) VALUES (${placeholders.join(', ')})`,
          params,
        );
        existing.add(id);
        report.inserted[modelName] += 1;
      }
    }

    // Pass 2: references and links.
    const cache = new Map<string, number | null>();
    const seeded = new Set(Object.keys(registry.seed));
    for (const item of pending) {
      const { model, id, field, value } = item;
      const comodel = field.relation ? registry.models[field.relation] : undefined;
      if (!comodel) continue;

      if (field.type === 'many2one') {
        const target = await resolveReference(cr, comodel, String(value), cache, seeded);
        if (target === null) { report.unresolved.push(`${model.name}#${id}.${field.name} = ${JSON.stringify(value)}`); continue; }
        await cr.query(`UPDATE ${quoteIdent(model.table)} SET ${quoteIdent(field.name)} = $1 WHERE "id" = $2`, [target, id]);
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
        for (const target of targets) {
          await cr.query(
            `INSERT INTO ${quoteIdent(field.m2mTable)} (${quoteIdent(field.m2mColumn1)}, ${quoteIdent(field.m2mColumn2)}) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [id, target],
          );
        }
      } else if (field.type === 'one2many' && field.inverse && targets.length) {
        if (field.inverse === 'res_id') {
          await cr.query(`UPDATE ${quoteIdent(comodel.table)} SET "res_id" = $1, "res_model" = $2 WHERE "id" = ANY($3)`, [id, model.name, targets]);
        } else {
          await cr.query(`UPDATE ${quoteIdent(comodel.table)} SET ${quoteIdent(field.inverse)} = $1 WHERE "id" = ANY($2)`, [id, targets]);
        }
      }
    }

    // Translations.
    if (registry.models['ir.translation']) {
      for (const translation of translations) {
        const exists = await cr.query<{ id: number }>(
          `SELECT "id" FROM ir_translation WHERE res_model = $1 AND res_id = $2 AND field_name = $3 AND lang = 'ar_001'`,
          [translation.model, translation.id, translation.field],
        );
        if (exists.rows.length) continue;
        await cr.query(
          `INSERT INTO ir_translation (res_model, res_id, field_name, lang, value, create_uid, create_date, write_uid, write_date)
           VALUES ($1, $2, $3, 'ar_001', $4, $5, $6::timestamp, $5, $6::timestamp)`,
          [translation.model, translation.id, translation.field, translation.value, uid, now],
        );
      }
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

    // Identity sequences must continue past the explicit ids.
    for (const modelName of Object.keys(registry.seed)) {
      const model = registry.models[modelName];
      if (!model) continue;
      await cr.query(
        `SELECT setval(pg_get_serial_sequence($1, 'id'), GREATEST((SELECT coalesce(max("id"), 0) FROM ${quoteIdent(model.table)}), 1))`,
        [model.table],
      );
    }
  });

  report.ignoredFields = [...ignored].sort();
  return report;
}
