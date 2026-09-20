'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { GraphArch } from '@engine/registry/arch';
import type { Domain, FieldDef } from '@engine/registry/types';
import type { ReadGroupRow } from '@engine/orm/read-group';
import { rpc } from '@/lib/client/rpc';
import { useLang, useT } from '@/lib/client/i18n';
import { formatValue, useCurrencies } from '@/lib/client/display';
import { Dropdown } from '../webclient/Navbar';
import { DATE_INTERVALS, groupField, groupKey, groupLabel, groupableFields, measureFields, withInterval } from './groups';
import { downloadCsv } from './export';

interface Props {
  arch: GraphArch;
  fields: Record<string, FieldDef>;
  model: string;
  domain: Domain;
  groupBy: string[];
  context: Record<string, unknown>;
  onDrill: (domain: Domain, title: string) => void;
}

const PALETTE = ['#1f77b4', '#ff7f0e', '#aec7e8', '#ffbb78', '#2ca02c', '#98df8a', '#d62728', '#ff9896', '#9467bd', '#c5b0d5', '#8c564b', '#c49c94', '#e377c2', '#f7b6d2', '#7f7f7f', '#c7c7c7', '#bcbd22', '#dbdb8d', '#17becf', '#9edae5'];

interface Series { key: string; label: string; domain: Domain; values: number[] }

/**
 * Graph view (A-4 §12): bar / line / pie rendered in SVG, one or two
 * group-bys (the second becomes the series), measure and order selectors,
 * stacked bars, hover values, click-through and CSV download. No chart
 * library: it stays crisp in RTL and prints.
 */
