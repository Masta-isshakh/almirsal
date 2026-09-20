import type { Domain, DomainLeaf, FieldDef, ModelDef } from '../registry/types.js';
import { combineDomains } from '../domain/normalize.js';
import { domainToSql } from '../domain/sql.js';
import { evaluate } from '../expr/evaluate.js';
import { quoteIdent } from '../schema/ddl.js';
import type { Environment } from './env.js';
import { AccessError, MissingError, UserError, ValidationError } from './errors.js';
import { hooksFor, type ActionResult, type OnchangeResult, type Values } from './hooks.js';
import { postCreationMessage, postTracking, unlinkThreadData, type TrackingChange } from './mail.js';
import { readGroup, type ReadGroupOptions, type ReadGroupRow } from './read-group.js';
import {
  fromSql, nowSql, paramExpr, selectExpr, toCommands, toSql, type X2ManyCommand,
} from './values.js';

/**
 * The per-model API with Odoo's semantics (A-3): defaults, required-field
 * validation, x2many commands, stored computes with cross-model dependency
 * triggers, record rules, multi-company filtering, `active_test`, tracking in
 * the chatter, and `[id, display_name]` many2one reads.
 *
 * Every mutation is transactional: public methods wrap themselves in
 * `env.withTransaction`, which is a no-op when already inside one.
 */

export interface SearchOptions {
  offset?: number;
  limit?: number;
  /** `"date_order desc, id desc"`; defaults to the model's `order`. */
  order?: string;
  /** Include archived records (`active = false`). Default follows context. */
  activeTest?: boolean;
}

export interface ReadSpecification {
  [field: string]: { fields?: ReadSpecification; limit?: number; order?: string } | Record<string, never>;
}

const AUDIT_FIELDS = new Set(['id', 'create_uid', 'create_date', 'write_uid', 'write_date']);
const X2MANY = new Set(['one2many', 'many2many']);

function idList(ids: number | number[]): number[] {
  return (Array.isArray(ids) ? ids : [ids]).map(Number);
}

export class Model {
  readonly env: Environment;
  readonly def: ModelDef;

  constructor(env: Environment, def: ModelDef) {
    this.env = env;
    this.def = def;
  }

  get name(): string { return this.def.name; }
  get table(): string { return this.def.table; }
  get fields(): Record<string, FieldDef> { return this.def.fields; }

  field(name: string): FieldDef {
    const field = this.fields[name];
    if (!field) throw new ValidationError({ en: `Invalid field '${name}' on model '${this.name}'`, ar: `حقل غير صالح '${name}' في النموذج '${this.name}'` });
    return field;
  }

  /** Columns that live on the table (no x2many, no display_name). */
  private storedFields(): FieldDef[] {
    return Object.values(this.fields).filter(
      (field) => !X2MANY.has(field.type) && field.name !== 'display_name' && field.name !== 'id',
    );
  }

  /* ---------------------------------------------------------------- *
   * Access control
   * ---------------------------------------------------------------- */

  checkAccess(operation: 'read' | 'write' | 'create' | 'unlink'): void {
    if (this.env.superuser) return;
    const rules = this.def.access;
    if (rules.length === 0) return; // no ACL declared yet: open to internal users
    const allowed = rules.some((rule) =>
      rule[operation] && (rule.group === undefined || this.env.groupIds.includes(Number(rule.group))));
    if (!allowed) {
      throw new AccessError({
        en: `You are not allowed to ${operation} '${this.def.description.en}' records.`,
        ar: `غير مسموح لك بـ ${operation} سجلات '${this.def.description.ar}'.`,
      });
    }
  }

  /** Record-rule domain for an operation (global rules AND, group rules OR). */
  private ruleDomain(operation: 'read' | 'write' | 'create' | 'unlink'): Domain {
    if (this.env.superuser) return [];
    const rules = (this.def.recordRules ?? []).filter((rule) => rule.perms[operation]);
    const evalDomain = (source: Domain | string): Domain =>
      (typeof source === 'string' ? evaluate(source, this.scope()) as Domain : source);
    const globalRules = rules.filter((rule) => rule.global || !rule.groups?.length);
    const groupRules = rules.filter((rule) => !rule.global && rule.groups?.length
      && rule.groups.some((group) => this.env.groupIds.includes(Number(group))));
    const globalDomain = combineDomains(globalRules.map((rule) => evalDomain(rule.domain)), '&');
    const groupDomain = combineDomains(groupRules.map((rule) => evalDomain(rule.domain)), '|');
    return combineDomains([globalDomain, groupDomain], '&');
  }

  /** Expression scope for rule / default evaluation. */
  private scope(record: Values = {}) {
    return {
      record,
      uid: this.env.uid,
      allowedCompanyIds: this.env.companyIds,
      context: this.env.context,
      extra: { user: { id: this.env.uid }, company: { id: this.env.companyId } },
      strictNames: false,
    };
  }

  /** Domain implied by the environment: active_test, multi-company, rules. */
  private implicitDomain(operation: 'read' | 'write' | 'unlink', activeTest?: boolean): Domain {
    const parts: Domain[] = [];
    const testActive = activeTest ?? this.env.context.active_test !== false;
    if (testActive && this.fields.active) parts.push([['active', '=', true]]);
    if (this.fields.company_id && this.name !== 'res.company' && !this.env.superuser) {
      parts.push(['|', ['company_id', 'in', this.env.companyIds], ['company_id', '=', false]]);
    }
    parts.push(this.ruleDomain(operation));
    return combineDomains(parts, '&');
  }

  /* ---------------------------------------------------------------- *
   * Search & read
   * ---------------------------------------------------------------- */

  private compileWhere(domain: Domain, alias: string, paramOffset = 0) {
    return domainToSql(this.name, domain, { model: (name) => this.env.registry.models[name] }, {
      alias, paramOffset, unaccent: false,
    });
  }

