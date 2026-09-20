'use client';

import { useState } from 'react';
import type { Domain, FieldDef } from '@engine/registry/types';
import { rpc } from '@/lib/client/rpc';
import { useLang, useT } from '@/lib/client/i18n';
import { formatValue, useCurrencies } from '@/lib/client/display';
import { Dropdown } from '../webclient/Navbar';
import { useUi } from '../webclient/ui';
import { downloadCsv, downloadXls } from './export';

type Rec = Record<string, unknown>;

interface Props {
  model: string;
  fields: Record<string, FieldDef>;
  /** Selected ids, or the whole domain when "select all" is on. */
  selected: number[];
  allMatching: boolean;
  domain: Domain;
  columns: string[];
  onDone: () => void;
  reports?: { reportName: string; name: { en: string; ar: string } }[];
  onPrint?: (reportName: string, ids: number[]) => void;
}

/**
 * The ⚙ Actions menu of a list with a selection (A-4 §3): Export (field
 * picker, CSV or Excel, selection or every matching record), Archive /
 * Unarchive with an Undo toast, Duplicate and Delete with confirmation.
 */
export function ListActions({ model, fields, selected, allMatching, domain, columns, onDone, reports = [], onPrint }: Props) {
  const t = useT();
  const ui = useUi();
  const targetDomain: Domain = allMatching ? domain : [['id', 'in', selected]];
  const label = allMatching ? t('all matching records') : `${selected.length} ${t(selected.length === 1 ? 'record' : 'records')}`;

  const ids = async (): Promise<number[]> => (allMatching ? rpc<number[]>('search', model, { domain, limit: 5000 }) : selected);

  const archive = async (active: boolean) => {
    const targets = await ids();
    await rpc('write', model, { ids: targets, values: { active } });
    onDone();
    ui.notify({
      type: 'success',
      message: { en: `${targets.length} ${active ? 'record(s) unarchived' : 'record(s) archived'}.`, ar: `${targets.length} ${active ? 'سجل تم إلغاء أرشفته' : 'سجل تمت أرشفته'}.` },
      action: { label: { en: 'Undo', ar: 'تراجع' }, onClick: async () => { await rpc('write', model, { ids: targets, values: { active: !active } }); onDone(); } },
    });
  };

  const duplicate = async () => {
    const targets = await ids();
    for (const id of targets) await rpc('copy', model, { id });
    onDone();
    ui.notify({ type: 'success', message: { en: `${targets.length} record(s) duplicated.`, ar: `تم تكرار ${targets.length} سجل.` } });
  };

  const remove = async () => {
    const targets = await ids();
    if (!(await ui.confirm({ message: { en: `Are you sure you want to delete ${targets.length} record(s)? This cannot be undone.`, ar: `هل أنت متأكد من حذف ${targets.length} سجل؟ لا يمكن التراجع عن هذا.` }, confirmLabel: { en: 'Delete', ar: 'حذف' } }))) return;
    await rpc('unlink', model, { ids: targets });
    onDone();
  };

  const openExport = () => {
    let dialogId = 0;
    dialogId = ui.openDialog({
      title: { en: 'Export Data', ar: 'تصدير البيانات' },
      size: 'lg',
      footer: null,
      body: <ExportDialog model={model} fields={fields} columns={columns} domain={targetDomain} count={allMatching ? null : selected.length} onClose={() => ui.closeDialog(dialogId)} />,
    });
  };

  return (
    <Dropdown toggle={() => <button type="button" className="btn btn-secondary"><i className="fa fa-cog me-1" />{t('Actions')} <i className="fa fa-caret-down" /></button>}>
      <div className="o_dropdown_header">{label}</div>
      <button type="button" className="o_dropdown_item" onClick={openExport}><i className="fa fa-upload me-2 text-muted" />{t('Export')}</button>
      {reports.map((report) => <button key={report.reportName} type="button" className="o_dropdown_item" onClick={async () => onPrint?.(report.reportName, await ids())}><i className="fa fa-print me-2 text-muted" />{t('Print')}: {t(report.name)}</button>)}
      {fields.active && <button type="button" className="o_dropdown_item" onClick={() => archive(false)}><i className="fa fa-archive me-2 text-muted" />{t('Archive')}</button>}
      {fields.active && <button type="button" className="o_dropdown_item" onClick={() => archive(true)}><i className="fa fa-folder-open-o me-2 text-muted" />{t('Unarchive')}</button>}
      <button type="button" className="o_dropdown_item" onClick={duplicate}><i className="fa fa-clone me-2 text-muted" />{t('Duplicate')}</button>
      <div className="o_dropdown_divider" />
      <button type="button" className="o_dropdown_item text-danger" onClick={remove}><i className="fa fa-trash-o me-2" />{t('Delete')}</button>
    </Dropdown>
  );
}

