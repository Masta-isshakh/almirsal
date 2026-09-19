'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { FieldDef } from '@engine/registry/types';
import type { Lang } from '@engine/i18n/types';
import { t as resolve } from '@engine/i18n/types';
import {
  DEFAULT_CURRENCY, formatDate, formatDateTime, formatFloat, formatFloatTime, formatInteger,
  formatMonetary, formatPercentage, type CurrencyDef,
} from '@engine/format/index';
import { rpc } from './rpc';

/**
 * Read-only rendering of a field value, shared by list cells, kanban cards
 * and readonly form fields. Money needs the record's currency, so currencies
 * are loaded once and provided.
 */

const CurrencyContext = createContext<Record<number, CurrencyDef>>({});

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [currencies, setCurrencies] = useState<Record<number, CurrencyDef>>({});
  useEffect(() => {
    let cancelled = false;
    rpc<Record<string, unknown>[]>('searchRead', 'res.currency', {
      domain: [], fields: ['name', 'symbol', 'position', 'decimal_places', 'rounding'], limit: 500,
    }, { silent: true }).then((rows) => {
      if (cancelled) return;
      const map: Record<number, CurrencyDef> = {};
      for (const row of rows) {
        map[row.id as number] = {
          id: row.id as number,
          name: String(row.name),
          symbol: String(row.symbol || row.name),
          position: row.position === 'before' ? 'before' : 'after',
          decimalPlaces: Number(row.decimal_places ?? 2),
          rounding: Number(row.rounding || 0.01),
        };
      }
      setCurrencies(map);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  return <CurrencyContext.Provider value={currencies}>{children}</CurrencyContext.Provider>;
}

export function useCurrencies(): Record<number, CurrencyDef> {
  return useContext(CurrencyContext);
}

function idOf(value: unknown): number | null {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'id' in (value as object)) return (value as { id: number }).id;
  if (Array.isArray(value) && typeof value[0] === 'number') return value[0];
  return null;
}

function nameOf(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'display_name' in (value as object)) return String((value as { display_name: string }).display_name ?? '');
  if (Array.isArray(value) && value.length === 2 && typeof value[1] === 'string') return value[1];
  return '';
}

export function currencyOf(record: Record<string, unknown>, field: FieldDef, currencies: Record<number, CurrencyDef>): CurrencyDef {
  const currencyField = field.currencyField ?? 'currency_id';
  const id = idOf(record[currencyField]);
  return (id && currencies[id]) || DEFAULT_CURRENCY;
}

/** Plain-text rendering of a value. */
export function formatValue(field: FieldDef, value: unknown, options: { lang: Lang; widget?: string; record?: Record<string, unknown>; currencies?: Record<number, CurrencyDef> }): string {
  const { lang, widget, record = {}, currencies = {} } = options;
  if (value === false || value === null || value === undefined) return '';
  switch (field.type) {
    case 'monetary':
      return formatMonetary(value as number, currencyOf(record, field, currencies));
    case 'float':
      if (widget === 'float_time') return formatFloatTime(value as number);
      if (widget === 'percentage') return formatPercentage(value as number);
      if (widget === 'monetary') return formatMonetary(value as number, currencyOf(record, field, currencies));
      return formatFloat(value as number, { digits: field.digits });
    case 'integer':
      return formatInteger(value as number);
    case 'date':
      return formatDate(value as string, lang);
    case 'datetime':
      return formatDateTime(value as string, lang, { withSeconds: false });
    case 'boolean':
      return value ? '✓' : '';
    case 'selection': {
      const option = field.selection?.find((item) => item.value === value);
      return option ? resolve(option.label, lang) : String(value);
    }
    case 'many2one':
      return nameOf(value);
    case 'one2many':
    case 'many2many':
      if (Array.isArray(value)) return value.map((item) => nameOf(item) || String(idOf(item) ?? item)).filter(Boolean).join(', ');
      return '';
    case 'html':
      return String(value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    default:
      return String(value);
  }
}

export { idOf, nameOf };
