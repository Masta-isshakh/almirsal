import type { Environment } from './env.js';
import { UserError } from './errors.js';

/**
 * `ir.sequence` — numbering that never repeats and never skips on error.
 *
 * The row is locked with `SELECT … FOR UPDATE` inside the caller's
 * transaction, so two concurrent confirmations cannot draw the same number
 * and a rolled-back transaction releases the number it drew (D-1).
 *
 * Prefix / suffix interpolation follows Odoo: `%(year)s`, `%(month)s`,
 * `%(day)s`, `%(y)s`, `%(doy)s`, `%(woy)s`, `%(weekday)s`, `%(h24)s`,
 * `%(h12)s`, `%(min)s`, `%(sec)s`, plus the `range_` variants that use the
 * date range's start date.
 */

interface SequenceRow extends Record<string, unknown> {
  id: number;
  prefix: string | null;
  suffix: string | null;
  padding: number | null;
  number_increment: number | null;
  number_next_actual: number | null;
  use_date_range: boolean | null;
  company_id: number | null;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function interpolate(template: string | null, date: Date, rangeDate: Date): string {
  if (!template) return '';
  const values = (d: Date, prefix: string): Record<string, string> => {
    const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
    const doy = Math.floor((d.getTime() - jan1) / 86400000) + 1;
    const woy = Math.ceil(doy / 7);
    return {
      [`${prefix}year`]: String(d.getUTCFullYear()),
      [`${prefix}month`]: pad(d.getUTCMonth() + 1, 2),
      [`${prefix}day`]: pad(d.getUTCDate(), 2),
      [`${prefix}y`]: pad(d.getUTCFullYear() % 100, 2),
      [`${prefix}doy`]: pad(doy, 3),
      [`${prefix}woy`]: pad(woy, 2),
      [`${prefix}weekday`]: String(d.getUTCDay() === 0 ? 7 : d.getUTCDay()),
      [`${prefix}h24`]: pad(d.getUTCHours(), 2),
      [`${prefix}h12`]: pad(d.getUTCHours() % 12 || 12, 2),
      [`${prefix}min`]: pad(d.getUTCMinutes(), 2),
      [`${prefix}sec`]: pad(d.getUTCSeconds(), 2),
    };
  };
  const table = { ...values(date, ''), ...values(rangeDate, 'range_') };
  return template.replace(/%\((\w+)\)s/g, (match, key: string) => table[key] ?? match);
}

export interface NextOptions {
  /** Date used for interpolation and date-range selection (default now). */
  date?: Date;
  companyId?: number;
}

/** Draw the next number of the sequence with this `code`. */
export async function nextByCode(env: Environment, code: string, options: NextOptions = {}): Promise<string> {
  const companyId = options.companyId ?? env.companyId;
  const found = await env.cr.query<{ id: number }>(
    `SELECT id FROM ir_sequence WHERE code = $1 AND (company_id = $2 OR company_id IS NULL) AND (active IS NULL OR active = TRUE)
     ORDER BY company_id NULLS LAST, id LIMIT 1`,
    [code, companyId],
  );
  if (found.rows.length === 0) {
    throw new UserError({ en: `No sequence defined for code ${code}`, ar: `لا يوجد تسلسل معرف للرمز ${code}` });
  }
  return nextById(env, found.rows[0].id, options);
}

/** Draw the next number of a sequence by id. Must run in a transaction. */
export async function nextById(env: Environment, sequenceId: number, options: NextOptions = {}): Promise<string> {
  if (!env.inTransaction) {
    return env.withTransaction((tx) => nextById(tx, sequenceId, options));
  }
  const date = options.date ?? new Date();
  const locked = await env.cr.query<SequenceRow>(
    `SELECT id, prefix, suffix, padding, number_increment, number_next_actual, use_date_range, company_id
     FROM ir_sequence WHERE id = $1 FOR UPDATE`,
    [sequenceId],
  );
  const sequence = locked.rows[0];
  if (!sequence) throw new UserError(`Sequence ${sequenceId} does not exist`);

  const increment = sequence.number_increment ?? 1;
  let number: number;
  let rangeDate = date;

  if (sequence.use_date_range) {
    const isoDate = date.toISOString().slice(0, 10);
    let range = await env.cr.query<{ id: number; number_next_actual: number | null; date_from: string }>(
      `SELECT id, number_next_actual, to_char(date_from, 'YYYY-MM-DD') AS date_from
       FROM ir_sequence_date_range WHERE sequence_id = $1 AND date_from <= $2::date AND date_to >= $2::date
       FOR UPDATE`,
      [sequenceId, isoDate],
    );
    if (range.rows.length === 0) {
      // Odoo creates one range per calendar year on demand.
      const year = date.getUTCFullYear();
      await env.cr.query(
        `INSERT INTO ir_sequence_date_range (sequence_id, date_from, date_to, number_next, number_next_actual, create_date, write_date)
         VALUES ($1, $2::date, $3::date, 1, 1, now(), now())`,
        [sequenceId, `${year}-01-01`, `${year}-12-31`],
      );
      range = await env.cr.query(
        `SELECT id, number_next_actual, to_char(date_from, 'YYYY-MM-DD') AS date_from
         FROM ir_sequence_date_range WHERE sequence_id = $1 AND date_from <= $2::date AND date_to >= $2::date FOR UPDATE`,
        [sequenceId, isoDate],
      );
    }
    const row = range.rows[0];
    number = row.number_next_actual ?? 1;
    rangeDate = new Date(`${row.date_from}T00:00:00Z`);
    await env.cr.query(
      `UPDATE ir_sequence_date_range SET number_next_actual = $2, number_next = $2, write_date = now() WHERE id = $1`,
      [row.id, number + increment],
    );
  } else {
    number = sequence.number_next_actual ?? 1;
    await env.cr.query(
      `UPDATE ir_sequence SET number_next_actual = $2, number_next = $2, write_date = now() WHERE id = $1`,
      [sequenceId, number + increment],
    );
  }

  const padded = pad(number, sequence.padding ?? 0);
  return `${interpolate(sequence.prefix, date, rangeDate)}${padded}${interpolate(sequence.suffix, date, rangeDate)}`;
}
