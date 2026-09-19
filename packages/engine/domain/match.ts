import type { Domain, DomainOperator } from '../registry/types.js';
import { pyEq, pyGe, pyGt, pyLe, pyLt } from '../expr/values.js';
import { parseDomain, type DomainNode } from './normalize.js';

/**
 * Client-side domain matching, used wherever the browser already holds the
 * record: kanban quick filters, `onchange` domain checks, optional-column
 * visibility, and the "does this new record still belong in this group" test
 * after an inline edit.
 *
 * Relational operators that need other records (`child_of`, `parent_of`,
 * `any`, `not any`, and dotted paths) are delegated to the optional resolver;
 * without one they evaluate to `false` rather than guessing.
 */

export interface MatchOptions {
  /**
   * Read a dotted path such as `partner_id.country_id.code` starting from the
   * record. Return `undefined` when the value cannot be resolved locally.
   */
  resolvePath?: (record: Record<string, unknown>, path: string) => unknown;
  /** Ids of every ancestor/descendant, for `child_of` / `parent_of`. */
  resolveHierarchy?: (
    field: string,
    value: unknown,
    direction: 'child_of' | 'parent_of',
  ) => number[] | undefined;
  /** Match a subdomain against the records a relational field points at. */
  resolveAny?: (
    record: Record<string, unknown>,
    field: string,
    subdomain: Domain,
  ) => boolean | undefined;
  /** Called when a leaf cannot be evaluated locally. */
  onUnsupported?: (field: string, op: DomainOperator) => void;
}

/** Odoo sends a many2one as `[id, display_name]` in some payloads. */
function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'number' && typeof value[1] === 'string') {
    return value[0];
  }
  return value;
}

function isEmpty(value: unknown): boolean {
  return value === false || value === null || value === undefined || value === '';
}

