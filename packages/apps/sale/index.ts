import { registerModelHooks, type Values } from '../../engine/orm/hooks.js';
import type { Environment } from '../../engine/orm/env.js';
import { UserError } from '../../engine/orm/errors.js';
import { nextByCode } from '../../engine/orm/sequence.js';
import { floatRound } from '../../engine/format/index.js';
import { m2oId } from '../base/index.js';

/**
 * D-2 — Sales: quotation → order state machine, numbering, totals with
 * taxes, invoice status, partner/product onchanges, and the header buttons
 * of the sale.order form (S-ref V063). Rental and invoicing wizards build
 * on these hooks in later modules.
 */

type Row = Record<string, unknown>;

const QUOTATION_VALIDITY_DAYS = 30;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function now(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Tax amounts for one line: percent / fixed / division, tax-excluded prices. */
async function lineTaxes(env: Environment, lineId: number, base: number, qty: number): Promise<number> {
  const rel = env.registry.models['sale.order.line'].fields.tax_ids;
  if (!rel?.m2mTable) return 0;
  const taxes = await env.cr.query<{ amount: number | null; amount_type: string | null; price_include: boolean | null }>(
    `SELECT t.amount::float8 AS amount, t.amount_type, t.price_include FROM account_tax t
     JOIN "${rel.m2mTable}" r ON r."${rel.m2mColumn2}" = t.id WHERE r."${rel.m2mColumn1}" = $1`, [lineId],
  );
  let total = 0;
  for (const tax of taxes.rows) {
    const amount = tax.amount ?? 0;
    if (tax.amount_type === 'percent') total += tax.price_include ? base - base / (1 + amount / 100) : base * amount / 100;
    else if (tax.amount_type === 'fixed') total += amount * qty;
    else if (tax.amount_type === 'division') total += base / (1 - amount / 100) - base;
  }
  return total;
}

async function currencyRounding(env: Environment, orderId: number): Promise<number> {
  const row = await env.cr.query<{ rounding: number | null }>(
    `SELECT c.rounding::float8 AS rounding FROM sale_order o LEFT JOIN res_currency c ON c.id = o.currency_id WHERE o.id = $1`, [orderId],
  );
  return row.rows[0]?.rounding || 0.01;
}

export function registerSale(): void {
  registerModelHooks('sale.order', {
    defaults: (env) => ({
      name: 'New',
      state: 'draft',
      date_order: now(),
      validity_date: addDays(today(), QUOTATION_VALIDITY_DAYS),
      document_tax_mode: 'tax_excluded',
      user_id: env.uid,
      invoice_status: 'no',
      locked: false,
      require_signature: true,
      require_payment: false,
    }),
    tracked: ['state', 'partner_id', 'user_id', 'amount_total'],
    searchFields: ['client_order_ref'],
    creationMessage: { en: 'Quotation created', ar: 'تم إنشاء عرض السعر' },

    beforeCreate: async (env, vals) => {
      const out = { ...vals };
      if (!out.name || out.name === 'New') out.name = await nextByCode(env, 'sale.order');
      await fillFromPartner(env, out);
      return out;
    },
    beforeWrite: async (env, _ids, vals) => {
      const out = { ...vals };
      if ('partner_id' in out) await fillFromPartner(env, out, true);
      return out;
    },

    computes: [{
      fields: ['amount_untaxed', 'amount_tax', 'amount_total', 'amount_to_invoice', 'amount_invoiced'],
      depends: ['order_line.price_subtotal', 'order_line.price_tax', 'order_line.qty_to_invoice', 'order_line', 'currency_id'],
      compute: async (env, ids) => {
        const rows = await env.cr.query<{ order_id: number; untaxed: number; tax: number; to_invoice: number }>(
          `SELECT order_id, coalesce(sum(price_subtotal), 0)::float8 AS untaxed, coalesce(sum(price_tax), 0)::float8 AS tax,
                  coalesce(sum(CASE WHEN display_type IS NULL THEN qty_to_invoice * price_unit * (1 - coalesce(discount, 0) / 100) ELSE 0 END), 0)::float8 AS to_invoice
           FROM sale_order_line WHERE order_id = ANY($1) GROUP BY order_id`, [ids],
        );
        const out: Record<number, Values> = {};
        for (const id of ids) out[id] = { amount_untaxed: 0, amount_tax: 0, amount_total: 0, amount_to_invoice: 0, amount_invoiced: 0 };
        for (const row of rows.rows) {
          const rounding = await currencyRounding(env, Number(row.order_id));
          const untaxed = floatRound(row.untaxed, rounding);
          const tax = floatRound(row.tax, rounding);
          out[Number(row.order_id)] = { amount_untaxed: untaxed, amount_tax: tax, amount_total: floatRound(untaxed + tax, rounding), amount_to_invoice: floatRound(row.to_invoice, rounding), amount_invoiced: floatRound(untaxed - row.to_invoice, rounding) };
        }
        return out;
      },
    }, {
      fields: ['invoice_status'],
      depends: ['state', 'order_line.invoice_status', 'order_line'],
      compute: async (env, ids) => {
        const rows = await env.cr.query<{ id: number; state: string | null; statuses: string[] | null }>(
          `SELECT o.id, o.state, array_agg(l.invoice_status) FILTER (WHERE l.display_type IS NULL) AS statuses
           FROM sale_order o LEFT JOIN sale_order_line l ON l.order_id = o.id WHERE o.id = ANY($1) GROUP BY o.id, o.state`, [ids],
        );
        const out: Record<number, Values> = {};
        for (const row of rows.rows) {
          const statuses = row.statuses ?? [];
          let status = 'no';
          if (row.state === 'sale' && statuses.length) {
            if (statuses.includes('to invoice')) status = 'to invoice';
            else if (statuses.includes('upselling')) status = 'upselling';
            else if (statuses.every((item) => item === 'invoiced')) status = 'invoiced';
          }
          out[Number(row.id)] = { invoice_status: status };
        }
        return out;
      },
    }],

    onchange: {
      partner_id: async (env, values) => {
        const partnerId = m2oId(values.partner_id);
        if (!partnerId) return { value: { partner_invoice_id: false, partner_shipping_id: false } };
        const [partner] = await env.sudo().model('res.partner').read(partnerId, ['property_payment_term_id', 'sale_warn', 'sale_warn_msg']);
        const value: Values = { partner_invoice_id: partnerId, partner_shipping_id: partnerId };
        if (partner?.property_payment_term_id) value.payment_term_id = partner.property_payment_term_id;
        const result: { value: Values; warning?: { title: string; message: string } } = { value };
        if (partner?.sale_warn && partner.sale_warn !== 'no-message' && partner.sale_warn_msg) {
          result.warning = { title: 'Warning for the customer', message: String(partner.sale_warn_msg) };
          if (partner.sale_warn === 'block') result.value.partner_id = false;
        }
        return result;
      },
    },

    methods: {
      action_confirm: async (env, ids) => {
        const orders = env.model('sale.order');
        for (const [order] of await Promise.all(ids.map((id) => orders.read(id, ['state', 'order_line', 'date_order'])))) {
          if (!['draft', 'sent'].includes(String(order.state))) {
            throw new UserError({ en: 'Only draft or sent quotations can be confirmed.', ar: 'يمكن تأكيد عروض الأسعار في حالة المسودة أو المرسلة فقط.' });
          }
          await orders.write(order.id as number, { state: 'sale', date_order: now() });
          // Lines become invoiceable once the order is confirmed.
          const lines = order.order_line as number[];
          if (lines.length) await env.model('sale.order.line').recompute(lines, ['state'], false);
          await orders.recompute([order.id as number], ['order_line'], false);
        }
      },
      action_quotation_send: async (env, ids) => {
        const orders = env.model('sale.order');
        for (const id of ids) {
          const [order] = await orders.read(id, ['state']);
          if (order.state === 'draft') await orders.write(id, { state: 'sent' });
        }
        return { type: 'ir.actions.client', tag: 'display_notification', params: { title: 'Quotation sent', message: 'The quotation has been marked as sent.', type: 'success' } };
      },
      action_cancel: async (env, ids) => {
        await env.model('sale.order').write(ids, { state: 'cancel' });
      },
      action_draft: async (env, ids) => {
        const orders = env.model('sale.order');
        for (const id of ids) {
          const [order] = await orders.read(id, ['state']);
          if (order.state !== 'cancel') throw new UserError({ en: 'Only cancelled orders can be reset to quotation.', ar: 'يمكن إعادة الطلبات الملغاة فقط إلى عرض سعر.' });
          await orders.write(id, { state: 'draft' });
        }
      },
      action_lock: async (env, ids) => { await env.model('sale.order').write(ids, { locked: true }); },
      action_unlock: async (env, ids) => { await env.model('sale.order').write(ids, { locked: false }); },
      action_preview_sale_order: async (_env, ids) => ({ type: 'ir.actions.act_url', url: `/my/orders/${ids[0]}`, target: 'new' }),
      action_reopen_order: async (env, ids) => { await env.model('sale.order').write(ids, { invoicing_closed: false }); },
    },
  });

  registerModelHooks('sale.order.line', {
    defaults: () => ({ product_uom_qty: 1, price_unit: 0, discount: 0, customer_lead: 0, qty_delivered: 0, qty_invoiced: 0, sequence: 10 }),
    beforeCreate: async (env, vals) => {
      const out = { ...vals };
      if (out.display_type) {
        // Sections and notes carry no product or price.
        Object.assign(out, { product_id: false, product_uom_qty: 0, price_unit: 0, customer_lead: 0 });
        return out;
      }
      const productId = m2oId(out.product_id);
      if (productId) await fillFromProduct(env, out, productId);
      if (out.sequence === undefined && out.order_id) {
        const max = await env.cr.query<{ m: number | null }>(`SELECT max(sequence) AS m FROM sale_order_line WHERE order_id = $1`, [m2oId(out.order_id)]);
        out.sequence = (Number(max.rows[0]?.m) || 0) + 10;
      }
      return out;
    },
    beforeWrite: async (env, ids, vals) => {
      const out = { ...vals };
      const productId = m2oId(out.product_id);
      if ('product_id' in out && productId) await fillFromProduct(env, out, productId, true);
      return out;
    },
    computes: [{
      fields: ['price_subtotal', 'price_tax', 'price_total', 'price_reduce_taxexcl'],
      depends: ['product_uom_qty', 'price_unit', 'discount', 'tax_ids'],
      compute: async (env, ids) => {
        const rows = await env.cr.query<{ id: number; qty: number; price: number; discount: number | null; display_type: string | null; rounding: number | null }>(
          `SELECT l.id, l.product_uom_qty::float8 AS qty, l.price_unit::float8 AS price, l.discount::float8 AS discount, l.display_type, c.rounding::float8 AS rounding
           FROM sale_order_line l LEFT JOIN sale_order o ON o.id = l.order_id LEFT JOIN res_currency c ON c.id = o.currency_id WHERE l.id = ANY($1)`, [ids],
        );
        const out: Record<number, Values> = {};
        for (const row of rows.rows) {
          if (row.display_type) { out[Number(row.id)] = { price_subtotal: 0, price_tax: 0, price_total: 0, price_reduce_taxexcl: 0 }; continue; }
          const rounding = row.rounding || 0.01;
          const unit = (row.price ?? 0) * (1 - (row.discount ?? 0) / 100);
          const subtotal = floatRound(unit * (row.qty ?? 0), rounding);
          const tax = floatRound(await lineTaxes(env, Number(row.id), subtotal, row.qty ?? 0), rounding);
          out[Number(row.id)] = { price_subtotal: subtotal, price_tax: tax, price_total: floatRound(subtotal + tax, rounding), price_reduce_taxexcl: floatRound(unit, rounding) };
        }
        return out;
      },
    }, {
      fields: ['qty_to_invoice', 'invoice_status'],
      depends: ['product_uom_qty', 'qty_delivered', 'qty_invoiced', 'state', 'product_id'],
      compute: async (env, ids) => {
        const rows = await env.cr.query<{ id: number; qty: number; delivered: number; invoiced: number; state: string | null; policy: string | null; display_type: string | null }>(
          `SELECT l.id, l.product_uom_qty::float8 AS qty, coalesce(l.qty_delivered, 0)::float8 AS delivered, coalesce(l.qty_invoiced, 0)::float8 AS invoiced,
                  o.state, t.invoice_policy AS policy, l.display_type
           FROM sale_order_line l JOIN sale_order o ON o.id = l.order_id
           LEFT JOIN product_product p ON p.id = l.product_id LEFT JOIN product_template t ON t.id = p.product_tmpl_id WHERE l.id = ANY($1)`, [ids],
        );
        const out: Record<number, Values> = {};
        for (const row of rows.rows) {
          if (row.display_type || row.state !== 'sale') { out[Number(row.id)] = { qty_to_invoice: 0, invoice_status: 'no' }; continue; }
          const basis = row.policy === 'delivery' ? row.delivered : row.qty;
          const toInvoice = basis - row.invoiced;
          let status = 'no';
          if (toInvoice > 0.00001) status = 'to invoice';
          else if (row.invoiced >= row.qty - 0.00001 && row.qty > 0) status = 'invoiced';
          if (row.policy === 'order' && row.delivered > row.qty + 0.00001) status = 'upselling';
          out[Number(row.id)] = { qty_to_invoice: Math.max(0, toInvoice), invoice_status: status };
        }
        return out;
      },
    }],
    onchange: {
      product_id: async (env, values) => {
        const productId = m2oId(values.product_id);
        if (!productId) return {};
        const patch: Values = {};
        await fillFromProduct(env, patch, productId, true);
        return { value: patch };
      },
    },
  });
}

/** Partner-derived defaults: addresses and payment term (D-2 onchanges). */
async function fillFromPartner(env: Environment, vals: Values, force = false): Promise<void> {
  const partnerId = m2oId(vals.partner_id);
  if (!partnerId) return;
  const [partner] = await env.sudo().model('res.partner').read(partnerId, ['property_payment_term_id']);
  if (force || !vals.partner_invoice_id) vals.partner_invoice_id = partnerId;
  if (force || !vals.partner_shipping_id) vals.partner_shipping_id = partnerId;
  if ((force || !vals.payment_term_id) && partner?.property_payment_term_id) vals.payment_term_id = m2oId(partner.property_payment_term_id);
}

/** Product-derived line values: description, unit, price, taxes. */
async function fillFromProduct(env: Environment, vals: Values, productId: number, force = false): Promise<void> {
  const [product] = await env.sudo().model('product.product').read(productId, ['name', 'default_code', 'lst_price', 'product_tmpl_id']);
  if (!product) return;
  const templateId = m2oId(product.product_tmpl_id);
  const [template] = templateId ? await env.sudo().model('product.template').read(templateId, ['uom_id', 'taxes_id', 'description_sale', 'list_price']) : [undefined];
  const label = product.default_code ? `[${product.default_code}] ${product.name}` : String(product.name ?? '');
  if (force || !vals.name) vals.name = template?.description_sale ? `${label}\n${template.description_sale}` : label;
  if (force || !vals.product_uom_id) vals.product_uom_id = template ? m2oId(template.uom_id) : false;
  if (force || vals.price_unit === undefined || vals.price_unit === 0) vals.price_unit = Number(product.lst_price ?? template?.list_price ?? 0);
  if ((force || !vals.tax_ids) && template && Array.isArray(template.taxes_id)) vals.tax_ids = [[6, 0, template.taxes_id as number[]]];
  if (!vals.product_template_id && templateId) vals.product_template_id = templateId;
}
