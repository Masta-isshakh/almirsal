import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgliteDatabase } from '../../engine/db/pglite.js';
import type { Database } from '../../engine/db/types.js';
import { syncSchema } from '../../engine/schema/ddl.js';
import { loadSeed } from '../../engine/seed/load.js';
import { testRegistry } from '../../engine/testing/registry.js';
import { Environment } from '../../engine/orm/env.js';
import { clearModelHooks } from '../../engine/orm/hooks.js';
import { registerApps } from '../index.js';
import { setIdentityProvider } from './users.js';

/** Activities (Part G) and Settings › Users (D-16) behaviours. */
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

afterAll(async () => { setIdentityProvider(null); await db.close?.(); });

describe('activities', () => {
  it('defaults from the context and type, keeps the document activity state, marks done in the chatter', async () => {
    const partner = await env.model('res.partner').create({ name: 'Activity Partner' });
    const order = await env.model('sale.order').create({ partner_id: partner });
    const ctx = env.with({ context: { default_res_model: 'sale.order', default_res_id: order } });
    const defaults = await ctx.model('mail.activity').defaultGet();
    expect(defaults.res_model).toBe('sale.order');
    expect(defaults.res_id).toBe(order);
    expect(defaults.user_id).toBe(2);
    expect(typeof defaults.res_model_id).toBe('number');
    expect(String(defaults.date_deadline)).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    const activity = await ctx.model('mail.activity').create({ summary: 'Call back', date_deadline: yesterday });
    const [row] = await env.model('mail.activity').read(activity, ['res_name', 'res_model_id', 'active']);
    expect(String(row.res_name)).toMatch(/^S\d+/);
    expect(row.active).toBe(true);

    let [doc] = await env.model('sale.order').read(order, ['activity_state', 'activity_date_deadline', 'activity_ids']);
    expect(doc.activity_state).toBe('overdue');
    expect(String(doc.activity_date_deadline)).toBe(yesterday);
    expect(doc.activity_ids).toEqual([activity]);

    const result = await env.model('mail.activity').callButton(activity, 'action_done', { feedback: 'Reached them' });
    expect(result?.type).toBe('ir.actions.act_window_close');
    const remaining = await env.model('mail.activity').search([['res_model', '=', 'sale.order'], ['res_id', '=', order]]);
    expect(remaining).toEqual([]);
    [doc] = await env.model('sale.order').read(order, ['activity_state']);
    expect(doc.activity_state).toBe(false);
    const messages = await env.model('mail.message').searchRead([['model', '=', 'sale.order'], ['res_id', '=', order]], ['body']);
    expect(messages.some((message) => String(message.body).includes('Call back') && String(message.body).includes('Reached them'))).toBe(true);
  });

  it('refuses an activity without a document', async () => {
    await expect(env.model('mail.activity').create({ summary: 'Orphan' })).rejects.toThrow(/linked to a document/);
  });
});

describe('users', () => {
  it('creates the partner, mirrors name/email, applies the default groups and hashes the password', async () => {
    const invites: string[] = [];
    setIdentityProvider({
      invite: async (email) => { invites.push(email); return `sub-${email}`; },
      setEnabled: async () => undefined,
    });
    const defaults = await env.model('res.users').defaultGet();
    expect(defaults.state).toBe('new');
    expect(defaults.company_id).toBe(1);

    const id = await env.model('res.users').create({ name: 'Jane Doe', login: 'Jane@Example.com', new_password: 'secret-1' });
    const [user] = await env.model('res.users').read(id, ['login', 'email', 'partner_id', 'group_ids', 'password', 'cognito_sub', 'display_name']);
    expect(user.login).toBe('jane@example.com');
    expect(user.email).toBe('jane@example.com');
    expect(String(user.password)).toMatch(/^scrypt\$/);
    expect(user.cognito_sub).toBe('sub-jane@example.com');
    expect(user.display_name).toBe('Jane Doe');
    expect((user.group_ids as number[]).length).toBeGreaterThan(0);
    expect(invites).toEqual(['jane@example.com']);
    const partnerId = Array.isArray(user.partner_id) ? user.partner_id[0] : (user.partner_id as { id: number }).id;
    const [partner] = await env.model('res.partner').read(partnerId, ['name', 'email']);
    expect(partner.name).toBe('Jane Doe');
    expect(partner.email).toBe('jane@example.com');

    await env.model('res.users').write(id, { name: 'Jane Smith', email: 'jane.smith@example.com' });
    const [renamed] = await env.model('res.partner').read(partnerId, ['name', 'email']);
    expect(renamed.name).toBe('Jane Smith');
    expect(renamed.email).toBe('jane.smith@example.com');

    await expect(env.model('res.users').create({ name: 'Dup', login: 'JANE@example.com' })).rejects.toThrow(/same login/);
    await expect(env.model('res.users').unlink(2)).rejects.toThrow(/currently logged in/);
  });

  it('explains the invitation when no identity provider is configured', async () => {
    setIdentityProvider(null);
    const id = await env.model('res.users').create({ name: 'Local Only', login: 'local@example.com' });
    await expect(env.model('res.users').callButton(id, 'action_reset_password')).rejects.toThrow(/No identity provider/);
  });
});

