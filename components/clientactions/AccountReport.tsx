'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ActionDef } from '@engine/registry/types';
import type { I18n } from '@engine/i18n/types';
import { rpc } from '@/lib/client/rpc';
import { useLang, useT } from '@/lib/client/i18n';
import { useNavigation } from '@/lib/client/navigation';
import { useUi } from '../webclient/ui';
import { Dropdown } from '../webclient/Navbar';

type Value = number | string | null;
interface Column { label: I18n; type: 'monetary' | 'date' | 'string' | 'integer' | 'percentage' }
interface Line { id: string; name: I18n; level: number; parentId?: string; values: Value[]; compare?: Value[]; total?: boolean; unfoldable?: boolean; domain?: unknown[]; model?: string; resId?: number; children?: Line[] }
interface Result { id: number; name: I18n; columns: Column[]; lines: Line[]; period: { from: string | null; to: string }; compare?: { from: string | null; to: string } | null; singleDate: boolean; note?: I18n }
type PeriodKind = 'month' | 'quarter' | 'year' | 'custom';
type Comparison = 'none' | 'previous_period' | 'previous_year';

const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const iso = (d: Date) => d.toISOString().slice(0, 10);

function periodBounds(kind: PeriodKind, anchor: Date, custom: { from: string; to: string }): { from: string; to: string } {
  const y = anchor.getUTCFullYear(); const m = anchor.getUTCMonth();
  if (kind === 'month') return { from: iso(new Date(Date.UTC(y, m, 1))), to: iso(new Date(Date.UTC(y, m + 1, 0))) };
  if (kind === 'quarter') { const q = Math.floor(m / 3) * 3; return { from: iso(new Date(Date.UTC(y, q, 1))), to: iso(new Date(Date.UTC(y, q + 3, 0))) }; }
  if (kind === 'year') return { from: `${y}-01-01`, to: `${y}-12-31` };
  return custom;
}
function shift(kind: PeriodKind, anchor: Date, n: number): Date {
  const d = new Date(anchor);
  if (kind === 'month') d.setUTCMonth(d.getUTCMonth() + n); else if (kind === 'quarter') d.setUTCMonth(d.getUTCMonth() + 3 * n); else d.setUTCFullYear(d.getUTCFullYear() + n);
  return d;
}
function previous(period: { from: string; to: string }, comparison: Comparison): { from: string; to: string } | null {
  if (comparison === 'none') return null;
  const from = new Date(`${period.from}T00:00:00Z`); const to = new Date(`${period.to}T00:00:00Z`);
  if (comparison === 'previous_year') { from.setUTCFullYear(from.getUTCFullYear() - 1); to.setUTCFullYear(to.getUTCFullYear() - 1); return { from: iso(from), to: iso(to) }; }
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
  const pTo = new Date(from.getTime() - 86_400_000); const pFrom = new Date(pTo.getTime() - (days - 1) * 86_400_000);
  return { from: iso(pFrom), to: iso(pTo) };
}

/**
 * Financial report client action (C-8.7): period picker (month / quarter /
 * fiscal year / custom, previous / next), comparison with the previous
 * period or year, options (draft entries, unfold all, hide zero lines),
 * journal filter, the C-13 line hierarchy with foldable type/account lines,
 * totals, drill-down from any amount to the journal items behind it, Print
 * (browser print → PDF) and Export (CSV that opens in Excel).
 */
