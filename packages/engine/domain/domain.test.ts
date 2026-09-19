import { describe, expect, it } from 'vitest';
import type { Domain, ModelDef } from '../registry/types.js';
import { i18n } from '../i18n/types.js';
import { combineDomains, normalizeDomain, parseDomain } from './normalize.js';
import { domainFields, domainMatch, filterByDomain } from './match.js';
import { domainToSql } from './sql.js';

/* ---------------------------------------------------------------- *
 * A minimal fixture schema, shaped like the real registry entries.
 * ---------------------------------------------------------------- */

function model(partial: Partial<ModelDef> & Pick<ModelDef, 'name' | 'table' | 'fields'>): ModelDef {
  return {
    description: i18n(partial.name),
    recName: 'name',
    order: 'id desc',
    access: [],
    ...partial,
  } as ModelDef;
}

const MODELS: Record<string, ModelDef> = {
  'res.partner': model({
    name: 'res.partner',
    table: 'res_partner',
    fields: {
      name: { name: 'name', type: 'char', label: i18n('Name') },
      email: { name: 'email', type: 'char', label: i18n('Email') },
      active: { name: 'active', type: 'boolean', label: i18n('Active') },
      parent_id: { name: 'parent_id', type: 'many2one', relation: 'res.partner', label: i18n('Parent') },
      country_id: { name: 'country_id', type: 'many2one', relation: 'res.country', label: i18n('Country') },
    },
  }),
  'res.country': model({
    name: 'res.country',
    table: 'res_country',
    fields: {
      name: { name: 'name', type: 'char', label: i18n('Name') },
      code: { name: 'code', type: 'char', label: i18n('Code') },
    },
  }),
  'sale.order': model({
    name: 'sale.order',
    table: 'sale_order',
    order: 'date_order desc, id desc',
    fields: {
      name: { name: 'name', type: 'char', label: i18n('Order Reference') },
      state: { name: 'state', type: 'selection', label: i18n('Status') },
      amount_total: { name: 'amount_total', type: 'monetary', label: i18n('Total') },
      date_order: { name: 'date_order', type: 'datetime', label: i18n('Order Date') },
      partner_id: { name: 'partner_id', type: 'many2one', relation: 'res.partner', label: i18n('Customer') },
      company_id: { name: 'company_id', type: 'many2one', relation: 'res.company', label: i18n('Company') },
      order_line: {
        name: 'order_line', type: 'one2many', relation: 'sale.order.line',
        inverse: 'order_id', label: i18n('Order Lines'),
      },
      tag_ids: {
        name: 'tag_ids', type: 'many2many', relation: 'crm.tag', label: i18n('Tags'),
        m2mTable: 'sale_order_tag_rel', m2mColumn1: 'order_id', m2mColumn2: 'tag_id',
      },
      margin: {
        name: 'margin', type: 'monetary', label: i18n('Margin'),
        compute: '_compute_margin', store: false,
      },
    },
  }),
  'sale.order.line': model({
    name: 'sale.order.line',
    table: 'sale_order_line',
    fields: {
      name: { name: 'name', type: 'text', label: i18n('Description') },
      order_id: { name: 'order_id', type: 'many2one', relation: 'sale.order', label: i18n('Order') },
      product_uom_qty: { name: 'product_uom_qty', type: 'float', label: i18n('Quantity') },
    },
  }),
  'crm.tag': model({
    name: 'crm.tag',
    table: 'crm_tag',
    fields: { name: { name: 'name', type: 'char', label: i18n('Tag') } },
  }),
  'res.company': model({
    name: 'res.company',
    table: 'res_company',
    fields: { name: { name: 'name', type: 'char', label: i18n('Company') } },
  }),
};

const schema = { model: (name: string) => MODELS[name] };

function sql(domain: Domain, modelName = 'sale.order', alias = 'so') {
  return domainToSql(modelName, domain, schema, { alias });
}

/* ---------------------------------------------------------------- *
 * Normalisation
 * ---------------------------------------------------------------- */

