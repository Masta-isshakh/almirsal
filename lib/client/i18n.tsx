'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { I18n, Lang } from '@engine/i18n/types';
import { t as resolve } from '@engine/i18n/types';

/**
 * Translation the Odoo way: the English string is the key, the catalog maps
 * it to Arabic. `I18n` objects from the registry resolve directly.
 */
interface I18nContextValue {
  lang: Lang;
  dir: 'ltr' | 'rtl';
  catalog: Record<string, string>;
}

const I18nContext = createContext<I18nContextValue>({ lang: 'en_US', dir: 'ltr', catalog: {} });

export function I18nProvider({ lang, catalog, children }: { lang: Lang; catalog: Record<string, string>; children: ReactNode }) {
  return <I18nContext.Provider value={{ lang, dir: lang === 'ar_001' ? 'rtl' : 'ltr', catalog }}>{children}</I18nContext.Provider>;
}

export function useLang(): Lang {
  return useContext(I18nContext).lang;
}

export function useDir(): 'ltr' | 'rtl' {
  return useContext(I18nContext).dir;
}

/** `t('Confirm')` → catalog lookup; `t({en, ar})` → direct resolve. */
export function useT(): (value: I18n | string | undefined | null) => string {
  const { lang, catalog } = useContext(I18nContext);
  return (value) => {
    if (value == null) return '';
    if (typeof value === 'string') return lang === 'ar_001' ? (catalog[value] ?? value) : value;
    // An export string without Arabic (or with the English copied over) still gets the catalog.
    if (lang === 'ar_001' && (!value.ar || value.ar === value.en) && catalog[value.en]) return catalog[value.en];
    return resolve(value, lang);
  };
}
