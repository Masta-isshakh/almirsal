import { registerModelHooks, type Values } from '../../engine/orm/hooks.js';
import type { Environment } from '../../engine/orm/env.js';
import type { Registry } from '../../engine/registry/types.js';
import { UserError, ValidationError } from '../../engine/orm/errors.js';
import { nextByCode } from '../../engine/orm/sequence.js';
import { floatRound } from '../../engine/format/index.js';
import { m2oId } from '../base/index.js';
import { paidAmount, registerPayments } from './payment.js';

/**
 * D-3 — Accounting core: journal entries and invoices (`account.move`),
 * journal items (`account.move.line`), numbering on post through per-journal
 * date-range sequences (`INV/2026/00001`, `RINV/…`, `BILL/2026/00001`),
 * totals with taxes, balanced receivable/tax/income items generated at
 * posting time, and the draft → posted → cancel state machine.
 */

const SALE_TYPES = new Set(['out_invoice', 'out_refund', 'out_receipt']);
const PURCHASE_TYPES = new Set(['in_invoice', 'in_refund', 'in_receipt']);
const REFUND_TYPES = new Set(['out_refund', 'in_refund']);
const PRODUCT_LINE_TYPES = ['product', 'line_section', 'line_note'];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Journal of the right type for a move type, in the current company. */
async function defaultJournal(env: Environment, moveType: string): Promise<number | false> {
  const type = SALE_TYPES.has(moveType) ? 'sale' : PURCHASE_TYPES.has(moveType) ? 'purchase' : 'general';
  const row = await env.cr.query<{ id: number }>(
    `SELECT id FROM account_journal WHERE type = $1 AND (company_id = $2 OR company_id IS NULL) AND (active IS NULL OR active = TRUE)
     ORDER BY sequence NULLS LAST, id LIMIT 1`, [type, env.companyId],
  );
  return row.rows[0]?.id ?? false;
}

/** First account of a type in the company chart (receivable, payable, tax…). */
async function accountOfType(env: Environment, accountType: string): Promise<number | false> {
  const row = await env.cr.query<{ id: number }>(
    `SELECT id FROM account_account WHERE account_type = $1 AND (active IS NULL OR active = TRUE) ORDER BY code LIMIT 1`, [accountType],
  );
  return row.rows[0]?.id ?? false;
}

/**
 * Sequence for a journal: Odoo keeps one per journal (and one for refunds),
 * year-ranged: `INV/2026/00001`. Created on first use.
 */
async function journalSequence(env: Environment, journalId: number, refund: boolean): Promise<string> {
  const journal = await env.cr.query<{ code: string; refund_sequence: boolean | null; company_id: number | null }>(
    `SELECT code, refund_sequence, company_id FROM account_journal WHERE id = $1`, [journalId],
  );
  const row = journal.rows[0];
  if (!row) throw new UserError({ en: 'The journal of this entry does not exist.', ar: 'دفتر اليومية لهذا القيد غير موجود.' });
  // Sales and purchase journals use a dedicated refund sequence unless switched off.
  const useRefund = refund && row.refund_sequence !== false;
  const code = `account.move.${journalId}${useRefund ? '.refund' : ''}`;
  const existing = await env.cr.query<{ id: number }>(`SELECT id FROM ir_sequence WHERE code = $1 LIMIT 1`, [code]);
  if (existing.rows.length === 0) {
    await env.cr.query(
      `INSERT INTO ir_sequence (name, code, prefix, padding, number_next, number_next_actual, number_increment, use_date_range, implementation, active, company_id, create_date, write_date)
       VALUES ($1, $2, $3, 5, 1, 1, 1, TRUE, 'no_gap', TRUE, $4, now(), now())`,
      [`${row.code}${useRefund ? ' refund' : ''}`, code, `${useRefund ? 'R' : ''}${row.code}/%(range_year)s/`, row.company_id],
    );
  }
  return code;
}

