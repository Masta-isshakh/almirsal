/**
 * Put one record in front of every screen. The checks that press a record's
 * buttons or read its form need a record to open; on an empty database they
 * skip the screen and report nothing, which reads like a pass.
 *
 *   PGLITE_DIR=.pglite-verify npx tsx scripts/dev/populate.mts
 *
 * A required relation is filled with an existing record or a new one, the way
 * `scripts/verify-backend.mts --crud` does. The records stay: this is the
 * database the UI checks then run against. Stop any server using the directory
 * first — PGlite allows one writer.
 */
import { readFileSync } from 'node:fs';
import { loadRegistry } from '../../packages/engine/registry/spec-loader.js';
import { pgliteDatabase } from '../../packages/engine/db/pglite.js';
import { syncSchema } from '../../packages/engine/schema/ddl.js';
import { loadSeed } from '../../packages/engine/seed/load.js';
import { Environment } from '../../packages/engine/orm/env.js';
import { registerApps } from '../../packages/apps/index.js';
import type { FieldDef } from '../../packages/engine/registry/types.js';

const DIR = process.env.PGLITE_DIR ?? '.pglite-verify';
const registry = loadRegistry(JSON.parse(readFileSync('registry/odoo_spec.json', 'utf8')), JSON.parse(readFileSync('registry/extra-models.json', 'utf8')));
const db = pgliteDatabase(DIR);
await syncSchema(db, registry);
await loadSeed(db, registry);
registerApps(registry);
const env = new Environment({ registry, db, uid: 2, companyIds: [1], superuser: true });

// Models whose records belong to the system rather than to a screen.
const SKIP = new Set(['res.users', 'res.company', 'ir.module.module', 'ir.cron', 'ir.attachment', 'mail.message', 'mail.followers', 'res.lang']);

function fillValue(field: FieldDef, ids: Map<string, number | null>): unknown {
  switch (field.type) {
    case 'char': case 'text': case 'html':
      return field.name === 'email' || field.name.endsWith('_email') ? 'sample@example.com' : field.name === 'login' ? `sample_${Date.now()}@example.com` : 'Sample';
    case 'integer': case 'float': case 'monetary': return 1;
    case 'boolean': return false;
    case 'date': return new Date().toISOString().slice(0, 10);
    case 'datetime': return new Date().toISOString().slice(0, 19).replace('T', ' ');
    case 'selection': return field.selection?.[0]?.value ?? null;
    case 'many2one': return ids.get(field.relation ?? '') ?? null;
    case 'many2many': { const id = ids.get(field.relation ?? ''); return id ? [[6, 0, [id]]] : null; }
    case 'binary': case 'image': return 'QUJD';
    default: return null;
  }
}

/** An existing record of `model`, else one created with its required fields filled. */
async function ensureRecord(model: string, ids: Map<string, number | null>, depth = 0): Promise<number | null> {
  const known = ids.get(model);
  if (known !== undefined) return known;
  const def = registry.models[model];
  if (!def || def.sqlView || depth > 2 || SKIP.has(model)) return null;
  const found = await env.model(model).search([], { limit: 1 }).catch(() => [] as number[]);
  if (found[0]) { ids.set(model, found[0]); return found[0]; }
  try {
    const target = env.model(model);
    const defaults = await target.defaultGet();
    const values: Record<string, unknown> = {};
    for (const field of Object.values(def.fields)) {
      if (field.sqlExpr || field.required !== true) continue;
      if (defaults[field.name] !== undefined && defaults[field.name] !== null && defaults[field.name] !== false) continue;
      const value = field.type === 'many2one' && field.relation ? await ensureRecord(field.relation, ids, depth + 1) : fillValue(field, ids);
      if (value !== null && value !== undefined) values[field.name] = value;
    }
    const recName = def.recName ?? 'name';
    if (def.fields[recName] && ['char', 'text'].includes(def.fields[recName].type) && values[recName] === undefined) {
      values[recName] = `Sample ${def.description?.en ?? model}`.slice(0, 60);
    }
    const id = await target.create(values);
    ids.set(model, id);
    return id;
  } catch {
    ids.set(model, null);
    return null;
  }
}

const models = [...new Set(Object.values(registry.views).filter((view) => view.type === 'form').map((view) => view.model))].sort();
const ids = new Map<string, number | null>();
let already = 0;
let created = 0;
const refused: string[] = [];

for (const model of models) {
  const def = registry.models[model];
  if (!def || def.sqlView || def.transient) continue;
  const existing = await env.model(model).searchCount([]).catch(() => 0);
  if (existing > 0) { already += 1; continue; }
  const id = await ensureRecord(model, ids);
  if (id) created += 1; else refused.push(model);
}

console.log(`${models.length} models behind a form: ${already} already had a record, ${created} created, ${refused.length} still without one`);
if (refused.length) console.log(`  without a record: ${refused.join(', ')}`);

/*
 * A record of every model is still not what the screens show: an action that
 * asks for a customer invoice, a confirmed order or a vehicle with a contract
 * finds none of them in a bare record. This builds what the four apps used most
 * actually display, through the same flows a person would use, so the checks
 * that open a record and press its buttons have something to work on.
 */
