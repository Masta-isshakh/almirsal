import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pgliteDatabase } from '../packages/engine/db/pglite.js';
import type { Database } from '../packages/engine/db/types.js';
import { syncSchema } from '../packages/engine/schema/ddl.js';
import { loadSeed } from '../packages/engine/seed/load.js';
import { testRegistry } from '../packages/engine/testing/registry.js';
import { Environment } from '../packages/engine/orm/env.js';
import { clearModelHooks } from '../packages/engine/orm/hooks.js';
import { registerApps } from '../packages/apps/index.js';
import { sendDocumentMail, setMailTransport, type OutgoingMail } from '../lib/server/mail.js';

/**
 * Sending a quotation or an invoice: the recipient gets the document and a
 * button to their own page (the portal link carries the record's token), the
 * message is kept in the chatter, and the record says it has been sent — a
 * quotation becomes Quotation Sent, as in Odoo.
 */
const registry = testRegistry();
let db: Database;
let env: Environment;
let partner: number;
let variant: number;
const sent: (OutgoingMail & { from: string })[] = [];

beforeAll(async () => {
  db = pgliteDatabase();
  await syncSchema(db, registry);
  await loadSeed(db, registry);
  clearModelHooks();
  registerApps(registry);
  env = new Environment({ registry, db, uid: 2, companyIds: [1], superuser: true });
  partner = await env.model('res.partner').create({ name: 'Mail Customer', email: 'mail.customer@example.com' });
  const template = await env.model('product.template').create({ name: 'Mail Service', list_price: 500, type: 'service' });
  [variant] = await env.model('product.product').search([['product_tmpl_id', '=', template]]);
  process.env.RODEO_MAIL_FROM = 'sales@example.com';
  process.env.RODEO_APP_URL = 'https://erp.example.com';
}, 240_000);

afterEach(() => { sent.length = 0; });

afterAll(async () => {
  setMailTransport(undefined);
  delete process.env.RODEO_MAIL_FROM;
  delete process.env.RODEO_APP_URL;
  await db.close?.();
});

/** A transport that keeps what it was asked to send. */
const collect = () => setMailTransport({ send: async (mail) => { sent.push(mail); return 'test-message-id'; } });

describe('sending a document', () => {
  it('emails the quotation with its document and a link to the customer page', async () => {
    collect();
    const order = await env.model('sale.order').create({ partner_id: partner, order_line: [[0, 0, { product_id: variant, product_uom_qty: 2 }]] });
    const result = await sendDocumentMail(env, {
      model: 'sale.order', id: order, partnerIds: [partner],
      subject: 'Your quotation', body: '<p>Hello</p>', reportName: 'sale.report_saleorder',
    });

    expect(result.sent).toBe(true);
    expect(result.recipients).toEqual(['mail.customer@example.com']);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('Your quotation');
    expect(sent[0].to[0]).toMatchObject({ email: 'mail.customer@example.com', name: 'Mail Customer' });
    // The document is in the body, and so is the portal button with its token.
    expect(sent[0].html).toContain('Mail Service');
    expect(sent[0].html).toContain('View and accept online');
    expect(sent[0].html).toMatch(new RegExp(`https://erp\\.example\\.com/my/orders/${order}\\?access_token=[a-z0-9]{48}`));

    // The quotation says it was sent, and the message is in the chatter.
    expect((await env.model('sale.order').read(order, ['state']))[0].state).toBe('sent');
    const messages = await env.model('mail.message').searchRead([['model', '=', 'sale.order'], ['res_id', '=', order]], ['subject', 'message_type']);
    expect(messages.some((message) => message.subject === 'Your quotation' && message.message_type === 'email')).toBe(true);
  });

  it('marks an invoice as sent and links to its page', async () => {
    collect();
    const invoice = await env.model('account.move').create({
      move_type: 'out_invoice', partner_id: partner, invoice_date: '2026-10-01',
      invoice_line_ids: [[0, 0, { name: 'Service', quantity: 1, price_unit: 100 }]],
    });
    await sendDocumentMail(env, { model: 'account.move', id: invoice, partnerIds: [partner], subject: 'Your invoice', body: '<p>Hello</p>', reportName: null });
    expect(sent[0].html).toContain('View the invoice');
    expect(sent[0].html).toContain(`/my/invoices/${invoice}?access_token=`);
    expect((await env.model('account.move').read(invoice, ['is_move_sent']))[0].is_move_sent).toBe(true);
  });

  it('keeps the message and says so when no transport is configured', async () => {
    setMailTransport(null);
    const order = await env.model('sale.order').create({ partner_id: partner, order_line: [[0, 0, { product_id: variant, product_uom_qty: 1 }]] });
    const result = await sendDocumentMail(env, { model: 'sale.order', id: order, partnerIds: [partner], subject: 'No transport', body: '<p>Hello</p>', reportName: null });
    expect(result.sent).toBe(false);
    expect(sent).toHaveLength(0);
    const messages = await env.model('mail.message').searchRead([['model', '=', 'sale.order'], ['res_id', '=', order]], ['body']);
    expect(messages.some((message) => String(message.body ?? '').includes('no outgoing mail server'))).toBe(true);
    // Composed and recorded, so the quotation still counts as sent.
    expect((await env.model('sale.order').read(order, ['state']))[0].state).toBe('sent');
  });

  it('refuses when nobody has an email address', async () => {
    collect();
    const nameless = await env.model('res.partner').create({ name: 'No Email' });
    const order = await env.model('sale.order').create({ partner_id: nameless });
    await expect(sendDocumentMail(env, { model: 'sale.order', id: order, partnerIds: [nameless], subject: 'x', body: 'x', reportName: null }))
      .rejects.toMatchObject({ kind: 'user_error' });
    expect(sent).toHaveLength(0);
  });
});
