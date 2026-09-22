'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { MenuDef } from '@engine/registry/types';
import { useLang, useT } from '@/lib/client/i18n';
import type { AppEntry, SessionInfo } from './WebClient';
import { ActivitiesMenu, MessagesMenu } from './Systray';
import { AttendanceMenu } from './AttendanceMenu';
import { useTheme } from './theme';
import { ShortcutsHelp } from './Shortcuts';
import { logout as signOutEverywhere } from '@/lib/client/auth';
import { ChangePassword } from './ChangePassword';
import { useUi } from './ui';

/**
 * C-1: 46px white navbar — app icon (opens the home menu), app name, the
 * app's menu sections as dropdowns, then the systray (messages, activities,
 * user menu with avatar).
 */
export function Navbar({ user, apps, currentApp, homeOpen, onToggleHome, menuHrefs, onSearch }: {
  user: SessionInfo; apps: AppEntry[]; currentApp: AppEntry | null; homeOpen: boolean; onToggleHome: () => void;
  menuHrefs?: Record<number, string>; onSearch?: () => void;
}) {
  const t = useT();
  return (
    <nav className="o_main_navbar" aria-label="Main navigation">
      <button type="button" className="o_navbar_apps_menu" title={t('Home menu')} aria-expanded={homeOpen} onClick={onToggleHome}>
        {currentApp ? <img src={`/icons/apps/${currentApp.slug}.svg`} alt="" /> : <i className="fa fa-th fa-lg" aria-hidden="true" />}
      </button>
      {currentApp && (
        <>
          <a href={currentApp.href} data-app={currentApp.id} className="o_menu_brand">{t(currentApp.name)}</a>
          <MenuSections key={currentApp.id} app={currentApp} menuHrefs={menuHrefs ?? {}} />
        </>
      )}
      <div className="o_menu_systray">
        <button type="button" className="o_systray_item" title="Ctrl+K" onClick={onSearch}><i className="fa fa-search fa-lg" /></button>
        <AttendanceMenu />
        <MessagesMenu />
        <ActivitiesMenu user={user} />
        <UserMenu user={user} />
      </div>
    </nav>
  );
}

function useClickOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) close(); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onClick); document.removeEventListener('keydown', onKey); };
  }, [open, close]);
  return ref;
}

export function Dropdown({ toggle, children, end, className }: { toggle: (open: boolean) => ReactNode; children: ReactNode; end?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(open, () => setOpen(false));
  return (
    <div className={`o_dropdown ${className ?? ''}`} ref={ref}>
      <span onClick={() => setOpen((v) => !v)}>{toggle(open)}</span>
      {open && <div className={`o_dropdown_menu ${end ? 'o_dropdown_end' : ''}`} onClick={() => setOpen(false)}>{children}</div>}
    </div>
  );
}

/**
 * The app's menu sections. One section is open at a time; while one is
 * open, hovering another switches to it (Odoo's navbar behaviour), Escape
 * or a click outside closes it, and every link carries the app it belongs
 * to so the shell keeps showing this app's sections after the move.
 */
function MenuSections({ app, menuHrefs }: { app: AppEntry; menuHrefs: Record<number, string> }) {
  const t = useT();
  const [open, setOpen] = useState<number | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const ref = useClickOutside(open !== null, close);
  const link = (menu: MenuDef, className: string) => (
    <a key={menu.id} href={menuHrefs[menu.id] ?? '/odoo'} data-app={app.id} className={className} onClick={close}>{t(menu.name)}</a>
  );
  return (
    <div className="o_menu_sections" ref={ref} role="menubar">
      {app.children.map((section) => (
        section.children.length === 0 ? link(section, 'o_nav_entry') : (
          <div key={section.id} className="o_dropdown" onMouseEnter={() => { if (open !== null && open !== section.id) setOpen(section.id); }}>
            <button type="button" className="o_nav_entry" aria-haspopup="menu" aria-expanded={open === section.id}
              onClick={() => setOpen((current) => (current === section.id ? null : section.id))}>{t(section.name)}</button>
            {open === section.id && (
              <div className="o_dropdown_menu" role="menu">
                {section.children.map((item) => (
                  item.children.length === 0 ? link(item, 'o_dropdown_item') : (
                    <div key={item.id}>
                      <div className="o_dropdown_header">{t(item.name)}</div>
                      {item.children.map((sub) => link(sub, 'o_dropdown_item ps-4'))}
                    </div>
                  )
                ))}
              </div>
            )}
          </div>
        )
      ))}
    </div>
  );
}

/** Deterministic avatar colour from the name, as Odoo's generated avatars. */
export function avatarColor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360}, 68%, 52%)`;
}

function UserMenu({ user }: { user: SessionInfo }) {
  const t = useT();
  const lang = useLang();
  const { preference, setTheme } = useTheme();
  const ui = useUi();

  async function switchLang(next: 'en_US' | 'ar_001') {
    await fetch('/api/auth/lang', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: next }) });
    window.location.reload();
  }
  const logout = () => signOutEverywhere();

  return (
    <Dropdown end toggle={() => (
      <button type="button" className="o_user_menu">
        <span className="o_user_name d-none d-md-inline">{user.name}</span>
        <span className="o_avatar" style={{ background: avatarColor(user.name) }}>{user.name.slice(0, 1).toUpperCase()}</span>
      </button>
    )}>
      <a className="o_dropdown_item" href="https://www.odoo.com/documentation/19.0/" target="_blank" rel="noreferrer">{t('Documentation')}</a>
      <button type="button" className="o_dropdown_item" onClick={() => ui.openDialog({ title: { en: 'Keyboard Shortcuts', ar: 'اختصارات لوحة المفاتيح' }, size: 'sm', body: <ShortcutsHelp /> })}>{t('Shortcuts')} <span className="text-muted small ms-2">?</span></button>
      <div className="o_dropdown_divider" />
      <div className="o_dropdown_header">{t('Theme')}</div>
      <button type="button" className="o_dropdown_item" onClick={() => setTheme('light')}>{preference === 'light' ? '✓ ' : ''}{t('Light')}</button>
      <button type="button" className="o_dropdown_item" onClick={() => setTheme('dark')}>{preference === 'dark' ? '✓ ' : ''}{t('Dark')}</button>
      <button type="button" className="o_dropdown_item" onClick={() => setTheme('system')}>{preference === 'system' ? '✓ ' : ''}{t('System')}</button>
      <div className="o_dropdown_divider" />
      <a href={`/odoo/m/res.users/${user.uid}`} className="o_dropdown_item">{t('My Preferences')}</a>
      <button type="button" className="o_dropdown_item" onClick={() => { let id = 0; id = ui.openDialog({ title: { en: 'Change Password', ar: 'تغيير كلمة المرور' }, size: 'sm', footer: null, body: <ChangePassword uid={user.uid} authConfig={user.authConfig ?? null} onDone={() => ui.closeDialog(id)} /> }); }}>{t('Change Password')}</button>
      <div className="o_dropdown_divider" />
      <div className="o_dropdown_header">{t('Language')}</div>
      <button type="button" className="o_dropdown_item" onClick={() => switchLang('en_US')}>{lang === 'en_US' ? '✓ ' : ''}English (US)</button>
      <button type="button" className="o_dropdown_item" onClick={() => switchLang('ar_001')}>{lang === 'ar_001' ? '✓ ' : ''}العربية</button>
      <div className="o_dropdown_divider" />
      <button type="button" className="o_dropdown_item" onClick={logout}>{t('Log out')}</button>
    </Dropdown>
  );
}
