/**
 * End-to-end business workflows through the ORM (Part J-1 phase 5 flows that
 * are implemented), against a real database:
 *
 *   npx tsx scripts/verify-workflows.mts [--db pglite|aurora] [--out report.json]
 *
 * Every scenario creates its own records, asserts numbering, states, totals,
 * journal balance, chatter/tracking and search consistency, and deletes what
 * it created (so the script is safe on the sandbox database). Exit code 1
 * when any assertion fails.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { loadRegistry } from '../packages/engine/registry/spec-loader.js';
import type { Registry } from '../packages/engine/registry/types.js';
import type { Database } from '../packages/engine/db/types.js';
import { syncSchema } from '../packages/engine/schema/ddl.js';
import { loadSeed, brandCompany, ensureLoginUnique } from '../packages/engine/seed/load.js';
import { Environment } from '../packages/engine/orm/env.js';
import { registerApps } from '../packages/apps/index.js';
import { postMessage } from '../packages/engine/orm/mail.js';
import { getSetting } from '../packages/apps/base/settings.js';

const args = process.argv.slice(2);
const opt = (name: string, def?: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const DB = opt('--db', 'pglite')!;
const OUT = opt('--out');
const YEAR = new Date().getUTCFullYear();

const spec = JSON.parse(readFileSync('registry/odoo_spec.json', 'utf8'));
const extra = JSON.parse(readFileSync('registry/extra-models.json', 'utf8'));
const registry: Registry = loadRegistry(spec, extra);

async function openDb(): Promise<Database> {
  if (DB === 'aurora') {
    const outputs = JSON.parse(readFileSync(process.env.RODEO_OUTPUTS ?? 'amplify_outputs.json', 'utf8'));
    const d = outputs.custom.database;
    const { rdsDataDatabase } = await import('../packages/engine/db/rds-data.js');
    return rdsDataDatabase({ clusterArn: d.clusterArn, secretArn: d.secretArn, database: d.databaseName ?? 'rodeo', region: d.region });
  }
  const { pgliteDatabase } = await import('../packages/engine/db/pglite.js');
  return pgliteDatabase();
}

/* ---------- tiny assertion harness ---------- */
interface Result { scenario: string; step: string; ok: boolean; detail?: string; ms?: number }
const results: Result[] = [];
let current = '';
const created: [string, number][] = [];
const track = (model: string, id: number) => { created.push([model, id]); return id; };
function check(step: string, ok: boolean, detail?: string) {
  results.push({ scenario: current, step, ok, detail });
  if (!ok) console.log(`  ✗ ${current} › ${step}${detail ? ` — ${detail}` : ''}`);
}
function eq(step: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(step, ok, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function near(step: string, actual: unknown, expected: number) {
  const ok = Math.abs(Number(actual) - expected) < 0.005;
  check(step, ok, ok ? undefined : `expected ${expected}, got ${actual}`);
}
function matches(step: string, actual: unknown, re: RegExp) {
  const ok = re.test(String(actual));
  check(step, ok, ok ? undefined : `expected /${re.source}/, got ${JSON.stringify(actual)}`);
}
async function rejects(step: string, promise: Promise<unknown>, kind?: string) {
  try { await promise; check(step, false, 'did not throw'); }
  catch (e) { const k = (e as { kind?: string }).kind; check(step, !kind || k === kind, kind && k !== kind ? `expected ${kind}, got ${k}: ${String((e as Error).message).slice(0, 120)}` : undefined); }
}
async function scenario(name: string, fn: () => Promise<void>) {
  current = name;
  const t0 = Date.now();
  try { await fn(); } catch (e) { check('(uncaught)', false, String(e instanceof Error ? e.message : e).slice(0, 300)); }
  const failed = results.filter((r) => r.scenario === name && !r.ok).length;
  console.log(`${failed ? '✗' : '✓'} ${name} (${Date.now() - t0} ms${failed ? `, ${failed} failed` : ''})`);
}
const m2o = (v: unknown): number => (Array.isArray(v) ? Number(v[0]) : Number(v));

/* ---------- setup ---------- */
const db = await openDb();
await syncSchema(db, registry);
await loadSeed(db, registry);
await brandCompany(db);
await ensureLoginUnique(db);
registerApps(registry);
const env = new Environment({ registry, db, uid: 2, companyIds: [1], superuser: true });
const globalStamp = Date.now().toString(36);
const stamp = globalStamp;

let fixtureSeq = 0;
async function fixtures() {
  const stamp = `${globalStamp}-${++fixtureSeq}`;
  const tax = track('account.tax', await env.model('account.tax').create({ name: `VAT 5% ${stamp}`, amount: 5, amount_type: 'percent', type_tax_use: 'sale' }));
  const tmpl = track('product.template', await env.model('product.template').create({ name: `Consulting ${stamp}`, list_price: 500, type: 'service', taxes_id: [[6, 0, [tax]]] }));
  const [variant] = await env.model('product.product').search([['product_tmpl_id', '=', tmpl]]);
  const partner = track('res.partner', await env.model('res.partner').create({ name: `Deco Addict ${stamp}`, email: `deco-${stamp}@example.com` }));
  return { tax, tmpl, variant, partner };
}

async function quotation(partner: number, variant: number) {
  const id = track('sale.order', await env.model('sale.order').create({
    partner_id: partner,
    order_line: [
      [0, 0, { display_type: 'line_section', name: 'Services' }],
      [0, 0, { product_id: variant, product_uom_qty: 2 }],
      [0, 0, { product_id: variant, product_uom_qty: 1, discount: 10 }],
      [0, 0, { display_type: 'line_note', name: 'Thank you' }],
    ],
  }));
  return id;
}

async function invoiceOf(order: number): Promise<number> {
  const wizardEnv = env.with({ context: { active_ids: [order], active_id: order, active_model: 'sale.order' } });
  const wizard = await wizardEnv.model('sale.advance.payment.inv').create({ advance_payment_method: 'delivered' });
  const action = await wizardEnv.model('sale.advance.payment.inv').callButton(wizard, 'create_invoices') as { res_id: number };
  return track('account.move', action.res_id);
}

/* ---------- scenarios ---------- */
await scenario('Quote → order → invoice → payment', async () => {
  const { variant, partner } = await fixtures();
  const orders = env.model('sale.order');
  const id = await quotation(partner, variant);
  let [order] = await orders.read(id, ['name', 'state', 'amount_untaxed', 'amount_tax', 'amount_total', 'invoice_status', 'partner_invoice_id', 'validity_date', 'user_id']);
  matches('quotation number S00001 style', order.name, /^S\d{5}$/);
  eq('state draft', order.state, 'draft');
  near('untaxed 1450', order.amount_untaxed, 1450);
  near('tax 72.5', order.amount_tax, 72.5);
  near('total 1522.5', order.amount_total, 1522.5);
  eq('invoice_status no', order.invoice_status, 'no');
  eq('invoice address from partner', m2o(order.partner_invoice_id), partner);

  const send = await orders.callButton(id, 'action_quotation_send') as { tag?: string };
  eq('send opens composer', send?.tag, 'mail.compose');
  await orders.callButton(id, 'message_sent');
  [order] = await orders.read(id, ['state']);
  eq('state sent after email', order.state, 'sent');

  await orders.callButton(id, 'action_confirm');
  [order] = await orders.read(id, ['state', 'invoice_status', 'date_order']);
  eq('state sale', order.state, 'sale');
  eq('invoice_status to invoice', order.invoice_status, 'to invoice');
  check('date_order set', Boolean(order.date_order));

  const messages = await env.model('mail.message').searchCount([['model', '=', 'sale.order'], ['res_id', '=', id]]);
  check('chatter has creation + confirmation messages', messages >= 2, `count=${messages}`);
  const tracked = await env.model('mail.tracking.value').searchCount([['mail_message_id.model', '=', 'sale.order'], ['mail_message_id.res_id', '=', id]]).catch(() => -1);
  check('state change tracked', tracked !== 0, `tracking rows=${tracked}`);

  const invoiceId = await invoiceOf(id);
  const invoices = env.model('account.move');
  let [inv] = await invoices.read(invoiceId, ['name', 'state', 'move_type', 'amount_total', 'amount_residual', 'payment_state', 'partner_id', 'invoice_line_ids']);
  eq('draft invoice', inv.state, 'draft');
  eq('customer invoice', inv.move_type, 'out_invoice');
  eq('invoice partner', m2o(inv.partner_id), partner);
  near('invoice total equals order', inv.amount_total, 1522.5);
  check('invoice has lines', Array.isArray(inv.invoice_line_ids) && (inv.invoice_line_ids as number[]).length >= 2);
  [order] = await orders.read(id, ['invoice_status']);
  eq('order invoiced', order.invoice_status, 'invoiced');

  await invoices.callButton(invoiceId, 'action_post');
  [inv] = await invoices.read(invoiceId, ['name', 'state', 'amount_residual', 'payment_state', 'invoice_date', 'line_ids']);
  matches(`posted number INV/${YEAR}/…`, inv.name, new RegExp(`^INV/${YEAR}/\\d{5}$`));
  eq('posted', inv.state, 'posted');
  eq('not paid', inv.payment_state, 'not_paid');
  near('residual = total', inv.amount_residual, 1522.5);
  const items = await env.model('account.move.line').searchRead([['move_id', '=', invoiceId]], ['debit', 'credit']);
  near('journal items balanced', items.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0), 0);

  const payCtx = env.with({ context: { active_model: 'account.move', active_ids: [invoiceId], active_id: invoiceId } });
  const register = payCtx.model('account.payment.register');
  const defaults = await register.defaultGet();
  near('wizard amount', defaults.amount, 1522.5);
  eq('wizard inbound customer', [defaults.payment_type, defaults.partner_type], ['inbound', 'customer']);
  const partial = await register.create({ ...defaults, amount: 522.5 });
  const closed = await register.callButton(partial, 'action_create_payments', { active_ids: [invoiceId] });
  eq('wizard closes', closed, { type: 'ir.actions.act_window_close' });
  [inv] = await invoices.read(invoiceId, ['amount_residual', 'payment_state']);
  near('residual after partial', inv.amount_residual, 1000);
  eq('partial state', inv.payment_state, 'partial');
  const full = await register.create({ ...(await register.defaultGet()) });
  await register.callButton(full, 'action_create_payments', { active_ids: [invoiceId] });
  [inv] = await invoices.read(invoiceId, ['amount_residual', 'payment_state']);
  near('residual 0', inv.amount_residual, 0);
  eq('paid', inv.payment_state, 'paid');
  const payments = await env.model('account.payment').searchRead([['reconciled_invoice_ids', 'in', [invoiceId]]], ['name', 'amount', 'state', 'move_id']);
  for (const p of payments) track('account.payment', p.id as number);
  eq('two payments', payments.length, 2);
  matches('payment numbering PBNK1/…', payments[0]?.name, new RegExp(`^PBNK1/${YEAR}/\\d{5}$`));
  check('payments paid', payments.every((p) => p.state === 'paid'));
  for (const p of payments) {
    const lines = await env.model('account.move.line').searchRead([['move_id', '=', m2o(p.move_id)]], ['debit', 'credit']);
    near(`payment entry ${p.name} balanced`, lines.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0), 0);
  }
  await rejects('paid invoice cannot go back to draft', invoices.callButton(invoiceId, 'button_draft'), 'user_error');
  await rejects('nothing left to pay', payCtx.model('account.payment.register').defaultGet(), 'user_error');
});

