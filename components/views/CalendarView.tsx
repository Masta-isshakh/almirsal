'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CalendarArch } from '@engine/registry/arch';
import type { Domain, FieldDef } from '@engine/registry/types';
import { PyDate, applyRelativeDelta, RelativeDelta } from '@engine/expr/pydate';
import { rpc } from '@/lib/client/rpc';
import { useLang, useT } from '@/lib/client/i18n';
import { idOf, nameOf } from '@/lib/client/display';
import { useUi } from '../webclient/ui';

type Rec = Record<string, unknown>;
type Scale = 'day' | 'week' | 'month' | 'year';

interface Props {
  arch: CalendarArch;
  fields: Record<string, FieldDef>;
  model: string;
  domain: Domain;
  context: Record<string, unknown>;
  onOpen: (id: number) => void;
  onCreate?: (defaults: Rec) => void;
}

interface CalEvent { id: number; title: string; start: string; end: string; allDay: boolean; color: number; record: Rec }

const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const DAYS_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAYS_AR = ['الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت', 'الأحد'];

function iso(date: PyDate): string { return date.toString(); }
function startOfWeek(date: PyDate): PyDate { return applyRelativeDelta(date, new RelativeDelta({ days: -date.weekday() })); }
function colorOf(value: unknown): number {
  if (typeof value === 'number') return value % 12;
  const id = idOf(value);
  if (id) return id % 11 + 1;
  if (typeof value === 'string') { let h = 0; for (const ch of value) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return (h % 11) + 1; }
  return 0;
}

/**
 * Calendar view (A-4 §13): day / week / month / year scales, events from
 * the arch's `date_start` / `date_stop` / `all_day` / `color` fields, colour
 * legend with per-value filters, click a slot to quick-create, click an
 * event to open it, keyboard ←/→ to navigate.
 */
