'use client';

import { useEffect, useMemo, useState } from 'react';
import type { KanbanArch } from '@engine/registry/arch';
import type { Domain, FieldDef } from '@engine/registry/types';
import type { I18n } from '@engine/i18n/types';
import type { ReadGroupRow } from '@engine/orm/read-group';
import { rpc } from '@/lib/client/rpc';
import { useLang, useT } from '@/lib/client/i18n';
import { specificationFor } from '@/lib/client/arch';
import { formatValue, nameOf, useCurrencies } from '@/lib/client/display';
import type { SessionInfo } from '../webclient/WebClient';
import { EmptyState } from './EmptyState';

type Rec = Record<string, unknown>;

interface Props {
  arch: KanbanArch; fields: Record<string, FieldDef>; model: string; domain: Domain; groupBy: string[];
  offset: number; limit: number; onTotal: (total: number) => void; onOpen: (id: number) => void;
  user: SessionInfo; context: Record<string, unknown>; help?: I18n;
}

/**
 * A-4 §4, composed from the export's card summary: the record name as the
 * title, the remaining card fields as rows (badges for label_selection,
 * money formatted), colour stripe from `highlight_color`, grouped columns
 * when a group-by is active or the arch declares `default_group_by`.
 */
export function KanbanView({ arch, fields, model, domain, groupBy, offset, limit, onTotal, onOpen, context, help }: Props) {
  const t = useT();
  const lang = useLang();
  const currencies = useCurrencies();
  const card = arch.templates.card;
  const cardFields = useMemo(() => {
    const names = new Set<string>(card?.fields ?? []);
    for (const field of arch.fields) names.add(field.name);
    if (arch.highlightColor) names.add(arch.highlightColor);
    if (fields.name) names.add('name');
    return [...names].filter((name) => fields[name]);
  }, [card, arch, fields]);
  const widgets = useMemo(() => {
    const map: Record<string, string> = {};
    for (const entry of card?.widgets ?? []) {
      const [name, rest] = entry.split(':');
      if (rest) map[name] = rest.split(' ')[0];
    }
    return map;
  }, [card]);
  const spec = useMemo(() => specificationFor(cardFields, fields), [cardFields, fields]);
  const grouping = groupBy[0] ?? arch.defaultGroupBy;

  const [records, setRecords] = useState<Rec[] | null>(null);
  const [columns, setColumns] = useState<{ row: ReadGroupRow; records: Rec[] }[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      if (grouping) {
        const groups = await rpc<ReadGroupRow[]>('readGroup', model, { domain, fields: [], groupby: [grouping], options: { lazy: true } });
        const loaded = await Promise.all(groups.map(async (row) => ({
          row, records: (await rpc<{ records: Rec[] }>('webSearchRead', model, { domain: row.__domain, specification: spec, limit: 40, order: arch.defaultOrder })).records,
        })));
        if (cancelled) return;
        setColumns(loaded);
        setRecords(null);
        onTotal(groups.reduce((sum, row) => sum + row.__count, 0));
      } else {
        const result = await rpc<{ length: number; records: Rec[] }>('webSearchRead', model, { domain, specification: spec, offset, limit, order: arch.defaultOrder });
        if (cancelled) return;
        setRecords(result.records);
        setColumns(null);
        onTotal(result.length);
      }
      setLoading(false);
    })().catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [model, domain, grouping, offset, limit, spec, arch.defaultOrder]); // eslint-disable-line react-hooks/exhaustive-deps

  const isEmpty = !loading && ((records && records.length === 0) || (columns && columns.length === 0));

  const renderCard = (record: Rec) => {
    const title = typeof record.name === 'string' ? record.name : nameOf(record.display_name) || String(record.display_name ?? '');
    const color = arch.highlightColor ? Number(record[arch.highlightColor]) : 0;
    return (
      <div key={record.id as number} className="o_kanban_record" onClick={() => onOpen(record.id as number)}>
        {color > 0 && <span className="o_kanban_color_stripe" style={{ background: `var(--o-color-${color})` }} />}
        <div className="o_kanban_title">{title}</div>
        {cardFields.filter((name) => name !== 'name' && name !== arch.highlightColor && name !== 'display_name').map((name) => {
          const field = fields[name];
          const value = record[name];
          if (value === false || value === null || value === undefined || (Array.isArray(value) && value.length === 0)) return null;
          if (field.type === 'many2one' && name === 'currency_id') return null;
          const widget = widgets[name];
          if (widget === 'label_selection' || widget === 'badge') {
            return <span key={name} className="badge rounded-pill text-bg-secondary me-1">{formatValue(field, value, { lang, record, currencies })}</span>;
          }
          if (widget === 'kanban_activity') return null;
          const text = formatValue(field, value, { lang, widget, record, currencies });
          if (!text) return null;
          return <div key={name} className={`small ${field.type === 'monetary' ? 'fw-bold' : 'text-muted'}`}>{text}</div>;
        })}
      </div>
    );
  };

  return (
    <div className={`o_kanban_view ${grouping ? '' : 'o_kanban_ungrouped'} ${isEmpty && arch.sample ? 'o_sample_data' : ''}`}>
      {loading && <div className="o_loading_indicator" />}
      {records?.map(renderCard)}
      {columns?.map(({ row, records: items }) => {
        const label = row[grouping!.split(':')[0]] ?? row[grouping!];
        const text = Array.isArray(label) ? label[1] : label === false ? t('None') : String(label);
        return (
          <div key={JSON.stringify(row.__domain)} className="o_kanban_group">
            <div className="o_kanban_header"><span>{text}</span><span className="o_kanban_counter">{row.__count}</span></div>
            {items.map(renderCard)}
          </div>
        );
      })}
      {isEmpty && <EmptyState help={help} />}
    </div>
  );
}