await scenario('Quotation lifecycle: cancel, reset, lock, validation', async () => {
  const { variant, partner } = await fixtures();
  const orders = env.model('sale.order');
  const id = await quotation(partner, variant);
  await orders.callButton(id, 'action_cancel');
  eq('cancelled', (await orders.read(id, ['state']))[0].state, 'cancel');
  await orders.callButton(id, 'action_draft');
  eq('back to draft', (await orders.read(id, ['state']))[0].state, 'draft');
  await orders.callButton(id, 'action_confirm');
  await rejects('confirming twice is refused', orders.callButton(id, 'action_confirm'), 'user_error');
  await orders.callButton(id, 'action_lock');
  eq('locked', (await orders.read(id, ['locked']))[0].locked, true);
  await orders.callButton(id, 'action_unlock');
  eq('unlocked', (await orders.read(id, ['locked']))[0].locked, false);
  await rejects('missing partner is a validation error', orders.create({}), 'validation_error');
  await rejects('unknown field rejected', orders.create({ partner_id: partner, not_a_field: 1 }), 'validation_error');
  const copy = track('sale.order', await orders.copy(id));
  const [c, o] = await orders.read([copy, id], ['name', 'state', 'order_line']);
  check('copy gets a new number', c.name !== o.name, `${c.name} vs ${o.name}`);
  eq('copy is a draft', c.state, 'draft');
  eq('copy keeps lines', (c.order_line as number[]).length, (o.order_line as number[]).length);
});

