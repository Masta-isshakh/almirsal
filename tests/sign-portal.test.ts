import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgliteDatabase } from '../packages/engine/db/pglite.js';
import type { Database } from '../packages/engine/db/types.js';
import { syncSchema } from '../packages/engine/schema/ddl.js';
import { loadSeed } from '../packages/engine/seed/load.js';
import { testRegistry } from '../packages/engine/testing/registry.js';
import { Environment } from '../packages/engine/orm/env.js';
import { clearModelHooks } from '../packages/engine/orm/hooks.js';
import { registerApps } from '../packages/apps/index.js';

/**
 * Signing from a link: every signer gets their own token, sending puts the links
 * where the sender can copy them, and a signature moves the request on. The page
 * itself is `app/sign/[item]/route.ts`; this covers what it writes.
 */
const registry = testRegistry();
let db: Database;
let env: Environment;
let template: number;

beforeAll(async () => {
  db = pgliteDatabase();
  await syncSchema(db, registry);
  await loadSeed(db, registry);
  clearModelHooks();
  registerApps(registry);
  env = new Environment({ registry, db, uid: 2, companyIds: [1], superuser: true });
  template = await env.model('sign.template').create({ name: 'NDA' });
}, 240_000);

afterAll(async () => { await db.close?.(); });

describe('signing from a link', () => {
  it('gives every signer a token of their own', async () => {
    const first = await env.model('res.partner').create({ name: 'First Signer', email: 'first@example.com' });
    const second = await env.model('res.partner').create({ name: 'Second Signer', email: 'second@example.com' });
    const request = await env.model('sign.request').create({
      template_id: template,
      request_item_ids: [[0, 0, { partner_id: first }], [0, 0, { partner_id: second }]],
    });
    const items = await env.model('sign.request.item').searchRead([['sign_request_id', '=', request]], ['access_token', 'partner_id', 'state', 'signer_email'], { order: 'id' });
    expect(items).toHaveLength(2);
    expect(items[0].access_token).toMatch(/^[a-z0-9]{48}$/);
    expect(items[1].access_token).not.toBe(items[0].access_token);
    expect(items[0].signer_email).toBe('first@example.com');
    expect((await env.model('sign.request').read(request, ['nb_total', 'nb_closed']))[0]).toMatchObject({ nb_total: 2, nb_closed: 0 });
  });

  it('puts the links in the chatter when the request is sent', async () => {
    const partner = await env.model('res.partner').create({ name: 'Linked Signer' });
    const request = await env.model('sign.request').create({ template_id: template, request_item_ids: [[0, 0, { partner_id: partner }]] });
    await env.model('sign.request').callButton(request, 'action_send');
    const [item] = await env.model('sign.request.item').searchRead([['sign_request_id', '=', request]], ['access_token']);
    const messages = await env.model('mail.message').searchRead([['model', '=', 'sign.request'], ['res_id', '=', request]], ['body']);
    const bodies = messages.map((message) => String(message.body ?? '')).join('\n');
    expect(bodies).toContain(`/sign/${item.id}?token=${item.access_token}`);
    expect(bodies).toContain('Linked Signer');
  });

  it('moves the request on as the signers sign, and closes it at the last one', async () => {
    const first = await env.model('res.partner').create({ name: 'A Signer' });
    const second = await env.model('res.partner').create({ name: 'B Signer' });
    const request = await env.model('sign.request').create({
      template_id: template,
      request_item_ids: [[0, 0, { partner_id: first }], [0, 0, { partner_id: second }]],
    });
    await env.model('sign.request').callButton(request, 'action_send');
    const items = await env.model('sign.request.item').search([['sign_request_id', '=', request]]);

    // What the page writes when the first signer types their name.
    await env.model('sign.request.item').write(items[0], { state: 'completed', signing_date: '2026-09-30', signature: Buffer.from('A Signer', 'utf8').toString('base64') });
    expect((await env.model('sign.request').read(request, ['nb_closed', 'nb_wait', 'state']))[0]).toMatchObject({ nb_closed: 1, nb_wait: 1, state: 'sent' });

    await env.model('sign.request.item').write(items[1], { state: 'completed', signing_date: '2026-09-30' });
    const [signed] = await env.model('sign.request').read(request, ['nb_closed', 'nb_wait', 'state', 'completion_date']);
    expect(signed).toMatchObject({ nb_closed: 2, nb_wait: 0, state: 'signed' });
    expect(String(signed.completion_date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // The signed document is offered only once everybody has signed.
    const action = await env.model('sign.request').callButton(request, 'get_sign_request_documents') as { type: string; url?: string };
    expect(action.type).toBe('ir.actions.act_url');
  });

  it('reminds only the signers who have not signed', async () => {
    const first = await env.model('res.partner').create({ name: 'Done Signer' });
    const second = await env.model('res.partner').create({ name: 'Waiting Signer' });
    const request = await env.model('sign.request').create({
      template_id: template,
      request_item_ids: [[0, 0, { partner_id: first }], [0, 0, { partner_id: second }]],
    });
    await env.model('sign.request').callButton(request, 'action_send');
    const items = await env.model('sign.request.item').search([['sign_request_id', '=', request]]);
    await env.model('sign.request.item').write(items[0], { state: 'completed' });
    await env.model('sign.request').callButton(request, 'send_signature_accesses');
    const messages = await env.model('mail.message').searchRead([['model', '=', 'sign.request'], ['res_id', '=', request]], ['body']);
    const reminder = messages.map((message) => String(message.body ?? '')).filter((body) => body.includes('Reminder')).join('\n');
    expect(reminder).toContain('Waiting Signer');
    expect(reminder).not.toContain('Done Signer');
  });

  it('cancelling a request leaves the signed items alone', async () => {
    const first = await env.model('res.partner').create({ name: 'Signed Already' });
    const second = await env.model('res.partner').create({ name: 'Never Signed' });
    const request = await env.model('sign.request').create({
      template_id: template,
      request_item_ids: [[0, 0, { partner_id: first }], [0, 0, { partner_id: second }]],
    });
    const items = await env.model('sign.request.item').search([['sign_request_id', '=', request]]);
    await env.model('sign.request.item').write(items[0], { state: 'completed' });
    await env.model('sign.request').callButton(request, 'cancel');
    const states = await env.model('sign.request.item').read(items, ['state']);
    expect(states.map((item) => item.state)).toEqual(['completed', 'canceled']);
    expect((await env.model('sign.request').read(request, ['state']))[0].state).toBe('canceled');
  });
});
