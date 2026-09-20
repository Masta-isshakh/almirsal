import type { FieldDef } from '@engine/registry/types';
import type { I18n } from '@engine/i18n/types';
import type { ReadGroupRow } from '@engine/orm/read-group';

/**
 * Shared helpers for grouped/aggregated views (list groups, pivot, graph,
 * calendar): which fields can group, how a group value reads, and the
 * measures a model offers.
 */

export const GROUPABLE_TYPES = new Set(['many2one', 'selection', 'boolean', 'date', 'datetime', 'char', 'integer']);
export const DATE_INTERVALS: { key: string; label: I18n }[] = [
  { key: 'day', label: { en: 'Day', ar: 'يوم' } },
  { key: 'week', label: { en: 'Week', ar: 'أسبوع' } },
  { key: 'month', label: { en: 'Month', ar: 'شهر' } },
  { key: 'quarter', label: { en: 'Quarter', ar: 'ربع سنة' } },
  { key: 'year', label: { en: 'Year', ar: 'سنة' } },
];

/** Fields worth offering in a "group by" menu. */
export function groupableFields(fields: Record<string, FieldDef>): FieldDef[] {
  return Object.values(fields)
    .filter((field) => GROUPABLE_TYPES.has(field.type) && !['id', 'create_uid', 'write_uid', 'create_date', 'write_date', 'message_main_attachment_id'].includes(field.name))
    .sort((a, b) => (a.label.en ?? a.name).localeCompare(b.label.en ?? b.name));
}

/** Numeric fields that can be summed / averaged. */
export function measureFields(fields: Record<string, FieldDef>): FieldDef[] {
  return Object.values(fields)
    .filter((field) => ['integer', 'float', 'monetary'].includes(field.type) && !['id', 'sequence', 'color', 'priority'].includes(field.name))
    .sort((a, b) => (a.label.en ?? a.name).localeCompare(b.label.en ?? b.name));
}

/** The row entry for a groupby spec: exact key, then `field:interval` (dates default to month), then the bare field. */
function groupValue(row: ReadGroupRow, groupby: string): unknown {
  if (groupby in row) return row[groupby];
  const name = groupby.split(':')[0];
  const dated = Object.keys(row).find((key) => key.startsWith(`${name}:`));
  return dated ? row[dated] : row[name];
}

export function groupLabel(row: ReadGroupRow, groupby: string, field: FieldDef | undefined, t: (text: I18n | string | undefined) => string): string {
  const value = groupValue(row, groupby);
  if (value === false || value === null || value === undefined) return t({ en: 'None', ar: 'لا شيء' });
  if (Array.isArray(value)) return String(value[1]);
  if (field?.type === 'selection') {
    const option = field.selection?.find((item) => item.value === value);
    return option ? t(option.label) : String(value);
  }
  if (field?.type === 'boolean') return value ? t({ en: 'Yes', ar: 'نعم' }) : t({ en: 'No', ar: 'لا' });
  return String(value);
}

/** Stable key for a group value (ids for many2one, raw otherwise). */
export function groupKey(row: ReadGroupRow, groupby: string): string {
  const value = groupValue(row, groupby);
  if (Array.isArray(value)) return `id:${value[0]}`;
  return value === false || value == null ? 'none' : `v:${String(value)}`;
}

/** Give date group-bys their default interval so keys match what read_group returns. */
export function withInterval(groupby: string, fields: Record<string, FieldDef>): string {
  const name = groupby.split(':')[0];
  const type = fields[name]?.type;
  return (type === 'date' || type === 'datetime') && !groupby.includes(':') ? `${name}:month` : groupby;
}

/** Base name of a groupby spec (`date_order:month` → `date_order`). */
export function groupField(groupby: string): string {
  return groupby.split(':')[0];
}

/** Measure spec (`amount_total:sum`) → the field it aggregates. */
export function measureField(measure: string): string {
  return measure.split(':')[0];
}
