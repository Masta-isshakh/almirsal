import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pgliteDatabase } from '@engine/db/pglite';
import type { Database } from '@engine/db/types';
import { syncSchema } from '@engine/schema/ddl';
import { loadSeed } from '@engine/seed/load';
import { testRegistry } from '@engine/testing/registry';
import { Environment } from '@engine/orm/env';
import { clearModelHooks, hooksFor } from '@engine/orm/hooks';
import { registerApps } from '@/packages/apps/index';

vi.mock('@/lib/server/registry', async () => {
  const { testRegistry: make } = await import('@engine/testing/registry');
  const registry = make();
  return { getRegistry: () => registry };
});

/** Send-by-email: composer defaults, SES transport call, chatter log, "sent" state. */
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

describe('send by email', () => {
  it('composes, sends through the transport, logs the email and marks the quotation sent', async () => {
    const { composerDefaults, sendDocumentMail, setMailTransport } = await import('@/lib/server/mail');
    const partner = await env.model('res.partner').create({ name: 'Mail Customer', email: 'customer@example.com' });
    const template = await env.model('product.template').create({ name: 'Mail Service', list_price: 50, type: 'service' });
    const [variant] = await env.model('product.product').search([['product_tmpl_id', '=', template]]);
    const order = await env.model('sale.order').create({ partner_id: partner, order_line: [[0, 0, { product_id: variant, product_uom_qty: 2 }]] });

    const defaults = await composerDefaults(env, 'sale.order', order);
    expect(defaults.subject).toMatch(/Quotation S\d+/);
    expect(defaults.recipients[0].email).toBe('customer@example.com');
    expect(defaults.reportName).toBe('sale.report_saleorder');

    const sent: { from: string; to: { email: string }[]; subject: string; html: string }[] = [];
    process.env.RODEO_MAIL_FROM = 'noreply@example.com';
    setMailTransport({ send: async (mail) => { sent.push(mail); return 'msg-1'; } });
    const result = await sendDocumentMail(env, { model: 'sale.order', id: order, partnerIds: defaults.partnerIds, subject: defaults.subject, body: '<p>Hello</p>', reportName: defaults.reportName });
    expect(result.sent).toBe(true);
    expect(sent[0].to[0].email).toBe('customer@example.com');
    expect(sent[0].html).toContain('o_report_lines');
    expect(sent[0].html).toContain('Mail Service');

    await hooksFor('sale.order').methods!.message_sent(env, [order], {});
    const [row] = await env.model('sale.order').read(order, ['state']);
    expect(row.state).toBe('sent');
    const messages = await env.model('mail.message').searchRead([['model', '=', 'sale.order'], ['res_id', '=', order], ['message_type', '=', 'email']], ['subject', 'partner_ids']);
    expect(messages).toHaveLength(1);
    expect(messages[0].partner_ids).toEqual([partner]);

    // Without a transport the message is still logged, flagged as not sent.
    setMailTransport(null);
    delete process.env.RODEO_MAIL_FROM;
    const offline = await sendDocumentMail(env, { model: 'sale.order', id: order, partnerIds: defaults.partnerIds, subject: 's', body: '<p>x</p>', reportName: null });
    expect(offline.sent).toBe(false);
    setMailTransport(undefined);
  });
});
