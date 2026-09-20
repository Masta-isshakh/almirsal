import { registerModelHooks, type Values } from '../../engine/orm/hooks.js';
import type { Environment } from '../../engine/orm/env.js';
import { UserError } from '../../engine/orm/errors.js';
import { nextByCode } from '../../engine/orm/sequence.js';
import { floatRound } from '../../engine/format/index.js';
import { m2oId } from '../base/index.js';

/**
 * Payments (D-3): the "Register Payment" wizard on invoices creates an
 * `account.payment` (numbered per bank journal, `PBNK1/2026/00001`) with
 * its balanced journal entry (bank ↔ receivable/payable), links it to the
 * invoices and recomputes their residual and payment status.
 */

const INBOUND_TYPES = new Set(['out_invoice', 'in_refund', 'out_receipt']);

function today(): string { return new Date().toISOString().slice(0, 10); }

async function bankJournal(env: Environment): Promise<number | false> {
  const row = await env.cr.query<{ id: number }>(
    `SELECT id FROM account_journal WHERE type IN ('bank', 'cash') AND (company_id = $1 OR company_id IS NULL) AND (active IS NULL OR active = TRUE) ORDER BY CASE type WHEN 'bank' THEN 0 ELSE 1 END, sequence NULLS LAST, id LIMIT 1`, [env.companyId],
  );
  return row.rows[0]?.id ?? false;
}

async function methodLine(env: Environment, journalId: number | false, paymentType: string): Promise<number | false> {
  if (!env.registry.models['account.payment.method.line'] || !journalId) return false;
  const row = await env.cr.query<{ id: number }>(
    `SELECT l.id FROM account_payment_method_line l LEFT JOIN account_payment_method m ON m.id = l.payment_method_id
     WHERE (l.journal_id = $1 OR l.journal_id IS NULL) AND (m.payment_type = $2 OR l.payment_type = $2 OR m.id IS NULL) ORDER BY l.journal_id NULLS LAST, l.sequence NULLS LAST, l.id LIMIT 1`, [journalId, paymentType],
  ).catch(() => ({ rows: [] as { id: number }[] }));
  return row.rows[0]?.id ?? false;
}

async function accountOfType(env: Environment, accountType: string): Promise<number | false> {
  const row = await env.cr.query<{ id: number }>(`SELECT id FROM account_account WHERE account_type = $1 AND (active IS NULL OR active = TRUE) ORDER BY code LIMIT 1`, [accountType]);
  return row.rows[0]?.id ?? false;
}

/** Payment sequence per journal: `P<CODE>/<year>/00001`. */
async function paymentSequence(env: Environment, journalId: number): Promise<string> {
  const journal = await env.cr.query<{ code: string; company_id: number | null }>(`SELECT code, company_id FROM account_journal WHERE id = $1`, [journalId]);
  const row = journal.rows[0];
  if (!row) throw new UserError({ en: 'The payment journal does not exist.', ar: 'دفتر يومية الدفع غير موجود.' });
  const code = `account.payment.${journalId}`;
  const existing = await env.cr.query<{ id: number }>(`SELECT id FROM ir_sequence WHERE code = $1 LIMIT 1`, [code]);
  if (existing.rows.length === 0) {
    await env.cr.query(
      `INSERT INTO ir_sequence (name, code, prefix, padding, number_next, number_next_actual, number_increment, use_date_range, implementation, active, company_id, create_date, write_date)
       VALUES ($1, $2, $3, 5, 1, 1, 1, TRUE, 'no_gap', TRUE, $4, now(), now())`,
      [`${row.code} payments`, code, `P${row.code}/%(range_year)s/`, row.company_id],
    );
  }
  return code;
}

/** Amount already paid on an invoice: its posted payments. */
export async function paidAmount(env: Environment, moveId: number): Promise<number> {
  const rel = env.registry.models['account.payment']?.fields.reconciled_invoice_ids;
  if (!rel?.m2mTable) return 0;
  const row = await env.cr.query<{ paid: number }>(
    `SELECT coalesce(sum(p.amount), 0)::float8 AS paid FROM account_payment p JOIN "${rel.m2mTable}" r ON r."${rel.m2mColumn1}" = p.id
     WHERE r."${rel.m2mColumn2}" = $1 AND p.state IN ('paid', 'reconciled', 'in_process')`, [moveId],
  );
  return row.rows[0]?.paid ?? 0;
}