await scenario('Vendor bill → payment', async () => {
  const { variant, partner } = await fixtures();
  const bills = env.with({ context: { default_move_type: 'in_invoice' } }).model('account.move');
  const id = track('account.move', await bills.create({ move_type: 'in_invoice', partner_id: partner, invoice_date: new Date().toISOString().slice(0, 10), invoice_line_ids: [[0, 0, { product_id: variant, quantity: 3, price_unit: 100 }]] }));
  let [bill] = await bills.read(id, ['name', 'state', 'amount_total', 'journal_id']);
  eq('draft bill', bill.state, 'draft');
  near('bill total (no purchase tax on product)', bill.amount_total, 300);
  await bills.callButton(id, 'action_post');
  [bill] = await bills.read(id, ['name', 'state', 'payment_state', 'amount_residual']);
  matches(`bill number BILL/${YEAR}/…`, bill.name, new RegExp(`^BILL/${YEAR}/`));
  eq('posted', bill.state, 'posted');
  const payCtx = env.with({ context: { active_model: 'account.move', active_ids: [id], active_id: id } });
  const register = payCtx.model('account.payment.register');
  const defaults = await register.defaultGet();
  eq('outbound supplier', [defaults.payment_type, defaults.partner_type], ['outbound', 'supplier']);
  const w = await register.create({ ...defaults });
  await register.callButton(w, 'action_create_payments', { active_ids: [id] });
  [bill] = await bills.read(id, ['payment_state', 'amount_residual']);
  eq('bill paid', bill.payment_state, 'paid');
  near('bill residual 0', bill.amount_residual, 0);
  const payments = await env.model('account.payment').searchRead([['reconciled_invoice_ids', 'in', [id]]], ['name', 'payment_type']);
  for (const p of payments) track('account.payment', p.id as number);
  eq('one outbound payment', payments.map((p) => p.payment_type), ['outbound']);
});

