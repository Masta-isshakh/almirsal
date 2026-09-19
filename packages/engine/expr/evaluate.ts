import { parse } from './parse.js';
import type { CompareOperator, Node } from './ast.js';
import {
  PyDate,
  PyDateTime,
  PyTimeDelta,
  RelativeDelta,
  applyRelativeDelta,
  applyTimeDelta,
  isTemporal,
  subtractTemporal,
  type RelativeDeltaOptions,
} from './pydate.js';
import {
  BUILTINS,
  isDict,
  pyBool,
  pyEq,
  pyFloat,
  pyGe,
  pyGt,
  pyIn,
  pyInt,
  pyLe,
  pyLt,
  pyStr,
} from './values.js';

export class ExprEvalError extends Error {
  readonly source?: string;

  constructor(message: string, source?: string) {
    super(source ? `${message} — in ${JSON.stringify(source)}` : message);
    this.name = 'ExprEvalError';
    this.source = source;
  }
}

/* ------------------------------------------------------------------ *
 * Scope
 * ------------------------------------------------------------------ */

export interface ScopeOptions {
  /**
   * Field values of the record the expression is evaluated against.
   * Values must be ORM-normalised: many2one as an id or `false`, x2many as an
   * id array, empty char as `false` or `''`, dates as ISO strings.
   */
  record?: Record<string, unknown>;
  /** The `parent` record, for expressions inside an embedded x2many view. */
  parent?: Record<string, unknown> | null;
  /** The evaluation context (`context.get('...')`). */
  context?: Record<string, unknown>;
  /** Current `res.users` id. */
  uid?: number;
  /** Companies currently selected in the company switcher. */
  allowedCompanyIds?: number[];
  activeId?: number | false;
  activeIds?: number[];
  activeModel?: string;
  /** "Now" already converted to the user's timezone. */
  now?: PyDateTime;
  /** Resolve an xml id to a database id, for `ref('module.xml_id')`. */
  ref?: (xmlId: string) => number | false;
  /** Extra names merged last, overriding everything else. */
  extra?: Record<string, unknown>;
  /** Throw on an unknown name instead of returning `false`. Default true. */
  strictNames?: boolean;
}

export interface EvalScope {
  names: Record<string, unknown>;
  record: Record<string, unknown>;
  strictNames: boolean;
}

class PyModule {
  constructor(
    readonly moduleName: string,
    readonly members: Record<string, unknown>,
  ) {}
}

/** Class-like object exposing static members (`datetime.date.today()`). */
class PyClass {
  constructor(
    readonly className: string,
    readonly members: Record<string, unknown>,
  ) {}
}

function buildDateGlobals(now: PyDateTime) {
  const dateClass = new PyClass('date', {
    today: () => new PyDate(now.year, now.month, now.day),
    fromordinal: (value: unknown) => PyDate.fromDays(pyInt(value)),
    // `date(2026, 1, 31)` used as a constructor.
    __call__: (y: unknown, m: unknown, d: unknown) => new PyDate(pyInt(y), pyInt(m), pyInt(d)),
  });

  const datetimeClass = new PyClass('datetime', {
    now: () => now,
    today: () => now,
    utcnow: () => now,
    combine: (date: unknown, _time: unknown) =>
      (date instanceof PyDate ? new PyDateTime(date.year, date.month, date.day) : now),
    __call__: (y: unknown, m: unknown, d: unknown, hh?: unknown, mm?: unknown, ss?: unknown) =>
      new PyDateTime(pyInt(y), pyInt(m), pyInt(d), pyInt(hh ?? 0), pyInt(mm ?? 0), pyInt(ss ?? 0)),
  });

  const timedeltaFactory = (...args: unknown[]) => new PyTimeDelta({ days: pyFloat(args[0] ?? 0) });

  const datetimeModule = new PyModule('datetime', {
    date: dateClass,
    datetime: datetimeClass,
    timedelta: timedeltaFactory,
  });

  const timeModule = new PyModule('time', {
    strftime: (format: unknown) => now.strftime(pyStr(format)),
    time: () => now.epochSeconds,
  });

  return { dateClass, datetimeClass, datetimeModule, timeModule, timedeltaFactory };
}

