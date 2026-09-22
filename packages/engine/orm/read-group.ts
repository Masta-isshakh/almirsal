import type { Domain, FieldDef } from '../registry/types.js';
import { PyDate, applyRelativeDelta, RelativeDelta } from '../expr/pydate.js';
import { combineDomains } from '../domain/normalize.js';
import { quoteIdent } from '../schema/ddl.js';
import type { Model } from './model.js';
import { ValidationError } from './errors.js';
import { expandSqlExpr, fromSql } from './values.js';

/**
 * `read_group`: the aggregation behind list group headers, kanban columns,
 * pivot and graph views.
 *
 * Group-by items are `field` or `field:interval` (day/week/month/quarter/
 * year). Lazy mode (the default, as in Odoo) groups by the first item only
 * and returns `__context.group_by` with the rest, so the list view can expand
 * sub-groups on demand. Each row carries `__domain`, the leaf domain that
 * selects exactly its records.
 */

export interface ReadGroupOptions {
  lazy?: boolean;
  orderby?: string;
  limit?: number;
  offset?: number;
  activeTest?: boolean;
}

export interface ReadGroupRow {
  __count: number;
  __domain: Domain;
  __context?: { group_by: string[] };
  __range?: Record<string, { from: string; to: string }>;
  [key: string]: unknown;
}

type Interval = 'day' | 'week' | 'month' | 'quarter' | 'year';
const INTERVALS = new Set<Interval>(['day', 'week', 'month', 'quarter', 'year']);
const AGGREGATES = new Set(['sum', 'avg', 'min', 'max', 'count', 'count_distinct', 'bool_and', 'bool_or', 'array_agg']);

const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

interface GroupSpec {
  key: string;
  field: FieldDef;
  interval?: Interval;
  expr: string;
}

function parseGroup(model: Model, item: string, joins: string[]): GroupSpec {
  const [name, intervalText] = item.split(':');
  const field = model.field(name);
  if (field.type === 'one2many') {
    throw new ValidationError(`Cannot group by one2many field ${name}`);
  }
  if (field.type === 'many2many') {
    // A record with several tags appears under each of them, as in Odoo.
    if (!field.m2mTable || !field.m2mColumn1 || !field.m2mColumn2) throw new ValidationError(`Cannot group by ${name}: no relation table`);
    const alias = `m${joins.length + 1}`;
    joins.push(`LEFT JOIN ${quoteIdent(field.m2mTable)} ${alias} ON ${alias}.${quoteIdent(field.m2mColumn1)} = t."id"`);
    return { key: name, field, expr: `${alias}.${quoteIdent(field.m2mColumn2)}` };
  }
  const column = field.sqlExpr ? expandSqlExpr(field.sqlExpr, 't', { uid: model.env.uid, model: model.name }) : `t.${quoteIdent(name)}`;
  if (field.type === 'date' || field.type === 'datetime') {
    const interval = (intervalText && INTERVALS.has(intervalText as Interval) ? intervalText : 'month') as Interval;
    return { key: `${name}:${interval}`, field, interval, expr: `to_char(date_trunc('${interval}', ${column}), 'YYYY-MM-DD')` };
  }
  return { key: name, field, expr: column };
}

function intervalDelta(interval: Interval): RelativeDelta {
  switch (interval) {
    case 'day': return new RelativeDelta({ days: 1 });
    case 'week': return new RelativeDelta({ weeks: 1 });
    case 'month': return new RelativeDelta({ months: 1 });
    case 'quarter': return new RelativeDelta({ months: 3 });
    case 'year': return new RelativeDelta({ years: 1 });
  }
}

function intervalLabel(start: PyDate, interval: Interval, lang: string): string {
  const months = lang === 'ar_001' ? MONTHS_AR : MONTHS_EN;
  switch (interval) {
    case 'day': return `${start.day} ${months[start.month - 1].slice(0, 3)} ${start.year}`;
    case 'week': {
      const dayOfYear = start.toOrdinal() - new PyDate(start.year, 1, 1).toOrdinal();
      return `W${String(Math.floor(dayOfYear / 7) + 1).padStart(2, '0')} ${start.year}`;
    }
    case 'month': return `${months[start.month - 1]} ${start.year}`;
    case 'quarter': return `Q${Math.floor((start.month - 1) / 3) + 1} ${start.year}`;
    case 'year': return String(start.year);
  }
}

interface AggregateSpec {
  alias: string;
  expr: string;
}

function parseAggregate(model: Model, item: string): AggregateSpec | null {
  if (item === '__count') return { alias: '__count_agg', expr: 'count(*)' };
  const match = /^(\w+)(?::(\w+)(?:\((\w+)\))?)?$/.exec(item);
  if (!match) return null;
  const alias = match[1];
  const operator = match[2] && AGGREGATES.has(match[2]) ? match[2] : undefined;
  const source = match[3] ?? (operator ? alias : alias);
  const field = model.fields[source];
  if (!field) return null;
  const column = field.sqlExpr ? expandSqlExpr(field.sqlExpr, 't', { uid: model.env.uid, model: model.name }) : `t.${quoteIdent(source)}`;
  const numeric = ['integer', 'float', 'monetary'].includes(field.type);
  const op = operator ?? (numeric ? 'sum' : null);
  if (!op) return null;
  if (op === 'count_distinct') return { alias, expr: `count(DISTINCT ${column})` };
  if (op === 'array_agg') return { alias, expr: `array_agg(${column})` };
  return { alias, expr: `${op}(${column})${numeric ? '::float8' : ''}` };
}

