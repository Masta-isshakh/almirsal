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
}

/**
 * The web client shell (A-4 §1): navbar + action manager, dialog stack and
 * toast notifications. Server-resolved props say what to render; data is
 * fetched through `/api/rpc`.
 */
export function WebClient({ user, apps, menuHrefs, resolution }: { user: SessionInfo; apps: AppEntry[]; menuHrefs: Record<number, string>; resolution: Resolution }) {
  return (
    <UiProvider>
      <SessionProvider user={user}>
        <ActionRunnerProvider>
          <Shell user={user} apps={apps} menuHrefs={menuHrefs} resolution={resolution} />
        </ActionRunnerProvider>
      </SessionProvider>
    </UiProvider>
  );
}

function Shell({ user, apps, menuHrefs, resolution }: { user: SessionInfo; apps: AppEntry[]; menuHrefs: Record<number, string>; resolution: Resolution }) {
  const ui = useUi();
  const [homeOpen, setHomeOpen] = useState(resolution.kind === 'home');

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
      if (event.key === 'Escape' && homeOpen && resolution.kind !== 'home') setHomeOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [homeOpen, resolution.kind]);

  const currentApp = resolution.kind === 'action' && resolution.app
    ? apps.find((app) => app.id === resolution.app!.id) ?? null
    : null;

  return (
    <div className="o_web_client">
      <Navbar user={user} apps={apps} menuHrefs={menuHrefs} currentApp={homeOpen ? null : currentApp} onToggleHome={() => setHomeOpen((open) => !open)} homeOpen={homeOpen} />
      <div className="o_action_manager">
        {homeOpen || resolution.kind === 'home' ? (
          <HomeMenu apps={apps} />
        ) : resolution.kind === 'notfound' ? (
          <div className="p-5 text-center text-muted">
            <h2 className="fs-4">404</h2>
            <p>No action at <code>/odoo/{resolution.path}</code>.</p>
          </div>
        ) : (
          <ActionContainer key={`${resolution.action.id}:${resolution.viewType}:${resolution.recordId ?? (resolution.isNew ? 'new' : '')}`} resolution={resolution} user={user} />
        )}
      </div>
      <DialogHost />
      <NotificationHost />
    </div>
  );
}
