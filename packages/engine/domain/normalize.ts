import type { Domain, DomainItem, DomainLeaf, DomainOperator } from '../registry/types.js';

/**
 * Odoo domains are prefix ("polish notation") lists with an implicit `&`
 * between consecutive complete expressions:
 *
 *   ['|', ('a','=',1), ('b','!=',False)]
 *   [('a','=',1), ('b','=',2)]            -> a AND b
 *   ['!', ('a','=',1)]
 *
 * `parseDomain` turns that flat list into a tree so the matcher and the SQL
 * compiler can work on something structured.
 */

export type DomainNode =
  | { type: 'true' }
  | { type: 'false' }
  | { type: 'leaf'; field: string; op: DomainOperator; value: unknown }
  | { type: 'and'; left: DomainNode; right: DomainNode }
  | { type: 'or'; left: DomainNode; right: DomainNode }
  | { type: 'not'; child: DomainNode };

export const TRUE_NODE: DomainNode = { type: 'true' };
export const FALSE_NODE: DomainNode = { type: 'false' };

export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainError';
  }
}

const CONNECTORS = new Set(['&', '|', '!']);

function isLeafItem(item: DomainItem): item is DomainLeaf {
  return Array.isArray(item) && item.length === 3;
}

/** Odoo's TRUE_LEAF / FALSE_LEAF sentinels. */
function leafToNode(leaf: DomainLeaf): DomainNode {
  const [field, op, value] = leaf;
  if (field === 1 as unknown as string && op === '=' && value === 1) return TRUE_NODE;
  if (field === 0 as unknown as string && op === '=' && value === 1) return FALSE_NODE;
  if (field === '1' && op === '=' && (value === 1 || value === '1')) return TRUE_NODE;
  if (field === '0' && op === '=' && (value === 1 || value === '1')) return FALSE_NODE;
  return { type: 'leaf', field: String(field), op, value };
}

export function and(left: DomainNode, right: DomainNode): DomainNode {
  if (left.type === 'true') return right;
  if (right.type === 'true') return left;
  if (left.type === 'false' || right.type === 'false') return FALSE_NODE;
  return { type: 'and', left, right };
}

export function or(left: DomainNode, right: DomainNode): DomainNode {
  if (left.type === 'false') return right;
  if (right.type === 'false') return left;
  if (left.type === 'true' || right.type === 'true') return TRUE_NODE;
  return { type: 'or', left, right };
}

export function not(child: DomainNode): DomainNode {
  if (child.type === 'true') return FALSE_NODE;
  if (child.type === 'false') return TRUE_NODE;
  if (child.type === 'not') return child.child;
  return { type: 'not', child };
}

interface ParseState {
  items: DomainItem[];
  index: number;
}

function parseOne(state: ParseState): DomainNode {
  if (state.index >= state.items.length) {
    throw new DomainError('Malformed domain: ran out of items while parsing an operator');
  }
  const item = state.items[state.index];
  state.index += 1;

  if (typeof item === 'string' && CONNECTORS.has(item)) {
    if (item === '!') return not(parseOne(state));
    const left = parseOne(state);
    const right = parseOne(state);
    return item === '&' ? and(left, right) : or(left, right);
  }

  if (isLeafItem(item)) return leafToNode(item);

  throw new DomainError(`Malformed domain item: ${JSON.stringify(item)}`);
}

/** Parse a flat domain list into a tree, honouring the implicit `&`. */
export function parseDomain(domain: Domain | null | undefined): DomainNode {
  if (!domain || domain.length === 0) return TRUE_NODE;

  const state: ParseState = { items: domain, index: 0 };
  const parts: DomainNode[] = [];
  while (state.index < state.items.length) {
    parts.push(parseOne(state));
  }
  if (parts.length === 0) return TRUE_NODE;
  return parts.reduce((left, right) => and(left, right));
}

/** Serialise a tree back to the flat prefix form. */
export function toDomainList(node: DomainNode): Domain {
  switch (node.type) {
    case 'true': return [['1', '=', 1] as unknown as DomainLeaf];
    case 'false': return [['0', '=', 1] as unknown as DomainLeaf];
    case 'leaf': return [[node.field, node.op, node.value]];
    case 'and': return ['&', ...toDomainList(node.left), ...toDomainList(node.right)];
    case 'or': return ['|', ...toDomainList(node.left), ...toDomainList(node.right)];
    case 'not': return ['!', ...toDomainList(node.child)];
  }
}

/** Insert the explicit `&` connectors Odoo's `normalize_domain` adds. */
export function normalizeDomain(domain: Domain | null | undefined): Domain {
  return toDomainList(parseDomain(domain));
}

/** AND several domains together, skipping empty ones. */
export function combineDomains(
  domains: (Domain | null | undefined)[],
  connector: '&' | '|' = '&',
): Domain {
  const nodes = domains
    .filter((domain): domain is Domain => Boolean(domain && domain.length))
    .map(parseDomain);
  if (nodes.length === 0) return [];
  const combined = nodes.reduce((left, right) => (connector === '&' ? and(left, right) : or(left, right)));
  if (combined.type === 'true') return [];
  return toDomainList(combined);
}

export const NEGATABLE: Record<string, DomainOperator> = {
  '=': '!=',
  '!=': '=',
  '>': '<=',
  '>=': '<',
  '<': '>=',
  '<=': '>',
  in: 'not in',
  'not in': 'in',
  like: 'not like',
  'not like': 'like',
  ilike: 'not ilike',
  'not ilike': 'ilike',
  any: 'not any',
  'not any': 'any',
};
