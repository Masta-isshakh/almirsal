import { registerModelHooks, type Values } from '../../engine/orm/hooks.js';
import { UserError } from '../../engine/orm/errors.js';
import { note, notify } from '../common.js';
import { m2oId } from '../base/index.js';

/**
 * Renting (the Rental app). A rental line is an order line with a rental
 * period; picking it up records the delivered quantity and returning it records
 * the returned quantity, which is what drives the order's rental status, the
 * Pickup and Return buttons and the Scheduled Rentals gantt.
 *
 * Odoo asks for the quantities in a wizard before it writes them; the export
 * carries no wizard model, so the buttons do the pickup and the return straight
 * away and say what they did.
 */
export function registerRental(): void {
  registerModelHooks('sale.order.line', {
    // A line of a rental order inherits the order's period, which is what makes
    // it a rental line.
    beforeCreate: async (env, vals) => {
      const out = { ...vals };
      const orderId = m2oId(out.order_id);
      if (!orderId || out.display_type) return out;
      if (out.start_date && out.return_date) return out;
      const [order] = await env.sudo().model('sale.order').read(orderId, ['rental_start_date', 'rental_return_date', 'is_rental_order']);
      if (!order?.is_rental_order && !(order?.rental_start_date && order?.rental_return_date)) return out;
      if (!out.start_date && order.rental_start_date) out.start_date = order.rental_start_date;
      if (!out.return_date && order.rental_return_date) out.return_date = order.rental_return_date;
      return out;
    },

    computes: [{
      fields: ['is_rental', 'rental_status', 'rental_color'],
      depends: ['start_date', 'return_date', 'qty_delivered', 'qty_returned', 'product_uom_qty'],
      compute: async (env, ids) => {
        const rows = await env.cr.query<{ id: number; start_date: string | null; return_date: string | null; qty: number; delivered: number; returned: number; display_type: string | null }>(
          `SELECT id, start_date::text, return_date::text, coalesce(product_uom_qty, 0)::float8 AS qty,
                  coalesce(qty_delivered, 0)::float8 AS delivered, coalesce(qty_returned, 0)::float8 AS returned, display_type
           FROM sale_order_line WHERE id = ANY($1)`, [ids],
        );
        const now = Date.now();
        const out: Record<number, Values> = {};
        for (const row of rows.rows) {
          const isRental = Boolean(row.start_date && row.return_date && !row.display_type);
          const returned = row.returned > 0 && row.returned >= row.qty;
          const pickedUp = row.delivered > 0;
          // Odoo colours a late line in the schedule; everything else is plain.
          const due = row.return_date ? new Date(row.return_date.replace(' ', 'T') + 'Z').getTime() : 0;
          const late = isRental && pickedUp && !returned && due > 0 && due < now;
          out[Number(row.id)] = {
            is_rental: isRental,
            rental_status: !isRental ? false : returned ? 'returned' : pickedUp ? 'return' : 'pickup',
            rental_color: late ? 2 : 0,
          };
        }
        return out;
      },
    }],
  });

  registerModelHooks('sale.order', {
    computes: [{
      fields: ['is_rental_order', 'has_pickable_lines', 'has_returnable_lines', 'rental_status', 'show_update_duration'],
      depends: ['order_line', 'order_line.start_date', 'order_line.return_date', 'order_line.qty_delivered', 'order_line.qty_returned', 'order_line.product_uom_qty', 'state'],
      compute: async (env, ids) => {
        const rows = await env.cr.query<{ id: number; state: string | null; rental: number; pickable: number; returnable: number; returned: number; flagged: boolean | null }>(
          `SELECT o.id, o.state, o.is_rental_order AS flagged,
                  count(l.id) FILTER (WHERE l.start_date IS NOT NULL AND l.return_date IS NOT NULL AND l.display_type IS NULL)::int AS rental,
                  count(l.id) FILTER (WHERE l.start_date IS NOT NULL AND l.return_date IS NOT NULL AND l.display_type IS NULL
                                        AND coalesce(l.qty_delivered, 0) < coalesce(l.product_uom_qty, 0))::int AS pickable,
                  count(l.id) FILTER (WHERE l.start_date IS NOT NULL AND l.return_date IS NOT NULL AND l.display_type IS NULL
                                        AND coalesce(l.qty_delivered, 0) > coalesce(l.qty_returned, 0))::int AS returnable,
                  count(l.id) FILTER (WHERE l.start_date IS NOT NULL AND l.return_date IS NOT NULL AND l.display_type IS NULL
                                        AND coalesce(l.qty_returned, 0) > 0 AND coalesce(l.qty_returned, 0) >= coalesce(l.product_uom_qty, 0))::int AS returned
           FROM sale_order o LEFT JOIN sale_order_line l ON l.order_id = o.id
           WHERE o.id = ANY($1) GROUP BY o.id, o.state, o.is_rental_order`, [ids],
        );
        const out: Record<number, Values> = {};
        for (const row of rows.rows) {
          const rental = Number(row.rental) > 0;
          const state = String(row.state ?? 'draft');
          const status = !rental ? false
            : state === 'cancel' ? 'cancel'
              : state === 'draft' || state === 'sent' ? state
                : Number(row.returned) === Number(row.rental) ? 'returned'
                  : Number(row.returnable) > 0 ? 'return' : 'pickup';
          out[Number(row.id)] = {
            // A flag the rental app set on an empty order stays set.
            is_rental_order: rental || Boolean(row.flagged),
            has_pickable_lines: rental && state === 'sale' && Number(row.pickable) > 0,
            has_returnable_lines: rental && state === 'sale' && Number(row.returnable) > 0,
            rental_status: status,
            show_update_duration: rental && !['cancel'].includes(state),
          };
        }
        return out;
      },
    }],

    methods: {
      /** "Pickup": hand the goods over, which records the delivered quantity. */
      action_open_pickup: async (env, ids) => {
        const orders = env.model('sale.order');
        const [order] = await orders.read(ids[0], ['state']);
        if (order.state !== 'sale') throw new UserError({ en: 'Confirm the rental order before picking up.', ar: 'قم بتأكيد أمر التأجير قبل الاستلام.' });
        const lines = env.model('sale.order.line');
        const ready = await lines.search([['order_id', '=', ids[0]], ['is_rental', '=', true]]);
        const records = await lines.read(ready, ['product_uom_qty', 'qty_delivered', 'name']);
        const todo = records.filter((line) => Number(line.qty_delivered ?? 0) < Number(line.product_uom_qty ?? 0));
        if (!todo.length) return notify({ en: 'Everything on this order has been picked up.', ar: 'تم استلام كل ما في هذا الطلب.' }, 'info');
        for (const line of todo) await lines.write(line.id as number, { qty_delivered: Number(line.product_uom_qty ?? 0) });
        await note(env, 'sale.order', ids[0], { en: `${todo.length} rental product(s) picked up.`, ar: `تم استلام ${todo.length} منتج مؤجّر.` });
        return notify({ en: `${todo.length} product(s) picked up.`, ar: `تم استلام ${todo.length} منتج.` });
      },

      /** "Return": take the goods back, which records the returned quantity. */
      action_open_return: async (env, ids) => {
        const orders = env.model('sale.order');
        const [order] = await orders.read(ids[0], ['state']);
        if (order.state !== 'sale') throw new UserError({ en: 'Confirm the rental order before returning.', ar: 'قم بتأكيد أمر التأجير قبل الإرجاع.' });
        const lines = env.model('sale.order.line');
        const ready = await lines.search([['order_id', '=', ids[0]], ['is_rental', '=', true]]);
        const records = await lines.read(ready, ['qty_delivered', 'qty_returned']);
        const todo = records.filter((line) => Number(line.qty_delivered ?? 0) > Number(line.qty_returned ?? 0));
        if (!todo.length) return notify({ en: 'Nothing is out on rental to return.', ar: 'لا يوجد ما يمكن إرجاعه.' }, 'info');
        for (const line of todo) await lines.write(line.id as number, { qty_returned: Number(line.qty_delivered ?? 0) });
        await note(env, 'sale.order', ids[0], { en: `${todo.length} rental product(s) returned.`, ar: `تم إرجاع ${todo.length} منتج مؤجّر.` });
        return notify({ en: `${todo.length} product(s) returned.`, ar: `تم إرجاع ${todo.length} منتج.` });
      },

      /**
       * "Update Rental Prices": the rental period changed, so price the lines
       * from the product again. The export carries no rental price list
       * (`product.pricing`), so the price is the product's, which is what the
       * line takes when the product is picked.
       */
      action_update_rental_prices: async (env, ids) => {
        const lines = env.model('sale.order.line');
        const [order] = await env.model('sale.order').read(ids[0], ['state']);
        if (order.state === 'cancel') throw new UserError({ en: 'A cancelled order cannot be priced again.', ar: 'لا يمكن إعادة تسعير أمر ملغى.' });
        const rental = await lines.search([['order_id', '=', ids[0]], ['is_rental', '=', true]]);
        const records = await lines.read(rental, ['product_id']);
        let updated = 0;
        for (const line of records) {
          const productId = m2oId(line.product_id);
          if (!productId) continue;
          // Writing the product again is what re-reads its price and taxes.
          await lines.write(line.id as number, { product_id: productId });
          updated += 1;
        }
        return updated
          ? notify({ en: `${updated} rental line(s) priced again.`, ar: `تمت إعادة تسعير ${updated} بند تأجير.` })
          : notify({ en: 'There is no rental line to price.', ar: 'لا يوجد بند تأجير لتسعيره.' }, 'info');
      },
    },
  });
}
