'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GridArch } from '@engine/registry/arch';
import type { Domain, FieldDef } from '@engine/registry/types';
import { rpc } from '@/lib/client/rpc';
import { useLang, useT } from '@/lib/client/i18n';
import { idOf, nameOf } from '@/lib/client/display';
import { useUi } from '../webclient/ui';

type Rec = Record<string, unknown>;

interface Props {
  arch: GridArch;
  fields: Record<string, FieldDef>;
  model: string;
  domain: Domain;
  context: Record<string, unknown>;
  onOpen: (id: number) => void;
  onCreate?: (defaults: Rec) => void;
}

interface Col { key: string; label: string; from: string; to: string }
interface Row { key: string; label: string; value: unknown; cells: Record<string, { total: number; ids: number[] }> }

const DAY = 86_400_000;
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const DAYS_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAYS_AR = ['اثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت', 'أحد'];
const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Grid view (A-4 §16, timesheets / analytic entries): rows per the `row`
 * field, one column per step (day or month) of the selected range, the
 * `measure` summed in each cell; Day / Week / Month / Year ranges with
 * previous / next / today; row and column totals; editable cells write the
 * existing entry or create one for that row and date ("Add a line" opens
 * the form).
 */
export function GridView({ arch, fields, model, domain, context, onOpen, onCreate }: Props) {
  const t = useT();
  const lang = useLang();
  const ui = useUi();
  const months = lang === 'ar_001' ? MONTHS_AR : MONTHS_EN;
  const days = lang === 'ar_001' ? DAYS_AR : DAYS_EN;
  const rowField = arch.fields.find((f) => f.type === 'row')?.name ?? '';
  const colField = arch.fields.find((f) => f.type === 'col')?.name ?? '';
  const measure = arch.fields.find((f) => f.type === 'measure')?.name ?? '';
  const ranges = arch.ranges.length ? arch.ranges : [{ name: 'week', string: { en: 'Week', ar: 'الأسبوع' }, span: 'week', step: 'day' }];
  const [range, setRange] = useState(ranges.find((r) => r.name === 'week') ?? ranges[0]);
  const [anchor, setAnchor] = useState(() => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())));
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const editable = arch.edit !== false && arch.edit !== 'false' && !fields[measure]?.readonly;

  const period = useMemo(() => {
    const from = new Date(anchor);
    const to = new Date(anchor);
    if (range.span === 'day') { to.setUTCDate(to.getUTCDate() + 1); }
    else if (range.span === 'week') { from.setUTCDate(from.getUTCDate() - ((from.getUTCDay() + 6) % 7)); to.setTime(from.getTime() + 7 * DAY); }
    else if (range.span === 'month') { from.setUTCDate(1); to.setUTCDate(1); to.setUTCMonth(to.getUTCMonth() + 1); }
    else { from.setUTCMonth(0, 1); to.setUTCFullYear(to.getUTCFullYear() + 1, 0, 1); }
    return { from, to };
  }, [anchor, range]);

  const columns = useMemo<Col[]>(() => {
    const out: Col[] = [];
    if (range.step === 'month') {
      for (let d = new Date(period.from); d < period.to; d.setUTCMonth(d.getUTCMonth() + 1)) { const next = new Date(d); next.setUTCMonth(next.getUTCMonth() + 1); out.push({ key: iso(d), label: `${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`, from: iso(d), to: iso(next) }); }
    } else {
      for (let time = period.from.getTime(); time < period.to.getTime(); time += DAY) { const d = new Date(time); out.push({ key: iso(d), label: `${days[(d.getUTCDay() + 6) % 7]} ${d.getUTCDate()}`, from: iso(d), to: iso(new Date(time + DAY)) }); }
    }
    return out;
  }, [period, range.step, months, days]);

  const load = useCallback(async () => {
    if (!rowField || !colField || !measure) { setLoading(false); return; }
    setLoading(true);
    const full: Domain = [...domain, [colField, '>=', iso(period.from)], [colField, '<', iso(period.to)]] as Domain;
    const records = await rpc<Rec[]>('searchRead', model, { domain: full, fields: ['id', rowField, colField, measure], limit: 5000 }, { silent: true, context }).catch(() => [] as Rec[]);
    const map = new Map<string, Row>();
    for (const record of records) {
      const value = record[rowField];
      const key = String(idOf(value) || value || 'none');
      const row = map.get(key) ?? { key, label: nameOf(value) || (value === false || value === null ? t('None') : String(value)), value, cells: {} };
      const date = String(record[colField] ?? '').slice(0, 10);
      const colKey = range.step === 'month' ? `${date.slice(0, 7)}-01` : date;
      const cell = row.cells[colKey] ?? (row.cells[colKey] = { total: 0, ids: [] });
      cell.total += Number(record[measure] ?? 0);
      cell.ids.push(record.id as number);
      map.set(key, row);
    }
    setRows([...map.values()].sort((a, b) => a.label.localeCompare(b.label)));
    setLoading(false);
  }, [model, JSON.stringify(domain), context, rowField, colField, measure, period.from.getTime(), period.to.getTime(), range.step]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);

  const move = (direction: 1 | -1) => setAnchor((current) => { const d = new Date(current); if (range.span === 'day') d.setUTCDate(d.getUTCDate() + direction); else if (range.span === 'week') d.setUTCDate(d.getUTCDate() + 7 * direction); else if (range.span === 'month') d.setUTCMonth(d.getUTCMonth() + direction); else d.setUTCFullYear(d.getUTCFullYear() + direction); return d; });
  const fmt = (n: number) => n.toLocaleString(lang === 'ar_001' ? 'ar-EG-u-nu-latn' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const save = async (row: Row, column: Col, text: string) => {
    const amount = Number(text.replace(',', '.'));
    if (Number.isNaN(amount)) return;
    const cell = row.cells[column.key];
    try {
      if (cell && cell.ids.length === 1) await rpc('write', model, { ids: cell.ids, values: { [measure]: amount } }, { context });
      else if (cell && cell.ids.length > 1) { ui.notify({ type: 'warning', message: { en: 'Several entries share this cell: open them from the list to edit.', ar: 'عدة قيود تشترك في هذه الخلية: افتحها من القائمة لتعديلها.' } }); return; }
      else await rpc('create', model, { values: { [rowField]: idOf(row.value) || row.value, [colField]: column.from, [measure]: amount } }, { context });
      await load();
    } catch (error) { ui.notify({ type: 'danger', message: String((error as Error).message ?? error) }); }
  };
  const colTotals = columns.map((c) => rows.reduce((s, r) => s + (r.cells[c.key]?.total ?? 0), 0));
  const title = range.span === 'day' ? `${anchor.getUTCDate()} ${months[anchor.getUTCMonth()]} ${anchor.getUTCFullYear()}` : range.span === 'week' ? `${period.from.getUTCDate()} ${months[period.from.getUTCMonth()]} – ${new Date(period.to.getTime() - DAY).getUTCDate()} ${months[new Date(period.to.getTime() - DAY).getUTCMonth()]} ${period.from.getUTCFullYear()}` : range.span === 'month' ? `${months[period.from.getUTCMonth()]} ${period.from.getUTCFullYear()}` : String(period.from.getUTCFullYear());

  return (
    <div className="o_grid_view">
      <div className="d-flex align-items-center gap-2 flex-wrap mb-2">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAnchor(new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())))}>{t('Today')}</button>
        <div className="btn-group btn-group-sm">
          <button type="button" className="btn btn-secondary" onClick={() => move(-1)} aria-label="Previous"><i className="fa fa-chevron-left" /></button>
          <button type="button" className="btn btn-secondary" onClick={() => move(1)} aria-label="Next"><i className="fa fa-chevron-right" /></button>
        </div>
        <h5 className="m-0 mx-2">{title}</h5>
        {onCreate && <button type="button" className="btn btn-link btn-sm" onClick={() => onCreate({ [colField]: iso(period.from) })}><i className="fa fa-plus me-1" />{t('Add a line')}</button>}
        <div className="btn-group btn-group-sm ms-auto">
          {ranges.map((r) => <button key={r.name} type="button" className={`btn ${range.name === r.name ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setRange(r)}>{t(r.string ?? r.name)}</button>)}
        </div>
      </div>
      {loading && <div className="o_loading_indicator" />}
      <div className="table-responsive">
        <table className="o_list_table o_grid_table">
          <thead>
            <tr>
              <th style={{ minWidth: 220 }}>{t(fields[rowField]?.label ?? rowField)}</th>
              {columns.map((c) => <th key={c.key} className="text-center small">{c.label}</th>)}
              <th className="text-end">{t('Total')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && <tr><td colSpan={columns.length + 2} className="text-center text-muted py-4">{t('No entries in this period.')}</td></tr>}
            {rows.map((row) => {
              const total = columns.reduce((s, c) => s + (row.cells[c.key]?.total ?? 0), 0);
              return (
                <tr key={row.key}>
                  <td className="fw-bold">{row.label}</td>
                  {columns.map((c) => {
                    const cell = row.cells[c.key];
                    return (
                      <td key={c.key} className={`o_grid_cell o_list_number ${cell ? '' : 'o_grid_cell_empty'}`} onDoubleClick={() => cell?.ids.length === 1 && onOpen(cell.ids[0])}>
                        {editable ? (
                          <input className="o_grid_input" defaultValue={cell ? fmt(cell.total) : ''} key={`${row.key}-${c.key}-${cell?.total ?? 0}`}
                            onBlur={(event) => { const text = event.target.value.trim(); if (text !== (cell ? fmt(cell.total) : '') && text !== '') void save(row, c, text); }}
                            onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); }} />
                        ) : (cell ? fmt(cell.total) : '')}
                      </td>
                    );
                  })}
                  <td className="o_list_number fw-bold">{fmt(total)}</td>
                </tr>
              );
            })}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr>
                <td className="fw-bold">{t('Total')}</td>
                {colTotals.map((v, i) => <td key={i} className="o_list_number fw-bold">{v ? fmt(v) : ''}</td>)}
                <td className="o_list_number fw-bold">{fmt(colTotals.reduce((s, v) => s + v, 0))}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
