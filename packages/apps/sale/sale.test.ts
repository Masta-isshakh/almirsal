import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgliteDatabase } from '../../engine/db/pglite.js';
import type { Database } from '../../engine/db/types.js';
import { syncSchema } from '../../engine/schema/ddl.js';
import { loadSeed } from '../../engine/seed/load.js';
import { testRegistry } from '../../engine/testing/registry.js';
import { Environment } from '../../engine/orm/env.js';
import { clearModelHooks } from '../../engine/orm/hooks.js';
import { registerApps } from '../index.js';

/**
 * D-2 on top of the real seed: quotation numbering, product-driven lines,
 * taxes, confirm/cancel/draft, invoice status.
 */
const registry = testRegistry();
let db: Database;
let env: Environment;

beforeAll(async () => {
  db = pgliteDatabase();
  await syncSchema(db, registry);
  await loadSeed(db, registry);
  clearModelHooks();
  registerApps(registry);
  env = new Environment({ registry, db, uid: 2, companyIds: [1] });
}, 240_000);

afterAll(async () => { await db.close?.(); });

describe('sales', () => {
  it('numbers quotations S00001, S00002 on save and fills addresses from the partner', async () => {
    const partner = await env.model('res.partner').create({ name: 'Deco Addict', email: 'deco@example.com' });
    const orders = env.model('sale.order');
    const first = await orders.create({ partner_id: partner });
    const second = await orders.create({ partner_id: partner });
    const [a, b] = await orders.read([first, second], ['name', 'state', 'partner_invoice_id', 'partner_shipping_id', 'validity_date', 'user_id', 'display_name']);
    expect(a.name).toBe('S00001');
    expect(b.name).toBe('S00002');
    expect(a.state).toBe('draft');
    expect(a.partner_invoice_id).toEqual([partner, 'Deco Addict']);
    expect(a.partner_shipping_id).toEqual([partner, 'Deco Addict']);
    expect(a.user_id).toEqual([2, 'masta']);
    expect(a.display_name).toBe('S00001');
    expect(String(a.validity_date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('creates a product with its variant and prices lines from it, applying taxes', async () => {
    const templateId = await env.model('product.template').create({ name: 'Consulting Day', list_price: 500, type: 'service' });
    const [variant] = await env.model('product.product').search([['product_tmpl_id', '=', templateId]]);
    expect(variant).toBeGreaterThan(0);
    const taxId = await env.model('account.tax').create({ name: 'VAT 5%', amount: 5, amount_type: 'percent', type_tax_use: 'sale' });
    await env.model('product.template').write(templateId, { taxes_id: [[6, 0, [taxId]]] });

    const partner = await env.model('res.partner').create({ name: 'Tax Payer' });
    const orderId = await env.model('sale.order').create({
      partner_id: partner,
      order_line: [
        [0, 0, { display_type: 'line_section', name: 'Services' }],
        [0, 0, { product_id: variant, product_uom_qty: 2 }],
        [0, 0, { product_id: variant, product_uom_qty: 1, discount: 10 }],
      ],
    });
    const [order] = await env.model('sale.order').read(orderId, ['amount_untaxed', 'amount_tax', 'amount_total', 'order_line', 'invoice_status']);
    expect(order.amount_untaxed).toBe(1450);
    expect(order.amount_tax).toBe(72.5);
    expect(order.amount_total).toBe(1522.5);
    expect(order.invoice_status).toBe('no');

    const lines = await env.model('sale.order.line').read(order.order_line as number[], ['name', 'price_unit', 'price_subtotal', 'price_total', 'display_type', 'product_uom_id']);
    expect(lines[0].display_type).toBe('line_section');
    expect(lines[1].name).toBe('Consulting Day');
    expect(lines[1].price_unit).toBe(500);
    expect(lines[1].price_total).toBe(1050);
    expect(lines[2].price_subtotal).toBe(450);
  });

  it('confirms, tracks the state, computes invoice status, and rejects a second confirm', async () => {
    const partner = await env.model('res.partner').create({ name: 'Confirmer' });
    const templateId = await env.model('product.template').create({ name: 'Widget', list_price: 10 });
    const [variant] = await env.model('product.product').search([['product_tmpl_id', '=', templateId]]);
    const orders = env.model('sale.order');
    const id = await orders.create({ partner_id: partner, order_line: [[0, 0, { product_id: variant, product_uom_qty: 3 }]] });

    await orders.callButton(id, 'action_confirm');
    const [order] = await orders.read(id, ['state', 'invoice_status', 'amount_to_invoice']);
    expect(order.state).toBe('sale');
    expect(order.invoice_status).toBe('to invoice');
    expect(order.amount_to_invoice).toBe(30);

    const tracking = await db.query<{ old_value_char: string; new_value_char: string }>(
      `SELECT v.old_value_char, v.new_value_char FROM mail_tracking_value v JOIN mail_message m ON m.id = v.mail_message_id
       WHERE m.model = 'sale.order' AND m.res_id = $1 AND v.field_name = 'state'`, [id],
    );
    expect(tracking.rows).toEqual([{ old_value_char: 'Quotation', new_value_char: 'Sales Order' }]);

    await expect(orders.callButton(id, 'action_confirm')).rejects.toMatchObject({ kind: 'user_error' });

    await orders.callButton(id, 'action_cancel');
    expect((await orders.read(id, ['state']))[0].state).toBe('cancel');
    await orders.callButton(id, 'action_draft');
    expect((await orders.read(id, ['state', 'invoice_status']))[0]).toMatchObject({ state: 'draft', invoice_status: 'no' });
  });

  it('marks a quotation as sent and returns a notification', async () => {
    const partner = await env.model('res.partner').create({ name: 'Sender' });
    const orders = env.model('sale.order');
    const id = await orders.create({ partner_id: partner });
    const result = await orders.callButton(id, 'action_quotation_send');
    expect(result).toMatchObject({ type: 'ir.actions.client', tag: 'display_notification' });
    expect((await orders.read(id, ['state']))[0].state).toBe('sent');
  });

  it('onchange on the partner proposes the addresses', async () => {
    const partner = await env.model('res.partner').create({ name: 'Onchange Co' });
    const result = await env.model('sale.order').onchange({ partner_id: partner }, ['partner_id']);
    expect(result.value).toMatchObject({ partner_invoice_id: partner, partner_shipping_id: partner });
  });
});