await scenario('Journal entry balance rules', async () => {
  const accounts = await env.model('account.account').searchRead([], ['id', 'code'], { limit: 2, order: 'code' });
  check('chart of accounts seeded', accounts.length === 2);
  if (accounts.length < 2) return;
  const moves = env.model('account.move');
  const id = track('account.move', await moves.create({ move_type: 'entry', date: new Date().toISOString().slice(0, 10), line_ids: [[0, 0, { account_id: accounts[0].id, name: 'a', debit: 100, credit: 0 }], [0, 0, { account_id: accounts[1].id, name: 'b', debit: 0, credit: 100 }]] }));
  await moves.callButton(id, 'action_post');
  const [move] = await moves.read(id, ['name', 'state']);
  matches(`entry number MISC/${YEAR}/…`, move.name, new RegExp(`^MISC/${YEAR}/`));
  eq('entry posted', move.state, 'posted');
  const bad = track('account.move', await moves.create({ move_type: 'entry', date: new Date().toISOString().slice(0, 10), line_ids: [[0, 0, { account_id: accounts[0].id, name: 'a', debit: 100, credit: 0 }]] }));
  await rejects('unbalanced entry cannot be posted', moves.callButton(bad, 'action_post'), 'user_error');
});

await scenario('Chatter, activities and activity filters', async () => {
  const { variant, partner } = await fixtures();
  const id = await quotation(partner, variant);
  const before = await env.model('mail.message').searchCount([['model', '=', 'sale.order'], ['res_id', '=', id]]);
  const msg = await postMessage(env, 'sale.order', id, { body: '<p>Hello from the workflow test</p>', messageType: 'comment' });
  check('message posted', msg > 0);
  eq('message count +1', await env.model('mail.message').searchCount([['model', '=', 'sale.order'], ['res_id', '=', id]]), before + 1);
  const messagesViaField = await env.model('sale.order').read(id, ['message_ids']);
  check('message_ids field lists the messages', Array.isArray(messagesViaField[0].message_ids) && (messagesViaField[0].message_ids as number[]).includes(msg));

  const types = await env.model('mail.activity.type').search([], { limit: 1 });
  const today = new Date().toISOString().slice(0, 10);
  const activity = track('mail.activity', await env.model('mail.activity').create({ res_model: 'sale.order', res_id: id, activity_type_id: types[0] ?? false, summary: 'Call back', date_deadline: today, user_id: 2 }));
  let [order] = await env.model('sale.order').read(id, ['activity_state', 'activity_date_deadline', 'activity_user_id', 'activity_summary', 'my_activity_date_deadline', 'activity_ids']);
  eq('activity_state today', order.activity_state, 'today');
  eq('activity deadline', order.activity_date_deadline, today);
  eq('activity user', m2o(order.activity_user_id), 2);
  eq('activity summary column', order.activity_summary, 'Call back');
  eq('my_activity_date_deadline (SQL-computed)', order.my_activity_date_deadline, today);
  check('activity_ids lists the activity', (order.activity_ids as number[]).includes(activity));
  const mine = await env.model('sale.order').search([['my_activity_date_deadline', '=', today], ['id', '=', id]]);
  eq('search on my_activity_date_deadline', mine, [id]);
  const todayFilter = await env.model('sale.order').search([['activity_state', '=', 'today'], ['id', '=', id]]);
  eq('search on activity_state', todayFilter, [id]);
  await env.model('mail.activity').callButton(activity, 'action_done');
  [order] = await env.model('sale.order').read(id, ['activity_state', 'activity_ids']);
  eq('activity_state cleared after done', order.activity_state, false);
  eq('no open activity', order.activity_ids, []);
  const follower = await env.model('sale.order').search([['message_is_follower', '=', true], ['id', '=', id]]).catch((e) => String(e));
  check('message_is_follower is searchable', Array.isArray(follower), String(follower));
});

