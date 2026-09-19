/**
 * Civil date/time values behaving like Python's `datetime` plus
 * `dateutil.relativedelta`, which Odoo uses throughout view contexts and
 * domains, e.g.
 *
 *   (context_today() - relativedelta(days=7)).strftime('%Y-%m-%d')
 *   (datetime.date.today() + relativedelta(months=1, day=1))
 *
 * All arithmetic is done on civil fields via day-number conversion, never on
 * a JS `Date`, so results never shift with the host timezone. The caller
 * injects "now" (already converted to the user's timezone) through the eval
 * scope, which keeps evaluation deterministic and testable.
 */

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const DAY_NAMES = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
];

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month === 2 && isLeapYear(year)) return 29;
  return lengths[month - 1];
}

/** Howard Hinnant's civil-from-days / days-from-civil algorithms. */
export function daysFromCivil(y: number, m: number, d: number): number {
  const year = m <= 2 ? y - 1 : y;
  const era = Math.floor((year >= 0 ? year : year - 399) / 400);
  const yoe = year - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(z: number): [number, number, number] {
  const shifted = z + 719468;
  const era = Math.floor((shifted >= 0 ? shifted : shifted - 146096) / 146097);
  const doe = shifted - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return [m <= 2 ? y + 1 : y, m, d];
}

function pad(value: number, width: number): string {
  return String(Math.abs(value)).padStart(width, '0');
}

export interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  microsecond: number;
}

function formatWith(parts: DateParts, format: string): string {
  const { year, month, day, hour, minute, second, microsecond } = parts;
  const weekday = ((daysFromCivil(year, month, day) % 7) + 10) % 7; // 0 = Monday
  const dayOfYear = daysFromCivil(year, month, day) - daysFromCivil(year, 1, 1) + 1;
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;

  return format.replace(/%[-_]?[a-zA-Z%]/g, (directive) => {
    const noPad = directive.includes('-') || directive.includes('_');
    const code = directive[directive.length - 1];
    const maybePad = (value: number, width: number) => (noPad ? String(value) : pad(value, width));

    switch (code) {
      case 'Y': return String(year);
      case 'y': return pad(year % 100, 2);
      case 'm': return maybePad(month, 2);
      case 'd': return maybePad(day, 2);
      case 'H': return maybePad(hour, 2);
      case 'I': return maybePad(hour12, 2);
      case 'M': return maybePad(minute, 2);
      case 'S': return maybePad(second, 2);
      case 'f': return pad(microsecond, 6);
      case 'p': return hour < 12 ? 'AM' : 'PM';
      case 'j': return maybePad(dayOfYear, 3);
      case 'a': return DAY_NAMES[weekday].slice(0, 3);
      case 'A': return DAY_NAMES[weekday];
      case 'b': return MONTH_NAMES[month - 1].slice(0, 3);
      case 'B': return MONTH_NAMES[month - 1];
      case 'w': return String((weekday + 1) % 7);
      case 'u': return String(weekday + 1);
      case 'U': return pad(Math.floor((dayOfYear + ((daysFromCivil(year, 1, 1) % 7) + 10) % 7) / 7), 2);
      case 'W': return pad(Math.floor((dayOfYear + (((daysFromCivil(year, 1, 1) % 7) + 10) % 7) - 1) / 7), 2);
      case 'Z': return 'UTC';
      case 'z': return '+0000';
      case 'c': return `${DAY_NAMES[weekday].slice(0, 3)} ${MONTH_NAMES[month - 1].slice(0, 3)} ${pad(day, 2)} ${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)} ${year}`;
      case 'x': return `${pad(month, 2)}/${pad(day, 2)}/${pad(year % 100, 2)}`;
      case 'X': return `${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}`;
      case '%': return '%';
      default: return directive;
    }
  });
}

/** Marker so `instanceof`-free checks work across module copies. */
const PY_DATE = Symbol.for('rodeo.pydate');

export class PyDate {
  readonly [PY_DATE] = true;
  readonly year: number;
  readonly month: number;
  readonly day: number;

  constructor(year: number, month: number, day: number) {
    this.year = year;
    this.month = month;
    this.day = day;
  }

  static today(reference: PyDateTime): PyDate {
    return new PyDate(reference.year, reference.month, reference.day);
  }

  static fromDays(days: number): PyDate {
    const [y, m, d] = civilFromDays(days);
    return new PyDate(y, m, d);
  }