export async function readGroup(
  model: Model,
  domain: Domain,
  implicitDomain: Domain,
  fields: string[],
  groupby: string[],
  options: ReadGroupOptions = {},
): Promise<ReadGroupRow[]> {
  const lazy = options.lazy ?? true;
  const active = lazy ? groupby.slice(0, 1) : groupby;
  const rest = lazy ? groupby.slice(1) : [];
  const joins: string[] = [];
  const groups = active.map((item) => parseGroup(model, item, joins));
  const aggregates = fields.map((item) => parseAggregate(model, item)).filter((agg): agg is AggregateSpec => Boolean(agg))
    .filter((agg) => !groups.some((group) => group.field.name === agg.alias));

  // The implicit (active/company/rules) part filters rows but never leaks
  // into __domain, which the client shows and re-submits.
  const where = model.compileDomain(combineDomains([domain, implicitDomain], '&'), 't');
  const selects = [
    ...groups.map((group, index) => `${group.expr} AS ${quoteIdent(`g${index}`)}`),
    'count(*)::int AS "__count"',
    ...aggregates.map((agg) => `${agg.expr} AS ${quoteIdent(agg.alias)}`),
  ];
  const params = [...where.params];
  let sql = `SELECT ${selects.join(', ')} FROM ${quoteIdent(model.table)} t${joins.length ? ' ' + joins.join(' ') : ''} WHERE ${where.text}`;
  if (groups.length) sql += ` GROUP BY ${groups.map((group) => group.expr).join(', ')}`;

  // Ordering: explicit orderby on aggregates/groups, else by group value.
  const orderParts: string[] = [];
  if (options.orderby) {
    for (const term of options.orderby.split(',')) {
      const [name, dir = 'asc'] = term.trim().split(/\s+/);
      const groupIndex = groups.findIndex((group) => group.field.name === name || group.key === name);
      if (groupIndex >= 0) orderParts.push(`${quoteIdent(`g${groupIndex}`)} ${dir.toUpperCase()} NULLS LAST`);
      else if (aggregates.some((agg) => agg.alias === name)) orderParts.push(`${quoteIdent(name)} ${dir.toUpperCase()}`);
      else if (name === '__count') orderParts.push(`"__count" ${dir.toUpperCase()}`);
    }
  }
  if (orderParts.length === 0) {
    groups.forEach((group, index) => {
      if ((group.field.type === 'many2one' || group.field.type === 'many2many') && group.field.relation) {
        const comodel = model.env.registry.models[group.field.relation];
        if (comodel) {
          orderParts.push(`(SELECT ${model.nameSqlFor(comodel, 'c')} FROM ${quoteIdent(comodel.table)} c WHERE c."id" = ${group.expr}) ASC NULLS LAST`);
          return;
        }
      }
      orderParts.push(`${quoteIdent(`g${index}`)} ASC NULLS LAST`);
    });
  }
  if (orderParts.length) sql += ` ORDER BY ${orderParts.join(', ')}`;
  if (options.limit) { params.push(options.limit); sql += ` LIMIT $${params.length}`; }
  if (options.offset) { params.push(options.offset); sql += ` OFFSET $${params.length}`; }

  const result = await model.env.cr.query(sql, params);

  // Resolve many2one group values to [id, display_name] in one query per comodel.
  const nameMaps = new Map<string, Map<number, string>>();
  for (const group of groups) {
    if ((group.field.type !== 'many2one' && group.field.type !== 'many2many') || !group.field.relation) continue;
    const ids = [...new Set(result.rows.map((row) => row[`g${groups.indexOf(group)}`]).filter((v) => v != null).map(Number))];
    nameMaps.set(group.field.name, await model.env.sudo().model(group.field.relation).displayNames(ids));
  }

  return result.rows.map((row) => {
    const out: ReadGroupRow = { __count: Number(row.__count), __domain: [] };
    const leaves: Domain = [];
    const ranges: Record<string, { from: string; to: string }> = {};

    groups.forEach((group, index) => {
      const raw = row[`g${index}`];
      const name = group.field.name;
      if (group.interval) {
        if (raw == null) {
          out[group.key] = false;
          leaves.push([name, '=', false]);
          return;
        }
        const start = PyDate.parse(String(raw))!;
        const end = applyRelativeDelta(start, intervalDelta(group.interval));
        const isDatetime = group.field.type === 'datetime';
        const from = isDatetime ? `${start} 00:00:00` : start.toString();
        const to = isDatetime ? `${end} 00:00:00` : end.toString();
        out[group.key] = intervalLabel(start, group.interval, model.env.lang);
        ranges[name] = { from, to };
        leaves.push([name, '>=', from], [name, '<', to]);
        return;
      }
      if (group.field.type === 'many2one' || group.field.type === 'many2many') {
        if (raw == null) { out[name] = false; leaves.push([name, '=', false]); return; }
        const id = Number(raw);
        out[name] = [id, nameMaps.get(name)?.get(id) ?? `${group.field.relation},${id}`];
        leaves.push([name, group.field.type === 'many2many' ? 'in' : '=', group.field.type === 'many2many' ? [id] : id]);
        return;
      }
      const value = fromSql(group.field, raw);
      out[name] = value;
      leaves.push([name, '=', value === false && group.field.type !== 'boolean' ? false : value]);
    });

    for (const agg of aggregates) {
      const value = row[agg.alias];
      out[agg.alias] = value == null ? (agg.expr.startsWith('count') ? 0 : false) : (typeof value === 'string' && !Number.isNaN(Number(value)) ? Number(value) : value);
    }

    out.__domain = [...domain, ...leaves];
    if (Object.keys(ranges).length) out.__range = ranges;
    if (rest.length) out.__context = { group_by: rest };
    if (groups.length === 1) out[`${groups[0].field.name}_count`] = out.__count;
    return out;
  });
}
