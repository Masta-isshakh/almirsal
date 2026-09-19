import type { Lang } from '../i18n/types.js';
import { PyDate, PyDateTime } from '../expr/pydate.js';

/**
 * Number, money, date and duration formatting.
 *
 * Two rules from the spec drive the bilingual behaviour and are applied here
 * rather than left to `Intl`, which would localise both:
 *
 *  - Amounts ALWAYS use Latin digits, `,` thousands and `.` decimals, with the
 *    currency label after the number (`0.00 QR`), in Arabic as well as English.
 *  - Dates in Arabic use Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩).
 */

const ARABIC_INDIC = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];

/** Convert the Latin digits in a string to Arabic-Indic digits. */
export function toArabicDigits(text: string): string {
  return text.replace(/[0-9]/g, (digit) => ARABIC_INDIC[Number(digit)]);
}

export function fromArabicDigits(text: string): string {
  return text.replace(/[٠-٩]/g, (digit) => String(ARABIC_INDIC.indexOf(digit)));
}

export interface CurrencyDef {
  id?: number;
  name: string;
  /** Label rendered next to the amount, e.g. `QR`, `$`, `€`. */
  symbol: string;
  position: 'before' | 'after';
  decimalPlaces: number;
  rounding: number;
}

export const DEFAULT_CURRENCY: CurrencyDef = {
  name: 'QAR',
  symbol: 'QR',
  position: 'after',
  decimalPlaces: 2,
  rounding: 0.01,
};

/** Group the integer part with `,` every three digits. */
function groupThousands(integerPart: string): string {
  return integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Odoo's `float_round` with the HALF-UP method, operating on the currency's
 * rounding step rather than on a digit count, so 0.05-rounded currencies work.
 */
export function floatRound(value: number, precisionRounding: number): number {
  if (!precisionRounding) return value;
  const scaled = value / precisionRounding;
  // Nudge away from binary representation error before rounding, as Odoo does.
  const epsilonScaled = Math.abs(scaled) * Number.EPSILON * 8;
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled) + epsilonScaled);
  return rounded * precisionRounding;
}

/** Odoo's `float_compare`: -1, 0 or 1 at the given rounding. */
export function floatCompare(a: number, b: number, precisionRounding: number): -1 | 0 | 1 {
  const delta = floatRound(a - b, precisionRounding);
  if (delta < 0) return -1;
  if (delta > 0) return 1;
  return 0;
}

export function floatIsZero(value: number, precisionRounding: number): boolean {
  return floatRound(value, precisionRounding) === 0;
}

export interface FloatFormatOptions {
  /** Odoo's `digits` pair; only the second entry (decimals) is used. */
  digits?: [number, number];
  /** Force an exact number of decimals, overriding `digits`. */
  decimals?: number;
  /** Drop trailing zeros after the decimal point. */
  trim?: boolean;
  /** Render `0` as an empty string, as list cells do for zero quantities. */
  blankZero?: boolean;
}

/** Format a float with `,` thousands and `.` decimals (Latin digits always). */
export function formatFloat(value: number | false | null | undefined, options: FloatFormatOptions = {}): string {
  if (value === false || value === null || value === undefined || Number.isNaN(value)) return '';
  if (options.blankZero && value === 0) return '';

  const decimals = options.decimals ?? options.digits?.[1] ?? 2;
  const fixed = Math.abs(value).toFixed(decimals);
  const [integerPart, decimalPart = ''] = fixed.split('.');

  let out = groupThousands(integerPart);
  if (decimalPart) {
    const tail = options.trim ? decimalPart.replace(/0+$/, '') : decimalPart;
    if (tail) out += `.${tail}`;
  }
  return value < 0 ? `-${out}` : out;
}

export function formatInteger(value: number | false | null | undefined): string {
  if (value === false || value === null || value === undefined) return '';
  return formatFloat(Math.trunc(value), { decimals: 0 });
}

/**
 * Format a monetary amount. The currency label goes after the number by
 * default (`0.00 QR`) and digits stay Latin in every language.
 */
export function formatMonetary(
  value: number | false | null | undefined,
  currency: CurrencyDef = DEFAULT_CURRENCY,
  options: { noSymbol?: boolean; digits?: [number, number] } = {},
): string {
  if (value === false || value === null || value === undefined) return '';

  const rounded = floatRound(value, currency.rounding || 0.01);
  const decimals = options.digits?.[1] ?? currency.decimalPlaces;
  const number = formatFloat(rounded, { decimals });

  if (options.noSymbol || !currency.symbol) return number;
  return currency.position === 'before'
    ? `${currency.symbol} ${number}`
    : `${number} ${currency.symbol}`;
}

/** `widget="percentage"`: stored as a ratio, displayed as a percentage. */
export function formatPercentage(value: number | false | null | undefined, decimals = 2): string {
  if (value === false || value === null || value === undefined) return '';
  return `${formatFloat(value * 100, { decimals, trim: true })}%`;
}

