import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgliteDatabase } from '../../engine/db/pglite.js';
import type { Database } from '../../engine/db/types.js';
import { syncSchema } from '../../engine/schema/ddl.js';
import { loadSeed } from '../../engine/seed/load.js';
import { testRegistry } from '../../engine/testing/registry.js';
import { Environment } from '../../engine/orm/env.js';
import { clearModelHooks } from '../../engine/orm/hooks.js';
import { registerApps } from '../index.js';

/** D-2 → D-3: quotation → confirm → Create Invoice wizard → post → numbering, items, qty_invoiced. */
const registry = testRegistry();
let db: Database;
let env: Environment;
let partner: number;
let variant: number;

beforeAll(async () => {
  db = pgliteDatabase();
  await syncSchema(db, registry);
  await loadSeed(db, registry);
  clearModelHooks();
  registerApps(registry);
  env = new Environment({ registry, db, uid: 2, companyIds: [1] });
  partner = await env.model('res.partner').create({ name: 'Invoice Customer' });
  const template = await env.model('product.template').create({ name: 'Service Hour', list_price: 100, type: 'service' });
  const tax = await env.model('account.tax').create({ name: 'VAT 10%', amount: 10, amount_type: 'percent', type_tax_use: 'sale' });
  await env.model('product.template').write(template, { taxes_id: [[6, 0, [tax]]] });
  [variant] = await env.model('product.product').search([['product_tmpl_id', '=', template]]);
}, 240_000);

afterAll(async () => { await db.close?.(); });

async function confirmedOrder(qty: number): Promise<number> {
  const orders = env.model('sale.order');
  const id = await orders.create({ partner_id: partner, order_line: [[0, 0, { display_type: 'line_section', name: 'Consulting' }], [0, 0, { product_id: variant, product_uom_qty: qty }]] });
  await orders.callButton(id, 'action_confirm');
  return id;
}