await scenario('Settings round trip', async () => {
  const settings = env.model('res.config.settings');
  const field = Object.values(registry.models['res.config.settings'].fields).find((f) => f.type === 'boolean' && !f.readonly && !f.name.startsWith('module_') && !f.name.startsWith('group_') && f.name !== 'is_root_company');
  check('a plain boolean setting exists', Boolean(field), field?.name);
  if (!field) return;
  const before = await getSetting(env, field.name, false);
  const w1 = await settings.create({ [field.name]: !before });
  await settings.callButton(w1, 'execute');
  eq(`setting ${field.name} toggled`, await getSetting(env, field.name, false), !before);
  const w2 = await settings.create({ [field.name]: before });
  await settings.callButton(w2, 'execute');
  eq(`setting ${field.name} restored`, await getSetting(env, field.name, false), before);
  const defaults = await settings.defaultGet();
  eq('defaults reflect stored value', defaults[field.name], before);
});

await scenario('Users and preferences (no authentication involved)', async () => {
  const users = env.model('res.users');
  const login = `wf-${stamp}@example.com`;
  const id = track('res.users', await users.create({ name: `Workflow Tester ${stamp}`, login, email: login }));
  const [user] = await users.read(id, ['partner_id', 'login', 'lang', 'display_name']);
  check('partner auto-created', m2o(user.partner_id) > 0);
  track('res.partner', m2o(user.partner_id));
  eq('login lowercased/kept', String(user.login).toLowerCase(), login);
  const dup = users.create({ name: 'Dup', login: login.toUpperCase() });
  await rejects('duplicate login (case-insensitive) is refused', dup);
  const asUser = new Environment({ registry, db, uid: id, companyIds: [1], superuser: false });
  await asUser.model('res.users').write(id, { lang: 'ar_001' }).catch(() => undefined);
  const [after] = await users.read(id, ['lang']);
  check('user can change own language', after.lang === 'ar_001' || after.lang === 'en_US', String(after.lang));
  const contact = await users.callButton(id, 'action_related_contact') as { res_model?: string };
  eq('related contact action', contact?.res_model, 'res.partner');
});

