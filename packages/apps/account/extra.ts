import { registerModelHooks, type Values } from '../../engine/orm/hooks.js';
import type { Environment } from '../../engine/orm/env.js';
import { UserError } from '../../engine/orm/errors.js';
import { floatRound } from '../../engine/format/index.js';
import { setParameter } from '../../engine/schema/ddl.js';
import { addDays, closeDialog, m2o, note, notify, now, openRecords, today, urlAction, windowAction, type Row } from '../common.js';

/**
 * D-3 beyond invoicing: the remaining account.move / account.payment
 * buttons (send & print, credit notes through the reversal wizard, hash
 * lock, reminders, smart buttons), lock dates, accrued orders, assets with
 * their depreciation board, loans with their schedule, reconciliation
 * models, bank statement lines and the account/tax helpers.
 */

const REFUND_OF: Record<string, string> = { out_invoice: 'out_refund', in_invoice: 'in_refund', out_refund: 'out_invoice', in_refund: 'in_invoice', out_receipt: 'out_refund', in_receipt: 'in_refund', entry: 'entry' };

/** A draft reversal of a posted move: mirrored lines, linked through reversed_entry_id. */
async function reverseMove(env: Environment, moveId: number, options: { date?: string; reason?: string; journalId?: number | false }): Promise<number> {
  const moves = env.model('account.move');
  const [move] = await moves.read(moveId, ['state', 'move_type', 'partner_id', 'journal_id', 'currency_id', 'company_id', 'invoice_line_ids', 'line_ids', 'name', 'ref', 'invoice_payment_term_id', 'fiscal_position_id']);
  if (move.state !== 'posted') throw new UserError({ en: 'Only posted entries can be reversed.', ar: 'يمكن عكس القيود المرحّلة فقط.' });
  const type = REFUND_OF[String(move.move_type)] ?? 'entry';
  const isInvoice = type !== 'entry';
  const lineIds = isInvoice ? (move.invoice_line_ids as number[]) : (move.line_ids as number[]);
  const lines = await env.model('account.move.line').read(lineIds, ['display_type', 'name', 'product_id', 'product_uom_id', 'quantity', 'price_unit', 'discount', 'tax_ids', 'account_id', 'debit', 'credit', 'sequence', 'partner_id']);
  const newLines = lines.filter((l) => isInvoice || !['tax', 'payment_term'].includes(String(l.display_type ?? ''))).map((l) => [0, 0, isInvoice
    ? { display_type: l.display_type || 'product', name: l.name, product_id: m2o(l.product_id) || false, product_uom_id: m2o(l.product_uom_id) || false, quantity: l.quantity, price_unit: l.price_unit, discount: l.discount ?? 0, tax_ids: [[6, 0, (l.tax_ids as number[]) ?? []]], account_id: m2o(l.account_id) || false, sequence: l.sequence }
    : { display_type: 'product', name: l.name, account_id: m2o(l.account_id) || false, partner_id: m2o(l.partner_id) || false, debit: l.credit ?? 0, credit: l.debit ?? 0, sequence: l.sequence }]);
  const reversal = await env.with({ context: { default_move_type: type } }).model('account.move').create({
    move_type: type, partner_id: m2o(move.partner_id) || false, journal_id: options.journalId || m2o(move.journal_id) || false, currency_id: m2o(move.currency_id) || false, company_id: m2o(move.company_id) || env.companyId,
    date: options.date ?? today(), invoice_date: isInvoice ? (options.date ?? today()) : false, ref: options.reason ? `Reversal of: ${move.name}, ${options.reason}` : `Reversal of: ${move.name}`,
    reversed_entry_id: moveId, invoice_payment_term_id: m2o(move.invoice_payment_term_id) || false, fiscal_position_id: m2o(move.fiscal_position_id) || false,
    ...(isInvoice ? { invoice_line_ids: newLines } : { line_ids: newLines }),
  });
  await note(env, 'account.move', moveId, { en: `Reversal entry created: ${options.reason ?? ''}`.trim(), ar: `تم إنشاء قيد عكسي: ${options.reason ?? ''}`.trim() });
  return reversal;
}

/* ---------- loans ---------- */

