'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { I18n } from '@engine/i18n/types';
import { rpc } from '@/lib/client/rpc';
import { useLang, useT } from '@/lib/client/i18n';
import { Dropdown } from '../webclient/Navbar';

interface Scorecard { label: I18n; value: number; format: 'money' | 'int' | 'pct' | 'hours' | 'days' | 'text'; text?: string; baseline?: { pct: number | null; label: I18n } }
interface Chart { kind: 'line' | 'bar' | 'pie' | 'stacked'; title: I18n; labels: string[]; series: { name: string; values: number[] }[]; format?: 'money' | 'int' }
interface Table { title: I18n; columns: { label: I18n; format?: 'money' | 'int' | 'pct' | 'text' }[]; rows: (string | number)[][] }
interface Gauge { label: I18n; value: number; format: 'pct' | 'ratio' | 'money' | 'days'; good: number; bad: number; higherIsBetter: boolean; help: I18n }
type Block = { type: 'scorecards'; items: Scorecard[] } | { type: 'chart'; chart: Chart } | { type: 'table'; table: Table } | { type: 'gauges'; items: Gauge[] } | { type: 'kpis'; title: I18n; rows: { label: I18n; value: number; previous: number; format: 'money' | 'pct' | 'days' | 'ratio' }[] };
interface Result { name: I18n; period: { from: string; to: string }; previous: { from: string; to: string }; blocks: Block[] }
interface Entry { id: number; name: string; group: string; sequence: number }

const PALETTE = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'];
const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Dashboards (C-8.3): left sidebar with the dashboard groups, a period
 * selector, and the dashboard rendered from live data — scorecards with
 * baselines, line / bar / pie / stacked charts (inline SVG), tables, KPI
 * tables with the previous period and benchmark gauges.
 */
