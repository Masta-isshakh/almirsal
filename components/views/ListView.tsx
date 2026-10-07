'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { FieldNode, ListArch } from '@engine/registry/arch';
import type { Domain, FieldDef } from '@engine/registry/types';
import type { I18n } from '@engine/i18n/types';
import type { ReadGroupRow } from '@engine/orm/read-group';
import { rpc } from '@/lib/client/rpc';
import { useLang, useT } from '@/lib/client/i18n';
import { badgeClass, decorationClasses, isInvisible, isReadonly, isRequired, listColumns, listFieldNames, makeRecordScope, specificationFor } from '@/lib/client/arch';
import { evalCondition } from '@engine/expr/evaluate';
import { formatValue, idOf, nameOf, useCurrencies } from '@/lib/client/display';
import { AnalyticDistributionField, StatisticsField } from '../fields/widgets';
import { Field } from '../fields/Field';
import { widgetKind } from '../fields/routing';
import type { SessionInfo } from '../webclient/WebClient';
import { EmptyState } from './EmptyState';
import { writeValue } from './form/lines';
import { resolveWireValues } from './form/resolve';
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
  /** Bumped by the control panel's New on an editable list: add a row in place. */
  newRowSignal?: number;
  /** An editable list reports its row being edited, for the Save / Discard buttons. */
  onEditing?: (controls: { save: () => void; discard: () => void } | null) => void;
}

/** The record id a row added in place carries until it is saved. */
const NEW_ROW = -1;

interface RowEdit {
  /** The record's id; null for a row added in place. */
  id: number | null;
  values: Rec;
  /** What is sent on save: the user's edits, onchange results, and for a new row its defaults. */
  changes: Rec;
  invalid: Set<string>;
}

const isEmptyValue = (value: unknown) => value === false || value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);

/**
 * A-4 §3: sticky header, sortable columns, optional-column toggler,
 * decorations, badges, footer aggregates, group headers with counts and
 * sums (folded until clicked), sample-data empty state.
 */