  /** ORDER BY clause; many2one terms sort by the comodel's record name. */
  private orderClause(order: string | undefined, alias: string): string {
    const spec = (order ?? this.def.order ?? 'id').trim();
    const terms = spec.split(',').map((term) => term.trim()).filter(Boolean);
    const parts: string[] = [];
    for (const term of terms) {
      const [name, direction = 'asc'] = term.split(/\s+/);
      const dir = direction.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
      if (name === 'id') { parts.push(`${alias}."id" ${dir}`); continue; }
      const field = this.fields[name];
      if (!field || X2MANY.has(field.type)) continue;
      if (field.type === 'many2one' && field.relation && this.env.registry.models[field.relation]) {
        const comodel = this.env.registry.models[field.relation];
        const recName = comodel.fields[comodel.recName] ? comodel.recName : 'id';
        parts.push(`(SELECT c.${quoteIdent(recName)} FROM ${quoteIdent(comodel.table)} c WHERE c."id" = ${alias}.${quoteIdent(name)}) ${dir} NULLS LAST`);
      } else {
        parts.push(`${alias}.${quoteIdent(name)} ${dir} NULLS LAST`);
      }
    }
    if (!parts.some((part) => part.startsWith(`${alias}."id"`))) parts.push(`${alias}."id" DESC`);
    return parts.join(', ');
  }

  async search(domain: Domain = [], options: SearchOptions = {}): Promise<number[]> {
    this.checkAccess('read');
    const full = combineDomains([domain, this.implicitDomain('read', options.activeTest)], '&');
    const alias = 't';
    const where = this.compileWhere(full, alias);
    const params = [...where.params];
    let sql = `SELECT ${alias}."id" FROM ${quoteIdent(this.table)} ${alias} WHERE ${where.text} ORDER BY ${this.orderClause(options.order, alias)}`;
    if (options.limit !== undefined) { params.push(options.limit); sql += ` LIMIT $${params.length}`; }
    if (options.offset) { params.push(options.offset); sql += ` OFFSET $${params.length}`; }
    const result = await this.env.cr.query<{ id: number }>(sql, params);
    return result.rows.map((row) => Number(row.id));
  }

  /** Page of ids plus the total in one round trip (a window count), for `web_search_read`. */
  async searchWithCount(domain: Domain = [], options: SearchOptions = {}): Promise<{ ids: number[]; total: number }> {
    this.checkAccess('read');
    const full = combineDomains([domain, this.implicitDomain('read', options.activeTest)], '&');
    const alias = 't';
    const where = this.compileWhere(full, alias);
    const params = [...where.params];
    let sql = `SELECT ${alias}."id", count(*) OVER()::int AS total FROM ${quoteIdent(this.table)} ${alias} WHERE ${where.text} ORDER BY ${this.orderClause(options.order, alias)}`;
    if (options.limit !== undefined) { params.push(options.limit); sql += ` LIMIT $${params.length}`; }
    if (options.offset) { params.push(options.offset); sql += ` OFFSET $${params.length}`; }
    const result = await this.env.cr.query<{ id: number; total: number }>(sql, params);
    if (result.rows.length === 0 && options.offset) return { ids: [], total: await this.searchCount(domain, options) };
    return { ids: result.rows.map((row) => Number(row.id)), total: Number(result.rows[0]?.total ?? 0) };
  }

