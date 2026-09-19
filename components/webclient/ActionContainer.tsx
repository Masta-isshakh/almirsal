'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SearchArch, SearchFilter, SearchGroupBy } from '@engine/registry/arch';
import type { Domain, ViewType } from '@engine/registry/types';
import type { I18n } from '@engine/i18n/types';
import { evaluate, makeScope } from '@engine/expr/evaluate';
import { PyDateTime } from '@engine/expr/pydate';
import type { ResolvedAction } from '@/lib/server/actions';
import { useT } from '@/lib/client/i18n';
import { CurrencyProvider } from '@/lib/client/display';
import { Dropdown } from './Navbar';
import type { SessionInfo } from './WebClient';
import { ListView } from '../views/ListView';
import { KanbanView } from '../views/KanbanView';
import { FormView } from '../views/FormView';
import { UnsupportedView } from '../views/UnsupportedView';

/**
 * The action manager for one act_window action: control panel (primary
 * button, breadcrumb, search view, pager, view switcher) over the current
 * view. Search state is a list of facets exactly as Odoo renders them.
 */

export interface Facet {
  id: string;
  kind: 'filter' | 'groupby' | 'field';
  label: I18n | string;
  values: (I18n | string)[];
  domain?: Domain;
  groupBy?: string;
}

const VIEW_ICONS: Record<ViewType, string> = {
  list: 'oi oi-view-list fa fa-list-ul', kanban: 'fa fa-th-large', form: 'fa fa-file-text-o', calendar: 'fa fa-calendar',
  pivot: 'fa fa-table', graph: 'fa fa-bar-chart', gantt: 'fa fa-tasks', activity: 'fa fa-clock-o', map: 'fa fa-map-marker',
  cohort: 'fa fa-signal', grid: 'fa fa-th', hierarchy: 'fa fa-sitemap', search: 'fa fa-search',
};

function evalScope(user: SessionInfo, context: Record<string, unknown>) {
  return makeScope({ uid: user.uid, allowedCompanyIds: user.companyIds, context, now: PyDateTime.fromJsUtc(new Date()), strictNames: false });
}

function safeEval(source: string | undefined | false, user: SessionInfo, context: Record<string, unknown> = {}): unknown {
  if (!source) return undefined;
  try { return evaluate(source, evalScope(user, context)); } catch { return undefined; }
}

