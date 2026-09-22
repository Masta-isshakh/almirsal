import type { Environment } from '../../engine/orm/env.js';

/**
 * Accounting dashboard (C-8.7): the numbers behind each journal card —
 * invoices/bills to validate and unpaid with their amounts, late ones,
 * bank/cash balances with the last entries, entries to check, and the
 * weekly "due" bars of the sales card.
 */
export interface JournalCard {
  id: number; name: string; type: string; color: number; code: string;
  draftCount: number; draftAmount: number; unpaidCount: number; unpaidAmount: number; lateCount: number; lateAmount: number;
  balance: number; lastEntryDate: string | null; toCheck: number; entriesCount: number;
  /** Amounts due per week bucket (sales / purchase journals). */
  due: { label: string; amount: number }[];
  currency: string;
}

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

export async function journalDashboard(env: Environment, journalIds?: number[]): Promise<JournalCard[]> {
  const params: unknown[] = [];
  let where = `coalesce(j.active, true)`;
  if (journalIds?.length) { params.push(journalIds); where += ` AND j.id = ANY($1)`; }
  const journals = await env.cr.query<Record<string, unknown>>(
    `SELECT j.id, j.name, j.type, coalesce(j.color, 0) AS color, j.code, j.default_account_id, c.symbol AS currency
     FROM account_journal j LEFT JOIN res_currency c ON c.id = coalesce(j.currency_id, (SELECT currency_id FROM res_company WHERE id = $${params.length + 1}))
     WHERE ${where} ORDER BY j.sequence, j.id`, [...params, env.companyId],
  );
  const cards: JournalCard[] = [];
  for (const j of journals.rows) {
    const id = Number(j.id); const type = String(j.type);
    const card: JournalCard = { id, name: String(j.name), type, color: num(j.color), code: String(j.code ?? ''), draftCount: 0, draftAmount: 0, unpaidCount: 0, unpaidAmount: 0, lateCount: 0, lateAmount: 0, balance: 0, lastEntryDate: null, toCheck: 0, entriesCount: 0, due: [], currency: String(j.currency ?? '') };
    if (type === 'sale' || type === 'purchase') {
      const types = type === 'sale' ? ['out_invoice', 'out_refund', 'out_receipt'] : ['in_invoice', 'in_refund', 'in_receipt'];
      const stats = await env.cr.query<Record<string, unknown>>(
        `SELECT count(*) FILTER (WHERE state = 'draft')::int AS draft_count, coalesce(sum(amount_total) FILTER (WHERE state = 'draft'), 0)::float8 AS draft_amount,
                count(*) FILTER (WHERE state = 'posted' AND payment_state IN ('not_paid', 'partial'))::int AS unpaid_count, coalesce(sum(amount_residual) FILTER (WHERE state = 'posted' AND payment_state IN ('not_paid', 'partial')), 0)::float8 AS unpaid_amount,
                count(*) FILTER (WHERE state = 'posted' AND payment_state IN ('not_paid', 'partial') AND invoice_date_due < CURRENT_DATE)::int AS late_count,
                coalesce(sum(amount_residual) FILTER (WHERE state = 'posted' AND payment_state IN ('not_paid', 'partial') AND invoice_date_due < CURRENT_DATE), 0)::float8 AS late_amount,
                count(*) FILTER (WHERE coalesce(review_state, '') = 'to_check' OR coalesce(to_check, false))::int AS to_check, count(*)::int AS n
         FROM account_move WHERE journal_id = $1 AND move_type = ANY($2)`, [id, types],
      ).catch(async () => env.cr.query<Record<string, unknown>>(
        `SELECT count(*) FILTER (WHERE state = 'draft')::int AS draft_count, coalesce(sum(amount_total) FILTER (WHERE state = 'draft'), 0)::float8 AS draft_amount,
                count(*) FILTER (WHERE state = 'posted' AND payment_state IN ('not_paid', 'partial'))::int AS unpaid_count, coalesce(sum(amount_residual) FILTER (WHERE state = 'posted' AND payment_state IN ('not_paid', 'partial')), 0)::float8 AS unpaid_amount,
                count(*) FILTER (WHERE state = 'posted' AND payment_state IN ('not_paid', 'partial') AND invoice_date_due < CURRENT_DATE)::int AS late_count,
                coalesce(sum(amount_residual) FILTER (WHERE state = 'posted' AND payment_state IN ('not_paid', 'partial') AND invoice_date_due < CURRENT_DATE), 0)::float8 AS late_amount, 0::int AS to_check, count(*)::int AS n
         FROM account_move WHERE journal_id = $1 AND move_type = ANY($2)`, [id, types]));
      const s = stats.rows[0] ?? {};
      Object.assign(card, { draftCount: num(s.draft_count), draftAmount: num(s.draft_amount), unpaidCount: num(s.unpaid_count), unpaidAmount: num(s.unpaid_amount), lateCount: num(s.late_count), lateAmount: num(s.late_amount), toCheck: num(s.to_check), entriesCount: num(s.n) });
      const weeks = await env.cr.query<{ bucket: number; amount: number }>(
        `SELECT CASE WHEN invoice_date_due < CURRENT_DATE THEN 0 ELSE least(4, 1 + floor((invoice_date_due - CURRENT_DATE) / 7))::int END AS bucket, coalesce(sum(amount_residual), 0)::float8 AS amount
         FROM account_move WHERE journal_id = $1 AND move_type = ANY($2) AND state = 'posted' AND payment_state IN ('not_paid', 'partial') GROUP BY 1 ORDER BY 1`, [id, types],
      );
      const labels = ['Due', 'This Week', 'Next Week', 'In 2 Weeks', 'Later'];
      card.due = labels.map((label, i) => ({ label, amount: num(weeks.rows.find((w) => Number(w.bucket) === i)?.amount) }));
    } else if (type === 'bank' || type === 'cash' || type === 'credit') {
      const account = j.default_account_id ? Number(j.default_account_id) : null;
      const bal = account ? await env.cr.query<{ balance: number; last: string | null; n: number }>(
        `SELECT coalesce(sum(coalesce(l.balance, coalesce(l.debit, 0) - coalesce(l.credit, 0))), 0)::float8 AS balance, max(coalesce(l.date, m.date))::text AS last, count(*)::int AS n
         FROM account_move_line l JOIN account_move m ON m.id = l.move_id WHERE l.account_id = $1 AND m.state = 'posted'`, [account]) : { rows: [] as { balance: number; last: string | null; n: number }[] };
      card.balance = num(bal.rows[0]?.balance); card.lastEntryDate = bal.rows[0]?.last ?? null; card.entriesCount = num(bal.rows[0]?.n);
      const drafts = await env.cr.query<{ n: number }>(`SELECT count(*)::int AS n FROM account_move WHERE journal_id = $1 AND state = 'draft'`, [id]);
      card.draftCount = num(drafts.rows[0]?.n);
    } else {
      const stats = await env.cr.query<{ draft: number; n: number; last: string | null }>(`SELECT count(*) FILTER (WHERE state = 'draft')::int AS draft, count(*)::int AS n, max(date)::text AS last FROM account_move WHERE journal_id = $1`, [id]);
      card.draftCount = num(stats.rows[0]?.draft); card.entriesCount = num(stats.rows[0]?.n); card.lastEntryDate = stats.rows[0]?.last ?? null;
    }
    cards.push(card);
  }
  return cards;
}
