'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { I18n } from '@engine/i18n/types';
import type { MenuDef } from '@engine/registry/types';
import { rpc } from '@/lib/client/rpc';
import { useLang, useT } from '@/lib/client/i18n';
import type { AppEntry } from './WebClient';
import { useTheme } from './theme';
import { useNavigation } from '@/lib/client/navigation';
import { logout as signOutEverywhere } from '@/lib/client/auth';

interface Item { id: string; kind: 'menu' | 'record' | 'command'; label: string; hint?: string; icon: string; run: () => void }
interface SearchGroup { model: string; label: I18n; hits: [number, string][] }

const RECENT_KEY = 'rodeo.palette.recent';

/**
 * Command palette (Ctrl+K): fuzzy jump to any menu, find records across
 * the models that have menus in one round trip, and run commands (new
 * record, home, language, theme, log out). Prefixes: `/` menus only,
 * `@` records only, `>` commands only. Recent picks are remembered.
 */
export function CommandPalette({ open, onClose, apps, menuHrefs, currentModel, currentSlug, currentName }: {
  open: boolean; onClose: () => void; apps: AppEntry[]; menuHrefs: Record<number, string>; currentModel?: string; currentSlug?: string; currentName?: I18n;
}) {
  const t = useT();
  const lang = useLang();
  const { navigate } = useNavigation();
  const { theme, setTheme } = useTheme();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [records, setRecords] = useState<SearchGroup[]>([]);
  const [recent, setRecent] = useState<{ id: string; label: string; href: string; icon: string }[]>([]);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    setRecords([]);
    try { setRecent(JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')); } catch { setRecent([]); }
    setTimeout(() => input.current?.focus(), 0);
  }, [open]);

  const menus = useMemo(() => {
    const out: { id: string; label: string; path: string; href: string; app: string }[] = [];
    const walk = (app: AppEntry, node: MenuDef, trail: string[]) => {
      const label = t(node.name);
      const href = menuHrefs[node.id];
      if (href && node.children.length === 0) out.push({ id: `menu:${node.id}`, label, path: [...trail, label].join(' › '), href, app: t(app.name) });
      for (const child of node.children) walk(app, child, [...trail, label]);
    };
    for (const app of apps) {
      out.push({ id: `app:${app.id}`, label: t(app.name), path: t(app.name), href: app.href, app: t(app.name) });
      for (const child of app.children) walk(app, child, [t(app.name)]);
    }
    return out;
  }, [apps, menuHrefs, t]);

  const mode = query.startsWith('/') ? 'menu' : query.startsWith('@') ? 'record' : query.startsWith('>') ? 'command' : 'all';
  const text = mode === 'all' ? query.trim() : query.slice(1).trim();

  useEffect(() => {
    if (!open || (mode !== 'all' && mode !== 'record') || text.length < 2) { setRecords([]); return; }
    let cancelled = false;
    const handle = setTimeout(async () => {
      const groups = await rpc<SearchGroup[]>('globalSearch', 'res.partner', { name: text, model: currentModel }, { silent: true }).catch(() => [] as SearchGroup[]);
      if (!cancelled) setRecords(groups);
    }, 180);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [open, text, mode, currentModel]);

  const remember = (item: { id: string; label: string; href: string; icon: string }) => {
    const next = [item, ...recent.filter((r) => r.id !== item.id)].slice(0, 8);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };
  const go = (href: string, item?: { id: string; label: string; icon: string }) => { if (item) remember({ ...item, href }); onClose(); navigate(href); };

  const items = useMemo<Item[]>(() => {
    const list: Item[] = [];
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (haystack: string) => words.every((word) => haystack.toLowerCase().includes(word));
    if (mode === 'all' || mode === 'command') {
      const commands: Item[] = [];
      if (currentSlug) commands.push({ id: 'cmd:new', kind: 'command', label: `${t('New')} — ${t(currentName)}`, icon: 'fa-plus', run: () => go(`/odoo/${currentSlug}/new`) });
      commands.push({ id: 'cmd:home', kind: 'command', label: t('Home menu'), hint: 'Alt+H', icon: 'fa-th', run: () => go('/odoo') });
      commands.push({ id: 'cmd:theme', kind: 'command', label: theme === 'dark' ? t('Switch to light mode') : t('Switch to dark mode'), icon: theme === 'dark' ? 'fa-sun-o' : 'fa-moon-o', run: () => { setTheme(theme === 'dark' ? 'light' : 'dark'); onClose(); } });
      commands.push({ id: 'cmd:lang', kind: 'command', label: lang === 'ar_001' ? 'Switch to English' : 'التبديل إلى العربية', icon: 'fa-globe', run: async () => { await fetch('/api/auth/lang', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: lang === 'ar_001' ? 'en_US' : 'ar_001' }) }); window.location.reload(); } });
      commands.push({ id: 'cmd:users', kind: 'command', label: t('Users & Companies'), icon: 'fa-users', run: () => go('/odoo/users') });
      commands.push({ id: 'cmd:logout', kind: 'command', label: t('Log out'), icon: 'fa-sign-out', run: () => signOutEverywhere() });
      list.push(...commands.filter((command) => !text || matches(command.label)));
    }
    if (mode === 'all' || mode === 'menu') {
      const found = text ? menus.filter((menu) => matches(menu.path)) : [];
      list.push(...found.slice(0, mode === 'menu' ? 40 : 8).map((menu) => ({ id: menu.id, kind: 'menu' as const, label: menu.label, hint: menu.path, icon: 'fa-bars', run: () => go(menu.href, { id: menu.id, label: menu.path, icon: 'fa-bars' }) })));
    }
    if (mode === 'all' || mode === 'record') {
      for (const group of records) {
        for (const [id, name] of group.hits) {
          list.push({ id: `rec:${group.model}:${id}`, kind: 'record', label: name, hint: t(group.label), icon: 'fa-file-text-o', run: () => go(`/odoo/m/${group.model}/${id}`, { id: `rec:${group.model}:${id}`, label: name, icon: 'fa-file-text-o' }) });
        }
      }
    }
    if (!text && recent.length) {
      list.unshift(...recent.map((item) => ({ id: `recent:${item.id}`, kind: 'menu' as const, label: item.label, hint: t('Recent'), icon: item.icon, run: () => go(item.href) })));
    }
    return list;
  }, [text, mode, menus, records, recent, currentSlug, currentName, theme, lang]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setActive(0), [items.length, text]);

  if (!open) return null;
  return (
    <div className="o_dialog_backdrop" style={{ zIndex: 1300, alignItems: 'flex-start', paddingTop: '10vh' }} onMouseDown={onClose}>
      <div className="o_command_palette" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="o_command_palette_search">
          <i className="fa fa-search text-muted" />
          <input ref={input} value={query} placeholder={t('Search menus, records, commands…  ( / menus, @ records, > commands )')}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') { event.preventDefault(); setActive((i) => Math.min(items.length - 1, i + 1)); }
              if (event.key === 'ArrowUp') { event.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
              if (event.key === 'Enter' && items[active]) { event.preventDefault(); items[active].run(); }
              if (event.key === 'Escape') onClose();
            }} />
          <kbd>Esc</kbd>
        </div>
        <div className="o_command_palette_list">
          {items.length === 0 && <div className="p-3 text-muted small">{text.length < 2 ? t('Type to search') : t('No results')}</div>}
          {items.map((item, index) => (
            <button key={item.id} type="button" className={`o_command_item ${index === active ? 'active' : ''}`} onMouseEnter={() => setActive(index)} onClick={item.run}>
              <i className={`fa ${item.icon} text-muted`} />
              <span className="flex-grow-1 text-truncate">{item.label}</span>
              {item.hint && <span className="text-muted small text-truncate" style={{ maxWidth: '45%' }}>{item.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