async function sample(): Promise<void> {
  const customer = await ensureNamed('res.partner', 'Sample Customer', { email: 'customer@example.com' });
  const vendor = await ensureNamed('res.partner', 'Sample Vendor', { email: 'vendor@example.com', supplier_rank: 1 });
  const service = await ensureNamed('product.template', 'Sample Service', { list_price: 400, type: 'service' });
  const goods = await ensureNamed('product.template', 'Sample Equipment', { list_price: 1200, type: 'consu' });
  const [serviceVariant] = await env.model('product.product').search([['product_tmpl_id', '=', service]], { limit: 1 });
  const [goodsVariant] = await env.model('product.product').search([['product_tmpl_id', '=', goods]], { limit: 1 });
  const orders = env.model('sale.order');
  const moves = env.model('account.move');

  // Sales: a quotation, a confirmed order and an invoice out of it.
  if (!(await orders.searchCount([['state', '=', 'draft'], ['partner_id', '=', customer]]))) {
    await orders.create({ partner_id: customer, order_line: [[0, 0, { product_id: serviceVariant, product_uom_qty: 2 }]] });
  }
  let confirmed = (await orders.search([['state', '=', 'sale'], ['partner_id', '=', customer]], { limit: 1 }))[0];
  if (!confirmed) {
    confirmed = await orders.create({ partner_id: customer, order_line: [[0, 0, { product_id: serviceVariant, product_uom_qty: 3 }], [0, 0, { product_id: goodsVariant, product_uom_qty: 1 }]] });
    await orders.callButton(confirmed, 'action_confirm').catch(() => undefined);
  }
  if (!(await moves.searchCount([['move_type', '=', 'out_invoice']]))) {
    const wizardEnv = env.with({ context: { active_ids: [confirmed], active_id: confirmed, active_model: 'sale.order' } });
    const wizard = await wizardEnv.model('sale.advance.payment.inv').create({ advance_payment_method: 'delivered' }).catch(() => null);
    if (wizard) {
      const action = await wizardEnv.model('sale.advance.payment.inv').callButton(wizard, 'create_invoices').catch(() => null) as { res_id?: number } | null;
      // One invoice posted (so payments, reports and the payment widget have
      // something), one left in draft.
      if (action?.res_id) await moves.callButton(action.res_id, 'action_post').catch(() => undefined);
    }
  }
  if (!(await moves.searchCount([['move_type', '=', 'in_invoice']]))) {
    await moves.create({ move_type: 'in_invoice', partner_id: vendor, invoice_date: new Date().toISOString().slice(0, 10), invoice_line_ids: [[0, 0, { name: 'Sample supply', quantity: 1, price_unit: 300 }]] }).catch(() => undefined);
  }

  // Renting: an order out on rental, so Pickup, Return and the schedule show.
  if (!(await orders.searchCount([['is_rental_order', '=', true]]))) {
    const start = new Date();
    const back = new Date(Date.now() + 3 * 86_400_000);
    const rental = await orders.create({
      partner_id: customer,
      rental_start_date: `${start.toISOString().slice(0, 10)} 08:00:00`,
      rental_return_date: `${back.toISOString().slice(0, 10)} 08:00:00`,
      order_line: [[0, 0, { product_id: goodsVariant, product_uom_qty: 1 }]],
    }).catch(() => null);
    if (rental) {
      await orders.callButton(rental, 'action_confirm').catch(() => undefined);
      await orders.callButton(rental, 'action_open_pickup').catch(() => undefined);
    }
  }

  // Fleet: a vehicle with a driver, a contract, a service and an odometer log.
  const brand = await ensureNamed('fleet.vehicle.model.brand', 'Sample Brand', {});
  const model = await ensureNamed('fleet.vehicle.model', 'Sample Model', { brand_id: brand, vehicle_type: 'car' });
  const vehicles = env.model('fleet.vehicle');
  let vehicle = (await vehicles.search([['model_id', '=', model]], { limit: 1 }))[0];
  if (!vehicle) vehicle = await vehicles.create({ model_id: model, license_plate: 'SAMPLE-1', driver_id: customer });
  if (vehicle) {
    if (!(await env.model('fleet.vehicle.log.contract').searchCount([['vehicle_id', '=', vehicle]]))) {
      await env.model('fleet.vehicle.log.contract').create({ vehicle_id: vehicle, amount: 450, expiration_date: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10) }).catch(() => undefined);
    }
    if (!(await env.model('fleet.vehicle.log.services').searchCount([['vehicle_id', '=', vehicle]]))) {
      const [type] = await env.model('fleet.service.type').search([], { limit: 1 });
      if (type) await env.model('fleet.vehicle.log.services').create({ vehicle_id: vehicle, service_type_id: type, amount: 120, date_from: new Date().toISOString().slice(0, 10) }).catch(() => undefined);
    }
    if (!(await env.model('fleet.vehicle.odometer').searchCount([['vehicle_id', '=', vehicle]]))) {
      await env.model('fleet.vehicle.odometer').create({ vehicle_id: vehicle, value: 24_500 }).catch(() => undefined);
    }
  }
}

/** A record of `model` with that name, created with the given values if absent. */
async function ensureNamed(model: string, name: string, values: Record<string, unknown>): Promise<number> {
  const field = registry.models[model]?.fields.name ? 'name' : 'display_name';
  const found = await env.model(model).search([[field, '=', name]], { limit: 1 }).catch(() => [] as number[]);
  if (found[0]) return found[0];
  return env.model(model).create({ [field]: name, ...values });
}

await sample();
const summary = await Promise.all(['sale.order', 'account.move', 'fleet.vehicle', 'fleet.vehicle.log.contract', 'res.partner'].map(async (model) => `${model}: ${await env.model(model).searchCount([])}`));
console.log(`sample data — ${summary.join(', ')}`);
await db.close?.();