export function CalendarView({ arch, fields, model, domain, context, onOpen, onCreate }: Props) {
  const t = useT();
  const lang = useLang();
  const ui = useUi();
  const today = useMemo(() => PyDate.parse(new Date().toISOString().slice(0, 10))!, []);
  const scales = (arch.scales ? arch.scales.split(',') : ['day', 'week', 'month', 'year']).map((s) => s.trim()) as Scale[];
  const [scale, setScale] = useState<Scale>((arch.mode as Scale) && scales.includes(arch.mode as Scale) ? (arch.mode as Scale) : scales.includes('month') ? 'month' : scales[0]);
  const [anchor, setAnchor] = useState<PyDate>(today);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const months = lang === 'ar_001' ? MONTHS_AR : MONTHS_EN;
  const days = lang === 'ar_001' ? DAYS_AR : DAYS_EN;
  const isDatetime = fields[arch.dateStart]?.type === 'datetime';

  const range = useMemo(() => {
    if (scale === 'day') return { from: anchor, to: applyRelativeDelta(anchor, new RelativeDelta({ days: 1 })) };
    if (scale === 'week') { const from = startOfWeek(anchor); return { from, to: applyRelativeDelta(from, new RelativeDelta({ days: 7 })) }; }
    if (scale === 'year') return { from: new PyDate(anchor.year, 1, 1), to: new PyDate(anchor.year + 1, 1, 1) };
    const first = new PyDate(anchor.year, anchor.month, 1);
    const from = startOfWeek(first);
    return { from, to: applyRelativeDelta(from, new RelativeDelta({ days: 42 })) };
  }, [scale, anchor]);

  const load = useCallback(async () => {
    setLoading(true);
    const names = [arch.dateStart, arch.dateStop, arch.allDay, arch.color].filter((n): n is string => Boolean(n && fields[n]));
    const fieldList = [...new Set(['display_name', ...names, ...arch.fields.map((f) => f.name).filter((n) => fields[n])])];
    const extra: Domain = ['&', [arch.dateStart, '>=', isDatetime ? `${iso(range.from)} 00:00:00` : iso(range.from)], [arch.dateStart, '<', isDatetime ? `${iso(range.to)} 00:00:00` : iso(range.to)]];
    const full: Domain = domain.length ? (['&', ...domain, ...extra] as Domain) : extra;
    const rows = await rpc<Rec[]>('searchRead', model, { domain: full, fields: fieldList, limit: 1000, order: `${arch.dateStart} asc` }, { silent: true, context }).catch(() => [] as Rec[]);
    setEvents(rows.map((row) => {
      const start = String(row[arch.dateStart] ?? '');
      const stop = arch.dateStop ? String(row[arch.dateStop] || start) : start;
      return {
        id: row.id as number, title: String(row.display_name ?? ''), start, end: stop || start,
        allDay: !isDatetime || Boolean(arch.allDay && row[arch.allDay]), color: arch.color ? colorOf(row[arch.color]) : 4, record: row,
      };
    }));
    setLoading(false);
  }, [arch, fields, model, JSON.stringify(domain), range.from.toString(), range.to.toString(), context, isDatetime]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.tagName === 'INPUT' || (event.target as HTMLElement)?.tagName === 'TEXTAREA') return;
      if (event.key === 'ArrowLeft') move(-1);
      if (event.key === 'ArrowRight') move(1);
      if (event.key.toLowerCase() === 't' && !event.ctrlKey && !event.metaKey) setAnchor(today);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const move = (direction: 1 | -1) => setAnchor((current) => applyRelativeDelta(current, scale === 'day' ? new RelativeDelta({ days: direction }) : scale === 'week' ? new RelativeDelta({ weeks: direction }) : scale === 'month' ? new RelativeDelta({ months: direction }) : new RelativeDelta({ years: direction })));

  const legend = useMemo(() => {
    const map = new Map<number, string>();
    for (const event of events) {
      if (!arch.color || map.has(event.color)) continue;
      const raw = event.record[arch.color];
      map.set(event.color, Array.isArray(raw) || (raw && typeof raw === 'object') ? nameOf(raw) : String(raw ?? ''));
    }
    return [...map.entries()];
  }, [events, arch.color]);
  const visible = events.filter((event) => !hidden.has(event.color));

  const eventsOn = (date: PyDate) => {
    const key = iso(date);
    return visible.filter((event) => event.start.slice(0, 10) <= key && (event.end.slice(0, 10) >= key));
  };

  const quickCreate = (date: PyDate, hour?: number) => {
    const startValue = isDatetime ? `${iso(date)} ${String(hour ?? 9).padStart(2, '0')}:00:00` : iso(date);
    const defaults: Rec = { [arch.dateStart]: startValue };
    if (arch.dateStop && fields[arch.dateStop]) defaults[arch.dateStop] = isDatetime ? `${iso(date)} ${String((hour ?? 9) + 1).padStart(2, '0')}:00:00` : iso(date);
    if (arch.quickCreate === false) { onCreate?.(defaults); return; }
    let name = '';
    let dialogId = 0;
    dialogId = ui.openDialog({
      title: { en: 'New Event', ar: 'حدث جديد' },
      size: 'sm',
      body: <input className="form-control" placeholder={t('Title')} autoFocus onChange={(event) => { name = event.target.value; }} onKeyDown={(event) => { if (event.key === 'Enter') (document.getElementById(`o_cal_create_${dialogId}`) as HTMLButtonElement)?.click(); }} />,
      footer: (
        <>
          <button id={`o_cal_create_${dialogId}`} type="button" className="btn btn-primary" onClick={async () => {
            if (!name.trim()) return;
            ui.closeDialog(dialogId);
            const recName = fields.name ? 'name' : fields.summary ? 'summary' : fields.subject ? 'subject' : 'name';
            await rpc('create', model, { values: { ...defaults, [recName]: name.trim() } }, { context }).catch(() => undefined);
            await load();
          }}>{t('Create')}</button>
          <button type="button" className="btn btn-secondary" onClick={() => { ui.closeDialog(dialogId); onCreate?.({ ...defaults, name }); }}>{t('Edit')}</button>
          <button type="button" className="btn btn-link" onClick={() => ui.closeDialog(dialogId)}>{t('Discard')}</button>
        </>
      ),
    });
  };

  const title = scale === 'day' ? `${anchor.day} ${months[anchor.month - 1]} ${anchor.year}`
    : scale === 'week' ? `${t('Week')} ${range.from.day} ${months[range.from.month - 1]} – ${applyRelativeDelta(range.to, new RelativeDelta({ days: -1 })).day} ${months[applyRelativeDelta(range.to, new RelativeDelta({ days: -1 })).month - 1]} ${range.from.year}`
    : scale === 'month' ? `${months[anchor.month - 1]} ${anchor.year}` : String(anchor.year);

  const Chip = ({ event, compact }: { event: CalEvent; compact?: boolean }) => (
    <div className={`o_calendar_event ${compact ? 'o_calendar_event_compact' : ''}`} style={{ background: `var(--o-color-${event.color || 4})` }} title={event.title}
      onClick={(e) => { e.stopPropagation(); onOpen(event.id); }}>
      {!event.allDay && <span className="o_calendar_time">{event.start.slice(11, 16)} </span>}{event.title}
    </div>
  );

  return (
    <div className="o_calendar_view">
      <div className="o_calendar_buttons d-flex align-items-center gap-2 flex-wrap mb-2">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAnchor(today)}>{t('Today')}</button>
        <div className="btn-group btn-group-sm">
          <button type="button" className="btn btn-secondary" onClick={() => move(-1)} aria-label="Previous"><i className="fa fa-chevron-left" /></button>
          <button type="button" className="btn btn-secondary" onClick={() => move(1)} aria-label="Next"><i className="fa fa-chevron-right" /></button>
        </div>
        <h5 className="m-0 mx-2">{title}</h5>
        <div className="btn-group btn-group-sm ms-auto">
          {scales.map((s) => <button key={s} type="button" className={`btn ${scale === s ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setScale(s)}>{t(s === 'day' ? 'Day' : s === 'week' ? 'Week' : s === 'month' ? 'Month' : 'Year')}</button>)}
        </div>
      </div>
      {loading && <div className="o_loading_indicator" />}
      <div className="d-flex gap-3">
        <div className="flex-grow-1" style={{ minWidth: 0 }}>
          {scale === 'month' && (
            <div className="o_calendar_month">
              <div className="o_calendar_weekdays">{days.map((d) => <div key={d}>{d}</div>)}</div>
              <div className="o_calendar_grid">
                {Array.from({ length: 42 }, (_, i) => applyRelativeDelta(range.from, new RelativeDelta({ days: i }))).map((date) => {
                  const list = eventsOn(date);
                  const isToday = iso(date) === iso(today);
                  return (
                    <div key={iso(date)} className={`o_calendar_day ${date.month !== anchor.month ? 'o_calendar_day_other' : ''} ${isToday ? 'o_calendar_today' : ''}`} onClick={() => quickCreate(date)}>
                      <div className="o_calendar_day_number">{date.day}</div>
                      {list.slice(0, arch.eventLimit ?? 4).map((event) => <Chip key={event.id} event={event} compact />)}
                      {list.length > (arch.eventLimit ?? 4) && <div className="small text-muted">+{list.length - (arch.eventLimit ?? 4)} {t('more')}</div>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {(scale === 'week' || scale === 'day') && (
            <WeekGrid days={scale === 'week' ? Array.from({ length: 7 }, (_, i) => applyRelativeDelta(range.from, new RelativeDelta({ days: i }))) : [anchor]} dayNames={days} months={months}
              today={today} eventsOn={eventsOn} isDatetime={isDatetime} onSlot={quickCreate} Chip={Chip} t={t} />
          )}
          {scale === 'year' && (
            <div className="o_calendar_year">
              {Array.from({ length: 12 }, (_, m) => m + 1).map((month) => {
                const first = new PyDate(anchor.year, month, 1);
                const start = startOfWeek(first);
                return (
                  <div key={month} className="o_calendar_mini" onClick={() => { setAnchor(first); setScale('month'); }}>
                    <div className="fw-bold small mb-1">{months[month - 1]}</div>
                    <div className="o_calendar_mini_grid">
                      {Array.from({ length: 42 }, (_, i) => applyRelativeDelta(start, new RelativeDelta({ days: i }))).map((date) => {
                        const count = date.month === month ? eventsOn(date).length : 0;
                        return <div key={iso(date)} className={`o_calendar_mini_day ${date.month !== month ? 'text-muted opacity-25' : ''} ${count ? 'o_calendar_mini_busy' : ''} ${iso(date) === iso(today) ? 'o_calendar_today' : ''}`} title={count ? `${count}` : undefined}>{date.day}</div>;
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {legend.length > 0 && (
          <div className="o_calendar_sidebar d-none d-lg-block" style={{ width: 200 }}>
            <div className="fw-bold small text-muted mb-2">{t(fields[arch.color ?? '']?.label ?? 'Legend')}</div>
            {legend.map(([color, label]) => (
              <label key={color} className="d-flex align-items-center gap-2 small mb-1">
                <input type="checkbox" className="form-check-input m-0" checked={!hidden.has(color)} onChange={() => setHidden((set) => { const next = new Set(set); if (next.has(color)) next.delete(color); else next.add(color); return next; })} />
                <span style={{ width: 12, height: 12, borderRadius: 3, background: `var(--o-color-${color || 4})`, display: 'inline-block' }} />{label || t('None')}
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function WeekGrid({ days, dayNames, months, today, eventsOn, isDatetime, onSlot, Chip, t }: {
  days: PyDate[]; dayNames: string[]; months: string[]; today: PyDate; eventsOn: (d: PyDate) => CalEvent[]; isDatetime: boolean;
  onSlot: (d: PyDate, hour?: number) => void; Chip: (props: { event: CalEvent; compact?: boolean }) => React.JSX.Element; t: (s: string) => string;
}) {
  const hours = Array.from({ length: 24 }, (_, h) => h);
  return (
    <div className="o_calendar_week" style={{ gridTemplateColumns: `56px repeat(${days.length}, 1fr)` }}>
      <div className="o_calendar_week_corner" />
      {days.map((date) => (
        <div key={iso(date)} className={`o_calendar_week_head ${iso(date) === iso(today) ? 'o_calendar_today' : ''}`}>
          <div className="small text-muted">{dayNames[date.weekday()]}</div>
          <div className="fs-5">{date.day} <span className="small text-muted">{months[date.month - 1].slice(0, 3)}</span></div>
        </div>
      ))}
      <div className="o_calendar_allday_label small text-muted">{t('All day')}</div>
      {days.map((date) => (
        <div key={`allday-${iso(date)}`} className="o_calendar_allday" onClick={() => onSlot(date)}>
          {eventsOn(date).filter((event) => event.allDay).map((event) => <Chip key={event.id} event={event} compact />)}
        </div>
      ))}
      {isDatetime && hours.map((hour) => (
        <div key={hour} style={{ display: 'contents' }}>
          <div className="o_calendar_hour small text-muted">{String(hour).padStart(2, '0')}:00</div>
          {days.map((date) => (
            <div key={`${iso(date)}-${hour}`} className="o_calendar_slot" onClick={() => onSlot(date, hour)}>
              {eventsOn(date).filter((event) => !event.allDay && Number(event.start.slice(11, 13)) === hour).map((event) => <Chip key={event.id} event={event} />)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
