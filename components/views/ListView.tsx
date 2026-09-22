'use client';

import { useEffect, useMemo, useState } from 'react';
import type { FieldNode, ListArch } from '@engine/registry/arch';
import type { Domain, FieldDef } from '@engine/registry/types';
import type { I18n } from '@engine/i18n/types';
import type { ReadGroupRow } from '@engine/orm/read-group';
import { rpc } from '@/lib/client/rpc';
import { useLang, useT } from '@/lib/client/i18n';
import { badgeClass, decorationClasses, listColumns, listFieldNames, makeRecordScope, specificationFor } from '@/lib/client/arch';
import { formatValue, idOf, nameOf, useCurrencies } from '@/lib/client/display';
import type { SessionInfo } from '../webclient/WebClient';
import { EmptyState } from './EmptyState';
import { ListSkeleton } from './Skeleton';

type Rec = Record<string, unknown>;

interface Props {
  arch: ListArch;
  fields: Record<string, FieldDef>;
  model: string;
  domain: Domain;
  groupBy: string[];
  offset: number;
  limit: number;
  onTotal: (total: number) => void;
  onOpen: (id: number) => void;
  onSelect?: (ids: number[], allMatching: boolean) => void;
  /** Ids of the loaded page, for the form pager. */
  onRecords?: (ids: number[]) => void;
  /** Pointer rests on a row: prefetch it. */
  onHover?: (id: number) => void;
  user: SessionInfo;
  context: Record<string, unknown>;
  help?: I18n;
}

/**
 * A-4 §3: sticky header, sortable columns, optional-column toggler,
 * decorations, badges, footer aggregates, group headers with counts and
 * sums (folded until clicked), sample-data empty state.
 */
