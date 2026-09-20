'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SearchArch, SearchFilter, SearchGroupBy } from '@engine/registry/arch';
import type { Domain, ViewType } from '@engine/registry/types';
import { PyDate } from '@engine/expr/pydate';
import type { ResolvedAction } from '@/lib/server/actions';
import { useLang, useT } from '@/lib/client/i18n';
import { rpc } from '@/lib/client/rpc';
import { CurrencyProvider } from '@/lib/client/display';
import { useActions } from '@/lib/client/actions';
import { useNavigation } from '@/lib/client/navigation';
import { Dropdown } from './Navbar';
import { useUi } from './ui';
import type { SessionInfo } from './WebClient';
import { ListView } from '../views/ListView';
import { KanbanView } from '../views/KanbanView';
import { FormView } from '../views/FormView';
import { PivotView } from '../views/PivotView';
import { GraphView } from '../views/GraphView';
import { CalendarView } from '../views/CalendarView';
import { ActivityView } from '../views/ActivityView';
import { ListActions } from '../views/ListActions';
import { UnsupportedView } from '../views/UnsupportedView';
import { RECORD_CACHE_MS, formSpecification, listFieldNames } from '@/lib/client/arch';
import {
  EMPTY_STATE, facetsFromState, periodOptions, safeEval, stateFromContext, textFacetDomain,
  type EvalEnv, type Facet, type SearchState,
} from './search';

export type { Facet } from './search';

/**
 * The action manager for one act_window action: control panel (primary
 * button, breadcrumb, search view with facets, pager, view switcher) over
 * the current view. The search state is serialisable, which is what saved
 * favorites are.
 */

const VIEW_ICONS: Record<ViewType, string> = {
  list: 'fa fa-list-ul', kanban: 'fa fa-th-large', form: 'fa fa-file-text-o', calendar: 'fa fa-calendar',
  pivot: 'fa fa-table', graph: 'fa fa-bar-chart', gantt: 'fa fa-tasks', activity: 'fa fa-clock-o', map: 'fa fa-map-marker',
  cohort: 'fa fa-signal', grid: 'fa fa-th', hierarchy: 'fa fa-sitemap', search: 'fa fa-search',
};

interface Favorite { id: number; name: string; state: SearchState; isDefault: boolean; shared: boolean }

