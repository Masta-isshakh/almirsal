'use client';

import { useCallback, useEffect, useState } from 'react';
import { PyDate } from '@engine/expr/pydate';
import { daysUntil, formatDate } from '@engine/format/index';
import { rpc } from '@/lib/client/rpc';
import { useLang, useT } from '@/lib/client/i18n';
import { idOf, nameOf } from '@/lib/client/display';
import { useActions, type DoActionOptions } from '@/lib/client/actions';
import { avatarColor } from './Navbar';
import { useUi } from './ui';

type Rec = Record<string, unknown>;

export interface ActivityRow {
  id: number; summary: string | false; note: string | false; date_deadline: string; user_id: unknown; activity_type_id: unknown;
  res_model: string; res_id: number; res_name: string | false; icon?: string | null;
}

export const ACTIVITY_FIELDS = ['summary', 'note', 'date_deadline', 'user_id', 'activity_type_id', 'res_model', 'res_id', 'res_name'];

export function activityState(deadline: string, today: PyDate): 'overdue' | 'today' | 'planned' {
  const days = daysUntil(deadline, today) ?? 0;
  return days < 0 ? 'overdue' : days === 0 ? 'today' : 'planned';
}

/** Open the "Schedule Activity" dialog (the mail.activity form, target=new). */
export function useScheduleActivity() {
  const { doAction } = useActions();
  return useCallback((model: string, resId: number, options: DoActionOptions = {}, activityId?: number) => doAction({
    type: 'ir.actions.act_window', res_model: 'mail.activity', view_mode: 'form', target: 'new', res_id: activityId,
    name: activityId ? { en: 'Edit Activity', ar: 'تعديل النشاط' } : { en: 'Schedule Activity', ar: 'جدولة نشاط' },
    context: { default_res_model: model, default_res_id: resId, active_model: model, active_id: resId },
  }, options), [doAction]);
}

/** Icons per activity type come from mail.activity.type; cached per session. */
let typeIcons: Promise<Record<number, string>> | undefined;
function loadTypeIcons(): Promise<Record<number, string>> {
  return (typeIcons ??= rpc<Rec[]>('searchRead', 'mail.activity.type', { domain: [], fields: ['icon'], limit: 200 }, { silent: true })
    .then((rows) => Object.fromEntries(rows.map((row) => [row.id as number, String(row.icon || 'fa-clock-o')])))
    .catch(() => ({})));
}

export function useActivityIcons(): Record<number, string> {
  const [icons, setIcons] = useState<Record<number, string>>({});
  useEffect(() => { loadTypeIcons().then(setIcons); }, []);
  return icons;
}

/**
 * Chatter activities (Part G): one card per planned activity with type icon,
 * deadline colouring (overdue red / today orange / planned green), assignee,
 * and the Mark Done (with feedback), Edit and Cancel actions.
 */
