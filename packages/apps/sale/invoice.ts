import { registerModelHooks, type Values } from '../../engine/orm/hooks.js';
import type { Environment } from '../../engine/orm/env.js';
import { UserError } from '../../engine/orm/errors.js';
import { floatRound } from '../../engine/format/index.js';
import { m2oId } from '../base/index.js';

/**
 * D-2 "Create Invoice": the `sale.advance.payment.inv` wizard (S-ref 448)
 * and the sales ↔ invoicing links — invoice lines point back at order lines
 * (`sale_line_ids`), so `qty_invoiced` and the order's invoice status follow
 * the invoices as they are created, posted or cancelled.
 */

async function downPaymentProduct(env: Environment): Promise<number> {
  const found = await env.cr.query<{ id: number }>(
    `SELECT p.id FROM product_product p JOIN product_template t ON t.id = p.product_tmpl_id WHERE t.name = 'Down Payment' ORDER BY p.id LIMIT 1`,
  );
  if (found.rows.length) return Number(found.rows[0].id);
  const templateId = await env.sudo().model('product.template').create({ name: 'Down Payment', type: 'service', invoice_policy: 'order', list_price: 0, sale_ok: false, purchase_ok: false });
  const [variant] = await env.sudo().model('product.product').search([['product_tmpl_id', '=', templateId]]);
  return variant;
}

/** Create one draft customer invoice for an order's invoiceable lines. */
async function invoiceOrder(env: Environment, orderId: number, mode: 'delivered' | 'percentage' | 'fixed', amount: number): Promise<number> {
  const orders = env.model('sale.order');
  const [order] = await orders.read(orderId, ['name', 'partner_id', 'partner_invoice_id', 'currency_id', 'company_id', 'payment_term_id', 'client_order_ref', 'order_line', 'amount_untaxed', 'amount_total', 'user_id', 'team_id', 'note', 'state']);
  if (order.state !== 'sale') {
    throw new UserError({ en: 'Only confirmed sales orders can be invoiced.', ar: 'يمكن فوترة أوامر البيع المؤكدة فقط.' });
  }
  const invoiceLines: Values[] = [];
  const lineModel = env.model('sale.order.line');

  if (mode === 'delivered') {
    const lines = await lineModel.read(order.order_line as number[], ['display_type', 'name', 'product_id', 'product_uom_id', 'qty_to_invoice', 'price_unit', 'discount', 'tax_ids', 'is_downpayment', 'sequence']);
    let pendingSection: Values | null = null;
    for (const line of lines) {
      if (line.display_type) { pendingSection = line; continue; }
      const qty = Number(line.qty_to_invoice ?? 0);
      if (qty <= 0) continue;
      if (pendingSection) {
        invoiceLines.push({ display_type: pendingSection.display_type, name: pendingSection.name, sequence: pendingSection.sequence });
        pendingSection = null;
      }
      invoiceLines.push({
        display_type: 'product', name: line.name, product_id: m2oId(line.product_id), product_uom_id: m2oId(line.product_uom_id),
        quantity: qty, price_unit: line.price_unit, discount: line.discount, tax_ids: [[6, 0, line.tax_ids as number[]]],
        sale_line_ids: [[4, line.id as number]], sequence: line.sequence,
      });
    }
    if (invoiceLines.length === 0) {
      throw new UserError({
        en: 'There is no invoiceable line. If a product has a Delivered quantities invoicing policy, please make sure that a quantity has been delivered.',
        ar: 'لا يوجد بند قابل للفوترة. إذا كانت سياسة فوترة المنتج بالكميات المسلّمة، يرجى التأكد من تسليم كمية.',
      });
    }
  } else {
    const productId = await downPaymentProduct(env);
    const base = Number(order.amount_untaxed ?? 0);
    const value = floatRound(mode === 'percentage' ? base * amount / 100 : amount, 0.01);
    if (value <= 0) throw new UserError({ en: 'The value of the down payment amount must be positive.', ar: 'يجب أن تكون قيمة الدفعة المقدمة موجبة.' });
    const today = new Date().toISOString().slice(0, 10);
    // Odoo adds the down payment as an order line so it is deducted later.
    const soLine = await lineModel.create({
      order_id: orderId, product_id: productId, name: `Down Payment: ${today}`, product_uom_qty: 0, price_unit: value, is_downpayment: true, discount: 0,
    });
    invoiceLines.push({ display_type: 'product', name: `Down Payment: ${today}`, product_id: productId, quantity: 1, price_unit: value, sale_line_ids: [[4, soLine]] });
  }

  const moves = env.with({ context: { default_move_type: 'out_invoice' } }).model('account.move');
  const invoiceId = await moves.create({
    move_type: 'out_invoice',
    partner_id: m2oId(order.partner_invoice_id) || m2oId(order.partner_id),
    currency_id: m2oId(order.currency_id),
    company_id: m2oId(order.company_id),
    invoice_payment_term_id: m2oId(order.payment_term_id),
    invoice_origin: order.name,
    ref: order.client_order_ref || false,
    invoice_user_id: m2oId(order.user_id),
    narration: order.note || false,
    invoice_line_ids: invoiceLines.map((line) => [0, 0, line]),
  });
  await orders.write(orderId, { invoice_ids: [[4, invoiceId]] });
  return invoiceId;
}

