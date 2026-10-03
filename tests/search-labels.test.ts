import { describe, expect, it } from 'vitest';
import { entryLabel } from '../components/webclient/search.js';
import type { FieldDef } from '../packages/engine/registry/types.js';

/**
 * The Filters and Group By menus must never show a technical name. About thirty
 * entries in Odoo's own search views carry no label, and Odoo shows the label
 * of the field the entry acts on instead.
 */
const fields = {
  category: { name: 'category', type: 'many2one', label: { en: 'Category', ar: 'الفئة' } },
  birthday_month: { name: 'birthday_month', type: 'selection', label: { en: 'Birthday Month', ar: 'شهر الميلاد' } },
} as unknown as Record<string, FieldDef>;

describe('search entry labels', () => {
  it('keeps the label the view gives', () => {
    expect(entryLabel({ name: 'groupby_category', string: { en: 'By Category', ar: 'حسب الفئة' }, context: "{'group_by': 'category'}" }, fields))
      .toEqual({ en: 'By Category', ar: 'حسب الفئة' });
  });

  it('falls back to the label of the grouped field', () => {
    expect(entryLabel({ name: 'groupby_category', context: "{'group_by' : 'category'}" }, fields)).toEqual({ en: 'Category', ar: 'الفئة' });
    expect(entryLabel({ name: 'group_birthday', context: "{'group_by': 'birthday_month'}" }, fields)).toEqual({ en: 'Birthday Month', ar: 'شهر الميلاد' });
  });

  it('reads a grouped field written with a granularity', () => {
    expect(entryLabel({ name: 'group_date', context: "{'group_by': 'birthday_month:month'}" }, fields)).toEqual({ en: 'Birthday Month', ar: 'شهر الميلاد' });
  });

  it('uses the date field of a period filter', () => {
    expect(entryLabel({ name: 'filter_date', date: 'birthday_month' }, fields)).toEqual({ en: 'Birthday Month', ar: 'شهر الميلاد' });
  });

  it('reads the name as words when nothing else says what it is', () => {
    expect(entryLabel({ name: 'group_by_responsible_user_ids' }, {})).toBe('Responsible User');
    expect(entryLabel({ name: 'groupby_company' }, {})).toBe('Company');
    expect(entryLabel({ name: 'assigned_employee_id' }, {})).toBe('Assigned Employee');
    // Odoo glues this one together; it still reads as words.
    expect(entryLabel({ name: 'myinvoices' }, {})).toBe('My Invoices');
  });
});
