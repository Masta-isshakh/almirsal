import { describe, expect, it } from 'vitest';
import { PyDate, PyDateTime } from '../expr/pydate.js';
import {
  DEFAULT_CURRENCY,
  floatCompare,
  floatIsZero,
  floatRound,
  formatDate,
  formatDateTime,
  formatDuration,
  formatFloat,
  formatFloatTime,
  formatMonetary,
  formatPercentage,
  formatRelativeDate,
  humanNumber,
  toArabicDigits,
  type CurrencyDef,
} from './index.js';

const TODAY = new PyDate(2026, 9, 19);

describe('floats', () => {
  it('groups thousands and fixes decimals', () => {
    expect(formatFloat(1234.5)).toBe('1,234.50');
    expect(formatFloat(1234567.891, { decimals: 2 })).toBe('1,234,567.89');
    expect(formatFloat(-1234.5)).toBe('-1,234.50');
    expect(formatFloat(0)).toBe('0.00');
  });

  it('honours digits, trimming and blank zero', () => {
    expect(formatFloat(1.5, { digits: [16, 3] })).toBe('1.500');
    expect(formatFloat(1.5, { digits: [16, 3], trim: true })).toBe('1.5');
    expect(formatFloat(0, { blankZero: true })).toBe('');
  });

  it('returns an empty string for false/null, as Odoo does', () => {
    expect(formatFloat(false)).toBe('');
    expect(formatFloat(null)).toBe('');
    expect(formatFloat(undefined)).toBe('');
  });

  it('rounds half-up on the currency step', () => {
    expect(floatRound(0.005, 0.01)).toBeCloseTo(0.01, 10);
    expect(floatRound(2.675, 0.01)).toBeCloseTo(2.68, 10);
    expect(floatRound(-2.675, 0.01)).toBeCloseTo(-2.68, 10);
    expect(floatRound(1.23, 0.05)).toBeCloseTo(1.25, 10);
  });

  it('compares at a rounding step', () => {
    expect(floatCompare(0.001, 0.002, 0.01)).toBe(0);
    expect(floatCompare(1.0, 1.02, 0.01)).toBe(-1);
    expect(floatCompare(1.02, 1.0, 0.01)).toBe(1);
    expect(floatIsZero(0.004, 0.01)).toBe(true);
    expect(floatIsZero(0.006, 0.01)).toBe(false);
  });
});

describe('monetary', () => {
  it('puts the currency label after the number', () => {
    expect(formatMonetary(0, DEFAULT_CURRENCY)).toBe('0.00 QR');
    expect(formatMonetary(1234.5, DEFAULT_CURRENCY)).toBe('1,234.50 QR');
  });

  it('honours a before-position currency', () => {
    const usd: CurrencyDef = {
      name: 'USD', symbol: '$', position: 'before', decimalPlaces: 2, rounding: 0.01,
    };
    expect(formatMonetary(1234.5, usd)).toBe('$ 1,234.50');
  });

  it('respects the currency decimal places and rounding', () => {
    const jpy: CurrencyDef = {
      name: 'JPY', symbol: '¥', position: 'before', decimalPlaces: 0, rounding: 1,
    };
    expect(formatMonetary(1234.6, jpy)).toBe('¥ 1,235');
  });

  it('can drop the symbol for totals columns', () => {
    expect(formatMonetary(99, DEFAULT_CURRENCY, { noSymbol: true })).toBe('99.00');
  });
});

describe('other widgets', () => {
  it('formats percentages', () => {
    expect(formatPercentage(0.155)).toBe('15.5%');
    expect(formatPercentage(1)).toBe('100%');
  });

  it('formats float_time as HH:MM', () => {
    expect(formatFloatTime(7.5)).toBe('07:30');
    expect(formatFloatTime(0)).toBe('00:00');
    expect(formatFloatTime(12.25)).toBe('12:15');
    expect(formatFloatTime(-1.5)).toBe('-01:30');
  });

  it('humanises kanban counters', () => {
    expect(humanNumber(999)).toBe('999');
    expect(humanNumber(12000)).toBe('12k');
    expect(humanNumber(1200000)).toBe('1.2M');
    expect(humanNumber(1500000000)).toBe('1.5G');
  });

  it('formats durations in both languages', () => {
    expect(formatDuration(2.5)).toBe('2 hours 30 minutes');
    expect(formatDuration(1)).toBe('1 hour');
    expect(formatDuration(2.5, 'ar_001')).toBe('٢ ساعة ٣٠ دقيقة');
  });
});

describe('dates', () => {
  it('uses the per-language date pattern', () => {
    expect(formatDate('2026-09-19', 'en_US')).toBe('09/19/2026');
    expect(formatDate('2026-09-19', 'ar_001')).toBe(toArabicDigits('19/09/2026'));
  });

  it('renders datetimes on a 12-hour clock', () => {
    expect(formatDateTime('2026-09-19 14:30:05', 'en_US')).toBe('09/19/2026 02:30:05 PM');
    expect(formatDateTime('2026-09-19 09:05:00', 'en_US')).toBe('09/19/2026 09:05:00 AM');
    expect(formatDateTime('2026-09-19 00:30:00', 'en_US')).toBe('09/19/2026 12:30:00 AM');
    expect(formatDateTime('2026-09-19 12:30:00', 'en_US')).toBe('09/19/2026 12:30:00 PM');
  });

  it('uses Arabic-Indic digits for Arabic dates but never for money', () => {
    expect(formatDate('2026-09-19', 'ar_001')).toBe('١٩/٠٩/٢٠٢٦');
    // Rule 3: amounts stay in Latin digits in every language.
    expect(formatMonetary(1234.5, DEFAULT_CURRENCY)).toBe('1,234.50 QR');
  });

  it('accepts PyDate, PyDateTime and ISO strings', () => {
    expect(formatDate(new PyDate(2026, 1, 5))).toBe('01/05/2026');
    expect(formatDate(new PyDateTime(2026, 1, 5, 10, 0, 0))).toBe('01/05/2026');
    expect(formatDate('2026-01-05T10:00:00')).toBe('01/05/2026');
  });

  it('returns empty for falsy values', () => {
    expect(formatDate(false)).toBe('');
    expect(formatDateTime(null)).toBe('');
  });

  it('formats chatter-style relative dates', () => {
    expect(formatRelativeDate('2026-09-19', TODAY)).toBe('Today');
    expect(formatRelativeDate('2026-09-18', TODAY)).toBe('Yesterday');
    expect(formatRelativeDate('2026-09-20', TODAY)).toBe('Tomorrow');
    expect(formatRelativeDate('2026-09-17', TODAY)).toBe('2 days ago');
    expect(formatRelativeDate('2026-09-11', TODAY)).toBe('Sep 11');
    expect(formatRelativeDate('2025-09-11', TODAY)).toBe('Sep 11, 2025');
  });

  it('localises relative dates', () => {
    expect(formatRelativeDate('2026-09-19', TODAY, 'ar_001')).toBe('اليوم');
    expect(formatRelativeDate('2026-09-17', TODAY, 'ar_001')).toBe('منذ ٢ أيام');
  });
});
