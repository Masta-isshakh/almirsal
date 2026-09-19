import { describe, expect, it } from 'vitest';
import { PyDateTime } from './pydate.js';
import { evalCondition, evaluate, evaluateBoolean, makeScope } from './evaluate.js';
import { parse } from './parse.js';

/** Fixed clock so date expressions are deterministic. */
const NOW = new PyDateTime(2026, 9, 19, 14, 30, 5);

function scope(record: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return makeScope({
    record,
    now: NOW,
    uid: 2,
    allowedCompanyIds: [1],
    context: { hide_pdf_quote_builder: true, default_partner_id: 7 },
    ...extra,
  });
}

describe('literals and containers', () => {
  it('parses Python constants', () => {
    expect(evaluate('True')).toBe(true);
    expect(evaluate('False')).toBe(false);
    expect(evaluate('None')).toBe(null);
    expect(evaluate('42')).toBe(42);
    expect(evaluate('3.5')).toBe(3.5);
    expect(evaluate("'draft'")).toBe('draft');
    expect(evaluate('"draft"')).toBe('draft');
  });

  it('concatenates adjacent string literals like Python', () => {
    expect(evaluate("'foo' 'bar'")).toBe('foobar');
  });

  it('builds lists, tuples and dicts', () => {
    expect(evaluate("['a', 'b']")).toEqual(['a', 'b']);
    expect(evaluate("('a', 1)")).toEqual(['a', 1]);
    expect(evaluate("{'default_move_type': 'out_invoice'}")).toEqual({
      default_move_type: 'out_invoice',
    });
    expect(evaluate('[]')).toEqual([]);
    expect(evaluate('(1,)')).toEqual([1]);
  });

  it('parses a polish-notation domain as a nested list', () => {
    expect(evaluate("['|', ('a','=',1), ('b','!=',False)]")).toEqual([
      '|', ['a', '=', 1], ['b', '!=', false],
    ]);
  });
});

describe('operators', () => {
  it('applies Python truthiness', () => {
    expect(evaluateBoolean('not partner_id', scope({ partner_id: false }))).toBe(true);
    expect(evaluateBoolean('not partner_id', scope({ partner_id: 7 }))).toBe(false);
    expect(evaluateBoolean('order_line', scope({ order_line: [] }))).toBe(false);
    expect(evaluateBoolean('order_line', scope({ order_line: [1] }))).toBe(true);
    expect(evaluateBoolean("name", scope({ name: '' }))).toBe(false);
  });

  it('returns the operand, not a boolean, from and/or', () => {
    expect(evaluate("0 or 'fallback'")).toBe('fallback');
    expect(evaluate("'a' and 'b'")).toBe('b');
  });

  it('handles membership', () => {
    expect(evaluateBoolean("state in ['draft', 'sent']", scope({ state: 'sent' }))).toBe(true);
    expect(evaluateBoolean("state not in ['draft', 'sent']", scope({ state: 'sale' }))).toBe(true);
    expect(evaluateBoolean("'x' in 'prefix'", scope())).toBe(true);
  });

  it('supports chained comparisons', () => {
    expect(evaluateBoolean('0 < qty <= 10', scope({ qty: 5 }))).toBe(true);
    expect(evaluateBoolean('0 < qty <= 10', scope({ qty: 50 }))).toBe(false);
  });

  it('follows Python precedence, including unary minus and **', () => {
    expect(evaluate('-2 ** 2')).toBe(-4);
    expect(evaluate('2 ** 3 ** 2')).toBe(512);
    expect(evaluate('1 + 2 * 3')).toBe(7);
    expect(evaluate('(1 + 2) * 3')).toBe(9);
  });

  it('uses Python modulo sign semantics', () => {
    expect(evaluate('-7 % 3')).toBe(2);
  });

  it('formats strings with %', () => {
    expect(evaluate("'%s/%s' % ('INV', 2026)")).toBe('INV/2026');
    expect(evaluate("'%(year)s' % {'year': 2026}")).toBe('2026');
  });

  it('evaluates the ternary', () => {
    expect(evaluate("'yes' if state == 'sale' else 'no'", scope({ state: 'sale' }))).toBe('yes');
    expect(evaluate("'yes' if state == 'sale' else 'no'", scope({ state: 'draft' }))).toBe('no');
  });
});

describe('Odoo globals', () => {
  it('reads context with .get and a default', () => {
    expect(evaluateBoolean("context.get('hide_pdf_quote_builder')", scope())).toBe(true);
    expect(evaluateBoolean("context.get('missing')", scope())).toBe(false);
    expect(evaluate("context.get('missing', 5)", scope())).toBe(5);
  });

  it('exposes uid, active_id and allowed_company_ids', () => {
    expect(evaluate('uid', scope())).toBe(2);
    expect(evaluate('allowed_company_ids', scope())).toEqual([1]);
    expect(evaluateBoolean('user_id == uid', scope({ user_id: 2 }))).toBe(true);
  });

  it('resolves parent.<field> inside an embedded view', () => {
    const embedded = makeScope({
      record: { product_uom_qty: 3 },
      parent: { state: 'sale' },
      now: NOW,
    });
    expect(evaluateBoolean("parent.state == 'sale'", embedded)).toBe(true);
    expect(evaluateBoolean("parent.state not in ['draft']", embedded)).toBe(true);
  });

  it('returns false for parent.<field> when there is no parent', () => {
    expect(evaluateBoolean("parent.state == 'sale'", scope())).toBe(false);
  });
});

