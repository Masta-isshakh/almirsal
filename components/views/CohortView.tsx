'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CohortArch } from '@engine/registry/arch';
import type { Domain, FieldDef } from '@engine/registry/types';
import { rpc } from '@/lib/client/rpc';
import { useLang, useT } from '@/lib/client/i18n';

type Rec = Record<string, unknown>;
type Interval = 'day' | 'week' | 'month' | 'year';
type Mode = 'retention' | 'churn';

interface Props {
  arch: CohortArch;
  fields: Record<string, FieldDef>;
  model: string;
  domain: Domain;
  context: Record<string, unknown>;
  onDrill?: (domain: Domain, title: string) => void;
}

interface Cohort { key: string; label: string; from: Date; to: Date; total: number; measure: number; periods: { value: number; count: number; domain: Domain }[] }

const DAY = 86_400_000;
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

function parse(value: unknown): Date | null {
  if (!value || typeof value !== 'string') return null;
  const time = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : `${value.replace(' ', 'T')}Z`);
  return Number.isNaN(time) ? null : new Date(time);
}
function truncate(date: Date, interval: Interval): Date {
  if (interval === 'day') return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  if (interval === 'week') { const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d; }
  if (interval === 'month') return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  return new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
}
function advance(date: Date, interval: Interval, n: number): Date {
  const d = new Date(date);
  if (interval === 'day') d.setUTCDate(d.getUTCDate() + n);
  else if (interval === 'week') d.setUTCDate(d.getUTCDate() + 7 * n);
  else if (interval === 'month') d.setUTCMonth(d.getUTCMonth() + n);
  else d.setUTCFullYear(d.getUTCFullYear() + n);
  return d;
}
function sql(date: Date, datetime: boolean): string { const iso = date.toISOString(); return datetime ? `${iso.slice(0, 10)} ${iso.slice(11, 19)}` : iso.slice(0, 10); }

/**
 * Cohort view (A-4 §15): records grouped by the period of `date_start`
 * (rows); each column is the n-th period after it and shows how many of the
 * cohort were still open (retention) or had stopped (churn: `date_stop`
 * reached) by then, as a percentage with a heat colour. Cells drill down to
 * the list of records behind them.
 */
