'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ActivityArch } from '@engine/registry/arch';
import type { Domain, FieldDef } from '@engine/registry/types';
import { PyDate } from '@engine/expr/pydate';
import { rpc } from '@/lib/client/rpc';
import { useT } from '@/lib/client/i18n';
import { idOf, nameOf } from '@/lib/client/display';
import { activityState, useScheduleActivity, type ActivityRow } from '../webclient/Activities';

type Rec = Record<string, unknown>;

interface Props {
  arch: ActivityArch;
  fields: Record<string, FieldDef>;
  model: string;
  domain: Domain;
  context: Record<string, unknown>;
  offset: number;
  limit: number;
  onTotal: (total: number) => void;
  onOpen: (id: number) => void;
}

interface ActivityType { id: number; name: string; icon: string }

/**
 * Activity view (A-4 §14): records × activity types; each cell shows the
 * next activity of that type coloured by its state, click schedules or
 * opens it. The record column opens the form.
 */
export function ActivityView({ model, domain, context, offset, limit, onTotal, onOpen }: Props) {
  const t = useT();
  const schedule = useScheduleActivity();
  const [types, setTypes] = useState<ActivityType[]>([]);
  const [records, setRecords] = useState<Rec[]>([]);
  const [activities, setActivities] = useState<Map<string, ActivityRow[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const today = PyDate.parse(new Date().toISOString().slice(0, 10))!;

  const load = useCallback(async () => {
    setLoading(true);
    const [typeRows, page] = await Promise.all([
      rpc<Rec[]>('searchRead', 'mail.activity.type', { domain: ['|', ['res_model', '=', false], ['res_model', '=', model]], fields: ['name', 'icon'], order: 'sequence asc, id asc', limit: 50 }, { silent: true }).catch(() => [] as Rec[]),
      rpc<{ length: number; records: Rec[] }>('webSearchRead', model, { domain: domain.length ? (['&', ['activity_ids', '!=', false], ...domain] as Domain) : [['activity_ids', '!=', false]], specification: { display_name: {} }, offset, limit, order: 'activity_date_deadline asc' }, { silent: true, context })
        .catch(() => ({ length: 0, records: [] as Rec[] })),
    ]);
    setTypes(typeRows.map((row) => ({ id: row.id as number, name: String(row.name), icon: String(row.icon || 'fa-clock-o') })));
    setRecords(page.records);
    onTotal(page.length);
    const ids = page.records.map((row) => row.id as number);
    const rows = ids.length ? await rpc<ActivityRow[]>('searchRead', 'mail.activity', {
      domain: [['res_model', '=', model], ['res_id', 'in', ids]], fields: ['summary', 'date_deadline', 'user_id', 'activity_type_id', 'res_id', 'res_model'], order: 'date_deadline asc',
    }, { silent: true }).catch(() => [] as ActivityRow[]) : [];
    const map = new Map<string, ActivityRow[]>();
    for (const row of rows) { const key = `${row.res_id}:${idOf(row.activity_type_id)}`; (map.get(key) ?? map.set(key, []).get(key)!).push(row); }
    setActivities(map);
    setLoading(false);
  }, [model, JSON.stringify(domain), offset, limit, context]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="o_activity_view">
      {loading && <div className="o_loading_indicator" />}
      <table className="o_list_table o_activity_table">
        <thead>
          <tr>
            <th style={{ minWidth: 240 }}>{t('Record')}</th>
            {types.map((type) => <th key={type.id} className="text-center"><i className={`fa ${type.icon} me-1 text-muted`} />{type.name}</th>)}
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr key={record.id as number}>
              <td className="fw-bold" onClick={() => onOpen(record.id as number)}>{String(record.display_name ?? '')}</td>
              {types.map((type) => {
                const list = activities.get(`${record.id}:${type.id}`) ?? [];
                const next = list[0];
                const state = next ? activityState(next.date_deadline, today) : null;
                return (
                  <td key={type.id} className={`text-center o_activity_cell ${state ? `o_activity_cell_${state}` : ''}`}
                    onClick={() => void schedule(model, record.id as number, { onClose: () => void load() }, next?.id)}>
                    {next ? (
                      <div>
                        <div className="small fw-bold">{next.date_deadline}</div>
                        <div className="small text-truncate" style={{ maxWidth: 160 }}>{next.summary || nameOf(next.user_id)}</div>
                        {list.length > 1 && <div className="small text-muted">+{list.length - 1}</div>}
                      </div>
                    ) : <span className="text-muted o_activity_cell_add"><i className="fa fa-plus" /></span>}
                  </td>
                );
              })}
            </tr>
          ))}
          {!loading && records.length === 0 && (
            <tr><td colSpan={types.length + 1} className="text-center text-muted p-5">{t('No activities planned. Click a cell to schedule one.')}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