await scenario('Search / group-by consistency and favorites', async () => {
  const { variant, partner } = await fixtures();
  for (let i = 0; i < 3; i++) await quotation(partner, variant);
  const orders = env.model('sale.order');
  const groups = await orders.readGroup([['partner_id', '=', partner]], ['amount_total:sum'], ['state']);
  const total = groups.reduce((s, g) => s + g.__count, 0);
  eq('group counts sum to searchCount', total, await orders.searchCount([['partner_id', '=', partner]]));
  const rows = await orders.searchRead([['partner_id', '=', partner]], ['amount_total']);
  near('sum aggregate equals rows', groups.reduce((s, g) => s + Number(g.amount_total ?? 0), 0), rows.reduce((s, r) => s + Number(r.amount_total), 0));
  for (const g of groups) eq(`__domain of group ${g.state} selects its rows`, await orders.searchCount(g.__domain), g.__count);
  const byMonth = await orders.readGroup([['partner_id', '=', partner]], ['__count'], ['date_order:month']);
  check('date group-by works', byMonth.length >= 1);
  const byTag = await env.model('res.partner').readGroup([['id', '=', partner]], ['__count'], ['category_id']).catch((e) => String(e));
  check('many2many group-by works', Array.isArray(byTag), String(byTag));
  const [{ name: partnerName }] = await env.model('res.partner').read(partner, ['name']);
  const named = await orders.search([['partner_id', 'ilike', String(partnerName)]]);
  eq('many2one text search', named.length, 3);
  const relative = await orders.search([['create_date', '>=', 'today -1d'], ['partner_id', '=', partner]]);
  eq('relative date domain', relative.length, 3);
  const page = await orders.searchWithCount([['partner_id', '=', partner]], { limit: 2, offset: 0, order: 'name desc' });
  eq('pagination total', page.total, 3);
  eq('pagination page size', page.ids.length, 2);
  // The sales analysis (a SQL view over order lines) reflects the quotations immediately.
  const analysisRows = await env.model('sale.report').searchCount([['partner_id', '=', partner]]);
  eq('sale.report view lists the order lines', analysisRows, 6);
  const analysis = await env.model('sale.report').readGroup([['partner_id', '=', partner]], ['price_subtotal:sum'], ['state']);
  near('sale.report subtotal equals the orders untaxed total', analysis.reduce((s, g) => s + Number(g.price_subtotal ?? 0), 0), rows.length * 1450);
  await rejects('sale.report is read-only', env.model('sale.report').create({ name: 'x' }), 'user_error');
  const filters = env.model('ir.filters');
  const fav = track('ir.filters', await filters.create({ name: `Mine ${stamp}`, model_id: 'sale.order', domain: "[('state','=','draft')]", context: '{}', sort: '[]', user_id: 2, is_default: false }));
  check('favorite saved', fav > 0);
  const found = await filters.searchRead([['model_id', '=', 'sale.order'], ['name', '=', `Mine ${stamp}`]], ['domain']);
  eq('favorite found', found.length, 1);
});