export function ListView(props: Props) {
  const { arch, fields, model, domain, groupBy, offset, limit, onTotal, onOpen, onSelect, onRecords, onHover, user, context, help } = props;
  const t = useT();
  const lang = useLang();
  const currencies = useCurrencies();
  const [optional, setOptional] = useState<Set<string>>(() => new Set(arch.columns.filter((c): c is FieldNode => c.kind === 'field' && c.optional === 'show').map((c) => c.name)));
  const [order, setOrder] = useState<string | undefined>(arch.defaultOrder);
  const [records, setRecords] = useState<Rec[] | null>(null);
  const [groups, setGroups] = useState<ReadGroupRow[] | null>(null);
  const [expanded, setExpanded] = useState<Record<string, Rec[]>>({});
  const [totals, setTotals] = useState<Rec | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [total, setTotal] = useState(0);
  const select = (next: Set<number>, all = false) => { setSelected(next); setAllMatching(all); onSelect?.([...next], all); };
  const toggleSelected = (id: number) => { const next = new Set(selected); if (next.has(id)) next.delete(id); else next.add(id); select(next); };

  const columns = useMemo(() => listColumns(arch, optional), [arch, optional]);
  const optionalColumns = arch.columns.filter((c): c is FieldNode => c.kind === 'field' && !c.hidden && Boolean(c.optional));
  const names = useMemo(() => listFieldNames(arch), [arch]);
  const spec = useMemo(() => specificationFor(names, fields, arch.columns.filter((c): c is FieldNode => c.kind === 'field')), [names, fields, arch]);
  const sumColumns = columns.filter((column) => column.sum || column.avg);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      if (groupBy.length) {
        const rows = await rpc<ReadGroupRow[]>('readGroup', model, {
          domain, fields: sumColumns.map((c) => `${c.name}:${c.avg ? 'avg' : 'sum'}`), groupby: groupBy, options: { lazy: true, orderby: order },
        });
        if (cancelled) return;
        setGroups(rows);
        setRecords(null);
        onTotal(rows.reduce((sum, row) => sum + row.__count, 0));
      } else {
        const result = await rpc<{ length: number; records: Rec[] }>('webSearchRead', model, { domain, specification: spec, offset, limit, order });
        if (cancelled) return;
        setRecords(result.records);
        setGroups(null);
        select(new Set());
        onRecords?.(result.records.map((record) => record.id as number));
        setTotal(result.length);
        onTotal(result.length);
        if (sumColumns.length && result.length) {
          const agg = await rpc<ReadGroupRow[]>('readGroup', model, { domain, fields: sumColumns.map((c) => `${c.name}:${c.avg ? 'avg' : 'sum'}`), groupby: [] });
          if (!cancelled) setTotals(agg[0] ?? null);
        }
      }
      setLoading(false);
    })().catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [model, domain, groupBy, offset, limit, order, spec]); // eslint-disable-line react-hooks/exhaustive-deps

  async function expandGroup(row: ReadGroupRow, key: string) {
    if (expanded[key]) { setExpanded((map) => { const next = { ...map }; delete next[key]; return next; }); return; }
    const result = await rpc<{ length: number; records: Rec[] }>('webSearchRead', model, { domain: row.__domain, specification: spec, limit: 80, order });
    setExpanded((map) => ({ ...map, [key]: result.records }));
  }

  function toggleSort(column: FieldNode) {
    const field = fields[column.name];
    if (!field || field.type === 'one2many' || field.type === 'many2many') return;
    const current = order?.split(',')[0]?.trim().split(/\s+/) ?? [];
    const next = current[0] === column.name && current[1] !== 'desc' ? `${column.name} desc` : `${column.name} asc`;
    setOrder(next);
  }

  const sortField = order?.split(',')[0]?.trim().split(/\s+/) ?? [];
  const isEmpty = !loading && ((records && records.length === 0) || (groups && groups.length === 0));

  const renderRow = (record: Rec) => {
    const scope = makeRecordScope(record, { uid: user.uid, context, companyIds: user.companyIds, fields });
    const rowClass = decorationClasses(arch.decorations, scope);
    return (
      <tr key={record.id as number} className={`${rowClass} ${selected.has(record.id as number) ? 'o_selected' : ''}`} onClick={() => onOpen(record.id as number)} onMouseEnter={() => onHover?.(record.id as number)}>
        <td className="o_list_record_selector" onClick={(event) => event.stopPropagation()}><input type="checkbox" className="form-check-input" checked={selected.has(record.id as number)} onChange={() => toggleSelected(record.id as number)} /></td>
        {columns.map((column, index) => <Cell key={`${column.name}-${index}`} column={column} field={fields[column.name]} record={record} scope={scope} />)}
        <td />
      </tr>
    );
  };

  return (
    <div className="o_list_view">
      {loading && <div className="o_loading_indicator" />}
      {loading && records === null && groups === null && <ListSkeleton columns={Math.min(8, columns.length)} />}
      <table className={`o_list_table ${isEmpty && arch.sample ? 'o_sample_data' : ''}`} hidden={loading && records === null && groups === null}>
        <thead>
          <tr>
            <th className="o_list_record_selector"><input type="checkbox" className="form-check-input" aria-label="Select all" checked={Boolean(records?.length) && selected.size === records?.length}
              onChange={() => select(records && selected.size !== records.length ? new Set(records.map((r) => r.id as number)) : new Set())} /></th>
            {columns.map((column, index) => {
              const field = fields[column.name];
              const numeric = field && ['integer', 'float', 'monetary'].includes(field.type);
              return (
                <th key={`${column.name}-${index}`} className={`o_column_sortable ${numeric ? 'o_list_number_th' : ''}`} onClick={() => toggleSort(column)}>
                  {t(column.string ?? field?.label ?? column.name)}
                  {sortField[0] === column.name && <i className={`fa ${sortField[1] === 'desc' ? 'fa-angle-down' : 'fa-angle-up'}`} />}
                </th>
              );
            })}
            <th className="o_optional_columns_dropdown_toggle">
              {optionalColumns.length > 0 && (
                <OptionalColumns columns={optionalColumns} fields={fields} shown={optional} onToggle={(name) => setOptional((set) => { const next = new Set(set); if (next.has(name)) next.delete(name); else next.add(name); return next; })} />
              )}
            </th>
          </tr>
        </thead>
        <tbody>
          {isEmpty && arch.sample && <SampleRows columns={columns} fields={fields} />}
          {records?.map(renderRow)}
          {groups?.map((row) => {
            const key = JSON.stringify(row.__domain);
            const groupField = groupBy[0]?.split(':')[0];
            const label = row[groupBy[0]] ?? row[groupField];
            const text = Array.isArray(label) ? label[1] : label === false ? t('None') : String(label);
            return (
              <GroupRows key={key} label={String(text)} count={row.__count} row={row} columns={columns} fields={fields} expanded={expanded[key]} onToggle={() => expandGroup(row, key)} renderRow={renderRow} lang={lang} currencies={currencies} />
            );
          })}
        </tbody>
        {totals && sumColumns.length > 0 && !groups && (
          <tfoot>
            <tr>
              <td />
              {columns.map((column, index) => (
                <td key={`${column.name}-${index}`} className={column.sum || column.avg ? 'o_list_number' : ''} title={column.sum ? t(column.sum) : column.avg ? t(column.avg) : undefined}>
                  {column.sum || column.avg ? formatValue(fields[column.name], totals[column.name], { lang, record: {}, currencies }) : ''}
                </td>
              ))}
              <td />
            </tr>
          </tfoot>
        )}
      </table>
      {isEmpty && <EmptyState help={help} />}
      {records && selected.size > 0 && selected.size === records.length && total > records.length && (
        <div className="o_list_selection_box small">
          {allMatching
            ? <span>{t('All')} {total} {t('records selected.')} <a href="#none" onClick={(event) => { event.preventDefault(); select(new Set()); }}>{t('Clear selection')}</a></span>
            : <span>{t('All')} {records.length} {t('records on this page are selected.')} <a href="#all" onClick={(event) => { event.preventDefault(); select(new Set(records.map((r) => r.id as number)), true); }}>{t('Select all')} {total}</a></span>}
        </div>
      )}
    </div>
  );
}

