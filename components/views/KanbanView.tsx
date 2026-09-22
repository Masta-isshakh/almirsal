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
import { groupKey, groupLabel } from './groups';
import type { SessionInfo } from '../webclient/WebClient';
import { EmptyState } from './EmptyState';
import { AccountingDashboard } from './AccountingDashboard';
import { useActions } from '@/lib/client/actions';
import { Dropdown } from '../webclient/Navbar';

interface CardButton { name?: string; type?: string; string?: I18n; class?: string }

type Rec = Record<string, unknown>;

interface Props {
  arch: KanbanArch; fields: Record<string, FieldDef>; model: string; domain: Domain; groupBy: string[];
  offset: number; limit: number; onTotal: (total: number) => void; onOpen: (id: number) => void;
  user: SessionInfo; context: Record<string, unknown>; help?: I18n;
  onHover?: (id: number) => void;
}

/**
 * A-4 §4, composed from the export's card summary: the record name as the
 * title, the remaining card fields as rows (badges for label_selection,
 * money formatted), colour stripe from `highlight_color`, grouped columns
 * when a group-by is active or the arch declares `default_group_by`.
 */
export function KanbanView({ arch, fields, model, domain, groupBy, offset, limit, onTotal, onOpen, onHover, context, help }: Props) {
  const t = useT();
  const lang = useLang();
  const currencies = useCurrencies();
  const { doAction } = useActions();
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
  const [reload, setReload] = useState(0);
  const [dragging, setDragging] = useState<{ id: number; from: string } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [quick, setQuick] = useState<string | null>(null);
  const [quickName, setQuickName] = useState('');
  const groupField = grouping ? grouping.split(':')[0] : null;
  const groupDef = groupField ? fields[groupField] : undefined;
  // Cards move between columns when the group-by is a plain many2one / selection / boolean field.
  const canDrag = Boolean(groupDef && ['many2one', 'selection', 'boolean'].includes(groupDef.type) && !grouping?.includes(':'));

  /** Value to write so a record lands in the column of `row`. */
  const columnValue = (row: ReadGroupRow): unknown => {
    const raw = row[groupField!];
    return Array.isArray(raw) ? raw[0] : raw;
  };

  const drop = async (target: { row: ReadGroupRow; records: Rec[] }) => {
    if (!dragging || !groupField) return;
    const key = groupKey(target.row, grouping!);
    setOver(null);
    if (key === dragging.from) { setDragging(null); return; }
    const id = dragging.id;
    const from = dragging.from;
    setDragging(null);
    // Optimistic move, then the write; reload on failure.
    setColumns((current) => current?.map((column) => {
      const columnKey = groupKey(column.row, grouping!);
      if (columnKey === from) return { ...column, row: { ...column.row, __count: column.row.__count - 1 }, records: column.records.filter((record) => record.id !== id) };
      if (columnKey === key) { const moved = current.flatMap((c) => c.records).find((record) => record.id === id); return moved ? { ...column, row: { ...column.row, __count: column.row.__count + 1 }, records: [...column.records, moved] } : column; }
      return column;
    }) ?? null);
    try { await rpc('write', model, { ids: [id], values: { [groupField]: columnValue(target.row) } }); }
    catch { setReload((n) => n + 1); }
  };

  const quickCreate = async (row: ReadGroupRow) => {
    const name = quickName.trim();
    if (!name || !groupField) return;
    const recName = fields.name ? 'name' : fields.summary ? 'summary' : 'display_name';
    try {
      await rpc('create', model, { values: { [recName]: name, [groupField]: columnValue(row) } }, { context });
      setQuickName('');
      setQuick(null);
      setReload((n) => n + 1);
    } catch { /* error dialog shown by the rpc listener */ }
  };

  const toggleFold = (key: string) => setFolded((set) => { const next = new Set(set); if (next.has(key)) next.delete(key); else next.add(key); return next; });

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
  }, [model, domain, grouping, offset, limit, spec, arch.defaultOrder, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const isEmpty = !loading && ((records && records.length === 0) || (columns && columns.length === 0));

  // Dashboards with their own layout (C-8.7).
  if (arch.jsClass === 'account_dashboard_kanban') return <AccountingDashboard domain={domain} />;

  const cardButtons = ((card?.buttons ?? []) as CardButton[]).filter((b) => b.name && (b.type === 'object' || b.type === 'action'));
  const menuButtons = (((arch.templates as Record<string, { buttons?: CardButton[] }>).menu?.buttons ?? []) as CardButton[]).filter((b) => (b.type === 'object' || b.type === 'action') && b.name || b.type === 'archive' || b.type === 'unarchive' || b.type === 'open' || b.type === 'edit');
  /** A card button: object method, registry action, archive/unarchive, or open the form. */
  const runButton = async (record: Rec, button: CardButton) => {
    const id = record.id as number;
    if (button.type === 'open' || button.type === 'edit') { onOpen(id); return; }
    if (button.type === 'archive' || button.type === 'unarchive') { await rpc('toggleActive', model, { ids: [id] }); setReload((n) => n + 1); return; }
    if (button.type === 'object' && button.name) {
      const result = await rpc<Record<string, unknown> | false>('callButton', model, { ids: [id], method: button.name, context: { ...context, active_id: id, active_ids: [id], active_model: model } }, { context });
      if (result && typeof result === 'object') await doAction(result, { activeId: id, activeIds: [id], activeModel: model, onClose: () => setReload((n) => n + 1) });
      else setReload((n) => n + 1);
      return;
    }
    if (button.type === 'action' && button.name) {
      const description = await rpc<{ action: Record<string, unknown> }>('loadAction', null, { id: button.name });
      await doAction({ ...description.action, id: button.name, context: { ...context, active_id: id, active_ids: [id], active_model: model } }, { activeId: id, activeIds: [id], activeModel: model, onClose: () => setReload((n) => n + 1) });
    }
  };
  const openCard = (record: Rec) => {
    const id = record.id as number;
    if (arch.action && arch.actionType === 'object') { void runButton(record, { type: 'object', name: arch.action }); return; }
    if (arch.action && arch.actionType === 'action') { void runButton(record, { type: 'action', name: arch.action }); return; }
    if (arch.canOpen === false || arch.canOpen === 'false') return;
    onOpen(id);
  };

  const renderCard = (record: Rec, column = '') => {
    const title = typeof record.name === 'string' ? record.name : nameOf(record.display_name) || String(record.display_name ?? '');
    const color = arch.highlightColor ? Number(record[arch.highlightColor]) : 0;
    return (
      <div key={record.id as number} className={`o_kanban_record ${dragging?.id === record.id ? 'o_kanban_dragging' : ''}`} onClick={() => openCard(record)} onMouseEnter={() => onHover?.(record.id as number)}
        draggable={canDrag} onDragStart={(event) => { if (!canDrag) return; event.dataTransfer.effectAllowed = 'move'; setDragging({ id: record.id as number, from: column }); }} onDragEnd={() => { setDragging(null); setOver(null); }}>
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
        {cardButtons.length > 0 && (
          <div className="o_kanban_card_buttons" onClick={(event) => event.stopPropagation()}>
            {cardButtons.map((button, index) => (
              <button key={index} type="button" className={`btn btn-sm ${button.class?.includes('btn-primary') ? 'btn-primary' : button.class?.includes('btn-link') ? 'btn-link' : 'btn-secondary'}`} onClick={() => void runButton(record, button)}>
                {t(button.string ?? button.name ?? '')}
                {/^\s*to review/i.test(String(button.string?.en ?? '')) && typeof record.request_to_validate_count === 'number' ? ` ${record.request_to_validate_count}` : ''}
              </button>
            ))}
          </div>
        )}
        {menuButtons.length > 0 && (
          <div onClick={(event) => event.stopPropagation()}>
            <Dropdown end toggle={() => <span className="o_kanban_menu_toggle"><i className="fa fa-ellipsis-v" /></span>}>
              {menuButtons.map((button, index) => (
                <button key={index} type="button" className="o_dropdown_item" onClick={() => void runButton(record, button)}>
                  {t(button.string ?? (button.type === 'archive' ? 'Archive' : button.type === 'unarchive' ? 'Unarchive' : button.type === 'open' || button.type === 'edit' ? 'Edit' : button.name ?? ''))}
                </button>
              ))}
            </Dropdown>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={`o_kanban_view ${grouping ? '' : 'o_kanban_ungrouped'} ${isEmpty && arch.sample ? 'o_sample_data' : ''}`}>
      {loading && <div className="o_loading_indicator" />}
      {records?.map((record) => renderCard(record))}
      {columns?.map((column) => {
        const { row, records: items } = column;
        const key = groupKey(row, grouping!);
        const text = groupLabel(row, grouping!, groupDef, t);
        if (folded.has(key)) {
          return (
            <div key={key} className="o_kanban_group o_kanban_group_folded" onClick={() => toggleFold(key)}
              onDragOver={(event) => { if (dragging) { event.preventDefault(); setOver(key); } }} onDrop={(event) => { event.preventDefault(); void drop(column); }}>
              <div className="o_kanban_folded_title">{text} <span className="o_kanban_counter">{row.__count}</span></div>
            </div>
          );
        }
        return (
          <div key={key} className={`o_kanban_group ${over === key && dragging?.from !== key ? 'o_kanban_group_over' : ''}`}
            onDragOver={(event) => { if (dragging) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; if (over !== key) setOver(key); } }}
            onDragLeave={(event) => { if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)) setOver((current) => (current === key ? null : current)); }}
            onDrop={(event) => { event.preventDefault(); void drop(column); }}>
            <div className="o_kanban_header">
              <span className="o_kanban_header_title" onClick={() => toggleFold(key)} title={t('Fold')}>{text}</span>
              <span className="o_kanban_counter">{row.__count}</span>
              {arch.quickCreate !== false && groupField && (fields.name || fields.summary) && (
                <button type="button" className="o_kanban_quick_add" title={t('Quick add')} onClick={() => { setQuick(key); setQuickName(''); }}><i className="fa fa-plus" /></button>
              )}
            </div>
            {quick === key && (
              <div className="o_kanban_quick_create" onClick={(event) => event.stopPropagation()}>
                <input className="form-control form-control-sm" autoFocus placeholder={t('Title')} value={quickName} onChange={(event) => setQuickName(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') void quickCreate(row); if (event.key === 'Escape') setQuick(null); }} />
                <div className="d-flex gap-1 mt-1">
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => void quickCreate(row)}>{t('Add')}</button>
                  <button type="button" className="btn btn-link btn-sm" onClick={() => setQuick(null)}>{t('Discard')}</button>
                </div>
              </div>
            )}
            {items.map((record) => renderCard(record, key))}
            {items.length === 0 && dragging && <div className="o_kanban_drop_hint">{t('Drop here')}</div>}
          </div>
        );
      })}
      {isEmpty && <EmptyState help={help} />}
    </div>
  );
}