export function ActionContainer({ resolution, user }: { resolution: ResolvedAction; user: SessionInfo }) {
  const t = useT();
  const router = useRouter();
  const { action, views, searchView, fields } = resolution;
  const search = searchView?.arch.type === 'search' ? (searchView.arch as SearchArch) : null;

  const actionContext = useMemo(() => (safeEval(action.context, user) as Record<string, unknown>) ?? {}, [action.context, user]);
  const actionDomain = useMemo(() => (safeEval(action.domain || undefined, user, actionContext) as Domain) ?? [], [action.domain, user, actionContext]);

  // Default facets from search_default_* context keys.
  const [facets, setFacets] = useState<Facet[]>(() => {
    const out: Facet[] = [];
    if (!search) return out;
    for (const [key, value] of Object.entries(actionContext)) {
      if (!key.startsWith('search_default_') || !value) continue;
      const name = key.slice('search_default_'.length);
      const filter = search.filters.find((item): item is SearchFilter => 'name' in item && item.name === name);
      if (filter?.domain) {
        out.push({ id: `filter:${name}`, kind: 'filter', label: filter.string ?? name, values: [filter.string ?? name], domain: safeEval(filter.domain, user, actionContext) as Domain });
        continue;
      }
      const group = search.groupbys.find((item) => item.name === name);
      if (group) out.push({ id: `groupby:${name}`, kind: 'groupby', label: group.string ?? name, values: [group.string ?? name], groupBy: groupByField(group) });
    }
    return out;
  });
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const limit = action.limit ?? 80;

  const domain = useMemo<Domain>(() => {
    const parts: Domain[] = [actionDomain];
    for (const facet of facets) if (facet.domain) parts.push(facet.domain);
    return parts.flatMap((part) => (part.length ? part : []));
  }, [actionDomain, facets]);

  const groupBy = useMemo(() => facets.filter((facet) => facet.groupBy).map((facet) => facet.groupBy!), [facets]);

  const toggleFilter = useCallback((filter: SearchFilter) => {
    setOffset(0);
    setFacets((list) => {
      const id = `filter:${filter.name}`;
      if (list.some((facet) => facet.id === id)) return list.filter((facet) => facet.id !== id);
      return [...list, { id, kind: 'filter', label: filter.string ?? filter.name, values: [filter.string ?? filter.name], domain: (safeEval(filter.domain, user, actionContext) as Domain) ?? [] }];
    });
  }, [user, actionContext]);

  const toggleGroupBy = useCallback((group: SearchGroupBy) => {
    setOffset(0);
    setFacets((list) => {
      const id = `groupby:${group.name}`;
      if (list.some((facet) => facet.id === id)) return list.filter((facet) => facet.id !== id);
      return [...list, { id, kind: 'groupby', label: group.string ?? group.name, values: [group.string ?? group.name], groupBy: groupByField(group) }];
    });
  }, []);

  const addTextFacet = useCallback((text: string) => {
    if (!text.trim() || !search) return;
    const field = search.fields[0];
    const recName = fields.name ? 'name' : 'display_name';
    let facetDomain: Domain;
    if (field?.filterDomain) {
      facetDomain = (safeEval(field.filterDomain, user, { ...actionContext, self: text }) as Domain) ?? [[recName, 'ilike', text]];
    } else {
      facetDomain = [[field?.name ?? recName, 'ilike', text]];
    }
    setOffset(0);
    setFacets((list) => [...list, { id: `field:${Date.now()}`, kind: 'field', label: field?.string ?? fields[field?.name ?? '']?.label ?? 'Search', values: [text], domain: facetDomain }]);
    setQuery('');
  }, [search, fields, user, actionContext]);

  const removeFacet = (id: string) => { setOffset(0); setFacets((list) => list.filter((facet) => facet.id !== id)); };

  const goTo = (viewType: ViewType) => router.push(`/odoo/${resolution.slug}?view_type=${viewType}`);
  const openRecord = (id: number) => router.push(`/odoo/${resolution.slug}/${id}`);
  const createRecord = () => router.push(`/odoo/${resolution.slug}/new`);

  const isForm = resolution.viewType === 'form';
  const view = views[resolution.viewType];
  const switcher = (action.viewMode ?? []).filter((type) => type !== 'form' && views[type]);

  return (
    <CurrencyProvider>
      <div className="o_control_panel">
        <div className="o_control_panel_main">
          <div className="o_control_panel_breadcrumbs">
            {!isForm && action.type === 'act_window' && views.form && (
              <button type="button" className="btn btn-primary" onClick={createRecord} accessKey="c">{t('New')}</button>
            )}
            {isForm && views.form && (
              <button type="button" className="btn btn-outline-primary" onClick={createRecord}>{t('New')}</button>
            )}
            <div className="o_breadcrumb">
              {isForm ? (
                <>
                  <Link href={`/odoo/${resolution.slug}`}>{t(action.name)}</Link>
                  <span className="o_breadcrumb_sep">/</span>
                  <span className="active" id="o_breadcrumb_current">{resolution.isNew ? t('New') : '…'}</span>
                </>
              ) : (
                <span className="active">{t(action.name)}</span>
              )}
            </div>
          </div>
          {!isForm && search && (
            <div className="o_cp_searchview">
              <SearchBox facets={facets} query={query} onQuery={setQuery} onSubmit={addTextFacet} onRemove={removeFacet} search={search} onToggleFilter={toggleFilter} onToggleGroupBy={toggleGroupBy} />
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
                    <button key={type} type="button" className={`o_switch_view ${type === resolution.viewType ? 'active' : ''}`} title={type} onClick={() => goTo(type)}>
                      <i className={VIEW_ICONS[type]} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="o_view_container">
        {!view ? (
          <UnsupportedView type={resolution.viewType} />
        ) : view.arch.type === 'list' ? (
          <ListView key={JSON.stringify([domain, groupBy, offset])} arch={view.arch} fields={fields} model={action.model!} domain={domain} groupBy={groupBy} offset={offset} limit={limit} onTotal={setTotal} onOpen={openRecord} user={user} context={actionContext} help={action.help} />
        ) : view.arch.type === 'kanban' ? (
          <KanbanView key={JSON.stringify([domain, groupBy, offset])} arch={view.arch} fields={fields} model={action.model!} domain={domain} groupBy={groupBy} offset={offset} limit={limit} onTotal={setTotal} onOpen={openRecord} user={user} context={actionContext} help={action.help} />
        ) : view.arch.type === 'form' ? (
          <FormView arch={view.arch} fields={fields} model={action.model!} recordId={resolution.recordId} context={actionContext} user={user} slug={resolution.slug} views={views} />
        ) : (
          <UnsupportedView type={view.arch.type} />
        )}
      </div>
    </CurrencyProvider>
  );
}

function groupByField(group: SearchGroupBy): string {
  const match = /'group_by'\s*:\s*'([^']+)'/.exec(group.context);
  return match ? match[1] : group.name;
}