export function AccountReport({ action, context }: { action: ActionDef; context: Record<string, unknown> }) {
  const t = useT();
  const lang = useLang();
  const ui = useUi();
  const { navigate } = useNavigation();
  const reportId = Number(context.report_id ?? (action.params as Record<string, unknown> | undefined)?.report_id ?? 0);
  const today = useMemo(() => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())), []);
  const [kind, setKind] = useState<PeriodKind>('year');
  const [anchor, setAnchor] = useState<Date>(today);
  const [custom, setCustom] = useState({ from: `${today.getUTCFullYear()}-01-01`, to: iso(today) });
  const [comparison, setComparison] = useState<Comparison>('none');
  const [includeDraft, setIncludeDraft] = useState(false);
  const [unfoldAll, setUnfoldAll] = useState(false);
  const [hideZero, setHideZero] = useState(false);
  const [journals, setJournals] = useState<{ id: number; name: string }[]>([]);
  const [journalIds, setJournalIds] = useState<number[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [expanded, setExpanded] = useState<Record<string, Line[] | null>>({});
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const months = lang === 'ar_001' ? MONTHS_AR : MONTHS_EN;
  const period = useMemo(() => periodBounds(kind, anchor, custom), [kind, anchor, custom]);
  const compare = useMemo(() => previous(period, comparison), [period, comparison]);

  useEffect(() => {
    rpc<{ id: number; name: string }[]>('searchRead', 'account.journal', { domain: [], fields: ['name', 'type'], order: 'sequence asc, id asc', limit: 50 }, { silent: true, cacheMs: 60_000 })
      .then((rows) => setJournals(rows.map((r) => ({ id: r.id, name: String(r.name) })))).catch(() => setJournals([]));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await rpc<Result>('accountReport', null, {
        reportId, dateFrom: period.from, dateTo: period.to, includeDraft, unfoldAll, hideZero, journalIds,
        compareFrom: compare?.from ?? null, compareTo: compare?.to ?? null,
      }, { silent: true });
      setResult(res);
      setExpanded({});
    } catch (error) { ui.notify({ type: 'danger', message: String((error as Error).message ?? error) }); }
    setLoading(false);
  }, [reportId, period.from, period.to, includeDraft, unfoldAll, hideZero, journalIds.join(','), compare?.from, compare?.to]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);

  const unfold = async (line: Line) => {
    if (line.children) { setFolded((set) => { const next = new Set(set); if (next.has(line.id)) next.delete(line.id); else next.add(line.id); return next; }); return; }
    if (expanded[line.id] !== undefined) { setExpanded((map) => { const next = { ...map }; delete next[line.id]; return next; }); return; }
    setExpanded((map) => ({ ...map, [line.id]: null }));
    const res = await rpc<Result>('accountReport', null, { reportId, dateFrom: period.from, dateTo: period.to, includeDraft, hideZero, journalIds, unfold: line.id, compareFrom: compare?.from ?? null, compareTo: compare?.to ?? null }, { silent: true }).catch(() => null);
    const found = res?.lines.find((l) => l.id === line.id);
    setExpanded((map) => ({ ...map, [line.id]: found?.children ?? [] }));
  };

  const fmt = (value: Value, column: Column | undefined): string => {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value === 'number') {
      if (column?.type === 'integer') return value.toLocaleString(lang === 'ar_001' ? 'ar-EG-u-nu-latn' : 'en-US');
      return value.toLocaleString(lang === 'ar_001' ? 'ar-EG-u-nu-latn' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    return String(value);
  };
  const drill = (line: Line) => {
    if (line.model === 'account.move.line' && line.resId) { navigate(`/odoo/items/${line.resId}`); return; }
    if (!line.domain) return;
    navigate(`/odoo/items?view_type=list&domain=${encodeURIComponent(JSON.stringify(line.domain))}`);
  };
  const exportCsv = () => {
    if (!result) return;
    const rows: string[][] = [[t('Line'), ...result.columns.map((c) => t(c.label)), ...(result.compare ? result.columns.map((c) => `${t(c.label)} (${result.compare!.from ?? ''} → ${result.compare!.to})`) : [])]];
    const walk = (lines: Line[], depth: number) => {
      for (const line of lines) {
        rows.push([`${'  '.repeat(depth)}${t(line.name)}`, ...line.values.map((v) => (typeof v === 'number' ? v.toFixed(2) : String(v ?? ''))), ...(line.compare ? line.compare.map((v) => (typeof v === 'number' ? v.toFixed(2) : String(v ?? ''))) : [])]);
        const children = line.children ?? expanded[line.id] ?? [];
        if (children.length) walk(children, depth + 1);
      }
    };
    walk(tree, 0);
    const csv = '﻿' + rows.map((r) => r.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = `${t(result.name)} ${period.to}.csv`; a.click(); URL.revokeObjectURL(url);
  };

  // Lines come flat with parent ids: render them in order, nesting children under their parent.
  const tree = useMemo<Line[]>(() => {
    if (!result) return [];
    const byId = new Map(result.lines.map((l) => [l.id, { ...l }]));
    const roots: Line[] = [];
    for (const line of byId.values()) {
      if (line.parentId && byId.has(line.parentId)) { const parent = byId.get(line.parentId)!; parent.children = [...(parent.children ?? []).filter((c) => c.id !== line.id), line]; }
      else roots.push(line);
    }
    return roots;
  }, [result]);

  const title = kind === 'month' ? `${months[anchor.getUTCMonth()]} ${anchor.getUTCFullYear()}` : kind === 'quarter' ? `Q${Math.floor(anchor.getUTCMonth() / 3) + 1} ${anchor.getUTCFullYear()}` : kind === 'year' ? `${t('Fiscal Year')} ${anchor.getUTCFullYear()}` : `${custom.from} → ${custom.to}`;
  const dateLabel = result?.singleDate ? `${t('As of')} ${period.to}` : title;

  const Row = ({ line, depth }: { line: Line; depth: number }) => {
    const children = line.children ?? expanded[line.id];
    const isOpen = line.children ? !folded.has(line.id) : expanded[line.id] !== undefined;
    const loadingChildren = expanded[line.id] === null;
    return (
      <>
        <tr className={`o_report_line o_report_level_${Math.min(line.level, 5)} ${line.total ? 'o_report_total' : ''} ${line.unfoldable || line.children ? 'o_report_foldable' : ''}`}>
          <td className="o_report_name" style={{ paddingInlineStart: 12 + depth * 20 }} onClick={() => (line.unfoldable || line.children) && void unfold(line)}>
            {(line.unfoldable || line.children) && <i className={`fa fa-caret-${isOpen ? 'down' : lang === 'ar_001' ? 'left' : 'right'} me-2 text-muted`} />}
            {t(line.name)}
            {loadingChildren && <i className="fa fa-circle-o-notch fa-spin ms-2 text-muted" />}
          </td>
          {result!.columns.map((column, index) => (
            <td key={index} className={`o_report_value ${column.type === 'monetary' || column.type === 'integer' ? 'text-end' : ''} ${typeof line.values[index] === 'number' && Math.abs(line.values[index] as number) < 0.005 ? 'text-muted' : ''} ${line.domain || line.resId ? 'o_report_drill' : ''}`}
              onClick={() => (line.domain || line.resId) && drill(line)} title={line.domain ? t('Open the journal items') : undefined}>
              {fmt(line.values[index], column)}
            </td>
          ))}
          {result!.compare && result!.columns.map((column, index) => <td key={`c${index}`} className={`o_report_value o_report_compare ${column.type === 'monetary' ? 'text-end' : ''}`}>{fmt(line.compare?.[index] ?? null, column)}</td>)}
          {result!.compare && result!.columns.length === 1 && (
            <td className="o_report_value text-end o_report_growth">
              {typeof line.values[0] === 'number' && typeof line.compare?.[0] === 'number' && line.compare[0] !== 0 ? (
                <span className={(line.values[0] as number) >= (line.compare[0] as number) ? 'text-success' : 'text-danger'}>{((((line.values[0] as number) - (line.compare[0] as number)) / Math.abs(line.compare[0] as number)) * 100).toFixed(1)}%</span>
              ) : ''}
            </td>
          )}
        </tr>
        {isOpen && children && children.map((child) => <Row key={child.id} line={child} depth={depth + 1} />)}
      </>
    );
  };

  return (
    <div className="o_account_report">
      <div className="o_control_panel">
        <div className="o_cp_top d-flex align-items-center gap-2 flex-wrap">
          <Dropdown toggle={() => <span className="btn btn-primary btn-sm"><i className="fa fa-print me-1" />{t('Print')} <i className="fa fa-caret-down" /></span>}>
            <button type="button" className="o_dropdown_item" onClick={() => window.print()}><i className="fa fa-file-pdf-o me-2 text-muted" />PDF</button>
            <button type="button" className="o_dropdown_item" onClick={exportCsv}><i className="fa fa-file-excel-o me-2 text-muted" />XLSX / CSV</button>
          </Dropdown>
          <h5 className="o_breadcrumb m-0 ms-2">{t(action.name)}</h5>
          <div className="o_report_filters d-flex align-items-center gap-2 flex-wrap ms-auto">
            <Dropdown toggle={() => <span className="btn btn-secondary btn-sm"><i className="fa fa-calendar me-1" />{dateLabel} <i className="fa fa-caret-down" /></span>}>
              <div className="px-3 py-2" style={{ minWidth: 300 }} onClick={(e) => e.stopPropagation()}>
                {(['month', 'quarter', 'year'] as PeriodKind[]).map((k) => (
                  <div key={k} className={`d-flex align-items-center justify-content-between py-1 ${kind === k ? 'fw-bold text-primary' : ''}`}>
                    <button type="button" className="btn btn-link btn-sm p-0" onClick={() => { setKind(k); setAnchor(anchor); }}>{t(k === 'month' ? 'Month' : k === 'quarter' ? 'Quarter' : 'Fiscal Year')}</button>
                    <span className="d-flex align-items-center gap-1">
                      <button type="button" className="btn btn-link btn-sm p-0" onClick={() => { setKind(k); setAnchor(shift(k, anchor, -1)); }}><i className="fa fa-chevron-left" /></button>
                      <span className="small text-muted" style={{ minWidth: 120, textAlign: 'center' }}>{k === 'month' ? `${months[anchor.getUTCMonth()]} ${anchor.getUTCFullYear()}` : k === 'quarter' ? `Q${Math.floor(anchor.getUTCMonth() / 3) + 1} ${anchor.getUTCFullYear()}` : anchor.getUTCFullYear()}</span>
                      <button type="button" className="btn btn-link btn-sm p-0" onClick={() => { setKind(k); setAnchor(shift(k, anchor, 1)); }}><i className="fa fa-chevron-right" /></button>
                    </span>
                  </div>
                ))}
                <div className="border-top mt-2 pt-2">
                  <div className={`small mb-1 ${kind === 'custom' ? 'fw-bold text-primary' : ''}`}>{t(result?.singleDate ? 'As of' : 'Custom Dates')}</div>
                  <div className="d-flex gap-2">
                    {!result?.singleDate && <input type="date" className="form-control form-control-sm" value={custom.from} onChange={(e) => { setKind('custom'); setCustom((c) => ({ ...c, from: e.target.value })); }} />}
                    <input type="date" className="form-control form-control-sm" value={custom.to} onChange={(e) => { setKind('custom'); setCustom((c) => ({ ...c, to: e.target.value })); }} />
                  </div>
                </div>
              </div>
            </Dropdown>
            <Dropdown toggle={() => <span className="btn btn-secondary btn-sm"><i className="fa fa-exchange me-1" />{t(comparison === 'none' ? 'Comparison' : comparison === 'previous_period' ? 'Previous Period' : 'Same Period Last Year')} <i className="fa fa-caret-down" /></span>}>
              {(['none', 'previous_period', 'previous_year'] as Comparison[]).map((c) => <button key={c} type="button" className={`o_dropdown_item ${comparison === c ? 'fw-bold' : ''}`} onClick={() => setComparison(c)}>{comparison === c && <i className="fa fa-check me-2 text-success" />}{t(c === 'none' ? 'No Comparison' : c === 'previous_period' ? 'Previous Period' : 'Same Period Last Year')}</button>)}
            </Dropdown>
            <Dropdown toggle={() => <span className="btn btn-secondary btn-sm"><i className="fa fa-cog me-1" />{t(includeDraft ? 'All Entries' : 'Posted Entries')}, {t('Accrual Basis')} <i className="fa fa-caret-down" /></span>}>
              <label className="o_dropdown_item d-flex gap-2 align-items-center"><input type="checkbox" className="form-check-input m-0" checked={includeDraft} onChange={(e) => setIncludeDraft(e.target.checked)} />{t('Draft Entries')}</label>
              <label className="o_dropdown_item d-flex gap-2 align-items-center"><input type="checkbox" className="form-check-input m-0" checked={unfoldAll} onChange={(e) => setUnfoldAll(e.target.checked)} />{t('Unfold All')}</label>
              <label className="o_dropdown_item d-flex gap-2 align-items-center"><input type="checkbox" className="form-check-input m-0" checked={hideZero} onChange={(e) => setHideZero(e.target.checked)} />{t('Hide lines at 0')}</label>
            </Dropdown>
            {journals.length > 0 && (
              <Dropdown toggle={() => <span className="btn btn-secondary btn-sm"><i className="fa fa-book me-1" />{journalIds.length ? `${journalIds.length} ${t('Journals')}` : t('All Journals')} <i className="fa fa-caret-down" /></span>}>
                {journals.map((j) => (
                  <label key={j.id} className="o_dropdown_item d-flex gap-2 align-items-center" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" className="form-check-input m-0" checked={journalIds.includes(j.id)} onChange={(e) => setJournalIds((ids) => (e.target.checked ? [...ids, j.id] : ids.filter((id) => id !== j.id)))} />{j.name}
                  </label>
                ))}
              </Dropdown>
            )}
          </div>
        </div>
      </div>
      {loading && <div className="o_loading_indicator" />}
      <div className="o_report_sheet">
        {result && (
          <>
            <div className="o_report_header">
              <h2>{t(result.name)}</h2>
              <div className="text-muted">{result.singleDate ? `${t('As of')} ${result.period.to}` : `${result.period.from} → ${result.period.to}`}{result.compare ? ` · ${t('vs')} ${result.compare.from ?? ''} → ${result.compare.to}` : ''}</div>
            </div>
            {result.note && <div className="alert alert-info py-2">{t(result.note)}</div>}
            <table className="o_report_table">
              <thead>
                <tr>
                  <th />
                  {result.columns.map((c, i) => <th key={i} className={c.type === 'monetary' || c.type === 'integer' ? 'text-end' : ''}>{t(c.label)}</th>)}
                  {result.compare && result.columns.map((c, i) => <th key={`c${i}`} className="text-end o_report_compare">{t(c.label)} · {result.compare!.to.slice(0, 4)}</th>)}
                  {result.compare && result.columns.length === 1 && <th className="text-end">%</th>}
                </tr>
              </thead>
              <tbody>
                {tree.length === 0 && !loading && <tr><td colSpan={result.columns.length + 1} className="text-center text-muted py-4">{t('No data for this period.')}</td></tr>}
                {tree.map((line) => <Row key={line.id} line={line} depth={0} />)}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}
