import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pgliteDatabase } from '../db/pglite.js';
import type { Database } from '../db/types.js';
import { syncSchema } from '../schema/ddl.js';
import { testRegistry } from '../testing/registry.js';
import { Environment } from './env.js';
import { AccessError, OrmError, ValidationError } from './errors.js';
import { clearModelHooks, registerModelHooks } from './hooks.js';
import { nextByCode } from './sequence.js';

/**
 * Exercises the ORM against the real registry in an in-process Postgres.
 * The Sales models are used throughout because Phase 2's gate is the Sales
 * app end-to-end (J-1).
 */

const registry = testRegistry();
let db: Database;
let env: Environment;
let partnerId: number;
let companyId: number;
let currencyId: number;

function makeEnv(overrides: Partial<ConstructorParameters<typeof Environment>[0]> = {}): Environment {
  return new Environment({ registry, db, uid: 2, companyIds: [companyId ?? 1], ...overrides });
}

/** Sales hooks close enough to Part D for the ORM mechanics to be tested. */
function registerSalesHooks(): void {
  registerModelHooks('sale.order', {
    defaults: async (e) => ({
      name: await nextByCode(e, 'sale.order'),
      date_order: '2026-09-19 10:00:00',
      document_tax_mode: 'tax_excluded',
      state: 'draft',
    }),
    tracked: ['state', 'partner_id'],
    creationMessage: { en: 'Quotation created', ar: 'تم إنشاء عرض السعر' },
    computes: [{
      fields: ['amount_untaxed', 'amount_total'],
      depends: ['order_line.price_subtotal', 'order_line'],
      compute: async (e, ids) => {
        const rows = await e.cr.query<{ order_id: number; total: number }>(
          `SELECT order_id, coalesce(sum(price_subtotal), 0)::float8 AS total FROM sale_order_line WHERE order_id = ANY($1) GROUP BY order_id`, [ids],
        );
        const out: Record<number, Record<string, unknown>> = {};
        for (const id of ids) out[id] = { amount_untaxed: 0, amount_total: 0 };
        for (const row of rows.rows) out[Number(row.order_id)] = { amount_untaxed: row.total, amount_total: row.total };
        return out;
      },
    }],
    onchange: {
      partner_id: async (e, values) => {
        if (!values.partner_id) return {};
        return { value: { partner_invoice_id: values.partner_id }, warning: undefined };
      },
    },
    methods: {
      action_confirm: async (e, ids) => {
        await e.model('sale.order').write(ids, { state: 'sale' });
      },
    },
  });
  registerModelHooks('sale.order.line', {
    defaults: () => ({ customer_lead: 0, product_uom_qty: 1, price_unit: 0 }),
    computes: [{
      fields: ['price_subtotal'],
      depends: ['product_uom_qty', 'price_unit', 'discount'],
      compute: async (e, ids) => {
        const rows = await e.cr.query<{ id: number; qty: number; price: number; discount: number | null }>(
          `SELECT id, product_uom_qty::float8 AS qty, price_unit::float8 AS price, discount::float8 AS discount FROM sale_order_line WHERE id = ANY($1)`, [ids],
        );
        const out: Record<number, Record<string, unknown>> = {};
        for (const row of rows.rows) {
          out[Number(row.id)] = { price_subtotal: row.qty * row.price * (1 - (row.discount ?? 0) / 100) };
        }
        return out;
      },
    }],
  });
}

beforeAll(async () => {
  db = pgliteDatabase();
  await syncSchema(db, registry);
  const boot = new Environment({ registry, db, uid: 1, superuser: true });

  currencyId = await boot.model('res.currency').create({ name: 'QAR', symbol: 'QR', position: 'after', decimal_places: 2, active: true });
  const companyPartner = await boot.model('res.partner').create({ name: 'masta', autopost_bills: 'ask', is_company: true });
  companyId = await boot.model('res.company').create({ name: 'masta', partner_id: companyPartner, currency_id: currencyId });
  const userPartner = await boot.model('res.partner').create({ name: 'Admin', autopost_bills: 'ask' });
  await boot.cr.query(
    `INSERT INTO res_users (id, login, partner_id, company_id, notification_type, outgoing_mail_server_type, active) VALUES (2, 'admin', $1, $2, 'email', 'default', true)`,
    [userPartner, companyId],
  );
  await boot.cr.query(
    `INSERT INTO ir_sequence (name, code, prefix, padding, number_next_actual, number_increment, use_date_range, implementation, active)
     VALUES ('Sales Order', 'sale.order', 'S', 5, 1, 1, false, 'standard', true),
            ('Invoice', 'account.move.invoice', 'INV/%(range_year)s/', 5, 1, 1, true, 'standard', true)`,
  );
  partnerId = await boot.model('res.partner').create({ name: 'Azure Interior', autopost_bills: 'ask', email: 'azure@example.com' });
}, 120_000);

