'use client';

import { useEffect, useState } from 'react';
import { PyDate } from '@engine/expr/pydate';
import { formatRelativeDate } from '@engine/format/index';
import { rpc } from '@/lib/client/rpc';
import { useLang, useT } from '@/lib/client/i18n';
import { idOf, nameOf } from '@/lib/client/display';
import { activityState, useActivityIcons, type ActivityRow } from './Activities';
import { Dropdown, avatarColor } from './Navbar';
import { useNavigation } from '@/lib/client/navigation';
import type { SessionInfo } from './WebClient';

type Rec = Record<string, unknown>;

/**
 * C-1 systray panels: Messages (latest chatter messages across documents)
 * and Activities (my planned activities grouped by document model with the
 * Late / Today / Future counters). Each row opens its document.
 */
export function MessagesMenu() {
  const t = useT();
  const lang = useLang();
  const { navigate } = useNavigation();
  const [rows, setRows] = useState<Rec[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const today = PyDate.parse(new Date().toISOString().slice(0, 10))!;

  const load = async () => {
    const list = await rpc<Rec[]>('searchRead', 'mail.message', {
      domain: [['message_type', 'in', ['comment', 'email']], ['model', '!=', false], ['res_id', '!=', 0]],
      fields: ['body', 'author_id', 'date', 'model', 'res_id', 'is_internal', 'subject'], order: 'date desc, id desc', limit: 20,
    }, { silent: true }).catch(() => [] as Rec[]);
    setRows(list);
    const wanted = list.map((row) => `${row.model}:${row.res_id}`);
    const byModel = new Map<string, number[]>();
    for (const row of list) { const ids = byModel.get(String(row.model)) ?? []; ids.push(Number(row.res_id)); byModel.set(String(row.model), ids); }
    const found: Record<string, string> = {};
    await Promise.all([...byModel].map(async ([model, ids]) => {
      const recs = await rpc<Rec[]>('read', model, { ids: [...new Set(ids)], fields: ['display_name'] }, { silent: true }).catch(() => [] as Rec[]);
      for (const rec of recs) found[`${model}:${rec.id}`] = String(rec.display_name ?? '');
    }));
    setNames(Object.fromEntries(wanted.map((key) => [key, found[key] ?? ''])));
  };

  const strip = (html: unknown) => String(html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  return (
    <Dropdown end toggle={(open) => (
      <button type="button" className={`o_systray_item ${open ? 'active' : ''}`} title={t('Messages')} onClick={() => { if (!open) void load(); }}>
        <i className="fa fa-comments fa-lg" />
      </button>
    )}>
      <div className="o_systray_panel" style={{ width: 380, maxHeight: 480, overflow: 'auto' }}>
        <div className="o_dropdown_header d-flex justify-content-between align-items-center">
          <span>{t('Messages')}</span>
          <a href="#discuss" className="small" onClick={(event) => { event.preventDefault(); navigate('/odoo/discuss'); }}>{t('Open Discuss')}</a>
        </div>
        {rows === null && <div className="p-3 text-muted">{t('Loading...')}</div>}
        {rows?.length === 0 && <div className="p-4 text-center text-muted"><i className="fa fa-comments-o fa-2x d-block mb-2" />{t('No messages')}</div>}
        {rows?.map((row) => {
          const author = nameOf(row.author_id) || t('System');
          const key = `${row.model}:${row.res_id}`;
          return (
            <button key={row.id as number} type="button" className="o_dropdown_item d-flex gap-2 align-items-start text-start" style={{ whiteSpace: 'normal' }}
              onClick={() => navigate(`/odoo/m/${row.model}/${row.res_id}`)}>
              <span className="o_avatar flex-shrink-0" style={{ background: avatarColor(author) }}>{author.slice(0, 1).toUpperCase()}</span>
              <span className="flex-grow-1" style={{ minWidth: 0 }}>
                <span className="d-flex justify-content-between gap-2">
                  <span className="fw-bold text-truncate">{names[key] || String(row.model)}</span>
                  <span className="text-muted small flex-shrink-0">{formatRelativeDate(String(row.date), today, lang)}</span>
                </span>
                <span className="d-block text-muted small text-truncate">{author}: {strip(row.body) || String(row.subject ?? '')}</span>
              </span>
            </button>
          );
        })}
      </div>
    </Dropdown>
  );
}

interface ActivityGroup { model: string; name: string; overdue: number; today: number; planned: number; ids: number[]; icon: string }

export function ActivitiesMenu({ user }: { user: SessionInfo }) {
  const t = useT();
  const { navigate } = useNavigation();
  const icons = useActivityIcons();
  const [groups, setGroups] = useState<ActivityGroup[] | null>(null);
  const [count, setCount] = useState(0);
  const today = PyDate.parse(new Date().toISOString().slice(0, 10))!;

  const load = async () => {
    const rows = await rpc<ActivityRow[]>('searchRead', 'mail.activity', {
      domain: [['user_id', '=', user.uid]], fields: ['date_deadline', 'res_model', 'res_model_id', 'res_id', 'activity_type_id'], order: 'date_deadline asc', limit: 500,
    }, { silent: true, cacheMs: 60_000 }).catch(() => [] as ActivityRow[]);
    const map = new Map<string, ActivityGroup>();
    for (const row of rows) {
      const group = map.get(row.res_model) ?? { model: row.res_model, name: nameOf((row as unknown as Rec).res_model_id) || row.res_model, overdue: 0, today: 0, planned: 0, ids: [], icon: '' };
      group[activityState(row.date_deadline, today)] += 1;
      group.ids.push(Number(row.res_id));
      const typeId = idOf(row.activity_type_id);
      if (!group.icon && typeId && icons[typeId]) group.icon = icons[typeId];
      map.set(row.res_model, group);
    }
    setGroups([...map.values()]);
    setCount(rows.filter((row) => activityState(row.date_deadline, today) !== 'planned').length);
  };

  useEffect(() => { void load(); }, [user.uid]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Dropdown end toggle={(open) => (
      <button type="button" className={`o_systray_item position-relative ${open ? 'active' : ''}`} title={t('Activities')} onClick={() => { if (!open) void load(); }}>
        <i className="fa fa-clock-o fa-lg" />
        {count > 0 && <span className="o_systray_badge">{count}</span>}
      </button>
    )}>
      <div className="o_systray_panel" style={{ width: 360, maxHeight: 480, overflow: 'auto' }}>
        <div className="o_dropdown_header">{t('Activities')}</div>
        {groups === null && <div className="p-3 text-muted">{t('Loading...')}</div>}
        {groups?.length === 0 && <div className="p-4 text-center text-muted"><i className="fa fa-check-circle fa-2x d-block mb-2 text-success" />{t('Congratulations, you\'re done with your activities.')}</div>}
        {groups?.map((group) => (
          <button key={group.model} type="button" className="o_dropdown_item d-flex gap-2 align-items-center" onClick={() => navigate(`/odoo/m/${group.model}?ids=${[...new Set(group.ids)].join(',')}`)}>
            <span className="o_activity_app_icon"><i className={`fa ${group.icon || 'fa-clock-o'}`} /></span>
            <span className="flex-grow-1">
              <span className="fw-bold d-block">{group.name}</span>
              <span className="small">
                {group.overdue > 0 && <span className="text-danger me-2">{group.overdue} {t('Late')}</span>}
                {group.today > 0 && <span className="text-warning me-2">{group.today} {t('Today')}</span>}
                {group.planned > 0 && <span className="text-success">{group.planned} {t('Future')}</span>}
              </span>
            </span>
          </button>
        ))}
      </div>
    </Dropdown>
  );
}