function SearchBox({ facets, query, onQuery, onSubmit, onRemove, search, onToggleFilter, onToggleGroupBy }: {
  facets: Facet[]; query: string; onQuery: (value: string) => void; onSubmit: (value: string) => void; onRemove: (id: string) => void;
  search: SearchArch; onToggleFilter: (filter: SearchFilter) => void; onToggleGroupBy: (group: SearchGroupBy) => void;
}) {
  const t = useT();
  const activeIds = new Set(facets.map((facet) => facet.id));
  const filters = search.filters.filter((item) => !('separator' in item) && item.invisible !== true) as SearchFilter[];
  const groupbys = search.groupbys.filter((item) => item.invisible !== true);
  return (
    <Dropdown className="w-100" toggle={() => (
      <div className="o_searchview" role="search">
        <i className="fa fa-search text-muted" aria-hidden="true" />
        {facets.map((facet) => (
          <span key={facet.id} className="o_searchview_facet">
            <span className="o_facet_label"><i className={`fa ${facet.kind === 'filter' ? 'fa-filter' : facet.kind === 'groupby' ? 'fa-bars' : 'fa-search'}`} /></span>
            <span className="o_facet_values">{facet.kind === 'field' ? `${t(facet.label)}: ` : ''}{facet.values.map((value) => t(value)).join(` ${t('or')} `)}</span>
            <button type="button" className="o_facet_remove" onClick={(event) => { event.stopPropagation(); onRemove(facet.id); }} aria-label="Remove">×</button>
          </span>
        ))}
        <input className="o_searchview_input" placeholder={t('Search...')} value={query} onChange={(event) => onQuery(event.target.value)}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); onSubmit(query); }
            if (event.key === 'Backspace' && !query && facets.length) onRemove(facets[facets.length - 1].id);
          }} />
        <i className="fa fa-caret-down text-muted" aria-hidden="true" />
      </div>
    )}>
      <div className="d-flex gap-4 p-3" style={{ minWidth: 520 }} onClick={(event) => event.stopPropagation()}>
        <div style={{ flex: 1 }}>
          <div className="o_dropdown_header"><i className="fa fa-filter me-1" />{t('Filters')}</div>
          {filters.filter((f) => !f.date).map((filter) => (
            <button key={filter.name} type="button" className="o_dropdown_item" onClick={() => onToggleFilter(filter)}>
              <span style={{ display: 'inline-block', width: 16 }}>{activeIds.has(`filter:${filter.name}`) ? '✓' : ''}</span>{t(filter.string ?? filter.name)}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }}>
          <div className="o_dropdown_header"><i className="fa fa-bars me-1" />{t('Group By')}</div>
          {groupbys.map((group) => (
            <button key={group.name} type="button" className="o_dropdown_item" onClick={() => onToggleGroupBy(group)}>
              <span style={{ display: 'inline-block', width: 16 }}>{activeIds.has(`groupby:${group.name}`) ? '✓' : ''}</span>{t(group.string ?? group.name)}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }}>
          <div className="o_dropdown_header"><i className="fa fa-star me-1" />{t('Favorites')}</div>
          <button type="button" className="o_dropdown_item text-muted" disabled>{t('Save current search')}</button>
        </div>
      </div>
    </Dropdown>
  );
}
