'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GanttArch } from '@engine/registry/arch';
import type { Domain, FieldDef } from '@engine/registry/types';
import { PyDate, applyRelativeDelta, RelativeDelta } from '@engine/expr/pydate';
import { evalCondition } from '@engine/expr/evaluate';
import { rpc } from '@/lib/client/rpc';
import { useLang, useT } from '@/lib/client/i18n';
import { idOf, nameOf } from '@/lib/client/display';
import { makeRecordScope } from '@/lib/client/arch';

type Rec = Record<string, unknown>;
type Scale = 'day' | 'week' | 'month' | 'quarter' | 'year';

interface Props {
  arch: GanttArch;
  fields: Record<string, FieldDef>;
  model: string;
  domain: Domain;
  groupBy: string[];
  context: Record<string, unknown>;
  user: { uid: number };
  onOpen: (id: number) => void;
  onCreate?: (defaults: Rec) => void;
}

interface Pill { id: number; title: string; start: number; stop: number; color: number; classes: string; progress: number | null; record: Rec; tooltip: string }
interface Row { key: string; label: string; groupValue: unknown; pills: Pill[]; lanes: Pill[][] }
interface Column { start: number; end: number; label: string; weekend: boolean }

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const DAYS_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAYS_AR = ['اثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت', 'أحد'];

const DAY = 86_400_000;
function ms(value: unknown): number | null {
  if (!value || typeof value !== 'string') return null;
  const text = value.length === 10 ? `${value}T00:00:00Z` : `${value.replace(' ', 'T')}Z`;
  const time = Date.parse(text);
  return Number.isNaN(time) ? null : time;
}
function toSql(time: number, datetime: boolean): string {
  const iso = new Date(time).toISOString();
  return datetime ? `${iso.slice(0, 10)} ${iso.slice(11, 19)}` : iso.slice(0, 10);
}
function pyToMs(date: PyDate): number { return Date.UTC(date.year, date.month - 1, date.day); }
function startOfWeek(date: PyDate): PyDate { return applyRelativeDelta(date, new RelativeDelta({ days: -date.weekday() })); }
function colorOf(value: unknown): number {
  if (typeof value === 'number') return value % 12;
  const id = idOf(value);
  if (id) return id % 11 + 1;
  if (typeof value === 'string') { let h = 0; for (const ch of value) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return (h % 11) + 1; }
  return 0;
}
/** Lay pills of one row out on as few lanes as possible (Odoo stacks overlapping pills). */
function lanesOf(pills: Pill[]): Pill[][] {
  const lanes: Pill[][] = [];
  for (const pill of [...pills].sort((a, b) => a.start - b.start)) {
    const lane = lanes.find((list) => list.every((other) => other.stop <= pill.start || other.start >= pill.stop));
    if (lane) lane.push(pill); else lanes.push([pill]);
  }
  return lanes;
}

/**
 * Gantt view (A-4 §10): Day / Week / Month / Quarter / Year scales, one row
 * per group (`default_group_by` or the active group-by; many2many groups
 * repeat the record under each value, empty groups form the "Open Shifts"
 * row), pills coloured by the `color` field with `decoration-*` classes and a
 * progress bar, a total row, today marker, click a cell to create in that
 * slot, click a pill to open it. Hover shows the `popover_fields`.
 */
