import type { ActionDef, FieldDef, MenuDef, ViewDef, ViewType } from '@engine/registry/types';
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

export function resolvePath(segments: string[], searchParams: Record<string, string | string[] | undefined>): Resolution {
  if (segments.length === 0) return { kind: 'home' };

  const action = findAction(segments[0]);
  if (!action) return { kind: 'notfound', path: segments.join('/') };

  const bound = menuForAction(action.id);
  const { views, searchView } = viewsForAction(action);
  const registry = getRegistry();

  let recordId: number | null = null;
  let isNew = false;
  if (segments[1] === 'new') isNew = true;
  else if (segments[1] && /^\d+$/.test(segments[1])) recordId = Number(segments[1]);

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
    slug: actionSlug(action),
  };
}

export { ROOT_SLUGS };