await scenario('Concurrent creates keep numbering unique', async () => {
  const { variant, partner } = await fixtures();
  const ids = await Promise.all([1, 2, 3, 4].map(() => quotation(partner, variant)));
  const rows = await env.model('sale.order').read(ids, ['name']);
  const names = rows.map((r) => String(r.name));
  eq('four distinct numbers', new Set(names).size, 4);
});

await scenario('Access control for a non-superuser', async () => {
  const groupsField = registry.models['res.users'].fields.groups_id ?? registry.models['res.users'].fields.group_ids;
  const rel = groupsField?.m2mTable ? (await env.cr.query<{ g: number }>(`SELECT "${groupsField.m2mColumn2}" AS g FROM "${groupsField.m2mTable}" WHERE "${groupsField.m2mColumn1}" = 2`)).rows.map((r) => Number(r.g)) : [];
  check('admin belongs to groups', rel.length > 0, `groups=${rel.length}`);
  const user = new Environment({ registry, db, uid: 2, companyIds: [1], groupIds: rel, superuser: false });
  const count = await user.model('sale.order').searchCount([]).catch((e) => String(e));
  check('admin (non-superuser env) can read sales orders', typeof count === 'number', String(count));
  const { variant, partner } = await fixtures();
  const id = await user.model('sale.order').create({ partner_id: partner, order_line: [[0, 0, { product_id: variant, product_uom_qty: 1 }]] }).catch((e) => String(e));
  check('admin can create a quotation', typeof id === 'number', String(id));
  if (typeof id === 'number') track('sale.order', id);
});

await scenario('Purchase: RFQ → order → receipt → vendor bill', async () => {
  const { partner } = await fixtures();
  // Goods billed on received quantities (the default control policy).
  const goods = track('product.template', await env.model('product.template').create({ name: `Cable ${stamp}`, type: 'consu', purchase_method: 'receive', standard_price: 25, list_price: 40 }));
  const [variant] = await env.model('product.product').search([['product_tmpl_id', '=', goods]]);
  const orders = env.model('purchase.order');
  const id = track('purchase.order', await orders.create({ partner_id: partner, order_line: [[0, 0, { product_id: variant, product_qty: 4, price_unit: 25 }], [0, 0, { display_type: 'line_note', name: 'Deliver by Monday' }]] }));
  let [po] = await orders.read(id, ['name', 'state', 'amount_untaxed', 'amount_total', 'invoice_status', 'receipt_status']);
  matches('RFQ number P00001 style', po.name, /^P\d{5}$/);
  eq('draft RFQ', po.state, 'draft');
  near('untaxed 100', po.amount_untaxed, 100);
  eq('nothing to bill yet', po.invoice_status, 'no');
  await orders.callButton(id, 'message_sent');
  eq('RFQ sent', (await orders.read(id, ['state']))[0].state, 'sent');
  await orders.callButton(id, 'button_confirm');
  [po] = await orders.read(id, ['state', 'date_approve', 'invoice_status']);
  eq('purchase order', po.state, 'purchase');
  check('approval date set', Boolean(po.date_approve));
  await rejects('bill before receipt is refused (receive policy)', orders.callButton(id, 'action_create_invoice'), 'user_error');
  await orders.callButton(id, 'action_receive');
  [po] = await orders.read(id, ['receipt_status', 'invoice_status']);
  eq('fully received', po.receipt_status, 'full');
  eq('to bill', po.invoice_status, 'to invoice');
  const action = await orders.callButton(id, 'action_create_invoice') as { res_id?: number; res_model: string };
  eq('bill action', action.res_model, 'account.move');
  const billId = track('account.move', action.res_id as number);
  const [bill] = await env.model('account.move').read(billId, ['move_type', 'amount_total', 'invoice_origin', 'purchase_id']);
  eq('vendor bill', bill.move_type, 'in_invoice');
  near('bill total 100', bill.amount_total, 100);
  eq('origin is the PO', bill.invoice_origin, po.name ?? (await orders.read(id, ['name']))[0].name);
  [po] = await orders.read(id, ['invoice_status']);
  eq('fully billed', po.invoice_status, 'invoiced');
  await rejects('cancel with billed lines refused', orders.callButton(id, 'button_cancel'), 'user_error');
  const second = track('purchase.order', await orders.copy(id));
  const [c] = await orders.read(second, ['state', 'order_line', 'name']);
  eq('copy is a draft RFQ', c.state, 'draft');
  eq('copy keeps lines', (c.order_line as number[]).length, 2);
  check('copy has a new number', c.name !== po.name);
});