  async searchCount(domain: Domain = [], options: Pick<SearchOptions, 'activeTest'> = {}): Promise<number> {
    this.checkAccess('read');
    const full = combineDomains([domain, this.implicitDomain('read', options.activeTest)], '&');
    const where = this.compileWhere(full, 't');
    const result = await this.env.cr.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${quoteIdent(this.table)} t WHERE ${where.text}`, where.params,
    );
    return Number(result.rows[0].n);
  }

  async exists(ids: number[]): Promise<number[]> {
    if (ids.length === 0) return [];
    const result = await this.env.cr.query<{ id: number }>(
      `SELECT "id" FROM ${quoteIdent(this.table)} WHERE "id" = ANY($1)`, [ids],
    );
    return result.rows.map((row) => Number(row.id));
  }

  /** Read records; many2one as `[id, display_name]`, x2many as id lists. */
  async read(ids: number | number[], fieldNames?: string[]): Promise<Values[]> {
    this.checkAccess('read');
    const list = idList(ids);
    if (list.length === 0) return [];

    const requested = (fieldNames ?? Object.keys(this.fields)).filter((name) => name !== 'id');
    const wantDisplay = requested.includes('display_name') || fieldNames === undefined;
    const names = requested.filter((name) => name !== 'display_name');
    const scalar = names.map((name) => this.field(name)).filter((field) => !X2MANY.has(field.type));
    const x2many = names.map((name) => this.field(name)).filter((field) => X2MANY.has(field.type));

    // Reads respect record rules too: rows outside the rules simply vanish.
    const rule = combineDomains([[['id', 'in', list]], this.implicitDomain('read', false)], '&');
    const where = this.compileWhere(rule, 't');
    // Plain many2one names (comodels without a custom display name) come back
    // in the same SELECT as scalar subqueries: one round trip instead of one
    // per relation.
    const many2one = scalar.filter((field) => field.type === 'many2one');
    const inline = many2one.filter((field) => this.inlineNameExpr(field) !== null);
    // The record's own display name rides along too when it can be expressed in SQL.
    const ownHooks = hooksFor(this.name);
    const ownNameExpr = !wantDisplay ? null : ownHooks.displayNameSql ? ownHooks.displayNameSql('t') : !ownHooks.displayName && this.fields[this.def.recName] && !X2MANY.has(this.fields[this.def.recName].type) ? selectExpr(this.fields[this.def.recName], 't') : null;
    const selects = [
      't."id"',
      ...scalar.map((field) => `${selectExpr(field, 't')} AS ${quoteIdent(field.name)}`),
      ...inline.map((field) => `${this.inlineNameExpr(field)} AS ${quoteIdent(`__name_${field.name}`)}`),
      ...(ownNameExpr ? [`${ownNameExpr} AS "__rec_name"`] : []),
    ];
    const result = await this.env.cr.query(
      `SELECT ${selects.join(', ')} FROM ${quoteIdent(this.table)} t WHERE ${where.text}`, where.params,
    );
    const byId = new Map<number, Values>();
    for (const row of result.rows) {
      const record: Values = { id: Number(row.id) };
      for (const field of scalar) record[field.name] = fromSql(field, row[field.name]);
      if (ownNameExpr) record.display_name = row.__rec_name === null || row.__rec_name === undefined ? `${this.name},${record.id}` : String(row.__rec_name);
      for (const field of inline) {
        const value = record[field.name];
        if (typeof value === 'number' && value > 0) {
          const name = row[`__name_${field.name}`];
          record[field.name] = [value, name === null || name === undefined ? `${field.relation},${value}` : String(name)];
        }
      }
      byId.set(record.id as number, record);
    }
    const records = list.map((id) => byId.get(id)).filter((record): record is Values => Boolean(record));

    // The remaining lookups (all x2many fields in one query, many2ones with a
    // custom display name) run together outside transactions.
    const lookups: (() => Promise<void>)[] = this.many2OneLookups(records, many2one.filter((field) => !inline.includes(field)));
    if (x2many.length) lookups.unshift(() => this.readX2ManyAll(records, x2many));
    await this.runLookups(lookups);
    if (wantDisplay && !ownNameExpr) {
      // A custom display name may need columns outside the requested set; re-read then.
      const needed = hooksFor(this.name).displayNameFields ?? this.storedFields().map((field) => field.name);
      const preloaded = hooksFor(this.name).displayName && !needed.every((name) => name in (records[0] ?? {})) ? undefined : records;
      const displayNames = await this.displayNames(records.map((record) => record.id as number), preloaded);
      for (const record of records) record.display_name = displayNames.get(record.id as number) ?? '';
    }
    return records;
  }

  /** SQL for a many2one's display name inside the parent SELECT, or null when the comodel needs its hook. */
  private inlineNameExpr(field: FieldDef): string | null {
    const comodel = field.relation ? this.env.registry.models[field.relation] : undefined;
    if (!comodel) return null;
    const hooks = hooksFor(comodel.name);
    if (hooks.displayNameSql) return `(SELECT ${hooks.displayNameSql('n')} FROM ${quoteIdent(comodel.table)} n WHERE n."id" = t.${quoteIdent(field.name)})`;
    if (hooks.displayName) return null;
    const recName = comodel.fields[comodel.recName] ? comodel.recName : null;
    if (!recName || X2MANY.has(comodel.fields[recName].type)) return null;
    return `(SELECT ${selectExpr(comodel.fields[recName], 'n')} FROM ${quoteIdent(comodel.table)} n WHERE n."id" = t.${quoteIdent(field.name)})`;
  }

  /**
   * Every x2many field of the records in ONE query: each field's child rows
   * (ordered) are tagged with the field name and unioned.
   */
  private async readX2ManyAll(records: Values[], fields: FieldDef[]): Promise<void> {
    const ids = records.map((record) => record.id as number);
    const maps = new Map<string, Map<number, number[]>>();
    const parts: string[] = [];
    const params: unknown[] = [ids];
    for (const field of fields) {
      maps.set(field.name, new Map(ids.map((id) => [id, []])));
      const comodel = this.env.registry.models[field.relation ?? ''];
      if (field.type === 'one2many' && comodel && field.inverse) {
        const co = this.env.model(comodel.name);
        let extra = '';
        if (field.inverse === 'res_id') { params.push(this.name); extra += ` AND t."res_model" = $${params.length}`; }
        if (Array.isArray(field.domain) && field.domain.length) {
          const compiled = co.compileDomain(field.domain as Domain, 't', params.length);
          extra += ` AND (${compiled.text})`;
          params.push(...compiled.params);
        }
        if (comodel.fields.active && this.env.context.active_test !== false) extra += ` AND coalesce(t."active", true)`;
        params.push(field.name);
        parts.push(`(SELECT $${params.length}::text AS f, t.${quoteIdent(field.inverse)}::int AS parent, t."id"::int AS child, row_number() OVER (ORDER BY ${co.orderClause(undefined, 't')})::int AS seq
          FROM ${quoteIdent(comodel.table)} t WHERE t.${quoteIdent(field.inverse)} = ANY($1)${extra})`);
      } else if (field.type === 'many2many' && field.m2mTable && field.m2mColumn1 && field.m2mColumn2) {
        params.push(field.name);
        parts.push(`(SELECT $${params.length}::text AS f, ${quoteIdent(field.m2mColumn1)}::int AS parent, ${quoteIdent(field.m2mColumn2)}::int AS child, row_number() OVER (ORDER BY ${quoteIdent(field.m2mColumn2)})::int AS seq
          FROM ${quoteIdent(field.m2mTable)} WHERE ${quoteIdent(field.m2mColumn1)} = ANY($1))`);
      }
    }
    if (parts.length) {
      const rows = await this.env.cr.query<{ f: string; parent: number; child: number; seq: number }>(`${parts.join(' UNION ALL ')} ORDER BY f, seq`, params);
      for (const row of rows.rows) maps.get(row.f)?.get(Number(row.parent))?.push(Number(row.child));
    }
    for (const field of fields) for (const record of records) record[field.name] = maps.get(field.name)?.get(record.id as number) ?? [];
  }

  private async readX2Many(records: Values[], field: FieldDef): Promise<void> {
    const ids = records.map((record) => record.id as number);
    const comodel = this.env.registry.models[field.relation ?? ''];
    const map = new Map<number, number[]>(ids.map((id) => [id, []]));

    if (field.type === 'one2many' && comodel && field.inverse) {
      const co = this.env.model(comodel.name);
      // A one2many may carry a domain (Odoo's invoice_line_ids = line_ids
      // restricted to product lines); registered as a Domain by app hooks.
      const params: unknown[] = field.inverse === 'res_id' ? [ids, this.name] : [ids];
      let extra = '';
      if (Array.isArray(field.domain) && field.domain.length) {
        const compiled = co.compileDomain(field.domain as Domain, 't', params.length);
        extra = ` AND (${compiled.text})`;
        params.push(...compiled.params);
      }
      // Odoo applies active_test on x2many reads: archived children (done activities) disappear.
      if (comodel.fields.active && this.env.context.active_test !== false) extra += ` AND coalesce(t."active", true)`;
      const rows = await this.env.cr.query<{ id: number; parent: number }>(
        `SELECT t."id", t.${quoteIdent(field.inverse)} AS parent FROM ${quoteIdent(comodel.table)} t
         WHERE t.${quoteIdent(field.inverse)} = ANY($1)${field.inverse === 'res_id' ? ` AND t."res_model" = $2` : ''}${extra}
         ORDER BY ${co.orderClause(undefined, 't')}`,
        params,
      );
      for (const row of rows.rows) map.get(Number(row.parent))?.push(Number(row.id));
    } else if (field.type === 'many2many' && field.m2mTable && field.m2mColumn1 && field.m2mColumn2) {
      const rows = await this.env.cr.query<{ a: number; b: number }>(
        `SELECT ${quoteIdent(field.m2mColumn1)} AS a, ${quoteIdent(field.m2mColumn2)} AS b FROM ${quoteIdent(field.m2mTable)}
         WHERE ${quoteIdent(field.m2mColumn1)} = ANY($1) ORDER BY ${quoteIdent(field.m2mColumn2)}`,
        [ids],
      );
      for (const row of rows.rows) map.get(Number(row.a))?.push(Number(row.b));
    }
    for (const record of records) record[field.name] = map.get(record.id as number) ?? [];
  }

  /** Sequential inside a transaction (one connection), concurrent otherwise. */
  private async runLookups(lookups: (() => Promise<void>)[]): Promise<void> {
    if (this.env.inTransaction) { for (const lookup of lookups) await lookup(); return; }
    await Promise.all(lookups.map((lookup) => lookup()));
  }

  private many2OneLookups(records: Values[], fields: FieldDef[]): (() => Promise<void>)[] {
    const lookups: (() => Promise<void>)[] = [];
    for (const field of fields) {
      if (!field.relation || !this.env.registry.models[field.relation]) continue;
      const ids = [...new Set(records.map((record) => record[field.name]).filter((value): value is number => typeof value === 'number' && value > 0))];
      if (ids.length === 0) continue;
      const relation = field.relation;
      lookups.push(async () => {
        const names = await this.env.sudo().model(relation).displayNames(ids);
        for (const record of records) {
          const value = record[field.name];
          if (typeof value === 'number' && value > 0) {
            record[field.name] = names.has(value) ? [value, names.get(value)] : false;
          }
        }
      });
    }
    return lookups;
  }

  async searchRead(domain: Domain = [], fieldNames?: string[], options: SearchOptions = {}): Promise<Values[]> {
    const ids = await this.search(domain, options);
    return this.read(ids, fieldNames);
  }

  /**
   * `web_read`: nested reads in one call. A specification maps field names to
   * `{fields, limit, order}` for x2many (returns records) and many2one
   * (returns `{id, display_name, …}`); scalar fields map to `{}`.
   */
  async webRead(ids: number | number[], specification: ReadSpecification): Promise<Values[]> {
    const names = Object.keys(specification);
    const records = await this.read(ids, names);
    const lookups: (() => Promise<void>)[] = [];
    for (const name of names) {
      const field = this.fields[name];
      const spec = specification[name] as { fields?: ReadSpecification; limit?: number; order?: string };
      if (!field || !field.relation || !this.env.registry.models[field.relation]) continue;
      const relation = field.relation;
      if (field.type === 'many2one') {
        for (const record of records) {
          const value = record[name];
          record[name] = Array.isArray(value) ? { id: value[0], display_name: value[1] } : false;
        }
        if (spec.fields && Object.keys(spec.fields).length) {
          lookups.push(async () => {
            const targetIds = records.map((record) => (record[name] as { id: number } | false)).filter(Boolean).map((v) => (v as { id: number }).id);
            const nested = await this.env.model(relation).webRead(targetIds, spec.fields!);
            const byId = new Map(nested.map((row) => [row.id as number, row]));
            for (const record of records) {
              const value = record[name] as { id: number; display_name: string } | false;
              if (value) record[name] = { ...value, ...(byId.get(value.id) ?? {}) };
            }
          });
        }
      } else if (X2MANY.has(field.type) && spec.fields) {
        // One nested read for all parents (children are already in the
        // comodel's default order); per-record only when a custom order asks.
        lookups.push(async () => {
          const co = this.env.model(relation);
          if (spec.order) {
            for (const record of records) {
              let childIds = await co.search([['id', 'in', record[name] as number[]]], { order: spec.order, activeTest: false });
              if (spec.limit) childIds = childIds.slice(0, spec.limit);
              record[name] = await co.webRead(childIds, spec.fields!);
            }
            return;
          }
          const perRecord = new Map(records.map((record) => [record.id as number, (spec.limit ? (record[name] as number[]).slice(0, spec.limit) : (record[name] as number[]))]));
          const allIds = [...new Set([...perRecord.values()].flat())];
          const rows = allIds.length ? await co.webRead(allIds, spec.fields!) : [];
          const byId = new Map(rows.map((row) => [row.id as number, row]));
          for (const record of records) record[name] = (perRecord.get(record.id as number) ?? []).map((id) => byId.get(id)).filter((row): row is Values => Boolean(row));
        });
      }
    }
    await this.runLookups(lookups);
    return records;
  }

  async readGroup(domain: Domain, fields: string[], groupby: string[], options: ReadGroupOptions = {}): Promise<ReadGroupRow[]> {
    this.checkAccess('read');
    return readGroup(this, domain, this.implicitDomain('read', options.activeTest), fields, groupby, options);
  }

  /** Public for read-group and friends. */
  compileDomain(domain: Domain, alias: string, paramOffset = 0) {
    return this.compileWhere(domain, alias, paramOffset);
  }

  /* ---------------------------------------------------------------- *
   * Names
   * ---------------------------------------------------------------- */

  /** display_name per id (no access checks: used to label many2one links). */
  async displayNames(ids: number[], preloaded?: Values[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    if (ids.length === 0) return out;
    const hooks = hooksFor(this.name);

    if (hooks.displayName) {
      const records = preloaded ?? await this.sudoRead(ids, hooks.displayNameFields);
      for (const record of records) out.set(record.id as number, hooks.displayName(this.env, record));
      return out;
    }

    const recName = this.fields[this.def.recName] ? this.def.recName : null;
    if (!recName) {
      for (const id of ids) out.set(id, `${this.name},${id}`);
      return out;
    }
    // The record name is already loaded: no query.
    if (preloaded && preloaded.every((record) => recName in record)) {
      for (const record of preloaded) {
        const value = record[recName];
        out.set(record.id as number, value === false || value === null || value === undefined ? `${this.name},${record.id}` : String(value));
      }
      return out;
    }
    const field = this.fields[recName];
    const result = await this.env.cr.query<{ id: number; name: unknown }>(
      `SELECT "id", ${selectExpr(field, 't')} AS name FROM ${quoteIdent(this.table)} t WHERE "id" = ANY($1)`, [ids],
    );
    for (const row of result.rows) {
      const value = fromSql(field, row.name);
      out.set(Number(row.id), value === false || value === null ? `${this.name},${row.id}` : String(value));
    }
    return out;
  }

  /** Raw scalar read without rules, for internal use (display names, tracking). */
  private async sudoRead(ids: number[], only?: string[]): Promise<Values[]> {
    const scalar = this.storedFields().filter((field) => !only || only.includes(field.name));
    const selects = ['t."id"', ...scalar.map((field) => `${selectExpr(field, 't')} AS ${quoteIdent(field.name)}`)];
    const result = await this.env.cr.query(
      `SELECT ${selects.join(', ')} FROM ${quoteIdent(this.table)} t WHERE t."id" = ANY($1)`, [ids],
    );
    return result.rows.map((row) => {
      const record: Values = { id: Number(row.id) };
      for (const field of scalar) record[field.name] = fromSql(field, row[field.name]);
      return record;
    });
  }

  /** many2one autocomplete: `[[id, display_name], …]`. */
  async nameSearch(name = '', domain: Domain = [], operator = 'ilike', limit = 8): Promise<[number, string][]> {
    const hooks = hooksFor(this.name);
    const searchable = [this.def.recName, ...(hooks.searchFields ?? [])].filter((field) => this.fields[field] && !X2MANY.has(this.fields[field].type));
    let full = domain;
    if (name) {
      const leaves: Domain = searchable.map((field) => [field, operator, name] as DomainLeaf);
      const or: Domain = [...Array(Math.max(0, leaves.length - 1)).fill('|'), ...leaves];
      full = combineDomains([domain, or], '&');
    }
    const ids = await this.search(full, { limit });
    const names = await this.displayNames(ids);
    return ids.map((id) => [id, names.get(id) ?? '']);
  }

  /* ---------------------------------------------------------------- *
   * Defaults
   * ---------------------------------------------------------------- */

  async defaultGet(fieldNames?: string[]): Promise<Values> {
    const names = fieldNames ?? Object.keys(this.fields);
    const hooks = hooksFor(this.name);
    const defaults: Values = {};

    // Generic company / currency defaults.
    if (this.fields.company_id && this.name !== 'res.company' && this.env.companyId) defaults.company_id = this.env.companyId;
    if (this.fields.currency_id && this.name !== 'res.currency' && this.env.companyId) {
      const company = await this.env.cr.query<{ currency_id: number | null }>(
        `SELECT currency_id FROM res_company WHERE id = $1`, [this.env.companyId],
      );
      if (company.rows[0]?.currency_id) defaults.currency_id = Number(company.rows[0].currency_id);
    }
    if (this.fields.active) defaults.active = true;

    // Field-level defaults from the registry.
    for (const field of Object.values(this.fields)) {
      if (field.default === undefined) continue;
      defaults[field.name] = typeof field.default === 'function'
        ? (field.default as (env: Environment) => unknown)(this.env)
        : field.default;
    }

    // Model hooks, then `default_<field>` context keys (highest priority).
    Object.assign(defaults, await hooks.defaults?.(this.env));
    for (const [key, value] of Object.entries(this.env.context)) {
      if (key.startsWith('default_') && this.fields[key.slice(8)]) defaults[key.slice(8)] = value;
    }

    const out: Values = {};
    for (const name of names) if (name in defaults) out[name] = defaults[name];
    return out;
  }

  /* ---------------------------------------------------------------- *
   * Create / write / unlink
   * ---------------------------------------------------------------- */

  private validateRequired(vals: Values, isCreate: boolean): void {
    const missing: string[] = [];
    for (const field of Object.values(this.fields)) {
      if (field.required !== true || field.inferred) continue;
      if (isCreate ? !(field.name in vals) : !(field.name in vals)) { if (isCreate) missing.push(field.name); continue; }
      const value = vals[field.name];
      const empty = value === null || value === undefined || value === false || value === ''
        || (Array.isArray(value) && value.length === 0 && X2MANY.has(field.type));
      if (empty && field.type !== 'boolean') missing.push(field.name);
    }
    if (missing.length) {
      const labels = missing.map((name) => this.fields[name].label);
      throw new ValidationError({
        en: `The following fields are invalid:\n${labels.map((label) => `- ${label.en}`).join('\n')}`,
        ar: `الحقول التالية غير صالحة:\n${labels.map((label) => `- ${label.ar}`).join('\n')}`,
      }, { fields: missing });
    }
  }

  private splitValues(vals: Values): { columns: [FieldDef, unknown][]; relations: [FieldDef, X2ManyCommand[]][] } {
    const columns: [FieldDef, unknown][] = [];
    const relations: [FieldDef, X2ManyCommand[]][] = [];
    for (const [name, value] of Object.entries(vals)) {
      if (AUDIT_FIELDS.has(name) || name === 'display_name') continue;
      const field = this.field(name);
      if (X2MANY.has(field.type)) relations.push([field, toCommands(value)]);
      else columns.push([field, value]);
    }
    return { columns, relations };
  }

  async create(vals: Values): Promise<number>;
  async create(vals: Values[]): Promise<number[]>;
  async create(vals: Values | Values[]): Promise<number | number[]> {
    const many = Array.isArray(vals);
    const list = many ? vals : [vals];
    const ids = await this.env.withTransaction((env) => env.model(this.name).createInTx(list));
    return many ? ids : ids[0];
  }

  private async createInTx(list: Values[]): Promise<number[]> {
    this.checkAccess('create');
    const hooks = hooksFor(this.name);
    const ids: number[] = [];
    const now = nowSql();

    for (const raw of list) {
      let vals = { ...(await this.defaultGet()), ...raw };
      if (hooks.beforeCreate) vals = await hooks.beforeCreate(this.env, vals);
      this.validateRequired(vals, true);
      const { columns, relations } = this.splitValues(vals);

      const names = ['create_uid', 'create_date', 'write_uid', 'write_date'];
      const params: unknown[] = [this.env.uid, now, this.env.uid, now];
      const placeholders = ['$1', '$2::timestamp', '$3', '$4::timestamp'];
      for (const [field, value] of columns) {
        names.push(field.name);
        params.push(toSql(field, value));
        placeholders.push(paramExpr(field, `$${params.length}`));
      }
      const inserted = await this.env.cr.query<{ id: number }>(
        `INSERT INTO ${quoteIdent(this.table)} (${names.map(quoteIdent).join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING "id"`,
        params,
      );
      const id = Number(inserted.rows[0].id);
      ids.push(id);
      for (const [field, commands] of relations) await this.applyCommands(id, field, commands);
    }

    await this.recompute(ids, Object.keys(this.fields), true);
    await this.triggerDependents(ids, Object.keys(this.fields));
    for (const constraint of hooks.constraints ?? []) await constraint(this.env, ids);
    await hooks.onCreate?.(this.env, ids, list);
    if (hooks.creationMessage) {
      for (const id of ids) await postCreationMessage(this.env, this.name, id, hooks.creationMessage);
    }
    return ids;
  }

  async write(ids: number | number[], vals: Values): Promise<boolean> {
    const list = idList(ids);
    if (list.length === 0 || Object.keys(vals).length === 0) return true;
    return this.env.withTransaction((env) => env.model(this.name).writeInTx(list, vals));
  }

  private async writeInTx(ids: number[], rawVals: Values): Promise<boolean> {
    this.checkAccess('write');
    const hooks = hooksFor(this.name);
    const vals = hooks.beforeWrite ? await hooks.beforeWrite(this.env, ids, rawVals) : rawVals;
    const { columns, relations } = this.splitValues(vals);
    this.validateRequired(vals, false);

    // Rules: the user may only touch records the write rule lets through.
    const allowed = await this.search([['id', 'in', ids]], { activeTest: false });
    const forbidden = ids.filter((id) => !allowed.includes(id));
    if (forbidden.length && !this.env.superuser) {
      const exist = await this.exists(forbidden);
      if (exist.length) throw new AccessError({ en: 'You are not allowed to modify this record.', ar: 'غير مسموح لك بتعديل هذا السجل.' });
      throw new MissingError({ en: 'Record does not exist or has been deleted.', ar: 'السجل غير موجود أو تم حذفه.' });
    }

    const tracked = (hooks.tracked ?? []).filter((name) => name in vals && this.fields[name]);
    const previous = tracked.length || hooks.onWrite ? await this.sudoRead(ids) : [];

    if (columns.length) {
      const sets: string[] = ['"write_uid" = $1', '"write_date" = $2::timestamp'];
      const params: unknown[] = [this.env.uid, nowSql()];
      for (const [field, value] of columns) {
        params.push(toSql(field, value));
        sets.push(`${quoteIdent(field.name)} = ${paramExpr(field, `$${params.length}`)}`);
      }
      params.push(ids);
      await this.env.cr.query(
        `UPDATE ${quoteIdent(this.table)} SET ${sets.join(', ')} WHERE "id" = ANY($${params.length})`, params,
      );
    }
    for (const id of ids) {
      for (const [field, commands] of relations) await this.applyCommands(id, field, commands);
    }

    const changed = Object.keys(vals);
    const computed = await this.recompute(ids, changed, false);
    // Dependents react to computed outputs too (a line's subtotal → order total).
    await this.triggerDependents(ids, [...changed, ...computed]);
    for (const constraint of hooks.constraints ?? []) await constraint(this.env, ids);
    await hooks.onWrite?.(this.env, ids, vals, previous);

    if (tracked.length) {
      const current = await this.sudoRead(ids);
      const byId = new Map(current.map((record) => [record.id as number, record]));
      for (const before of previous) {
        const after = byId.get(before.id as number);
        if (!after) continue;
        const changes: TrackingChange[] = [];
        for (const name of tracked) {
          if (JSON.stringify(before[name]) !== JSON.stringify(after[name])) {
            changes.push({ field: this.fields[name], oldValue: before[name], newValue: after[name] });
          }
        }
        if (changes.length) await postTracking(this.env, this.name, before.id as number, changes);
      }
    }
    return true;
  }

  async unlink(ids: number | number[]): Promise<boolean> {
    const list = idList(ids);
    if (list.length === 0) return true;
    return this.env.withTransaction((env) => env.model(this.name).unlinkInTx(list));
  }

  private async unlinkInTx(ids: number[]): Promise<boolean> {
    this.checkAccess('unlink');
    const allowed = await this.search([['id', 'in', ids]], { activeTest: false });
    if (allowed.length !== ids.length && !this.env.superuser) {
      throw new AccessError({ en: 'You are not allowed to delete this record.', ar: 'غير مسموح لك بحذف هذا السجل.' });
    }
    await hooksFor(this.name).onUnlink?.(this.env, ids);

    // Dependents recompute after the rows are gone (e.g. order totals).
    const parents = await this.dependentParents(ids, Object.keys(this.fields));
    await unlinkThreadData(this.env, this.name, ids);
    await this.env.cr.query(`DELETE FROM ${quoteIdent(this.table)} WHERE "id" = ANY($1)`, [ids]);
    for (const [model, parentIds, changed] of parents) {
      await this.env.model(model).recompute(parentIds, changed, false);
    }
    return true;
  }

  async copy(id: number, defaults: Values = {}): Promise<number> {
    const hooks = hooksFor(this.name);
    const [record] = await this.read(id);
    if (!record) throw new MissingError({ en: 'Record does not exist or has been deleted.', ar: 'السجل غير موجود أو تم حذفه.' });
    const vals: Values = {};
    for (const [name, field] of Object.entries(this.fields)) {
      if (AUDIT_FIELDS.has(name) || name === 'display_name') continue;
      if (field.copy === false || hooks.noCopy?.includes(name) || field.inferred) continue;
      if (field.type === 'one2many') continue; // Odoo copies lines only when copy=True on the o2m; default off here
      const value = record[name];
      if (field.type === 'many2one') vals[name] = Array.isArray(value) ? value[0] : value;
      else if (field.type === 'many2many') vals[name] = [[6, 0, value as number[]]];
      else vals[name] = value;
    }
    if (this.def.recName === 'name' && typeof vals.name === 'string' && !('name' in defaults)) {
      vals.name = `${vals.name} (copy)`;
    }
    return this.create({ ...vals, ...defaults });
  }

  async toggleActive(ids: number | number[]): Promise<boolean> {
    if (!this.fields.active) throw new UserError('This model has no active field');
    const records = await this.read(ids, ['active']);
    for (const record of records) await this.write(record.id as number, { active: !record.active });
    return true;
  }

  /* ---------------------------------------------------------------- *
   * x2many commands
   * ---------------------------------------------------------------- */

  private async applyCommands(recordId: number, field: FieldDef, commands: X2ManyCommand[]): Promise<void> {
    if (!field.relation) return;
    const co = this.env.model(field.relation);

    if (field.type === 'one2many') {
      const inverse = field.inverse;
      if (!inverse) throw new UserError(`one2many ${this.name}.${field.name} has no inverse`);
      const inverseField = co.fields[inverse];
      const polymorphic = inverse === 'res_id';
      const link = (vals: Values): Values => (polymorphic ? { ...vals, res_id: recordId, res_model: this.name } : { ...vals, [inverse]: recordId });
      const detach = async (childIds: number[]) => {
        if (childIds.length === 0) return;
        if (inverseField?.required || polymorphic) await co.unlink(childIds);
        else await co.write(childIds, { [inverse]: false });
      };
      const currentIds = async () => (await this.read(recordId, [field.name]))[0]?.[field.name] as number[] ?? [];

      for (const command of commands) {
        switch (command[0]) {
          case 0: await co.create(link(command[2])); break;
          case 1: await co.write(command[1], command[2]); break;
          case 2: await co.unlink(command[1]); break;
          case 3: await detach([command[1]]); break;
          case 4: await co.write(command[1], link({})); break;
          case 5: await detach(await currentIds()); break;
          case 6: {
            const keep = new Set(command[2]);
            await detach((await currentIds()).filter((id) => !keep.has(id)));
            for (const id of command[2]) await co.write(id, link({}));
            break;
          }
          default: break;
        }
      }
      return;
    }

    const { m2mTable, m2mColumn1, m2mColumn2 } = field;
    if (!m2mTable || !m2mColumn1 || !m2mColumn2) return;
    const linkIds = async (ids: number[]) => {
      for (const id of ids) {
        await this.env.cr.query(
          `INSERT INTO ${quoteIdent(m2mTable)} (${quoteIdent(m2mColumn1)}, ${quoteIdent(m2mColumn2)}) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [recordId, id],
        );
      }
    };
    const unlinkIds = async (ids: number[]) => {
      if (ids.length === 0) return;
      await this.env.cr.query(
        `DELETE FROM ${quoteIdent(m2mTable)} WHERE ${quoteIdent(m2mColumn1)} = $1 AND ${quoteIdent(m2mColumn2)} = ANY($2)`,
        [recordId, ids],
      );
    };
    for (const command of commands) {
      switch (command[0]) {
        case 0: await linkIds([await co.create(command[2])]); break;
        case 1: await co.write(command[1], command[2]); break;
        case 2: await co.unlink(command[1]); break;
        case 3: await unlinkIds([command[1]]); break;
        case 4: await linkIds([command[1]]); break;
        case 5:
          await this.env.cr.query(`DELETE FROM ${quoteIdent(m2mTable)} WHERE ${quoteIdent(m2mColumn1)} = $1`, [recordId]);
          break;
        case 6:
          await this.env.cr.query(`DELETE FROM ${quoteIdent(m2mTable)} WHERE ${quoteIdent(m2mColumn1)} = $1`, [recordId]);
          await linkIds(command[2]);
          break;
        default: break;
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Stored computes
   * ---------------------------------------------------------------- */

  /** Write computed values without triggering hooks (internal). */
  private async writeRaw(id: number, vals: Values): Promise<void> {
    const entries = Object.entries(vals).filter(([name]) => this.fields[name] && !X2MANY.has(this.fields[name].type));
    if (entries.length === 0) return;
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [name, value] of entries) {
      const field = this.fields[name];
      params.push(toSql(field, value));
      sets.push(`${quoteIdent(name)} = ${paramExpr(field, `$${params.length}`)}`);
    }
    params.push(id);
    await this.env.cr.query(`UPDATE ${quoteIdent(this.table)} SET ${sets.join(', ')} WHERE "id" = $${params.length}`, params);
  }

  /**
   * Run the model's compute hooks whose dependencies intersect `changed`;
   * returns the names of every field that was recomputed.
   */
  async recompute(ids: number[], changed: string[], all: boolean): Promise<string[]> {
    const computes = hooksFor(this.name).computes ?? [];
    const touched = new Set<string>();
    if (computes.length === 0 || ids.length === 0) return [];
    let pending = new Set(changed);
    for (let round = 0; round < 5 && pending.size; round += 1) {
      const next = new Set<string>();
      for (const compute of computes) {
        const triggered = all || compute.depends.some((dep) => pending.has(dep.split('.')[0]));
        if (!triggered) continue;
        const values = await compute.compute(this.env, ids);
        for (const [id, vals] of Object.entries(values)) {
          await this.writeRaw(Number(id), vals);
          for (const name of Object.keys(vals)) { next.add(name); touched.add(name); }
        }
      }
      // Only fields not already processed this round can trigger again.
      for (const name of pending) next.delete(name);
      pending = next;
      all = false;
    }
    return [...touched];
  }

  /**
   * Parents whose computes depend on `<relation>.<field>` of this model:
   * returns [model, parentIds, changedPathFields] triples.
   */
  private async dependentParents(ids: number[], changed: string[]): Promise<[string, number[], string[]][]> {
    const out: [string, number[], string[]][] = [];
    for (const [modelName, def] of Object.entries(this.env.registry.models)) {
      const computes = hooksFor(modelName).computes ?? [];
      for (const compute of computes) {
        for (const dep of compute.depends) {
          const [relField, ...rest] = dep.split('.');
          if (rest.length === 0) continue;
          const field = def.fields[relField];
          if (!field || field.relation !== this.name) continue;
          if (!changed.includes(rest[0]) && rest[0] !== '*' && !changed.includes(field.inverse ?? '')) continue;
          let parentIds: number[] = [];
          if (field.type === 'one2many' && field.inverse) {
            const rows = await this.env.cr.query<{ p: number }>(
              `SELECT DISTINCT ${quoteIdent(field.inverse)} AS p FROM ${quoteIdent(this.table)} WHERE "id" = ANY($1) AND ${quoteIdent(field.inverse)} IS NOT NULL`, [ids],
            );
            parentIds = rows.rows.map((row) => Number(row.p));
          } else if (field.type === 'many2many' && field.m2mTable && field.m2mColumn1 && field.m2mColumn2) {
            const rows = await this.env.cr.query<{ p: number }>(
              `SELECT DISTINCT ${quoteIdent(field.m2mColumn1)} AS p FROM ${quoteIdent(field.m2mTable)} WHERE ${quoteIdent(field.m2mColumn2)} = ANY($1)`, [ids],
            );
            parentIds = rows.rows.map((row) => Number(row.p));
          } else if (field.type === 'many2one') {
            const rows = await this.env.cr.query<{ p: number }>(
              `SELECT "id" AS p FROM ${quoteIdent(def.table)} WHERE ${quoteIdent(relField)} = ANY($1)`, [ids],
            );
            parentIds = rows.rows.map((row) => Number(row.p));
          }
          if (parentIds.length) out.push([modelName, parentIds, [relField]]);
        }
      }
    }
    return out;
  }

  /**
   * Recompute dependents and keep propagating: a line's invoiced quantity
   * changes the order's invoice status, which may change something else.
   * Depth-limited so a cyclic declaration cannot loop forever.
   */
  private async triggerDependents(ids: number[], changed: string[], depth = 0): Promise<void> {
    if (depth > 6) return;
    for (const [model, parentIds, fields] of await this.dependentParents(ids, changed)) {
      const parent = this.env.model(model);
      const touched = await parent.recompute(parentIds, fields, false);
      if (touched.length) await parent.triggerDependents(parentIds, [...fields, ...touched], depth + 1);
    }
  }

  /* ---------------------------------------------------------------- *
   * Onchange & buttons
   * ---------------------------------------------------------------- */

  async onchange(values: Values, fieldNames: string[]): Promise<OnchangeResult> {
    const rules = hooksFor(this.name).onchange ?? {};
    const merged: OnchangeResult = { value: {} };
    let current = { ...values };
    for (const name of fieldNames) {
      const rule = rules[name];
      if (!rule) continue;
      const result = await rule(this.env, current);
      if (result.value) {
        Object.assign(merged.value!, result.value);
        current = { ...current, ...result.value };
      }
      if (result.warning && !merged.warning) merged.warning = result.warning;
      if (result.domain) merged.domain = { ...(merged.domain ?? {}), ...result.domain };
    }
    return merged;
  }

  /** Execute a button/server method (`action_confirm`, …) on records. */
  async callButton(ids: number | number[], method: string, context: Values = {}): Promise<ActionResult | void> {
    const handler = hooksFor(this.name).methods?.[method];
    if (!handler) {
      throw new UserError({ en: `Method ${method} is not implemented on ${this.name}`, ar: `الدالة ${method} غير منفذة في ${this.name}` });
    }
    const env = this.env.with({ context });
    return env.withTransaction((tx) => handler(tx, idList(ids), context));
  }
}