afterAll(async () => {
  await db.close?.();
});

beforeEach(() => {
  clearModelHooks();
  registerSalesHooks();
  env = makeEnv();
});

describe('sequences', () => {
  it('draws consecutive padded numbers with the prefix', async () => {
    const first = await nextByCode(env, 'sale.order');
    const second = await nextByCode(env, 'sale.order');
    expect(first).toMatch(/^S\d{5}$/);
    expect(Number(second.slice(1))).toBe(Number(first.slice(1)) + 1);
  });

  it('interpolates the date range year and creates the range on demand', async () => {
    const number = await nextByCode(env, 'account.move.invoice', { date: new Date('2026-09-19T00:00:00Z') });
    expect(number).toBe('INV/2026/00001');
    const next = await nextByCode(env, 'account.move.invoice', { date: new Date('2026-12-01T00:00:00Z') });
    expect(next).toBe('INV/2026/00002');
    const nextYear = await nextByCode(env, 'account.move.invoice', { date: new Date('2027-01-05T00:00:00Z') });
    expect(nextYear).toBe('INV/2027/00001');
  });

  it('releases the number when the transaction rolls back', async () => {
    const before = await nextByCode(env, 'sale.order');
    await expect(env.withTransaction(async (tx) => {
      await nextByCode(tx, 'sale.order');
      throw new Error('boom');
    })).rejects.toThrow('boom');
    const after = await nextByCode(env, 'sale.order');
    expect(Number(after.slice(1))).toBe(Number(before.slice(1)) + 1);
  });
});

describe('create / read', () => {
  it('applies defaults, validates required fields and reads many2one as [id, name]', async () => {
    const id = await env.model('sale.order').create({ partner_id: partnerId, partner_invoice_id: partnerId });
    const [order] = await env.model('sale.order').read(id, ['name', 'partner_id', 'state', 'company_id', 'currency_id', 'date_order', 'order_line', 'display_name']);
    expect(order.name).toMatch(/^S\d{5}$/);
    expect(order.partner_id).toEqual([partnerId, 'Azure Interior']);
    expect(order.state).toBe('draft');
    expect(order.company_id).toEqual([companyId, 'masta']);
    expect(order.currency_id).toEqual([currencyId, 'QAR']);
    expect(order.date_order).toBe('2026-09-19 10:00:00');
    expect(order.order_line).toEqual([]);
    expect(order.display_name).toBe(order.name);
  });

  it('raises a Validation Error listing the missing required labels', async () => {
    await expect(env.model('sale.order').create({})).rejects.toMatchObject({
      kind: 'validation_error',
    });
    try {
      await env.model('sale.order').create({});
    } catch (error) {
      const orm = error as ValidationError;
      expect(orm.title.en).toBe('Validation Error');
      expect(orm.i18n.en).toContain('- Customer');
      expect(orm.i18n.ar).toContain('- العميل');
    }
  });

  it('rejects unknown fields', async () => {
    await expect(env.model('sale.order').create({ partner_id: partnerId, partner_invoice_id: partnerId, nope: 1 }))
      .rejects.toBeInstanceOf(OrmError);
  });

  it('creates one2many lines from commands and computes totals up the chain', async () => {
    const id = await env.model('sale.order').create({
      partner_id: partnerId,
      partner_invoice_id: partnerId,
      order_line: [
        [0, 0, { name: 'Consulting', product_uom_qty: 2, price_unit: 100 }],
        [0, 0, { name: 'Support', product_uom_qty: 1, price_unit: 50, discount: 10 }],
      ],
    });
    const [order] = await env.model('sale.order').read(id, ['order_line', 'amount_total', 'amount_untaxed']);
    expect((order.order_line as number[]).length).toBe(2);
    expect(order.amount_total).toBeCloseTo(245);

    const lines = await env.model('sale.order.line').read(order.order_line as number[], ['name', 'price_subtotal', 'order_id']);
    expect(lines.map((line) => line.price_subtotal)).toEqual([200, 45]);
    expect(lines[0].order_id).toEqual([id, order.name ?? expect.any(String)]);
  });

  it('posts the creation message in the chatter', async () => {
    const id = await env.model('sale.order').create({ partner_id: partnerId, partner_invoice_id: partnerId });
    const messages = await env.cr.query<{ body: string; author_id: number }>(
      `SELECT body, author_id FROM mail_message WHERE model = 'sale.order' AND res_id = $1`, [id],
    );
    expect(messages.rows.map((row) => row.body)).toContain('<p>Quotation created</p>');
    expect(messages.rows[0].author_id).toBeTruthy();
  });
});