export function registerPayments(): void {
  registerModelHooks('account.payment', {
    defaults: async (env) => {
      const journal = await bankJournal(env);
      return { date: today(), state: 'draft', payment_type: 'inbound', partner_type: 'customer', journal_id: journal, payment_method_line_id: await methodLine(env, journal, 'inbound'), amount: 0, company_id: env.companyId };
    },
    displayName: (_env, record) => String(record.name || (record.state === 'draft' ? 'Draft Payment' : 'Payment')),
    displayNameFields: ['name', 'state'],
    tracked: ['state', 'amount'],
    methods: {
      action_post: async (env, ids) => {
        const payments = env.model('account.payment');
        for (const id of ids) {
          const [payment] = await payments.read(id, ['state', 'journal_id', 'name', 'amount']);
          if (payment.state !== 'draft') continue;
          if (!Number(payment.amount)) throw new UserError({ en: 'The payment amount must be positive.', ar: 'يجب أن يكون مبلغ الدفع موجباً.' });
          const journalId = m2oId(payment.journal_id);
          if (!journalId) throw new UserError({ en: 'A journal is required.', ar: 'دفتر اليومية مطلوب.' });
          const name = payment.name && payment.name !== '/' ? payment.name : await nextByCode(env, await paymentSequence(env, journalId), { date: new Date(`${today()}T00:00:00Z`) });
          await payments.write(id, { name, state: 'paid' });
        }
      },
      action_draft: async (env, ids) => { await env.model('account.payment').write(ids, { state: 'draft' }); },
      action_cancel: async (env, ids) => { await env.model('account.payment').write(ids, { state: 'canceled' }); },
      mark_as_sent: async (env, ids) => { await env.model('account.payment').write(ids, { is_sent: true }); },
      unmark_as_sent: async (env, ids) => { await env.model('account.payment').write(ids, { is_sent: false }); },
    },
  });

  registerModelHooks('account.payment.register', {
    defaults: async (env) => {
      const ids = Array.isArray(env.context.active_ids) ? (env.context.active_ids as number[]) : typeof env.context.active_id === 'number' ? [env.context.active_id] : [];
      const model = env.context.active_model === 'account.move' || !env.context.active_model ? 'account.move' : String(env.context.active_model);
      const out: Values = { payment_date: today(), payment_difference_handling: 'open', group_payment: true, company_id: env.companyId, can_edit_wizard: ids.length <= 1 };
      if (model !== 'account.move' || ids.length === 0) return out;
      const moves = await env.model('account.move').read(ids, ['name', 'state', 'move_type', 'partner_id', 'currency_id', 'amount_residual', 'payment_reference', 'payment_state']);
      const open = moves.filter((move) => move.state === 'posted' && Number(move.amount_residual) > 0);
      if (open.length === 0) throw new UserError({ en: 'You can only register payments on posted invoices that are not fully paid.', ar: 'يمكنك تسجيل الدفعات فقط على الفواتير المرحّلة غير المدفوعة بالكامل.' });
      const first = open[0];
      const paymentType = INBOUND_TYPES.has(String(first.move_type)) ? 'inbound' : 'outbound';
      const journal = await bankJournal(env);
      const amount = open.reduce((sum, move) => sum + Number(move.amount_residual ?? 0), 0);
      return {
        ...out,
        amount: floatRound(amount, 0.01), source_amount: floatRound(amount, 0.01), payment_difference: 0,
        currency_id: m2oId(first.currency_id), partner_id: open.every((move) => m2oId(move.partner_id) === m2oId(first.partner_id)) ? m2oId(first.partner_id) : false,
        partner_type: String(first.move_type).startsWith('out') ? 'customer' : 'supplier', payment_type: paymentType,
        journal_id: journal, payment_method_line_id: await methodLine(env, journal, paymentType),
        communication: open.map((move) => String(move.payment_reference || move.name)).join(', '),
        line_ids: [[6, 0, []]],
      };
    },
    onchange: {
      amount: async (env, values) => {
        const source = Number(values.source_amount ?? 0);
        const amount = Number(values.amount ?? 0);
        return { value: { payment_difference: floatRound(source - amount, 0.01) } };
      },
      journal_id: async (env, values) => ({ value: { payment_method_line_id: await methodLine(env, m2oId(values.journal_id), String(values.payment_type ?? 'inbound')) } }),
    },
    methods: {
      action_create_payments: async (env, ids, context) => {
        const [wizard] = await env.model('account.payment.register').read(ids[0], ['payment_date', 'amount', 'journal_id', 'payment_method_line_id', 'communication', 'partner_id', 'partner_type', 'payment_type', 'currency_id', 'payment_difference_handling']);
        const invoiceIds = Array.isArray(context.active_ids) ? (context.active_ids as number[]) : Array.isArray(env.context.active_ids) ? (env.context.active_ids as number[]) : [];
        const moves = env.model('account.move');
        const invoices = (await moves.read(invoiceIds, ['name', 'state', 'partner_id', 'move_type', 'currency_id', 'amount_residual', 'amount_total'])).filter((move) => move.state === 'posted' && Number(move.amount_residual) > 0);
        if (invoices.length === 0) throw new UserError({ en: 'Nothing left to pay.', ar: 'لا يوجد ما يُدفع.' });
        const journalId = m2oId(wizard.journal_id);
        if (!journalId) throw new UserError({ en: 'Choose a payment journal.', ar: 'اختر دفتر يومية للدفع.' });
        let remaining = Number(wizard.amount ?? 0);
        if (remaining <= 0) throw new UserError({ en: 'The payment amount must be positive.', ar: 'يجب أن يكون مبلغ الدفع موجباً.' });
        const created: number[] = [];
        const payments = env.model('account.payment');
        const sequenceCode = await paymentSequence(env, journalId);
        const bankAccount = await accountOfType(env, 'asset_cash');
        for (const invoice of invoices) {
          if (remaining <= 0) break;
          const residual = Number(invoice.amount_residual ?? 0);
          const amount = floatRound(invoices.length === 1 ? Math.min(remaining, residual + (wizard.payment_difference_handling === 'reconcile' ? 0 : 0)) : Math.min(remaining, residual), 0.01);
          remaining = floatRound(remaining - amount, 0.01);
          const name = await nextByCode(env, sequenceCode, { date: new Date(`${String(wizard.payment_date ?? today()).slice(0, 10)}T00:00:00Z`) });
          const inbound = String(wizard.payment_type ?? 'inbound') === 'inbound';
          // The payment's journal entry: bank against the partner's receivable / payable.
          const counterpart = await accountOfType(env, String(invoice.move_type).startsWith('out') ? 'asset_receivable' : 'liability_payable');
          const entry = await moves.create({
            move_type: 'entry', journal_id: journalId, date: wizard.payment_date, partner_id: m2oId(invoice.partner_id), currency_id: m2oId(wizard.currency_id) || m2oId(invoice.currency_id), ref: name,
            line_ids: [
              [0, 0, { name, account_id: bankAccount, partner_id: m2oId(invoice.partner_id), debit: inbound ? amount : 0, credit: inbound ? 0 : amount, balance: inbound ? amount : -amount, amount_currency: inbound ? amount : -amount, quantity: 1, price_unit: 0, display_type: 'payment_term', date: wizard.payment_date }],
              [0, 0, { name, account_id: counterpart, partner_id: m2oId(invoice.partner_id), debit: inbound ? 0 : amount, credit: inbound ? amount : 0, balance: inbound ? -amount : amount, amount_currency: inbound ? -amount : amount, quantity: 1, price_unit: 0, display_type: 'payment_term', date: wizard.payment_date }],
            ],
          });
          await moves.write(entry, { state: 'posted', name });
          const paymentId = await payments.create({
            name, date: wizard.payment_date, amount, journal_id: journalId, payment_method_line_id: m2oId(wizard.payment_method_line_id) || false,
            partner_id: m2oId(invoice.partner_id), partner_type: wizard.partner_type, payment_type: wizard.payment_type, memo: wizard.communication || invoice.name,
            currency_id: m2oId(wizard.currency_id) || m2oId(invoice.currency_id), company_id: env.companyId, state: 'paid', move_id: entry, is_reconciled: true,
            reconciled_invoice_ids: [[6, 0, [invoice.id as number]]],
          });
          created.push(paymentId);
          await moves.recompute([invoice.id as number], ['line_ids'], false);
          const [after] = await moves.read(invoice.id as number, ['amount_residual', 'payment_state']);
          await env.model('mail.message').create({
            model: 'account.move', res_id: invoice.id, message_type: 'notification', body: `<p>${env.lang === 'ar_001' ? 'تم تسجيل دفعة' : 'Payment'} <strong>${name}</strong> ${env.lang === 'ar_001' ? 'بمبلغ' : 'of'} ${amount}${after.payment_state === 'paid' ? (env.lang === 'ar_001' ? ' — الفاتورة مدفوعة بالكامل.' : ' — invoice fully paid.') : ''}</p>`,
            author_id: false, date: new Date().toISOString().slice(0, 19).replace('T', ' '),
          }).catch(() => undefined);
        }
        return { type: 'ir.actions.act_window_close' };
      },
    },
  });
}
