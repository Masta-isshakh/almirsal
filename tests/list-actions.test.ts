import { describe, expect, it } from 'vitest';
import { changeActive, fetchAllIds, fetchAllRecords, restoreActive, type ListActionRpc } from '../lib/client/list-actions';
import type { RpcOptions } from '../lib/client/rpc';
import type { Domain } from '../packages/engine/registry/types';

interface Call { method: string; model: string | null; params: Record<string, unknown>; options: RpcOptions }
function stub(handler: (call: Call) => Promise<unknown> | unknown) {
  const calls: Call[] = [];
  const call: ListActionRpc = async <T>(method: string, model: string | null, params = {}, options = {}) => {
    const item = { method, model, params, options };
    calls.push(item);
    return await handler(item) as T;
  };
  return { call, calls };
}

function afterId(domain: Domain): number {
  const condition = domain.find((item) => Array.isArray(item) && item[0] === 'id' && item[1] === '>');
  return Array.isArray(condition) ? Number(condition[2]) : 0;
}

describe('list action paging', () => {
  it('resolves every matching id beyond 5,000 with the archived-record context on every page', async () => {
    const domain: Domain = [['active', '=', false], ['account_type', '=', 'expense']];
    const context = { active_test: false, default_company_id: 7 };
    const { call, calls } = stub(({ params }) => {
      const cursor = afterId(params.domain as Domain);
      return Array.from({ length: Math.min(Number(params.limit), 6001 - cursor) }, (_, index) => cursor + index + 1);
    });
    const ids = await fetchAllIds(call, 'account.account', domain, context);
    expect(ids).toHaveLength(6001);
    expect(ids[0]).toBe(1);
    expect(ids.at(-1)).toBe(6001);
    expect(calls).toHaveLength(7);
    for (const item of calls) {
      expect(item.method).toBe('search');
      expect(item.model).toBe('account.account');
      expect(item.options.context).toBe(context);
      expect(item.params.order).toBe('id asc');
      expect(item.params.limit).toBe(1000);
      expect((item.params.domain as Domain).slice(0, 2)).toEqual(domain);
    }
    expect(domain).toEqual([['active', '=', false], ['account_type', '=', 'expense']]);
  });

  it('exports more than 10,000 rows without dropping the domain, columns, or context', async () => {
    const domain: Domain = ['|', ['internal_group', '=', 'asset'], ['internal_group', '=', 'liability']];
    const context = { active_test: false };
    const columns = ['code', 'name'];
    const { call, calls } = stub(({ params }) => {
      const cursor = afterId(params.domain as Domain);
      return Array.from({ length: Math.min(Number(params.limit), 10001 - cursor) }, (_, index) => ({ id: cursor + index + 1, code: `A${cursor + index + 1}` }));
    });
    const rows = await fetchAllRecords<{ id: number; code: string }>(call, 'account.account', domain, columns, context);
    expect(rows).toHaveLength(10001);
    expect(rows.at(-1)).toEqual({ id: 10001, code: 'A10001' });
    expect(calls).toHaveLength(11);
    for (const item of calls) {
      expect(item.method).toBe('searchRead');
      expect(item.params.fields).toBe(columns);
      expect(item.params.order).toBe('id asc');
      expect((item.params.domain as Domain).slice(0, 3)).toEqual(domain);
      expect(item.options.context).toBe(context);
    }
  });

  it('keeps an explicit selected subset as the export domain', async () => {
    const domain: Domain = [['id', 'in', [3, 8]]];
    const { call, calls } = stub(() => [{ id: 3 }, { id: 8 }]);
    expect(await fetchAllRecords(call, 'account.account', domain, ['name'])).toEqual([{ id: 3 }, { id: 8 }]);
    expect(calls[0].params.domain).toBe(domain);
    expect(calls).toHaveLength(1);
  });

  it('surfaces a failed later page instead of producing a partial export', async () => {
    const { call } = stub(({ params }) => {
      if (afterId(params.domain as Domain)) throw new Error('Access denied');
      return Array.from({ length: 1000 }, (_, index) => ({ id: index + 1 }));
    });
    await expect(fetchAllRecords(call, 'account.account', [], ['name'])).rejects.toThrow('Access denied');
  });
});

describe('archive and undo', () => {
  for (const active of [false, true]) {
    it(`${active ? 'unarchives' : 'archives'} only rows that change and restores mixed selections exactly`, async () => {
      const rows = new Map([[1, true], [2, false], [3, true]]);
      const context = { active_test: false, company_id: 4 };
      const { call, calls } = stub(({ method, params }) => {
        const ids = params.ids as number[];
        if (method === 'read') return ids.map((id) => ({ id, active: rows.get(id) }));
        if (method === 'write') for (const id of ids) rows.set(id, (params.values as { active: boolean }).active);
        return true;
      });
      const previous = await changeActive(call, 'account.account', [1, 2, 3, 1], active, context);
      expect(previous.map((row) => row.id)).toEqual(active ? [2] : [1, 3]);
      expect(calls[0].params.ids).toEqual([1, 2, 3]);
      expect([...rows.values()]).toEqual([active, active, active]);
      await restoreActive(call, 'account.account', previous, context);
      expect([...rows.values()]).toEqual([true, false, true]);
      expect(calls.filter((item) => item.method === 'write').map((item) => item.params.ids)).toEqual(active ? [[2], [2]] : [[1, 3], [1, 3]]);
      for (const item of calls) expect(item.options.context).toBe(context);
    });
  }

  it('performs no write when all records already have the requested state', async () => {
    const { call, calls } = stub(() => [{ id: 2, active: false }]);
    expect(await changeActive(call, 'account.account', [2], false)).toEqual([]);
    expect(calls.map((item) => item.method)).toEqual(['read']);
  });

  it('surfaces failed writes so callers cannot show a success or undo result', async () => {
    const { call } = stub(({ method }) => {
      if (method === 'read') return [{ id: 1, active: true }];
      throw new Error('Used accounts cannot be archived');
    });
    await expect(changeActive(call, 'account.account', [1], false)).rejects.toThrow('Used accounts cannot be archived');
  });
});