export function Dashboards({ context }: { context: Record<string, unknown> }) {
  const t = useT();
  const lang = useLang();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [current, setCurrent] = useState<string>(typeof context.dashboard === 'string' ? context.dashboard : 'Sales');
  const [kind, setKind] = useState<'year' | 'quarter' | 'month' | 'custom'>('year');
  const [anchor, setAnchor] = useState(() => new Date());
  const [custom, setCustom] = useState({ from: `${new Date().getUTCFullYear()}-01-01`, to: iso(new Date()) });
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const locale = lang === 'ar_001' ? 'ar-EG-u-nu-latn' : 'en-US';

  useEffect(() => {
    rpc<{ id: number; name: string; dashboard_group_id: unknown; sequence: number }[]>('searchRead', 'spreadsheet.dashboard', { domain: [['is_published', '=', true]], fields: ['name', 'dashboard_group_id', 'sequence'], order: 'sequence asc, id asc' }, { silent: true, cacheMs: 60_000 })
      .then((rows) => setEntries(rows.map((r) => ({ id: r.id, name: String(r.name), group: Array.isArray(r.dashboard_group_id) ? String(r.dashboard_group_id[1]) : t('Other'), sequence: Number(r.sequence ?? 0) }))))
      .catch(() => setEntries([{ id: 1, name: 'Sales', group: 'Sales', sequence: 1 }, { id: 2, name: 'Accounting', group: 'Finance', sequence: 2 }]));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `t` changes identity per render; entries load once
  }, []);

  const period = useMemo(() => {
    const y = anchor.getUTCFullYear(); const m = anchor.getUTCMonth();
    if (kind === 'month') return { from: iso(new Date(Date.UTC(y, m, 1))), to: iso(new Date(Date.UTC(y, m + 1, 0))) };
    if (kind === 'quarter') { const q = Math.floor(m / 3) * 3; return { from: iso(new Date(Date.UTC(y, q, 1))), to: iso(new Date(Date.UTC(y, q + 3, 0))) }; }
    if (kind === 'year') return { from: `${y}-01-01`, to: `${y}-12-31` };
    return custom;
  }, [kind, anchor, custom]);

  const load = useCallback(async () => {
    setLoading(true);
    try { setResult(await rpc<Result>('dashboardData', null, { name: current, from: period.from, to: period.to }, { silent: true })); } catch { setResult(null); }
    setLoading(false);
  }, [current, period.from, period.to]);
  useEffect(() => { void load(); }, [load]);

  const groups = useMemo(() => { const map = new Map<string, Entry[]>(); for (const e of entries) (map.get(e.group) ?? map.set(e.group, []).get(e.group)!).push(e); return [...map.entries()]; }, [entries]);
  const fmt = (v: number, format?: string) => format === 'money' ? v.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : format === 'pct' ? `${v.toFixed(1)}%` : format === 'ratio' ? v.toFixed(2) : format === 'hours' ? `${v.toFixed(1)} h` : format === 'days' ? `${Math.round(v)} d` : v.toLocaleString(locale, { maximumFractionDigits: 2 });
  const shift = (n: number) => setAnchor((a) => { const d = new Date(a); if (kind === 'month') d.setUTCMonth(d.getUTCMonth() + n); else if (kind === 'quarter') d.setUTCMonth(d.getUTCMonth() + 3 * n); else d.setUTCFullYear(d.getUTCFullYear() + n); return d; });
  const periodLabel = kind === 'custom' ? `${custom.from} → ${custom.to}` : kind === 'month' ? anchor.toLocaleDateString(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }) : kind === 'quarter' ? `Q${Math.floor(anchor.getUTCMonth() / 3) + 1} ${anchor.getUTCFullYear()}` : String(anchor.getUTCFullYear());

  return (
    <div className="o_dashboards">
      <aside className={`o_dashboards_sidebar ${collapsed ? 'collapsed' : ''}`}>
        <button type="button" className="o_dashboards_toggle" onClick={() => setCollapsed((c) => !c)} title={t('Toggle sidebar')}><i className={`fa fa-angle-double-${collapsed ? (lang === 'ar_001' ? 'left' : 'right') : (lang === 'ar_001' ? 'right' : 'left')}`} /></button>
        {!collapsed && groups.map(([group, items]) => (
          <div key={group} className="o_dashboards_group">
            <div className="o_dashboards_group_title">{group}</div>
            {items.map((e) => <button key={e.id} type="button" className={`o_dashboards_item ${current === e.name ? 'active' : ''}`} onClick={() => setCurrent(e.name)}>{e.name}</button>)}
          </div>
        ))}
      </aside>
      <section className="o_dashboards_content">
        <div className="o_dashboards_bar">
          <h5 className="m-0">{result ? t(result.name) : current}</h5>
          <div className="d-flex align-items-center gap-2 ms-auto">
            <div className="btn-group btn-group-sm">
              <button type="button" className="btn btn-secondary" onClick={() => shift(-1)}><i className="fa fa-chevron-left" /></button>
              <Dropdown toggle={() => <span className="btn btn-secondary"><i className="fa fa-calendar me-1" />{periodLabel} <i className="fa fa-caret-down" /></span>}>
                {(['month', 'quarter', 'year'] as const).map((k) => <button key={k} type="button" className={`o_dropdown_item ${kind === k ? 'fw-bold' : ''}`} onClick={() => setKind(k)}>{t(k === 'month' ? 'Month' : k === 'quarter' ? 'Quarter' : 'Year')}</button>)}
                <div className="px-3 py-2 border-top" onClick={(e) => e.stopPropagation()}>
                  <div className="small text-muted mb-1">{t('Custom Dates')}</div>
                  <div className="d-flex gap-1"><input type="date" className="form-control form-control-sm" value={custom.from} onChange={(e) => { setKind('custom'); setCustom((c) => ({ ...c, from: e.target.value })); }} /><input type="date" className="form-control form-control-sm" value={custom.to} onChange={(e) => { setKind('custom'); setCustom((c) => ({ ...c, to: e.target.value })); }} /></div>
                </div>
              </Dropdown>
              <button type="button" className="btn btn-secondary" onClick={() => shift(1)}><i className="fa fa-chevron-right" /></button>
            </div>
          </div>
        </div>
        {loading && <div className="o_loading_indicator" />}
        {!loading && !result && <div className="p-5 text-center text-muted">{t('This dashboard has no data source yet.')}</div>}
        {result && (
          <div className="o_dashboards_canvas">
            {result.blocks.map((block, index) => {
              if (block.type === 'scorecards') return (
                <div key={index} className="o_dash_scorecards">
                  {block.items.map((item, i) => (
                    <div key={i} className="o_dash_scorecard">
                      <div className="o_dash_label">{t(item.label)}</div>
                      <div className="o_dash_value">{item.format === 'text' ? item.text : fmt(item.value, item.format)}</div>
                      {item.baseline && <div className={`o_dash_baseline ${item.baseline.pct === null ? 'text-muted' : item.baseline.pct >= 0 ? 'text-success' : 'text-danger'}`}>{item.baseline.pct === null ? '' : `${item.baseline.pct >= 0 ? '↑' : '↓'} ${Math.abs(item.baseline.pct).toFixed(1)}% `}{t(item.baseline.label)}</div>}
                    </div>
                  ))}
                </div>
              );
              if (block.type === 'chart') return <div key={index} className="o_dash_card"><div className="o_dash_title">{t(block.chart.title)}</div><ChartSvg chart={block.chart} fmt={fmt} /></div>;
              if (block.type === 'table') return (
                <div key={index} className="o_dash_card">
                  <div className="o_dash_title">{t(block.table.title)}</div>
                  <table className="o_dash_table"><thead><tr>{block.table.columns.map((c, i) => <th key={i} className={c.format && c.format !== 'text' ? 'text-end' : ''}>{t(c.label)}</th>)}</tr></thead>
                    <tbody>{block.table.rows.length === 0 && <tr><td colSpan={block.table.columns.length} className="text-muted text-center">{t('No data')}</td></tr>}{block.table.rows.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c} className={block.table.columns[c]?.format && block.table.columns[c].format !== 'text' ? 'text-end' : ''}>{typeof cell === 'number' ? fmt(cell, block.table.columns[c]?.format) : cell}</td>)}</tr>)}</tbody></table>
                </div>
              );
              if (block.type === 'kpis') return (
                <div key={index} className="o_dash_card">
                  <div className="o_dash_title">{t(block.title)}</div>
                  <table className="o_dash_table"><thead><tr><th /><th className="text-end">{t('Current')}</th><th className="text-end">{t('Previous')}</th><th className="text-end">Δ</th></tr></thead>
                    <tbody>{block.rows.map((row, r) => { const delta = row.previous ? ((row.value - row.previous) / Math.abs(row.previous)) * 100 : null; return <tr key={r}><td>{t(row.label)}</td><td className="text-end">{fmt(row.value, row.format)}</td><td className="text-end text-muted">{fmt(row.previous, row.format)}</td><td className={`text-end ${delta === null ? 'text-muted' : delta >= 0 ? 'text-success' : 'text-danger'}`}>{delta === null ? '—' : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`}</td></tr>; })}</tbody></table>
                </div>
              );
              if (block.type === 'gauges') return (
                <div key={index} className="o_dash_gauges">
                  {block.items.map((g, i) => {
                    const ok = g.higherIsBetter ? g.value >= g.good : g.value <= g.good; const bad = g.higherIsBetter ? g.value < g.bad : g.value > g.bad;
                    const color = ok ? 'var(--o-success)' : bad ? 'var(--o-danger)' : 'var(--o-warning)';
                    const span = Math.max(Math.abs(g.good), Math.abs(g.bad), Math.abs(g.value), 1) * 1.4;
                    const ratio = Math.max(0, Math.min(1, (g.value + (g.format === 'money' ? span / 2 : 0)) / (g.format === 'money' ? span : span)));
                    return (
                      <div key={i} className="o_dash_card o_dash_gauge">
                        <div className="o_dash_title">{t(g.label)}</div>
                        <svg viewBox="0 0 100 60" className="o_dash_gauge_svg"><path d="M10 55 A40 40 0 0 1 90 55" stroke="var(--o-gray-200)" strokeWidth="10" fill="none" /><path d="M10 55 A40 40 0 0 1 90 55" stroke={color} strokeWidth="10" fill="none" strokeDasharray={`${ratio * 125.7} 200`} /><text x="50" y="52" textAnchor="middle" fontSize="12" fontWeight="700">{fmt(g.value, g.format)}</text></svg>
                        <div className="small text-muted">{t(g.help)}</div>
                      </div>
                    );
                  })}
                </div>
              );
              return null;
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function ChartSvg({ chart, fmt }: { chart: Chart; fmt: (v: number, f?: string) => string }) {
  const w = 600; const h = 240; const pad = { l: 56, r: 12, t: 12, b: 36 };
  if (!chart.labels.length) return <div className="text-muted text-center py-4">No data</div>;
  if (chart.kind === 'pie') {
    const values = chart.series[0]?.values ?? []; const total = values.reduce((s, v) => s + v, 0) || 1; let angle = -Math.PI / 2;
    return (
      <div className="d-flex align-items-center gap-3 flex-wrap">
        <svg viewBox="0 0 200 200" width={200} height={200}>{values.map((v, i) => { const a0 = angle; const a1 = angle + (v / total) * Math.PI * 2; angle = a1; const large = a1 - a0 > Math.PI ? 1 : 0; const p = (a: number) => `${100 + 90 * Math.cos(a)} ${100 + 90 * Math.sin(a)}`; return <path key={i} d={`M100 100 L${p(a0)} A90 90 0 ${large} 1 ${p(a1)} Z`} fill={PALETTE[i % PALETTE.length]} stroke="#fff" />; })}</svg>
        <div>{chart.labels.map((l, i) => <div key={i} className="small d-flex align-items-center gap-2"><span style={{ width: 10, height: 10, background: PALETTE[i % PALETTE.length], display: 'inline-block' }} />{l} <span className="text-muted">{fmt(values[i] ?? 0, chart.format)}</span></div>)}</div>
      </div>
    );
  }
  const stacked = chart.kind === 'stacked';
  const totals = chart.labels.map((_, i) => (stacked ? chart.series.reduce((s, se) => s + (se.values[i] ?? 0), 0) : Math.max(...chart.series.map((se) => se.values[i] ?? 0))));
  const max = Math.max(1, ...totals);
  const x = (i: number) => pad.l + ((w - pad.l - pad.r) * (i + 0.5)) / chart.labels.length;
  const y = (v: number) => h - pad.b - ((h - pad.b - pad.t) * v) / max;
  const bw = Math.max(4, ((w - pad.l - pad.r) / chart.labels.length) * 0.6);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="o_dash_chart">
      {[0, 0.25, 0.5, 0.75, 1].map((f) => <g key={f}><line x1={pad.l} x2={w - pad.r} y1={y(max * f)} y2={y(max * f)} stroke="var(--o-gray-200)" /><text x={pad.l - 6} y={y(max * f) + 4} textAnchor="end" fontSize="10" fill="#6b7280">{fmt(max * f, chart.format === 'money' ? 'int' : chart.format)}</text></g>)}
      {chart.kind === 'line' ? chart.series.map((se, s) => (
        <g key={s}><polyline fill="none" stroke={PALETTE[s % PALETTE.length]} strokeWidth="2" points={se.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />{se.values.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r="3" fill={PALETTE[s % PALETTE.length]}><title>{`${chart.labels[i]}: ${fmt(v, chart.format)}`}</title></circle>)}</g>
      )) : chart.labels.map((_, i) => { let acc = 0; return chart.series.map((se, s) => { const v = se.values[i] ?? 0; const top = stacked ? acc + v : v; const el = <rect key={`${i}-${s}`} x={stacked ? x(i) - bw / 2 : x(i) - bw / 2 + (bw / chart.series.length) * s} width={stacked ? bw : bw / chart.series.length} y={y(top)} height={Math.max(0, y(stacked ? acc : 0) - y(top))} fill={PALETTE[s % PALETTE.length]}><title>{`${chart.labels[i]} · ${se.name}: ${fmt(v, chart.format)}`}</title></rect>; acc += v; return el; }); })}
      {chart.labels.map((l, i) => <text key={i} x={x(i)} y={h - pad.b + 14} textAnchor="middle" fontSize="10" fill="#6b7280">{l.length > 12 ? `${l.slice(0, 11)}…` : l}</text>)}
      {chart.series.length > 1 && chart.series.map((se, s) => <g key={`l${s}`}><rect x={pad.l + s * 110} y={h - 10} width="10" height="10" fill={PALETTE[s % PALETTE.length]} /><text x={pad.l + s * 110 + 14} y={h - 1} fontSize="10" fill="#6b7280">{se.name}</text></g>)}
    </svg>
  );
}
