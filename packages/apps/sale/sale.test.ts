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

  it('"Send" opens the email composer; the quotation is marked sent once the mail goes out', async () => {
    const partner = await env.model('res.partner').create({ name: 'Sender' });
    const orders = env.model('sale.order');
    const id = await orders.create({ partner_id: partner });
    const result = await orders.callButton(id, 'action_quotation_send');
    expect(result).toMatchObject({ type: 'ir.actions.client', tag: 'mail.compose', params: { model: 'sale.order', res_id: id } });
    expect((await orders.read(id, ['state']))[0].state).toBe('draft');
    await orders.callButton(id, 'message_sent');
    expect((await orders.read(id, ['state']))[0].state).toBe('sent');
  });

  it('onchange on the partner proposes the addresses', async () => {
    const partner = await env.model('res.partner').create({ name: 'Onchange Co' });
    const result = await env.model('sale.order').onchange({ partner_id: partner }, ['partner_id']);
    expect(result.value).toMatchObject({ partner_invoice_id: partner, partner_shipping_id: partner });
  });
});

/** The Rental app: a rental line is one with a period; pickup and return move it on. */
describe('renting', () => {
  it('marks a rental order, picks it up and returns it', async () => {
    const partner = await env.model('res.partner').create({ name: 'Rental Customer' });
    const template = await env.model('product.template').create({ name: 'Scissor Lift', list_price: 200, type: 'consu' });
    const [variant] = await env.model('product.product').search([['product_tmpl_id', '=', template]]);
    const orders = env.model('sale.order');
    const lines = env.model('sale.order.line');
    const id = await orders.create({
      partner_id: partner,
      rental_start_date: '2026-10-01 08:00:00',
      rental_return_date: '2026-10-05 08:00:00',
      order_line: [[0, 0, { product_id: variant, product_uom_qty: 2 }]],
    });

    // The line inherits the order's period, which is what makes it a rental.
    const [line] = await lines.read((await orders.read(id, ['order_line']))[0].order_line as number[], ['start_date', 'return_date', 'is_rental', 'rental_status']);
    expect(line.is_rental).toBe(true);
    expect(String(line.start_date)).toContain('2026-10-01');
    expect(String(line.return_date)).toContain('2026-10-05');
    expect(line.rental_status).toBe('pickup');
    expect((await orders.read(id, ['is_rental_order', 'rental_status', 'has_pickable_lines']))[0])
      .toMatchObject({ is_rental_order: true, rental_status: 'draft', has_pickable_lines: false });

    // Nothing can be picked up before the order is confirmed.
    await expect(orders.callButton(id, 'action_open_pickup')).rejects.toMatchObject({ kind: 'user_error' });
    await orders.callButton(id, 'action_confirm');
    expect((await orders.read(id, ['rental_status', 'has_pickable_lines', 'has_returnable_lines']))[0])
      .toMatchObject({ rental_status: 'pickup', has_pickable_lines: true, has_returnable_lines: false });

    await orders.callButton(id, 'action_open_pickup');
    expect((await lines.read(line.id as number, ['qty_delivered', 'rental_status']))[0]).toMatchObject({ qty_delivered: 2, rental_status: 'return' });
    expect((await orders.read(id, ['rental_status', 'has_pickable_lines', 'has_returnable_lines']))[0])
      .toMatchObject({ rental_status: 'return', has_pickable_lines: false, has_returnable_lines: true });
    // Pressing it again says so instead of picking up twice.
    await orders.callButton(id, 'action_open_pickup');
    expect((await lines.read(line.id as number, ['qty_delivered']))[0].qty_delivered).toBe(2);

    await orders.callButton(id, 'action_open_return');
    expect((await lines.read(line.id as number, ['qty_returned', 'rental_status']))[0]).toMatchObject({ qty_returned: 2, rental_status: 'returned' });
    expect((await orders.read(id, ['rental_status', 'has_returnable_lines']))[0]).toMatchObject({ rental_status: 'returned', has_returnable_lines: false });

    // The Rental app's own list and the schedule find it by these two fields.
    expect(await orders.search([['is_rental_order', '=', true]])).toContain(id);
    expect(await lines.search([['is_rental', '=', true], ['state', '!=', 'cancel']])).toContain(line.id);
  });

  it('leaves an ordinary order alone', async () => {
    const partner = await env.model('res.partner').create({ name: 'Plain Customer' });
    const template = await env.model('product.template').create({ name: 'Plain Service', list_price: 50, type: 'service' });
    const [variant] = await env.model('product.product').search([['product_tmpl_id', '=', template]]);
    const id = await env.model('sale.order').create({ partner_id: partner, order_line: [[0, 0, { product_id: variant, product_uom_qty: 1 }]] });
    expect((await env.model('sale.order').read(id, ['is_rental_order', 'rental_status', 'has_pickable_lines']))[0])
      .toMatchObject({ is_rental_order: false, rental_status: false, has_pickable_lines: false });
  });
});

/** Quotation templates: picking one fills the quotation. */
describe('quotation templates', () => {
  it('copies the template lines, terms and validity onto a new quotation', async () => {
    const partner = await env.model('res.partner').create({ name: 'Template Customer' });
    const template = await env.model('product.template').create({ name: 'Workshop Day', list_price: 750, type: 'service' });
    const [variant] = await env.model('product.product').search([['product_tmpl_id', '=', template]]);
    const templates = env.model('sale.order.template');
    // The type comes from the model's defaults, as on the form.
    expect(await templates.defaultGet()).toMatchObject({ template_type: 'quotation' });
    const quoteTemplate = await templates.create({
      ...(await templates.defaultGet()),
      name: 'Standard Workshop',
      number_of_days: 20,
      note: 'Payment within 15 days.',
      sale_order_template_line_ids: [
        [0, 0, { display_type: 'line_section', name: 'Workshop', sequence: 1 }],
        [0, 0, { product_id: variant, product_uom_qty: 3, sequence: 2 }],
        [0, 0, { product_id: variant, product_uom_qty: 1, discount: 50, is_optional: true, sequence: 3 }],
      ],
    });

    const orders = env.model('sale.order');
    const id = await orders.create({ partner_id: partner, sale_order_template_id: quoteTemplate });
    const [order] = await orders.read(id, ['order_line', 'note', 'validity_date', 'amount_untaxed']);
    const lines = await env.model('sale.order.line').read(order.order_line as number[], ['display_type', 'name', 'product_uom_qty', 'price_unit', 'price_subtotal']);
    // The section and the product line come over; the optional extra does not.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ display_type: 'line_section', name: 'Workshop' });
    expect(lines[1]).toMatchObject({ product_uom_qty: 3, price_unit: 750, price_subtotal: 2250 });
    expect(order.amount_untaxed).toBe(2250);
    expect(order.note).toBe('Payment within 15 days.');
    expect(String(order.validity_date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // A quotation that already has lines keeps them.
    const own = await orders.create({ partner_id: partner, order_line: [[0, 0, { product_id: variant, product_uom_qty: 9 }]] });
    await orders.write(own, { sale_order_template_id: quoteTemplate });
    const keptIds = (await orders.read(own, ['order_line']))[0].order_line as number[];
    expect(keptIds).toHaveLength(1);
    expect((await env.model('sale.order.line').read(keptIds[0], ['product_uom_qty']))[0].product_uom_qty).toBe(9);

    // Picking the template in the form fills the terms straight away.
    const onchange = await orders.onchange({ sale_order_template_id: quoteTemplate }, ['sale_order_template_id']);
    expect(onchange.value).toMatchObject({ note: 'Payment within 15 days.' });
  });
});