describe('parseDomain', () => {
  it('treats consecutive leaves as an implicit AND', () => {
    const node = parseDomain([['a', '=', 1], ['b', '=', 2]]);
    expect(node).toEqual({
      type: 'and',
      left: { type: 'leaf', field: 'a', op: '=', value: 1 },
      right: { type: 'leaf', field: 'b', op: '=', value: 2 },
    });
  });

  it('parses polish notation with | and !', () => {
    expect(parseDomain(['|', ['a', '=', 1], ['b', '!=', false]])).toEqual({
      type: 'or',
      left: { type: 'leaf', field: 'a', op: '=', value: 1 },
      right: { type: 'leaf', field: 'b', op: '!=', value: false },
    });
    expect(parseDomain(['!', ['a', '=', 1]])).toEqual({
      type: 'not',
      child: { type: 'leaf', field: 'a', op: '=', value: 1 },
    });
  });

  it('parses nested connectors', () => {
    const node = parseDomain(['&', '|', ['a', '=', 1], ['b', '=', 2], ['c', '=', 3]]);
    expect(node.type).toBe('and');
  });

  it('treats an empty domain as TRUE', () => {
    expect(parseDomain([])).toEqual({ type: 'true' });
    expect(parseDomain(undefined)).toEqual({ type: 'true' });
  });

  it('rejects a malformed domain', () => {
    expect(() => parseDomain(['&', ['a', '=', 1]])).toThrow(/Malformed domain/);
  });

  it('round-trips through the flat form with explicit connectors', () => {
    expect(normalizeDomain([['a', '=', 1], ['b', '=', 2]]))
      .toEqual(['&', ['a', '=', 1], ['b', '=', 2]]);
  });

  it('combines domains, ignoring empty ones', () => {
    expect(combineDomains([[['a', '=', 1]], [], null, [['b', '=', 2]]]))
      .toEqual(['&', ['a', '=', 1], ['b', '=', 2]]);
    expect(combineDomains([[], null])).toEqual([]);
  });
});

/* ---------------------------------------------------------------- *
 * Client-side matching
 * ---------------------------------------------------------------- */

describe('domainMatch', () => {
  const order = {
    name: 'S00012',
    state: 'sale',
    amount_total: 1500,
    partner_id: 7,
    tag_ids: [3, 4],
    order_line: [],
    note: false,
  };

  it('matches simple leaves', () => {
    expect(domainMatch(order, [['state', '=', 'sale']])).toBe(true);
    expect(domainMatch(order, [['state', '=', 'draft']])).toBe(false);
    expect(domainMatch(order, [['state', 'in', ['draft', 'sale']]])).toBe(true);
    expect(domainMatch(order, [['state', 'not in', ['draft']]])).toBe(true);
    expect(domainMatch(order, [['amount_total', '>', 1000]])).toBe(true);
  });

  it('treats = False as "empty", covering false and empty lists', () => {
    expect(domainMatch(order, [['note', '=', false]])).toBe(true);
    expect(domainMatch(order, [['order_line', '=', false]])).toBe(true);
    expect(domainMatch(order, [['tag_ids', '=', false]])).toBe(false);
    expect(domainMatch(order, [['partner_id', '!=', false]])).toBe(true);
  });

  it('matches a many2one sent as [id, display_name]', () => {
    const withTuple = { ...order, partner_id: [7, 'Azure Interior'] };
    expect(domainMatch(withTuple, [['partner_id', '=', 7]])).toBe(true);
    expect(domainMatch(withTuple, [['partner_id', 'in', [7, 9]]])).toBe(true);
  });

  it('tests membership against an x2many', () => {
    expect(domainMatch(order, [['tag_ids', 'in', [4]]])).toBe(true);
    expect(domainMatch(order, [['tag_ids', 'in', [99]]])).toBe(false);
    expect(domainMatch(order, [['tag_ids', '=', 3]])).toBe(true);
  });

  it('applies like/ilike with SQL wildcards', () => {
    expect(domainMatch(order, [['name', 'ilike', 's000']])).toBe(true);
    expect(domainMatch(order, [['name', 'like', 's000']])).toBe(false);
    expect(domainMatch(order, [['name', '=like', 'S000%']])).toBe(true);
    expect(domainMatch(order, [['name', '=ilike', 's00012']])).toBe(true);
    expect(domainMatch(order, [['name', 'not ilike', 'zzz']])).toBe(true);
  });

  it('evaluates connectors', () => {
    expect(domainMatch(order, ['|', ['state', '=', 'draft'], ['state', '=', 'sale']])).toBe(true);
    expect(domainMatch(order, ['!', ['state', '=', 'draft']])).toBe(true);
    expect(domainMatch(order, [['state', '=', 'sale'], ['amount_total', '>', 5000]])).toBe(false);
  });

  it('delegates dotted paths to the resolver', () => {
    const unsupported: string[] = [];
    expect(domainMatch(order, [['partner_id.country_id.code', '=', 'QA']], {
      onUnsupported: (field) => unsupported.push(field),
    })).toBe(false);
    expect(unsupported).toEqual(['partner_id.country_id.code']);

    expect(domainMatch(order, [['partner_id.country_id.code', '=', 'QA']], {
      resolvePath: () => 'QA',
    })).toBe(true);
  });

  it('filters a record list', () => {
    const records = [
      { id: 1, state: 'draft' },
      { id: 2, state: 'sale' },
      { id: 3, state: 'sale' },
    ];
    expect(filterByDomain(records, [['state', '=', 'sale']]).map((r) => r.id)).toEqual([2, 3]);
    expect(filterByDomain(records, []).length).toBe(3);
  });

  it('lists the fields a domain reads', () => {
    expect(domainFields(['|', ['state', '=', 'sale'], ['partner_id.name', 'ilike', 'a']]))
      .toEqual(['state', 'partner_id.name']);
  });
});