async function currencyRounding(env: Environment, moveId: number): Promise<number> {
  const row = await env.cr.query<{ rounding: number | null }>(
    `SELECT c.rounding::float8 AS rounding FROM account_move m LEFT JOIN res_currency c ON c.id = m.currency_id WHERE m.id = $1`, [moveId],
  );
  return row.rows[0]?.rounding || 0.01;
}

async function lineTaxAmount(env: Environment, lineId: number, base: number, qty: number): Promise<number> {
  const rel = env.registry.models['account.move.line'].fields.tax_ids;
  if (!rel?.m2mTable) return 0;
  const taxes = await env.cr.query<{ amount: number | null; amount_type: string | null; price_include: boolean | null }>(
    `SELECT t.amount::float8 AS amount, t.amount_type, t.price_include FROM account_tax t
     JOIN "${rel.m2mTable}" r ON r."${rel.m2mColumn2}" = t.id WHERE r."${rel.m2mColumn1}" = $1`, [lineId],
  );
  let total = 0;
  for (const tax of taxes.rows) {
    const amount = tax.amount ?? 0;
    if (tax.amount_type === 'percent') total += tax.price_include ? base - base / (1 + amount / 100) : base * amount / 100;
    else if (tax.amount_type === 'fixed') total += amount * qty;
    else if (tax.amount_type === 'division') total += base / (1 - amount / 100) - base;
  }
  return total;
}

/**
 * Rebuild the automatic journal items (receivable/payable, tax) so the
 * entry balances: product lines carry the income/expense side.
 */
async function rebuildBalancingLines(env: Environment, moveId: number): Promise<void> {
  const [move] = await env.sudo().model('account.move').read(moveId, ['move_type', 'partner_id', 'journal_id', 'date', 'invoice_date', 'currency_id', 'invoice_date_due']);
  const moveType = String(move.move_type);
  if (moveType === 'entry') return;
  const rounding = await currencyRounding(env, moveId);

  await env.cr.query(`DELETE FROM account_move_line WHERE move_id = $1 AND display_type IN ('tax', 'payment_term')`, [moveId]);
  const products = await env.cr.query<{ subtotal: number; tax: number }>(
    `SELECT coalesce(sum(price_subtotal), 0)::float8 AS subtotal, coalesce(sum(price_total - price_subtotal), 0)::float8 AS tax
     FROM account_move_line WHERE move_id = $1 AND display_type = 'product'`, [moveId],
  );
  const subtotal = floatRound(products.rows[0]?.subtotal ?? 0, rounding);
  const tax = floatRound(products.rows[0]?.tax ?? 0, rounding);
  const total = floatRound(subtotal + tax, rounding);
  // Customer invoices credit income and debit the receivable; refunds and
  // vendor bills flip the sign.
  const sign = (SALE_TYPES.has(moveType) ? 1 : -1) * (REFUND_TYPES.has(moveType) ? -1 : 1);
  const lines = env.model('account.move.line');
  const base: Values = {
    move_id: moveId, partner_id: m2oId(move.partner_id), currency_id: m2oId(move.currency_id),
    date: move.date, quantity: 1, price_unit: 0,
  };
  if (tax) {
    const taxAccount = await accountOfType(env, 'liability_current');
    await lines.create({
      ...base, display_type: 'tax', name: 'Tax', account_id: taxAccount,
      debit: sign > 0 ? 0 : tax, credit: sign > 0 ? tax : 0, balance: -sign * tax, amount_currency: -sign * tax, sequence: 9000,
    });
  }
  const counterpart = await accountOfType(env, SALE_TYPES.has(moveType) ? 'asset_receivable' : 'liability_payable');
  await lines.create({
    ...base, display_type: 'payment_term', name: String(move.invoice_date_due ?? move.invoice_date ?? ''), account_id: counterpart,
    debit: sign > 0 ? total : 0, credit: sign > 0 ? 0 : total, balance: sign * total, amount_currency: sign * total,
    date_maturity: move.invoice_date_due ?? move.invoice_date ?? move.date, sequence: 9999,
  });
}

