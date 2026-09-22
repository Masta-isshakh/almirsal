import type { Domain, FieldDef, ModelDef } from '../registry/types.js';
import { parseDomain, type DomainNode } from './normalize.js';
import { DomainError } from './normalize.js';
import { expandSqlExpr } from '../orm/values.js';

/**
 * Compiles an Odoo domain to a parameterised PostgreSQL `WHERE` fragment.
 *
 * Relational traversal uses `IN (subquery)` rather than joins, matching what
 * Odoo's own `expression.py` does: a join would duplicate rows whenever a
 * one2many or many2many is crossed, which silently corrupts counts and
 * aggregates in list and pivot views.
 *
 * NULL handling follows Odoo, not SQL: `('state','!=','draft')` matches rows
 * where `state` is NULL, and `('field','=',False)` means "empty" — NULL, the
 * empty string, or no related records, depending on the field type.
 */

export interface SqlSchema {
  model(name: string): ModelDef | undefined;
}

export interface CompiledSql {
  text: string;
  params: unknown[];
}

export interface SqlOptions {
  /** Alias of the root table in the surrounding query. */
  alias?: string;
  /** Start numbering placeholders after this many existing params. */
  paramOffset?: number;
  /** Use `unaccent()` around ilike comparisons, as Odoo does when installed. */
  unaccent?: boolean;
  /** Current user, substituted into `sqlExpr` templates (`{uid}`). */
  uid?: number;
  /** SQL of a model's display name for an alias (custom hooks); null = use the default. */
  nameSql?: (model: ModelDef, alias: string) => string | null;
  /** "Now" for relative date values such as `'today -365d'`; defaults to the wall clock. */
  now?: Date;
}

/**
 * SQL of a model's display name: the record-name column when it is stored,
 * else the first text column, else the id. Custom display names come from
 * `nameSql` (the ORM passes the model hooks).
 */
export function defaultNameSql(model: ModelDef, alias: string): string {
  const rec = model.fields[model.recName];
  if (rec && rec.name !== 'display_name' && !X2MANY_TYPES.has(rec.type) && !rec.sqlExpr) return `${alias}.${quoteIdent(rec.name)}`;
  const candidates = ['name', 'complete_name', 'code', 'title', 'subject', 'summary', 'ref', 'login', 'label', 'description'];
  for (const name of candidates) {
    const field = model.fields[name];
    if (field && TEXT_TYPES.has(field.type) && !field.sqlExpr) return `${alias}.${quoteIdent(name)}`;
  }
  const text = Object.values(model.fields).find((field) => (field.type === 'char' || field.type === 'text') && !field.sqlExpr && field.name !== 'display_name');
  return text ? `${alias}.${quoteIdent(text.name)}` : `${alias}."id"::text`;
}

/**
 * Relative date values accepted in search filters (`'-1d'`, `'today -365d'`,
 * `'+1H'`, `'-3m'`): a base (`today` at midnight, or `now`) plus offsets in
 * seconds/minutes (`M`)/hours (`H`)/days/weeks/months (`m`)/years. Returns
 * the resolved ISO value, or null when the string is not of that form.
 */
export function resolveRelativeDate(value: unknown, fieldType: string, now: Date): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const re = /^(today|now)?((?:\s*[+-]\d+\s*[a-zA-Z]+)*)$/;
  const match = re.exec(text);
  if (!match || (!match[1] && !match[2])) return null;
  const base = match[1] === 'now' || (!match[1] && fieldType === 'datetime' && /[HMs]\b/.test(match[2])) ? new Date(now) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const date = new Date(base);
  for (const part of match[2].matchAll(/([+-]\d+)\s*([a-zA-Z]+)/g)) {
    const n = Number(part[1]);
    const unit = part[2];
    if (/^(d|days?)$/.test(unit)) date.setUTCDate(date.getUTCDate() + n);
    else if (/^(w|weeks?)$/.test(unit)) date.setUTCDate(date.getUTCDate() + 7 * n);
    else if (/^(m|months?)$/.test(unit)) date.setUTCMonth(date.getUTCMonth() + n);
    else if (/^(y|years?)$/.test(unit)) date.setUTCFullYear(date.getUTCFullYear() + n);
    else if (/^(H|h|hours?)$/.test(unit)) date.setUTCHours(date.getUTCHours() + n);
    else if (/^(M|minutes?|min)$/.test(unit)) date.setUTCMinutes(date.getUTCMinutes() + n);
    else if (/^(s|seconds?|sec)$/.test(unit)) date.setUTCSeconds(date.getUTCSeconds() + n);
    else return null;
  }
  const iso = date.toISOString();
  return fieldType === 'date' ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

