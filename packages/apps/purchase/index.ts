import { registerModelHooks, type Values } from '../../engine/orm/hooks.js';
import type { Environment } from '../../engine/orm/env.js';
import { UserError } from '../../engine/orm/errors.js';
import { nextByCode } from '../../engine/orm/sequence.js';
import { floatRound } from '../../engine/format/index.js';
import { getSetting } from '../base/settings.js';
import { m2o, note, notify, now, openRecords, today, windowAction, type Row } from '../common.js';

/**
 * D-4 — Purchase: RFQ → purchase order state machine with the optional
 * manager approval, numbering (`P00001`), line totals, receipts without the
 * Inventory app ("Receive" marks quantities received), vendor bills from
 * ordered or received quantities, and the purchase.order form buttons.
 */

async function lineRounding(env: Environment, orderId: number): Promise<number> {
  const row = await env.cr.query<{ rounding: number | null }>(`SELECT c.rounding::float8 AS rounding FROM purchase_order o LEFT JOIN res_currency c ON c.id = o.currency_id WHERE o.id = $1`, [orderId]);
  return row.rows[0]?.rounding || 0.01;
}

/** Vendor price from the product's vendor pricelist, else the product cost. */
async function vendorPrice(env: Environment, productId: number, partnerId: number | false, qty: number): Promise<{ price: number; delay: number; name: string; uom: number | false }> {
  const product = await env.cr.query<{ standard_price: number | null; name: string; uom_id: number | null; tmpl: number; description_purchase: string | null }>(
    `SELECT t.standard_price::float8 AS standard_price, p.name, t.uom_id, t.id AS tmpl, t.description_purchase FROM product_product p JOIN product_template t ON t.id = p.product_tmpl_id WHERE p.id = $1`, [productId],
  );
  const row = product.rows[0];
  let price = row?.standard_price ?? 0;
  let delay = 0;
  if (env.registry.models['product.supplierinfo'] && row) {
    const seller = await env.cr.query<{ price: number | null; delay: number | null }>(
      `SELECT price::float8 AS price, delay FROM product_supplierinfo WHERE product_tmpl_id = $1 AND (partner_id = $2 OR $2 IS NULL) AND coalesce(min_qty, 0) <= $3 ORDER BY CASE WHEN partner_id = $2 THEN 0 ELSE 1 END, sequence, min_qty DESC LIMIT 1`,
      [row.tmpl, partnerId || null, qty],
    ).catch(() => ({ rows: [] as { price: number | null; delay: number | null }[] }));
    if (seller.rows[0]) { price = seller.rows[0].price ?? price; delay = seller.rows[0].delay ?? 0; }
  }
  const name = row ? `${row.name}${row.description_purchase ? `\n${row.description_purchase}` : ''}` : '';
  return { price, delay, name, uom: row?.uom_id ?? false };
}

async function fillLine(env: Environment, vals: Values, productId: number, force = false): Promise<void> {
  let partnerId: number | false = false;
  const orderId = m2o(vals.order_id);
  if (orderId) {
    const order = await env.cr.query<{ partner_id: number | null }>(`SELECT partner_id FROM purchase_order WHERE id = $1`, [orderId]);
    partnerId = order.rows[0]?.partner_id ?? false;
  }
  const info = await vendorPrice(env, productId, partnerId, Number(vals.product_qty ?? 1));
  if (force || !vals.name) vals.name = info.name;
  if (force || vals.price_unit === undefined || vals.price_unit === 0) vals.price_unit = info.price;
  if (!vals.uom_id && info.uom) vals.uom_id = info.uom;
  if (!vals.date_planned) vals.date_planned = `${new Date(Date.now() + info.delay * 86_400_000).toISOString().slice(0, 10)} 12:00:00`;
}

/** Quantity a line can still be billed for, per the product's control policy. */
async function qtyToBill(env: Environment, line: Row): Promise<number> {
  const productId = m2o(line.product_id);
  let method = 'receive';
  if (productId) {
    const row = await env.cr.query<{ purchase_method: string | null; type: string | null }>(`SELECT t.purchase_method, t.type FROM product_product p JOIN product_template t ON t.id = p.product_tmpl_id WHERE p.id = $1`, [productId]);
    method = row.rows[0]?.purchase_method ?? (row.rows[0]?.type === 'service' ? 'purchase' : 'receive');
  }
  const base = method === 'purchase' ? Number(line.product_qty ?? 0) : Number(line.qty_received ?? 0);
  return Math.max(0, base - Number(line.qty_invoiced ?? 0));
}