describe('write', () => {
  it('updates lines through commands and recomputes the parent total', async () => {
    const orderModel = env.model('sale.order');
    const id = await orderModel.create({
      partner_id: partnerId, partner_invoice_id: partnerId,
      order_line: [[0, 0, { name: 'A', product_uom_qty: 1, price_unit: 10 }], [0, 0, { name: 'B', product_uom_qty: 1, price_unit: 20 }]],
    });
    const [before] = await orderModel.read(id, ['order_line', 'amount_total']);
    const [lineA, lineB] = before.order_line as number[];
    expect(before.amount_total).toBe(30);

    await orderModel.write(id, { order_line: [[1, lineA, { product_uom_qty: 3 }], [2, lineB]] });
    const [after] = await orderModel.read(id, ['order_line', 'amount_total']);
    expect(after.order_line).toEqual([lineA]);
    expect(after.amount_total).toBe(30);

    // Editing a line directly also propagates to the order.
    await env.model('sale.order.line').write(lineA, { price_unit: 5 });
    const [propagated] = await orderModel.read(id, ['amount_total']);
    expect(propagated.amount_total).toBe(15);

    await orderModel.write(id, { order_line: [[5]] });
    const [cleared] = await orderModel.read(id, ['order_line', 'amount_total']);
    expect(cleared.order_line).toEqual([]);
    expect(cleared.amount_total).toBe(0);
  });

  it('links and unlinks many2many tags', async () => {
    const tagModel = env.model('crm.tag');
    const red = await tagModel.create({ name: 'Red', color: 1 });
    const blue = await tagModel.create({ name: 'Blue', color: 4 });
    const orderModel = env.model('sale.order');
    const id = await orderModel.create({ partner_id: partnerId, partner_invoice_id: partnerId, tag_ids: [[6, 0, [red, blue]]] });
    expect((await orderModel.read(id, ['tag_ids']))[0].tag_ids).toEqual([red, blue]);

    await orderModel.write(id, { tag_ids: [[3, red]] });
    expect((await orderModel.read(id, ['tag_ids']))[0].tag_ids).toEqual([blue]);

    await orderModel.write(id, { tag_ids: [[4, red]] });
    expect((await orderModel.read(id, ['tag_ids']))[0].tag_ids).toEqual([red, blue]);

    await orderModel.write(id, { tag_ids: [[5]] });
    expect((await orderModel.read(id, ['tag_ids']))[0].tag_ids).toEqual([]);
  });

  it('records tracking values for tracked fields', async () => {
    const orderModel = env.model('sale.order');
    const id = await orderModel.create({ partner_id: partnerId, partner_invoice_id: partnerId });
    await orderModel.write(id, { state: 'sent' });
    const tracking = await env.cr.query<{ field_name: string; old_value_char: string; new_value_char: string }>(
      `SELECT v.field_name, v.old_value_char, v.new_value_char FROM mail_tracking_value v
       JOIN mail_message m ON m.id = v.mail_message_id WHERE m.model = 'sale.order' AND m.res_id = $1`, [id],
    );
    expect(tracking.rows).toEqual([{ field_name: 'state', old_value_char: 'Quotation', new_value_char: 'Quotation Sent' }]);
  });

  it('does not post tracking when nothing tracked changed', async () => {
    const orderModel = env.model('sale.order');
    const id = await orderModel.create({ partner_id: partnerId, partner_invoice_id: partnerId });
    const before = await env.cr.query<{ n: string }>(`SELECT count(*)::text AS n FROM mail_message WHERE model = 'sale.order' AND res_id = $1`, [id]);
    await orderModel.write(id, { client_order_ref: 'PO-1' });
    const after = await env.cr.query<{ n: string }>(`SELECT count(*)::text AS n FROM mail_message WHERE model = 'sale.order' AND res_id = $1`, [id]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe('search', () => {
  it('filters, orders and paginates', async () => {
    const orderModel = env.model('sale.order');
    const ids = [];
    for (const ref of ['pag-1', 'pag-2', 'pag-3']) {
      ids.push(await orderModel.create({ partner_id: partnerId, partner_invoice_id: partnerId, client_order_ref: ref }));
    }
    const found = await orderModel.search([['client_order_ref', 'like', 'pag-']], { order: 'client_order_ref desc' });
    expect(found).toEqual([...ids].reverse());
    const page = await orderModel.search([['client_order_ref', 'like', 'pag-']], { order: 'client_order_ref asc', limit: 2, offset: 1 });
    expect(page).toEqual([ids[1], ids[2]]);
    expect(await orderModel.searchCount([['client_order_ref', 'like', 'pag-']])).toBe(3);
  });

  it('orders by a many2one through the comodel name', async () => {
    const orderModel = env.model('sale.order');
    const zed = await env.model('res.partner').create({ name: 'Zed Corp', autopost_bills: 'ask' });
    const a = await orderModel.create({ partner_id: zed, partner_invoice_id: zed, client_order_ref: 'm2o-order' });
    const b = await orderModel.create({ partner_id: partnerId, partner_invoice_id: partnerId, client_order_ref: 'm2o-order' });
    const found = await orderModel.search([['client_order_ref', '=', 'm2o-order']], { order: 'partner_id asc' });
    expect(found).toEqual([b, a]);
  });

  it('hides archived records unless active_test is off', async () => {
    const partners = env.model('res.partner');
    const id = await partners.create({ name: 'Archived Co', autopost_bills: 'ask', active: false });
    expect(await partners.search([['name', '=', 'Archived Co']])).toEqual([]);
    expect(await partners.search([['name', '=', 'Archived Co']], { activeTest: false })).toEqual([id]);
    expect(await makeEnv({ context: { active_test: false } }).model('res.partner').search([['name', '=', 'Archived Co']])).toEqual([id]);
  });

  it('toggles active', async () => {
    const partners = env.model('res.partner');
    const id = await partners.create({ name: 'Toggle Co', autopost_bills: 'ask' });
    await partners.toggleActive(id);
    expect((await partners.read(id, ['active']))[0].active).toBe(false);
    await partners.toggleActive(id);
    expect((await partners.read(id, ['active']))[0].active).toBe(true);
  });

  it('resolves dotted paths in domains', async () => {
    const orderModel = env.model('sale.order');
    const id = await orderModel.create({ partner_id: partnerId, partner_invoice_id: partnerId, client_order_ref: 'dotted' });
    const found = await orderModel.search([['partner_id.email', 'ilike', 'azure'], ['client_order_ref', '=', 'dotted']]);
    expect(found).toEqual([id]);
  });

  it('name_search matches the record name and extra search fields', async () => {
    registerModelHooks('res.partner', { searchFields: ['email'] });
    const partners = env.model('res.partner');
    const results = await partners.nameSearch('azure@');
    expect(results.some(([id, name]) => id === partnerId && name === 'Azure Interior')).toBe(true);
    expect((await partners.nameSearch('Azure')).map(([id]) => id)).toContain(partnerId);
  });
});

describe('read_group', () => {
  it('groups by a selection with counts and sums, carrying a leaf domain', async () => {
    const orderModel = env.model('sale.order');
    const base = { partner_id: partnerId, partner_invoice_id: partnerId, client_order_ref: 'grp' };
    await orderModel.create({ ...base, order_line: [[0, 0, { name: 'x', product_uom_qty: 1, price_unit: 100 }]] });
    await orderModel.create({ ...base, order_line: [[0, 0, { name: 'x', product_uom_qty: 1, price_unit: 40 }]] });
    const sale = await orderModel.create({ ...base, order_line: [[0, 0, { name: 'x', product_uom_qty: 1, price_unit: 7 }]] });
    await orderModel.write(sale, { state: 'sale' });

    const groups = await orderModel.readGroup([['client_order_ref', '=', 'grp']], ['amount_total:sum'], ['state']);
    const draft = groups.find((group) => group.state === 'draft');
    expect(draft?.__count).toBe(2);
    expect(draft?.amount_total).toBe(140);
    expect(draft?.__domain).toEqual([['client_order_ref', '=', 'grp'], ['state', '=', 'draft']]);
    expect(groups.find((group) => group.state === 'sale')?.amount_total).toBe(7);
  });

  it('groups by month with a range domain and a human label', async () => {
    const orderModel = env.model('sale.order');
    const base = { partner_id: partnerId, partner_invoice_id: partnerId, client_order_ref: 'month' };
    await orderModel.create({ ...base, date_order: '2026-08-03 09:00:00' });
    await orderModel.create({ ...base, date_order: '2026-09-19 09:00:00' });
    await orderModel.create({ ...base, date_order: '2026-09-25 09:00:00' });

    const groups = await orderModel.readGroup([['client_order_ref', '=', 'month']], [], ['date_order:month']);
    expect(groups.map((group) => group['date_order:month'])).toEqual(['August 2026', 'September 2026']);
    expect(groups[1].__count).toBe(2);
    expect(groups[1].__range).toEqual({ date_order: { from: '2026-09-01 00:00:00', to: '2026-10-01 00:00:00' } });
    expect(groups[1].__domain).toEqual([
      ['client_order_ref', '=', 'month'], ['date_order', '>=', '2026-09-01 00:00:00'], ['date_order', '<', '2026-10-01 00:00:00'],
    ]);

    const arabic = await makeEnv({ lang: 'ar_001' }).model('sale.order').readGroup([['client_order_ref', '=', 'month']], [], ['date_order:month']);
    expect(arabic[1]['date_order:month']).toBe('سبتمبر 2026');
  });

  it('groups by many2one with [id, name] and lazy sub-groups', async () => {
    const orderModel = env.model('sale.order');
    await orderModel.create({ partner_id: partnerId, partner_invoice_id: partnerId, client_order_ref: 'm2o-grp' });
    const groups = await orderModel.readGroup([['client_order_ref', '=', 'm2o-grp']], [], ['partner_id', 'state']);
    expect(groups).toHaveLength(1);
    expect(groups[0].partner_id).toEqual([partnerId, 'Azure Interior']);
    expect(groups[0].__context).toEqual({ group_by: ['state'] });
    expect(groups[0].partner_id_count).toBe(1);
  });
});

describe('records', () => {
  it('copies a record with a "(copy)" suffix and skips lines', async () => {
    const orderModel = env.model('sale.order');
    const id = await orderModel.create({
      partner_id: partnerId, partner_invoice_id: partnerId, client_order_ref: 'orig',
      order_line: [[0, 0, { name: 'A', product_uom_qty: 1, price_unit: 10 }]],
    });
    const copyId = await orderModel.copy(id);
    const [copy] = await orderModel.read(copyId, ['name', 'client_order_ref', 'order_line', 'partner_id']);
    const [original] = await orderModel.read(id, ['name']);
    expect(copy.name).toBe(`${original.name} (copy)`);
    expect(copy.client_order_ref).toBe('orig');
    expect(copy.order_line).toEqual([]);
    expect(copy.partner_id).toEqual([partnerId, 'Azure Interior']);
  });

  it('deletes a record with its lines and chatter', async () => {
    const orderModel = env.model('sale.order');
    const id = await orderModel.create({
      partner_id: partnerId, partner_invoice_id: partnerId,
      order_line: [[0, 0, { name: 'A', product_uom_qty: 1, price_unit: 10 }]],
    });
    const [order] = await orderModel.read(id, ['order_line']);
    await orderModel.unlink(id);
    expect(await orderModel.exists([id])).toEqual([]);
    expect(await env.model('sale.order.line').exists(order.order_line as number[])).toEqual([]);
    const messages = await env.cr.query<{ n: string }>(`SELECT count(*)::text AS n FROM mail_message WHERE model = 'sale.order' AND res_id = $1`, [id]);
    expect(messages.rows[0].n).toBe('0');
  });

  it('web_read returns nested lines and many2one objects from a specification', async () => {
    const orderModel = env.model('sale.order');
    const id = await orderModel.create({
      partner_id: partnerId, partner_invoice_id: partnerId,
      order_line: [[0, 0, { name: 'Nested', product_uom_qty: 2, price_unit: 3 }]],
    });
    const [record] = await orderModel.webRead(id, {
      name: {},
      partner_id: { fields: { email: {} } },
      order_line: { fields: { name: {}, price_subtotal: {} } },
    });
    expect(record.partner_id).toMatchObject({ id: partnerId, display_name: 'Azure Interior', email: 'azure@example.com' });
    expect(record.order_line).toEqual([expect.objectContaining({ name: 'Nested', price_subtotal: 6 })]);
  });

  it('default_get honours default_<field> context keys', async () => {
    const defaults = await makeEnv({ context: { default_client_order_ref: 'CTX' } }).model('sale.order').defaultGet(['client_order_ref', 'company_id', 'state']);
    expect(defaults).toMatchObject({ client_order_ref: 'CTX', company_id: companyId, state: 'draft' });
  });

  it('runs onchange rules and button methods', async () => {
    const orderModel = env.model('sale.order');
    const change = await orderModel.onchange({ partner_id: partnerId }, ['partner_id']);
    expect(change.value).toEqual({ partner_invoice_id: partnerId });

    const id = await orderModel.create({ partner_id: partnerId, partner_invoice_id: partnerId });
    await orderModel.callButton(id, 'action_confirm');
    expect((await orderModel.read(id, ['state']))[0].state).toBe('sale');
    await expect(orderModel.callButton(id, 'action_nope')).rejects.toMatchObject({ kind: 'user_error' });
  });
});

describe('access', () => {
  it('enforces model ACLs by group', async () => {
    const def = registry.models['crm.tag'];
    def.access = [{ group: '99', read: true, write: true, create: true, unlink: true }];
    try {
      await expect(env.model('crm.tag').create({ name: 'Forbidden' })).rejects.toBeInstanceOf(AccessError);
      const member = makeEnv({ groupIds: [99] });
      const id = await member.model('crm.tag').create({ name: 'Allowed' });
      expect(id).toBeGreaterThan(0);
      expect(await env.sudo().model('crm.tag').search([['name', '=', 'Allowed']])).toEqual([id]);
    } finally {
      def.access = [];
    }
  });

  it('applies record rules to search, write and unlink', async () => {
    const def = registry.models['sale.order'];
    def.recordRules = [{
      name: 'Own quotations', domain: "[('user_id', '=', uid)]", groups: undefined, global: true,
      perms: { read: true, write: true, create: false, unlink: true },
    }];
    try {
      const mine = await env.sudo().model('sale.order').create({ partner_id: partnerId, partner_invoice_id: partnerId, user_id: 2, client_order_ref: 'rule' });
      const theirs = await env.sudo().model('sale.order').create({ partner_id: partnerId, partner_invoice_id: partnerId, user_id: 1, client_order_ref: 'rule' });
      expect(await env.model('sale.order').search([['client_order_ref', '=', 'rule']])).toEqual([mine]);
      await expect(env.model('sale.order').write(theirs, { client_order_ref: 'x' })).rejects.toBeInstanceOf(AccessError);
      await expect(env.model('sale.order').unlink(theirs)).rejects.toBeInstanceOf(AccessError);
      expect(await env.model('sale.order').write(mine, { client_order_ref: 'rule' })).toBe(true);
    } finally {
      def.recordRules = [];
    }
  });
});