export function registerAccount(registry: Registry): void {
  registerPayments();
  // The Register Payment wizard form (the export has none): journal, method, date, amount, memo.
  if (registry.models['account.payment.register'] && !Object.values(registry.views).some((view) => view.model === 'account.payment.register' && view.type === 'form')) {
    const field = (name: string, extra: Record<string, unknown> = {}) => ({ kind: 'field' as const, name, decorations: {}, attrs: {}, ...extra });
    registry.views['account.payment.register|form|rodeo'] = {
      key: 'account.payment.register|form|rodeo', id: null, model: 'account.payment.register', type: 'form', toolbar: { print: [], action: [] },
      arch: {
        type: 'form', attrs: {}, string: { en: 'Register Payment', ar: 'تسجيل الدفع' },
        body: [
          { kind: 'group', children: [
            { kind: 'group', children: [field('journal_id', { options: "{'no_create': True}" }), field('payment_method_line_id', { options: "{'no_create': True}" }), field('partner_id', { invisible: 'not partner_id', options: "{'no_create': True}" })] },
            { kind: 'group', children: [field('amount'), field('currency_id', { options: "{'no_create': True}", invisible: 'not currency_id' }), field('payment_date'), field('communication')] },
          ] },
          { kind: 'group', invisible: 'not payment_difference', children: [field('source_amount'), field('payment_difference'), field('payment_difference_handling', { widget: 'radio' })] },
          { kind: 'element', tag: 'footer', attrs: {}, children: [
            { kind: 'button', type: 'object', name: 'action_create_payments', string: { en: 'Create Payment', ar: 'إنشاء الدفعة' }, class: 'btn-primary', attrs: {} },
            { kind: 'button', type: 'object', special: 'cancel', string: { en: 'Discard', ar: 'تجاهل' }, class: 'btn-secondary', attrs: {} },
          ] },
        ],
      },
    };
  }
  // invoice_line_ids is line_ids restricted to the lines a user edits.
  const move = registry.models['account.move'];
  if (move?.fields.invoice_line_ids) move.fields.invoice_line_ids.domain = [['display_type', 'in', PRODUCT_LINE_TYPES]];

  registerModelHooks('account.journal', {
    displayName: (_env, record) => String(record.name ?? ''),
    displayNameFields: ['name'],
    displayNameSql: (alias) => `${alias}."name"`,
    searchFields: ['code'],
  });

  registerModelHooks('account.account', {
    displayName: (_env, record) => (record.code ? `${record.code} ${record.name ?? ''}` : String(record.name ?? '')),
    displayNameFields: ['code', 'name'],
    displayNameSql: (alias) => `CASE WHEN ${alias}."code" IS NOT NULL AND ${alias}."code" <> '' THEN ${alias}."code" || ' ' || coalesce(${alias}."name", '') ELSE coalesce(${alias}."name", '') END`,
    searchFields: ['code'],
  });

  registerModelHooks('account.move', {
    // A duplicated entry is a new draft: number, state, payments and sent flag are not copied.
    noCopy: ['name', 'state', 'payment_state', 'posted_before', 'is_move_sent', 'amount_residual', 'amount_residual_signed', 'line_ids', 'payment_id', 'reversal_move_ids', 'reversed_entry_id', 'invoice_date', 'access_token', 'message_ids', 'activity_ids', 'sequence_prefix', 'sequence_number'],
    // Posted entries are part of the books: cancel or reset to draft first.
    onUnlink: async (env, ids) => {
      const posted = await env.cr.query<{ name: string }>(`SELECT name FROM account_move WHERE id = ANY($1) AND state = 'posted'`, [ids]);
      if (posted.rows.length) throw new UserError({ en: `You cannot delete posted entries (${posted.rows.map((row) => row.name).join(', ')}); cancel or reset them to draft first.`, ar: `لا يمكن حذف قيود مرحّلة (${posted.rows.map((row) => row.name).join('، ')})؛ قم بإلغائها أو إعادتها إلى المسودة أولاً.` });
    },
    defaults: async (env) => {
      const moveType = String(env.context.default_move_type ?? 'entry');
      return {
        name: '/',
        move_type: moveType,
        state: 'draft',
        payment_state: 'not_paid',
        date: today(),
        journal_id: await defaultJournal(env, moveType),
        invoice_user_id: env.uid,
        is_move_sent: false,
        posted_before: false,
        auto_post: 'no',
        review_state: 'todo',
      };
    },
    tracked: ['state', 'partner_id', 'amount_total', 'invoice_date'],
    searchFields: ['ref', 'invoice_origin', 'payment_reference'],
    creationMessage: { en: 'Invoice Created', ar: 'تم إنشاء الفاتورة' },
    displayNameFields: ['name', 'move_type', 'state'],
    displayName: (_env, record) => {
      if (record.name && record.name !== '/') return String(record.name);
      const type = String(record.move_type ?? 'entry');
      const label = SALE_TYPES.has(type) ? (type === 'out_refund' ? 'Draft Credit Note' : 'Draft Invoice')
        : PURCHASE_TYPES.has(type) ? (type === 'in_refund' ? 'Draft Vendor Credit Note' : 'Draft Bill') : 'Draft Entry';
      return `${label} (* ${record.id})`;
    },

    beforeCreate: async (env, vals) => {
      const out = { ...vals };
      const partnerId = m2oId(out.partner_id);
      if (partnerId && !out.invoice_payment_term_id) {
        const [partner] = await env.sudo().model('res.partner').read(partnerId, ['property_payment_term_id']);
        if (partner?.property_payment_term_id) out.invoice_payment_term_id = m2oId(partner.property_payment_term_id);
      }
      if (out.invoice_date && !out.invoice_date_due) out.invoice_date_due = out.invoice_date;
      if (!out.journal_id) out.journal_id = await defaultJournal(env, String(out.move_type ?? 'entry'));
      if (!out.currency_id && out.journal_id) {
        const journal = await env.cr.query<{ currency_id: number | null }>(`SELECT currency_id FROM account_journal WHERE id = $1`, [m2oId(out.journal_id)]);
        if (journal.rows[0]?.currency_id) out.currency_id = Number(journal.rows[0].currency_id);
      }
      return out;
    },

    computes: [{
      fields: ['amount_untaxed', 'amount_tax', 'amount_total', 'amount_residual', 'amount_untaxed_signed', 'amount_total_signed', 'payment_state'],
      depends: ['invoice_line_ids.price_subtotal', 'invoice_line_ids.price_total', 'invoice_line_ids', 'line_ids', 'currency_id', 'move_type', 'state'],
      compute: async (env, ids) => {
        const rows = await env.cr.query<{ id: number; move_type: string; state: string | null; payment_state: string | null; untaxed: number; total: number }>(
          `SELECT m.id, m.move_type, m.state, m.payment_state,
                  coalesce((SELECT sum(l.price_subtotal) FROM account_move_line l WHERE l.move_id = m.id AND l.display_type = 'product'), 0)::float8 AS untaxed,
                  coalesce((SELECT sum(l.price_total) FROM account_move_line l WHERE l.move_id = m.id AND l.display_type = 'product'), 0)::float8 AS total
           FROM account_move m WHERE m.id = ANY($1)`, [ids],
        );
        const out: Record<number, Values> = {};
        for (const row of rows.rows) {
          const rounding = await currencyRounding(env, Number(row.id));
          const untaxed = floatRound(row.untaxed, rounding);
          const total = floatRound(row.total, rounding);
          const sign = REFUND_TYPES.has(row.move_type) ? -1 : 1;
          // Residual = total less the posted payments linked to the invoice (payment.ts).
          const paid = row.state === 'posted' && total > 0 ? floatRound(await paidAmount(env, Number(row.id)), rounding) : 0;
          const residual = row.payment_state === 'reversed' ? 0 : Math.max(0, floatRound(total - paid, rounding));
          const paymentState = row.payment_state === 'reversed' ? 'reversed' : row.state !== 'posted' || total === 0 ? 'not_paid' : residual <= 0 ? 'paid' : paid > 0 ? 'partial' : 'not_paid';
          out[Number(row.id)] = {
            amount_untaxed: untaxed, amount_tax: floatRound(total - untaxed, rounding), amount_total: total,
            amount_residual: residual, amount_untaxed_signed: sign * untaxed, amount_total_signed: sign * total, payment_state: paymentState,
          };
        }
        return out;
      },
    }],

    onchange: {
      partner_id: async (env, values) => {
        const partnerId = m2oId(values.partner_id);
        if (!partnerId) return {};
        const [partner] = await env.sudo().model('res.partner').read(partnerId, ['property_payment_term_id', 'invoice_warn', 'invoice_warn_msg']);
        const value: Values = {};
        if (partner?.property_payment_term_id) value.invoice_payment_term_id = partner.property_payment_term_id;
        const result: { value: Values; warning?: { title: string; message: string } } = { value };
        if (partner?.invoice_warn && partner.invoice_warn !== 'no-message' && partner.invoice_warn_msg) {
          result.warning = { title: 'Warning for the customer', message: String(partner.invoice_warn_msg) };
        }
        return result;
      },
    },

    methods: {
      action_post: async (env, ids) => {
        const moves = env.model('account.move');
        for (const id of ids) {
          const [move] = await moves.read(id, ['state', 'move_type', 'journal_id', 'invoice_date', 'date', 'name', 'invoice_line_ids', 'partner_id', 'invoice_date_due']);
          if (move.state !== 'draft') throw new UserError({ en: 'Only draft entries can be posted.', ar: 'يمكن ترحيل القيود في حالة المسودة فقط.' });
          const moveType = String(move.move_type);
          const isInvoice = moveType !== 'entry';
          if (isInvoice && !m2oId(move.partner_id)) {
            throw new ValidationError({ en: 'The field "Customer" is required, please complete it to validate the invoice.', ar: 'حقل "العميل" مطلوب، يرجى إكماله لتأكيد الفاتورة.' });
          }
          if (isInvoice && (move.invoice_line_ids as number[]).length === 0) {
            throw new UserError({ en: 'You need to add a line before posting.', ar: 'يجب إضافة بند قبل الترحيل.' });
          }
          if (!isInvoice) {
            // Journal entries are written by hand: they must have items and balance.
            const sums = await env.cr.query<{ n: number; debit: number; credit: number }>(
              `SELECT count(*)::int AS n, coalesce(sum(debit), 0)::float8 AS debit, coalesce(sum(credit), 0)::float8 AS credit FROM account_move_line WHERE move_id = $1 AND coalesce(display_type, 'product') NOT IN ('line_section', 'line_note')`, [id],
            );
            const { n, debit, credit } = sums.rows[0];
            if (!n) throw new UserError({ en: 'You need to add a line before posting.', ar: 'يجب إضافة بند قبل الترحيل.' });
            if (Math.abs(Number(debit) - Number(credit)) > 0.005) {
              throw new UserError({ en: `You cannot post an unbalanced journal entry: debit ${Number(debit).toFixed(2)} ≠ credit ${Number(credit).toFixed(2)}.`, ar: `لا يمكن ترحيل قيد يومية غير متوازن: المدين ${Number(debit).toFixed(2)} ≠ الدائن ${Number(credit).toFixed(2)}.` });
            }
          }
          const invoiceDate = isInvoice ? String(move.invoice_date || today()) : String(move.date || today());
          const vals: Values = { state: 'posted', posted_before: true, date: invoiceDate };
          if (isInvoice) {
            vals.invoice_date = invoiceDate;
            if (!move.invoice_date_due) vals.invoice_date_due = invoiceDate;
          }
          if (!move.name || move.name === '/') {
            const journalId = m2oId(move.journal_id);
            if (!journalId) throw new UserError({ en: 'Please set a journal before posting.', ar: 'يرجى تحديد دفتر اليومية قبل الترحيل.' });
            const code = await journalSequence(env, journalId, REFUND_TYPES.has(moveType));
            vals.name = await nextByCode(env, code, { date: new Date(`${invoiceDate}T00:00:00Z`) });
          }
          await moves.write(id, vals);
          await rebuildBalancingLines(env, id);
        }
      },
      button_draft: async (env, ids) => {
        const moves = env.model('account.move');
        for (const id of ids) {
          const [move] = await moves.read(id, ['state', 'payment_state']);
          if (move.payment_state === 'paid') throw new UserError({ en: 'You cannot reset to draft a paid invoice.', ar: 'لا يمكن إعادة فاتورة مدفوعة إلى المسودة.' });
          await moves.write(id, { state: 'draft' });
        }
      },
      button_cancel: async (env, ids) => {
        await env.model('account.move').write(ids, { state: 'cancel' });
      },
      action_invoice_sent: async (_env, ids) => ({ type: 'ir.actions.client', tag: 'mail.compose', params: { model: 'account.move', res_id: ids[0] } }),
      message_sent: async (env, ids) => { await env.model('account.move').write(ids, { is_move_sent: true }); },
      preview_invoice: async (_env, ids) => ({ type: 'ir.actions.act_url', url: `/report/account.report_invoice_with_payments/${ids[0]}`, target: 'new' }),
      action_print_pdf: async (_env, ids) => ({ type: 'ir.actions.report', report_name: 'account.report_invoice_with_payments', context: { active_ids: ids } }),
      /** "Pay": the Register Payment wizard (D-3), see payment.ts. */
      action_register_payment: async (_env, ids) => ({
        type: 'ir.actions.act_window', res_model: 'account.payment.register', view_mode: 'form', target: 'new', name: { en: 'Register Payment', ar: 'تسجيل الدفع' },
        context: { active_model: 'account.move', active_ids: ids, active_id: ids[0] },
      }),
    },
  });

  registerModelHooks('account.move.line', {
    defaults: () => ({ display_type: 'product', quantity: 1, price_unit: 0, discount: 0, sequence: 10 }),
    beforeCreate: async (env, vals) => {
      const out = { ...vals };
      const moveId = m2oId(out.move_id);
      if (moveId) {
        const [move] = await env.sudo().model('account.move').read(moveId, ['partner_id', 'currency_id', 'date', 'journal_id', 'move_type']);
        if (!out.partner_id) out.partner_id = m2oId(move.partner_id);
        if (!out.currency_id) out.currency_id = m2oId(move.currency_id);
        if (!out.date) out.date = move.date;
        if (out.display_type === 'product' || out.display_type === undefined) {
          const productId = m2oId(out.product_id);
          if (productId) await fillLineFromProduct(env, out, productId, String(move.move_type));
          if (!out.account_id) {
            const journal = await env.cr.query<{ acc: number | null }>(`SELECT default_account_id AS acc FROM account_journal WHERE id = $1`, [m2oId(move.journal_id)]);
            out.account_id = journal.rows[0]?.acc ? Number(journal.rows[0].acc) : await accountOfType(env, SALE_TYPES.has(String(move.move_type)) ? 'income' : 'expense');
          }
        } else if (out.display_type === 'line_section' || out.display_type === 'line_note') {
          Object.assign(out, { product_id: false, quantity: 0, price_unit: 0, account_id: false });
        }
      }
      return out;
    },
    beforeWrite: async (env, ids, vals) => {
      const out = { ...vals };
      const productId = m2oId(out.product_id);
      if ('product_id' in out && productId) {
        const [line] = await env.sudo().model('account.move.line').read(ids[0], ['move_id']);
        const [move] = await env.sudo().model('account.move').read(m2oId(line.move_id) as number, ['move_type']);
        await fillLineFromProduct(env, out, productId, String(move.move_type), true);
      }
      return out;
    },
    computes: [{
      fields: ['price_subtotal', 'price_total', 'debit', 'credit', 'balance', 'amount_currency', 'move_type', 'parent_state'],
      depends: ['quantity', 'price_unit', 'discount', 'tax_ids', 'move_id', 'move_id.state', 'move_id.move_type', 'display_type'],
      compute: async (env, ids) => {
        const rows = await env.cr.query<{ id: number; qty: number; price: number; discount: number | null; display_type: string; move_type: string; state: string; rounding: number | null; debit: number | null; credit: number | null }>(
          `SELECT l.id, coalesce(l.quantity, 0)::float8 AS qty, coalesce(l.price_unit, 0)::float8 AS price, l.discount::float8 AS discount, l.display_type,
                  m.move_type, m.state, c.rounding::float8 AS rounding, l.debit::float8 AS debit, l.credit::float8 AS credit
           FROM account_move_line l JOIN account_move m ON m.id = l.move_id LEFT JOIN res_currency c ON c.id = m.currency_id WHERE l.id = ANY($1)`, [ids],
        );
        const out: Record<number, Values> = {};
        for (const row of rows.rows) {
          const rounding = row.rounding || 0.01;
          if (row.display_type !== 'product' || row.move_type === 'entry') {
            // Tax/payment-term lines and hand-written journal items carry their
            // own debit/credit: the balance follows them, never the price.
            const debit = row.debit ?? 0; const credit = row.credit ?? 0;
            const balance = floatRound(debit - credit, rounding);
            const manual = row.move_type === 'entry' && row.display_type === 'product';
            out[Number(row.id)] = { price_subtotal: manual ? balance : 0, price_total: manual ? balance : 0, balance, amount_currency: balance, move_type: row.move_type, parent_state: row.state };
            continue;
          }
          const subtotal = floatRound(row.qty * row.price * (1 - (row.discount ?? 0) / 100), rounding);
          const tax = floatRound(await lineTaxAmount(env, Number(row.id), subtotal, row.qty), rounding);
          const sign = (SALE_TYPES.has(row.move_type) ? 1 : -1) * (REFUND_TYPES.has(row.move_type) ? -1 : 1);
          // Income is a credit on customer invoices; expenses a debit on bills.
          const credit = sign > 0 ? subtotal : 0;
          const debit = sign > 0 ? 0 : subtotal;
          out[Number(row.id)] = {
            price_subtotal: subtotal, price_total: floatRound(subtotal + tax, rounding),
            debit, credit, balance: floatRound(debit - credit, rounding), amount_currency: floatRound(debit - credit, rounding),
            move_type: row.move_type, parent_state: row.state,
          };
        }
        return out;
      },
    }],
    onchange: {
      product_id: async (env, values) => {
        const productId = m2oId(values.product_id);
        if (!productId) return {};
        const patch: Values = {};
        await fillLineFromProduct(env, patch, productId, String(values.move_type ?? 'out_invoice'), true);
        return { value: patch };
      },
    },
  });
}