export function ActivityList({ model, recordId, onChanged }: { model: string; recordId: number; onChanged?: () => void }) {
  const t = useT();
  const lang = useLang();
  const ui = useUi();
  const icons = useActivityIcons();
  const schedule = useScheduleActivity();
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const today = PyDate.parse(new Date().toISOString().slice(0, 10))!;

  const load = useCallback(async () => {
    const list = await rpc<ActivityRow[]>('searchRead', 'mail.activity', {
      domain: [['res_model', '=', model], ['res_id', '=', recordId]], fields: ACTIVITY_FIELDS, order: 'date_deadline asc, id asc',
    }, { silent: true }).catch(() => [] as ActivityRow[]);
    setRows(list);
  }, [model, recordId]);
  useEffect(() => { void load(); }, [load]);

  const refresh = async () => { await load(); onChanged?.(); };

  const markDone = (row: ActivityRow, next: boolean) => {
    let feedback = '';
    let dialogId = 0;
    dialogId = ui.openDialog({
      title: { en: 'Mark Done', ar: 'تحديد كمنجز' },
      size: 'sm',
      body: <textarea className="form-control" rows={4} placeholder={t('Write Feedback')} autoFocus onChange={(event) => { feedback = event.target.value; }} />,
      footer: (
        <>
          <button type="button" className="btn btn-primary" onClick={async () => {
            ui.closeDialog(dialogId);
            const result = await rpc<Rec | false>('callButton', 'mail.activity', { ids: [row.id], method: next ? 'action_done_schedule_next' : 'action_done', context: { feedback } }).catch(() => false);
            await refresh();
            if (next && result && typeof result === 'object' && result.type === 'ir.actions.act_window') await schedule(model, recordId, { onClose: () => void refresh() });
          }}>{t(next ? 'Done & Schedule Next' : 'Done')}</button>
          <button type="button" className="btn btn-secondary" onClick={() => ui.closeDialog(dialogId)}>{t('Discard')}</button>
        </>
      ),
    });
  };

  const cancel = async (row: ActivityRow) => {
    await rpc('unlink', 'mail.activity', { ids: [row.id] }).catch(() => undefined);
    await refresh();
  };

  if (rows.length === 0) return null;
  const labels = { overdue: t('Overdue'), today: t('Today'), planned: t('Planned') };
  return (
    <div className="o_activity_list">
      {rows.map((row) => {
        const state = activityState(row.date_deadline, today);
        const days = daysUntil(row.date_deadline, today) ?? 0;
        const when = state === 'today' ? t('Today') : state === 'overdue' ? `${Math.abs(days)} ${t(Math.abs(days) === 1 ? 'day overdue' : 'days overdue')}` : days === 1 ? t('Tomorrow') : `${t('Due in')} ${days} ${t('days')}`;
        const user = nameOf(row.user_id);
        const typeId = idOf(row.activity_type_id);
        return (
          <div key={row.id} className={`o_activity o_activity_${state}`}>
            <div className="o_activity_icon"><i className={`fa ${(typeId && icons[typeId]) || 'fa-clock-o'}`} /></div>
            <div className="flex-grow-1">
              <div className="d-flex align-items-baseline gap-2 flex-wrap">
                <span className={`o_activity_when text-${state === 'overdue' ? 'danger' : state === 'today' ? 'warning' : 'success'} fw-bold`}>{when}</span>
                <span className="text-muted small">{formatDate(row.date_deadline, lang)}</span>
                <span className="badge rounded-pill text-bg-light">{labels[state]}</span>
              </div>
              <div className="o_activity_summary">
                <span className="fw-bold">{nameOf(row.activity_type_id)}</span>{row.summary ? `: ${row.summary}` : ''}
                {user && <span className="ms-2 text-muted small"><span className="o_avatar me-1" style={{ background: avatarColor(user), width: 18, height: 18, fontSize: 10 }}>{user.slice(0, 1).toUpperCase()}</span>{t('for')} {user}</span>}
              </div>
              {row.note && <div className="o_activity_note text-muted small" dangerouslySetInnerHTML={{ __html: String(row.note) }} />}
              <div className="o_activity_actions d-flex gap-3 mt-1 small">
                <a href="#done" onClick={(event) => { event.preventDefault(); markDone(row, false); }}><i className="fa fa-check me-1" />{t('Mark Done')}</a>
                <a href="#next" onClick={(event) => { event.preventDefault(); markDone(row, true); }}><i className="fa fa-forward me-1" />{t('Done & Schedule Next')}</a>
                <a href="#edit" onClick={(event) => { event.preventDefault(); void schedule(model, recordId, { onClose: () => void refresh() }, row.id); }}><i className="fa fa-pencil me-1" />{t('Edit')}</a>
                <a href="#cancel" className="text-muted" onClick={(event) => { event.preventDefault(); void cancel(row); }}><i className="fa fa-times me-1" />{t('Cancel')}</a>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
