'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ViewType } from '@engine/registry/types';
import type { Resolution, ResolvedAction } from '@/lib/server/actions';
import { rpc } from './rpc';

/**
 * Client-side routing for the web client. The server renders the first
 * page; after that every `/odoo/…` move is a `pushState` plus a state
 * change here, so switching list → form → next record never re-renders
 * the page on the server. Action descriptions (views, fields — ~230 KB
 * for Sales) are fetched once per action and cached for the session.
 */

export interface Location {
  path: string[];
  query: Record<string, string>;
  /**
   * The app (root menu id) the move was made from — a navbar or home-menu
   * click. Not part of the URL: it tells the shell which app's sections to
   * keep showing when the action is reachable from several apps.
   */
  app?: number;
}

interface Navigation {
  location: Location;
  /** `app: null` lets the target action choose the app (a URL action opening another app's page). */
  navigate: (href: string, options?: { replace?: boolean; app?: number | null }) => void;
  /** Re-resolve the current location (what `router.refresh()` used to do). */
  reload: () => void;
  version: number;
}

const NavigationContext = createContext<Navigation | null>(null);

/** Session-storage key of the app the shell currently shows (written by the shell). */
export const CURRENT_APP_KEY = 'rodeo.current_app';

/**
 * The app to keep for a move that names none: the one the shell shows now.
 * Odoo keeps the current menu when an action opens a record, runs a server
 * action or follows a smart button; only a navbar / home-menu click, the
 * command palette or a fresh URL choose the app.
 */
export function currentAppHint(): number | undefined {
  try { return Number(sessionStorage.getItem(CURRENT_APP_KEY)) || undefined; } catch { return undefined; }
}

export function parseHref(href: string): Location {
  const url = new URL(href, typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
  const path = url.pathname.replace(/^\/odoo\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => { query[key] = value; });
  return { path, query };
}

export function hrefOf(location: Location): string {
  const search = new URLSearchParams(location.query).toString();
  return `/odoo/${location.path.map(encodeURIComponent).join('/')}${search ? `?${search}` : ''}`;
}

export function NavigationProvider({ initial, children }: { initial: Location; children: ReactNode }) {
  const [location, setLocation] = useState<Location>(initial);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const onPop = (event: PopStateEvent) => {
      const app = Number((event.state as { app?: number } | null)?.app);
      setLocation({ ...parseHref(window.location.href), ...(app ? { app } : {}) });
    };
    window.addEventListener('popstate', onPop);
    // Any in-app link to /odoo/… becomes a client-side move. The web client
    // uses plain anchors, not next/link: a Next navigation re-renders the page
    // on the server and remounts the shell (the dynamic segment changes), which
    // would drop the current app and every in-memory state on each menu click.
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null;
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const href = anchor.getAttribute('href') ?? '';
      if (!href.startsWith('/odoo')) return;
      event.preventDefault();
      const app = Number(anchor.dataset.app) || currentAppHint();
      window.history.pushState(app ? { app } : null, '', href);
      setLocation({ ...parseHref(href), ...(app ? { app } : {}) });
    };
    document.addEventListener('click', onClick);
    return () => { window.removeEventListener('popstate', onPop); document.removeEventListener('click', onClick); };
  }, []);

  const navigate = useCallback((href: string, options: { replace?: boolean; app?: number | null } = {}) => {
    const app = options.app === null ? undefined : options.app ?? currentAppHint();
    if (options.app === null) { try { sessionStorage.removeItem(CURRENT_APP_KEY); } catch { /* private mode */ } }
    const next: Location = { ...parseHref(href), ...(app ? { app } : {}) };
    const state = app ? { app } : null;
    if (options.replace) window.history.replaceState(state, '', href); else window.history.pushState(state, '', href);
    setLocation(next);
  }, []);
  const reload = useCallback(() => setVersion((n) => n + 1), []);

  const value = useMemo(() => ({ location, navigate, reload, version }), [location, navigate, reload, version]);
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useNavigation(): Navigation {
  const context = useContext(NavigationContext);
  if (!context) throw new Error('useNavigation outside NavigationProvider');
  return context;
}

/* ------------------------------------------------------------------ *
 * Action resolution with a per-session cache
 * ------------------------------------------------------------------ */

type Described = Omit<ResolvedAction, 'recordId' | 'isNew' | 'viewType'>;
const described = new Map<string, Described>();
const pending = new Map<string, Promise<Resolution>>();

/** Seed the cache with the server-rendered first resolution. */
export function seedResolution(resolution: Resolution): void {
  if (resolution.kind === 'action') described.set(resolution.slug, stripState(resolution));
}

function stripState(resolution: ResolvedAction): Described {
  const { recordId, isNew, viewType, ...rest } = resolution;
  void recordId; void isNew; void viewType;
  return rest;
}

/** Slug of a path (`sales`, `action-66`, `m/res.partner`). */
function slugOf(path: string[]): { slug: string; rest: string[] } {
  if (path[0] === 'm' && path[1]) return { slug: `m/${path[1]}`, rest: path.slice(2) };
  return { slug: path[0] ?? '', rest: path.slice(1) };
}

/** Record / view state from the path, given a cached description. */
function withState(base: Described, rest: string[], query: Record<string, string>): ResolvedAction {
  let recordId: number | null = null;
  let isNew = false;
  if (rest[0] === 'new') isNew = true;
  else if (rest[0] && /^\d+$/.test(rest[0])) recordId = Number(rest[0]);
  const requested = query.view_type as ViewType | undefined;
  const viewMode = base.action.viewMode ?? ['list', 'form'];
  let viewType: ViewType = recordId || isNew ? 'form' : requested && base.views[requested] ? requested : viewMode[0];
  if (!base.views[viewType] && viewMode.length) viewType = viewMode[0];
  return { ...base, recordId, isNew, viewType };
}

/** Resolve a location: cached description + local state, or one RPC the first time. */
export async function resolveLocation(location: Location): Promise<Resolution> {
  if (location.path.length === 0) return { kind: 'home' };
  const { slug, rest } = slugOf(location.path);
  const cached = described.get(slug);
  if (cached) return { kind: 'action', ...withState(cached, rest, location.query) };
  let request = pending.get(slug);
  if (!request) {
    request = rpc<Resolution>('resolvePath', null, { path: location.path, query: location.query }, { silent: true }).finally(() => pending.delete(slug));
    pending.set(slug, request);
  }
  const resolution = await request;
  if (resolution.kind === 'action') { described.set(resolution.slug, stripState(resolution)); return { kind: 'action', ...withState(described.get(resolution.slug)!, rest, location.query) }; }
  return resolution;
}

/** Forget cached descriptions (after a language switch, for instance). */
export function clearResolutions(): void {
  described.clear();
}