describe('products', () => {
  it('deleting a template deletes its variants', async () => {
    const template = await env.model('product.template').create({ name: 'Throwaway', list_price: 1, type: 'service' });
    const variants = await env.model('product.product').search([['product_tmpl_id', '=', template]]);
    expect(variants.length).toBeGreaterThan(0);
    await env.model('product.template').unlink(template);
    expect(await env.model('product.product').search([['id', 'in', variants]], { activeTest: false })).toEqual([]);
  });
});

describe('settings', () => {
  it('loads defaults from stored parameters, writes only the changes, and hands them to getSetting()', async () => {
    const { getSetting } = await import('./settings.js');
    const defaults = await env.model('res.config.settings').defaultGet();
    expect(defaults.company_id).toBe(1);
    expect(defaults.active_user_count).toBeGreaterThan(0);
    const before = await env.cr.query<{ n: number }>(`SELECT count(*)::int AS n FROM ir_config_parameter WHERE key LIKE 'rodeo.settings.%'`);
    const id = await env.model('res.config.settings').create({ ...defaults, quotation_validity_days: 45, module_sale_margin: true });
    expect(id).toBeGreaterThan(0);
    const after = await env.cr.query<{ n: number }>(`SELECT count(*)::int AS n FROM ir_config_parameter WHERE key LIKE 'rodeo.settings.%'`);
    expect(after.rows[0].n - before.rows[0].n).toBe(2);
    expect(await getSetting(env, 'quotation_validity_days', 30)).toBe(45);
    expect(await getSetting(env, 'module_sale_margin', false)).toBe(true);
    const reloaded = await env.model('res.config.settings').defaultGet(['quotation_validity_days', 'module_sale_margin']);
    expect(reloaded).toEqual({ quotation_validity_days: 45, module_sale_margin: true });
    const result = await env.model('res.config.settings').callButton(id, 'execute');
    expect(result).toEqual({ type: 'ir.actions.client', tag: 'reload' });
  });
});

describe('invitations', () => {
  it('hands a temporary password to the administrator when the provider issues one and no mail server exists', async () => {
    const { setIdentityProvider: setProvider, setTemporaryPasswordMailer } = await import('./users.js');
    setProvider({
      invite: async (email, _name, options) => (options.resend ? { sub: 'sub-x', temporaryPassword: 'Temp#12345ab' } : `sub-${email}`),
      setEnabled: async () => undefined,
    });
    setTemporaryPasswordMailer(null);
    const id = await env.model('res.users').create({ name: 'Confirmed Person', login: 'confirmed@example.com' });
    const result = await env.model('res.users').callButton(id, 'action_reset_password') as { params: { type: string; message: { en: string } } };
    expect(result.params.type).toBe('warning');
    expect(result.params.message.en).toContain('confirmed@example.com: Temp#12345ab');
    // With a mailer the password travels by email and the admin only sees "sent".
    const mailed: string[] = [];
    setTemporaryPasswordMailer(async (_env, email, _name, password) => { mailed.push(`${email}:${password}`); return true; });
    const sent = await env.model('res.users').callButton(id, 'action_reset_password') as { params: { type: string } };
    expect(sent.params.type).toBe('success');
    expect(mailed).toEqual(['confirmed@example.com:Temp#12345ab']);
    setTemporaryPasswordMailer(null);
    setProvider(null);
  });
});
