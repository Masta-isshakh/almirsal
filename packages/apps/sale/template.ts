import { registerModelHooks, type Values } from '../../engine/orm/hooks.js';
import type { Environment } from '../../engine/orm/env.js';
import { addDays, today } from '../common.js';
import { m2oId } from '../base/index.js';

/**
 * Quotation templates (Sales → Configuration → Quotation Templates, and the
 * rental ones). Picking a template on a quotation fills in what the template
 * says: its lines with their products, quantities, discounts and taxes, the
 * terms, the validity and the signature and payment requirements.
 *
 * The lines are put in when the quotation is saved rather than as you pick the
 * template, and only while the quotation has none of its own, so choosing a
 * template never throws away lines somebody typed.
 */
export function registerSaleTemplates(): void {
  // Odoo's templates are quotations unless they are reusable sections.
  registerModelHooks('sale.order.template', { defaults: () => ({ template_type: 'quotation', active: true }) });

  registerModelHooks('sale.order.template.line', {
    defaults: () => ({ product_uom_qty: 1, sequence: 10 }),
    // A section or a note on a template carries no product and no quantity,
    // exactly as on an order.
    beforeCreate: (_env, vals) => (vals.display_type ? { ...vals, product_id: false, product_uom_qty: 0, price_unit: 0, discount: 0 } : vals),
  });

  registerModelHooks('sale.order', {
    onchange: {
      sale_order_template_id: async (env, values) => {
        const templateId = m2oId(values.sale_order_template_id);
        if (!templateId) return {};
        const [template] = await env.model('sale.order.template').read(templateId, ['note', 'number_of_days', 'require_signature', 'require_payment', 'prepayment_percent', 'journal_id']);
        if (!template) return {};
        const value: Values = {};
        if (template.note) value.note = template.note;
        if (Number(template.number_of_days) > 0) value.validity_date = addDays(today(), Number(template.number_of_days));
        for (const name of ['require_signature', 'require_payment', 'prepayment_percent'] as const) {
          if (template[name] !== undefined && template[name] !== false) value[name] = template[name];
        }
        if (m2oId(template.journal_id)) value.journal_id = m2oId(template.journal_id);
        return { value };
      },
    },

    onCreate: async (env, ids) => { for (const id of ids) await applyTemplate(env, id); },
    onWrite: async (env, ids, vals) => {
      if (!('sale_order_template_id' in vals)) return;
      for (const id of ids) await applyTemplate(env, id);
    },
  });
}

/** Copy a template's lines onto a quotation that has none. */
async function applyTemplate(env: Environment, orderId: number): Promise<void> {
  if (!env.registry.models['sale.order.template.line']) return;
  const orders = env.model('sale.order');
  const [order] = await orders.read(orderId, ['sale_order_template_id', 'order_line', 'state', 'validity_date', 'note']);
  const templateId = m2oId(order?.sale_order_template_id);
  if (!templateId || order.state !== 'draft') return;
  if (Array.isArray(order.order_line) && order.order_line.length) return;

  const lines = await env.model('sale.order.template.line').searchRead(
    [['sale_order_template_id', '=', templateId]],
    ['product_id', 'name', 'product_uom_qty', 'product_uom_id', 'display_type', 'discount', 'price_unit', 'tax_ids', 'sequence', 'is_optional'],
    { order: 'sequence, id' },
  );
  // An optional line is an extra Odoo offers the customer, not part of the
  // quotation, and the export carries no model to keep those in.
  const wanted = lines.filter((line) => !line.is_optional);
  if (!wanted.length) return;

  const commands = wanted.map((line) => [0, 0, line.display_type
    ? { display_type: line.display_type, name: line.name ?? '', sequence: line.sequence }
    : {
      product_id: m2oId(line.product_id) || false,
      name: line.name || undefined,
      product_uom_qty: Number(line.product_uom_qty ?? 1),
      product_uom_id: m2oId(line.product_uom_id) || undefined,
      discount: Number(line.discount ?? 0),
      price_unit: Number(line.price_unit ?? 0) || undefined,
      tax_ids: Array.isArray(line.tax_ids) && line.tax_ids.length ? [[6, 0, line.tax_ids as number[]]] : undefined,
      sequence: line.sequence,
    }]);

  const [template] = await env.model('sale.order.template').read(templateId, ['note', 'number_of_days']);
  const values: Values = { order_line: commands };
  if (!order.note && template?.note) values.note = template.note;
  if (!order.validity_date && Number(template?.number_of_days) > 0) values.validity_date = addDays(today(), Number(template.number_of_days));
  await orders.write(orderId, values);
}
