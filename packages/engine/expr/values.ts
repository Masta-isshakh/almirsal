import {
  PyDate,
  PyDateTime,
  PyTimeDelta,
  isTemporal,
} from './pydate.js';

/**
 * Python value semantics for the expression evaluator.
 *
 * Deliberate deviation from CPython: ordering comparisons never throw.
 * Python raises `TypeError` for `False < '2020-01-01'`, but a raised error
 * inside an `invisible=` attribute would break the whole view, so mismatched
 * operands are coerced to a comparable pair instead. Every other rule below
 * (truthiness, `==`, `in`, numeric/boolean equivalence) follows Python.
 */

/** Odoo sends an empty many2one as `false` and an empty x2many as `[]`. */
export type PyValue = unknown;

export function isDict(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !isTemporal(value) &&
    !(value instanceof PyTimeDelta) &&
    !(value instanceof Set) &&
    !(value instanceof Map)
  );
}

/** Python truthiness. */
export function pyBool(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === true) return true;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Set || value instanceof Map) return value.size > 0;
  if (isTemporal(value)) return true;
  if (value instanceof PyTimeDelta) return value.totalSeconds !== 0;
  if (isDict(value)) return Object.keys(value).length > 0;
  return true;
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return null;
}

/** Python `==`, including `True == 1` and structural list/dict equality. */
export function pyEq(left: unknown, right: unknown): boolean {
  if (left === right) return true;

  // None is only equal to None. Odoo's `False` is a distinct value.
  const leftNone = left === null || left === undefined;
  const rightNone = right === null || right === undefined;
  if (leftNone || rightNone) return leftNone && rightNone;

  const leftNum = numeric(left);
  const rightNum = numeric(right);
  if (leftNum !== null && rightNum !== null) return leftNum === rightNum;

  if (isTemporal(left) || isTemporal(right)) {
    return temporalKey(left) === temporalKey(right);
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    return left.every((item, index) => pyEq(item, right[index]));
  }

  if (left instanceof Set && right instanceof Set) {
    if (left.size !== right.size) return false;
    for (const item of left) {
      if (![...right].some((other) => pyEq(item, other))) return false;
    }
    return true;
  }

  if (isDict(left) && isDict(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => key in right && pyEq(left[key], right[key]));
  }

  return false;
}

function temporalKey(value: unknown): string {
  if (isTemporal(value)) return value.toString();
  if (typeof value === 'string') {
    // Normalise so a date compares equal to its ISO serialisation.
    return value.trim().replace('T', ' ');
  }
  return String(value);
}

/**
 * Ordering key. Returns a number when both sides are numeric-ish, otherwise a
 * string, and always returns the same kind for both operands.
 */
function orderingPair(left: unknown, right: unknown): [number, number] | [string, string] {
  if (isTemporal(left) || isTemporal(right)) {
    return [temporalKey(left), temporalKey(right)];
  }
  if (left instanceof PyTimeDelta || right instanceof PyTimeDelta) {
    const toSeconds = (value: unknown) =>
      value instanceof PyTimeDelta ? value.totalSeconds : (numeric(value) ?? 0);
    return [toSeconds(left), toSeconds(right)];
  }

  const leftNum = numeric(left);
  const rightNum = numeric(right);
  if (leftNum !== null && rightNum !== null) return [leftNum, rightNum];

  if (typeof left === 'string' && typeof right === 'string') return [left, right];

  // Mixed. Coerce the empty/None side to the neutral value of the other type
  // rather than raising, so a view attribute can never crash the client.
  const leftEmpty = left === false || left === null || left === undefined;
  const rightEmpty = right === false || right === null || right === undefined;
  if (typeof left === 'string' || typeof right === 'string') {
    const asString = (value: unknown, empty: boolean) =>
      empty ? '' : (typeof value === 'string' ? value : String(value));
    return [asString(left, leftEmpty), asString(right, rightEmpty)];
  }
  return [leftNum ?? 0, rightNum ?? 0];
}

export function pyLt(left: unknown, right: unknown): boolean {
  const [a, b] = orderingPair(left, right);
  return a < b;
}

export function pyLe(left: unknown, right: unknown): boolean {
  const [a, b] = orderingPair(left, right);
  return a <= b;
}

export function pyGt(left: unknown, right: unknown): boolean {
  return pyLt(right, left);
}

export function pyGe(left: unknown, right: unknown): boolean {
  return pyLe(right, left);
}