const RELATIVEDELTA_KEYS: (keyof RelativeDeltaOptions)[] = [
  'years', 'months', 'weeks', 'days', 'hours', 'minutes', 'seconds', 'microseconds',
  'year', 'month', 'day', 'hour', 'minute', 'second', 'microsecond', 'weekday',
];

export function makeScope(options: ScopeOptions = {}): EvalScope {
  const record = options.record ?? {};
  const context = options.context ?? {};
  const now = options.now ?? PyDateTime.fromJsUtc(new Date());
  const globals = buildDateGlobals(now);
  const today = new PyDate(now.year, now.month, now.day);

  const contextDict: Record<string, unknown> = { ...context };

  const names: Record<string, unknown> = {
    ...BUILTINS,

    // Odoo evaluation globals.
    context: contextDict,
    uid: options.uid ?? false,
    allowed_company_ids: options.allowedCompanyIds ?? [],
    active_id: options.activeId ?? false,
    active_ids: options.activeIds ?? [],
    active_model: options.activeModel ?? false,

    // `today` / `now` are the string forms Odoo injects into domains.
    today: today.toString(),
    now: now.toString(),
    current_date: today.toString(),

    datetime: globals.datetimeModule,
    time: globals.timeModule,
    date: globals.dateClass,
    timedelta: globals.timedeltaFactory,

    context_today: () => today,
    relativedelta: (...args: unknown[]) => {
      // Only keyword arguments are meaningful; they arrive as a trailing dict.
      const kwargs = args.find(isDict) ?? {};
      const built: RelativeDeltaOptions = {};
      for (const key of RELATIVEDELTA_KEYS) {
        if (key in kwargs) {
          const raw = (kwargs as Record<string, unknown>)[key];
          (built as Record<string, unknown>)[key] = key === 'weekday' ? raw : pyFloat(raw);
        }
      }
      return new RelativeDelta(built);
    },
    ref: (xmlId: unknown) => (options.ref ? options.ref(pyStr(xmlId)) : false),

    parent: options.parent ?? false,

    ...record,
    ...(options.extra ?? {}),
  };

  return {
    names,
    record,
    strictNames: options.strictNames ?? true,
  };
}

/* ------------------------------------------------------------------ *
 * Member access
 * ------------------------------------------------------------------ */

const STRING_METHODS: Record<string, (self: string, ...args: unknown[]) => unknown> = {
  startswith: (self, prefix) => self.startsWith(pyStr(prefix)),
  endswith: (self, suffix) => self.endsWith(pyStr(suffix)),
  lower: (self) => self.toLowerCase(),
  upper: (self) => self.toUpperCase(),
  strip: (self) => self.trim(),
  lstrip: (self) => self.replace(/^\s+/, ''),
  rstrip: (self) => self.replace(/\s+$/, ''),
  split: (self, sep) => (sep == null ? self.split(/\s+/) : self.split(pyStr(sep))),
  join: (self, items) => (Array.isArray(items) ? items.map(pyStr).join(self) : ''),
  replace: (self, from, to) => self.split(pyStr(from)).join(pyStr(to)),
  format: (self, ...args) => args.reduce<string>((text, arg) => text.replace('{}', pyStr(arg)), self),
  count: (self, needle) => self.split(pyStr(needle)).length - 1,
  find: (self, needle) => self.indexOf(pyStr(needle)),
  title: (self) => self.replace(/\w\S*/g, (word) => word[0].toUpperCase() + word.slice(1).toLowerCase()),
};

const LIST_METHODS: Record<string, (self: unknown[], ...args: unknown[]) => unknown> = {
  count: (self, needle) => self.filter((item) => pyEq(item, needle)).length,
  index: (self, needle) => self.findIndex((item) => pyEq(item, needle)),
};

