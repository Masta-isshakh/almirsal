import { registerModelHooks, type Values } from '../../engine/orm/hooks.js';
import type { Environment } from '../../engine/orm/env.js';
import { UserError } from '../../engine/orm/errors.js';
import { nextByCode } from '../../engine/orm/sequence.js';
import { floatRound } from '../../engine/format/index.js';
import { m2oId } from '../base/index.js';
import { reconcileItems, removeMatches } from './reconciliation.js';

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
  const ids = await env.model('account.account').search([['account_type', '=', accountType]], { limit: 1, order: 'code' });
  return ids[0] ?? false;
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
  const row = await env.cr.query<{ paid: number }>(
    `SELECT coalesce(sum(CASE WHEN coalesce(l.debit,0)-coalesce(l.credit,0)>0
      THEN (SELECT coalesce(sum(p.amount),0) FROM account_partial_reconcile p WHERE p.debit_move_id=l.id)
      ELSE (SELECT coalesce(sum(p.amount),0) FROM account_partial_reconcile p WHERE p.credit_move_id=l.id) END),0)::float8 AS paid
      FROM account_move_line l WHERE l.move_id=$1 AND l.display_type='payment_term'`, [moveId],
  );
  return row.rows[0]?.paid ?? 0;
}

export async function applyPayment(env: Environment, paymentId: number, invoiceId: number): Promise<void> {
  const [invoice] = await env.model('account.move').read(invoiceId, ['state','move_type','partner_id','currency_id','company_id','amount_residual']);
  const [payment] = await env.model('account.payment').read(paymentId, ['state','payment_type','partner_id','currency_id','company_id','move_id']);
  if (invoice.state !== 'posted' || invoice.move_type === 'entry' || Number(invoice.amount_residual) <= 0) throw new UserError({ en: 'Select an unpaid posted invoice.', ar: 'اختر فاتورة مرحّلة غير مدفوعة.' });
  if (!['paid','reconciled'].includes(String(payment.state)) || !m2oId(payment.move_id)) throw new UserError({ en: 'Only a confirmed payment with a journal entry can be applied.', ar: 'يمكن تطبيق الدفعات المؤكدة ذات القيد المحاسبي فقط.' });
  if (m2oId(invoice.partner_id) !== m2oId(payment.partner_id)) throw new UserError({ en: 'The payment belongs to another partner.', ar: 'الدفعة تتعلق بشريك آخر.' });
  if (m2oId(invoice.company_id) !== m2oId(payment.company_id) || m2oId(invoice.currency_id) !== m2oId(payment.currency_id)) throw new UserError({ en: 'The payment and invoice must use the same company and currency.', ar: 'يجب أن تستخدم الدفعة والفاتورة نفس الشركة والعملة.' });
  if ((INBOUND_TYPES.has(String(invoice.move_type)) ? 'inbound' : 'outbound') !== payment.payment_type) throw new UserError({ en: 'The payment direction does not match this invoice.', ar: 'اتجاه الدفع لا يطابق هذه الفاتورة.' });
  const invoiceLines = await env.model('account.move.line').search([['move_id','=',invoiceId],['display_type','=','payment_term']]);
  const rows = (await env.model('account.move.line').read(invoiceLines, ['account_id']));
  const accounts = [...new Set(rows.map(r => m2oId(r.account_id)).filter(Boolean))];
  const paymentLines = await env.model('account.move.line').search([['move_id','=',m2oId(payment.move_id)],['account_id','in',accounts]]);
  await reconcileItems(env, [...invoiceLines, ...paymentLines]);
}