  /** Parse 'YYYY-MM-DD' (also tolerates a trailing time part). */
  static parse(value: string): PyDate | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
    if (!match) return null;
    return new PyDate(Number(match[1]), Number(match[2]), Number(match[3]));
  }

  get parts(): DateParts {
    return {
      year: this.year, month: this.month, day: this.day,
      hour: 0, minute: 0, second: 0, microsecond: 0,
    };
  }

  toOrdinal(): number {
    return daysFromCivil(this.year, this.month, this.day);
  }

  /** Python's `date.weekday()`: Monday is 0. */
  weekday(): number {
    return ((this.toOrdinal() % 7) + 10) % 7;
  }

  isoweekday(): number {
    return this.weekday() + 1;
  }

  strftime(format: string): string {
    return formatWith(this.parts, format);
  }

  isoformat(): string {
    return this.toString();
  }

  replace(values: Partial<Pick<PyDate, 'year' | 'month' | 'day'>>): PyDate {
    return new PyDate(
      values.year ?? this.year,
      values.month ?? this.month,
      values.day ?? this.day,
    );
  }

  toString(): string {
    return `${pad(this.year, 4)}-${pad(this.month, 2)}-${pad(this.day, 2)}`;
  }

  valueOf(): number {
    return this.toOrdinal();
  }
}

const PY_DATETIME = Symbol.for('rodeo.pydatetime');

export class PyDateTime {
  readonly [PY_DATETIME] = true;
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly microsecond: number;

  constructor(
    year: number, month: number, day: number,
    hour = 0, minute = 0, second = 0, microsecond = 0,
  ) {
    this.year = year;
    this.month = month;
    this.day = day;
    this.hour = hour;
    this.minute = minute;
    this.second = second;
    this.microsecond = microsecond;
  }

  /** Build from a JS Date read in UTC (the storage convention). */
  static fromJsUtc(date: Date): PyDateTime {
    return new PyDateTime(
      date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(),
      date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(),
      date.getUTCMilliseconds() * 1000,
    );
  }

  /** Parse 'YYYY-MM-DD HH:MM:SS' or an ISO string. */
  static parse(value: string): PyDateTime | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(value.trim());
    if (!match) return null;
    return new PyDateTime(
      Number(match[1]), Number(match[2]), Number(match[3]),
      Number(match[4] ?? 0), Number(match[5] ?? 0), Number(match[6] ?? 0),
    );
  }

  get parts(): DateParts {
    return {
      year: this.year, month: this.month, day: this.day,
      hour: this.hour, minute: this.minute, second: this.second,
      microsecond: this.microsecond,
    };
  }

  date(): PyDate {
    return new PyDate(this.year, this.month, this.day);
  }

  toOrdinal(): number {
    return daysFromCivil(this.year, this.month, this.day);
  }

  /** Seconds since epoch, treating the civil fields as UTC. */
  get epochSeconds(): number {
    return this.toOrdinal() * 86400 + this.hour * 3600 + this.minute * 60 + this.second;
  }

  weekday(): number {
    return ((this.toOrdinal() % 7) + 10) % 7;
  }

  strftime(format: string): string {
    return formatWith(this.parts, format);
  }

  isoformat(): string {
    return `${this.date().toString()}T${pad(this.hour, 2)}:${pad(this.minute, 2)}:${pad(this.second, 2)}`;
  }

  replace(values: Partial<DateParts>): PyDateTime {
    return new PyDateTime(
      values.year ?? this.year,
      values.month ?? this.month,
      values.day ?? this.day,
      values.hour ?? this.hour,
      values.minute ?? this.minute,
      values.second ?? this.second,
      values.microsecond ?? this.microsecond,
    );
  }

  toString(): string {
    return `${this.date().toString()} ${pad(this.hour, 2)}:${pad(this.minute, 2)}:${pad(this.second, 2)}`;
  }

  valueOf(): number {
    return this.epochSeconds;
  }
}

const PY_TIMEDELTA = Symbol.for('rodeo.pytimedelta');

export class PyTimeDelta {
  readonly [PY_TIMEDELTA] = true;
  /** Normalised to whole seconds; Odoo never needs sub-second deltas here. */
  readonly totalSeconds: number;

  constructor(options: {
    days?: number; seconds?: number; minutes?: number;
    hours?: number; weeks?: number;
  } = {}) {
    this.totalSeconds =
      (options.weeks ?? 0) * 604800 +
      (options.days ?? 0) * 86400 +
      (options.hours ?? 0) * 3600 +
      (options.minutes ?? 0) * 60 +
      (options.seconds ?? 0);
  }

  get days(): number {
    return Math.floor(this.totalSeconds / 86400);
  }

  negate(): PyTimeDelta {
    return new PyTimeDelta({ seconds: -this.totalSeconds });
  }

  toString(): string {
    return `${this.days} days`;
  }

  valueOf(): number {
    return this.totalSeconds;
  }
}

const PY_RELATIVEDELTA = Symbol.for('rodeo.pyrelativedelta');

export interface RelativeDeltaOptions {
  // Relative (added).
  years?: number; months?: number; weeks?: number; days?: number;
  hours?: number; minutes?: number; seconds?: number; microseconds?: number;
  // Absolute (replace).
  year?: number; month?: number; day?: number;
  hour?: number; minute?: number; second?: number; microsecond?: number;
  /** 0 = Monday. Negative means "the previous such weekday". */
  weekday?: number | { weekday: number; n: number };
}

export class RelativeDelta {
  readonly [PY_RELATIVEDELTA] = true;
  readonly options: RelativeDeltaOptions;