function GroupRows({ label, count, row, columns, fields, expanded, onToggle, renderRow, lang, currencies }: {
  label: string; count: number; row: ReadGroupRow; columns: FieldNode[]; fields: Record<string, FieldDef>; expanded?: Rec[];
  onToggle: () => void; renderRow: (record: Rec) => React.ReactNode; lang: 'en_US' | 'ar_001'; currencies: ReturnType<typeof useCurrencies>;
}) {
  return (
    <>
      <tr className="o_group_header" onClick={onToggle}>
        <td colSpan={2} className="o_group_name"><i className={`fa ${expanded ? 'fa-caret-down' : 'fa-caret-right'}`} /> {label} ({count})</td>
        {columns.slice(1).map((column, index) => (
          <td key={`${column.name}-${index}`} className={column.sum ? 'o_list_number' : ''}>
            {column.sum && row[column.name] !== undefined ? formatValue(fields[column.name], row[column.name], { lang, record: {}, currencies }) : ''}
          </td>
        ))}
        <td />
      </tr>
      {expanded?.map(renderRow)}
    </>
  );
}

function Cell({ column, field, record, scope }: { column: FieldNode; field: FieldDef | undefined; record: Rec; scope: ReturnType<typeof makeRecordScope> }) {
  const lang = useLang();
  const t = useT();
  const currencies = useCurrencies();
  if (!field) return <td />;
  const value = record[column.name];
  const numeric = ['integer', 'float', 'monetary'].includes(field.type);
  const classes = [numeric ? 'o_list_number' : '', decorationClasses(column.decorations, scope)].filter(Boolean).join(' ');

  if (column.widget === 'badge' || column.widget === 'label_selection') {
    const text = formatValue(field, value, { lang, widget: column.widget, record, currencies });
    return <td className={classes}>{text && <span className={`badge rounded-pill ${badgeClass(column.decorations, scope)}`}>{text}</span>}</td>;
  }
  if (column.widget === 'many2many_tags' && Array.isArray(value)) {
    return (
      <td className={classes}>
        {value.map((item, index) => <span key={index} className="badge rounded-pill text-bg-secondary me-1">{nameOf(item) || idOf(item)}</span>)}
      </td>
    );
  }
  if (column.widget === 'boolean_toggle' || field.type === 'boolean') {
    return <td className={classes}><input type="checkbox" className="form-check-input" checked={Boolean(value)} readOnly /></td>;
  }
  if (column.widget === 'many2one_avatar_user' && value) {
    const name = nameOf(value);
    return (
      <td className={classes}>
        <span className="o_avatar me-2" style={{ width: 20, height: 20, fontSize: 10, borderRadius: '50%', background: `hsl(${[...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) % 360}, 68%, 52%)` }}>{name.slice(0, 1)}</span>{name}
      </td>
    );
  }
  if (column.widget === 'priority') {
    const level = Number(value) || 0;
    return <td className={classes}>{[1, 2, 3].map((star) => <i key={star} className={`fa ${level >= star ? 'fa-star text-warning' : 'fa-star-o text-muted'}`} />)}</td>;
  }
  if (column.widget === 'list_activity' || column.widget === 'kanban_activity') {
    return <td className={classes}><i className="fa fa-clock-o text-muted" title={t('Activities')} /></td>;
  }
  return <td className={classes}>{formatValue(field, value, { lang, widget: column.widget, record, currencies })}</td>;
}