export function CohortView({ arch, fields, model, domain, context, onDrill }: Props) {
  const t = useT();
  const lang = useLang();
  const months = lang === 'ar_001' ? MONTHS_AR : MONTHS_EN;
  const [interval, setInterval] = useState<Interval>((['day', 'week', 'month', 'year'].includes(arch.interval ?? '') ? arch.interval : 'week') as Interval);
  const [mode, setMode] = useState<Mode>(arch.mode === 'churn' ? 'churn' : 'retention');
  const [timeline, setTimeline] = useState<'forward' | 'backward'>(arch.timeline === 'backward' ? 'backward' : 'forward');
  const [records, setRecords] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(true);
  const isDatetime = fields[arch.dateStart]?.type === 'datetime';
  const measure = arch.measure && fields[arch.measure] && ['integer', 'float', 'monetary'].includes(fields[arch.measure].type) ? arch.measure : null;
  const PERIODS = 16;

  const load = useCallback(async () => {
    setLoading(true);
    const names = ['display_name', arch.dateStart, arch.dateStop, ...(measure ? [measure] : [])].filter((n) => fields[n]);
    const rows = await rpc<Rec[]>('searchRead', model, { domain: [...domain, [arch.dateStart, '!=', false]] as Domain, fields: names, limit: 5000, order: `${arch.dateStart} asc` }, { silent: true, context }).catch(() => [] as Rec[]);
    setRecords(rows);
    setLoading(false);
  }, [arch, fields, model, JSON.stringify(domain), context, measure]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);

  const cohorts = useMemo<Cohort[]>(() => {
    const map = new Map<string, Cohort>();
    const now = new Date();
    for (const record of records) {
      const start = parse(record[arch.dateStart]);
      if (!start) continue;
      const from = truncate(start, interval);
      const key = from.toISOString();
      const to = advance(from, interval, 1);
      const label = interval === 'day' ? `${from.getUTCDate()} ${months[from.getUTCMonth()]} ${from.getUTCFullYear()}`
        : interval === 'week' ? `${t('W')}${Math.ceil(((from.getTime() - Date.UTC(from.getUTCFullYear(), 0, 1)) / DAY + 1) / 7)} ${from.getUTCFullYear()}`
        : interval === 'month' ? `${months[from.getUTCMonth()]} ${from.getUTCFullYear()}` : String(from.getUTCFullYear());
      const cohort = map.get(key) ?? { key, label, from, to, total: 0, measure: 0, periods: Array.from({ length: PERIODS }, (_, n) => ({ value: 0, count: 0, domain: [] as Domain })) };
      cohort.total += 1;
      cohort.measure += measure ? Number(record[measure] ?? 0) : 1;
      const stop = parse(record[arch.dateStop]);
      for (let n = 0; n < PERIODS; n++) {
        const periodStart = timeline === 'forward' ? advance(from, interval, n) : advance(from, interval, -n);
        const periodEnd = advance(periodStart, interval, 1);
        if (periodStart > now) break; // the future is blank
        const stopped = stop !== null && stop < periodEnd;
        const counted = mode === 'churn' ? stopped : !stopped;
        if (counted) { cohort.periods[n].count += 1; cohort.periods[n].value += measure ? Number(record[measure] ?? 0) : 1; }
      }
      map.set(key, cohort);
    }
    const list = [...map.values()].sort((a, b) => b.from.getTime() - a.from.getTime());
    for (const cohort of list) {
      cohort.periods.forEach((period, n) => {
        const periodStart = timeline === 'forward' ? advance(cohort.from, interval, n) : advance(cohort.from, interval, -n);
        const periodEnd = advance(periodStart, interval, 1);
        const base: Domain = [...domain, [arch.dateStart, '>=', sql(cohort.from, isDatetime)], [arch.dateStart, '<', sql(cohort.to, isDatetime)]];
        period.domain = mode === 'churn'
          ? [...base, [arch.dateStop, '!=', false], [arch.dateStop, '<', sql(periodEnd, isDatetime)]] as Domain
          : [...base, '|', [arch.dateStop, '=', false], [arch.dateStop, '>=', sql(periodEnd, isDatetime)]] as Domain;
      });
    }
    return list;
  }, [records, interval, mode, timeline, arch, measure, months, t, isDatetime, JSON.stringify(domain)]); // eslint-disable-line react-hooks/exhaustive-deps

  const heat = (ratio: number) => `rgba(113, 75, 103, ${0.08 + ratio * 0.72})`;
  const unit = (n: number) => `${n} ${t(interval === 'day' ? 'Day' : interval === 'week' ? 'Week' : interval === 'month' ? 'Month' : 'Year')}`;

  return (
    <div className="o_cohort_view">
      <div className="d-flex align-items-center gap-2 flex-wrap mb-2">
        <div className="btn-group btn-group-sm">
          {(['day', 'week', 'month', 'year'] as Interval[]).map((i) => <button key={i} type="button" className={`btn ${interval === i ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setInterval(i)}>{t(i === 'day' ? 'Day' : i === 'week' ? 'Week' : i === 'month' ? 'Month' : 'Year')}</button>)}
        </div>
        <div className="btn-group btn-group-sm">
          <button type="button" className={`btn ${mode === 'retention' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode('retention')}>{t('Retention')}</button>
          <button type="button" className={`btn ${mode === 'churn' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode('churn')}>{t('Churn')}</button>
        </div>
        <div className="btn-group btn-group-sm">
          <button type="button" className={`btn ${timeline === 'forward' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTimeline('forward')}>{t('Forward')}</button>
          <button type="button" className={`btn ${timeline === 'backward' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTimeline('backward')}>{t('Backward')}</button>
        </div>
        <span className="text-muted small ms-auto">{t(fields[arch.dateStart]?.label ?? arch.dateStart)} → {t(fields[arch.dateStop]?.label ?? arch.dateStop)}</span>
      </div>
      {loading && <div className="o_loading_indicator" />}
      {!loading && cohorts.length === 0 && (
        <div className="o_view_nocontent p-5 text-center text-muted"><i className="fa fa-signal fa-2x d-block mb-2 opacity-50" />{t('No data to display')}</div>
      )}
      {cohorts.length > 0 && (
        <div className="table-responsive">
          <table className="o_list_table o_cohort_table">
            <thead>
              <tr>
                <th>{t(fields[arch.dateStart]?.label ?? arch.dateStart)}</th>
                <th className="text-end">{measure ? t(fields[measure].label) : t('Count')}</th>
                <th className="text-center" colSpan={PERIODS}>{t(mode === 'churn' ? 'Churn' : 'Retention')}</th>
              </tr>
              <tr>
                <th /><th />
                {Array.from({ length: PERIODS }, (_, n) => <th key={n} className="text-center small">{timeline === 'forward' ? `+${n}` : `-${n}`}</th>)}
              </tr>
            </thead>
            <tbody>
              {cohorts.map((cohort) => (
                <tr key={cohort.key}>
                  <td className="fw-bold">{cohort.label}</td>
                  <td className="o_list_number">{measure ? cohort.measure.toLocaleString(lang === 'ar_001' ? 'ar-EG-u-nu-latn' : 'en-US', { maximumFractionDigits: 2 }) : cohort.total}</td>
                  {cohort.periods.map((period, n) => {
                    const periodStart = timeline === 'forward' ? advance(cohort.from, interval, n) : advance(cohort.from, interval, -n);
                    if (periodStart > new Date()) return <td key={n} className="o_cohort_future" />;
                    const ratio = cohort.total ? period.count / cohort.total : 0;
                    return (
                      <td key={n} className="o_cohort_cell text-center" style={{ background: heat(ratio) }} title={`${unit(n)}: ${period.count} / ${cohort.total}`}
                        onClick={() => onDrill?.(period.domain, `${cohort.label} · ${unit(n)}`)}>
                        {Math.round(ratio * 100)}%
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