/** Turn a SQL LIKE pattern into a regular expression. */
function likeToRegExp(pattern: string, caseInsensitive: boolean): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const translated = escaped.replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${translated}$`, caseInsensitive ? 'is' : 's');
}

function textOf(value: unknown): string {
  if (value === null || value === undefined || value === false) return '';
  if (Array.isArray(value)) {
    const normalized = normalizeValue(value);
    return normalized === value ? value.map(textOf).join(',') : textOf(normalized);
  }
  return String(value);
}

function matchLike(
  fieldValue: unknown,
  pattern: unknown,
  options: { anchored: boolean; caseInsensitive: boolean; negated: boolean },
): boolean {
  const haystack = textOf(fieldValue);
  const raw = textOf(pattern);
  // `like`/`ilike` wrap the pattern in %...%; `=like`/`=ilike` do not.
  const effective = options.anchored ? raw : `%${raw}%`;
  const matched = likeToRegExp(effective, options.caseInsensitive).test(haystack);
  return options.negated ? !matched : matched;
}

function matchLeaf(
  record: Record<string, unknown>,
  field: string,
  op: DomainOperator,
  value: unknown,
  options: MatchOptions,
): boolean {
  // Dotted path: needs a resolver.
  let fieldValue: unknown;
  if (field.includes('.')) {
    const resolved = options.resolvePath?.(record, field);
    if (resolved === undefined) {
      options.onUnsupported?.(field, op);
      return false;
    }
    fieldValue = resolved;
  } else {
    fieldValue = record[field];
  }

  fieldValue = normalizeValue(fieldValue);
  const target = normalizeValue(value);

  switch (op) {
    case '=': {
      // `('field','=',False)` means "empty", which covers NULL, '' and [].
      if (isEmpty(target)) {
        if (Array.isArray(fieldValue)) return fieldValue.length === 0;
        return isEmpty(fieldValue);
      }
      // A leaf against an x2many is a membership test.
      if (Array.isArray(fieldValue)) return fieldValue.some((item) => pyEq(normalizeValue(item), target));
      return pyEq(fieldValue, target);
    }

    case '!=':
      return !matchLeaf(record, field, '=', value, options);

    case '>': return !isEmpty(fieldValue) && pyGt(fieldValue, target);
    case '>=': return !isEmpty(fieldValue) && pyGe(fieldValue, target);
    case '<': return !isEmpty(fieldValue) && pyLt(fieldValue, target);
    case '<=': return !isEmpty(fieldValue) && pyLe(fieldValue, target);

    case 'in':
    case 'not in': {
      const list = (Array.isArray(target) ? target : [target]).map(normalizeValue);
      const contains = Array.isArray(fieldValue)
        ? fieldValue.some((item) => list.some((candidate) => pyEq(normalizeValue(item), candidate)))
        : list.some((candidate) => (isEmpty(candidate) ? isEmpty(fieldValue) : pyEq(fieldValue, candidate)));
      return op === 'in' ? contains : !contains;
    }

    case 'like':
      return matchLike(fieldValue, target, { anchored: false, caseInsensitive: false, negated: false });
    case 'not like':
      return matchLike(fieldValue, target, { anchored: false, caseInsensitive: false, negated: true });
    case 'ilike':
      return matchLike(fieldValue, target, { anchored: false, caseInsensitive: true, negated: false });
    case 'not ilike':
      return matchLike(fieldValue, target, { anchored: false, caseInsensitive: true, negated: true });
    case '=like':
      return matchLike(fieldValue, target, { anchored: true, caseInsensitive: false, negated: false });
    case '=ilike':
      return matchLike(fieldValue, target, { anchored: true, caseInsensitive: true, negated: false });

    case 'child_of':
    case 'parent_of': {
      const ids = options.resolveHierarchy?.(field, target, op);
      if (ids === undefined) {
        options.onUnsupported?.(field, op);
        return false;
      }
      if (Array.isArray(fieldValue)) {
        return fieldValue.some((item) => ids.includes(Number(normalizeValue(item))));
      }
      return ids.includes(Number(fieldValue));
    }

    case 'any':
    case 'not any': {
      const result = options.resolveAny?.(record, field, target as Domain);
      if (result === undefined) {
        options.onUnsupported?.(field, op);
        return false;
      }
      return op === 'any' ? result : !result;
    }

    default:
      options.onUnsupported?.(field, op);
      return false;
  }
}

function matchNode(
  record: Record<string, unknown>,
  node: DomainNode,
  options: MatchOptions,
): boolean {
  switch (node.type) {
    case 'true': return true;
    case 'false': return false;
    case 'leaf': return matchLeaf(record, node.field, node.op, node.value, options);
    case 'and': return matchNode(record, node.left, options) && matchNode(record, node.right, options);
    case 'or': return matchNode(record, node.left, options) || matchNode(record, node.right, options);
    case 'not': return !matchNode(record, node.child, options);
  }
}

/** Does `record` satisfy `domain`? */
export function domainMatch(
  record: Record<string, unknown>,
  domain: Domain | null | undefined,
  options: MatchOptions = {},
): boolean {
  return matchNode(record, parseDomain(domain), options);
}

/** Filter a list of records by a domain. */
export function filterByDomain<T extends Record<string, unknown>>(
  records: T[],
  domain: Domain | null | undefined,
  options: MatchOptions = {},
): T[] {
  const node = parseDomain(domain);
  if (node.type === 'true') return [...records];
  if (node.type === 'false') return [];
  return records.filter((record) => matchNode(record, node, options));
}

/** Every field name a domain reads, including dotted roots. */
export function domainFields(domain: Domain | null | undefined): string[] {
  const names = new Set<string>();
  const walk = (node: DomainNode): void => {
    switch (node.type) {
      case 'leaf': names.add(node.field); break;
      case 'and':
      case 'or': walk(node.left); walk(node.right); break;
      case 'not': walk(node.child); break;
      default: break;
    }
  };
  walk(parseDomain(domain));
  return [...names];
}
