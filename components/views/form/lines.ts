import type { FieldDef } from '@engine/registry/types';
import { idOf } from '@/lib/client/display';

/**
 * Editable x2many state for the form view. Records loaded from the server
 * and rows added in the browser live in one list; `toCommands` turns the
 * difference into Odoo commands on save.
 */

export type Rec = Record<string, unknown>;

export interface LineRow {
  /** Stable key for React; new rows get a negative virtual id. */
  key: number;
  id: number | null;
  values: Rec;
  /** Fields changed since load (existing rows) or all values (new rows). */
  changes: Rec;
  deleted: boolean;
}

let virtual = 0;

export function rowsFromRecords(records: unknown): LineRow[] {
  if (!Array.isArray(records)) return [];
  return records.map((record) => {
    const values = (record && typeof record === 'object' ? record : {}) as Rec;
    return { key: Number(values.id) || --virtual, id: typeof values.id === 'number' ? values.id : null, values, changes: {}, deleted: false };
  });
}

export function newRow(values: Rec): LineRow {
  const key = --virtual;
  return { key, id: null, values: { ...values, id: false }, changes: { ...values }, deleted: false };
}

/** Wire value → write value for one field of a line. */
export function writeValue(field: FieldDef | undefined, value: unknown): unknown {
  if (!field) return value;
  if (field.type === 'many2one') return idOf(value) ?? false;
  if (field.type === 'many2many') {
    const ids = Array.isArray(value) ? value.map((item) => idOf(item)).filter((id): id is number => id !== null) : [];
    return [[6, 0, ids]];
  }
  if (field.type === 'one2many') return undefined;
  return value;
}

export function toCommands(rows: LineRow[], fields: Record<string, FieldDef>): unknown[] {
  const commands: unknown[] = [];
  for (const row of rows) {
    if (row.deleted) {
      if (row.id) commands.push([2, row.id]);
      continue;
    }
    const vals: Rec = {};
    for (const [name, value] of Object.entries(row.changes)) {
      if (name === 'id' || name === 'display_name') continue;
      const converted = writeValue(fields[name], value);
      if (converted !== undefined) vals[name] = converted;
    }
    if (row.id) {
      if (Object.keys(vals).length) commands.push([1, row.id, vals]);
    } else {
      commands.push([0, 0, vals]);
    }
  }
  return commands;
}

export function hasLineChanges(rows: LineRow[]): boolean {
  return rows.some((row) => row.deleted || !row.id || Object.keys(row.changes).length > 0);
}