export function registerSaleInvoicing(): void {
  registerModelHooks('sale.order', {
    computes: [{
      fields: ['invoice_count'],
      depends: ['invoice_ids'],
      compute: async (env, ids) => {
        const rel = env.registry.models['sale.order'].fields.invoice_ids;
        const out: Record<number, Values> = {};
        for (const id of ids) out[id] = { invoice_count: 0 };
        if (!rel?.m2mTable) return out;
        const rows = await env.cr.query<{ id: number; n: string }>(
          `SELECT r."${rel.m2mColumn1}" AS id, count(*)::text AS n FROM "${rel.m2mTable}" r WHERE r."${rel.m2mColumn1}" = ANY($1) GROUP BY 1`, [ids],
        );
        for (const row of rows.rows) out[Number(row.id)] = { invoice_count: Number(row.n) };
        return out;
      },
    }],
    methods: {
      action_view_invoice: async (env, ids) => {
        const [order] = await env.model('sale.order').read(ids[0], ['invoice_ids']);
        const invoiceIds = order.invoice_ids as number[];
        return invoiceIds.length === 1
          ? { type: 'ir.actions.act_window', res_model: 'account.move', res_id: invoiceIds[0], view_mode: 'form', name: 'Invoices' }
          : { type: 'ir.actions.act_window', res_model: 'account.move', view_mode: 'list,form', name: 'Invoices', domain: [['id', 'in', invoiceIds]] };
      },
    },
  });

  registerModelHooks('sale.order.line', {
    computes: [{
      fields: ['qty_invoiced', 'untaxed_amount_invoiced'],
      depends: ['invoice_lines.quantity', 'invoice_lines.parent_state', 'invoice_lines'],
      compute: async (env, ids) => {
        const rel = env.registry.models['sale.order.line'].fields.invoice_lines;
        const out: Record<number, Values> = {};
        for (const id of ids) out[id] = { qty_invoiced: 0, untaxed_amount_invoiced: 0 };
        if (!rel?.m2mTable) return out;
        // Draft and posted invoices count; cancelled ones do not; refunds subtract.
        const rows = await env.cr.query<{ id: number; qty: number; amount: number }>(
          `SELECT r."${rel.m2mColumn1}" AS id,
                  coalesce(sum(CASE WHEN m.move_type = 'out_refund' THEN -l.quantity ELSE l.quantity END), 0)::float8 AS qty,
                  coalesce(sum(CASE WHEN m.move_type = 'out_refund' THEN -l.price_subtotal ELSE l.price_subtotal END), 0)::float8 AS amount
           FROM "${rel.m2mTable}" r JOIN account_move_line l ON l.id = r."${rel.m2mColumn2}" JOIN account_move m ON m.id = l.move_id
           WHERE r."${rel.m2mColumn1}" = ANY($1) AND m.state <> 'cancel' GROUP BY 1`, [ids],
        );
        for (const row of rows.rows) out[Number(row.id)] = { qty_invoiced: row.qty, untaxed_amount_invoiced: row.amount };
        return out;
      },
    }],
  });

  registerModelHooks('sale.advance.payment.inv', {
    defaults: async (env) => {
      const activeIds = (env.context.active_ids as number[] | undefined) ?? (env.context.active_id ? [Number(env.context.active_id)] : []);
      const orders = activeIds.length ? await env.model('sale.order').read(activeIds, ['company_id', 'currency_id', 'amount_invoiced', 'amount_to_invoice', 'invoice_ids']) : [];
      const drafts = orders.length
        ? await env.model('account.move').searchCount([['id', 'in', orders.flatMap((order) => order.invoice_ids as number[])], ['state', '=', 'draft']])
        : 0;
      return {
        sale_order_ids: [[6, 0, activeIds]],
        count: activeIds.length,
        advance_payment_method: 'delivered',
        consolidated_billing: true,
        deduct_down_payments: true,
        amount: 0,
        fixed_amount: 0,
        company_id: orders[0] ? m2oId(orders[0].company_id) : env.companyId,
        currency_id: orders[0] ? m2oId(orders[0].currency_id) : false,
        amount_invoiced: orders.reduce((sum, order) => sum + Number(order.amount_invoiced ?? 0), 0),
        amount_to_invoice: orders.reduce((sum, order) => sum + Number(order.amount_to_invoice ?? 0), 0),
        has_down_payments: false,
        display_draft_invoice_warning: drafts > 0,
        display_invoice_amount_warning: false,
      };
    },
    methods: {
      create_invoices: async (env, ids) => {
        const [wizard] = await env.model('sale.advance.payment.inv').read(ids[0], ['sale_order_ids', 'advance_payment_method', 'amount', 'fixed_amount']);
        const orderIds = wizard.sale_order_ids as number[];
        if (orderIds.length === 0) throw new UserError({ en: 'No sales order to invoice.', ar: 'لا يوجد أمر بيع للفوترة.' });
        const mode = String(wizard.advance_payment_method) as 'delivered' | 'percentage' | 'fixed';
        const amount = mode === 'percentage' ? Number(wizard.amount ?? 0) : Number(wizard.fixed_amount ?? 0);
        const invoiceIds: number[] = [];
        for (const orderId of orderIds) invoiceIds.push(await invoiceOrder(env, orderId, mode, amount));
        return invoiceIds.length === 1
          ? { type: 'ir.actions.act_window', res_model: 'account.move', res_id: invoiceIds[0], view_mode: 'form', name: 'Invoices', context: { default_move_type: 'out_invoice' } }
          : { type: 'ir.actions.act_window', res_model: 'account.move', view_mode: 'list,form', name: 'Invoices', domain: [['id', 'in', invoiceIds]], context: { default_move_type: 'out_invoice' } };
      },
    },
  });
}
