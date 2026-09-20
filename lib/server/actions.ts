import type { ActionDef, FieldDef, MenuDef, ViewDef, ViewType } from '@engine/registry/types';
import type { FormNode } from '@engine/registry/arch';
import { getRegistry } from './registry';

/**
 * URL → action resolution (C-4):
 *
 *   /odoo                      home menu
 *   /odoo/<path>               action by slug (`sales`, `orders`, `discuss`)
 *   /odoo/action-<id>          action by id
 *   /odoo/<path>/<id>          record form
 *   /odoo/<path>/new           new record form
 *   ?view_type=kanban          view switcher
 *
 * The app (root menu) is inferred from the first menu bound to the action,
 * so the navbar shows that app's sections — Odoo 17+ does the same.
 */

export interface ResolvedAction {
  action: ActionDef;
  /** Root menu (the app) this action belongs to, if any. */
  app: MenuDef | null;
  /** The menu item that points at this action, if any. */
  menu: MenuDef | null;
  recordId: number | null;
  isNew: boolean;
  viewType: ViewType;
  views: Partial<Record<ViewType, ViewDef>>;
  searchView: ViewDef | null;
  fields: Record<string, FieldDef>;
  /** Field definitions of the comodels shown in embedded x2many views. */
  relatedFields: Record<string, Record<string, FieldDef>>;
  /** Public URL slug for this action. */
  slug: string;
}

export type Resolution = { kind: 'home' } | { kind: 'notfound'; path: string } | ({ kind: 'action' } & ResolvedAction);

const ROOT_SLUGS: Record<string, string> = {};

export function actionSlug(action: ActionDef): string {
  return action.path || `action-${action.id}`;
}

function findAction(segment: string): ActionDef | undefined {
  const registry = getRegistry();
  const byId = /^action-(\d+)$/.exec(segment);
  if (byId) return registry.actions[byId[1]];
  return Object.values(registry.actions).find((action) => action.path === segment);
}

/** Depth-first search for the first menu bound to an action. */
export function menuForAction(actionId: number | string): { menu: MenuDef; app: MenuDef } | null {
  const registry = getRegistry();
  const walk = (menu: MenuDef, app: MenuDef): { menu: MenuDef; app: MenuDef } | null => {
    if (menu.actionId !== undefined && String(menu.actionId) === String(actionId)) return { menu, app };
    for (const child of menu.children) {
      const found = walk(child, app);
      if (found) return found;
    }
    return null;
  };
  for (const root of registry.menus) {
    const found = walk(root, root);
    if (found) return found;
  }
  return null;
}

/** First action reachable from a menu (itself or its first descendant). */
export function firstActionOf(menu: MenuDef): ActionDef | null {
  const registry = getRegistry();
  if (menu.actionId !== undefined && registry.actions[String(menu.actionId)]) return registry.actions[String(menu.actionId)];
  for (const child of menu.children) {
    const found = firstActionOf(child);
    if (found) return found;
  }
  return null;
}

export function menuHref(menu: MenuDef): string {
  const action = firstActionOf(menu);
  return action ? `/odoo/${actionSlug(action)}` : '/odoo';
}

/** Comodels referenced by x2many fields of the model's views, with their fields. */
export function relatedFieldsFor(model: string, views: Partial<Record<ViewType, ViewDef>>): Record<string, Record<string, FieldDef>> {
  const registry = getRegistry();
  const def = registry.models[model];
  const out: Record<string, Record<string, FieldDef>> = {};
  if (!def) return out;
  const visit = (nodes: FormNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'field') {
        const field = def.fields[node.name];
        if (field && (field.type === 'one2many' || field.type === 'many2many') && field.relation && registry.models[field.relation]) {
          out[field.relation] = registry.models[field.relation].fields;
        }
      }
      if ('children' in node) visit(node.children);
      if (node.kind === 'notebook') visit(node.pages);
    }
  };
  for (const view of Object.values(views)) {
    if (view?.arch.type === 'form') visit(view.arch.body);
    if (view?.arch.type === 'list') visit(view.arch.columns);
  }
  return out;
}

/**
 * Best registry action for opening records of a model when a method returns
 * an ad-hoc `act_window` (no action id): prefer one with a URL slug whose
 * context matches (e.g. `default_move_type`).
 */
