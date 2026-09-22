import { registerModelHooks, type Values } from '../../engine/orm/hooks.js';
import type { Environment } from '../../engine/orm/env.js';
import { kioskKey } from '../common.js';
import type { Registry } from '../../engine/registry/types.js';
import { getParameter, setParameter } from '../../engine/schema/ddl.js';

/**
 * The settings engine (Part F / C-6). `res.config.settings` is transient:
 * opening the page creates a record whose defaults come from the stored
 * configuration, Save writes the changed values back and reloads.
 *
 *  - fields that exist on `res.company` are read from / written to the
 *    current company (currency, alias domain, …);
 *  - `module_*` and `group_*` toggles and every other field live in
 *    `ir.config_parameter` as JSON under `rodeo.settings.<field>`, which is
 *    what `getSetting()` hands to the other apps' hooks.
 */

const PREFIX = 'rodeo.settings.';
const COMPUTED = new Set(['is_root_company', 'active_user_count', 'language_count', 'company_count', 'company_name', 'company_informations', 'company_id']);

let companyFields: Set<string> = new Set();
const REQUIRED_INTEGERS: Record<string, number> = { fiscalyear_last_day: 31, account_return_reminder_day: 7, planning_generation_interval: 1 };

function encode(value: unknown): string {
  return JSON.stringify(value && typeof value === 'object' && 'id' in (value as object) ? (value as { id: number }).id : value);
}

/** A stored setting (any field of res.config.settings), or `fallback`. */
export async function getSetting<T = unknown>(env: Environment, name: string, fallback: T): Promise<T> {
  const raw = await getParameter(env.cr, `${PREFIX}${name}`);
  if (raw === null) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

export function registerSettings(registry: Registry): void {
  const settings = registry.models['res.config.settings'];
  const company = registry.models['res.company'];
  if (!settings || !company) return;
  companyFields = new Set(Object.keys(settings.fields).filter((name) => company.fields[name] && !COMPUTED.has(name) && name !== 'id'));

  const hooksDefaults = async (env: Environment): Promise<Values> => {
    const out: Values = { company_id: env.companyId };
    // Company-backed fields.
    const companyRow = companyFields.size
      ? (await env.sudo().model('res.company').read(env.companyId, [...companyFields, 'name'])).at(0) ?? {}
      : {};
    for (const name of companyFields) {
      const value = companyRow[name];
      out[name] = Array.isArray(value) ? value[0] : value ?? false;
    }
    out.company_name = String(companyRow.name ?? '');
    // Parameter-backed fields, one query.
    const rows = await env.cr.query<{ key: string; value: string }>(`SELECT key, value FROM ir_config_parameter WHERE key LIKE $1`, [`${PREFIX}%`]);
    for (const row of rows.rows) {
      const name = row.key.slice(PREFIX.length);
      if (!settings.fields[name]) continue;
      try { out[name] = JSON.parse(row.value); } catch { out[name] = row.value; }
    }
    if (settings.fields.attendance_kiosk_url) out.attendance_kiosk_url = `/kiosk/${await kioskKey(env)}`;
    for (const field of Object.values(settings.fields)) {
      if (field.type === 'boolean' && !(field.name in out)) out[field.name] = false;
      // Required selections / integers that were never saved start at Odoo's defaults.
      if (field.required === true && !(field.name in out)) {
        if (field.type === 'selection' && field.selection?.length) out[field.name] = field.selection[0].value;
        else if (field.type === 'integer') out[field.name] = REQUIRED_INTEGERS[field.name] ?? 0;
      }
    }
    // Live counters.
    const users = await env.cr.query<{ n: number }>(`SELECT count(*)::int AS n FROM res_users WHERE coalesce(active, true) AND coalesce(share, false) = false`);
    out.active_user_count = users.rows[0]?.n ?? 1;
    out.language_count = 2;
    out.is_root_company = true;
    return out;
  };

  registerModelHooks('res.config.settings', {
    defaults: hooksDefaults,
    beforeCreate: async (env, vals) => {
      const out: Values = { ...vals };
      const companyVals: Values = {};
      const params: [string, string][] = [];
      // `vals` carries every default too: only what differs from the stored value is written.
      const stored = await hooksDefaults(env);
      for (const [name, value] of Object.entries(vals)) {
        const field = settings.fields[name];
        if (!field || COMPUTED.has(name) || field.type === 'one2many') continue;
        const empty = value === false || value === null || value === undefined || value === '';
        if (!(name in stored) && empty) continue;
        if (name in stored && encode(stored[name]) === encode(field.type === 'many2many' && Array.isArray(value) && Array.isArray(value[0]) ? (value[0] as [number, number, number[]])[2] : value)) continue;
        if (companyFields.has(name)) { companyVals[name] = value && typeof value === 'object' && 'id' in (value as object) ? (value as { id: number }).id : value; continue; }
        params.push([`${PREFIX}${name}`, encode(field.type === 'many2many' && Array.isArray(value) && Array.isArray(value[0]) ? (value[0] as [number, number, number[]])[2] : value)]);
      }
      if (Object.keys(companyVals).length) await env.sudo().model('res.company').write(env.companyId, companyVals);
      for (const [key, value] of params) await setParameter(env.cr, key, value);
      // Transient row: only store plain columns.
      for (const name of Object.keys(out)) if (settings.fields[name]?.type === 'many2many' || settings.fields[name]?.type === 'one2many') delete out[name];
      return out;
    },
    methods: {
      execute: async () => ({ type: 'ir.actions.client', tag: 'reload' }),
      cancel: async () => ({ type: 'ir.actions.client', tag: 'reload' }),
      action_open_base_onboarding_company: async () => ({ type: 'ir.actions.act_window', res_model: 'res.company', view_mode: 'form', target: 'current', name: { en: 'Company', ar: 'الشركة' } }),
    },
  });
}