export function ActionContainer({ resolution, query: urlQuery, user }: { resolution: ResolvedAction; query: Record<string, string>; user: SessionInfo }) {
  const t = useT();
  const lang = useLang();
  const { navigate, reload: reloadPage } = useNavigation();
  const ui = useUi();
  const { doAction } = useActions();
  const { action, views, searchView, fields } = resolution;
  const search = searchView?.arch.type === 'search' ? (searchView.arch as SearchArch) : null;
  const today = useMemo(() => PyDate.parse(new Date().toISOString().slice(0, 10))!, []);

  const idsParam = urlQuery.ids ?? null;
  const defaultsParam = urlQuery.defaults ?? null;
  const actionContext = useMemo(() => {
    const base = (safeEval(action.context, { uid: user.uid, companyIds: user.companyIds, context: {} }) as Record<string, unknown>) ?? {};
    // Calendar / kanban quick-create hand their defaults to the form through the URL.
    if (defaultsParam) {
      try { for (const [key, value] of Object.entries(JSON.parse(defaultsParam) as Record<string, unknown>)) base[`default_${key}`] = value; } catch { /* ignore */ }
    }
    return base;
  }, [action.context, user, defaultsParam]);
  const env = useMemo<EvalEnv>(() => ({ uid: user.uid, companyIds: user.companyIds, context: actionContext }), [user, actionContext]);
  const actionDomain = useMemo(() => (safeEval(action.domain || undefined, env) as Domain) ?? [], [action.domain, env]);

  const [state, setState] = useState<SearchState>(() => stateFromContext(actionContext, search));
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [activeFavorite, setActiveFavorite] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [allMatching, setAllMatching] = useState(false);
  const [reload, setReload] = useState(0);
  const limit = action.limit ?? 80;
  const isForm = resolution.viewType === 'form';
  const isSettings = action.model === 'res.config.settings';
  const pagerKey = `rodeo.pager.${resolution.slug}`;

  // Record pager on the form: the ids of the list page the user came from.
  const [pagerIds, setPagerIds] = useState<number[]>([]);
  useEffect(() => {
    if (!isForm) return;
    try { setPagerIds(JSON.parse(sessionStorage.getItem(pagerKey) ?? '[]')); } catch { setPagerIds([]); }
  }, [isForm, pagerKey]);
  const rememberPage = useCallback((ids: number[]) => { try { sessionStorage.setItem(pagerKey, JSON.stringify(ids)); } catch { /* private mode */ } }, [pagerKey]);
  const pagerIndex = resolution.recordId ? pagerIds.indexOf(resolution.recordId) : -1;

  const refresh = useCallback(() => { setReload((n) => n + 1); setSelected([]); setAllMatching(false); }, []);

  // Alt+N new record, Alt+←/→ previous / next record on a form.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === 'n' && views.form && !isSettings) { event.preventDefault(); navigate(`/odoo/${resolution.slug}/new`); }
      if (isForm && pagerIndex >= 0) {
        const step = key === 'arrowright' ? 1 : key === 'arrowleft' ? -1 : 0;
        const target = step ? pagerIds[pagerIndex + step] : undefined;
        if (target) { event.preventDefault(); navigate(`/odoo/${resolution.slug}/${target}`); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [views.form, isSettings, isForm, pagerIndex, pagerIds, resolution.slug, navigate]);

  // Hover prefetch: the record a pointer rests on (and the pager neighbours) is
  // read into the RPC cache with the form's own specification, so opening it
  // costs no round trip.
  const formSpec = useMemo(() => (views.form?.arch.type === 'form' ? formSpecification(views.form.arch, fields).spec : null), [views.form, fields]);
  const prefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prefetch = useCallback((id: number, delay = 120) => {
    if (!formSpec || !action.model) return;
    if (prefetchTimer.current) clearTimeout(prefetchTimer.current);
    prefetchTimer.current = setTimeout(() => {
      rpc('webRead', action.model!, { ids: [id], specification: formSpec }, { silent: true, context: actionContext, cacheMs: RECORD_CACHE_MS }).catch(() => undefined);
    }, delay);
  }, [formSpec, action.model, actionContext]);
  useEffect(() => {
    if (!isForm || pagerIndex < 0) return;
    for (const neighbour of [pagerIds[pagerIndex + 1], pagerIds[pagerIndex - 1]]) if (neighbour) prefetch(neighbour, 400);
  }, [isForm, pagerIndex, pagerIds, prefetch]);

  // Printable reports bound to the model (form ⚙ › Print, list Actions › Print).
  const [reports, setReports] = useState<{ reportName: string; name: { en: string; ar: string } }[]>([]);
  useEffect(() => {
    if (!action.model || isSettings) return;
    rpc<{ reportName: string; name: { en: string; ar: string } }[]>('listReports', action.model, {}, { silent: true, cacheMs: 30 * 60_000 }).then(setReports).catch(() => setReports([]));
  }, [action.model, isSettings]);
  const openReport = (reportName: string, ids: number[]) => window.open(`/report/${encodeURIComponent(reportName)}/${ids.join(',')}?print=1`, '_blank');

  // Favorites are `ir.filters` rows scoped by model and action slug.
  useEffect(() => {
    if (isForm || !action.model) return;
    let cancelled = false;
    rpc<{ id: number; name: string; context: string; is_default: boolean; user_id: unknown }[]>('searchRead', 'ir.filters', {
      domain: [['model_id', '=', action.model], '|', ['user_id', '=', user.uid], ['user_id', '=', false]],
      fields: ['name', 'context', 'is_default', 'user_id'], order: 'name asc',
    }, { silent: true, cacheMs: 60_000 }).then((rows) => {
      if (cancelled) return;
      const mine = rows.map((row) => {
        let parsed: { action?: string; state?: SearchState } = {};
        try { parsed = JSON.parse(row.context); } catch { /* ignore */ }
        return { row, parsed };
      }).filter(({ parsed }) => parsed.action === resolution.slug);
      const list = mine.map(({ row, parsed }) => ({ id: row.id, name: row.name, state: parsed.state ?? EMPTY_STATE, isDefault: Boolean(row.is_default), shared: !row.user_id }));
      setFavorites(list);
      const preset = list.find((favorite) => favorite.isDefault);
      if (preset) { setState(preset.state); setActiveFavorite(preset.id); }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [action.model, resolution.slug, user.uid, isForm]);

  const facets = useMemo(() => facetsFromState(state, search, env, today, lang), [state, search, env, today, lang]);
  const domain = useMemo<Domain>(() => {
    const parts: Domain[] = [actionDomain];
    if (idsParam) parts.push([['id', 'in', idsParam.split(',').map(Number).filter((id) => id > 0)]]);
    for (const facet of facets) if (facet.domain?.length) parts.push(facet.domain);
    const nonEmpty = parts.filter((part) => part.length);
    if (nonEmpty.length <= 1) return nonEmpty[0] ?? [];
    return [...Array(nonEmpty.length - 1).fill('&'), ...nonEmpty.flat()] as Domain;
  }, [actionDomain, facets, idsParam]);
  const groupBy = useMemo(() => facets.filter((facet) => facet.groupBy).map((facet) => facet.groupBy!), [facets]);

  const change = useCallback((updater: (current: SearchState) => SearchState) => {
    setOffset(0);
    setActiveFavorite(null);
    setState(updater);
  }, []);

  const toggleFilter = (filter: SearchFilter) => change((current) => ({
    ...current, filters: current.filters.includes(filter.name) ? current.filters.filter((name) => name !== filter.name) : [...current.filters, filter.name],
  }));
  const togglePeriod = (filter: SearchFilter, key: string) => change((current) => {
    const keys = current.dates[filter.name] ?? [];
    const next = keys.includes(key) ? keys.filter((item) => item !== key) : [...keys, key];
    const dates = { ...current.dates };
    if (next.length) dates[filter.name] = next; else delete dates[filter.name];
    return { ...current, dates };
  });
  const toggleGroupBy = (group: SearchGroupBy) => change((current) => ({
    ...current, groupbys: current.groupbys.includes(group.name) ? current.groupbys.filter((name) => name !== group.name) : [...current.groupbys, group.name],
  }));
  const addText = (text: string) => {
    if (!text.trim() || !search) return;
    const { label, domain: textDomain } = textFacetDomain(text.trim(), search, fields.name ? 'name' : 'display_name', env);
    change((current) => ({ ...current, texts: [...current.texts, { label, value: text.trim(), domain: textDomain }] }));
    setQuery('');
  };
  const removeFacet = (facet: Facet) => change((current) => {
    const [kind, name] = facet.id.split(':');
    if (kind === 'filter') return { ...current, filters: current.filters.filter((item) => item !== name) };
    if (kind === 'groupby') return { ...current, groupbys: current.groupbys.filter((item) => item !== name) };
    if (kind === 'date') { const dates = { ...current.dates }; delete dates[name]; return { ...current, dates }; }
    if (kind === 'field') return { ...current, texts: current.texts.filter((_, index) => String(index) !== name) };
    return current;
  });

  const saveFavorite = () => {
    let name = t(action.name);
    let isDefault = false;
    let shared = false;
    let dialogId = 0;
    dialogId = ui.openDialog({
      title: { en: 'Save current search', ar: 'حفظ البحث الحالي' },
      size: 'sm',
      body: (
        <div>
          <input className="form-control mb-2" defaultValue={name} onChange={(event) => { name = event.target.value; }} autoFocus />
          <label className="d-flex gap-2 align-items-center"><input type="checkbox" className="form-check-input m-0" onChange={(event) => { isDefault = event.target.checked; }} />{t('Default filter')}</label>
          <label className="d-flex gap-2 align-items-center"><input type="checkbox" className="form-check-input m-0" onChange={(event) => { shared = event.target.checked; }} />{t('Shared')}</label>
        </div>
      ),
      footer: (
        <>
          <button type="button" className="btn btn-primary" onClick={async () => {
            ui.closeDialog(dialogId);
            const id = await rpc<number>('create', 'ir.filters', { values: {
              name, model_id: action.model, domain: JSON.stringify(domain), context: JSON.stringify({ action: resolution.slug, state }), sort: '[]',
              is_default: isDefault, user_id: shared ? false : user.uid, active: true,
            } });
            setFavorites((list) => [...list, { id, name, state, isDefault, shared }]);
            setActiveFavorite(id);
          }}>{t('Save')}</button>
          <button type="button" className="btn btn-secondary" onClick={() => ui.closeDialog(dialogId)}>{t('Cancel')}</button>
        </>
      ),
    });
  };
  const applyFavorite = (favorite: Favorite) => { setOffset(0); setState(favorite.state); setActiveFavorite(favorite.id); };
  const deleteFavorite = async (favorite: Favorite) => {
    if (!(await ui.confirm({ message: { en: `Delete the favorite "${favorite.name}"?`, ar: `حذف المفضلة "${favorite.name}"؟` } }))) return;
    await rpc('unlink', 'ir.filters', { ids: [favorite.id] });
    setFavorites((list) => list.filter((item) => item.id !== favorite.id));
    if (activeFavorite === favorite.id) { setActiveFavorite(null); setState(EMPTY_STATE); }
  };

  const goTo = (viewType: ViewType) => navigate(`/odoo/${resolution.slug}?view_type=${viewType}`);
  const openRecord = (id: number) => navigate(`/odoo/${resolution.slug}/${id}`);
  const createRecord = () => navigate(`/odoo/${resolution.slug}/new`);
  const view = views[resolution.viewType];
  const switcher = (action.viewMode ?? []).filter((type) => type !== 'form' && views[type]);
  const headerButtons = view?.arch.type === 'list' ? view.arch.headerButtons : [];

  const runHeaderButton = async (button: (typeof headerButtons)[number]) => {
    if (selected.length === 0) { ui.notify({ message: { en: 'Select records first.', ar: 'حدد السجلات أولاً.' }, type: 'warning' }); return; }
    if (button.type === 'action' && button.name) {
      await doAction(button.name, { activeIds: selected, activeId: selected[0], activeModel: action.model, onClose: refresh });
    } else if (button.type === 'object' && button.name && action.model) {
      const result = await rpc<Record<string, unknown> | false>('callButton', action.model, { ids: selected, method: button.name }).catch(() => false);
      if (result && typeof result === 'object') await doAction(result, { activeIds: selected, activeModel: action.model });
      refresh();
    }
  };

  /** Pivot / graph click-through: open the list on exactly those records. */
  const drill = async (cellDomain: Domain, title: string) => {
    const ids = await rpc<number[]>('search', action.model!, { domain: cellDomain, limit: 2000 }, { silent: true }).catch(() => [] as number[]);
    if (ids.length === 0) { ui.notify({ type: 'info', message: { en: `No records for ${title}.`, ar: `لا توجد سجلات لـ ${title}.` } }); return; }
    navigate(`/odoo/${resolution.slug}?view_type=list&ids=${ids.join(',')}`);
  };

  /** Form ⚙ menu: duplicate, archive/unarchive, delete. */
  const formMenu = resolution.recordId && action.model ? (
    <Dropdown toggle={() => <button type="button" className="btn btn-link text-muted px-2" title={t('Actions')}><i className="fa fa-cog" /></button>}>
      {reports.length > 0 && <div className="o_dropdown_header"><i className="fa fa-print me-1" />{t('Print')}</div>}
      {reports.map((report) => <button key={report.reportName} type="button" className="o_dropdown_item ps-4" onClick={() => openReport(report.reportName, [resolution.recordId!])}>{t(report.name)}</button>)}
      {reports.length > 0 && <div className="o_dropdown_divider" />}
      <button type="button" className="o_dropdown_item" onClick={async () => { const id = await rpc<number>('copy', action.model!, { id: resolution.recordId }); navigate(`/odoo/${resolution.slug}/${id}`); }}><i className="fa fa-clone me-2 text-muted" />{t('Duplicate')}</button>
      {fields.active && (
        <button type="button" className="o_dropdown_item" onClick={async () => {
          const [row] = await rpc<{ active: boolean }[]>('read', action.model!, { ids: [resolution.recordId], fields: ['active'] });
          await rpc('write', action.model!, { ids: [resolution.recordId], values: { active: !row?.active } });
          ui.notify({ type: 'success', message: row?.active ? { en: 'Record archived.', ar: 'تمت أرشفة السجل.' } : { en: 'Record unarchived.', ar: 'تم إلغاء أرشفة السجل.' },
            action: { label: { en: 'Undo', ar: 'تراجع' }, onClick: async () => { await rpc('write', action.model!, { ids: [resolution.recordId], values: { active: Boolean(row?.active) } }); reloadPage(); } } });
          reloadPage();
        }}><i className="fa fa-archive me-2 text-muted" />{t('Archive')} / {t('Unarchive')}</button>
      )}
      <div className="o_dropdown_divider" />
      <button type="button" className="o_dropdown_item text-danger" onClick={async () => {
        if (!(await ui.confirm({ message: { en: 'Are you sure you want to delete this record?', ar: 'هل أنت متأكد من حذف هذا السجل؟' }, confirmLabel: { en: 'Delete', ar: 'حذف' } }))) return;
        await rpc('unlink', action.model!, { ids: [resolution.recordId] });
        const next = pagerIds.filter((id) => id !== resolution.recordId);
        rememberPage(next);
        navigate(next[pagerIndex] ? `/odoo/${resolution.slug}/${next[pagerIndex]}` : `/odoo/${resolution.slug}`);
      }}><i className="fa fa-trash-o me-2" />{t('Delete')}</button>
    </Dropdown>
  ) : null;

  const displayFacets = activeFavorite
    ? [{ id: `favorite:${activeFavorite}`, kind: 'favorite' as const, label: favorites.find((f) => f.id === activeFavorite)?.name ?? '', values: [favorites.find((f) => f.id === activeFavorite)?.name ?? ''] }]
    : facets;

  return (
    <CurrencyProvider>
      <div className="o_control_panel">
        <div className="o_control_panel_main">
          <div className="o_control_panel_breadcrumbs">
            {!isForm && action.type === 'act_window' && views.form && (
              <button type="button" className="btn btn-primary" onClick={createRecord} accessKey="c">{t('New')}</button>
            )}
            {isForm && views.form && !isSettings && <button type="button" className="btn btn-outline-primary" onClick={createRecord}>{t('New')}</button>}
            <div className="o_breadcrumb">
              {isForm && !isSettings ? (
                <>
                  <Link href={`/odoo/${resolution.slug}`}>{t(action.name)}</Link>
                  <span className="o_breadcrumb_sep">/</span>
                  <span className="active" id="o_breadcrumb_current">{resolution.isNew ? t('New') : '…'}</span>
                </>
              ) : <span className="active">{t(action.name)}</span>}
            </div>
            {isForm && !isSettings && formMenu}
            {!isForm && headerButtons.map((button, index) => (
              <button key={index} type="button" className={`btn ${/btn-primary/.test(button.class ?? '') ? 'btn-primary' : 'btn-secondary'}`} onClick={() => runHeaderButton(button)}>{t(button.string)}</button>
            ))}
            {!isForm && selected.length > 0 && action.model && view?.arch.type === 'list' && (
              <ListActions model={action.model} fields={fields} selected={selected} allMatching={allMatching} domain={domain} columns={listFieldNames(view.arch)} onDone={refresh} reports={reports} onPrint={(reportName, ids) => openReport(reportName, ids)} />
            )}
          </div>
          {!isForm && search && (
            <div className="o_cp_searchview">
              <SearchBox facets={displayFacets} query={query} onQuery={setQuery} onSubmit={addText}
                onRemove={(facet) => (facet.kind === 'favorite' ? (setActiveFavorite(null), setState(EMPTY_STATE)) : removeFacet(facet))}
                search={search} state={state} onToggleFilter={toggleFilter} onTogglePeriod={togglePeriod} onToggleGroupBy={toggleGroupBy}
                favorites={favorites} activeFavorite={activeFavorite} onSaveFavorite={saveFavorite} onApplyFavorite={applyFavorite} onDeleteFavorite={deleteFavorite}
                periods={periodOptions(today, lang)} />
            </div>
          )}
          {isForm && pagerIndex >= 0 && pagerIds.length > 1 && (
            <div className="o_cp_pager">
              <span className="o_pager_value">{pagerIndex + 1} / {pagerIds.length}</span>
              <button type="button" className="o_pager_button" disabled={pagerIndex === 0} onClick={() => navigate(`/odoo/${resolution.slug}/${pagerIds[pagerIndex - 1]}`)} aria-label="Previous"><i className="fa fa-chevron-left" /></button>
              <button type="button" className="o_pager_button" disabled={pagerIndex >= pagerIds.length - 1} onClick={() => navigate(`/odoo/${resolution.slug}/${pagerIds[pagerIndex + 1]}`)} aria-label="Next"><i className="fa fa-chevron-right" /></button>
            </div>
          )}
          {!isForm && (
            <div className="o_cp_pager">
              {total !== null && total > 0 && (
                <>
                  <span className="o_pager_value">{offset + 1}-{Math.min(offset + limit, total)} / {total}</span>
                  <button type="button" className="o_pager_button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))} aria-label="Previous"><i className="fa fa-chevron-left" /></button>
                  <button type="button" className="o_pager_button" disabled={offset + limit >= total} onClick={() => setOffset(offset + limit)} aria-label="Next"><i className="fa fa-chevron-right" /></button>
                </>
              )}
              {switcher.length > 1 && (
                <div className="o_cp_switch_buttons ms-2">
                  {switcher.map((type) => (
                    <button key={type} type="button" className={`o_switch_view ${type === resolution.viewType ? 'active' : ''}`} title={type} onClick={() => goTo(type)}><i className={VIEW_ICONS[type]} /></button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="o_view_container">
        {!view ? <UnsupportedView type={resolution.viewType} />
          : view.arch.type === 'list' ? (
            <ListView key={JSON.stringify([domain, groupBy, offset, reload])} arch={view.arch} fields={fields} model={action.model!} domain={domain} groupBy={groupBy} offset={offset} limit={limit} onTotal={setTotal} onOpen={openRecord}
              onSelect={(ids, all) => { setSelected(ids); setAllMatching(all); }} onRecords={rememberPage} onHover={prefetch} user={user} context={actionContext} help={action.help} />
          ) : view.arch.type === 'kanban' ? (
            <KanbanView key={JSON.stringify([domain, groupBy, offset, reload])} arch={view.arch} fields={fields} model={action.model!} domain={domain} groupBy={groupBy} offset={offset} limit={limit} onTotal={setTotal} onOpen={openRecord} onHover={prefetch} user={user} context={actionContext} help={action.help} />
          ) : view.arch.type === 'form' ? (
            <FormView arch={view.arch} fields={fields} relatedFields={resolution.relatedFields} model={action.model!} recordId={resolution.recordId} context={actionContext} user={user} slug={resolution.slug} />
          ) : view.arch.type === 'pivot' ? (
            <PivotView key={reload} arch={view.arch} fields={fields} model={action.model!} domain={domain} groupBy={groupBy} context={actionContext} onDrill={drill} />
          ) : view.arch.type === 'graph' ? (
            <GraphView key={reload} arch={view.arch} fields={fields} model={action.model!} domain={domain} groupBy={groupBy} context={actionContext} onDrill={drill} />
          ) : view.arch.type === 'calendar' ? (
            <CalendarView key={reload} arch={view.arch} fields={fields} model={action.model!} domain={domain} context={actionContext} onOpen={openRecord}
              onCreate={(defaults) => navigate(`/odoo/${resolution.slug}/new?defaults=${encodeURIComponent(JSON.stringify(defaults))}`)} />
          ) : view.arch.type === 'activity' ? (
            <ActivityView key={JSON.stringify([domain, offset, reload])} arch={view.arch} fields={fields} model={action.model!} domain={domain} context={actionContext} offset={offset} limit={limit} onTotal={setTotal} onOpen={openRecord} />
          ) : <UnsupportedView type={view.arch.type} />}
      </div>
    </CurrencyProvider>
  );
}

interface SearchBoxProps {
  facets: Facet[]; query: string; onQuery: (value: string) => void; onSubmit: (value: string) => void; onRemove: (facet: Facet) => void;
  search: SearchArch; state: SearchState;
  onToggleFilter: (filter: SearchFilter) => void; onTogglePeriod: (filter: SearchFilter, key: string) => void; onToggleGroupBy: (group: SearchGroupBy) => void;
  favorites: Favorite[]; activeFavorite: number | null; onSaveFavorite: () => void; onApplyFavorite: (favorite: Favorite) => void; onDeleteFavorite: (favorite: Favorite) => void;
  periods: ReturnType<typeof periodOptions>;
}

function SearchBox(props: SearchBoxProps) {
  const { facets, query, onQuery, onSubmit, onRemove, search, state, onToggleFilter, onTogglePeriod, onToggleGroupBy, favorites, activeFavorite, onSaveFavorite, onApplyFavorite, onDeleteFavorite, periods } = props;
  const t = useT();
  const [openDate, setOpenDate] = useState<string | null>(null);
  const filters = search.filters.filter((item) => !('separator' in item) && item.invisible !== true) as SearchFilter[];
  const groupbys = search.groupbys.filter((item) => item.invisible !== true);
  const facetIcon = (facet: Facet) => (facet.kind === 'filter' || facet.kind === 'date' ? 'fa-filter' : facet.kind === 'groupby' ? 'fa-bars' : facet.kind === 'favorite' ? 'fa-star' : 'fa-search');

  return (
    <Dropdown className="w-100" toggle={() => (
      <div className="o_searchview" role="search">
        <i className="fa fa-search text-muted" aria-hidden="true" />
        {facets.map((facet) => (
          <span key={facet.id} className="o_searchview_facet">
            <span className="o_facet_label"><i className={`fa ${facetIcon(facet)}`} /></span>
            <span className="o_facet_values">{facet.kind === 'field' ? `${t(facet.label)}: ` : facet.kind === 'date' ? `${t(facet.label)}: ` : ''}{facet.values.map((value) => t(value)).join(` ${t('or')} `)}</span>
            <button type="button" className="o_facet_remove" onClick={(event) => { event.stopPropagation(); onRemove(facet); }} aria-label="Remove">×</button>
          </span>
        ))}
        <input className="o_searchview_input" placeholder={t('Search...')} value={query} onChange={(event) => onQuery(event.target.value)}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); onSubmit(query); }
            if (event.key === 'Backspace' && !query && facets.length) onRemove(facets[facets.length - 1]);
          }} />
        <i className="fa fa-caret-down text-muted" aria-hidden="true" />
      </div>
    )}>
      <div className="d-flex gap-4 p-3" style={{ minWidth: 640 }} onClick={(event) => event.stopPropagation()}>
        <div style={{ flex: 1 }}>
          <div className="o_dropdown_header"><i className="fa fa-filter me-1" />{t('Filters')}</div>
          {search.filters.map((item, index) => {
            if ('separator' in item) return <div key={`sep-${index}`} className="o_dropdown_divider" />;
            if (item.invisible === true) return null;
            const filter = item;
            if (filter.date) {
              const keys = state.dates[filter.name] ?? [];
              return (
                <div key={filter.name}>
                  <button type="button" className="o_dropdown_item d-flex justify-content-between" onClick={() => setOpenDate(openDate === filter.name ? null : filter.name)}>
                    <span><span style={{ display: 'inline-block', width: 16 }}>{keys.length ? '✓' : ''}</span>{t(filter.string ?? filter.name)}</span>
                    <i className={`fa ${openDate === filter.name ? 'fa-caret-down' : 'fa-caret-right'} text-muted`} />
                  </button>
                  {openDate === filter.name && (
                    <div className="ps-4">
                      {(['month', 'quarter', 'year'] as const).map((group) => (
                        <div key={group}>
                          {group !== 'month' && <div className="o_dropdown_divider" />}
                          {periods.filter((period) => period.group === group).map((period) => (
                            <button key={period.key} type="button" className="o_dropdown_item" onClick={() => onTogglePeriod(filter, period.key)}>
                              <span style={{ display: 'inline-block', width: 16 }}>{keys.includes(period.key) ? '✓' : ''}</span>{period.label}
                            </button>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            }
            return (
              <button key={filter.name} type="button" className="o_dropdown_item" onClick={() => onToggleFilter(filter)}>
                <span style={{ display: 'inline-block', width: 16 }}>{state.filters.includes(filter.name) ? '✓' : ''}</span>{t(filter.string ?? filter.name)}
              </button>
            );
          })}
          {filters.length === 0 && <div className="o_dropdown_item text-muted">{t('No filters')}</div>}
        </div>
        <div style={{ flex: 1 }}>
          <div className="o_dropdown_header"><i className="fa fa-bars me-1" />{t('Group By')}</div>
          {groupbys.map((group) => (
            <button key={group.name} type="button" className="o_dropdown_item" onClick={() => onToggleGroupBy(group)}>
              <span style={{ display: 'inline-block', width: 16 }}>{state.groupbys.includes(group.name) ? '✓' : ''}</span>{t(group.string ?? group.name)}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }}>
          <div className="o_dropdown_header"><i className="fa fa-star me-1" />{t('Favorites')}</div>
          {favorites.map((favorite) => (
            <div key={favorite.id} className="d-flex align-items-center">
              <button type="button" className="o_dropdown_item flex-grow-1" onClick={() => onApplyFavorite(favorite)}>
                <span style={{ display: 'inline-block', width: 16 }}>{activeFavorite === favorite.id ? '✓' : ''}</span>{favorite.name}{favorite.shared && <i className="fa fa-users text-muted ms-1 small" />}
              </button>
              <button type="button" className="btn btn-link btn-sm text-muted" onClick={() => onDeleteFavorite(favorite)} aria-label={t('Delete')}><i className="fa fa-trash-o" /></button>
            </div>
          ))}
          <div className="o_dropdown_divider" />
          <button type="button" className="o_dropdown_item" onClick={onSaveFavorite}>{t('Save current search')}</button>
        </div>
      </div>
    </Dropdown>
  );
}