/* ---------------------------------------------------------------- *
 * SQL compilation
 * ---------------------------------------------------------------- */

describe('domainToSql', () => {
  it('compiles a simple equality with a bind parameter', () => {
    const { text, params } = sql([['state', '=', 'sale']]);
    expect(text).toBe('so."state" = $1');
    expect(params).toEqual(['sale']);
  });

  it('compiles connectors', () => {
    const { text, params } = sql(['|', ['state', '=', 'draft'], ['amount_total', '>', 100]]);
    expect(text).toBe('(so."state" = $1 OR so."amount_total" > $2)');
    expect(params).toEqual(['draft', 100]);
  });

  it('treats = False as an emptiness test per field type', () => {
    expect(sql([['partner_id', '=', false]]).text).toBe('so."partner_id" IS NULL');
    expect(sql([['name', '=', false]]).text).toBe(`(so."name" IS NULL OR so."name" = '')`);
    expect(sql([['active', '=', false]], 'res.partner', 'res_partner').text)
      .toBe('(res_partner."active" IS NULL OR res_partner."active" = FALSE)');
  });

  it('makes != NULL-inclusive, unlike raw SQL', () => {
    // A row with state IS NULL must match ('state','!=','draft').
    expect(sql([['state', '!=', 'draft']]).text).toBe('(so."state" = $1) IS NOT TRUE');
  });

  it('compiles in / not in with ANY() and handles False members', () => {
    expect(sql([['state', 'in', ['draft', 'sent']]]).text).toBe('so."state" = ANY($1)');
    expect(sql([['state', 'not in', ['draft']]]).text).toBe('(so."state" = ANY($1)) IS NOT TRUE');
    expect(sql([['partner_id', 'in', [7, false]]]).text)
      .toBe('(so."partner_id" = ANY($1) OR so."partner_id" IS NULL)');
  });

  it('short-circuits an empty in list', () => {
    expect(sql([['id', 'in', []]]).text).toBe('FALSE');
    expect(sql([['id', 'not in', []]]).text).toBe('TRUE');
  });

  it('wraps like patterns and keeps =like anchored', () => {
    expect(sql([['name', 'ilike', 'S00']]).params).toEqual(['%S00%']);
    expect(sql([['name', '=like', 'S00%']]).params).toEqual(['S00%']);
    expect(sql([['name', 'ilike', 'S00']]).text).toBe('so."name"::text ILIKE $1');
  });

  it('uses unaccent when enabled', () => {
    const compiled = domainToSql('sale.order', [['name', 'ilike', 'e']], schema, {
      alias: 'so', unaccent: true,
    });
    expect(compiled.text).toBe('unaccent(so."name"::text) ILIKE unaccent($1)');
  });

  it('traverses a dotted path with a subquery, never a join', () => {
    const { text, params } = sql([['partner_id.country_id.code', '=', 'QA']]);
    expect(text).toContain('so."partner_id" IN (SELECT');
    expect(text).toContain('FROM "res_partner"');
    expect(text).toContain('FROM "res_country"');
    expect(text).not.toContain('JOIN');
    expect(params).toEqual(['QA']);
  });

  it('compiles one2many membership through the inverse field', () => {
    const { text, params } = sql([['order_line', 'any', [['product_uom_qty', '>', 0]]]]);
    expect(text).toContain('so."id" IN (SELECT');
    expect(text).toContain('FROM "sale_order_line"');
    expect(text).toContain('"order_id" IS NOT NULL');
    expect(text).toContain('"product_uom_qty" > $1');
    // The subdomain must be compiled once: a second compilation would push a
    // duplicate bind parameter and shift every later placeholder.
    expect(params).toEqual([0]);
  });

  it('keeps placeholder numbering aligned across a nested relational domain', () => {
    const { text, params } = sql([
      '&',
      ['state', '=', 'sale'],
      ['order_line', 'any', [['product_uom_qty', '>', 0]]],
    ]);
    expect(params).toEqual(['sale', 0]);
    expect(text).toContain('$1');
    expect(text).toContain('$2');
    expect(text).not.toContain('$3');
  });

  it('compiles child_of on id against the model itself', () => {
    const { text, params } = sql([['id', 'child_of', 7]], 'res.partner', 'p');
    expect(text).toContain('WITH RECURSIVE tree AS');
    expect(text).toContain('p."id" IN (');
    expect(text).toContain('c."parent_id" = t."id"');
    expect(params).toEqual([[7]]);
  });

  it('compiles parent_of by walking up the tree', () => {
    const { text } = sql([['id', 'parent_of', 7]], 'res.partner', 'p');
    expect(text).toContain('t."parent_id" = p."id"');
  });

  it('compiles many2many membership through the relation table', () => {
    const { text, params } = sql([['tag_ids', 'in', [3, 4]]]);
    expect(text).toContain('FROM "sale_order_tag_rel"');
    expect(text).toContain('"order_id"');
    expect(text).toContain('"tag_id" IN (SELECT');
    expect(params).toEqual([[3, 4]]);
  });

  it('compiles an ilike against a many2one as a search on the comodel name', () => {
    const { text, params } = sql([['partner_id', 'ilike', 'azure']]);
    expect(text).toContain('so."partner_id" IN (SELECT');
    expect(text).toContain('"name"::text ILIKE $1');
    expect(params).toEqual(['%azure%']);
  });

  it('compiles child_of with a recursive CTE', () => {
    const { text } = sql([['partner_id', 'child_of', 7]]);
    expect(text).toContain('WITH RECURSIVE tree AS');
    expect(text).toContain('so."partner_id" IN (');
  });

  it('refuses to search a non-stored computed field', () => {
    expect(() => sql([['margin', '>', 0]])).toThrow(/non-stored computed field/);
  });

  it('rejects an unknown field and an unknown model', () => {
    expect(() => sql([['nope', '=', 1]])).toThrow(/Unknown field sale.order.nope/);
    expect(() => domainToSql('no.such.model', [], schema)).toThrow(/Unknown model/);
  });

  it('rejects an unsafe identifier rather than interpolating it', () => {
    const evil = {
      model: (name: string) => (name === 'evil' ? model({
        name: 'evil',
        table: 'evil"; DROP TABLE users; --',
        fields: { a: { name: 'a', type: 'char', label: i18n('A') } },
      }) : MODELS[name]),
    };
    expect(() => domainToSql('evil', [['a', '=', 1]], evil)).toThrow(/Unsafe SQL identifier/);
  });

  it('numbers parameters from an offset so it can be spliced into a larger query', () => {
    const compiled = domainToSql('sale.order', [['state', '=', 'sale']], schema, {
      alias: 'so', paramOffset: 3,
    });
    expect(compiled.text).toBe('so."state" = $4');
  });
});
