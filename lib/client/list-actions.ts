import type { Domain } from '@engine/registry/types';
import type { RpcOptions } from './rpc';

export type ListActionRpc = <T = unknown>(method: string, model: string | null, params?: Record<string, unknown>, options?: RpcOptions) => Promise<T>;
export interface ActiveSnapshot { id: number; active: boolean }
const PAGE_SIZE = 1000;

/** Keep the selected domain and context on every page, including archived rows. */
export async function fetchAllIds(call: ListActionRpc, model: string, domain: Domain, context: Record<string, unknown> = {}): Promise<number[]> {
  const ids: number[] = [];
  let cursor = 0;
  for (;;) {
    const page = await call<number[]>('search', model, { domain: cursor ? [...domain, ['id', '>', cursor]] : domain, limit: PAGE_SIZE, order: 'id asc' }, { context });
    ids.push(...page);
    if (page.length < PAGE_SIZE) return ids;
    const next = page[page.length - 1];
    if (next <= cursor) throw new Error('The records could not be paginated.');
    cursor = next;
  }
}

export async function fetchAllRecords<T extends { id: number }>(call: ListActionRpc, model: string, domain: Domain, fields: string[], context: Record<string, unknown> = {}): Promise<T[]> {
  const rows: T[] = [];
  let cursor = 0;
  for (;;) {
    const page = await call<T[]>('searchRead', model, { domain: cursor ? [...domain, ['id', '>', cursor]] : domain, fields, limit: PAGE_SIZE, order: 'id asc' }, { context });
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
    const next = page[page.length - 1].id;
    if (next <= cursor) throw new Error('The records could not be paginated.');
    cursor = next;
  }
}

async function writeActive(call: ListActionRpc, model: string, ids: number[], active: boolean, context: Record<string, unknown>): Promise<void> {
  for (let offset = 0; offset < ids.length; offset += PAGE_SIZE) {
    await call('write', model, { ids: ids.slice(offset, offset + PAGE_SIZE), values: { active } }, { context });
  }
}

/** Only change rows that need it, and retain exactly those rows' original state. */
export async function changeActive(call: ListActionRpc, model: string, ids: number[], active: boolean, context: Record<string, unknown> = {}): Promise<ActiveSnapshot[]> {
  const targets = [...new Set(ids)];
  const previous: ActiveSnapshot[] = [];
  for (let offset = 0; offset < targets.length; offset += PAGE_SIZE) {
    const rows = await call<ActiveSnapshot[]>('read', model, { ids: targets.slice(offset, offset + PAGE_SIZE), fields: ['active'] }, { context });
    previous.push(...rows.map((row) => ({ id: row.id, active: Boolean(row.active) })).filter((row) => row.active !== active));
  }
  await writeActive(call, model, previous.map((row) => row.id), active, context);
  return previous;
}

/** Undo affects changed rows only; mixed active/inactive selections stay mixed. */
export async function restoreActive(call: ListActionRpc, model: string, previous: ActiveSnapshot[], context: Record<string, unknown> = {}): Promise<void> {
  for (const active of [true, false]) {
    await writeActive(call, model, previous.filter((row) => row.active === active).map((row) => row.id), active, context);
  }
}
