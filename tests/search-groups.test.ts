import { describe, expect, it } from 'vitest';
import { EMPTY_STATE, facetsFromState, filterGroups, orDomains } from '../components/webclient/search.js';
import type { SearchArch } from '../packages/engine/registry/arch.js';
import { PyDate } from '../packages/engine/expr/pydate.js';

/**
 * Filters between two separators are one question in Odoo: choosing Invoices
 * and Receipts asks for either of them. Combining them with AND — which is what
 * a facet each would do — leaves the screen empty, and the Customer Invoices
 * list did exactly that, because the action switches both on by default.
 */
const search = {
  type: 'search',
  fields: [],
  filters: [
    { name: 'invoices', string: { en: 'Invoices', ar: 'الفواتير' }, domain: "[('move_type', 'in', ('out_invoice', 'out_refund'))]" },
    { name: 'receipts', string: { en: 'Receipts', ar: 'الإيصالات' }, domain: "[('move_type', '=', 'out_receipt')]" },
    { separator: true },
    { name: 'posted', string: { en: 'Posted', ar: 'مرحّل' }, domain: "[('state', '=', 'posted')]" },
  ],
  groupbys: [],
  savedFilters: [],
  attrs: {},
} as unknown as SearchArch;

const env = { uid: 2, context: {}, companyIds: [1] } as never;

describe('filters in one group ask for either', () => {
  it('splits the filters by separator', () => {
    expect(filterGroups(search).map((group) => group.map((filter) => filter.name))).toEqual([['invoices', 'receipts'], ['posted']]);
  });

  it('ors the domains of one group and ands the groups', () => {
    const facets = facetsFromState({ ...EMPTY_STATE, filters: ['invoices', 'receipts', 'posted'] }, search, env, new PyDate(2026, 9, 30), 'en_US');
    expect(facets).toHaveLength(2);
    expect(facets[0].values).toEqual([{ en: 'Invoices', ar: 'الفواتير' }, { en: 'Receipts', ar: 'الإيصالات' }]);
    expect(facets[0].domain).toEqual(['|', ['move_type', 'in', ['out_invoice', 'out_refund']], ['move_type', '=', 'out_receipt']]);
    expect(facets[1].domain).toEqual([['state', '=', 'posted']]);
    // Removing the facet has to clear both filters it stands for.
    expect(facets[0].names).toEqual(['invoices', 'receipts']);
  });

  it('leaves a single chosen filter as it is', () => {
    const facets = facetsFromState({ ...EMPTY_STATE, filters: ['receipts'] }, search, env, new PyDate(2026, 9, 30), 'en_US');
    expect(facets).toHaveLength(1);
    expect(facets[0].domain).toEqual([['move_type', '=', 'out_receipt']]);
  });

  it('builds Odoo\'s prefix form for an or', () => {
    expect(orDomains([[['a', '=', 1]]])).toEqual([['a', '=', 1]]);
    expect(orDomains([[['a', '=', 1]], [['b', '=', 2]], [['c', '=', 3]]])).toEqual(['|', '|', ['a', '=', 1], ['b', '=', 2], ['c', '=', 3]]);
  });
});
