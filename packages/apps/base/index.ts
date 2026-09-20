import { registerModelHooks } from '../../engine/orm/hooks.js';
import type { Environment } from '../../engine/orm/env.js';
import { quoteIdent } from '../../engine/schema/ddl.js';

/**
 * Base behaviours shared by every app (D-16 / A-3 mixins): partners,
 * products, translated display names.
 */

/** Value of a many2one from a wire record ([id, name] or {id}). */
export function m2oId(value: unknown): number | false {
  if (typeof value === 'number') return value;
  if (Array.isArray(value) && typeof value[0] === 'number') return value[0];
  if (value && typeof value === 'object' && 'id' in (value as object)) return Number((value as { id: number }).id);
  return false;
}

/** Read one column of several records straight from SQL (internal helper). */
export async function columnOf<T = unknown>(env: Environment, table: string, column: string, ids: number[]): Promise<Map<number, T>> {
  if (ids.length === 0) return new Map();
  const rows = await env.cr.query<{ id: number; v: T }>(`SELECT "id", ${quoteIdent(column)} AS v FROM ${quoteIdent(table)} WHERE "id" = ANY($1)`, [ids]);
  return new Map(rows.rows.map((row) => [Number(row.id), row.v]));
}

export function registerBase(): void {
  registerModelHooks('res.partner', {
    defaults: () => ({ autopost_bills: 'ask', type: 'contact', is_company: false, lang: 'en_US' }),
    searchFields: ['email', 'phone', 'ref'],
    computes: [{
      fields: ['commercial_partner_id'],
      depends: ['parent_id', 'is_company'],
      compute: async (env, ids) => {
        const rows = await env.cr.query<{ id: number; parent_id: number | null; is_company: boolean | null }>(
          `SELECT "id", parent_id, is_company FROM res_partner WHERE "id" = ANY($1)`, [ids],
        );
        const out: Record<number, Record<string, unknown>> = {};
        for (const row of rows.rows) {
          out[Number(row.id)] = { commercial_partner_id: row.is_company || !row.parent_id ? Number(row.id) : Number(row.parent_id) };
        }
        return out;
      },
    }],
    tracked: ['name', 'email', 'phone'],
  });

  registerModelHooks('product.template', {
    defaults: async (env) => {
      const unit = await env.cr.query<{ id: number }>(`SELECT id FROM uom_uom WHERE name IN ('Unit', 'Units') ORDER BY id LIMIT 1`);
      return {
        type: 'consu', invoice_policy: 'order', service_tracking: 'no', sale_ok: true, purchase_ok: true,
        list_price: 1, standard_price: 0, uom_id: unit.rows[0]?.id ?? false, active: true,
      };
    },
    searchFields: ['default_code', 'barcode'],
    displayName: (_env, record) => (record.default_code ? `[${record.default_code}] ${record.name ?? ''}` : String(record.name ?? '')),
    displayNameFields: ['name', 'default_code'],
    displayNameSql: (alias) => `CASE WHEN ${alias}."default_code" IS NOT NULL AND ${alias}."default_code" <> '' THEN '[' || ${alias}."default_code" || '] ' || coalesce(${alias}."name", '') ELSE coalesce(${alias}."name", '') END`,
    onCreate: async (env, ids) => {
      // Every template has at least one variant, as in Odoo.
      for (const id of ids) {
        const variant = env.model('product.product');
        const existing = await variant.search([['product_tmpl_id', '=', id]], { activeTest: false });
        if (existing.length === 0) {
          const [template] = await env.sudo().model('product.template').read(id, ['name', 'default_code', 'list_price', 'standard_price']);
          await variant.create({ product_tmpl_id: id, name: template.name, default_code: template.default_code, lst_price: template.list_price, standard_price: template.standard_price, active: true });
        }
      }
    },
    onWrite: async (env, ids, vals) => {
      const mirrored = ['name', 'default_code', 'active'].filter((name) => name in vals);
      if (mirrored.length === 0) return;
      const variants = await env.sudo().model('product.product').search([['product_tmpl_id', 'in', ids]], { activeTest: false });
      if (variants.length) {
        const patch: Record<string, unknown> = {};
        for (const name of mirrored) patch[name] = vals[name];
        if ('list_price' in vals) patch.lst_price = vals.list_price;
        await env.sudo().model('product.product').write(variants, patch);
      }
    },
    // Deleting a template deletes its variants, as Odoo's cascade does.
    onUnlink: async (env, ids) => {
      const variants = await env.model('product.product').search([['product_tmpl_id', 'in', ids]], { activeTest: false });
      if (variants.length) await env.model('product.product').unlink(variants);
    },
  });

  registerModelHooks('product.product', {
    searchFields: ['default_code', 'barcode'],
    displayName: (_env, record) => (record.default_code ? `[${record.default_code}] ${record.name ?? ''}` : String(record.name ?? '')),
    displayNameFields: ['name', 'default_code'],
    displayNameSql: (alias) => `CASE WHEN ${alias}."default_code" IS NOT NULL AND ${alias}."default_code" <> '' THEN '[' || ${alias}."default_code" || '] ' || coalesce(${alias}."name", '') ELSE coalesce(${alias}."name", '') END`,
  });

  registerModelHooks('res.company', {
    tracked: ['name', 'currency_id'],
  });

  registerModelHooks('account.tax', {
    defaults: async (env) => {
      const company = await env.cr.query<{ country: number | null }>(
        `SELECT coalesce(account_fiscal_country_id, country_id) AS country FROM res_company WHERE id = $1`, [env.companyId],
      );
      // Odoo ships a default "Taxes" group per company; create it on first use.
      let group = await env.cr.query<{ id: number }>(`SELECT id FROM account_tax_group ORDER BY sequence, id LIMIT 1`);
      if (group.rows.length === 0) {
        await env.sudo().model('account.tax.group').create({ name: 'Taxes', sequence: 10 });
        group = await env.cr.query<{ id: number }>(`SELECT id FROM account_tax_group ORDER BY id LIMIT 1`);
      }
      return {
        sequence: 1, type_tax_use: 'sale', amount_type: 'percent', amount: 0, active: true, price_include: false,
        country_id: company.rows[0]?.country ? Number(company.rows[0].country) : false,
        tax_group_id: group.rows[0]?.id ?? false,
      };
    },
    displayName: (_env, record) => String(record.name ?? ''),
  });
}