/** Python `in`: substring for strings, membership for sequences, keys for dicts. */
export function pyIn(needle: unknown, haystack: unknown): boolean {
  if (typeof haystack === 'string') {
    if (typeof needle !== 'string') return false;
    return haystack.includes(needle);
  }
  if (Array.isArray(haystack)) {
    return haystack.some((item) => pyEq(item, needle));
  }
  if (haystack instanceof Set) {
    return [...haystack].some((item) => pyEq(item, needle));
  }
  if (haystack instanceof Map) {
    return [...haystack.keys()].some((item) => pyEq(item, needle));
  }
  if (isDict(haystack)) {
    return typeof needle === 'string' && needle in haystack;
  }
  return false;
}

/** Python `str()`. */
export function pyStr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'string') return value;
  if (isTemporal(value)) return value.toString();
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
  if (isDict(value)) {
    const body = Object.entries(value)
      .map(([key, item]) => `${pyRepr(key)}: ${pyRepr(item)}`)
      .join(', ');
    return `{${body}}`;
  }
  return String(value);
}

export function pyRepr(value: unknown): string {
  if (typeof value === 'string') return `'${value.replace(/'/g, "\\'")}'`;
  return pyStr(value);
}

export function pyLen(value: unknown): number {
  if (typeof value === 'string' || Array.isArray(value)) return value.length;
  if (value instanceof Set || value instanceof Map) return value.size;
  if (isDict(value)) return Object.keys(value).length;
  if (value === null || value === undefined || value === false) return 0;
  return 0;
}

function iterate(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [...value];
  if (value instanceof Set) return [...value];
  if (value instanceof Map) return [...value.keys()];
  if (isDict(value)) return Object.keys(value);
  if (value === null || value === undefined || value === false) return [];
  return [value];
}

/** Python's `int()`: truncates towards zero, accepts numeric strings. */
export function pyInt(value: unknown): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Math.trunc(value);
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    return Number.isNaN(parsed) ? 0 : Math.trunc(parsed);
  }
  return 0;
}

export function pyFloat(value: unknown): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/** Python 3 `round()` uses banker's rounding. */
export function pyRound(value: number, digits = 0): number {
  const factor = 10 ** digits;
  const scaled = value * factor;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let rounded: number;
  if (Math.abs(diff - 0.5) < Number.EPSILON * Math.max(1, Math.abs(scaled))) {
    rounded = floor % 2 === 0 ? floor : floor + 1;
  } else {
    rounded = Math.round(scaled);
  }
  return rounded / factor;
}

/** Builtins exposed to every expression. */
export const BUILTINS: Record<string, unknown> = {
  bool: (value: unknown) => pyBool(value),
  len: (value: unknown) => pyLen(value),
  str: (value: unknown) => pyStr(value),
  int: (value: unknown) => pyInt(value),
  float: (value: unknown) => pyFloat(value),
  abs: (value: unknown) => Math.abs(pyFloat(value)),
  round: (value: unknown, digits?: unknown) => pyRound(pyFloat(value), digits == null ? 0 : pyInt(digits)),
  any: (value: unknown) => iterate(value).some(pyBool),
  all: (value: unknown) => iterate(value).every(pyBool),
  sum: (value: unknown, start?: unknown) =>
    iterate(value).reduce<number>((total, item) => total + pyFloat(item), start == null ? 0 : pyFloat(start)),
  min: (...args: unknown[]) => {
    const items = args.length === 1 ? iterate(args[0]) : args;
    return items.reduce((best, item) => (pyLt(item, best) ? item : best), items[0]);
  },
  max: (...args: unknown[]) => {
    const items = args.length === 1 ? iterate(args[0]) : args;
    return items.reduce((best, item) => (pyGt(item, best) ? item : best), items[0]);
  },
  sorted: (value: unknown) => [...iterate(value)].sort((a, b) => (pyLt(a, b) ? -1 : pyLt(b, a) ? 1 : 0)),
  list: (value: unknown) => [...iterate(value)],
  tuple: (value: unknown) => [...iterate(value)],
  set: (value: unknown) => new Set(iterate(value)),
  dict: (value: unknown) => (isDict(value) ? { ...value } : {}),
  range: (start: unknown, stop?: unknown, step?: unknown) => {
    const from = stop == null ? 0 : pyInt(start);
    const to = stop == null ? pyInt(start) : pyInt(stop);
    const by = step == null ? 1 : pyInt(step);
    const out: number[] = [];
    if (by === 0) return out;
    for (let i = from; by > 0 ? i < to : i > to; i += by) out.push(i);
    return out;
  },
};

export { PyDate, PyDateTime, PyTimeDelta };