async function refreshInvoiceStatus(env: Environment, orderId: number): Promise<void> {
  const lines = await env.model('purchase.order.line').searchRead([['order_id', '=', orderId], ['display_type', '=', false]], ['product_qty', 'qty_received', 'qty_invoiced', 'product_id']);
  const [order] = await env.model('purchase.order').read(orderId, ['state']);
  let status = 'no';
  let receipt = 'pending';
  if (['purchase', 'done'].includes(String(order.state)) && lines.length) {
    let toBill = 0; let billed = 0;
    for (const line of lines) { toBill += await qtyToBill(env, line); billed += Number(line.qty_invoiced ?? 0); }
    status = toBill > 0 ? 'to invoice' : billed > 0 ? 'invoiced' : 'no';
    const ordered = lines.reduce((s, l) => s + Number(l.product_qty ?? 0), 0);
    const received = lines.reduce((s, l) => s + Number(l.qty_received ?? 0), 0);
    receipt = received <= 0 ? 'pending' : received >= ordered ? 'full' : 'partial';
  }
  await env.cr.query(`UPDATE purchase_order SET invoice_status = $2, receipt_status = $3 WHERE id = $1`, [orderId, status, receipt]);
}

export function registerPurchase(): void {
  registerModelHooks('purchase.order', {
    defaults: (env) => ({ name: 'New', state: 'draft', date_order: now(), user_id: env.uid, company_id: env.companyId, invoice_status: 'no', receipt_status: 'pending', locked: false, acknowledged: false, priority: '0', document_tax_mode: 'tax_excluded' }),
    noCopy: ['name', 'state', 'date_approve', 'invoice_status', 'receipt_status', 'locked', 'acknowledged', 'message_ids', 'activity_ids'],
    tracked: ['state', 'partner_id', 'amount_total', 'date_planned'],
    creationMessage: { en: 'Request for Quotation created', ar: 'تم إنشاء طلب عرض السعر' },
    displayName: (_env, record) => String(record.partner_ref ? `${record.name} (${record.partner_ref})` : record.name ?? ''),
    displayNameFields: ['name', 'partner_ref'],
    searchFields: ['partner_ref', 'origin'],
    beforeCreate: async (env, vals) => {
      const out = { ...vals };
      if (!out.name || out.name === 'New' || out.name === '/') out.name = await nextByCode(env, 'purchase.order');
      if (!out.currency_id) {
        const company = await env.cr.query<{ currency_id: number | null }>(`SELECT currency_id FROM res_company WHERE id = $1`, [env.companyId]);
        out.currency_id = company.rows[0]?.currency_id ?? false;
      }
      if (out.partner_id && !out.payment_term_id) {
        const partner = await env.cr.query<{ t: number | null }>(`SELECT property_supplier_payment_term_id AS t FROM res_partner WHERE id = $1`, [m2o(out.partner_id)]);
        if (partner.rows[0]?.t) out.payment_term_id = partner.rows[0].t;
      }
      return out;
    },
    computes: [{
      fields: ['amount_untaxed', 'amount_total', 'amount_total_cc'],
      depends: ['order_line', 'order_line.price_subtotal', 'order_line.price_total', 'currency_id'],
      compute: async (env, ids) => {
        const out: Record<number, Values> = {};
        for (const id of ids) {
          const rounding = await lineRounding(env, id);
          const sums = await env.cr.query<{ untaxed: number; total: number }>(`SELECT coalesce(sum(price_subtotal), 0)::float8 AS untaxed, coalesce(sum(price_total), 0)::float8 AS total FROM purchase_order_line WHERE order_id = $1 AND coalesce(display_type, '') = ''`, [id]);
          const untaxed = floatRound(sums.rows[0]?.untaxed ?? 0, rounding); const total = floatRound(sums.rows[0]?.total ?? 0, rounding);
          out[id] = { amount_untaxed: untaxed, amount_total: total, amount_total_cc: total };
        }
        return out;
      },
    }],
    onchange: {
      partner_id: async (env, values) => {
        const partnerId = m2o(values.partner_id);
        if (!partnerId) return {};
        const partner = await env.cr.query<{ t: number | null; warn: string | null; msg: string | null }>(`SELECT property_supplier_payment_term_id AS t, purchase_warn AS warn, purchase_warn_msg AS msg FROM res_partner WHERE id = $1`, [partnerId]);
        const result: { value: Values; warning?: { title: string; message: string } } = { value: {} };
        if (partner.rows[0]?.t) result.value.payment_term_id = partner.rows[0].t;
        if (partner.rows[0]?.warn && partner.rows[0].warn !== 'no-message' && partner.rows[0].msg) result.warning = { title: 'Warning for the vendor', message: String(partner.rows[0].msg) };
        return result;
      },
    },
    methods: {
      action_rfq_send: async (env, ids) => {
        const orders = env.model('purchase.order');
        for (const id of ids) { const [o] = await orders.read(id, ['state']); if (o.state === 'draft') await orders.write(id, { state: 'sent' }); }
        return { type: 'ir.actions.client', tag: 'mail.compose', params: { model: 'purchase.order', res_id: ids[0] } };
      },
      message_sent: async (env, ids) => {
        const orders = env.model('purchase.order');
        for (const id of ids) { const [o] = await orders.read(id, ['state']); if (o.state === 'draft') await orders.write(id, { state: 'sent' }); }
      },
      button_confirm: async (env, ids) => {
        const orders = env.model('purchase.order');
        const doubleValidation = await getSetting<string>(env, 'po_double_validation', 'one_step');
        const limit = Number(await getSetting<number>(env, 'po_double_validation_amount', 5000));
        const lock = await getSetting<string>(env, 'po_lock', 'edit');
        for (const id of ids) {
          const [order] = await orders.read(id, ['state', 'amount_total', 'order_line', 'partner_id']);
          if (!['draft', 'sent'].includes(String(order.state))) throw new UserError({ en: 'Only requests for quotation can be confirmed.', ar: 'يمكن تأكيد طلبات عروض الأسعار فقط.' });
          if (!(order.order_line as number[]).length) throw new UserError({ en: 'You cannot confirm a purchase order without products.', ar: 'لا يمكن تأكيد أمر شراء بدون منتجات.' });
          if (doubleValidation === 'two_step' && Number(order.amount_total) >= limit) {
            await orders.write(id, { state: 'to approve' });
            await note(env, 'purchase.order', id, { en: 'Purchase order sent for approval.', ar: 'تم إرسال أمر الشراء للموافقة.' });
            continue;
          }
          await orders.write(id, { state: 'purchase', date_approve: now(), locked: lock === 'lock' });
          const partnerId = m2o(order.partner_id);
          if (partnerId) await env.cr.query(`UPDATE res_partner SET supplier_rank = coalesce(supplier_rank, 0) + 1 WHERE id = $1`, [partnerId]);
          await refreshInvoiceStatus(env, id);
          await note(env, 'purchase.order', id, { en: 'Purchase order confirmed.', ar: 'تم تأكيد أمر الشراء.' });
        }
      },
      button_approve: async (env, ids) => {
        const orders = env.model('purchase.order');
        for (const id of ids) {
          const [order] = await orders.read(id, ['state']);
          if (order.state !== 'to approve') throw new UserError({ en: 'Only orders waiting for approval can be approved.', ar: 'يمكن الموافقة على الطلبات بانتظار الموافقة فقط.' });
          await orders.write(id, { state: 'purchase', date_approve: now() });
          await refreshInvoiceStatus(env, id);
          await note(env, 'purchase.order', id, { en: 'Purchase order approved.', ar: 'تمت الموافقة على أمر الشراء.' });
        }
      },
      action_receive: async (env, ids) => {
        for (const id of ids) {
          const [order] = await env.model('purchase.order').read(id, ['state']);
          if (order.state !== 'purchase') throw new UserError({ en: 'Only confirmed orders can be received.', ar: 'يمكن استلام الطلبات المؤكدة فقط.' });
          await env.cr.query(`UPDATE purchase_order_line SET qty_received = product_qty, qty_received_manual = product_qty WHERE order_id = $1 AND coalesce(display_type, '') = ''`, [id]);
          await refreshInvoiceStatus(env, id);
          await note(env, 'purchase.order', id, { en: 'Products received.', ar: 'تم استلام المنتجات.' });
        }
      },
      action_acknowledge: async (env, ids) => { await env.model('purchase.order').write(ids, { acknowledged: true }); },
      button_draft: async (env, ids) => { await env.model('purchase.order').write(ids, { state: 'draft', date_approve: false, locked: false }); for (const id of ids) await refreshInvoiceStatus(env, id); },
      button_cancel: async (env, ids) => {
        const orders = env.model('purchase.order');
        for (const id of ids) {
          const billed = await env.cr.query<{ n: number }>(`SELECT count(*)::int AS n FROM purchase_order_line WHERE order_id = $1 AND coalesce(qty_invoiced, 0) > 0`, [id]);
          if (billed.rows[0]?.n) throw new UserError({ en: 'You cannot cancel a purchase order with billed lines: cancel the bills first.', ar: 'لا يمكن إلغاء أمر شراء يحتوي بنوداً مفوترة: قم بإلغاء الفواتير أولاً.' });
          await orders.write(id, { state: 'cancel' });
          await refreshInvoiceStatus(env, id);
        }
      },
      button_lock: async (env, ids) => { await env.model('purchase.order').write(ids, { locked: true }); },
      button_unlock: async (env, ids) => { await env.model('purchase.order').write(ids, { locked: false }); },
      button_reset_date_order: async (env, ids) => { await env.model('purchase.order').write(ids, { date_order: now() }); },
      /** "Create Bills": one draft vendor bill from the lines still to bill. */
      action_create_invoice: async (env, ids) => {
        const billIds: number[] = [];
        for (const id of ids) {
          const [order] = await env.model('purchase.order').read(id, ['name', 'state', 'partner_id', 'currency_id', 'company_id', 'payment_term_id', 'partner_ref', 'order_line', 'user_id', 'fiscal_position_id']);
          if (order.state !== 'purchase') throw new UserError({ en: 'Only confirmed orders can be billed.', ar: 'يمكن فوترة الطلبات المؤكدة فقط.' });
          const lines = await env.model('purchase.order.line').read(order.order_line as number[], ['display_type', 'name', 'product_id', 'uom_id', 'product_qty', 'qty_received', 'qty_invoiced', 'price_unit', 'discount', 'sequence']);
          const invoiceLines: Values[] = [];
          for (const line of lines) {
            if (line.display_type) { invoiceLines.push([0, 0, { display_type: line.display_type, name: line.name, sequence: line.sequence }] as unknown as Values); continue; }
            const qty = await qtyToBill(env, line);
            if (qty <= 0) continue;
            invoiceLines.push([0, 0, { product_id: m2o(line.product_id), name: line.name, quantity: qty, product_uom_id: m2o(line.uom_id), price_unit: line.price_unit, discount: line.discount ?? 0, purchase_line_id: line.id, sequence: line.sequence }] as unknown as Values);
          }
          if (!invoiceLines.some((l) => !(l as unknown as unknown[])[2] || !((l as unknown as unknown[])[2] as Values).display_type)) {
            throw new UserError({ en: `There is no billable line on ${order.name}: receive the products first, or check the bill control policy.`, ar: `لا يوجد بند قابل للفوترة في ${order.name}: استلم المنتجات أولاً أو تحقق من سياسة مراقبة الفواتير.` });
          }
          const billId = await env.with({ context: { default_move_type: 'in_invoice' } }).model('account.move').create({
            move_type: 'in_invoice', partner_id: m2o(order.partner_id), currency_id: m2o(order.currency_id), company_id: m2o(order.company_id) || env.companyId,
            invoice_payment_term_id: m2o(order.payment_term_id) || false, ref: order.partner_ref || false, invoice_origin: order.name, purchase_id: id, fiscal_position_id: m2o(order.fiscal_position_id) || false,
            invoice_date: today(), invoice_line_ids: invoiceLines,
          });
          billIds.push(billId);
          // Billed quantities follow the bill lines.
          for (const line of lines) {
            if (line.display_type) continue;
            const qty = await qtyToBill(env, line);
            if (qty > 0) await env.cr.query(`UPDATE purchase_order_line SET qty_invoiced = coalesce(qty_invoiced, 0) + $2 WHERE id = $1`, [line.id, qty]);
          }
          await refreshInvoiceStatus(env, id);
          await note(env, 'purchase.order', id, { en: 'Vendor bill created.', ar: 'تم إنشاء فاتورة المورد.' });
        }
        return openRecords('account.move', { en: 'Vendor Bills', ar: 'فواتير الموردين' }, billIds, { context: { default_move_type: 'in_invoice' } });
      },
      action_view_invoice: async (env, ids) => {
        const bills = await env.model('account.move').search([['purchase_id', 'in', ids]]).catch(() => [] as number[]);
        return windowAction('account.move', { en: 'Vendor Bills', ar: 'فواتير الموردين' }, { domain: [['id', 'in', bills]], context: { default_move_type: 'in_invoice', default_purchase_id: ids[0] } });
      },
      action_bill_matching: async (_env, ids) => windowAction('account.move', { en: 'Bill Matching', ar: 'مطابقة الفواتير' }, { domain: [['move_type', '=', 'in_invoice'], ['state', '=', 'draft'], ['purchase_id', 'in', [false, ...ids]]], context: { default_move_type: 'in_invoice' } }),
      action_purchase_comparison: async (env, ids) => {
        const [order] = await env.model('purchase.order').read(ids[0], ['partner_id']);
        return windowAction('purchase.order.line', { en: 'Compare Order Lines', ar: 'مقارنة بنود الطلب' }, { domain: [['order_id.state', 'in', ['draft', 'sent', 'to approve']], ['order_id.partner_id', '=', m2o(order.partner_id)]], viewMode: 'list' });
      },
      action_view_sale_orders: async (env, ids) => {
        const [order] = await env.model('purchase.order').read(ids[0], ['origin']);
        const sales = order.origin ? await env.model('sale.order').search([['name', '=', String(order.origin)]]) : [];
        return windowAction('sale.order', { en: 'Sales Orders', ar: 'أوامر البيع' }, { domain: [['id', 'in', sales]] });
      },
    },
  });

  registerModelHooks('purchase.order.line', {
    defaults: () => ({ product_qty: 1, price_unit: 0, discount: 0, qty_received: 0, qty_invoiced: 0, sequence: 10, qty_received_method: 'manual' }),
    beforeCreate: async (env, vals) => {
      const out = { ...vals };
      if (out.display_type) { Object.assign(out, { product_id: false, product_qty: 0, price_unit: 0 }); return out; }
      const productId = m2o(out.product_id);
      if (productId) await fillLine(env, out, productId);
      return out;
    },
    beforeWrite: async (env, ids, vals) => {
      const out = { ...vals };
      const productId = m2o(out.product_id);
      if ('product_id' in out && productId) {
        const [line] = await env.model('purchase.order.line').read(ids[0], ['order_id']);
        await fillLine(env, { ...out, order_id: line.order_id }, productId, true);
      }
      return out;
    },
    computes: [{
      fields: ['price_subtotal', 'price_total', 'state', 'partner_id', 'currency_id', 'date_order'],
      depends: ['product_qty', 'price_unit', 'discount', 'order_id', 'order_id.state', 'order_id.partner_id', 'order_id.currency_id', 'order_id.date_order', 'display_type'],
      compute: async (env, ids) => {
        const rows = await env.cr.query<{ id: number; qty: number; price: number; discount: number | null; display_type: string | null; state: string; partner_id: number | null; currency_id: number | null; date_order: string | null; rounding: number | null }>(
          `SELECT l.id, coalesce(l.product_qty, 0)::float8 AS qty, coalesce(l.price_unit, 0)::float8 AS price, l.discount::float8 AS discount, l.display_type, o.state, o.partner_id, o.currency_id, to_char(o.date_order, 'YYYY-MM-DD HH24:MI:SS') AS date_order, c.rounding::float8 AS rounding
           FROM purchase_order_line l JOIN purchase_order o ON o.id = l.order_id LEFT JOIN res_currency c ON c.id = o.currency_id WHERE l.id = ANY($1)`, [ids],
        );
        const out: Record<number, Values> = {};
        for (const row of rows.rows) {
          const rounding = row.rounding || 0.01;
          const subtotal = row.display_type ? 0 : floatRound(row.qty * row.price * (1 - (row.discount ?? 0) / 100), rounding);
          out[Number(row.id)] = { price_subtotal: subtotal, price_total: subtotal, state: row.state, partner_id: row.partner_id, currency_id: row.currency_id, date_order: row.date_order };
        }
        return out;
      },
    }],
    onchange: {
      product_id: async (env, values) => {
        const productId = m2o(values.product_id);
        if (!productId) return {};
        const vals: Values = { ...values };
        await fillLine(env, vals, productId, true);
        return { value: { name: vals.name, price_unit: vals.price_unit, uom_id: vals.uom_id, date_planned: vals.date_planned } };
      },
    },
    onCreate: async (env, ids) => {
      const rows = await env.cr.query<{ order_id: number }>(`SELECT DISTINCT order_id FROM purchase_order_line WHERE id = ANY($1)`, [ids]);
      for (const row of rows.rows) await refreshInvoiceStatus(env, Number(row.order_id));
    },
  });
}