const ORDER_OPS = new Set(['>', '>=', '<', '<=']);

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new DomainError(`Unsafe SQL identifier: ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
}

const TEXT_TYPES = new Set(['char', 'text', 'html', 'selection']);
const X2MANY_TYPES = new Set(['one2many', 'many2many']);

class Compiler {
  private readonly params: unknown[] = [];
  private aliasCounter = 0;

  constructor(
    private readonly schema: SqlSchema,
    private readonly options: Required<Pick<SqlOptions, 'unaccent'>> & Pick<SqlOptions, 'uid' | 'nameSql' | 'now'>,
    private readonly paramOffset: number,
  ) {}

  /** Column or expression that reads a field on `alias`. */
  private columnOf(field: FieldDef, alias: string, model: ModelDef): string {
    if (field.sqlExpr) return expandSqlExpr(field.sqlExpr, alias, { uid: this.options.uid ?? 0, model: model.name });
    return `${alias}.${quoteIdent(field.name)}`;
  }

  /** SQL of the display name of `model` rows aliased `alias`. */
  private nameSql(model: ModelDef, alias: string): string {
    return this.options.nameSql?.(model, alias) ?? defaultNameSql(model, alias);
  }

  /** The leaf to search on a comodel when a text is matched against a relation. */
  private nameLeafField(comodel: ModelDef): string {
    const rec = comodel.fields[comodel.recName];
    return rec && rec.name !== 'display_name' && !X2MANY_TYPES.has(rec.type) && !rec.sqlExpr ? comodel.recName : 'display_name';
  }

  private placeholder(value: unknown): string {
    this.params.push(value);
    return `$${this.paramOffset + this.params.length}`;
  }

  private nextAlias(prefix: string): string {
    this.aliasCounter += 1;
    return `${prefix}_${this.aliasCounter}`;
  }

  getParams(): unknown[] {
    return this.params;
  }

  private field(model: ModelDef, name: string): FieldDef {
    const field = model.fields[name];
    if (!field) {
      throw new DomainError(`Unknown field ${model.name}.${name}`);
    }
    if (field.compute && field.store === false && !field.sqlExpr) {
      throw new DomainError(
        `Cannot search on non-stored computed field ${model.name}.${name}`,
      );
    }
    return field;
  }

  private comodel(field: FieldDef): ModelDef {
    if (!field.relation) {
      throw new DomainError(`Field ${field.name} has no relation to traverse`);
    }
    const model = this.schema.model(field.relation);
    if (!model) {
      throw new DomainError(`Unknown model ${field.relation}`);
    }
    return model;
  }

  compile(node: DomainNode, model: ModelDef, alias: string): string {
    switch (node.type) {
      case 'true': return 'TRUE';
      case 'false': return 'FALSE';
      case 'and':
        return `(${this.compile(node.left, model, alias)} AND ${this.compile(node.right, model, alias)})`;
      case 'or':
        return `(${this.compile(node.left, model, alias)} OR ${this.compile(node.right, model, alias)})`;
      case 'not':
        // NOT must not swallow NULL rows, so wrap with an explicit IS NOT TRUE.
        return `(${this.compile(node.child, model, alias)}) IS NOT TRUE`;
      case 'leaf':
        return this.compileLeaf(node.field, node.op, node.value, model, alias);
    }
  }

  private compileLeaf(
    path: string,
    op: string,
    value: unknown,
    model: ModelDef,
    alias: string,
  ): string {
    // `id` is always available even when not declared as a field.
    if (path === 'id') {
      if (op === 'child_of' || op === 'parent_of') {
        return this.hierarchyCondition(null, model, alias, op, value);
      }
      return this.scalarCondition(`${alias}.${quoteIdent('id')}`, op, value, 'integer');
    }

    const [head, ...rest] = path.split('.');

    // `display_name` never has a column: search the name expression instead.
    if (head === 'display_name' && rest.length === 0) {
      if (op === 'child_of' || op === 'parent_of') return this.hierarchyCondition(null, model, alias, op, value);
      return this.scalarCondition(this.nameSql(model, alias), op, value, 'char');
    }

    const field = this.field(model, head);

    // A non-stored related field is searched through its path, as in Odoo.
    if (field.related && field.store !== true && !field.sqlExpr) {
      return this.compileLeaf([field.related, ...rest].join('.'), op, value, model, alias);
    }

    // Dotted traversal: recurse into the comodel with the remaining path.
    if (rest.length > 0) {
      return this.relationalSubquery(field, model, alias, [
        [rest.join('.'), op as never, value],
      ], false);
    }

    if (op === 'any' || op === 'not any') {
      return this.relationalSubquery(
        field,
        model,
        alias,
        (value ?? []) as Domain,
        op === 'not any',
      );
    }

    if (op === 'child_of' || op === 'parent_of') {
      return this.hierarchyCondition(field, model, alias, op, value);
    }

    if (X2MANY_TYPES.has(field.type)) {
      return this.x2manyCondition(field, model, alias, op, value);
    }

    if (field.type === 'many2one') {
      // An `ilike` (or a text compared with =/in) against a many2one searches
      // the comodel's display name, as Odoo's name_search does.
      const textual = op.includes('like') || (typeof value === 'string' && value !== '' && Number.isNaN(Number(value)) && ['=', '!=', 'in', 'not in'].includes(op));
      if (textual && !field.sqlExpr) {
        const comodel = this.comodel(field);
        const nameOp = op.includes('like') ? op : op === '=' || op === 'in' ? '=ilike' : 'not ilike';
        return this.relationalSubquery(field, model, alias, [
          [this.nameLeafField(comodel), nameOp as never, value],
        ], op.startsWith('not') || op === '!=');
      }
      return this.scalarCondition(
        this.columnOf(field, alias, model),
        op,
        value,
        'many2one',
      );
    }

    return this.scalarCondition(this.columnOf(field, alias, model), op, value, field.type);
  }

  /**
   * `field any [subdomain]` for every relational kind:
   *   many2one  -> root.field IN (SELECT id FROM comodel WHERE sub)
   *   one2many  -> root.id    IN (SELECT inverse FROM comodel WHERE sub)
   *   many2many -> root.id    IN (SELECT col1 FROM rel WHERE col2 IN (SELECT id FROM comodel WHERE sub))
   */
  private relationalSubquery(
    field: FieldDef,
    model: ModelDef,
    alias: string,
    subdomain: Domain,
    negated: boolean,
  ): string {
    const comodel = this.comodel(field);
    const subAlias = this.nextAlias(comodel.table);
    // Compile the subdomain exactly once: compiling it per branch would push
    // its bind parameters twice and shift every later placeholder.
    const where = this.compile(parseDomain(subdomain), comodel, subAlias);
    const inner = `SELECT ${subAlias}.${quoteIdent('id')} FROM ${quoteIdent(comodel.table)} AS ${subAlias} WHERE ${where}`;

    const condition = this.wrapRelation(field, model, alias, inner);
    return negated ? `(${condition}) IS NOT TRUE` : condition;
  }

  /**
   * Turn a `SELECT id FROM comodel ...` into a condition on the root table,
   * according to how the field links the two models.
   */
  private wrapRelation(
    field: FieldDef,
    model: ModelDef,
    alias: string,
    innerIdSelect: string,
  ): string {
    if (field.type === 'many2one') {
      return `${alias}.${quoteIdent(field.name)} IN (${innerIdSelect})`;
    }

    if (field.type === 'one2many') {
      if (!field.inverse) {
        throw new DomainError(`one2many ${model.name}.${field.name} has no inverse field`);
      }
      const comodel = this.comodel(field);
      const invAlias = this.nextAlias(comodel.table);
      // Polymorphic inverses (activities, messages: res_model + res_id) are
      // scoped to this model; archived children do not count, as on read.
      const modelCol = field.inverse === 'res_id' ? (comodel.fields.res_model ? 'res_model' : comodel.fields.model ? 'model' : null) : null;
      const polymorphic = modelCol ? ` AND ${invAlias}.${quoteIdent(modelCol)} = '${model.name.replace(/'/g, "''")}'` : '';
      const active = comodel.fields.active ? ` AND coalesce(${invAlias}."active", true)` : '';
      return `${alias}.${quoteIdent('id')} IN (SELECT ${invAlias}.${quoteIdent(field.inverse)} FROM ${quoteIdent(comodel.table)} AS ${invAlias} WHERE ${invAlias}.${quoteIdent('id')} IN (${innerIdSelect}) AND ${invAlias}.${quoteIdent(field.inverse)} IS NOT NULL${polymorphic}${active})`;
    }

    if (field.type === 'many2many') {
      const { m2mTable, m2mColumn1, m2mColumn2 } = field;
      if (!m2mTable || !m2mColumn1 || !m2mColumn2) {
        throw new DomainError(`many2many ${model.name}.${field.name} is missing its relation table metadata`);
      }
      const relAlias = this.nextAlias('rel');
      return `${alias}.${quoteIdent('id')} IN (SELECT ${relAlias}.${quoteIdent(m2mColumn1)} FROM ${quoteIdent(m2mTable)} AS ${relAlias} WHERE ${relAlias}.${quoteIdent(m2mColumn2)} IN (${innerIdSelect}))`;
    }

    throw new DomainError(`Cannot traverse non-relational field ${model.name}.${field.name}`);
  }

  private x2manyCondition(
    field: FieldDef,
    model: ModelDef,
    alias: string,
    op: string,
    value: unknown,
  ): string {
    const comodel = this.comodel(field);

    // Emptiness test: ('line_ids', '=', False).
    if ((op === '=' || op === '!=') && (value === false || value === null)) {
      const empty = this.relationalSubquery(field, model, alias, [], false);
      return op === '=' ? `(${empty}) IS NOT TRUE` : empty;
    }

    if (op.includes('like') || (typeof value === 'string' && value !== '' && Number.isNaN(Number(value)))) {
      const nameOp = op.includes('like') ? op : op === '!=' || op === 'not in' ? 'not ilike' : 'ilike';
      return this.relationalSubquery(field, model, alias, [
        [this.nameLeafField(comodel), nameOp as never, value],
      ], nameOp.startsWith('not'));
    }

    // Membership by id.
    const ids = Array.isArray(value) ? value : [value];
    const negated = op === 'not in' || op === '!=';
    return this.relationalSubquery(field, model, alias, [['id', 'in', ids]], negated);
  }

  /**
   * `child_of` / `parent_of` walk the model's own parent link with a recursive
   * CTE, so it works on any hierarchical model regardless of whether it keeps
   * a denormalised `parent_path`.
   */
  private hierarchyCondition(
    field: FieldDef | null,
    model: ModelDef,
    alias: string,
    op: 'child_of' | 'parent_of',
    value: unknown,
  ): string {
    // `('id','child_of',x)` walks this model; a relational field walks its
    // comodel.
    const comodel = field ? this.comodel(field) : model;

    if (!comodel.fields.parent_id) {
      throw new DomainError(`Model ${comodel.name} has no parent_id for ${op}`);
    }
    const parentField = quoteIdent('parent_id');
    const idCol = quoteIdent('id');
    const table = quoteIdent(comodel.table);

    const seeds = (Array.isArray(value) ? value : [value]).map((item) =>
      (Array.isArray(item) ? item[0] : item)).filter((item) => item !== false && item !== null && item !== undefined && item !== '');
    // No seed (`child_of False`) matches nothing, as in Odoo.
    if (seeds.length === 0) return 'FALSE';
    // Text seeds (typed in the search box) name-search the comodel first.
    const textual = seeds.some((item) => typeof item === 'string' && Number.isNaN(Number(item)));
    const seedSelect = textual
      ? seeds.map((item) => `SELECT ${idCol} FROM ${table} WHERE ${this.nameSql(comodel, table)} ILIKE ${this.placeholder(`%${String(item)}%`)}`).join(' UNION ')
      : `SELECT unnest(${this.placeholder(seeds.map(Number))}::int[])`;

    // child_of starts at the seeds and walks down to every descendant;
    // parent_of walks up to every ancestor. Both carry parent_id through the
    // recursion so the join has a column to follow.
    const anchor = `SELECT ${idCol}, ${parentField} FROM ${table} WHERE ${idCol} IN (${seedSelect})`;
    const step = op === 'child_of'
      ? `SELECT c.${idCol}, c.${parentField} FROM ${table} c JOIN tree t ON c.${parentField} = t.${idCol}`
      : `SELECT p.${idCol}, p.${parentField} FROM ${table} p JOIN tree t ON t.${parentField} = p.${idCol}`;

    const cte = `WITH RECURSIVE tree AS (${anchor} UNION ${step}) SELECT ${idCol} FROM tree`;

    if (!field) return `${alias}.${idCol} IN (${cte})`;
    return this.wrapRelation(field, model, alias, cte);
  }

  /**
   * The Data API sends every bind parameter as text; Postgres will not
   * compare a date/timestamp column to text, so temporal parameters are
   * cast explicitly (PGlite and node-postgres infer, the cast is harmless).
   */
  private typed(placeholder: string, fieldType: string, array = false): string {
    if (fieldType === 'date') return `${placeholder}::${array ? 'date[]' : 'date'}`;
    if (fieldType === 'datetime') return `${placeholder}::${array ? 'timestamp[]' : 'timestamp'}`;
    return placeholder;
  }

  private scalarCondition(
    column: string,
    op: string,
    value: unknown,
    fieldType: string,
  ): string {
    const isText = TEXT_TYPES.has(fieldType);
    const isEmptyValue = value === false || value === null || value === undefined;

    // Ordering against "nothing" (`date >= context.get('date_from')` with no
    // date in the context) matches no row rather than erroring.
    if (ORDER_OPS.has(op) && (isEmptyValue || value === '')) return 'FALSE';
    // Relative date literals from search filters.
    if ((fieldType === 'date' || fieldType === 'datetime') && typeof value === 'string') {
      const resolved = resolveRelativeDate(value, fieldType, this.options.now ?? new Date());
      if (resolved !== null) value = resolved;
    }

    switch (op) {
      case '=': {
        if (isEmptyValue) {
          if (fieldType === 'boolean') return `(${column} IS NULL OR ${column} = FALSE)`;
          if (isText) return `(${column} IS NULL OR ${column} = '')`;
          return `${column} IS NULL`;
        }
        if (value === true && fieldType === 'boolean') return `${column} = TRUE`;
        return `${column} = ${this.typed(this.placeholder(this.coerce(value, fieldType)), fieldType)}`;
      }

      case '!=': {
        const positive = this.scalarCondition(column, '=', value, fieldType);
        return `(${positive}) IS NOT TRUE`;
      }

      case '>':
      case '>=':
      case '<':
      case '<=':
        return `${column} ${op} ${this.typed(this.placeholder(this.coerce(value, fieldType)), fieldType)}`;

      case 'in':
      case 'not in': {
        const list = (Array.isArray(value) ? value : [value]).map((item) =>
          (Array.isArray(item) ? item[0] : item));
        const hasEmpty = list.some((item) => item === false || item === null || item === undefined);
        const concrete = list.filter((item) => item !== false && item !== null && item !== undefined);

        const parts: string[] = [];
        if (concrete.length > 0) {
          parts.push(`${column} = ANY(${this.typed(this.placeholder(concrete.map((item) => this.coerce(item, fieldType))), fieldType, true)})`);
        }
        if (hasEmpty) {
          parts.push(this.scalarCondition(column, '=', false, fieldType));
        }
        if (parts.length === 0) {
          // `('id','in',[])` is always false; `not in []` always true.
          return op === 'in' ? 'FALSE' : 'TRUE';
        }
        const positive = parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
        return op === 'in' ? positive : `(${positive}) IS NOT TRUE`;
      }

      case 'like':
      case 'not like':
      case 'ilike':
      case 'not ilike':
      case '=like':
      case '=ilike': {
        const caseInsensitive = op.includes('ilike');
        const anchored = op.startsWith('=');
        const negated = op.startsWith('not');
        const pattern = anchored ? String(value ?? '') : `%${String(value ?? '')}%`;

        const left = this.options.unaccent && caseInsensitive
          ? `unaccent(${column}::text)`
          : `${column}::text`;
        const right = this.options.unaccent && caseInsensitive
          ? `unaccent(${this.placeholder(pattern)})`
          : this.placeholder(pattern);

        const operator = caseInsensitive ? 'ILIKE' : 'LIKE';
        const positive = `${left} ${operator} ${right}`;
        return negated ? `(${column} IS NULL OR (${positive}) IS NOT TRUE)` : positive;
      }

      default:
        throw new DomainError(`Unsupported domain operator ${JSON.stringify(op)}`);
    }
  }

  private coerce(value: unknown, fieldType: string): unknown {
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'number') {
      // A many2one arriving as [id, display_name].
      return value[0];
    }
    if (fieldType === 'boolean') return Boolean(value);
    if (fieldType === 'integer' || fieldType === 'many2one') {
      return value === '' ? null : Number(value);
    }
    if (fieldType === 'float' || fieldType === 'monetary') return Number(value);
    return value;
  }
}

/** Compile a domain into a `WHERE` fragment plus its bind parameters. */
export function domainToSql(
  modelName: string,
  domain: Domain | null | undefined,
  schema: SqlSchema,
  options: SqlOptions = {},
): CompiledSql {
  const model = schema.model(modelName);
  if (!model) throw new DomainError(`Unknown model ${modelName}`);

  const compiler = new Compiler(
    schema,
    { unaccent: options.unaccent ?? false, uid: options.uid, nameSql: options.nameSql, now: options.now },
    options.paramOffset ?? 0,
  );
  const text = compiler.compile(
    parseDomain(domain),
    model,
    options.alias ?? quoteIdent(model.table),
  );
  return { text, params: compiler.getParams() };
}
