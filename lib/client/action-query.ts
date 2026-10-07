import type { Domain } from '@engine/registry/types';
import { parseDomain } from '@engine/domain/normalize';

const OPERATORS = new Set([
  '=', '!=', '>', '>=', '<', '<=', 'like', 'ilike', 'not like', 'not ilike', '=like', '=ilike',
  'in', 'not in', 'child_of', 'parent_of', 'any', 'not any',
]);
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface ActionQuery {
  domain?: Domain;
  context?: Record<string, unknown>;
}

/** JSON domains in a URL are filters; registry domains and record rules still apply. */
function isDomain(value: unknown): value is Domain {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (typeof item === 'string' && ['&', '|', '!'].includes(item)) continue;
    if (!Array.isArray(item) || item.length !== 3 || !OPERATORS.has(item[1])) return false;
    // The expression engine also accepts Odoo's numeric TRUE/FALSE sentinels.
    if (typeof item[0] !== 'string' && item[0] !== 0 && item[0] !== 1) return false;
    if ((item[1] === 'any' || item[1] === 'not any') && !isDomain(item[2])) return false;
  }
  try { parseDomain(value as Domain); return true; } catch { return false; }
}

function contextOf(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !RESERVED_KEYS.has(key)));
}

/** Decode returned action state without evaluating source from the address bar. */
export function readActionQuery(query: Record<string, string | undefined>): ActionQuery {
  const state: ActionQuery = {};
  if (query.domain !== undefined) {
    try {
      const value: unknown = JSON.parse(query.domain);
      if (isDomain(value)) state.domain = value;
    } catch { /* Ignore malformed URL state. */ }
  }
  if (query.context !== undefined) {
    try { state.context = contextOf(JSON.parse(query.context)); } catch { /* Ignore malformed URL state. */ }
  }
  return state;
}

/** Keep the complete returned domain and context, including an empty `id in []`. */
export function actionQuery(domain?: unknown, context?: unknown): string {
  const query = new URLSearchParams();
  if (isDomain(domain)) query.set('domain', JSON.stringify(domain));
  const values = contextOf(context);
  if (values && Object.keys(values).length) query.set('context', JSON.stringify(values));
  const search = query.toString();
  return search ? `?${search}` : '';
}

export function actionHref(slug: string, recordId?: number | 'new' | null, domain?: unknown, context?: unknown): string {
  const path = slug.split('/').map(encodeURIComponent).join('/');
  const record = recordId === 'new' || (typeof recordId === 'number' && recordId > 0) ? `/${recordId}` : '';
  return `/odoo/${path}${record}${actionQuery(domain, context)}`;
}