function OptionalColumns({ columns, fields, shown, onToggle }: { columns: FieldNode[]; fields: Record<string, FieldDef>; shown: Set<string>; onToggle: (name: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <span className="o_dropdown" onClick={(event) => event.stopPropagation()}>
      <button type="button" className="btn btn-link p-0" onClick={() => setOpen((v) => !v)} title={t('Optional columns')}><i className="fa fa-cog" /></button>
      {open && (
        <div className="o_dropdown_menu o_dropdown_end" style={{ maxHeight: 400, overflow: 'auto' }}>
          {columns.map((column, index) => (
            <label key={column.name} className="o_dropdown_item d-flex gap-2 align-items-center" style={{ cursor: 'pointer' }}>
              <input type="checkbox" className="form-check-input m-0" checked={shown.has(column.name)} onChange={() => onToggle(column.name)} />
              {t(column.string ?? fields[column.name]?.label ?? column.name)}
            </label>
          ))}
        </div>
      )}
    </span>
  );
}

const SAMPLE_NAMES = ['REF0001', 'John Miller', 'Wendi Baltz', 'Henry Campbell', 'Thomas Passot', 'Carrie Helle', 'In massa', 'Integer vitae', 'Viverra nam', 'Laoreet id'];

/** B-8: ten ghost rows at 6% opacity behind the help block. */
function SampleRows({ columns, fields }: { columns: FieldNode[]; fields: Record<string, FieldDef> }) {
  return (
    <>
      {SAMPLE_NAMES.map((name, index) => (
        <tr key={name}>
          <td />
          {columns.map((column, index) => {
            const field = fields[column.name];
            const numeric = field && ['integer', 'float', 'monetary'].includes(field.type);
            return <td key={`${column.name}-${index}`} className={numeric ? 'o_list_number' : ''}>{numeric ? `${(10 + index * 9).toLocaleString()},${String(index * 137 % 1000).padStart(3, '0')}.00` : field?.type === 'date' || field?.type === 'datetime' ? '09/19/2026' : name}</td>;
          })}
          <td />
        </tr>
      ))}
    </>
  );
}