describe('dates', () => {
  it('evaluates context_today and strftime', () => {
    expect(evaluate("context_today().strftime('%Y-%m-%d')", scope())).toBe('2026-09-19');
    expect(evaluate("datetime.date.today().strftime('%Y-%m-%d')", scope())).toBe('2026-09-19');
    expect(evaluate("datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')", scope()))
      .toBe('2026-09-19 14:30:05');
    expect(evaluate("time.strftime('%Y')", scope())).toBe('2026');
  });

  it('subtracts a relativedelta', () => {
    expect(evaluate("(context_today() - relativedelta(days=7)).strftime('%Y-%m-%d')", scope()))
      .toBe('2026-09-12');
    expect(evaluate("(context_today() - relativedelta(months=1)).strftime('%Y-%m-%d')", scope()))
      .toBe('2026-08-19');
    expect(evaluate("(context_today() + relativedelta(years=1)).strftime('%Y-%m-%d')", scope()))
      .toBe('2027-09-19');
  });

  it('treats absolute relativedelta fields as replacements', () => {
    // First day of next month, the idiom Odoo uses for period filters.
    expect(evaluate("(context_today() + relativedelta(months=1, day=1)).strftime('%Y-%m-%d')", scope()))
      .toBe('2026-10-01');
    // Day clamped to the length of the target month.
    expect(evaluate("(context_today() + relativedelta(months=1, day=31)).strftime('%Y-%m-%d')", scope()))
      .toBe('2026-10-31');
    expect(evaluate("(context_today() + relativedelta(months=5, day=31)).strftime('%Y-%m-%d')", scope()))
      .toBe('2027-02-28');
  });

  it('handles leap years', () => {
    const leap = makeScope({ now: new PyDateTime(2028, 1, 31) });
    expect(evaluate("(context_today() + relativedelta(months=1)).strftime('%Y-%m-%d')", leap))
      .toBe('2028-02-29');
  });

  it('formats weekday and month names', () => {
    expect(evaluate("context_today().strftime('%A %d %B %Y')", scope()))
      .toBe('Saturday 19 September 2026');
    expect(evaluate("context_today().strftime('%a %b')", scope())).toBe('Sat Sep');
  });

  it('supports the no-pad directives', () => {
    const early = makeScope({ now: new PyDateTime(2026, 3, 5, 9, 7, 0) });
    expect(evaluate("context_today().strftime('%-d/%-m/%Y')", early)).toBe('5/3/2026');
  });

  it('compares a date field against today', () => {
    const record = scope({ expected_date: '2026-09-25', commitment_date: '2026-09-20' });
    expect(evaluateBoolean('expected_date > commitment_date', record)).toBe(true);
  });

  it('subtracts two dates into a timedelta', () => {
    expect(evaluate("(context_today() - datetime.date.today()).days", scope())).toBe(0);
  });
});

describe('evalCondition', () => {
  it('shortcuts literal conditions', () => {
    expect(evalCondition('1')).toBe(true);
    expect(evalCondition('0')).toBe(false);
    expect(evalCondition('True')).toBe(true);
    expect(evalCondition('False')).toBe(false);
    expect(evalCondition(true)).toBe(true);
    expect(evalCondition(undefined)).toBe(false);
  });

  it('falls back instead of throwing on a bad attribute', () => {
    const errors: string[] = [];
    const result = evalCondition('missing_field == 1', scope(), false, (_error, source) => {
      errors.push(source);
    });
    expect(result).toBe(false);
    expect(errors).toEqual(['missing_field == 1']);
  });
});

describe('real view attributes from the spec', () => {
  // Every conditional string quoted in Parts A-2 and C must at least parse.
  const SPEC_EXPRESSIONS = [
    "state != 'draft'",
    'not partner_id',
    "parent.state == 'sale'",
    "context.get('hide_pdf_quote_builder')",
    'context_today()',
    'today',
    'uid',
    'allowed_company_ids',
    "[('company_id','in',allowed_company_ids)]",
    'product_uom_qty > 0 and not display_type',
    "state in ['draft','sent']",
    'commitment_date and (expected_date < commitment_date or not expected_date)',
    "'%Y-%m-%d'",
    "[('partner_id','child_of',active_id)]",
    "{'default_partner_id': partner_id, 'default_company_id': company_id}",
    "state == 'draft' and not invoice_ids",
    'len(order_line) == 0',
    "any(l.qty for l in [])".replace(' for l in []', ''),
    "bool(partner_id) and state not in ('cancel',)",
    "(datetime.date.today() - relativedelta(days=7)).strftime('%Y-%m-%d')",
  ];

  it('parses every conditional expression quoted in the spec', () => {
    for (const source of SPEC_EXPRESSIONS) {
      expect(() => parse(source), source).not.toThrow();
    }
  });
});