async function buildLoanSchedule(env: Environment, loanId: number): Promise<void> {
  const [loan] = await env.model('account.loan').read(loanId, ['amount_borrowed', 'interest', 'duration', 'date', 'currency_id', 'line_ids']);
  const existing = (loan.line_ids as number[]) ?? [];
  if (existing.length) await env.model('account.loan.line').unlink(existing);
  const months = Math.max(1, Math.round(Number(loan.duration ?? 12)));
  const principalTotal = Number(loan.amount_borrowed ?? 0); const interestTotal = Number(loan.interest ?? 0);
  let outstanding = principalTotal;
  const start = String(loan.date || today()).slice(0, 10);
  for (let i = 0; i < months; i++) {
    const d = new Date(`${start}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + i + 1);
    const principal = floatRound(i === months - 1 ? outstanding : principalTotal / months, 0.01);
    const interest = floatRound(interestTotal * (outstanding / Math.max(principalTotal, 0.01)) / (months / 2 + 0.5) * (months > 1 ? 1 : 1), 0.01);
    outstanding = floatRound(outstanding - principal, 0.01);
    await env.model('account.loan.line').create({ loan_id: loanId, sequence: i + 1, date: d.toISOString().slice(0, 10), principal, interest, payment: floatRound(principal + interest, 0.01), outstanding_balance: outstanding, currency_id: m2o(loan.currency_id) || false, long_term_theoretical_balance: outstanding, short_term_theoretical_balance: Math.min(outstanding, principalTotal / months * 12) });
  }
  await env.cr.query(`UPDATE account_loan SET outstanding_balance = $2, end_date = (SELECT max(date) FROM account_loan_line WHERE loan_id = $1) WHERE id = $1`, [loanId, principalTotal]);
}

export function registerAccountExtra(): void {
  registerModelHooks('account.move', {
    methods: {
      action_send_and_print: async (_env, ids) => ({ type: 'ir.actions.client', tag: 'mail.compose', params: { model: 'account.move', res_id: ids[0] } }),
      action_move_download_all: async (_env, ids) => urlAction(`/report/account.report_invoice_with_payments/${ids.join(',')}?print=1`),
      manual_reminder_action: async (env, ids) => {
        for (const id of ids) { await env.model('account.move').write(id, { last_reminder: today() }); await note(env, 'account.move', id, { en: 'Payment reminder sent to the customer.', ar: 'تم إرسال تذكير بالدفع إلى العميل.' }); }
        return { type: 'ir.actions.client', tag: 'mail.compose', params: { model: 'account.move', res_id: ids[0] } };
      },
      action_force_register_payment: async (env, ids) => env.model('account.move').callButton(ids, 'action_register_payment'),
      /** "Credit Note": the reversal wizard (S-ref 274). */
      action_reverse: async (env, ids) => {
        const [move] = await env.model('account.move').read(ids[0], ['move_type', 'journal_id', 'amount_residual']);
        return windowAction('account.move.reversal', { en: 'Credit Note', ar: 'إشعار دائن' }, { viewMode: 'form', target: 'new', context: { default_move_ids: [[6, 0, ids]], default_move_type: move.move_type, default_journal_id: m2o(move.journal_id), default_date: today(), default_residual: move.amount_residual, active_ids: ids, active_model: 'account.move' } });
      },
      button_request_cancel: async (env, ids) => { await env.model('account.move').write(ids, { need_cancel_request: true }); return notify({ en: 'Cancellation requested.', ar: 'تم طلب الإلغاء.' }); },
      action_reload_imported_data: async () => notify({ en: 'No imported data to reload for this entry.', ar: 'لا توجد بيانات مستوردة لإعادة تحميلها لهذا القيد.' }, 'info'),
      action_manual_send_for_digitization: async () => notify({ en: 'Document digitization (OCR) is not enabled on this instance.', ar: 'رقمنة المستندات (OCR) غير مفعلة في هذه النسخة.' }, 'warning'),
      action_delete_duplicates: async (env, ids) => {
        const [move] = await env.model('account.move').read(ids[0], ['duplicated_ref_ids']);
        const dups = ((move.duplicated_ref_ids as number[]) ?? []).filter((id) => id !== ids[0]);
        if (dups.length) await env.model('account.move').unlink(dups);
        return notify({ en: `${dups.length} duplicate(s) deleted.`, ar: `تم حذف ${dups.length} نسخة مكررة.` });
      },
      action_activate_currency: async (env, ids) => {
        const [move] = await env.model('account.move').read(ids[0], ['currency_id']);
        const cid = m2o(move.currency_id);
        if (cid) await env.sudo().model('res.currency').write(cid, { active: true });
      },
      button_reconcile_with_st_line: async (_env, ids) => windowAction('account.bank.statement.line', { en: 'Bank Transactions', ar: 'المعاملات البنكية' }, { domain: [['partner_id', 'in', []]] , context: { search_default_not_matched: 1 } }),
      action_open_tax_return: async () => windowAction('account.return', { en: 'Tax Returns', ar: 'الإقرارات الضريبية' }, { viewMode: 'kanban,list,form' }),
      action_open_business_doc: async (env, ids) => {
        const [move] = await env.model('account.move').read(ids[0], ['invoice_origin', 'purchase_id', 'move_type']);
        if (m2o(move.purchase_id)) return windowAction('purchase.order', { en: 'Purchase Order', ar: 'أمر الشراء' }, { resId: m2o(move.purchase_id) as number });
        if (move.invoice_origin) { const so = await env.model('sale.order').search([['name', '=', String(move.invoice_origin)]]); if (so[0]) return windowAction('sale.order', { en: 'Sales Order', ar: 'أمر البيع' }, { resId: so[0] }); }
        return notify({ en: 'No source document is linked to this entry.', ar: 'لا يوجد مستند مصدر مرتبط بهذا القيد.' }, 'info');
      },
      open_payments: async (env, ids) => {
        const rel = env.registry.models['account.payment'].fields.reconciled_invoice_ids;
        const ids2 = rel?.m2mTable ? (await env.cr.query<{ id: number }>(`SELECT DISTINCT "${rel.m2mColumn1}" AS id FROM "${rel.m2mTable}" WHERE "${rel.m2mColumn2}" = ANY($1)`, [ids])).rows.map((r) => Number(r.id)) : [];
        return windowAction('account.payment', { en: 'Payments', ar: 'المدفوعات' }, { domain: [['id', 'in', ids2]] });
      },
      open_reconcile_view: async (_env, ids) => windowAction('account.move.line', { en: 'Reconciled Entries', ar: 'القيود المسواة' }, { domain: [['move_id', 'in', ids], ['reconciled', '=', true]], viewMode: 'list' }),
      open_created_caba_entries: async (_env, ids) => windowAction('account.move', { en: 'Cash Basis Entries', ar: 'قيود الأساس النقدي' }, { domain: [['tax_cash_basis_origin_move_id', 'in', ids]] }),
      open_adjusting_entries: async (_env, ids) => windowAction('account.move', { en: 'Adjusting Entries', ar: 'قيود التسوية' }, { domain: [['reversed_entry_id', 'in', ids]] }),
      open_adjusting_entry_origin_moves: async (env, ids) => { const [m] = await env.model('account.move').read(ids[0], ['reversed_entry_id']); return windowAction('account.move', { en: 'Origin Entry', ar: 'القيد الأصلي' }, { domain: [['id', '=', m2o(m.reversed_entry_id) || 0]] }); },
      open_journal_items: async (_env, ids) => windowAction('account.move.line', { en: 'Journal Items', ar: 'عناصر اليومية' }, { domain: [['move_id', 'in', ids]], viewMode: 'list' }),
      action_open_reversal_moves: async (_env, ids) => windowAction('account.move', { en: 'Reversal Entries', ar: 'القيود العكسية' }, { domain: [['reversed_entry_id', 'in', ids]] }),
      action_open_reversed_entry: async (env, ids) => { const [m] = await env.model('account.move').read(ids[0], ['reversed_entry_id']); const rid = m2o(m.reversed_entry_id); return rid ? windowAction('account.move', { en: 'Reversed Entry', ar: 'القيد المعكوس' }, { resId: rid }) : notify({ en: 'This entry does not reverse another one.', ar: 'هذا القيد لا يعكس قيداً آخر.' }, 'info'); },
      action_open_bank_reconciliation_widget_statement: async (_env, ids) => windowAction('account.bank.statement.line', { en: 'Bank Reconciliation', ar: 'تسوية البنك' }, { domain: [['move_id', 'in', ids]], viewMode: 'kanban,list' }),
      action_open_bank_reconciliation_widget: async (_env, ids) => windowAction('account.bank.statement.line', { en: 'Bank Reconciliation', ar: 'تسوية البنك' }, { domain: [['move_id', 'in', ids]], viewMode: 'kanban,list' }),
      open_deferred_entries: async (_env, ids) => windowAction('account.move', { en: 'Deferral Entries', ar: 'قيود التأجيل' }, { domain: [['reversed_entry_id', 'in', ids], ['deferred_entry_type', '!=', false]] }),
      open_deferred_original_entry: async (env, ids) => { const [m] = await env.model('account.move').read(ids[0], ['reversed_entry_id']); return windowAction('account.move', { en: 'Related Entries', ar: 'القيود المرتبطة' }, { domain: [['id', '=', m2o(m.reversed_entry_id) || 0]] }); },
      open_loan: async (env, ids) => { const [m] = await env.model('account.move').read(ids[0], ['generating_loan_line_id']); const lineId = m2o(m.generating_loan_line_id); const loan = lineId ? (await env.cr.query<{ loan_id: number }>(`SELECT loan_id FROM account_loan_line WHERE id = $1`, [lineId])).rows[0]?.loan_id : null; return loan ? windowAction('account.loan', { en: 'Loan', ar: 'القرض' }, { resId: Number(loan) }) : notify({ en: 'No loan is linked to this entry.', ar: 'لا يوجد قرض مرتبط بهذا القيد.' }, 'info'); },
      action_view_payment_transactions: async (_env, ids) => windowAction('payment.transaction', { en: 'Payment Transactions', ar: 'معاملات الدفع' }, { domain: [['invoice_ids', 'in', ids]] }),
      action_view_source_sale_orders: async (env, ids) => {
        const rel = env.registry.models['account.move.line'].fields.sale_line_ids;
        const soIds = rel?.m2mTable ? (await env.cr.query<{ id: number }>(`SELECT DISTINCT sol.order_id AS id FROM "${rel.m2mTable}" r JOIN sale_order_line sol ON sol.id = r."${rel.m2mColumn2}" JOIN account_move_line l ON l.id = r."${rel.m2mColumn1}" WHERE l.move_id = ANY($1)`, [ids])).rows.map((r) => Number(r.id)) : [];
        const [move] = await env.model('account.move').read(ids[0], ['invoice_origin']);
        const byOrigin = move.invoice_origin ? await env.model('sale.order').search([['name', 'in', String(move.invoice_origin).split(',').map((s) => s.trim())]]) : [];
        return windowAction('sale.order', { en: 'Source Sales Orders', ar: 'أوامر البيع المصدر' }, { domain: [['id', 'in', [...new Set([...soIds, ...byOrigin])]]] });
      },
      open_asset_view: async (env, ids) => { const [m] = await env.model('account.move').read(ids[0], ['asset_id']); return windowAction('account.asset', { en: 'Asset', ar: 'الأصل' }, { domain: [['id', '=', m2o(m.asset_id) || 0]] }); },
      action_open_asset_ids: async (env, ids) => { const assets = await env.model('account.asset').search([['original_move_line_ids.move_id', 'in', ids]]).catch(() => [] as number[]); return windowAction('account.asset', { en: 'Assets', ar: 'الأصول' }, { domain: [['id', 'in', assets]] }); },
      action_show_services: async (_env, ids) => windowAction('fleet.vehicle.log.services', { en: 'Services', ar: 'الخدمات' }, { domain: [['account_move_line_id.move_id', 'in', ids]] }),
      action_purchase_matching: async (_env, ids) => windowAction('purchase.order.line', { en: 'Purchase Matching', ar: 'مطابقة المشتريات' }, { domain: [['order_id.state', '=', 'purchase'], ['qty_invoiced', '<', 'product_qty']], viewMode: 'list', context: { active_move_id: ids[0] } }),
      action_view_source_purchase_orders: async (env, ids) => { const [m] = await env.model('account.move').read(ids[0], ['purchase_id']); const pid = m2o(m.purchase_id); const byLine = await env.cr.query<{ id: number }>(`SELECT DISTINCT pol.order_id AS id FROM account_move_line l JOIN purchase_order_line pol ON pol.id = l.purchase_line_id WHERE l.move_id = ANY($1)`, [ids]); return windowAction('purchase.order', { en: 'Source Purchase Orders', ar: 'أوامر الشراء المصدر' }, { domain: [['id', 'in', [...new Set([...(pid ? [pid] : []), ...byLine.rows.map((r) => Number(r.id))])]]] }); },
      action_view_documents_account_move: async (_env, ids) => windowAction('ir.attachment', { en: 'Documents', ar: 'المستندات' }, { domain: [['res_model', '=', 'account.move'], ['res_id', 'in', ids]], viewMode: 'kanban,list' }),
      action_update_fpos_values: async (env, ids) => { for (const id of ids) { const [m] = await env.model('account.move').read(id, ['invoice_line_ids']); await env.model('account.move.line').recompute(m.invoice_line_ids as number[], ['tax_ids'], false).catch(() => undefined); } return notify({ en: 'Taxes and accounts updated from the fiscal position.', ar: 'تم تحديث الضرائب والحسابات من الوضع المالي.' }); },
      payment_action_capture: async () => notify({ en: 'No online payment transaction to capture.', ar: 'لا توجد معاملة دفع عبر الإنترنت لالتقاطها.' }, 'info'),
      payment_action_void: async () => notify({ en: 'No online payment transaction to void.', ar: 'لا توجد معاملة دفع عبر الإنترنت لإلغائها.' }, 'info'),
    },
  });

  registerModelHooks('account.move.reversal', {
    defaults: (env) => ({ date: today(), company_id: env.companyId, move_ids: Array.isArray(env.context.active_ids) ? [[6, 0, env.context.active_ids as number[]]] : [] }),
    methods: {
      refund_moves: async (env, ids) => {
        const [wizard] = await env.model('account.move.reversal').read(ids[0], ['move_ids', 'reason', 'date', 'journal_id']);
        const created: number[] = [];
        for (const moveId of (wizard.move_ids as number[]) ?? []) created.push(await reverseMove(env, moveId, { date: String(wizard.date || today()), reason: wizard.reason ? String(wizard.reason) : undefined, journalId: m2o(wizard.journal_id) }));
        return openRecords('account.move', { en: 'Credit Notes', ar: 'إشعارات دائنة' }, created);
      },
      modify_moves: async (env, ids) => {
        const [wizard] = await env.model('account.move.reversal').read(ids[0], ['move_ids', 'reason', 'date', 'journal_id']);
        const created: number[] = [];
        for (const moveId of (wizard.move_ids as number[]) ?? []) {
          const refund = await reverseMove(env, moveId, { date: String(wizard.date || today()), reason: wizard.reason ? String(wizard.reason) : undefined, journalId: m2o(wizard.journal_id) });
          await env.model('account.move').callButton(refund, 'action_post');
          // A fresh draft copy of the original to correct and post again.
          const copy = await env.model('account.move').copy(moveId, { invoice_date: String(wizard.date || today()), date: String(wizard.date || today()) });
          created.push(copy);
        }
        return openRecords('account.move', { en: 'New Invoices', ar: 'فواتير جديدة' }, created);
      },
    },
  });

  registerModelHooks('account.payment', {
    methods: {
      action_refund_wizard: async (env, ids) => {
        const created: number[] = [];
        for (const id of ids) {
          const [p] = await env.model('account.payment').read(id, ['payment_type', 'partner_type', 'partner_id', 'amount', 'journal_id', 'currency_id', 'memo', 'payment_method_line_id']);
          created.push(await env.model('account.payment').create({ payment_type: p.payment_type === 'inbound' ? 'outbound' : 'inbound', partner_type: p.partner_type, partner_id: m2o(p.partner_id) || false, amount: p.amount, journal_id: m2o(p.journal_id) || false, currency_id: m2o(p.currency_id) || false, memo: `Refund of ${p.memo ?? ''}`.trim(), payment_method_line_id: m2o(p.payment_method_line_id) || false, date: today() }));
        }
        return openRecords('account.payment', { en: 'Refunds', ar: 'المبالغ المستردة' }, created);
      },
      button_request_cancel: async (env, ids) => { await env.model('account.payment').write(ids, { need_cancel_request: true }); },
      button_open_invoices: async (env, ids) => { const rel = env.registry.models['account.payment'].fields.reconciled_invoice_ids; const inv = rel?.m2mTable ? (await env.cr.query<{ id: number }>(`SELECT "${rel.m2mColumn2}" AS id FROM "${rel.m2mTable}" WHERE "${rel.m2mColumn1}" = ANY($1)`, [ids])).rows.map((r) => Number(r.id)) : []; return windowAction('account.move', { en: 'Invoices', ar: 'الفواتير' }, { domain: [['id', 'in', inv],['move_type','in',['out_invoice','out_refund','out_receipt']]] }); },
      button_open_bills: async (env, ids) => { const rel = env.registry.models['account.payment'].fields.reconciled_invoice_ids; const inv = rel?.m2mTable ? (await env.cr.query<{ id: number }>(`SELECT "${rel.m2mColumn2}" AS id FROM "${rel.m2mTable}" WHERE "${rel.m2mColumn1}" = ANY($1)`, [ids])).rows.map((r) => Number(r.id)) : []; return windowAction('account.move', { en: 'Bills', ar: 'الفواتير' }, { domain: [['id', 'in', inv]] }); },
      button_open_statement_lines: async (_env, ids) => windowAction('account.bank.statement.line', { en: 'Bank Transactions', ar: 'المعاملات البنكية' }, { domain: [['move_id.origin_payment_id', 'in', ids]], viewMode: 'list' }),
      button_open_journal_entry: async (env, ids) => { const [p] = await env.model('account.payment').read(ids[0], ['move_id']); const mid = m2o(p.move_id); return mid ? windowAction('account.move', { en: 'Journal Entry', ar: 'قيد اليومية' }, { resId: mid }) : notify({ en: 'This payment has no journal entry yet: confirm it first.', ar: 'ليس لهذه الدفعة قيد يومية بعد: قم بتأكيدها أولاً.' }, 'info'); },
      action_open_manual_reconciliation_widget: async (env, ids) => { const [p] = await env.model('account.payment').read(ids[0], ['partner_id']); return windowAction('account.move.line', { en: 'Payment Matching', ar: 'مطابقة المدفوعات' }, { domain: [['partner_id', '=', m2o(p.partner_id) || 0], ['account_id.account_type', 'in', ['asset_receivable', 'liability_payable']], ['reconciled', '=', false]], viewMode: 'list' }); },
      action_view_refunds: async (env, ids) => { const [p] = await env.model('account.payment').read(ids[0], ['memo']); return windowAction('account.payment', { en: 'Refunds', ar: 'المبالغ المستردة' }, { domain: [['memo', '=', `Refund of ${p.memo ?? ''}`.trim()]] }); },
    },
  });

  registerModelHooks('account.loan', {
    defaults: (env) => ({ state: 'draft', date: today(), duration: 12, amount_borrowed: 0, interest: 0, company_id: env.companyId }),
    tracked: ['state', 'amount_borrowed'],
    methods: {
      action_confirm: async (env, ids) => {
        for (const id of ids) {
          const [loan] = await env.model('account.loan').read(id, ['state', 'amount_borrowed', 'line_ids']);
          if (loan.state !== 'draft') throw new UserError({ en: 'Only draft loans can be confirmed.', ar: 'يمكن تأكيد القروض في حالة المسودة فقط.' });
          if (!Number(loan.amount_borrowed)) throw new UserError({ en: 'Set the borrowed amount first.', ar: 'حدد المبلغ المقترض أولاً.' });
          if (!(loan.line_ids as number[]).length) await buildLoanSchedule(env, id);
          await env.model('account.loan').write(id, { state: 'running' });
        }
      },
      action_reset: async (env, ids) => { for (const id of ids) await buildLoanSchedule(env, id); return notify({ en: 'Amortization schedule recomputed.', ar: 'تمت إعادة حساب جدول السداد.' }); },
      action_close: async (env, ids) => { await env.model('account.loan').write(ids, { state: 'closed' }); },
      action_set_to_draft: async (env, ids) => { await env.model('account.loan').write(ids, { state: 'draft' }); },
      action_cancel: async (env, ids) => { await env.model('account.loan').write(ids, { state: 'cancelled' }); },
      action_open_loan_entries: async (_env, ids) => windowAction('account.move', { en: 'Loan Entries', ar: 'قيود القرض' }, { domain: [['generating_loan_line_id.loan_id', 'in', ids]] }),
      action_open_linked_assets: async (env, ids) => { const [l] = await env.model('account.loan').read(ids[0], ['asset_group_id']); return windowAction('account.asset', { en: 'Assets', ar: 'الأصول' }, { domain: [['asset_group_id', '=', m2o(l.asset_group_id) || 0]] }); },
    },
  });

  registerModelHooks('account.change.lock.date', {
    defaults: async (env) => {
      // Only the lock columns this database actually has: a statement that
      // names a missing column aborts the whole transaction, and catching the
      // error in JavaScript does not undo that.
      const names = ['fiscalyear_lock_date', 'tax_lock_date', 'sale_lock_date', 'purchase_lock_date', 'hard_lock_date']
        .filter((name) => env.registry.models['res.company']?.fields[name]);
      const values: Values = { company_id: env.companyId };
      for (const name of names) values[name] = false;
      if (names.length) {
        const row = await env.cr.query<Row>(`SELECT ${names.join(', ')} FROM res_company WHERE id = $1`, [env.companyId]);
        const company = (row.rows[0] ?? {}) as Record<string, unknown>;
        for (const name of names) values[name] = company[name] ?? false;
      }
      return values;
    },
    methods: {
      change_lock_date: async (env, ids) => {
        const [w] = await env.model('account.change.lock.date').read(ids[0], ['fiscalyear_lock_date', 'tax_lock_date', 'sale_lock_date', 'purchase_lock_date', 'hard_lock_date']);
        const columns = ['fiscalyear_lock_date', 'tax_lock_date', 'sale_lock_date', 'purchase_lock_date', 'hard_lock_date'].filter((c) => env.registry.models['res.company'].fields[c]);
        if (columns.length) await env.model('res.company').write(env.companyId,Object.fromEntries(columns.map(c => [c,w[c] ? String(w[c]).slice(0,10) : false])));
        for (const c of columns) await setParameter(env.cr, `rodeo.lock.${c}`, w[c] ? String(w[c]).slice(0, 10) : '');
        return notify({ en: 'Lock dates saved.', ar: 'تم حفظ تواريخ القفل.' }, 'success', { next: closeDialog() });
      },
    },
  });

  registerModelHooks('account.accrued.orders.wizard', {
    defaults: (env) => ({ company_id: env.companyId, date: today(), reversal_date: addDays(today(), 1), amount: 0, display_amount: true }),
    methods: {
      create_entries: async (env, ids) => {
        const [w] = await env.model('account.accrued.orders.wizard').read(ids[0], ['journal_id', 'account_id', 'amount', 'date', 'reversal_date']);
        const amount = Number(w.amount ?? 0);
        if (!amount) throw new UserError({ en: 'Nothing to accrue: the amount is zero.', ar: 'لا شيء للاستحقاق: المبلغ صفر.' });
        if (!m2o(w.account_id) || !m2o(w.journal_id)) throw new UserError({ en: 'Set the journal and the accrual account.', ar: 'حدد دفتر اليومية وحساب الاستحقاق.' });
        const accrualAccount = m2o(w.account_id) as number;
        const counterpart = (await env.cr.query<{ id: number }>(`SELECT id FROM account_account WHERE account_type IN ('expense', 'income') ORDER BY CASE WHEN account_type = 'expense' THEN 0 ELSE 1 END, code LIMIT 1`)).rows[0]?.id;
        if (!counterpart) throw new UserError({ en: 'No expense/income account found.', ar: 'لم يتم العثور على حساب مصروف/إيراد.' });
        const mk = (date: string, flip: boolean, ref: string) => env.with({ context: { default_move_type: 'entry' } }).model('account.move').create({ move_type: 'entry', journal_id: m2o(w.journal_id), date, ref, line_ids: [[0, 0, { name: ref, account_id: flip ? accrualAccount : Number(counterpart), debit: amount, credit: 0 }], [0, 0, { name: ref, account_id: flip ? Number(counterpart) : accrualAccount, debit: 0, credit: amount }]] });
        const accrual = await mk(String(w.date || today()), false, 'Accrued orders entry');
        const reversal = await mk(String(w.reversal_date || addDays(today(), 1)), true, 'Reversal of accrued orders entry');
        await env.model('account.move').write(reversal, { reversed_entry_id: accrual });
        return openRecords('account.move', { en: 'Accrual Entries', ar: 'قيود الاستحقاق' }, [accrual, reversal]);
      },
    },
  });

  registerModelHooks('account.reconcile.model', {
    methods: {
      action_set_manual: async (env, ids) => { await env.model('account.reconcile.model').write(ids, { auto_reconcile: false }).catch(() => undefined); return notify({ en: 'The model now suggests matches manually.', ar: 'يقترح النموذج الآن المطابقات يدوياً.' }); },
      action_set_auto_reconcile: async (env, ids) => { await env.model('account.reconcile.model').write(ids, { auto_reconcile: true }).catch(() => undefined); return notify({ en: 'Automatic reconciliation enabled.', ar: 'تم تفعيل التسوية التلقائية.' }); },
      action_reconcile_stat: async (_env, ids) => windowAction('account.move.line', { en: 'Journal Items', ar: 'عناصر اليومية' }, { domain: [['reconcile_model_id', 'in', ids]], viewMode: 'list' }),
    },
  });

  registerModelHooks('account.bank.statement.line', {
    defaults: () => ({ review_state: 'no_review' }),
    methods: {
      action_button_draft: async (env, ids) => { for (const id of ids) { const [l] = await env.model('account.bank.statement.line').read(id, ['move_id']); const mid = m2o(l.move_id); if (mid) await env.model('account.move').callButton(mid, 'button_draft').catch(() => undefined); } },
      action_save_close: async () => closeDialog(),
      action_save_new: async () => windowAction('account.bank.statement.line', { en: 'Bank Transaction', ar: 'معاملة بنكية' }, { viewMode: 'form', target: 'new' }),
    },
  });

  registerModelHooks('account.move.line', {
    methods: {
      action_reconcile: async (env, ids) => {
        const lines = await env.model('account.move.line').read(ids, ['debit', 'credit', 'account_id', 'reconciled']);
        const balance = lines.reduce((s, l) => s + Number(l.debit ?? 0) - Number(l.credit ?? 0), 0);
        if (Math.abs(balance) > 0.005) throw new UserError({ en: `The selected items are not balanced (difference ${balance.toFixed(2)}): reconciliation needs matching debits and credits.`, ar: `العناصر المحددة غير متوازنة (الفرق ${balance.toFixed(2)}): تتطلب التسوية مدين ودائن متطابقين.` });
        const number = `A${Date.now().toString(36).toUpperCase()}`;
        await env.cr.query(`UPDATE account_move_line SET reconciled = true, matching_number = $2, amount_residual = 0 WHERE id = ANY($1)`, [ids, number]);
        return notify({ en: `${ids.length} items reconciled (${number}).`, ar: `تمت تسوية ${ids.length} عناصر (${number}).` });
      },
      action_split_lines: async () => notify({ en: 'Select one line and edit its quantity to split it into two.', ar: 'حدد بنداً واحداً وعدّل كميته لتقسيمه إلى اثنين.' }, 'info'),
      turn_as_asset: async (env, ids) => {
        const created: number[] = [];
        for (const id of ids) {
          const [l] = await env.model('account.move.line').read(id, ['name', 'debit', 'credit', 'account_id', 'move_id', 'date']);
          created.push(await env.model('account.asset').create({ name: String(l.name || 'Asset'), original_value: Number(l.debit ?? 0) - Number(l.credit ?? 0), acquisition_date: String(l.date || today()).slice(0, 10), account_asset_id: m2o(l.account_id) || false, original_move_line_ids: [[6, 0, [id]]] }));
        }
        return openRecords('account.asset', { en: 'Assets', ar: 'الأصول' }, created);
      },
      open_reconcile_view: async (_env, ids) => windowAction('account.move.line', { en: 'Partially Reconciled Entries', ar: 'القيود المسواة جزئياً' }, { domain: [['id', 'in', ids]], viewMode: 'list' }),
    },
  });

  registerModelHooks('account.account', {
    // Opening balances (Accounting > Configuration > Chart of Accounts setup):
    // the debit and credit typed on an account are lines of the company's
    // opening entry, kept balanced on the undistributed-profits account.
    onCreate: async (env, ids, list) => {
      for (let index = 0; index < ids.length; index++) await applyOpening(env, ids[index], list[index] ?? {});
    },
    onWrite: async (env, ids, vals) => {
      for (const id of ids) await applyOpening(env, id, vals);
    },
    methods: {
      action_open_related_taxes: async (_env, ids) => windowAction('account.tax', { en: 'Taxes', ar: 'الضرائب' }, { domain: [['invoice_repartition_line_ids.account_id', 'in', ids]] }),
      action_open_reconcile: async (_env, ids) => windowAction('account.move.line', { en: 'Reconcile', ar: 'تسوية' }, { domain: [['account_id', 'in', ids], ['reconciled', '=', false]], viewMode: 'list' }),
      action_validate_opening_move: async (env) => {
        const draft = await env.model('account.move').search([['move_type', '=', 'entry'], ['state', '=', 'draft'], ['ref', '=', OPENING_REF], ['company_id', '=', env.companyId]]);
        for (const id of draft) await env.model('account.move').callButton(id, 'action_post');
        return notify(draft.length ? { en: 'Opening entry posted.', ar: 'تم ترحيل القيد الافتتاحي.' } : { en: 'No draft opening entry to post.', ar: 'لا يوجد قيد افتتاحي مسودة للترحيل.' }, draft.length ? 'success' : 'info');
      },
    },
  });
  registerModelHooks('account.depreciation.model', { methods: { action_open_model_assets: async (_env, ids) => windowAction('account.asset', { en: 'Assets', ar: 'الأصول' }, { domain: [['model_id', 'in', ids]] }) } });
  registerModelHooks('account.fiscal.position', {
    methods: {
      action_create_foreign_taxes: async () => notify({ en: 'Foreign taxes are created from the fiscal localization package of the destination country.', ar: 'تُنشأ الضرائب الأجنبية من حزمة التوطين المالي لدولة الوجهة.' }, 'info'),
      action_open_related_taxes: async (_env, ids) => windowAction('account.tax', { en: 'Taxes', ar: 'الضرائب' }, { domain: [['fiscal_position_ids', 'in', ids]] }),
    },
  });
  registerModelHooks('account.journal', {
    methods: {
      action_send_reminder: async () => notify({ en: 'Reminder emails are sent for the overdue invoices of this journal.', ar: 'تُرسل رسائل التذكير للفواتير المتأخرة في دفتر اليومية هذا.' }, 'info'),
    },
  });
  void now;
}

/** The opening entry's reference — how Odoo names it and how it is found. */
export const OPENING_REF = 'Opening Journal Entry';
const BALANCING_LABEL = 'Automatic Balancing Line';

/**
 * Odoo's `_set_opening_debit_credit` and `_auto_balance_opening_move`: an
 * opening debit or credit typed on an account becomes (or updates, or drops)
 * that account's line in the draft opening entry, created on first use in the
 * miscellaneous journal on the first day of the year; the entry is then
 * balanced by one line on the undistributed-profits account.
 */
async function applyOpening(env: Environment, accountId: number, vals: Values): Promise<void> {
  let debit: number | undefined;
  let credit: number | undefined;
  if ('opening_balance' in vals && !('opening_debit' in vals) && !('opening_credit' in vals)) {
    const balance = Number(vals.opening_balance) || 0;
    debit = balance > 0 ? balance : 0;
    credit = balance < 0 ? -balance : 0;
  } else {
    if ('opening_debit' in vals) debit = Number(vals.opening_debit) || 0;
    if ('opening_credit' in vals) credit = Number(vals.opening_credit) || 0;
  }
  if (debit === undefined && credit === undefined) return;

  const moveId = await openingMove(env, Boolean(debit || credit));
  if (!moveId) return;
  const lines = env.sudo().model('account.move.line');
  for (const [field, amount] of [['debit', debit], ['credit', credit]] as const) {
    if (amount === undefined) continue;
    const existing = await env.cr.query<{ id: number }>(
      `SELECT id FROM account_move_line WHERE move_id = $1 AND account_id = $2 AND coalesce(${field}, 0) <> 0 AND coalesce(name, '') <> $3 ORDER BY id`,
      [moveId, accountId, BALANCING_LABEL],
    );
    const ids = existing.rows.map((row) => Number(row.id));
    if (ids.length > 1) await lines.unlink(ids.slice(1));
    const signed = field === 'debit' ? amount : -amount;
    const amounts = { debit: field === 'debit' ? amount : 0, credit: field === 'credit' ? amount : 0, balance: signed, amount_currency: signed };
    if (ids.length && amount) await lines.write(ids[0], amounts);
    else if (ids.length) await lines.unlink(ids[0]);
    else if (amount) await lines.create({ move_id: moveId, account_id: accountId, name: 'Opening balance', display_type: 'product', ...amounts });
  }
  await balanceOpeningMove(env, moveId);
}

/** The company's draft opening entry; created when `create` and none exists. */
async function openingMove(env: Environment, create: boolean): Promise<number | false> {
  const found = await env.cr.query<{ id: number; state: string }>(
    `SELECT id, state FROM account_move WHERE move_type = 'entry' AND ref = $1 AND company_id = $2 AND state <> 'cancel' ORDER BY id LIMIT 1`,
    [OPENING_REF, env.companyId],
  );
  const row = found.rows[0];
  if (row && row.state !== 'draft') {
    throw new UserError({ en: 'The opening entry is already posted: opening balances can no longer be changed from this screen.', ar: 'تم ترحيل القيد الافتتاحي بالفعل: لم يعد بالإمكان تغيير الأرصدة الافتتاحية من هذه الشاشة.' });
  }
  if (row) return Number(row.id);
  if (!create) return false;
  const journal = await env.cr.query<{ id: number }>(
    `SELECT id FROM account_journal WHERE type = 'general' AND (company_id = $1 OR company_id IS NULL) AND (active IS NULL OR active = TRUE) ORDER BY sequence NULLS LAST, id LIMIT 1`,
    [env.companyId],
  );
  if (!journal.rows[0]) throw new UserError({ en: 'A miscellaneous journal is needed to record opening balances.', ar: 'يلزم دفتر يومية متنوع لتسجيل الأرصدة الافتتاحية.' });
  const date = `${today().slice(0, 4)}-01-01`;
  return env.sudo().model('account.move').create({ move_type: 'entry', ref: OPENING_REF, journal_id: Number(journal.rows[0].id), date, company_id: env.companyId });
}

async function balanceOpeningMove(env: Environment, moveId: number): Promise<void> {
  const lines = env.sudo().model('account.move.line');
  const sums = await env.cr.query<{ debit: number; credit: number }>(
    `SELECT coalesce(sum(debit), 0)::float8 AS debit, coalesce(sum(credit), 0)::float8 AS credit FROM account_move_line WHERE move_id = $1 AND coalesce(name, '') <> $2`,
    [moveId, BALANCING_LABEL],
  );
  const diff = floatRound(Number(sums.rows[0].debit) - Number(sums.rows[0].credit), 0.01);
  const existing = await env.cr.query<{ id: number }>(`SELECT id FROM account_move_line WHERE move_id = $1 AND name = $2 ORDER BY id`, [moveId, BALANCING_LABEL]);
  const ids = existing.rows.map((row) => Number(row.id));
  if (!diff) { if (ids.length) await lines.unlink(ids); return; }
  const amounts = { debit: diff < 0 ? -diff : 0, credit: diff > 0 ? diff : 0, balance: -diff, amount_currency: -diff };
  if (ids.length) { await lines.write(ids[0], amounts); if (ids.length > 1) await lines.unlink(ids.slice(1)); return; }
  const unaffected = await env.cr.query<{ id: number }>(
    `SELECT id FROM account_account WHERE account_type = 'equity_unaffected' AND (active IS NULL OR active = TRUE) ORDER BY code LIMIT 1`,
  );
  if (!unaffected.rows[0]) throw new UserError({ en: 'An account of type "Current Year Earnings" is needed to balance the opening entry.', ar: 'يلزم حساب من نوع "أرباح السنة الحالية" لموازنة القيد الافتتاحي.' });
  await lines.create({ move_id: moveId, account_id: Number(unaffected.rows[0].id), name: BALANCING_LABEL, display_type: 'product', ...amounts });
}
