'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { MenuDef } from '@engine/registry/types';
import { useLang, useT } from '@/lib/client/i18n';
import type { AppEntry, SessionInfo } from './WebClient';
import { ActivitiesMenu, MessagesMenu } from './Systray';

/**
 * C-1: 46px white navbar — app icon (opens the home menu), app name, the
 * app's menu sections as dropdowns, then the systray (messages, activities,
 * user menu with avatar).
 */
export function Navbar({ user, apps, currentApp, homeOpen, onToggleHome, menuHrefs }: {
  user: SessionInfo; apps: AppEntry[]; currentApp: AppEntry | null; homeOpen: boolean; onToggleHome: () => void;
  menuHrefs?: Record<number, string>;
}) {
  const t = useT();
  return (
    <nav className="o_main_navbar" aria-label="Main navigation">
      <button type="button" className="o_navbar_apps_menu" title={t('Home menu')} aria-expanded={homeOpen} onClick={onToggleHome}>
        {currentApp ? <img src={`/icons/apps/${currentApp.slug}.svg`} alt="" /> : <i className="fa fa-th fa-lg" aria-hidden="true" />}
      </button>
      {currentApp && (
        <>
          <Link href={currentApp.href} className="o_menu_brand">{t(currentApp.name)}</Link>
          <div className="o_menu_sections">
            {currentApp.children.map((section) => (
              section.children.length === 0
                ? <Link key={section.id} href={menuHrefs?.[section.id] ?? '/odoo'} className="o_nav_entry">{t(section.name)}</Link>
                : <SectionDropdown key={section.id} section={section} menuHrefs={menuHrefs ?? {}} />
            ))}
          </div>
        </>
      )}
      <div className="o_menu_systray">
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

function SectionDropdown({ section, menuHrefs }: { section: MenuDef; menuHrefs: Record<number, string> }) {
  const t = useT();
  return (
    <Dropdown toggle={(open) => <button type="button" className="o_nav_entry" aria-expanded={open}>{t(section.name)}</button>}>
      {section.children.map((item) => (
        item.children.length === 0
          ? <Link key={item.id} href={menuHrefs[item.id] ?? '/odoo'} className="o_dropdown_item">{t(item.name)}</Link>
          : (
            <div key={item.id}>
              <div className="o_dropdown_header">{t(item.name)}</div>
              {item.children.map((sub) => (
                <Link key={sub.id} href={menuHrefs[sub.id] ?? '/odoo'} className="o_dropdown_item ps-4">{t(sub.name)}</Link>
              ))}
            </div>
          )
      ))}
    </Dropdown>
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

  async function switchLang(next: 'en_US' | 'ar_001') {
    await fetch('/api/auth/lang', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: next }) });
    window.location.reload();
  }
  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/web/login';
  }

  return (
    <Dropdown end toggle={() => (
      <button type="button" className="o_user_menu">
        <span className="o_user_name d-none d-md-inline">{user.name}</span>
        <span className="o_avatar" style={{ background: avatarColor(user.name) }}>{user.name.slice(0, 1).toUpperCase()}</span>
      </button>
    )}>
      <a className="o_dropdown_item" href="https://www.odoo.com/documentation/19.0/" target="_blank" rel="noreferrer">{t('Documentation')}</a>
      <button type="button" className="o_dropdown_item">{t('Shortcuts')} <span className="text-muted small ms-2">CTRL+K</span></button>
      <div className="o_dropdown_divider" />
      <Link href={`/odoo/m/res.users/${user.uid}`} className="o_dropdown_item">{t('My Preferences')}</Link>
      <div className="o_dropdown_divider" />
      <div className="o_dropdown_header">{t('Language')}</div>
      <button type="button" className="o_dropdown_item" onClick={() => switchLang('en_US')}>{lang === 'en_US' ? '✓ ' : ''}English (US)</button>
      <button type="button" className="o_dropdown_item" onClick={() => switchLang('ar_001')}>{lang === 'ar_001' ? '✓ ' : ''}العربية</button>
      <div className="o_dropdown_divider" />
      <button type="button" className="o_dropdown_item" onClick={logout}>{t('Log out')}</button>
    </Dropdown>
  );
}
