/**
 * Runs every scheduled action on a fresh seeded PGlite database with
 * fixtures that make each job do something, and prints the results.
 *
 *   npx tsx scripts/dev/cron-check.mts
 */
import { readFileSync } from 'node:fs';
import { loadRegistry } from '../../packages/engine/registry/spec-loader.js';
import { pgliteDatabase } from '../../packages/engine/db/pglite.js';
import { syncSchema } from '../../packages/engine/schema/ddl.js';
import { loadSeed } from '../../packages/engine/seed/load.js';
import { Environment } from '../../packages/engine/orm/env.js';
import { registerApps } from '../../packages/apps/index.js';
import { runCron } from '../../lib/server/cron.js';
import { setMailTransport } from '../../lib/server/mail.js';

const registry = loadRegistry(JSON.parse(readFileSync('registry/odoo_spec.json', 'utf8')), JSON.parse(readFileSync('registry/extra-models.json', 'utf8')));
const db = pgliteDatabase();
await syncSchema(db, registry);
await loadSeed(db, registry);
registerApps(registry);
const env = new Environment({ registry, db, uid: 2, companyIds: [1], superuser: true });
const sent: string[] = [];
process.env.RODEO_MAIL_FROM = 'noreply@example.com';
setMailTransport({ async send(mail) { sent.push(`${mail.to.map((t) => t.email).join(',')} :: ${mail.subject}`); return 'test'; } });

const stamp = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');
// Digest due today, subscribed by the admin.
await env.model('digest.digest').create({ name: 'Weekly KPIs', periodicity: 'weekly', state: 'activated', next_run_date: stamp(new Date()).slice(0, 10), user_ids: [[6, 0, [2]]] });
// Event in 2 hours with the "Email - 3 Hours" alarm and a partner with an email.
const partner = await env.model('res.partner').create({ name: 'Cron Attendee', email: 'attendee@example.com' });
const [alarm] = await env.model('calendar.alarm').search([['alarm_type', '=', 'email']], { limit: 1 });
await env.model('calendar.event').create({ name: 'Cron Meeting', start: stamp(new Date(Date.now() + 2 * 3_600_000)), stop: stamp(new Date(Date.now() + 3 * 3_600_000)), partner_ids: [[6, 0, [partner]]], alarm_ids: [[6, 0, [alarm]]] });
// Attendance left open for 30 hours.
const employee = await env.model('hr.employee').create({ name: 'Cron Employee' });
await env.model('hr.attendance').create({ employee_id: employee, check_in: stamp(new Date(Date.now() - 30 * 3_600_000)) });
// Overdue posted invoice.
const tmpl = await env.model('product.template').create({ name: 'Cron Service', list_price: 100, type: 'service' });
const [variant] = await env.model('product.product').search([['product_tmpl_id', '=', tmpl]]);
const invoice = await env.model('account.move').create({ move_type: 'out_invoice', partner_id: partner, invoice_date: stamp(new Date(Date.now() - 40 * 86_400_000)).slice(0, 10), invoice_date_due: stamp(new Date(Date.now() - 10 * 86_400_000)).slice(0, 10), invoice_line_ids: [[0, 0, { product_id: variant, quantity: 1, price_unit: 100 }]] });
await env.model('account.move').callButton(invoice, 'action_post');

const results = await runCron(env, { force: true });
for (const r of results) console.log(r.job, '→', r.detail, `${r.ms} ms`);
console.log('mails:', sent);
const cron = await env.model('ir.cron').searchRead([], ['cron_name', 'lastcall', 'nextcall', 'interval_number', 'interval_type']);
console.log('ir.cron rows:', cron.map((c) => `${c.cron_name} last=${c.lastcall} next=${c.nextcall} every ${c.interval_number} ${c.interval_type}`).join('\n  '));
const [att] = await env.model('hr.attendance').searchRead([['employee_id', '=', employee]], ['check_out', 'worked_hours', 'out_mode']);
console.log('attendance closed:', att);
const notes = await env.model('mail.message').searchCount([['model', '=', 'account.move'], ['res_id', '=', invoice], ['body', 'ilike', 'overdue']]);
console.log('overdue note posted:', notes);
const again = await runCron(env, {});
console.log('second run (nothing due):', again.map((r) => `${r.job}:${r.ran}`).join(', '));
await db.close?.();