function dictMethods(self: Record<string, unknown>): Record<string, unknown> {
  return {
    get: (key: unknown, fallback?: unknown) => {
      const name = pyStr(key);
      if (name in self) return self[name];
      return fallback === undefined ? false : fallback;
    },
    keys: () => Object.keys(self),
    values: () => Object.values(self),
    items: () => Object.entries(self).map(([key, value]) => [key, value]),
    has_key: (key: unknown) => pyStr(key) in self,
  };
}

function temporalMembers(value: PyDate | PyDateTime): Record<string, unknown> {
  const shared: Record<string, unknown> = {
    strftime: (format: unknown) => value.strftime(pyStr(format)),
    isoformat: () => value.isoformat(),
    weekday: () => value.weekday(),
    year: value.year,
    month: value.month,
    day: value.day,
    replace: (...args: unknown[]) => {
      const kwargs = (args.find(isDict) ?? {}) as Record<string, unknown>;
      const numeric: Record<string, number> = {};
      for (const key of ['year', 'month', 'day', 'hour', 'minute', 'second']) {
        if (key in kwargs) numeric[key] = pyInt(kwargs[key]);
      }
      return value.replace(numeric as never);
    },
  };
  if (value instanceof PyDateTime) {
    shared.date = () => value.date();
    shared.hour = value.hour;
    shared.minute = value.minute;
    shared.second = value.second;
    shared.timestamp = () => value.epochSeconds;
  } else {
    shared.toordinal = () => value.toOrdinal();
    shared.isoweekday = () => value.isoweekday();
  }
  return shared;
}

function getMember(target: unknown, attr: string, source: string): unknown {
  if (target instanceof PyModule || target instanceof PyClass) {
    if (attr in target.members) return target.members[attr];
    throw new ExprEvalError(`${target instanceof PyModule ? target.moduleName : target.className} has no member ${attr}`, source);
  }

  if (isTemporal(target)) {
    const members = temporalMembers(target);
    if (attr in members) return members[attr];
    throw new ExprEvalError(`date object has no member ${attr}`, source);
  }

  if (target instanceof PyTimeDelta) {
    if (attr === 'days') return target.days;
    if (attr === 'seconds') return target.totalSeconds % 86400;
    if (attr === 'total_seconds') return () => target.totalSeconds;
    throw new ExprEvalError(`timedelta has no member ${attr}`, source);
  }

  if (typeof target === 'string') {
    const method = STRING_METHODS[attr];
    if (method) return (...args: unknown[]) => method(target, ...args);
    throw new ExprEvalError(`str has no member ${attr}`, source);
  }

  if (Array.isArray(target)) {
    const method = LIST_METHODS[attr];
    if (method) return (...args: unknown[]) => method(target, ...args);
    throw new ExprEvalError(`list has no member ${attr}`, source);
  }

  if (isDict(target)) {
    const methods = dictMethods(target);
    if (attr in methods) return methods[attr];
    // `parent.field` reaches a record passed in as a plain object.
    if (attr in target) return target[attr];
    return false;
  }

  // `parent` is `false` when there is no parent record; Odoo would raise, but
  // returning a falsy value keeps conditional attributes evaluable.
  if (target === false || target === null || target === undefined) return false;

  throw new ExprEvalError(`Cannot read member ${attr}`, source);
}

/* ------------------------------------------------------------------ *
 * Operators
 * ------------------------------------------------------------------ */