export function GanttView({ arch, fields, model, domain, groupBy, context, user, onOpen, onCreate }: Props) {
  const t = useT();
  const lang = useLang();
  const today = useMemo(() => PyDate.parse(new Date().toISOString().slice(0, 10))!, []);
  const scales = (arch.scales ? arch.scales.split(',') : ['day', 'week', 'month', 'year']).map((s) => s.trim()).filter((s): s is Scale => ['day', 'week', 'month', 'quarter', 'year'].includes(s));
  const [scale, setScale] = useState<Scale>(arch.defaultScale && scales.includes(arch.defaultScale as Scale) ? (arch.defaultScale as Scale) : scales.includes('week') ? 'week' : scales[0]);
  const [anchor, setAnchor] = useState<PyDate>(today);
  const [rows, setRows] = useState<Row[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const months = lang === 'ar_001' ? MONTHS_AR : MONTHS_EN;
  const days = lang === 'ar_001' ? DAYS_AR : DAYS_EN;
  const isDatetime = fields[arch.dateStart]?.type === 'datetime';
  const groupField = (groupBy[0] ?? arch.defaultGroupBy?.split(',')[0] ?? '').split(':')[0] || null;
  const groupDef = groupField ? fields[groupField] : undefined;

  const range = useMemo(() => {
    if (scale === 'day') return { from: pyToMs(anchor), to: pyToMs(anchor) + DAY };
    if (scale === 'week') { const from = pyToMs(startOfWeek(anchor)); return { from, to: from + 7 * DAY }; }
    if (scale === 'month') { const first = new PyDate(anchor.year, anchor.month, 1); return { from: pyToMs(first), to: pyToMs(applyRelativeDelta(first, new RelativeDelta({ months: 1 }))) }; }
    if (scale === 'quarter') { const q = Math.floor((anchor.month - 1) / 3); const first = new PyDate(anchor.year, q * 3 + 1, 1); return { from: pyToMs(first), to: pyToMs(applyRelativeDelta(first, new RelativeDelta({ months: 3 }))) }; }
    return { from: Date.UTC(anchor.year, 0, 1), to: Date.UTC(anchor.year + 1, 0, 1) };
  }, [scale, anchor]);

  const columns = useMemo<Column[]>(() => {
    const out: Column[] = [];
    if (scale === 'day') for (let h = 0; h < 24; h++) out.push({ start: range.from + h * 3_600_000, end: range.from + (h + 1) * 3_600_000, label: `${String(h).padStart(2, '0')}:00`, weekend: false });
    else if (scale === 'week' || scale === 'month') {
      for (let time = range.from; time < range.to; time += DAY) {
        const date = new Date(time);
        const weekday = (date.getUTCDay() + 6) % 7;
        out.push({ start: time, end: time + DAY, label: scale === 'week' ? `${days[weekday]} ${date.getUTCDate()}` : String(date.getUTCDate()), weekend: weekday >= 5 });
      }
    } else if (scale === 'quarter') {
      let time = pyToMs(startOfWeek(PyDate.parse(new Date(range.from).toISOString().slice(0, 10))!));
      let index = 1;
      while (time < range.to) { const date = new Date(Math.max(time, range.from)); out.push({ start: Math.max(time, range.from), end: Math.min(time + 7 * DAY, range.to), label: `${t('W')}${index} · ${date.getUTCDate()} ${months[date.getUTCMonth()]}`, weekend: false }); time += 7 * DAY; index++; }
    } else {
      for (let m = 0; m < 12; m++) out.push({ start: Date.UTC(anchor.year, m, 1), end: Date.UTC(anchor.year, m + 1, 1), label: months[m], weekend: false });
    }
    return out;
  }, [scale, range, anchor.year, days, months, t]);

  const load = useCallback(async () => {
    setLoading(true);
    const decorationFields = Object.values(arch.decorations).flatMap((expr) => expr.match(/[a-z_][a-z0-9_]*/g) ?? []).filter((name) => fields[name]);
    const names = [...new Set(['display_name', arch.dateStart, arch.dateStop, arch.color, arch.progress, groupField, ...arch.fields.map((f) => f.name), ...arch.popoverFields, ...decorationFields].filter((n): n is string => Boolean(n && fields[n])))];
    const window: Domain = ['&', [arch.dateStart, '<', toSql(range.to, isDatetime)], '|', [arch.dateStop, '>=', toSql(range.from, isDatetime)], [arch.dateStop, '=', false]];
    const full: Domain = domain.length ? (['&', ...domain, ...window] as Domain) : window;
    const records = await rpc<Rec[]>('searchRead', model, { domain: full, fields: names, limit: 2000, order: `${arch.dateStart} asc` }, { silent: true, context }).catch(() => [] as Rec[]);
    const byGroup = new Map<string, Row>();
    const emptyLabel = model === 'planning.slot' ? t('Open Shifts') : t('Unassigned');
    for (const record of records) {
      const start = ms(record[arch.dateStart]);
      const stopRaw = ms(record[arch.dateStop]);
      if (start === null) continue;
      const stop = stopRaw !== null && stopRaw > start ? stopRaw : start + (isDatetime ? 3_600_000 : DAY);
      const scope = makeRecordScope(record, { uid: user.uid, context, fields });
      const classes = Object.entries(arch.decorations).filter(([, expr]) => evalCondition(expr, scope, false)).map(([kind]) => `o_gantt_pill_${kind}`).join(' ');
      const tooltip = arch.popoverFields.filter((name) => fields[name] && record[name] !== false && record[name] !== null && record[name] !== undefined && name !== 'color')
        .map((name) => `${t(fields[name].label)}: ${Array.isArray(record[name]) ? (Array.isArray((record[name] as unknown[])[0]) || typeof (record[name] as unknown[])[0] === 'number' ? (record[name] as unknown[]).map((v) => nameOf(v) || String(v)).join(', ') : nameOf(record[name])) : String(record[name])}`).join('\n');
      const pill: Pill = {
        id: record.id as number, title: String(record.display_name ?? ''), start, stop,
        color: arch.color ? colorOf(record[arch.color]) : 4, classes,
        progress: arch.progress && typeof record[arch.progress] === 'number' ? Number(record[arch.progress]) : null, record, tooltip,
      };
      const raw = groupField ? record[groupField] : null;
      const values: unknown[] = Array.isArray(raw) && raw.length && typeof raw[0] !== 'string' ? (Array.isArray(raw[0]) || typeof raw[0] === 'object' ? raw : (typeof raw[0] === 'number' && raw.length === 2 && typeof raw[1] === 'string' ? [raw] : raw)) : raw === false || raw === null || raw === undefined ? [null] : [raw];
      for (const value of values.length ? values : [null]) {
        const key = value === null ? '__empty' : String(idOf(value) || (typeof value === 'object' ? JSON.stringify(value) : value));
        const label = value === null ? emptyLabel : nameOf(value) || String(value);
        const row = byGroup.get(key) ?? { key, label, groupValue: value, pills: [], lanes: [] };
        row.pills.push(pill);
        byGroup.set(key, row);
      }
    }
    const list = [...byGroup.values()].sort((a, b) => (a.key === '__empty' ? -1 : b.key === '__empty' ? 1 : a.label.localeCompare(b.label)));
    for (const row of list) row.lanes = lanesOf(row.pills);
    setRows(list);
    setLoading(false);
  }, [arch, fields, model, JSON.stringify(domain), groupField, range.from, range.to, context, isDatetime, user.uid]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);

  const move = (direction: 1 | -1) => setAnchor((current) => applyRelativeDelta(current, scale === 'day' ? new RelativeDelta({ days: direction }) : scale === 'week' ? new RelativeDelta({ weeks: direction }) : scale === 'month' ? new RelativeDelta({ months: direction }) : scale === 'quarter' ? new RelativeDelta({ months: 3 * direction }) : new RelativeDelta({ years: direction })));
  const span = range.to - range.from;
  const pct = (time: number) => `${((Math.min(Math.max(time, range.from), range.to) - range.from) / span) * 100}%`;
  const now = Date.now();
  const title = scale === 'day' ? `${anchor.day} ${months[anchor.month - 1]} ${anchor.year}`
    : scale === 'week' ? `${new Date(range.from).getUTCDate()} ${months[new Date(range.from).getUTCMonth()]} – ${new Date(range.to - DAY).getUTCDate()} ${months[new Date(range.to - DAY).getUTCMonth()]} ${anchor.year}`
    : scale === 'month' ? `${months[anchor.month - 1]} ${anchor.year}`
    : scale === 'quarter' ? `Q${Math.floor((anchor.month - 1) / 3) + 1} ${anchor.year}` : String(anchor.year);
  const createIn = (row: Row, column: Column) => {
    if (!onCreate || arch.attrs.create === 'false' || arch.attrs.create === false) return;
    const defaults: Rec = { [arch.dateStart]: toSql(column.start, isDatetime), [arch.dateStop]: toSql(Math.min(column.end, column.start + (isDatetime && scale !== 'day' ? 8 * 3_600_000 : column.end - column.start)), isDatetime) };
    if (groupField && groupDef && row.groupValue !== null) {
      const id = idOf(row.groupValue);
      if (groupDef.type === 'many2one' && id) defaults[groupField] = id;
      else if (groupDef.type === 'many2many' && id) defaults[groupField] = [[4, id]];
      else if (groupDef.type !== 'many2one' && groupDef.type !== 'many2many') defaults[groupField] = row.groupValue;
    }
    onCreate(defaults);
  };
  const totals = columns.map((column) => rows.reduce((sum, row) => sum + row.pills.filter((pill) => pill.start < column.end && pill.stop > column.start).length, 0));
  const scaleLabel = (s: Scale) => t(s === 'day' ? 'Day' : s === 'week' ? 'Week' : s === 'month' ? 'Month' : s === 'quarter' ? 'Quarter' : 'Year');

  return (
    <div className="o_gantt_view">
      <div className="o_gantt_buttons d-flex align-items-center gap-2 flex-wrap mb-2">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAnchor(today)}>{t('Today')}</button>
        <div className="btn-group btn-group-sm">
          <button type="button" className="btn btn-secondary" onClick={() => move(-1)} aria-label="Previous"><i className="fa fa-chevron-left" /></button>
          <button type="button" className="btn btn-secondary" onClick={() => move(1)} aria-label="Next"><i className="fa fa-chevron-right" /></button>
        </div>
        <h5 className="m-0 mx-2">{title}</h5>
        <button type="button" className="btn btn-link btn-sm" onClick={() => setCollapsed(collapsed.size ? new Set() : new Set(rows.map((r) => r.key)))}>
          <i className={`fa ${collapsed.size ? 'fa-expand' : 'fa-compress'} me-1`} />{collapsed.size ? t('Expand rows') : t('Collapse rows')}
        </button>
        <div className="btn-group btn-group-sm ms-auto">
          {scales.map((s) => <button key={s} type="button" className={`btn ${scale === s ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setScale(s)}>{scaleLabel(s)}</button>)}
        </div>
      </div>
      {loading && <div className="o_loading_indicator" />}
      <div className="o_gantt_scroll">
        <div className="o_gantt_grid" style={{ gridTemplateColumns: `220px repeat(${columns.length}, minmax(${scale === 'month' || scale === 'quarter' ? 28 : 48}px, 1fr))` }}>
          <div className="o_gantt_corner small text-muted">{groupDef ? t(groupDef.label) : ''}</div>
          {columns.map((column) => <div key={column.start} className={`o_gantt_head ${column.weekend ? 'o_gantt_weekend' : ''} ${now >= column.start && now < column.end ? 'o_gantt_today' : ''}`}>{column.label}</div>)}
          {rows.length === 0 && !loading && (
            <div className="o_gantt_empty" style={{ gridColumn: `1 / span ${columns.length + 1}` }}>
              <i className="fa fa-tasks fa-2x d-block mb-2 opacity-50" />{t('No records in this period.')}{onCreate && arch.attrs.create !== 'false' ? ` ${t('Click a cell to plan one.')}` : ''}
            </div>
          )}
          {rows.map((row) => {
            const folded = collapsed.has(row.key);
            const lanes = folded ? [] : row.lanes;
            const height = folded ? 26 : Math.max(1, lanes.length) * 30 + 6;
            return (
              <div key={row.key} style={{ display: 'contents' }}>
                <div className="o_gantt_row_head" style={{ height }} onClick={() => setCollapsed((set) => { const next = new Set(set); if (next.has(row.key)) next.delete(row.key); else next.add(row.key); return next; })}>
                  <i className={`fa fa-caret-${folded ? (lang === 'ar_001' ? 'left' : 'right') : 'down'} me-1 text-muted`} />
                  <span className="text-truncate">{row.label}</span>
                  <span className="badge rounded-pill text-bg-secondary ms-auto">{row.pills.length}</span>
                </div>
                <div className="o_gantt_row" style={{ height, gridColumn: `2 / span ${columns.length}` }}>
                  <div className="o_gantt_cells" style={{ gridTemplateColumns: `repeat(${columns.length}, 1fr)` }}>
                    {columns.map((column) => <div key={column.start} className={`o_gantt_cell ${column.weekend ? 'o_gantt_weekend' : ''} ${now >= column.start && now < column.end ? 'o_gantt_today' : ''}`} onClick={() => createIn(row, column)} />)}
                  </div>
                  {now >= range.from && now < range.to && <div className="o_gantt_now" style={{ insetInlineStart: pct(now) }} />}
                  {lanes.map((lane, laneIndex) => lane.map((pill) => (
                    <div key={pill.id} className={`o_gantt_pill ${pill.classes}`} title={`${pill.title}\n${pill.tooltip}`}
                      style={{ insetInlineStart: pct(pill.start), width: `calc(${((Math.min(pill.stop, range.to) - Math.max(pill.start, range.from)) / span) * 100}% - 2px)`, top: 4 + laneIndex * 30, background: pill.classes ? undefined : `var(--o-color-${pill.color || 4})` }}
                      onClick={(event) => { event.stopPropagation(); onOpen(pill.id); }}>
                      {pill.progress !== null && <div className="o_gantt_progress" style={{ width: `${Math.max(0, Math.min(100, pill.progress))}%` }} />}
                      <span className="o_gantt_pill_label">{arch.pillLabel !== false ? pill.title : ''}</span>
                    </div>
                  )))}
                </div>
              </div>
            );
          })}
          {arch.totalRow && rows.length > 0 && (
            <>
              <div className="o_gantt_row_head o_gantt_total">{t('Total')}</div>
              {columns.map((column, index) => <div key={column.start} className="o_gantt_total_cell">{totals[index] ? <span className="o_gantt_total_bar" style={{ height: `${Math.min(100, (totals[index] / Math.max(1, ...totals)) * 100)}%` }} title={String(totals[index])}><span>{totals[index]}</span></span> : null}</div>)}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
