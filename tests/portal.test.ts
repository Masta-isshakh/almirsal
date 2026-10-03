import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgliteDatabase } from '../packages/engine/db/pglite.js';
import type { Database } from '../packages/engine/db/types.js';
import { syncSchema } from '../packages/engine/schema/ddl.js';
import { loadSeed } from '../packages/engine/seed/load.js';
import { testRegistry } from '../packages/engine/testing/registry.js';
import { Environment } from '../packages/engine/orm/env.js';
import { clearModelHooks } from '../packages/engine/orm/hooks.js';
import { registerApps } from '../packages/apps/index.js';
import { portalToken, portalUrl } from '../packages/apps/common.js';
import { tokenMatches } from '../lib/server/portal.js';
import { findReport, renderReport } from '../lib/server/reports.js';
import { renderPortalPage } from '../components/report/PortalPage.js';

/**
 * The customer portal: the link on a quotation carries a token, the token is the
 * permission, and the page shows the document with the answer the customer can
 * give. Nothing here touches signing in.
 */
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
  env = new Environment({ registry, db, uid: 2, companyIds: [1], superuser: true });
  partner = await env.model('res.partner').create({ name: 'Portal Customer', email: 'portal@example.com' });
  const template = await env.model('product.template').create({ name: 'Portal Service', list_price: 250, type: 'service' });
  [variant] = await env.model('product.product').search([['product_tmpl_id', '=', template]]);
}, 240_000);

afterAll(async () => { await db.close?.(); });

const quotation = async (values: Record<string, unknown> = {}): Promise<number> =>
  env.model('sale.order').create({ partner_id: partner, order_line: [[0, 0, { product_id: variant, product_uom_qty: 2 }]], ...values });

describe('portal links', () => {
  it('gives a record one token and keeps it', async () => {
    const id = await quotation();
    const first = await portalToken(env, 'sale.order', id);
    expect(first).toMatch(/^[a-z0-9]{48}$/);
    expect(await portalToken(env, 'sale.order', id)).toBe(first);
    expect(await portalUrl(env, 'sale.order', id)).toBe(`/my/orders/${id}?access_token=${first}`);
  });

  it('gives two records different tokens', async () => {
    const [a, b] = [await quotation(), await quotation()];
    expect(await portalToken(env, 'sale.order', a)).not.toBe(await portalToken(env, 'sale.order', b));
  });

  it('compares tokens without a shortcut', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abc', 'abd')).toBe(false);
    expect(tokenMatches('abc', 'ab')).toBe(false);
    expect(tokenMatches('', '')).toBe(false);
    expect(tokenMatches('abc', '')).toBe(false);
  });

  it('is what Preview opens, on a quotation and on an invoice', async () => {
    const id = await quotation();
    const action = await env.model('sale.order').callButton(id, 'action_preview_sale_order') as { type: string; url: string; target: string };
    expect(action).toMatchObject({ type: 'ir.actions.act_url', target: 'new' });
    expect(action.url).toMatch(new RegExp(`^/my/orders/${id}\\?access_token=[a-z0-9]{48}$`));

    const invoice = await env.model('account.move').create({ move_type: 'out_invoice', partner_id: partner, invoice_date: '2026-09-30', invoice_line_ids: [[0, 0, { name: 'Service', quantity: 1, price_unit: 100 }]] });
    const invoiceAction = await env.model('account.move').callButton(invoice, 'preview_invoice') as { url: string };
    expect(invoiceAction.url).toMatch(new RegExp(`^/my/invoices/${invoice}\\?access_token=[a-z0-9]{48}$`));
  });

  it('draws the document with the answer the customer can give', async () => {
    const id = await quotation({ require_signature: true });
    const document = await renderReport(env, findReport('sale.report_saleorder')!, id);
    const html = renderPortalPage(document, {
      rtl: false,
      title: 'Quotation S00001',
      status: 'Waiting for your answer',
      statusTone: 'waiting',
      actions: [{ id: 'accept', label: 'Accept & Sign', primary: true }, { id: 'decline', label: 'Decline' }, { id: 'print', label: 'Print' }],
      signature: { prompt: 'Type your name to sign this document.', nameLabel: 'Your name', submitLabel: 'Accept & Sign', declineLabel: 'Decline', reasonLabel: 'Reason (optional)' },
      printHref: '/report/sale.report_saleorder/1?print=1',
      postUrl: `/my/orders/${id}?access_token=x`,
    });
    expect(html).toContain('Accept &amp; Sign');
    expect(html).toContain('Waiting for your answer');
    expect(html).toContain('Portal Service');
    expect(html).toContain(`/my/orders/${id}?access_token=x`);
    // The customer's page must not offer the back office.
    expect(html).not.toContain('/odoo');
  });

  it('accepts and signs the quotation the way the route does', async () => {
    const id = await quotation({ require_signature: true });
    const orders = env.model('sale.order');
    await orders.write(id, { signed_by: 'Dana Customer', signed_on: '2026-09-30 10:00:00' });
    await orders.callButton(id, 'action_confirm');
    const [order] = await orders.read(id, ['state', 'signed_by', 'signed_on']);
    expect(order).toMatchObject({ state: 'sale', signed_by: 'Dana Customer' });
    expect(String(order.signed_on)).toContain('2026-09-30');
  });

  it('declines the quotation the way the route does', async () => {
    const id = await quotation();
    await env.model('sale.order').callButton(id, 'action_cancel');
    expect((await env.model('sale.order').read(id, ['state']))[0].state).toBe('cancel');
  });
});