describe('invoicing', () => {
  it('refuses to invoice a quotation and requires invoiceable lines', async () => {
    const id = await env.model('sale.order').create({ partner_id: partner });
    const wizardEnv = env.with({ context: { active_ids: [id], active_id: id, active_model: 'sale.order' } });
    const wizard = await wizardEnv.model('sale.advance.payment.inv').create({});
    await expect(wizardEnv.model('sale.advance.payment.inv').callButton(wizard, 'create_invoices')).rejects.toMatchObject({ kind: 'user_error' });
  });

  it('creates a draft invoice from a confirmed order and links the lines', async () => {
    const orderId = await confirmedOrder(3);
    const wizardEnv = env.with({ context: { active_ids: [orderId], active_id: orderId, active_model: 'sale.order' } });
    const wizardModel = wizardEnv.model('sale.advance.payment.inv');
    const defaults = await wizardModel.defaultGet();
    expect(defaults).toMatchObject({ count: 1, advance_payment_method: 'delivered', amount_to_invoice: 300 });
    const wizard = await wizardModel.create({});
    const action = await wizardModel.callButton(wizard, 'create_invoices') as { type: string; res_model: string; res_id: number };
    expect(action).toMatchObject({ type: 'ir.actions.act_window', res_model: 'account.move' });

    const invoices = env.model('account.move');
    const [invoice] = await invoices.read(action.res_id, ['name', 'state', 'move_type', 'partner_id', 'amount_untaxed', 'amount_tax', 'amount_total', 'invoice_line_ids', 'line_ids', 'invoice_origin', 'display_name', 'journal_id', 'payment_state', 'amount_residual']);
    expect(invoice.state).toBe('draft');
    expect(invoice.move_type).toBe('out_invoice');
    expect(invoice.name).toBe('/');
    expect(invoice.display_name).toBe(`Draft Invoice (* ${action.res_id})`);
    expect(invoice.partner_id).toEqual([partner, 'Invoice Customer']);
    expect(invoice.amount_untaxed).toBe(300);
    expect(invoice.amount_tax).toBe(30);
    expect(invoice.amount_total).toBe(330);
    expect(invoice.amount_residual).toBe(330);
    expect((invoice.journal_id as [number, string])[1]).toBe('Sales');
    expect((invoice.invoice_line_ids as number[]).length).toBe(2); // section + product
    expect(invoice.line_ids).toEqual(invoice.invoice_line_ids);

    const lines = await env.model('account.move.line').read(invoice.invoice_line_ids as number[], ['display_type', 'name', 'quantity', 'price_unit', 'price_subtotal', 'price_total', 'credit', 'debit', 'sale_line_ids', 'account_id']);
    expect(lines[0].display_type).toBe('line_section');
    expect(lines[1]).toMatchObject({ display_type: 'product', quantity: 3, price_unit: 100, price_subtotal: 300, price_total: 330, credit: 300, debit: 0 });
    expect((lines[1].sale_line_ids as number[]).length).toBe(1);
    expect((lines[1].account_id as [number, string])[1]).toContain('Sales Account');

    const [order] = await env.model('sale.order').read(orderId, ['invoice_status', 'invoice_count', 'invoice_ids', 'amount_to_invoice', 'amount_invoiced']);
    expect(order.invoice_count).toBe(1);
    expect(order.invoice_ids).toEqual([action.res_id]);
    expect(order.invoice_status).toBe('invoiced');
    expect(order.amount_to_invoice).toBe(0);
    expect(order.amount_invoiced).toBe(300);
  });

  it('posts with the journal sequence and balanced journal items', async () => {
    const orderId = await confirmedOrder(2);
    const wizardEnv = env.with({ context: { active_ids: [orderId] } });
    const wizard = await wizardEnv.model('sale.advance.payment.inv').create({});
    const action = await wizardEnv.model('sale.advance.payment.inv').callButton(wizard, 'create_invoices') as { res_id: number };
    const invoices = env.model('account.move');
    await invoices.callButton(action.res_id, 'action_post');
    const [invoice] = await invoices.read(action.res_id, ['name', 'state', 'invoice_date', 'line_ids', 'invoice_line_ids', 'display_name']);
    expect(invoice.state).toBe('posted');
    expect(invoice.name).toMatch(/^INV\/\d{4}\/00001$/);
    expect(invoice.display_name).toBe(invoice.name);
    expect(invoice.invoice_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // line_ids adds the automatic tax and receivable items; invoice_line_ids does not.
    expect((invoice.line_ids as number[]).length).toBe((invoice.invoice_line_ids as number[]).length + 2);
    const items = await env.model('account.move.line').read(invoice.line_ids as number[], ['display_type', 'debit', 'credit', 'account_id']);
    const debit = items.reduce((sum, item) => sum + Number(item.debit), 0);
    const credit = items.reduce((sum, item) => sum + Number(item.credit), 0);
    expect(debit).toBeCloseTo(220);
    expect(credit).toBeCloseTo(220);
    const receivable = items.find((item) => item.display_type === 'payment_term');
    expect(receivable?.debit).toBe(220);
    expect((receivable?.account_id as [number, string])[1]).toContain('Receivable');

    // A second invoice takes the next number; a credit note its own sequence.
    const second = await confirmedOrder(1);
    const w2 = await env.with({ context: { active_ids: [second] } }).model('sale.advance.payment.inv').create({});
    const a2 = await env.with({ context: { active_ids: [second] } }).model('sale.advance.payment.inv').callButton(w2, 'create_invoices') as { res_id: number };
    await invoices.callButton(a2.res_id, 'action_post');
    expect((await invoices.read(a2.res_id, ['name']))[0].name).toMatch(/\/00002$/);
    const refund = await env.with({ context: { default_move_type: 'out_refund' } }).model('account.move').create({ partner_id: partner, invoice_line_ids: [[0, 0, { name: 'Refund', quantity: 1, price_unit: 50 }]] });
    await invoices.callButton(refund, 'action_post');
    expect((await invoices.read(refund, ['name']))[0].name).toMatch(/^RINV\/\d{4}\/00001$/);

    await expect(invoices.callButton(action.res_id, 'action_post')).rejects.toMatchObject({ kind: 'user_error' });
    await invoices.callButton(action.res_id, 'button_draft');
    expect((await invoices.read(action.res_id, ['state', 'name']))[0]).toMatchObject({ state: 'draft', name: invoice.name });
  });

  it('cancelling an invoice gives the quantity back to the order', async () => {
    const orderId = await confirmedOrder(4);
    const wizardEnv = env.with({ context: { active_ids: [orderId] } });
    const wizard = await wizardEnv.model('sale.advance.payment.inv').create({});
    const action = await wizardEnv.model('sale.advance.payment.inv').callButton(wizard, 'create_invoices') as { res_id: number };
    expect((await env.model('sale.order').read(orderId, ['invoice_status']))[0].invoice_status).toBe('invoiced');
    await env.model('account.move').callButton(action.res_id, 'button_cancel');
    const [order] = await env.model('sale.order').read(orderId, ['invoice_status', 'amount_to_invoice']);
    expect(order.invoice_status).toBe('to invoice');
    expect(order.amount_to_invoice).toBe(400);
  });

  it('creates a down payment invoice by percentage', async () => {
    const orderId = await confirmedOrder(10);
    const wizardEnv = env.with({ context: { active_ids: [orderId] } });
    const wizard = await wizardEnv.model('sale.advance.payment.inv').create({ advance_payment_method: 'percentage', amount: 30 });
    const action = await wizardEnv.model('sale.advance.payment.inv').callButton(wizard, 'create_invoices') as { res_id: number };
    const [invoice] = await env.model('account.move').read(action.res_id, ['amount_untaxed', 'invoice_line_ids']);
    expect(invoice.amount_untaxed).toBe(300);
    const [order] = await env.model('sale.order').read(orderId, ['order_line']);
    const lines = await env.model('sale.order.line').read(order.order_line as number[], ['is_downpayment', 'price_unit', 'product_uom_qty']);
    expect(lines.some((line) => line.is_downpayment && line.price_unit === 300 && line.product_uom_qty === 0)).toBe(true);
  });
});

describe('payments', () => {
  it('registers a partial then a final payment: numbered payments, balanced entries, residual and status', async () => {
    const order = await confirmedOrder(2); // 2 × 100 + 10% tax = 220
    const wizardEnv = env.with({ context: { active_ids: [order], active_id: order, active_model: 'sale.order' } });
    const wizard = await wizardEnv.model('sale.advance.payment.inv').create({ advance_payment_method: 'delivered' });
    const action = await wizardEnv.model('sale.advance.payment.inv').callButton(wizard, 'create_invoices') as { res_id: number };
    const invoices = env.model('account.move');
    await invoices.callButton(action.res_id, 'action_post');
    let [invoice] = await invoices.read(action.res_id, ['amount_total', 'amount_residual', 'payment_state']);
    expect(invoice).toMatchObject({ amount_total: 220, amount_residual: 220, payment_state: 'not_paid' });

    const payCtx = env.with({ context: { active_model: 'account.move', active_ids: [action.res_id], active_id: action.res_id } });
    const register = payCtx.model('account.payment.register');
    const defaults = await register.defaultGet();
    expect(defaults.amount).toBe(220);
    expect(defaults.payment_type).toBe('inbound');
    expect(defaults.partner_type).toBe('customer');
    expect(typeof defaults.journal_id).toBe('number');

    const first = await register.create({ ...defaults, amount: 100 });
    const result = await register.callButton(first, 'action_create_payments', { active_ids: [action.res_id] });
    expect(result).toEqual({ type: 'ir.actions.act_window_close' });
    [invoice] = await invoices.read(action.res_id, ['amount_residual', 'payment_state']);
    expect(invoice).toMatchObject({ amount_residual: 120, payment_state: 'partial' });

    const payments = await env.model('account.payment').searchRead([['reconciled_invoice_ids', 'in', [action.res_id]]], ['name', 'amount', 'state', 'move_id']);
    expect(payments).toHaveLength(1);
    expect(payments[0].name).toMatch(/^PBNK1\/\d{4}\/00001$/);
    expect(payments[0].state).toBe('paid');
    const entryId = Array.isArray(payments[0].move_id) ? payments[0].move_id[0] : 0;
    const items = await env.model('account.move.line').searchRead([['move_id', '=', entryId]], ['debit', 'credit']);
    expect(items.reduce((sum, item) => sum + Number(item.debit), 0)).toBe(100);
    expect(items.reduce((sum, item) => sum + Number(item.credit), 0)).toBe(100);

    const second = await register.create({ ...(await register.defaultGet()) });
    await register.callButton(second, 'action_create_payments', { active_ids: [action.res_id] });
    [invoice] = await invoices.read(action.res_id, ['amount_residual', 'payment_state']);
    expect(invoice).toMatchObject({ amount_residual: 0, payment_state: 'paid' });
    await expect(invoices.callButton(action.res_id, 'button_draft')).rejects.toMatchObject({ kind: 'user_error' });
    await expect(payCtx.model('account.payment.register').defaultGet()).rejects.toMatchObject({ kind: 'user_error' });
  });
});