export function findActionForModel(model: string, context: Record<string, unknown> = {}): ActionDef | null {
  const registry = getRegistry();
  const candidates = Object.values(registry.actions).filter((action) => action.type === 'act_window' && action.model === model);
  if (candidates.length === 0) return null;
  const score = (action: ActionDef): number => {
    let points = action.path ? 10 : 0;
    if (action.target === 'current') points += 2;
    for (const [key, value] of Object.entries(context)) {
      if (key.startsWith('default_') && action.context?.includes(`'${key}': '${String(value)}'`)) points += 5;
    }
    if (!action.secondary) points += 1;
    return points;
  };
  return [...candidates].sort((a, b) => score(b) - score(a))[0];
}

export function viewsForAction(action: ActionDef): { views: Partial<Record<ViewType, ViewDef>>; searchView: ViewDef | null } {
  const registry = getRegistry();
  const views: Partial<Record<ViewType, ViewDef>> = {};
  for (const key of action.views ?? []) {
    const view = registry.views[key];
    if (view) views[view.type] = view;
  }
  // View modes without an explicit binding fall back to the model's default view of that type.
  for (const type of action.viewMode ?? []) {
    if (!views[type]) {
      const fallback = Object.values(registry.views).find((view) => view.model === action.model && view.type === type);
      if (fallback) views[type] = fallback;
    }
  }
  const searchView = (action.searchView && registry.views[action.searchView])
    || Object.values(registry.views).find((view) => view.model === action.model && view.type === 'search')
    || null;
  return { views, searchView };
}

/** Synthetic action for a model that no registry action exposes at a URL. */
function syntheticAction(model: string): ActionDef | undefined {
  const registry = getRegistry();
  const def = registry.models[model];
  if (!def) return undefined;
  return {
    id: `m:${model}`, xmlId: `synthetic.${model}`, type: 'act_window', name: def.description, model,
    viewMode: ['list', 'form'], views: [], domain: false, context: '{}', target: 'current', path: `m/${model}`,
  };
}

export function resolvePath(segments: string[], searchParams: Record<string, string | string[] | undefined>): Resolution {
  if (segments.length === 0) return { kind: 'home' };

  let rest = segments.slice(1);
  let action = findAction(segments[0]);
  if (!action && segments[0] === 'm' && segments[1]) {
    action = syntheticAction(segments[1]);
    rest = segments.slice(2);
  }
  if (!action) return { kind: 'notfound', path: segments.join('/') };
  const segmentsAfter = rest;

  const bound = menuForAction(action.id);
  const { views, searchView } = viewsForAction(action);
  const registry = getRegistry();

  let recordId: number | null = null;
  let isNew = false;
  if (segmentsAfter[0] === 'new') isNew = true;
  else if (segmentsAfter[0] && /^\d+$/.test(segmentsAfter[0])) recordId = Number(segmentsAfter[0]);

  const requested = typeof searchParams.view_type === 'string' ? (searchParams.view_type as ViewType) : undefined;
  const viewMode = action.viewMode ?? ['list', 'form'];
  let viewType: ViewType = (recordId || isNew) ? 'form' : (requested && views[requested] ? requested : viewMode[0]);
  if (!views[viewType] && viewMode.length) viewType = viewMode[0];

  return {
    kind: 'action',
    action,
    app: bound?.app ?? null,
    menu: bound?.menu ?? null,
    recordId,
    isNew,
    viewType,
    views,
    searchView,
    fields: action.model ? registry.models[action.model]?.fields ?? {} : {},
    relatedFields: action.model ? relatedFieldsFor(action.model, views) : {},
    slug: actionSlug(action),
  };
}

/** Everything the client needs to render an action in a dialog or page. */
export function describeAction(action: ActionDef) {
  const registry = getRegistry();
  const { views, searchView } = viewsForAction(action);
  return {
    action,
    views,
    searchView,
    fields: action.model ? registry.models[action.model]?.fields ?? {} : {},
    relatedFields: action.model ? relatedFieldsFor(action.model, views) : {},
    slug: actionSlug(action),
  };
}

/** Views for a model without a registry action (ad-hoc act_window results). */
export function describeModel(model: string, viewTypes: ViewType[]) {
  const registry = getRegistry();
  const views: Partial<Record<ViewType, ViewDef>> = {};
  for (const type of viewTypes) {
    const view = Object.values(registry.views).find((candidate) => candidate.model === model && candidate.type === type);
    if (view) views[type] = view;
  }
  const searchView = Object.values(registry.views).find((view) => view.model === model && view.type === 'search') ?? null;
  return { views, searchView, fields: registry.models[model]?.fields ?? {}, relatedFields: relatedFieldsFor(model, views) };
}

export { ROOT_SLUGS };