function applyBinary(op: string, left: unknown, right: unknown, source: string): unknown {
  // Date arithmetic first: date ± relativedelta/timedelta, date - date.
  if (op === '+' || op === '-') {
    const sign = op === '+' ? 1 : -1;
    if (isTemporal(left) && right instanceof RelativeDelta) {
      return applyRelativeDelta(left, right, sign);
    }
    if (isTemporal(left) && right instanceof PyTimeDelta) {
      return applyTimeDelta(left, right, sign);
    }
    if (op === '+' && left instanceof RelativeDelta && isTemporal(right)) {
      return applyRelativeDelta(right, left, 1);
    }
    if (op === '-' && isTemporal(left) && isTemporal(right)) {
      return subtractTemporal(left, right);
    }
  }

  // String concatenation and list concatenation.
  if (op === '+') {
    if (typeof left === 'string' && typeof right === 'string') return left + right;
    if (Array.isArray(left) && Array.isArray(right)) return [...left, ...right];
  }

  // `%` doubles as printf-style formatting on strings.
  if (op === '%' && typeof left === 'string') {
    return formatPercent(left, right);
  }

  if (op === '*') {
    if (typeof left === 'string' && typeof right === 'number') return left.repeat(Math.max(0, pyInt(right)));
    if (Array.isArray(left) && typeof right === 'number') {
      const out: unknown[] = [];
      for (let i = 0; i < pyInt(right); i += 1) out.push(...left);
      return out;
    }
  }

  const a = pyFloat(left);
  const b = pyFloat(right);
  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/':
      if (b === 0) throw new ExprEvalError('Division by zero', source);
      return a / b;
    case '//':
      if (b === 0) throw new ExprEvalError('Division by zero', source);
      return Math.floor(a / b);
    case '%':
      if (b === 0) throw new ExprEvalError('Modulo by zero', source);
      // Python's modulo takes the sign of the divisor.
      return ((a % b) + b) % b;
    case '**': return a ** b;
    case '|': return pyInt(left) | pyInt(right);
    case '&': return pyInt(left) & pyInt(right);
    case '^': return pyInt(left) ^ pyInt(right);
    default:
      throw new ExprEvalError(`Unsupported operator ${op}`, source);
  }
}

function formatPercent(template: string, args: unknown): string {
  if (isDict(args)) {
    return template.replace(/%\((\w+)\)[sdifr]/g, (_match, key: string) => pyStr(args[key]));
  }
  const list = Array.isArray(args) ? [...args] : [args];
  let index = 0;
  return template.replace(/%[sdifr]/g, () => pyStr(list[index++]));
}

function compareOnce(op: CompareOperator, left: unknown, right: unknown): boolean {
  switch (op) {
    case '==': return pyEq(left, right);
    case '!=': return !pyEq(left, right);
    case '<': return pyLt(left, right);
    case '<=': return pyLe(left, right);
    case '>': return pyGt(left, right);
    case '>=': return pyGe(left, right);
    case 'in': return pyIn(left, right);
    case 'not in': return !pyIn(left, right);
    // `is` / `is not` are only ever used against None/True/False in Odoo.
    case 'is': return left === right || (left == null && right == null);
    case 'is not': return !(left === right || (left == null && right == null));
    default: return false;
  }
}

/* ------------------------------------------------------------------ *
 * Evaluation
 * ------------------------------------------------------------------ */