export async function unapplyPayment(env: Environment, paymentId: number, invoiceId: number): Promise<void> {
  const [payment] = await env.model('account.payment').read(paymentId, ['move_id']);
  await env.model('account.move').read(invoiceId, ['id']);
  const lines = await env.model('account.move.line').search([['move_id','in',[m2oId(payment.move_id),invoiceId].filter(Boolean)]]);
  const parts = (await env.cr.query<{ id: number }>(`SELECT p.id FROM account_partial_reconcile p
    JOIN account_move_line d ON d.id=p.debit_move_id JOIN account_move_line c ON c.id=p.credit_move_id
    WHERE p.debit_move_id=ANY($1) AND p.credit_move_id=ANY($1) AND d.move_id<>c.move_id`, [lines])).rows.map(r => Number(r.id));
  if (parts.length) await env.model('account.partial.reconcile').unlink(parts);
}

async function resetPayment(env: Environment, ids: number[], state: string): Promise<void> {
  for (const id of ids) {
    const [payment] = await env.model('account.payment').read(id, ['move_id']);
    const moveId = m2oId(payment.move_id);
    if (moveId) {
      const lines = await env.model('account.move.line').search([['move_id','=',moveId]]);
      await removeMatches(env, lines);
      await env.model('account.move').callButton(moveId, state === 'draft' ? 'button_draft' : 'button_cancel');
    }
    await env.model('account.payment').write(id, { state, is_reconciled: false, reconciled_invoice_ids: [[5]] });
  }
}

