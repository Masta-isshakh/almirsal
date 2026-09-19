import type { FieldDef } from '../registry/types.js';
import { quoteIdent } from '../schema/ddl.js';

/**
 * Conversions between the ORM's wire values (what views and RPC callers see)
 * and SQL. The wire format follows Odoo:
 *
 *  - dates are `'YYYY-MM-DD'`, datetimes `'YYYY-MM-DD HH:MM:SS'` in UTC
 *  - empty scalars are `false`, never `null`
 *  - many2one is an id on write; `[id, display_name]` on read
 *  - x2many is an id list on read and a command list on write
 *
 * Dates and datetimes are formatted by Postgres itself (`to_char`) so no
 * driver ever interprets a naive timestamp in the host timezone.
 */

/** Odoo x2many write commands. */
export type X2ManyCommand =
  | [0, 0 | false, Record<string, unknown>]      // create
  | [1, number, Record<string, unknown>]         // update
  | [2, number]                                  // delete
  | [3, number]                                  // unlink (o2m: clear inverse; m2m: remove)
  | [4, number]                                  // link
  | [5]                                          // clear all
  | [6, 0 | false, number[]];                    // replace with ids

export function isCommandList(value: unknown): value is X2ManyCommand[] {
  return Array.isArray(value) && value.every((item) => Array.isArray(item) && typeof item[0] === 'number');
}

/** Normalise an id-list write (`[1,2,3]`) into a replace command. */
export function toCommands(value: unknown): X2ManyCommand[] {
  if (value === false || value === null || value === undefined) return [[5]];
  if (isCommandList(value)) return value;
  if (Array.isArray(value)) return [[6, 0, value.map(Number)]];
  return [];
}

/** SELECT expression that yields the wire representation of a column. */
export function selectExpr(field: FieldDef, alias: string): string {
  const column = `${alias}.${quoteIdent(field.name)}`;
  switch (field.type) {
    case 'date':
      return `to_char(${column}, 'YYYY-MM-DD')`;
    case 'datetime':
      return `to_char(${column}, 'YYYY-MM-DD HH24:MI:SS')`;
    case 'monetary':
    case 'float':
      return `${column}::float8`;
    case 'json':
    case 'properties':
    case 'properties_definition':
      return `${column}::text`;
    default:
      return column;
  }
}

/** Placeholder expression for a bound parameter of this field. */
export function paramExpr(field: FieldDef, placeholder: string): string {
  switch (field.type) {
    case 'json':
    case 'properties':
    case 'properties_definition':
      return `${placeholder}::jsonb`;
    case 'date':
      return `${placeholder}::date`;
    case 'datetime':
      return `${placeholder}::timestamp`;
    default:
      return placeholder;
  }
}

/** Convert a wire value to what the driver should bind. */
export function toSql(field: FieldDef, value: unknown): unknown {
  if (value === undefined) return null;
  if (value === false && field.type !== 'boolean') return null;
  if (value === null) return null;

  switch (field.type) {
    case 'boolean':
      return Boolean(value);
    case 'integer':
    case 'many2one':
    case 'many2one_reference': {
      // A many2one may arrive as [id, name].
      const raw = Array.isArray(value) ? value[0] : value;
      if (raw === '' || raw === false) return null;
      return Math.trunc(Number(raw));
    }
    case 'float':
    case 'monetary':
      return Number(value);
    case 'date':
      if (value instanceof Date) return value.toISOString().slice(0, 10);
      return String(value).slice(0, 10);
    case 'datetime':
      if (value instanceof Date) return value.toISOString().slice(0, 19).replace('T', ' ');
      return String(value).replace('T', ' ').slice(0, 19);
    case 'json':
    case 'properties':
    case 'properties_definition':
      return typeof value === 'string' ? value : JSON.stringify(value);
    case 'reference':
      return value ? String(value) : null;
    default:
      return typeof value === 'string' ? value : String(value);
  }
}

/** Convert a raw driver value to the wire representation. */
export function fromSql(field: FieldDef, value: unknown): unknown {
  if (value === null || value === undefined) {
    return field.type === 'boolean' ? false : false;
  }
  switch (field.type) {
    case 'boolean':
      return Boolean(value);
    case 'integer':
    case 'many2one':
    case 'many2one_reference':
      return Number(value);
    case 'float':
    case 'monetary':
      return Number(value);
    case 'json':
    case 'properties':
    case 'properties_definition':
      if (typeof value === 'string') {
        try { return JSON.parse(value); } catch { return false; }
      }
      return value;
    case 'date':
    case 'datetime':
      // Already formatted by to_char; a Date can only come from a raw query.
      if (value instanceof Date) {
        const iso = value.toISOString();
        return field.type === 'date' ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
      }
      return String(value);
    default:
      return value === '' ? false : value;
  }
}

/** `2026-09-19 14:30:05` for "now", in UTC. */
export function nowSql(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

export function todaySql(): string {
  return new Date().toISOString().slice(0, 10);
}
