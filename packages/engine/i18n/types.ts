/**
 * Bilingual string carrier used across the whole metadata registry.
 *
 * Every user-visible string in the spec is written as `English / العربية`;
 * the registry stores both so nothing has to be looked up in a PO file at
 * render time. `I18nHtml` is the same shape but the value is trusted HTML
 * (action `help` blocks, empty-state text).
 */
export interface I18n {
  en: string;
  ar: string;
}

export type I18nHtml = I18n;

export type Lang = 'en_US' | 'ar_001';

export type Dir = 'ltr' | 'rtl';

export const LANGS: readonly Lang[] = ['en_US', 'ar_001'] as const;

export const DEFAULT_LANG: Lang = 'en_US';

export function dirOf(lang: Lang): Dir {
  return lang === 'ar_001' ? 'rtl' : 'ltr';
}

/** Resolve an `I18n` for a language, falling back to English. */
export function t(value: I18n | string | undefined | null, lang: Lang): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (lang === 'ar_001') return value.ar || value.en;
  return value.en;
}

/** Build an `I18n` from the `English / العربية` notation used in the spec. */
export function i18n(en: string, ar?: string): I18n {
  return { en, ar: ar ?? en };
}