/** `widget="float_time"`: 7.5 -> "07:30". */
export function formatFloatTime(value: number | false | null | undefined): string {
  if (value === false || value === null || value === undefined) return '';
  const sign = value < 0 ? '-' : '';
  const total = Math.round(Math.abs(value) * 60);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return `${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** Kanban stat counters: 12000 -> "12k", 1200000 -> "1.2M". */
export function humanNumber(value: number, options: { decimals?: number } = {}): string {
  const decimals = options.decimals ?? 1;
  const absolute = Math.abs(value);
  if (absolute < 1000) return formatFloat(value, { decimals: 0 });

  const units: [number, string][] = [
    [1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'],
  ];
  for (const [factor, suffix] of units) {
    if (absolute >= factor) {
      const scaled = value / factor;
      const text = formatFloat(scaled, { decimals, trim: true });
      return `${text}${suffix}`;
    }
  }
  return formatFloat(value, { decimals: 0 });
}

/* ------------------------------------------------------------------ *
 * Dates
 * ------------------------------------------------------------------ */

/** Per-language patterns, in Python strftime notation as Odoo stores them. */
export const DATE_FORMATS: Record<Lang, string> = {
  en_US: '%m/%d/%Y',
  ar_001: '%d/%m/%Y',
};

/** 12-hour clock in both languages, per the spec. */
export const TIME_FORMAT = '%I:%M:%S %p';

function localiseDigits(text: string, lang: Lang): string {
  return lang === 'ar_001' ? toArabicDigits(text) : text;
}

function toPyDate(value: string | PyDate | PyDateTime | Date): PyDate | null {
  if (value instanceof PyDate) return value;
  if (value instanceof PyDateTime) return value.date();
  if (value instanceof Date) return PyDateTime.fromJsUtc(value).date();
  return PyDate.parse(value);
}

function toPyDateTime(value: string | PyDate | PyDateTime | Date): PyDateTime | null {
  if (value instanceof PyDateTime) return value;
  if (value instanceof PyDate) return new PyDateTime(value.year, value.month, value.day);
  if (value instanceof Date) return PyDateTime.fromJsUtc(value);
  return PyDateTime.parse(value);
}

/** Format a date field for display. */
export function formatDate(
  value: string | PyDate | PyDateTime | Date | false | null | undefined,
  lang: Lang = 'en_US',
): string {
  if (!value) return '';
  const date = toPyDate(value);
  if (!date) return '';
  return localiseDigits(date.strftime(DATE_FORMATS[lang]), lang);
}

/** Format a datetime field for display, in the user's timezone. */
export function formatDateTime(
  value: string | PyDate | PyDateTime | Date | false | null | undefined,
  lang: Lang = 'en_US',
  options: { withSeconds?: boolean } = {},
): string {
  if (!value) return '';
  const moment = toPyDateTime(value);
  if (!moment) return '';
  const timePattern = options.withSeconds === false ? '%I:%M %p' : TIME_FORMAT;
  return localiseDigits(moment.strftime(`${DATE_FORMATS[lang]} ${timePattern}`), lang);
}

export interface RelativeLabels {
  today: string;
  yesterday: string;
  tomorrow: string;
  /** e.g. "%s days ago" */
  daysAgo: string;
  /** e.g. "In %s days" */
  inDays: string;
}

export const RELATIVE_LABELS: Record<Lang, RelativeLabels> = {
  en_US: {
    today: 'Today',
    yesterday: 'Yesterday',
    tomorrow: 'Tomorrow',
    daysAgo: '%s days ago',
    inDays: 'In %s days',
  },
  ar_001: {
    today: 'اليوم',
    yesterday: 'أمس',
    tomorrow: 'غداً',
    daysAgo: 'منذ %s أيام',
    inDays: 'خلال %s أيام',
  },
};

/**
 * Chatter-style relative date: "Today", "Yesterday", "2 days ago", then
 * "Sep 11" within the same year and "Sep 11, 2025" beyond it.
 */
export function formatRelativeDate(
  value: string | PyDate | PyDateTime | Date | false | null | undefined,
  today: PyDate,
  lang: Lang = 'en_US',
): string {
  if (!value) return '';
  const date = toPyDate(value);
  if (!date) return '';

  const delta = date.toOrdinal() - today.toOrdinal();
  const labels = RELATIVE_LABELS[lang];

  if (delta === 0) return labels.today;
  if (delta === -1) return labels.yesterday;
  if (delta === 1) return labels.tomorrow;
  if (delta < 0 && delta > -7) {
    return localiseDigits(labels.daysAgo.replace('%s', String(-delta)), lang);
  }
  if (delta > 0 && delta < 7) {
    return localiseDigits(labels.inDays.replace('%s', String(delta)), lang);
  }

  const pattern = date.year === today.year ? '%b %-d' : '%b %-d, %Y';
  return localiseDigits(date.strftime(pattern), lang);
}

/**
 * `widget="remaining_days"`: same wording as the relative date, and the caller
 * colours it (overdue red, today orange) from `daysUntil`.
 */
export function daysUntil(
  value: string | PyDate | PyDateTime | Date | false | null | undefined,
  today: PyDate,
): number | null {
  if (!value) return null;
  const date = toPyDate(value);
  if (!date) return null;
  return date.toOrdinal() - today.toOrdinal();
}

/** Duration in the "2 hours 30 minutes" style used by activity deadlines. */
export function formatDuration(hours: number, lang: Lang = 'en_US'): string {
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  const parts: string[] = [];
  if (lang === 'ar_001') {
    if (h) parts.push(`${toArabicDigits(String(h))} ساعة`);
    if (m) parts.push(`${toArabicDigits(String(m))} دقيقة`);
    return parts.join(' ') || '٠ دقيقة';
  }
  if (h) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
  if (m) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
  return parts.join(' ') || '0 minutes';
}

export { PyDate, PyDateTime };