  constructor(options: RelativeDeltaOptions = {}) {
    this.options = options;
  }

  negate(): RelativeDelta {
    const o = this.options;
    const flip = (value: number | undefined) => (value == null ? undefined : -value);
    return new RelativeDelta({
      ...o,
      years: flip(o.years), months: flip(o.months), weeks: flip(o.weeks),
      days: flip(o.days), hours: flip(o.hours), minutes: flip(o.minutes),
      seconds: flip(o.seconds), microseconds: flip(o.microseconds),
    });
  }
}

export function isPyDate(value: unknown): value is PyDate {
  return value instanceof PyDate;
}

export function isPyDateTime(value: unknown): value is PyDateTime {
  return value instanceof PyDateTime;
}

export function isTemporal(value: unknown): value is PyDate | PyDateTime {
  return isPyDate(value) || isPyDateTime(value);
}

/**
 * Apply a relativedelta following dateutil's own order: absolute fields
 * replace, then relative years/months are applied with the day clamped to the
 * month length, then days/hours/minutes/seconds are added as a plain delta,
 * then the optional weekday roll.
 */
export function applyRelativeDelta<T extends PyDate | PyDateTime>(
  value: T,
  delta: RelativeDelta,
  sign: 1 | -1 = 1,
): T {
  const o = sign === 1 ? delta.options : delta.negate().options;
  const isDateOnly = isPyDate(value);

  let year = (o.year ?? value.year) + (o.years ?? 0) * 1;
  let monthBase = o.month ?? value.month;

  if (o.months) {
    const total = monthBase - 1 + o.months;
    year += Math.floor(total / 12);
    monthBase = ((total % 12) + 12) % 12 + 1;
  }

  const desiredDay = o.day ?? value.day;
  const day = Math.min(desiredDay, daysInMonth(year, monthBase));

  const hour = o.hour ?? (isDateOnly ? 0 : (value as PyDateTime).hour);
  const minute = o.minute ?? (isDateOnly ? 0 : (value as PyDateTime).minute);
  const second = o.second ?? (isDateOnly ? 0 : (value as PyDateTime).second);

  const addedSeconds =
    (o.weeks ?? 0) * 604800 +
    (o.days ?? 0) * 86400 +
    (o.hours ?? 0) * 3600 +
    (o.minutes ?? 0) * 60 +
    (o.seconds ?? 0);

  let epoch = daysFromCivil(year, monthBase, day) * 86400
    + hour * 3600 + minute * 60 + second + addedSeconds;

  // Weekday roll, dateutil style: move forward (n > 0) or back (n < 0) to the
  // requested weekday, staying put if already on it.
  if (o.weekday != null) {
    const spec = typeof o.weekday === 'number'
      ? { weekday: o.weekday, n: 1 }
      : o.weekday;
    const currentDays = Math.floor(epoch / 86400);
    const currentWeekday = ((currentDays % 7) + 10) % 7;
    let shift = spec.weekday - currentWeekday;
    if (spec.n > 0) {
      if (shift < 0) shift += 7;
      shift += (spec.n - 1) * 7;
    } else {
      if (shift > 0) shift -= 7;
      shift += (spec.n + 1) * 7;
    }
    epoch += shift * 86400;
  }

  const days = Math.floor(epoch / 86400);
  const rest = epoch - days * 86400;
  const [ry, rm, rd] = civilFromDays(days);

  if (isDateOnly) {
    return new PyDate(ry, rm, rd) as T;
  }
  return new PyDateTime(
    ry, rm, rd,
    Math.floor(rest / 3600),
    Math.floor((rest % 3600) / 60),
    rest % 60,
    (value as PyDateTime).microsecond,
  ) as T;
}

export function applyTimeDelta<T extends PyDate | PyDateTime>(
  value: T,
  delta: PyTimeDelta,
  sign: 1 | -1 = 1,
): T {
  const seconds = delta.totalSeconds * sign;
  if (isPyDate(value)) {
    return PyDate.fromDays(value.toOrdinal() + Math.round(seconds / 86400)) as T;
  }
  const dt = value as PyDateTime;
  const epoch = dt.epochSeconds + seconds;
  const days = Math.floor(epoch / 86400);
  const rest = epoch - days * 86400;
  const [y, m, d] = civilFromDays(days);
  return new PyDateTime(
    y, m, d,
    Math.floor(rest / 3600),
    Math.floor((rest % 3600) / 60),
    rest % 60,
    dt.microsecond,
  ) as T;
}

/** Difference between two temporals, as Python's `date - date`. */
export function subtractTemporal(
  left: PyDate | PyDateTime,
  right: PyDate | PyDateTime,
): PyTimeDelta {
  const leftSeconds = isPyDate(left) ? left.toOrdinal() * 86400 : left.epochSeconds;
  const rightSeconds = isPyDate(right) ? right.toOrdinal() * 86400 : right.epochSeconds;
  return new PyTimeDelta({ seconds: leftSeconds - rightSeconds });
}
