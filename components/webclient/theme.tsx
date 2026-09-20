'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Theme = 'light' | 'dark' | 'system';
const KEY = 'rodeo.theme';

interface ThemeApi { theme: 'light' | 'dark'; preference: Theme; setTheme: (theme: Theme) => void }
const ThemeContext = createContext<ThemeApi>({ theme: 'light', preference: 'system', setTheme: () => undefined });

function resolve(preference: Theme): 'light' | 'dark' {
  if (preference !== 'system') return preference;
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Applies `data-theme` + `data-bs-theme` on <html>; the inline script in layout.tsx sets it before paint. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<Theme>('system');
  const [theme, setResolved] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    let stored: Theme = 'system';
    try { stored = (localStorage.getItem(KEY) as Theme) || 'system'; } catch { /* ignore */ }
    setPreference(stored);
    setResolved(resolve(stored));
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onChange = () => { if ((localStorage.getItem(KEY) || 'system') === 'system') setResolved(resolve('system')); };
    media?.addEventListener('change', onChange);
    return () => media?.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.bsTheme = theme;
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    try { localStorage.setItem(KEY, next); } catch { /* ignore */ }
    setPreference(next);
    setResolved(resolve(next));
  }, []);

  const api = useMemo(() => ({ theme, preference, setTheme }), [theme, preference, setTheme]);
  return <ThemeContext.Provider value={api}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeApi {
  return useContext(ThemeContext);
}

/** Inline bootstrap so the first paint already has the right theme (no flash). */
export const THEME_BOOT_SCRIPT = `(function(){try{var p=localStorage.getItem('${KEY}')||'system';var d=p==='dark'||(p==='system'&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);var t=d?'dark':'light';document.documentElement.dataset.theme=t;document.documentElement.dataset.bsTheme=t;}catch(e){}})();`;
