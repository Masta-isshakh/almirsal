import { describe, expect, it } from 'vitest';
import { actionHref, actionQuery, readActionQuery } from '../lib/client/action-query.js';

function readHref(href: string) {
  return readActionQuery(Object.fromEntries(new URL(href, 'http://localhost').searchParams));
}

describe('window action navigation', () => {
  it('keeps the account filter and unreconciled constraint together', () => {
    const domain = [['account_id', '=', 42], ['reconciled', '=', false]];
    const context = { search_default_posted: 1, default_account_id: 42 };
    const href = actionHref('journal-items', null, domain, context);
    expect(new URL(href, 'http://localhost').pathname).toBe('/odoo/journal-items');
    expect(readHref(href)).toEqual({ domain, context });
  });

  it('preserves an OR with id restrictions instead of selecting one id leaf', () => {
    const domain = ['&', ['account_id', '=', 42], '|', ['id', 'in', [2, 3]], ['id', 'in', [8, 9]]];
    expect(readHref(actionHref('journal-items', null, domain)).domain).toEqual(domain);
  });

  it('keeps empty ids so an action with no matching journal items stays empty', () => {
    const domain = [['id', 'in', []]];
    expect(readHref(actionHref('journal-items', null, domain)).domain).toEqual(domain);
    expect(readHref(actionHref('journal-items', null, [])).domain).toEqual([]);
  });

  it('keeps context on forms and encodes punctuation and Arabic correctly', () => {
    const context = { active_id: 42, active_ids: [42], active_model: 'account.account', active_test: false, default_name: 'الحساب & tax + cash / #1' };
    const href = actionHref('m/account.move.line', 9, undefined, context);
    expect(new URL(href, 'http://localhost').pathname).toBe('/odoo/m/account.move.line/9');
    expect(readHref(href).context).toEqual(context);
    expect(href).not.toContain('#1');
  });

  it('treats absent domains as absent and preserves false/null context values', () => {
    for (const domain of [undefined, null, false]) expect(actionQuery(domain)).toBe('');
    expect(readHref(actionHref('accounts', null, null, { active_test: false, default_currency_id: null })).context)
      .toEqual({ active_test: false, default_currency_id: null });
  });

  it('ignores malformed URL state and never evaluates source strings', () => {
    for (const domain of ['[', 'false', '{}', '["|"]', '[["id", "unsupported", 1]]', "[('id', '=', 4)]"]) {
      expect(readActionQuery({ domain }).domain).toBeUndefined();
    }
    for (const context of ['[', 'false', '[]', '"context.get(\"uid\")"']) {
      expect(readActionQuery({ context }).context).toBeUndefined();
    }
  });

  it('accepts nested relation domains and boolean sentinel leaves', () => {
    const domain = ['|', [0, '=', 1], ['line_ids', 'any', [['account_id', '=', 42]]]];
    expect(readHref(actionHref('journal-entries', null, domain)).domain).toEqual(domain);
  });

  it('drops object prototype keys before merging context', () => {
    const context = JSON.parse('{"__proto__":{"polluted":true},"constructor":1,"prototype":2,"active_test":false}');
    expect(readActionQuery({ context: JSON.stringify(context) }).context).toEqual({ active_test: false });
    expect(readHref(actionHref('accounts', null, undefined, context)).context).toEqual({ active_test: false });
  });
});
