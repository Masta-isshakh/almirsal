import { readFileSync } from 'node:fs';
import { loadRegistry } from '../../packages/engine/registry/spec-loader.js';
import { syncSchema } from '../../packages/engine/schema/ddl.js';
import { loadSeed } from '../../packages/engine/seed/load.js';
import { Environment } from '../../packages/engine/orm/env.js';
import { registerApps } from '../../packages/apps/index.js';
import { pgliteDatabase } from '../../packages/engine/db/pglite.js';
import { computeDashboard } from '../../packages/apps/dashboards.js';
const root = '';
const spec = JSON.parse(readFileSync(root + 'registry/odoo_spec.json', 'utf8'));
const extra = JSON.parse(readFileSync(root + 'registry/extra-models.json', 'utf8'));
const registry = loadRegistry(spec, extra);
const db = pgliteDatabase();
await syncSchema(db, registry);
await loadSeed(db, registry);
registerApps(registry);
const env = new Environment({ registry, db, uid: 2, companyIds: [1], superuser: true });
// Fixtures: a confirmed order → posted invoice → payment, plus a ticket, so the dashboards have data to show.
const tax = await env.model('account.tax').create({ name: 'VAT 5% dash', amount: 5, amount_type: 'percent', type_tax_use: 'sale' });
const tmpl = await env.model('product.template').create({ name: 'Consulting dash', list_price: 500, type: 'service', taxes_id: [[6, 0, [tax]]] });
const [variant] = await env.model('product.product').search([['product_tmpl_id', '=', tmpl]]);
const partner = await env.model('res.partner').create({ name: 'Deco Addict dash', email: 'deco-dash@example.com' });
const order = await env.model('sale.order').create({ partner_id: partner, order_line: [[0, 0, { product_id: variant, product_uom_qty: 2 }], [0, 0, { product_id: variant, product_uom_qty: 1, discount: 10 }]] });
await env.model('sale.order').create({ partner_id: partner, order_line: [[0, 0, { product_id: variant, product_uom_qty: 4 }]] });
await env.model('sale.order').callButton(order, 'action_confirm');
const wizardEnv = env.with({ context: { active_ids: [order], active_id: order, active_model: 'sale.order' } });
const wizard = await wizardEnv.model('sale.advance.payment.inv').create({ advance_payment_method: 'delivered' });
const action = await wizardEnv.model('sale.advance.payment.inv').callButton(wizard, 'create_invoices') as { res_id: number };
await env.model('account.move').callButton(action.res_id, 'action_post');
const payCtx = env.with({ context: { active_model: 'account.move', active_ids: [action.res_id], active_id: action.res_id } });
const register = payCtx.model('account.payment.register');
const partial = await register.create({ ...(await register.defaultGet()), amount: 522.5 });
await register.callButton(partial, 'action_create_payments', { active_ids: [action.res_id] });
const team = (await env.model('helpdesk.team').search([], { limit: 1 }))[0];
await env.model('helpdesk.ticket').create({ name: 'Printer on fire', partner_id: partner, team_id: team });
await env.model('helpdesk.ticket').create({ name: 'Login issue', partner_id: partner, team_id: team });
const years = await db.query<{ y: string; n: number }>(`SELECT to_char(date_order, 'YYYY') AS y, count(*)::int AS n FROM sale_order GROUP BY 1 ORDER BY 1`);
console.log('sale_order years', years.rows);
const inv = await db.query<{ y: string; n: number }>(`SELECT to_char(invoice_date, 'YYYY') AS y, count(*)::int AS n FROM account_move WHERE move_type LIKE 'out_%' GROUP BY 1 ORDER BY 1`);
console.log('invoice years', inv.rows);
for (const name of ['Sales', 'Product', 'Rental', 'Accounting', 'Invoicing', 'Benchmark', 'Helpdesk']) {
  for (const y of ['2025', '2026']) {
    const r = await computeDashboard(env, name, `${y}-01-01`, `${y}-12-31`);
    const summary = r.blocks.map((b) => b.type === 'scorecards' ? b.items.map((i) => `${i.label.en}=${i.text ?? Math.round(i.value * 100) / 100}`).join(',') : b.type === 'chart' ? `chart ${b.chart.title.en}[${b.chart.labels.length}]` : b.type === 'table' ? `table ${b.table.title.en}[${b.table.rows.length}]` : b.type === 'kpis' ? `kpis ${b.title.en}[${b.rows.length}]` : `gauges[${b.items.length}] ${b.items.slice(0, 3).map((g) => `${g.label.en}=${Math.round(g.value * 100) / 100}`).join(',')}`);
    console.log(name, y, '::', summary.join(' ; '));
  }
}
await db.close?.();