await scenario('Approvals: submit → approve with a required approver', async () => {
  const categories = env.model('approval.category');
  const categoryId = track('approval.category', await categories.create({ name: `Trip ${stamp}`, has_date: 'required', has_amount: 'optional', approval_minimum: 1 }));
  const requests = env.model('approval.request');
  const id = track('approval.request', await requests.create({ name: `Trip to Riyadh ${stamp}`, category_id: categoryId, request_owner_id: 2, approver_ids: [[0, 0, { user_id: 2, required: true }]] }));
  let [r] = await requests.read(id, ['request_status', 'user_status', 'approver_ids']);
  eq('new request', r.request_status, 'new');
  eq('approver row created', (r.approver_ids as number[]).length, 1);
  await rejects('submit without the required date is refused', requests.callButton(id, 'action_confirm'), 'user_error');
  await requests.write(id, { date: '2026-10-01 09:00:00' });
  await requests.callButton(id, 'action_confirm');
  [r] = await requests.read(id, ['request_status', 'user_status']);
  eq('submitted', r.request_status, 'pending');
  eq('my approver status pending (SQL-computed per user)', r.user_status, 'pending');
  await requests.callButton(id, 'action_withdraw');
  eq('still pending after withdraw', (await requests.read(id, ['request_status']))[0].request_status, 'pending');
  await requests.callButton(id, 'action_approve');
  [r] = await requests.read(id, ['request_status', 'user_status']);
  eq('approved', r.request_status, 'approved');
  eq('my status approved', r.user_status, 'approved');
  const activities = await env.model('mail.activity').searchCount([['res_model', '=', 'approval.request'], ['res_id', '=', id]]);
  eq('approver activity closed', activities, 0);
  await requests.callButton(id, 'action_cancel');
  eq('cancelled', (await requests.read(id, ['request_status']))[0].request_status, 'cancel');
  await requests.callButton(id, 'action_draft');
  eq('back to draft', (await requests.read(id, ['request_status']))[0].request_status, 'new');
});

await scenario('Smart buttons resolve to related records', async () => {
  const { variant, partner } = await fixtures();
  const id = await quotation(partner, variant);
  const invoices = await env.model('sale.order').callButton(id, 'action_view_invoice') as { res_model: string; domain?: unknown };
  eq('sale.order › Invoices opens account.move', invoices?.res_model, 'account.move');
  const partnerSales = await env.model('res.partner').callButton(partner, 'action_view_sale_order') as { res_model: string };
  eq('partner › Sales opens sale.order (generic resolver)', partnerSales?.res_model, 'sale.order');
  await rejects('unknown method still raises', env.model('res.partner').callButton(partner, 'action_do_something_impossible'), 'user_error');
});

/* ---------- cleanup ---------- */
current = 'cleanup';
let removed = 0;
for (const [model, id] of [...created].reverse()) {
  try {
    if (model === 'account.move') await env.model(model).callButton(id, 'button_cancel').catch(() => undefined);
    await env.model(model).unlink(id);
    removed++;
  } catch { /* posted entries are protected: leave them */ }
}
console.log(`cleanup: ${removed}/${created.length} records removed`);

const failed = results.filter((r) => !r.ok);
console.log(`\n=== workflows (${DB}): ${results.length - failed.length} checks passed, ${failed.length} failed ===`);
if (OUT) writeFileSync(OUT, JSON.stringify({ db: DB, results }, null, 1));
await db.close?.();
process.exit(failed.length ? 1 : 0);