const SKIP = new Set(['id', 'display_name', 'create_uid', 'write_uid', 'create_date', 'write_date', 'message_ids', 'message_follower_ids', 'activity_ids', 'website_message_ids', 'message_main_attachment_id', 'image_1920', 'image_1024', 'image_512', 'image_256', 'image_128', 'avatar_128', 'avatar_1920']);

function ExportDialog({ model, fields, columns, domain, count, onClose }: { model: string; fields: Record<string, FieldDef>; columns: string[]; domain: Domain; count: number | null; onClose: () => void }) {
  const t = useT();
  const lang = useLang();
  const currencies = useCurrencies();
  const [chosen, setChosen] = useState<string[]>(columns.filter((name) => fields[name]));
  const [format, setFormat] = useState<'csv' | 'xls'>('xls');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const available = Object.values(fields)
    .filter((field) => !SKIP.has(field.name) && field.type !== 'binary' && field.type !== 'one2many' && field.type !== 'html')
    .filter((field) => !query || t(field.label).toLowerCase().includes(query.toLowerCase()) || field.name.includes(query.toLowerCase()))
    .sort((a, b) => t(a.label).localeCompare(t(b.label)));

  const run = async () => {
    setBusy(true);
    try {
      const rows = await rpc<Rec[]>('searchRead', model, { domain, fields: chosen, limit: 5000 });
      const header = chosen.map((name) => t(fields[name].label));
      const lines = rows.map((row) => chosen.map((name) => {
        const field = fields[name];
        const value = row[name];
        if (field.type === 'many2many' && Array.isArray(value)) return value.map((item) => (Array.isArray(item) ? item[1] : (item as Rec)?.display_name ?? item)).join(', ');
        if (field.type === 'many2one') return Array.isArray(value) ? value[1] : (value as Rec)?.display_name ?? '';
        if (['integer', 'float', 'monetary'].includes(field.type)) return value === false || value == null ? '' : Number(value);
        return formatValue(field, value, { lang, record: row, currencies });
      }));
      const stamp = new Date().toISOString().slice(0, 10);
      if (format === 'csv') downloadCsv(`${model}-${stamp}.csv`, [header, ...lines]); else downloadXls(`${model}-${stamp}.xls`, [header, ...lines]);
      onClose();
    } finally { setBusy(false); }
  };

  const move = (name: string, direction: -1 | 1) => setChosen((list) => {
    const index = list.indexOf(name);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= list.length) return list;
    const next = [...list];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  });

  return (
    <div>
      <div className="d-flex gap-3 align-items-center mb-3 flex-wrap">
        <span className="text-muted small">{count === null ? t('All matching records') : `${count} ${t('selected')}`}</span>
        <div className="btn-group btn-group-sm ms-auto">
          <button type="button" className={`btn ${format === 'xls' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setFormat('xls')}>Excel</button>
          <button type="button" className={`btn ${format === 'csv' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setFormat('csv')}>CSV</button>
        </div>
      </div>
      <div className="row g-3">
        <div className="col-md-6">
          <div className="fw-bold small mb-1">{t('Available fields')}</div>
          <input className="form-control form-control-sm mb-2" placeholder={t('Search...')} value={query} onChange={(event) => setQuery(event.target.value)} />
          <div className="border rounded" style={{ height: 320, overflow: 'auto' }}>
            {available.map((field) => (
              <button key={field.name} type="button" className={`o_dropdown_item d-flex justify-content-between ${chosen.includes(field.name) ? 'text-muted' : ''}`} disabled={chosen.includes(field.name)} onClick={() => setChosen((list) => [...list, field.name])}>
                <span>{t(field.label)}</span><span className="text-muted small">{field.name}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="col-md-6">
          <div className="fw-bold small mb-1">{t('Fields to export')} ({chosen.length})</div>
          <div className="border rounded" style={{ height: 356, overflow: 'auto' }}>
            {chosen.map((name) => (
              <div key={name} className="o_dropdown_item d-flex align-items-center gap-2">
                <span className="flex-grow-1">{t(fields[name].label)}</span>
                <button type="button" className="btn btn-link btn-sm p-0" onClick={() => move(name, -1)} aria-label="Up"><i className="fa fa-arrow-up" /></button>
                <button type="button" className="btn btn-link btn-sm p-0" onClick={() => move(name, 1)} aria-label="Down"><i className="fa fa-arrow-down" /></button>
                <button type="button" className="btn btn-link btn-sm p-0 text-danger" onClick={() => setChosen((list) => list.filter((item) => item !== name))} aria-label="Remove"><i className="fa fa-times" /></button>
              </div>
            ))}
            {chosen.length === 0 && <div className="p-3 text-muted small">{t('Pick fields on the left.')}</div>}
          </div>
        </div>
      </div>
      <div className="o_dialog_footer mt-3 px-0 border-0">
        <button type="button" className="btn btn-primary" disabled={busy || chosen.length === 0} onClick={run}>{busy ? t('Exporting...') : t('Export')}</button>
        <button type="button" className="btn btn-secondary" onClick={onClose}>{t('Cancel')}</button>
      </div>
    </div>
  );
}