export function registerPayments(): void {
  registerModelHooks('account.payment', {
    defaults: async (env) => {
      const journal = await bankJournal(env);
      return { date: today(), state: 'draft', payment_type: 'inbound', partner_type: 'customer', journal_id: journal, payment_method_line_id: await methodLine(env, journal, 'inbound'), amount: 0, company_id: env.companyId, currency_id: m2oId((await env.model('res.company').read(env.companyId, ['currency_id']))[0].currency_id) };
    },
    displayName: (_env, record) => String(record.name || (record.state === 'draft' ? 'Draft Payment' : 'Payment')),
    displayNameFields: ['name', 'state'],
    tracked: ['state', 'amount'],
    noCopy: ['name','state','move_id','reconciled_invoice_ids','is_reconciled','is_matched','is_sent'],
    beforeWrite: async (env, ids, vals) => {
      if (['amount','date','journal_id','partner_id','currency_id','payment_type','partner_type'].some(f => f in vals)) {
        const rows = await env.model('account.payment').read(ids, ['state']);
        if (rows.some(r => r.state !== 'draft')) throw new UserError({ en: 'Reset the payment to draft before changing its financial details.', ar: 'أعد الدفعة إلى المسودة قبل تعديل تفاصيلها المالية.' });
      }
      return vals;
    },
    onUnlink: async (env, ids) => {
      const rows = await env.model('account.payment').read(ids, ['state']);
      if (rows.some(r => r.state !== 'draft')) throw new UserError({ en: 'Only draft payments can be deleted.', ar: 'يمكن حذف الدفعات المسودة فقط.' });
    },
    methods: {
      action_post: async (env, ids, context) => {
        const payments = env.model('account.payment');
        for (const id of ids) {
          await env.cr.query(`SELECT id FROM account_payment WHERE id=$1 FOR UPDATE`, [id]);
          const [payment] = await payments.read(id, ['state','journal_id','name','amount','date','partner_id','partner_type','payment_type','currency_id','company_id','move_id','memo']);
          if (payment.state !== 'draft') continue;
          if (!Number.isFinite(Number(payment.amount)) || Number(payment.amount) <= 0) throw new UserError({ en: 'The payment amount must be positive.', ar: 'يجب أن يكون مبلغ الدفع موجباً.' });
          const journalId = m2oId(payment.journal_id);
          if (!journalId) throw new UserError({ en: 'A journal is required.', ar: 'دفتر اليومية مطلوب.' });
          const [journal] = await env.model('account.journal').read(journalId, ['type','default_account_id','company_id','currency_id']);
          if (!['bank','cash'].includes(String(journal.type)) || m2oId(journal.company_id) && m2oId(journal.company_id) !== m2oId(payment.company_id)) throw new UserError({ en: 'Choose a bank or cash journal in the payment company.', ar: 'اختر دفتر بنك أو نقد في شركة الدفعة.' });
          const companyEnv = env.with({ companyIds: [Number(m2oId(payment.company_id) || env.companyId)] });
          const bankAccount = m2oId(journal.default_account_id) || await accountOfType(companyEnv, 'asset_cash');
          const partnerId = m2oId(payment.partner_id);
          const property = payment.partner_type === 'supplier' ? 'property_account_payable_id' : 'property_account_receivable_id';
          const partner = partnerId ? (await companyEnv.model('res.partner').read(partnerId, [property]))[0] : undefined;
          const counterpart = m2oId(partner?.[property]) || await accountOfType(companyEnv, payment.partner_type === 'supplier' ? 'liability_payable' : 'asset_receivable');
          if (!bankAccount || !counterpart) throw new UserError({ en: 'Configure bank and receivable/payable accounts before confirming a payment.', ar: 'اضبط حسابات البنك والمدين أو الدائن قبل تأكيد الدفع.' });
          const name = payment.name && payment.name !== '/' ? payment.name : await nextByCode(env, await paymentSequence(env, journalId), { date: new Date(`${String(payment.date).slice(0,10)}T00:00:00Z`) });
          const inbound = payment.payment_type === 'inbound';
          let moveId = m2oId(payment.move_id);
          const difference = Number(context.writeoff_amount || 0);
          const writeoffAccount = Number(context.writeoff_account_id || 0);
          if (difference && !writeoffAccount) throw new UserError({ en: 'Choose an account for the payment difference.', ar: 'اختر حساباً لفرق الدفع.' });
          const settled = Number(payment.amount) + difference;
          const sign = inbound ? 1 : -1;
          const writeoff = sign * difference;
          const lineCommands = [[0,0,{ name, account_id: bankAccount, debit: inbound ? payment.amount : 0, credit: inbound ? 0 : payment.amount, partner_id: partnerId || false, payment_id: id }],
              [0,0,{ name, account_id: counterpart, debit: inbound ? 0 : settled, credit: inbound ? settled : 0, partner_id: partnerId || false, payment_id: id }],
              ...(difference ? [[0,0,{ name: context.writeoff_label || 'Payment difference', account_id: writeoffAccount, debit: Math.max(0,writeoff), credit: Math.max(0,-writeoff), partner_id: partnerId || false, payment_id: id }]] : [])];
          const entryValues = { move_type: 'entry', journal_id: journalId, date: payment.date,
            partner_id: partnerId || false, company_id: m2oId(payment.company_id), currency_id: m2oId(payment.currency_id), ref: payment.memo || name };
          if (!moveId) moveId = await env.model('account.move').create({ ...entryValues,line_ids: lineCommands });
          else await env.model('account.move').write(moveId,{ ...entryValues,line_ids: [[5],...lineCommands] });
          // Use the normal posting path: balancing, lock dates and journal numbering apply.
          await env.model('account.move').callButton(moveId, 'action_post');
          await payments.write(id, { name, state: 'paid', move_id: moveId });
        }
      },
      action_draft: async (env, ids) => { await resetPayment(env, ids, 'draft'); },
      action_cancel: async (env, ids) => { await resetPayment(env, ids, 'canceled'); },
      action_reject: async (env, ids) => { await resetPayment(env, ids, 'rejected'); },
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
        const [wizard] = await env.model('account.payment.register').read(ids[0], ['payment_date','amount','journal_id','payment_method_line_id','communication','partner_id','partner_type','payment_type','currency_id','payment_difference_handling','writeoff_account_id','writeoff_label','group_payment']);
        const invoiceIds = Array.isArray(context.active_ids) ? (context.active_ids as number[]) : Array.isArray(env.context.active_ids) ? (env.context.active_ids as number[]) : [];
        const moves = env.model('account.move');
        await moves.read(invoiceIds, ['id']);
        await env.cr.query(`SELECT id FROM account_move WHERE id=ANY($1) ORDER BY id FOR UPDATE`, [invoiceIds]);
        const invoices = (await moves.read(invoiceIds, ['name','state','partner_id','move_type','currency_id','company_id','amount_residual','amount_total'])).filter((move) => move.state === 'posted' && move.move_type !== 'entry' && Number(move.amount_residual) > 0);
        if (invoices.length === 0) throw new UserError({ en: 'Nothing left to pay.', ar: 'لا يوجد ما يُدفع.' });
        const journalId = m2oId(wizard.journal_id);
        if (!journalId) throw new UserError({ en: 'Choose a payment journal.', ar: 'اختر دفتر يومية للدفع.' });
        let remaining = Number(wizard.amount ?? 0);
        if (!Number.isFinite(remaining) || remaining <= 0) throw new UserError({ en: 'The payment amount must be positive.', ar: 'يجب أن يكون مبلغ الدفع موجباً.' });
        const payments = env.model('account.payment');
        const groups = new Map<string, typeof invoices>();
        for (const invoice of invoices) {
          const key = wizard.group_payment ? [m2oId(invoice.partner_id),m2oId(invoice.company_id),m2oId(invoice.currency_id),INBOUND_TYPES.has(String(invoice.move_type)),String(invoice.move_type).startsWith('out')].join(':') : String(invoice.id);
          groups.set(key, [...(groups.get(key) ?? []), invoice]);
        }
        const batches = [...groups.values()];
        if (wizard.payment_difference_handling === 'reconcile' && batches.length !== 1) throw new UserError({ en: 'Register payment differences separately for each partner and currency.', ar: 'سجل فروق الدفع لكل شريك وعملة على حدة.' });
        for (let index=0; index<batches.length; index++) {
          if (remaining <= 0) break;
          const batch = batches[index];
          const invoice = batch[0];
          const currencyId = m2oId(invoice.currency_id);
          const rounding = currencyId ? Number((await env.model('res.currency').read(currencyId,['rounding']))[0].rounding) || .01 : .01;
          const residual = floatRound(batch.reduce((sum,m) => sum+Number(m.amount_residual),0),rounding);
          const amount = floatRound(index===batches.length-1 ? remaining : Math.min(remaining,residual),rounding);
          remaining = floatRound(remaining-amount,rounding);
          const difference = wizard.payment_difference_handling === 'reconcile' ? floatRound(residual-amount,rounding) : 0;
          const paymentId = await payments.create({
            date: wizard.payment_date, amount, journal_id: journalId, payment_method_line_id: m2oId(wizard.payment_method_line_id) || false,
            partner_id: m2oId(invoice.partner_id), partner_type: String(invoice.move_type).startsWith('out') ? 'customer' : 'supplier',
            payment_type: INBOUND_TYPES.has(String(invoice.move_type)) ? 'inbound' : 'outbound', memo: wizard.communication || invoice.name,
            currency_id: currencyId, company_id: m2oId(invoice.company_id),
          });
          await payments.callButton(paymentId,'action_post',{ writeoff_amount: difference, writeoff_account_id: m2oId(wizard.writeoff_account_id), writeoff_label: wizard.writeoff_label });
          for (const document of batch) {
            const [payment] = await payments.read(paymentId,['move_id']);
            const available = await env.cr.query<{ amount: number }>(`SELECT coalesce(sum(abs(l.amount_residual)),0)::float8 AS amount FROM account_move_line l
              JOIN account_account a ON a.id=l.account_id WHERE l.move_id=$1 AND a.account_type IN ('asset_receivable','liability_payable')`,[m2oId(payment.move_id)]);
            if (available.rows[0].amount < rounding/2) break;
            await applyPayment(env,paymentId,Number(document.id));
          }
        }
        return { type: 'ir.actions.act_window_close' };
      },
    },
  });
}
