import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgliteDatabase } from '../packages/engine/db/pglite.js';
import type { Database } from '../packages/engine/db/types.js';
import { syncSchema } from '../packages/engine/schema/ddl.js';
import { loadSeed } from '../packages/engine/seed/load.js';
import { testRegistry } from '../packages/engine/testing/registry.js';
import { Environment } from '../packages/engine/orm/env.js';
import { clearModelHooks, type ActionResult } from '../packages/engine/orm/hooks.js';
import type { Domain } from '../packages/engine/registry/types.js';
import { registerApps } from '../packages/apps/index.js';

const registry = testRegistry();
let db: Database;
let env: Environment;
let product: number;
let category: number;
const vendors: number[] = [];
const sellers: number[] = [];

beforeAll(async () => {
  db = pgliteDatabase();
  await syncSchema(db, registry);
  await loadSeed(db, registry);
  clearModelHooks();
  registerApps(registry);
  env = new Environment({ registry, db, uid: 2, companyIds: [1], superuser: true });
  const template = await env.model('product.template').create({ name: 'Approval supplies', type: 'consu', purchase_method: 'receive', standard_price: 25 });
  [product] = await env.model('product.product').search([['product_tmpl_id', '=', template]]);
  for (const name of ['First supplier', 'Second supplier']) {
    const vendor = await env.model('res.partner').create({ name });
    vendors.push(vendor);
    sellers.push(await env.model('product.supplierinfo').create({ partner_id: vendor, product_tmpl_id: template, price: 25, min_qty: 0 }));
  }
  category = await env.model('approval.category').create({ name: 'Purchase approval', has_product: 'required', approval_minimum: 1 });
}, 240_000);

afterAll(async () => { await db?.close?.(); });

async function request(sellerIds: number[]) {
  return env.model('approval.request').create({
    name: `Supplies ${sellerIds.join('-')}`,
    category_id: category,
    request_owner_id: 2,
    approver_ids: [[0, 0, { user_id: 2, required: true }]],
    product_line_ids: sellerIds.map((seller) => [0, 0, { product_id: product, quantity: 4, seller_id: seller }]),
  });
}

async function approve(id: number) {
  await env.model('approval.request').callButton(id, 'action_confirm');
  await env.model('approval.request').callButton(id, 'action_approve');
}

async function purchaseIds(action: ActionResult): Promise<number[]> {
  return typeof action.res_id === 'number' ? [action.res_id] : env.model('purchase.order').search(action.domain as Domain);
}

describe('Approval → Purchase → Accounting → Payment', () => {
  it('refuses unapproved requests and groups approved lines by supplier', async () => {
    const id = await request([sellers[0], sellers[0], sellers[1]]);
    await expect(env.model('approval.request').callButton(id, 'action_create_purchase_orders')).rejects.toMatchObject({ kind: 'user_error' });
    await approve(id);
    const ids = await purchaseIds(await env.model('approval.request').callButton(id, 'action_create_purchase_orders') as ActionResult);
    const orders = await env.model('purchase.order').read(ids, ['partner_id', 'order_line', 'state']);
    expect(orders).toHaveLength(2);
    for (const order of orders) {
      const vendor = (order.partner_id as [number, string])[0];
      expect(vendors).toContain(vendor);
      expect(order.state).toBe('draft');
      expect(order.order_line).toHaveLength(vendor === vendors[0] ? 2 : 1);
    }
  });

  it('receives an approved purchase, bills the correct supplier and pays its balance', async () => {
    const id = await request([sellers[0]]);
    await approve(id);
    const [purchase] = await purchaseIds(await env.model('approval.request').callButton(id, 'action_create_purchase_orders') as ActionResult);
    await env.model('purchase.order').callButton(purchase, 'button_confirm');
    await expect(env.model('purchase.order').callButton(purchase, 'action_create_invoice')).rejects.toMatchObject({ kind: 'user_error' });
    await env.model('purchase.order').callButton(purchase, 'action_receive');
    const { res_id: bill } = await env.model('purchase.order').callButton(purchase, 'action_create_invoice') as { res_id: number };
    expect((await env.model('account.move').read(bill, ['partner_id', 'move_type', 'amount_total']))[0]).toMatchObject({ partner_id: [vendors[0], 'First supplier'], move_type: 'in_invoice', amount_total: 100 });
    await env.model('account.move').write(bill, { invoice_date: '2026-10-07' });
    await env.model('account.move').callButton(bill, 'action_post');
    const paymentEnv = env.with({ context: { active_model: 'account.move', active_ids: [bill] } });
    const wizard = await paymentEnv.model('account.payment.register').create({});
    await paymentEnv.model('account.payment.register').callButton(wizard, 'action_create_payments');
    expect((await env.model('account.move').read(bill, ['amount_residual', 'payment_state']))[0]).toMatchObject({ amount_residual: 0, payment_state: 'paid' });
    const payments = await env.model('account.payment').searchRead([['reconciled_invoice_ids', 'in', [bill]]], ['payment_type', 'partner_type', 'amount', 'move_id']);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ payment_type: 'outbound', partner_type: 'supplier', amount: 100 });
    const entry = (payments[0].move_id as [number, string])[0];
    const lines = await env.model('account.move.line').searchRead([['move_id', '=', entry]], ['debit', 'credit']);
    expect(lines.reduce((sum, line) => sum + Number(line.debit) - Number(line.credit), 0)).toBeCloseTo(0, 2);
  });
});