export function ListView(props: Props) {
  const { arch, fields, model, domain, groupBy, offset, limit, onTotal, onOpen, onSelect, onRecords, onHover, user, context, help, newRowSignal, onEditing } = props;
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

  const columns = useMemo(() => listColumns(arch, optional, { context, uid: user.uid, companyIds: user.companyIds }), [arch, optional, context, user.uid, user.companyIds]);
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
        }, { context });
        if (cancelled) return;
        setGroups(rows);
        setRecords(null);
        onTotal(rows.reduce((sum, row) => sum + row.__count, 0));
      } else {
        const result = await rpc<{ length: number; records: Rec[] }>('webSearchRead', model, { domain, specification: spec, offset, limit, order }, { context });
        if (cancelled) return;
        setRecords(result.records);
        setGroups(null);
        select(new Set());
        onRecords?.(result.records.map((record) => record.id as number));
        setTotal(result.length);
        onTotal(result.length);
        if (sumColumns.length && result.length) {
          const agg = await rpc<ReadGroupRow[]>('readGroup', model, { domain, fields: sumColumns.map((c) => `${c.name}:${c.avg ? 'avg' : 'sum'}`), groupby: [] }, { context });
          if (!cancelled) setTotals(agg[0] ?? null);
        }
      }
      setLoading(false);
    })().catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [model, domain, groupBy, offset, limit, order, spec, context]); // eslint-disable-line react-hooks/exhaustive-deps

  async function expandGroup(row: ReadGroupRow, key: string) {
    if (expanded[key]) { setExpanded((map) => { const next = { ...map }; delete next[key]; return next; }); return; }
    const result = await rpc<{ length: number; records: Rec[] }>('webSearchRead', model, { domain: row.__domain, specification: spec, limit: 80, order }, { context });
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

  // Odoo's `handle` widget: a grip in the first column that drags a row to a
  // new place and writes the order back on the sequence field.
  const handleColumn = columns.find((column) => column.widget === 'handle');
  const reorder = async (from: number, to: number) => {
    if (!handleColumn || !records || from === to) return;
    const ordered = [...records];
    const [moved] = ordered.splice(from, 1);
    ordered.splice(to, 0, moved);
    setRecords(ordered);
    await Promise.all(ordered.map((record, index) => rpc('write', model, { ids: [record.id], values: { [handleColumn.name]: (index + 1) * 10 } })))
      .catch(() => undefined);
  };

  /**
   * A toggle in a list writes at once, as Odoo's `boolean_toggle` does (Allow
   * Reconciliation on the chart of accounts, Active on a product). The row is
   * updated in place, so the list neither reloads nor loses its scroll.
   */
  const writeField = async (id: number, name: string, value: unknown): Promise<void> => {
    const previous = records;
    setRecords((rows) => rows?.map((row) => (row.id === id ? { ...row, [name]: value } : row)) ?? rows);
    try {
      await rpc('write', model, { ids: [id], values: { [name]: value } }, { context });
    } catch {
      setRecords(previous);
    }
  };

  // ---- Editable lists (`editable="top|bottom"`): Odoo edits a row in place
  // instead of opening a form. A click on a row edits it; New adds a row at the
  // top or the bottom; leaving the row (another row, outside the list, Enter,
  // Save) saves it, and Escape or Discard drops the edit.
  const editable = arch.editable !== undefined && arch.edit !== false;
  const [edit, setEditState] = useState<RowEdit | null>(null);
  const editRef = useRef<RowEdit | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // The ref moves with every change, so a save started by the same keystroke
  // that committed a field (Enter blurs it) sees that value.
  const setEdit = (next: RowEdit | null) => { editRef.current = next; setEditState(next); };
  const savingRef = useRef<Promise<boolean> | null>(null);

  const replaceRow = (fromId: number, saved: Rec | null) => {
    const swap = (rows: Rec[]) => (saved ? rows.map((row) => (row.id === fromId ? saved : row)) : rows.filter((row) => row.id !== fromId));
    setRecords((rows) => (rows ? swap(rows) : rows));
    setExpanded((map) => Object.fromEntries(Object.entries(map).map(([key, rows]) => [key, swap(rows)])));
  };

  const discardRow = () => {
    const current = editRef.current;
    if (!current) return;
    if (current.id === null) replaceRow(NEW_ROW, null);
    setEdit(null);
  };

  const saveRow = (): Promise<boolean> => {
    if (savingRef.current) return savingRef.current;
    const current = editRef.current;
    if (!current) return Promise.resolve(true);
    if (current.id !== null && Object.keys(current.changes).length === 0) { setEdit(null); return Promise.resolve(true); }
    const scope = makeRecordScope(current.values, { uid: user.uid, context, companyIds: user.companyIds, fields });
    const missing = columns.filter((column) => fields[column.name] && !isInvisible(column, scope) && isRequired(column, fields[column.name], scope) && isEmptyValue(current.values[column.name]));
    if (missing.length) { setEdit({ ...current, invalid: new Set(missing.map((column) => column.name)) }); return Promise.resolve(false); }
    const values: Rec = {};
    for (const [name, value] of Object.entries(current.changes)) {
      if (name === 'id' || name === 'display_name' || !fields[name]) continue;
      const converted = writeValue(fields[name], value);
      if (converted !== undefined) values[name] = converted;
    }
    const run = (async () => {
      try {
        const saved = await rpc<Rec>('webSave', model, { id: current.id ?? undefined, values, specification: spec }, { context });
        replaceRow(current.id ?? NEW_ROW, saved);
        if (current.id === null) { setTotal((n) => n + 1); onTotal(total + 1); }
        if (editRef.current && editRef.current.id === current.id) setEdit(null);
        return true;
      } catch {
        return false;
      } finally {
        savingRef.current = null;
      }
    })();
    savingRef.current = run;
    return run;
  };

  const startEdit = async (record: Rec) => {
    const id = record.id as number;
    if (editRef.current && (editRef.current.id ?? NEW_ROW) === id) return;
    if (!(await saveRow())) return;
    setEdit({ id, values: { ...record }, changes: {}, invalid: new Set() });
  };

  const addRow = async () => {
    if (!(await saveRow())) return;
    const defaults = await rpc<Rec>('defaultGet', model, { fields: names }, { context }).catch(() => ({} as Rec));
    const resolved = await resolveWireValues(fields, defaults);
    const values: Rec = { id: NEW_ROW };
    for (const name of names) values[name] = resolved[name] ?? (fields[name]?.type === 'one2many' || fields[name]?.type === 'many2many' ? [] : false);
    setRecords((rows) => (arch.editable === 'bottom' ? [...(rows ?? []), values] : [values, ...(rows ?? [])]));
    setEdit({ id: null, values, changes: resolved, invalid: new Set() });
  };

  const changeField = async (name: string, value: unknown) => {
    const current = editRef.current;
    if (!current) return;
    const invalid = new Set(current.invalid);
    invalid.delete(name);
    const next: RowEdit = { ...current, values: { ...current.values, [name]: value }, changes: { ...current.changes, [name]: value }, invalid };
    setEdit(next);
    try {
      const plain: Rec = {};
      for (const [key, item] of Object.entries(next.values)) plain[key] = item && typeof item === 'object' && !Array.isArray(item) ? idOf(item) : item;
      if (next.id === null) delete plain.id;
      const result = await rpc<{ value?: Rec }>('onchange', model, { values: plain, fields: [name] }, { silent: true, context });
      if (result.value && Object.keys(result.value).length && editRef.current && editRef.current.id === next.id) {
        const resolved = await resolveWireValues(fields, result.value);
        const latest = editRef.current;
        setEdit({ ...latest, values: { ...latest.values, ...resolved }, changes: { ...latest.changes, ...resolved } });
      }
    } catch { /* an onchange failure leaves the typed value */ }
  };

  // The control panel's New adds a row here.
  const lastSignal = useRef(newRowSignal);
  useEffect(() => {
    if (newRowSignal === lastSignal.current) return;
    lastSignal.current = newRowSignal;
    if (editable) void addRow();
  }, [newRowSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  // Save / Discard in the control panel while a row is being edited.
  const editing = edit !== null;
  useEffect(() => {
    onEditing?.(editing ? { save: () => { void saveRow(); }, discard: discardRow } : null);
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onEditing?.(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  // A click outside the list saves the row (a click, not a mousedown, so a
  // field that commits on blur has committed by then). Dialogs and the
  // control panel's own New / Save / Discard are left to themselves.
  useEffect(() => {
    if (!editing) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target || !target.isConnected || listRef.current?.contains(target)) return;
      if (target.closest('.o_dialog_backdrop, .o_list_button_save, .o_list_button_discard')) return;
      void saveRow();
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  const renderEditingRow = (record: Rec, current: RowEdit) => {
    const scope = makeRecordScope(current.values, { uid: user.uid, context, companyIds: user.companyIds, fields });
    return (
      <tr key={record.id as number} className="o_data_row o_selected_row"
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); discardRow(); }
          if (event.key === 'Enter' && !event.defaultPrevented && (event.target as HTMLElement).tagName !== 'TEXTAREA') { event.preventDefault(); void saveRow(); }
        }}>
        <td className="o_list_record_selector" />
        {columns.map((column, index) => {
          const field = fields[column.name];
          if (!field || isInvisible(column, scope)) return <td key={`${column.name}-${index}`} data-name={column.name} />;
          if (column.widget === 'handle' || isReadonly(column, field, scope)) {
            return <Cell key={`${column.name}-${index}`} column={column} field={field} record={current.values} scope={scope} />;
          }
          const numeric = ['integer', 'float', 'monetary'].includes(field.type);
          return (
            <td key={`${column.name}-${index}`} data-name={column.name}
              className={`o_list_editable_cell ${numeric ? 'o_list_number' : ''} ${current.invalid.has(column.name) ? 'o_field_invalid' : ''}`}>
              <Field node={column} field={field} value={current.values[column.name]} record={current.values} readonly={false}
                required={isRequired(column, field, scope)} onChange={(next) => { void changeField(column.name, next); }} />
            </td>
          );
        })}
        <td />
      </tr>
    );
  };

  const renderRow = (record: Rec, position = 0) => {
    if (edit && (edit.id ?? NEW_ROW) === record.id) return renderEditingRow(record, edit);
    const scope = makeRecordScope(record, { uid: user.uid, context, companyIds: user.companyIds, fields });
    const rowClass = decorationClasses(arch.decorations, scope);
    return (
      <tr key={record.id as number} draggable={Boolean(handleColumn)}
        onDragStart={(event) => { if (handleColumn) event.dataTransfer.setData('text/plain', String(position)); }}
        onDragOver={(event) => { if (handleColumn) event.preventDefault(); }}
        onDrop={(event) => { if (!handleColumn) return; event.preventDefault(); void reorder(Number(event.dataTransfer.getData('text/plain')), position); }}
        className={`o_data_row ${rowClass} ${selected.has(record.id as number) ? 'o_selected' : ''}`} onClick={() => { if (editable) void startEdit(record); else onOpen(record.id as number); }} onMouseEnter={() => onHover?.(record.id as number)}>
        <td className="o_list_record_selector" onClick={(event) => event.stopPropagation()}><input type="checkbox" className="form-check-input" checked={selected.has(record.id as number)} onChange={() => toggleSelected(record.id as number)} /></td>
        {columns.map((column, index) => <Cell key={`${column.name}-${index}`} column={column} field={fields[column.name]} record={record} scope={scope} onWrite={writeField} />)}
        <td />
      </tr>
    );
  };

  return (
    <div className={`o_list_view ${editable ? 'o_list_editable' : ''}`} ref={listRef}>
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
                <th key={`${column.name}-${index}`} data-name={column.name} className={`o_column_sortable ${numeric ? 'o_list_number_th' : ''}`} onClick={() => toggleSort(column)}>
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
          {records?.map((record, index) => renderRow(record, index))}
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
                  {column.sum || column.avg ? formatValue(fields[column.name], totals[column.name], { lang, record: {}, currencies, fieldOptions: column.options }) : ''}
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

function Cell({ column, field, record, scope, onWrite }: { column: FieldNode; field: FieldDef | undefined; record: Rec; scope: ReturnType<typeof makeRecordScope>; onWrite?: (id: number, name: string, value: unknown) => void }) {
  const lang = useLang();
  const t = useT();
  const currencies = useCurrencies();
  if (!field) return <td />;
  // A column can hide its value on some rows (`invisible="payment_state ==
  // 'paid'"` on an invoice's due date): the cell stays, empty, as in Odoo.
  if (typeof column.invisible === 'string' && evalCondition(column.invisible, scope, false)) return <td data-name={column.name} />;
  if (column.invisible === true) return <td data-name={column.name} />;
  const value = record[column.name];
  const numeric = ['integer', 'float', 'monetary'].includes(field.type);
  const classes = [numeric ? 'o_list_number' : '', decorationClasses(column.decorations, scope)].filter(Boolean).join(' ');

  if (column.widget === 'handle') {
    return <td data-name={column.name} className="o_row_handle" title={t('Drag to reorder')}><i className="fa fa-ellipsis-v" aria-hidden="true" /><i className="fa fa-ellipsis-v" aria-hidden="true" /></td>;
  }
  if (column.widget === 'badge' || column.widget === 'label_selection') {
    const text = formatValue(field, value, { lang, widget: column.widget, record, currencies });
    return <td data-name={column.name} className={classes}>{text && <span className={`badge rounded-pill ${badgeClass(column.decorations, scope)}`}>{text}</span>}</td>;
  }
  if (column.widget === 'many2many_tags' && Array.isArray(value)) {
    return (
      <td data-name={column.name} className={classes}>
        {value.map((item, index) => <span key={index} className="badge rounded-pill text-bg-secondary me-1">{nameOf(item) || idOf(item)}</span>)}
      </td>
    );
  }
  if (column.widget === 'boolean_toggle') {
    // Odoo's list toggle is live: a click writes the field, unless the column
    // or the field is read-only.
    const locked = field.readonly === true || evalCondition(column.readonly, scope, false) || !onWrite;
    return (
      <td data-name={column.name} className={classes} onClick={(event) => { if (!locked) event.stopPropagation(); }}>
        <div className="form-check form-switch mb-0">
          <input type="checkbox" role="switch" className="form-check-input" checked={Boolean(value)} disabled={locked}
            onChange={(event) => onWrite?.(record.id as number, column.name, event.target.checked)} />
        </div>
      </td>
    );
  }
  if (field.type === 'boolean') {
    return <td data-name={column.name} className={classes}><input type="checkbox" className="form-check-input" checked={Boolean(value)} readOnly /></td>;
  }
  if (column.widget === 'many2one_avatar_user' && value) {
    const name = nameOf(value);
    return (
      <td data-name={column.name} className={classes}>
        <span className="o_avatar me-2" style={{ width: 20, height: 20, fontSize: 10, borderRadius: '50%', background: `hsl(${[...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) % 360}, 68%, 52%)` }}>{name.slice(0, 1)}</span>{name}
      </td>
    );
  }
  if (column.widget === 'priority') {
    const level = Number(value) || 0;
    return <td data-name={column.name} className={classes}>{[1, 2, 3].map((star) => <i key={star} className={`fa ${level >= star ? 'fa-star text-warning' : 'fa-star-o text-muted'}`} />)}</td>;
  }
  // `shortcut`: a canned response is typed as ":hello".
  if (column.widget === 'shortcut') {
    const text = value === false || value == null ? '' : String(value);
    return <td data-name={column.name} className={classes}>{text ? <span className="o_shortcut badge rounded-pill text-bg-light border font-monospace">{`:${text}`}</span> : null}</td>;
  }
  if (column.widget === 'contact_statistics') {
    return <td data-name={column.name} className={classes}><StatisticsField node={column} field={field} value={value} record={record} readonly required={false} onChange={() => undefined} /></td>;
  }
  if (column.widget === 'analytic_distribution') {
    return <td data-name={column.name} className={classes}><AnalyticDistributionField node={column} field={field} value={value} record={record} readonly required={false} onChange={() => undefined} /></td>;
  }
  // `char_with_placeholder_field`: an unnumbered draft shows its placeholder.
  if (column.widget === 'char_with_placeholder_field') {
    const text = value === false || value == null || value === '/' ? '' : String(value);
    return <td data-name={column.name} className={classes}>{text || <span className="text-muted">{t(column.placeholder ?? 'Draft')}</span>}</td>;
  }
  if (column.widget === 'activity_exception') {
    return <td data-name={column.name} className={classes}>{value ? <i className="fa fa-exclamation-triangle text-warning" title={t('Exception')} /> : null}</td>;
  }
  // `rotting`: the stage, with the clock Odoo adds when a record sits too long.
  if (column.widget === 'rotting') {
    return (
      <td data-name={column.name} className={classes}>
        {formatValue(field, value, { lang, record, currencies })}
        {record.is_rotting ? <i className="fa fa-clock-o text-danger ms-1" title={t('This record has been in this stage for a while')} /> : null}
      </td>
    );
  }
  // `name_with_subtask_count`: "Design (2 sub-tasks)".
  if (column.widget === 'name_with_subtask_count') {
    const subtasks = Number(record.subtask_count ?? 0);
    return <td data-name={column.name} className={classes}>{String(value ?? '')}{subtasks ? <span className="text-muted ms-1">{subtasks === 1 ? t('(1 sub-task)') : `(${subtasks} ${t('sub-tasks')})`}</span> : null}</td>;
  }
  if (column.widget === 'list_activity' || column.widget === 'kanban_activity') {
    return <td data-name={column.name} className={classes}><i className="fa fa-clock-o text-muted" title={t('Activities')} /></td>;
  }
  // A widget the cells above do not draw themselves, but the field renderer
  // does, is drawn by it — a file size, a star, a badge or a link then looks
  // the same in a list as it does on a form.
  if (column.widget && CELL_WIDGETS.has(widgetKind(column.widget, field) ?? '')) {
    return (
      <td data-name={column.name} className={classes}>
        <Field node={column} field={field} value={value} record={record} readonly required={false} onChange={() => undefined} />
      </td>
    );
  }
  return <td data-name={column.name} className={classes}>{formatValue(field, value, { lang, widget: column.widget, record, currencies, fieldOptions: column.options })}</td>;
}

/**
 * The widget kinds a list cell hands to the field renderer. They all draw a
 * value rather than an editor, so a cell stays a cell.
 */
const CELL_WIDGETS = new Set([
  'file_size', 'favorite', 'statistics', 'selection_badge', 'relative_date', 'open_record', 'presence_status',
  'activity_exception', 'percentpie', 'progressbar', 'clipboard', 'link', 'remaining_days', 'analytic_distribution',
  'image', 'color', 'x2many_buttons',
]);

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