export function GraphView({ arch, fields, model, domain, groupBy, context, onDrill }: Props) {
  const t = useT();
  const lang = useLang();
  const currencies = useCurrencies();
  const archGroups = arch.fields.filter((f) => f.type === 'row' || !f.type).filter((f) => f.name !== 'id' && !['integer', 'float', 'monetary'].includes(fields[f.name]?.type ?? '')).map((f) => withInterval(f.interval ? `${f.name}:${f.interval}` : f.name, fields));
  const archMeasure = arch.fields.find((f) => f.type === 'measure')?.name;

  const [type, setType] = useState<'bar' | 'line' | 'pie'>(arch.chartType ?? 'bar');
  const [groups, setGroups] = useState<string[]>(groupBy.length ? groupBy.slice(0, 2).map((g) => withInterval(g, fields)) : archGroups.slice(0, 2));
  const [measure, setMeasure] = useState<string>(archMeasure ?? '__count');
  const [order, setOrder] = useState<'' | 'asc' | 'desc'>((arch.order as 'asc' | 'desc') ?? '');
  const [stacked, setStacked] = useState(arch.stacked ?? true);
  const [rows, setRows] = useState<ReadGroupRow[]>([]);
  const [loading, setLoading] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  useEffect(() => { if (groupBy.length) setGroups(groupBy.slice(0, 2).map((g) => withInterval(g, fields))); }, [groupBy]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => setWidth(Math.max(320, entries[0].contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    rpc<ReadGroupRow[]>('readGroup', model, { domain, fields: [measure === '__count' ? '__count' : `${measure}:sum`], groupby: groups, options: { lazy: false } }, { silent: true, context })
      .then((result) => { if (!cancelled) { setRows(result); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [model, JSON.stringify(domain), groups.join(','), measure, context]); // eslint-disable-line react-hooks/exhaustive-deps

  const value = (row: ReadGroupRow) => Number(measure === '__count' ? row.__count : row[measure]) || 0;
  const measureDef = fields[measure];
  const format = (v: number) => (measure === '__count' ? String(Math.round(v)) : formatValue(measureDef, v, { lang, record: {}, currencies }));
  const measureLabel = measure === '__count' ? t('Count') : t(measureDef?.label ?? measure);

  // Categories (first group-by) × series (second group-by).
  const { categories, series } = useMemo(() => {
    const cats = new Map<string, { label: string; domain: Domain; total: number }>();
    const ser = new Map<string, Series>();
    const g0 = groups[0];
    const g1 = groups[1];
    for (const row of rows) {
      const ck = g0 ? groupKey(row, g0) : 'all';
      if (!cats.has(ck)) cats.set(ck, { label: g0 ? groupLabel(row, g0, fields[groupField(g0)], t) : t('Total'), domain: [], total: 0 });
      cats.get(ck)!.total += value(row);
    }
    let catList = [...cats.entries()];
    if (order) catList = catList.sort((a, b) => (order === 'asc' ? a[1].total - b[1].total : b[1].total - a[1].total));
    const catIndex = new Map(catList.map(([key], index) => [key, index]));
    for (const row of rows) {
      const ck = g0 ? groupKey(row, g0) : 'all';
      const sk = g1 ? groupKey(row, g1) : 'all';
      if (!ser.has(sk)) ser.set(sk, { key: sk, label: g1 ? groupLabel(row, g1, fields[groupField(g1)], t) : measureLabel, domain: [], values: new Array(catList.length).fill(0) });
      const s = ser.get(sk)!;
      s.values[catIndex.get(ck)!] += value(row);
      if (!g1) catList[catIndex.get(ck)!][1].domain = row.__domain;
    }
    // Per-cell domains for drill-down.
    const cellDomains = new Map<string, Domain>();
    for (const row of rows) cellDomains.set(`${g0 ? groupKey(row, g0) : 'all'}|${g1 ? groupKey(row, g1) : 'all'}`, row.__domain);
    return { categories: catList.map(([key, c]) => ({ key, ...c })), series: [...ser.values()], cellDomains };
  }, [rows, groups, order, measure, lang]); // eslint-disable-line react-hooks/exhaustive-deps

  const drill = (catKey: string, serKey: string, label: string) => {
    const row = rows.find((r) => (groups[0] ? groupKey(r, groups[0]) : 'all') === catKey && (groups[1] ? groupKey(r, groups[1]) : 'all') === serKey);
    if (row) onDrill(row.__domain.length ? ([...(domain.length ? ['&', ...domain] : []), ...row.__domain] as Domain) : domain, label);
  };

  const download = () => {
    const header = [groups[0] ? t(fields[groupField(groups[0])]?.label) : '', ...series.map((s) => s.label)];
    downloadCsv(`${model}-graph.csv`, [header, ...categories.map((c, i) => [c.label, ...series.map((s) => s.values[i])])]);
  };

  const groupMenu = (index: number) => (
    <div style={{ maxHeight: 360, overflow: 'auto', minWidth: 220 }}>
      {index > 0 && <button type="button" className="o_dropdown_item text-muted" onClick={() => setGroups((list) => list.slice(0, index))}>{t('None')}</button>}
      {groupableFields(fields).map((field) => (
        field.type === 'date' || field.type === 'datetime' ? (
          <div key={field.name} className="o_dropdown_item d-flex justify-content-between align-items-center" style={{ cursor: 'default' }}>
            <span>{t(field.label)}</span>
            <span className="d-flex gap-1">{DATE_INTERVALS.map((interval) => <button key={interval.key} type="button" className="btn btn-link btn-sm p-0 px-1" onClick={() => setGroups((list) => { const next = [...list]; next[index] = `${field.name}:${interval.key}`; return next.slice(0, index + 1).concat(list.slice(index + 1)); })}>{t(interval.label)}</button>)}</span>
          </div>
        ) : <button key={field.name} type="button" className="o_dropdown_item" onClick={() => setGroups((list) => { const next = [...list]; next[index] = field.name; return next; })}>{t(field.label)}</button>
      ))}
    </div>
  );

  const height = 420;
  return (
    <div className="o_graph_view" ref={box}>
      <div className="o_graph_buttons d-flex gap-2 flex-wrap align-items-center mb-2">
        <div className="btn-group btn-group-sm">
          {(['bar', 'line', 'pie'] as const).map((kind) => (
            <button key={kind} type="button" className={`btn ${type === kind ? 'btn-primary' : 'btn-secondary'}`} title={t(kind === 'bar' ? 'Bar Chart' : kind === 'line' ? 'Line Chart' : 'Pie Chart')} onClick={() => setType(kind)}>
              <i className={`fa ${kind === 'bar' ? 'fa-bar-chart' : kind === 'line' ? 'fa-line-chart' : 'fa-pie-chart'}`} />
            </button>
          ))}
        </div>
        {type === 'bar' && <button type="button" className={`btn btn-sm ${stacked ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setStacked(!stacked)}>{t('Stacked')}</button>}
        <div className="btn-group btn-group-sm">
          <button type="button" className={`btn ${order === 'asc' ? 'btn-primary' : 'btn-secondary'}`} title={t('Ascending')} onClick={() => setOrder(order === 'asc' ? '' : 'asc')}><i className="fa fa-sort-amount-asc" /></button>
          <button type="button" className={`btn ${order === 'desc' ? 'btn-primary' : 'btn-secondary'}`} title={t('Descending')} onClick={() => setOrder(order === 'desc' ? '' : 'desc')}><i className="fa fa-sort-amount-desc" /></button>
        </div>
        <Dropdown toggle={() => <button type="button" className="btn btn-secondary btn-sm">{t('Measures')}: {measureLabel} <i className="fa fa-caret-down" /></button>}>
          {measureFields(fields).map((field) => <button key={field.name} type="button" className="o_dropdown_item" onClick={() => setMeasure(field.name)}><span style={{ display: 'inline-block', width: 16 }}>{measure === field.name ? '✓' : ''}</span>{t(field.label)}</button>)}
          <div className="o_dropdown_divider" />
          <button type="button" className="o_dropdown_item" onClick={() => setMeasure('__count')}><span style={{ display: 'inline-block', width: 16 }}>{measure === '__count' ? '✓' : ''}</span>{t('Count')}</button>
        </Dropdown>
        <Dropdown toggle={() => <button type="button" className="btn btn-secondary btn-sm">{t('Group By')}: {groups[0] ? t(fields[groupField(groups[0])]?.label) : t('None')} <i className="fa fa-caret-down" /></button>}>{groupMenu(0)}</Dropdown>
        {groups[0] && (
          <Dropdown toggle={() => <button type="button" className="btn btn-secondary btn-sm">{t('Then by')}: {groups[1] ? t(fields[groupField(groups[1])]?.label) : t('None')} <i className="fa fa-caret-down" /></button>}>{groupMenu(1)}</Dropdown>
        )}
        <button type="button" className="btn btn-secondary btn-sm" onClick={download} title={t('Download')}><i className="fa fa-download" /></button>
      </div>
      {loading && <div className="o_loading_indicator" />}
      {!loading && categories.length === 0 && <div className="p-5 text-center text-muted">{t('No data to display')}</div>}
      {categories.length > 0 && type === 'pie' && <PieChart categories={categories} series={series} format={format} width={width} height={height} onClick={drill} />}
      {categories.length > 0 && type !== 'pie' && <BarLineChart type={type} stacked={stacked} categories={categories} series={series} format={format} width={width} height={height} onClick={drill} />}
    </div>
  );
}

interface ChartProps { categories: { key: string; label: string }[]; series: Series[]; format: (v: number) => string; width: number; height: number; onClick: (catKey: string, serKey: string, label: string) => void }

function niceTicks(max: number, count = 5): number[] {
  if (max <= 0) return [0];
  const rough = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / magnitude;
  const step = (residual > 5 ? 10 : residual > 2 ? 5 : residual > 1 ? 2 : 1) * magnitude;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.999; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

function BarLineChart({ type, stacked, categories, series, format, width, height, onClick }: ChartProps & { type: 'bar' | 'line'; stacked: boolean }) {
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  const margin = { top: 16, right: 24, bottom: 64, left: 72 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;
  const stackedBars = type === 'bar' && stacked && series.length > 1;
  const maxValue = Math.max(0, ...categories.map((_, i) => (stackedBars ? series.reduce((sum, s) => sum + Math.max(0, s.values[i]), 0) : Math.max(...series.map((s) => s.values[i])))));
  const ticks = niceTicks(maxValue);
  const top = ticks[ticks.length - 1] || 1;
  const y = (v: number) => margin.top + innerH - (v / top) * innerH;
  const band = innerW / Math.max(1, categories.length);
  const x = (i: number) => margin.left + i * band;

  return (
    <div style={{ position: 'relative' }}>
      <svg width={width} height={height} style={{ direction: 'ltr', display: 'block' }} onMouseLeave={() => setHover(null)}>
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} stroke="var(--o-border)" strokeDasharray={tick === 0 ? undefined : '3 3'} />
            <text x={margin.left - 8} y={y(tick) + 4} textAnchor="end" fontSize={11} fill="var(--o-text-muted)">{format(tick)}</text>
          </g>
        ))}
        {categories.map((cat, i) => (
          <text key={cat.key} x={x(i) + band / 2} y={height - margin.bottom + 18} textAnchor={categories.length > 8 ? 'end' : 'middle'} transform={categories.length > 8 ? `rotate(-35 ${x(i) + band / 2} ${height - margin.bottom + 18})` : undefined} fontSize={11} fill="var(--o-text)">
            {cat.label.length > 18 ? `${cat.label.slice(0, 17)}…` : cat.label}
          </text>
        ))}
        {type === 'bar' && categories.map((cat, i) => {
          let offset = 0;
          const groupWidth = band * 0.7;
          const barWidth = stackedBars ? groupWidth : groupWidth / series.length;
          return series.map((s, si) => {
            const v = s.values[i];
            const h = (Math.max(0, v) / top) * innerH;
            const bx = stackedBars ? x(i) + band * 0.15 : x(i) + band * 0.15 + si * barWidth;
            const by = stackedBars ? y(offset + v) : y(v);
            if (stackedBars) offset += Math.max(0, v);
            return (
              <rect key={s.key} x={bx} y={by} width={Math.max(1, barWidth - 2)} height={h} fill={PALETTE[si % PALETTE.length]} rx={2} style={{ cursor: 'pointer' }}
                onMouseMove={(event) => setHover({ x: event.nativeEvent.offsetX, y: event.nativeEvent.offsetY, text: `${cat.label}${series.length > 1 ? ` · ${s.label}` : ''}: ${format(v)}` })}
                onClick={() => onClick(cat.key, s.key, `${cat.label}${series.length > 1 ? ` / ${s.label}` : ''}`)} />
            );
          });
        })}
        {type === 'line' && series.map((s, si) => {
          const points = categories.map((_, i) => `${x(i) + band / 2},${y(s.values[i])}`).join(' ');
          return (
            <g key={s.key}>
              <polyline points={points} fill="none" stroke={PALETTE[si % PALETTE.length]} strokeWidth={2} />
              {categories.map((cat, i) => (
                <circle key={cat.key} cx={x(i) + band / 2} cy={y(s.values[i])} r={4} fill={PALETTE[si % PALETTE.length]} style={{ cursor: 'pointer' }}
                  onMouseMove={(event) => setHover({ x: event.nativeEvent.offsetX, y: event.nativeEvent.offsetY, text: `${cat.label}${series.length > 1 ? ` · ${s.label}` : ''}: ${format(s.values[i])}` })}
                  onClick={() => onClick(cat.key, s.key, `${cat.label}${series.length > 1 ? ` / ${s.label}` : ''}`)} />
              ))}
            </g>
          );
        })}
      </svg>
      {hover && <div className="o_graph_tooltip" style={{ left: hover.x + 12, top: hover.y - 28 }}>{hover.text}</div>}
      {series.length > 1 && <Legend series={series} />}
    </div>
  );
}

function PieChart({ categories, series, format, width, height, onClick }: ChartProps) {
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  // A pie shows the first series split by category; with two group-bys it shows one ring per series.
  const rings = series.length > 1 ? series : [series[0]];
  const cx = width / 2;
  const cy = height / 2;
  const outer = Math.min(width, height) / 2 - 24;
  const ringWidth = outer / (rings.length + 0.5);
  return (
    <div style={{ position: 'relative' }}>
      <svg width={width} height={height} style={{ direction: 'ltr', display: 'block' }} onMouseLeave={() => setHover(null)}>
        {rings.map((ring, ri) => {
          const total = ring.values.reduce((sum, v) => sum + Math.max(0, v), 0) || 1;
          const r1 = outer - ri * ringWidth;
          const r0 = rings.length > 1 ? r1 - ringWidth * 0.9 : 0;
          let angle = -Math.PI / 2;
          return categories.map((cat, i) => {
            const v = Math.max(0, ring.values[i]);
            const sweep = (v / total) * Math.PI * 2;
            const a0 = angle;
            const a1 = angle + sweep;
            angle = a1;
            if (sweep === 0) return null;
            const large = sweep > Math.PI ? 1 : 0;
            const p = (r: number, a: number) => `${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`;
            const full = sweep >= Math.PI * 2 - 1e-6;
            // A single 100% slice is a full circle: SVG arcs need two halves for that.
            const d = full
              ? (r0 > 0
                ? `M${p(r1, a0)} A${r1},${r1} 0 1 1 ${p(r1, a0 + Math.PI)} A${r1},${r1} 0 1 1 ${p(r1, a0)} M${p(r0, a0)} A${r0},${r0} 0 1 0 ${p(r0, a0 + Math.PI)} A${r0},${r0} 0 1 0 ${p(r0, a0)} Z`
                : `M${p(r1, a0)} A${r1},${r1} 0 1 1 ${p(r1, a0 + Math.PI)} A${r1},${r1} 0 1 1 ${p(r1, a0)} Z`)
              : r0 > 0
                ? `M${p(r1, a0)} A${r1},${r1} 0 ${large} 1 ${p(r1, a1)} L${p(r0, a1)} A${r0},${r0} 0 ${large} 0 ${p(r0, a0)} Z`
                : `M${cx},${cy} L${p(r1, a0)} A${r1},${r1} 0 ${large} 1 ${p(r1, a1)} Z`;
            const mid = (a0 + a1) / 2;
            const labelR = r0 > 0 ? (r0 + r1) / 2 : r1 * 0.65;
            return (
              <g key={`${ring.key}:${cat.key}`}>
                <path d={d} fill={PALETTE[i % PALETTE.length]} fillRule="evenodd" stroke="#fff" strokeWidth={1} style={{ cursor: 'pointer' }}
                  onMouseMove={(event) => setHover({ x: event.nativeEvent.offsetX, y: event.nativeEvent.offsetY, text: `${cat.label}${rings.length > 1 ? ` · ${ring.label}` : ''}: ${format(v)} (${Math.round((v / total) * 100)}%)` })}
                  onClick={() => onClick(cat.key, ring.key, cat.label)} />
                {sweep > 0.25 && <text x={cx + labelR * Math.cos(mid)} y={cy + labelR * Math.sin(mid)} textAnchor="middle" fontSize={11} fill="#fff" style={{ pointerEvents: 'none' }}>{Math.round((v / total) * 100)}%</text>}
              </g>
            );
          });
        })}
      </svg>
      {hover && <div className="o_graph_tooltip" style={{ left: hover.x + 12, top: hover.y - 28 }}>{hover.text}</div>}
      <Legend series={categories.map((cat, i) => ({ key: cat.key, label: cat.label, domain: [], values: [] })).map((s, i) => ({ ...s, color: PALETTE[i % PALETTE.length] }))} />
    </div>
  );
}

function Legend({ series }: { series: (Series & { color?: string })[] }) {
  return (
    <div className="d-flex flex-wrap gap-3 justify-content-center mt-2 small">
      {series.map((s, i) => (
        <span key={s.key} className="d-inline-flex align-items-center gap-1">
          <span style={{ width: 12, height: 12, background: s.color ?? PALETTE[i % PALETTE.length], borderRadius: 2, display: 'inline-block' }} />{s.label}
        </span>
      ))}
    </div>
  );
}
