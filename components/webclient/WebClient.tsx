'use client';

import { useEffect, useState } from 'react';
import type { I18n, Lang } from '@engine/i18n/types';
import type { MenuDef } from '@engine/registry/types';
import type { Resolution } from '@/lib/server/actions';
import { onRpcError, type RpcError } from '@/lib/client/rpc';
import { HomeMenu } from './HomeMenu';
import { Navbar } from './Navbar';
import { ActionContainer } from './ActionContainer';
import { DialogHost, NotificationHost, UiProvider, useUi } from './ui';
import { SessionProvider } from './session';
import { ActionRunnerProvider } from '@/lib/client/actions';
import { ThemeProvider } from './theme';
import { CommandPalette } from './CommandPalette';
import { NavigationProvider, parseHref, resolveLocation, seedResolution, useNavigation, type Location } from '@/lib/client/navigation';
import { ProgressBar } from './ProgressBar';
import { ShortcutsHelp } from './Shortcuts';

export interface AppEntry {
  id: number;
  xmlId: string;
  name: I18n;
  slug: string;
  href: string;
  children: MenuDef[];
}

export interface SessionInfo {
  uid: number;
  name: string;
  login: string;
  lang: Lang;
  companyIds: number[];
  /** Cognito client configuration (user pool, client id) when sign-in goes through Cognito. */
  authConfig?: Record<string, unknown> | null;
}

/**
 * The web client shell (A-4 §1): navbar + action manager, dialog stack and
 * toast notifications. Server-resolved props say what to render; data is
 * fetched through `/api/rpc`.
 */
export function WebClient({ user, apps, menuHrefs, resolution, href }: { user: SessionInfo; apps: AppEntry[]; menuHrefs: Record<number, string>; resolution: Resolution; href: string }) {
  // The server-rendered resolution seeds the client cache: the first page
  // paints without a round trip, later moves are client-side.
  seedResolution(resolution);
  return (
    <ThemeProvider>
      <UiProvider>
        <SessionProvider user={user}>
          <NavigationProvider initial={parseHref(href)}>
            <ActionRunnerProvider>
              <Shell user={user} apps={apps} menuHrefs={menuHrefs} initialResolution={resolution} />
            </ActionRunnerProvider>
          </NavigationProvider>
        </SessionProvider>
      </UiProvider>
    </ThemeProvider>
  );
}

/** Resolution of the current client location; the initial one comes from the server. */
function useResolution(initial: Resolution): { resolution: Resolution; resolving: boolean } {
  const { location, version } = useNavigation();
  const [state, setState] = useState<{ resolution: Resolution; key: string }>({ resolution: initial, key: keyOf(location) });
  const [resolving, setResolving] = useState(false);
  useEffect(() => {
    const key = keyOf(location);
    let cancelled = false;
    setResolving(true);
    resolveLocation(location).then((resolution) => { if (!cancelled) { setState({ resolution, key }); setResolving(false); } })
      .catch(() => { if (!cancelled) { setState({ resolution: { kind: 'notfound', path: location.path.join('/') }, key }); setResolving(false); } });
    return () => { cancelled = true; };
  }, [location, version]);
  return { resolution: state.resolution, resolving: resolving && state.key !== keyOf(location) };
}

function keyOf(location: Location): string {
  return `${location.path.join('/')}?${new URLSearchParams(location.query).toString()}`;
}

function Shell({ user, apps, menuHrefs, initialResolution }: { user: SessionInfo; apps: AppEntry[]; menuHrefs: Record<number, string>; initialResolution: Resolution }) {
  const ui = useUi();
  const { resolution, resolving } = useResolution(initialResolution);
  const { location, version } = useNavigation();
  const [homeOpen, setHomeOpen] = useState(resolution.kind === 'home');
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => setHomeOpen(resolution.kind === 'home'), [resolution]);

  // Every RPC error becomes an Odoo-style dialog (rule 5).
  useEffect(() => onRpcError((error: RpcError) => {
    if (error.payload.kind === 'session_expired') return;
    ui.showError(error.payload);
  }), [ui]);

  // Alt+H opens the home menu (C-1).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey && event.key.toLowerCase() === 'h') { event.preventDefault(); setHomeOpen(true); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setPaletteOpen((open) => !open); }
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement)?.tagName) || (event.target as HTMLElement)?.isContentEditable;
      if (event.key === '?' && !typing && !event.ctrlKey && !event.altKey) { event.preventDefault(); ui.openDialog({ title: { en: 'Keyboard Shortcuts', ar: 'اختصارات لوحة المفاتيح' }, size: 'sm', body: <ShortcutsHelp /> }); }
      if (event.key === 'Escape' && homeOpen && resolution.kind !== 'home') setHomeOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [homeOpen, resolution.kind, ui]);

  const currentApp = resolution.kind === 'action' && resolution.app
    ? apps.find((app) => app.id === resolution.app!.id) ?? null
    : null;

  return (
    <div className="o_web_client">
      <ProgressBar active={resolving} />
      <Navbar user={user} apps={apps} menuHrefs={menuHrefs} currentApp={homeOpen ? null : currentApp} onToggleHome={() => setHomeOpen((open) => !open)} homeOpen={homeOpen} onSearch={() => setPaletteOpen(true)} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} apps={apps} menuHrefs={menuHrefs}
        currentModel={resolution.kind === 'action' ? resolution.action.model ?? undefined : undefined} currentSlug={resolution.kind === 'action' ? resolution.slug : undefined} currentName={resolution.kind === 'action' ? resolution.action.name : undefined} />
      <div className="o_action_manager">
        {homeOpen || resolution.kind === 'home' ? (
          <HomeMenu apps={apps} />
        ) : resolution.kind === 'notfound' ? (
          <div className="p-5 text-center text-muted">
            <h2 className="fs-4">404</h2>
            <p>No action at <code>/odoo/{resolution.path}</code>.</p>
          </div>
        ) : (
          <ActionContainer key={`${resolution.action.id}:${resolution.viewType}:${resolution.recordId ?? (resolution.isNew ? 'new' : '')}:${version}`} resolution={resolution} query={location.query} user={user} />
        )}
      </div>
      <DialogHost />
      <NotificationHost />
    </div>
  );
}