function evalNode(node: Node, scope: EvalScope, source: string): unknown {
  switch (node.type) {
    case 'Num': return node.value;
    case 'Str': return node.value;
    case 'Const': return node.value;

    case 'Name': {
      if (node.id in scope.names) return scope.names[node.id];
      if (scope.strictNames) {
        throw new ExprEvalError(`Unknown name ${JSON.stringify(node.id)}`, source);
      }
      return false;
    }

    case 'Tuple':
    case 'List':
      return node.elements.map((element) => evalNode(element, scope, source));

    case 'Set':
      return new Set(node.elements.map((element) => evalNode(element, scope, source)));

    case 'Dict': {
      const out: Record<string, unknown> = {};
      node.keys.forEach((key, index) => {
        out[pyStr(evalNode(key, scope, source))] = evalNode(node.values[index], scope, source);
      });
      return out;
    }

    case 'UnaryOp': {
      const operand = evalNode(node.operand, scope, source);
      switch (node.op) {
        case 'not': return !pyBool(operand);
        case '-':
          if (operand instanceof RelativeDelta) return operand.negate();
          if (operand instanceof PyTimeDelta) return operand.negate();
          return -pyFloat(operand);
        case '+': return pyFloat(operand);
        case '~': return ~pyInt(operand);
        default: return false;
      }
    }

    case 'BinOp':
      return applyBinary(
        node.op,
        evalNode(node.left, scope, source),
        evalNode(node.right, scope, source),
        source,
      );

    case 'BoolOp': {
      // Python returns the operand itself, not a boolean.
      let result: unknown = node.op === 'and';
      for (const value of node.values) {
        result = evalNode(value, scope, source);
        const truthy = pyBool(result);
        if (node.op === 'and' && !truthy) return result;
        if (node.op === 'or' && truthy) return result;
      }
      return result;
    }

    case 'Compare': {
      let left = evalNode(node.left, scope, source);
      for (let i = 0; i < node.ops.length; i += 1) {
        const right = evalNode(node.comparators[i], scope, source);
        if (!compareOnce(node.ops[i], left, right)) return false;
        left = right;
      }
      return true;
    }

    case 'IfExp':
      return pyBool(evalNode(node.test, scope, source))
        ? evalNode(node.body, scope, source)
        : evalNode(node.orelse, scope, source);

    case 'Attribute':
      return getMember(evalNode(node.value, scope, source), node.attr, source);

    case 'Subscript': {
      const target = evalNode(node.value, scope, source);
      const index = evalNode(node.index, scope, source);
      if (Array.isArray(target)) {
        const position = pyInt(index);
        return target[position < 0 ? target.length + position : position];
      }
      if (typeof target === 'string') {
        const position = pyInt(index);
        return target[position < 0 ? target.length + position : position] ?? '';
      }
      if (isDict(target)) {
        const key = pyStr(index);
        if (key in target) return target[key];
        throw new ExprEvalError(`KeyError: ${key}`, source);
      }
      return false;
    }

    case 'Call': {
      const callee = evalNode(node.func, scope, source);
      const args = node.args.map((arg) => evalNode(arg, scope, source));
      if (node.keywords.length > 0) {
        const kwargs: Record<string, unknown> = {};
        for (const keyword of node.keywords) {
          kwargs[keyword.name] = evalNode(keyword.value, scope, source);
        }
        args.push(kwargs);
      }

      // `date(...)` / `datetime(...)` used as constructors.
      const target = callee instanceof PyClass ? callee.members.__call__ : callee;
      if (typeof target !== 'function') {
        throw new ExprEvalError('Attempted to call a non-callable value', source);
      }
      return (target as (...callArgs: unknown[]) => unknown)(...args);
    }

    default:
      throw new ExprEvalError('Unsupported expression node', source);
  }
}

/** Evaluate an expression source string and return its Python-ish value. */
export function evaluate(source: string, scope: EvalScope | ScopeOptions = {}): unknown {
  const resolved: EvalScope = 'names' in scope ? scope : makeScope(scope);
  return evalNode(parse(source), resolved, source);
}

/** Evaluate and coerce to a boolean with Python truthiness. */
export function evaluateBoolean(source: string, scope: EvalScope | ScopeOptions = {}): boolean {
  return pyBool(evaluate(source, scope));
}

/**
 * Evaluate a view-attribute condition (`invisible`, `readonly`, `required`,
 * `column_invisible`). The literal strings "1"/"0"/"True"/"False" shortcut,
 * and any evaluation error resolves to `fallback` after logging, so a bad
 * attribute degrades one widget instead of breaking the view.
 */
export function evalCondition(
  condition: boolean | string | undefined,
  scope: EvalScope | ScopeOptions = {},
  fallback = false,
  onError?: (error: unknown, source: string) => void,
): boolean {
  if (condition === undefined || condition === null) return fallback;
  if (typeof condition === 'boolean') return condition;

  const trimmed = condition.trim();
  if (trimmed === '' ) return fallback;
  if (trimmed === '1' || trimmed === 'True') return true;
  if (trimmed === '0' || trimmed === 'False') return false;

  try {
    return evaluateBoolean(trimmed, scope);
  } catch (error) {
    if (onError) onError(error, trimmed);
    return fallback;
  }
}

export { parse };
