import type { Domain, FieldDef, ModelDef } from '../registry/types.js';
import { parseDomain, type DomainNode } from './normalize.js';
import { DomainError } from './normalize.js';

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
}

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
    private readonly options: Required<Pick<SqlOptions, 'unaccent'>>,
    private readonly paramOffset: number,
  ) {}

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
    if (field.compute && field.store === false) {
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
    const field = this.field(model, head);

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
      // An `ilike` against a many2one searches the comodel's display name.
      if (op.includes('like')) {
        const comodel = this.comodel(field);
        return this.relationalSubquery(field, model, alias, [
          [comodel.recName, op as never, value],
        ], op.startsWith('not'));
      }
      return this.scalarCondition(
        `${alias}.${quoteIdent(head)}`,
        op,
        value,
        'many2one',
      );
    }

    return this.scalarCondition(`${alias}.${quoteIdent(head)}`, op, value, field.type);
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
      const polymorphic = field.inverse === 'res_id' && comodel.fields.res_model ? ` AND ${invAlias}."res_model" = '${model.name.replace(/'/g, "''")}'` : '';
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

    if (op.includes('like')) {
      return this.relationalSubquery(field, model, alias, [
        [comodel.recName, op as never, value],
      ], op.startsWith('not'));
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
      (Array.isArray(item) ? item[0] : item));
    const seedParam = this.placeholder(seeds);

    // child_of starts at the seeds and walks down to every descendant;
    // parent_of walks up to every ancestor. Both carry parent_id through the
    // recursion so the join has a column to follow.
    const anchor = `SELECT ${idCol}, ${parentField} FROM ${table} WHERE ${idCol} = ANY(${seedParam})`;
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
    { unaccent: options.unaccent ?? false },
    options.paramOffset ?? 0,
  );
  const text = compiler.compile(
    parseDomain(domain),
    model,
    options.alias ?? quoteIdent(model.table),
  );
  return { text, params: compiler.getParams() };
}