async function fillLineFromProduct(env: Environment, vals: Values, productId: number, moveType: string, force = false): Promise<void> {
  const [product] = await env.sudo().model('product.product').read(productId, ['name', 'default_code', 'lst_price', 'standard_price', 'product_tmpl_id']);
  if (!product) return;
  const templateId = m2oId(product.product_tmpl_id);
  const [template] = templateId
    ? await env.sudo().model('product.template').read(templateId, ['uom_id', 'taxes_id', 'supplier_taxes_id', 'property_account_income_id', 'property_account_expense_id', 'description_sale'])
    : [undefined];
  const sale = SALE_TYPES.has(moveType);
  const label = product.default_code ? `[${product.default_code}] ${product.name}` : String(product.name ?? '');
  if (force || !vals.name) vals.name = label;
  if (force || !vals.product_uom_id) vals.product_uom_id = template ? m2oId(template.uom_id) : false;
  if (force || vals.price_unit === undefined || vals.price_unit === 0) vals.price_unit = sale ? Number(product.lst_price ?? 0) : Number(product.standard_price ?? 0);
  const taxes = sale ? template?.taxes_id : template?.supplier_taxes_id;
  if ((force || !vals.tax_ids) && Array.isArray(taxes)) vals.tax_ids = [[6, 0, taxes as number[]]];
  const account = sale ? template?.property_account_income_id : template?.property_account_expense_id;
  if ((force || !vals.account_id) && account) vals.account_id = m2oId(account);
}
