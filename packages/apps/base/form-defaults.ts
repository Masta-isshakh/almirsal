import { registerModelHooks } from '../../engine/orm/hooks.js';
import type { Environment } from '../../engine/orm/env.js';

/**
 * Defaults for required fields a form cannot fill.
 *
 * Odoo gives these fields a default in the model, so pressing New and Save
 * works on a fresh record. The export carries the fields and their required
 * flag but not the Python defaults, which left several forms refusing to
 * save with a message about a field sitting behind a tab or not shown at
 * all ("Communication Type", "Code", "Power Unit"…). `scripts/dev/defaults-check.mts`
 * lists what is still missing; fields a person can see and type into are
 * deliberately left to them.
 */

/** The first id of a model, for the links Odoo fills from the company setup. */
async function firstId(env: Environment, model: string, order = 'id'): Promise<number | undefined> {
  if (!env.registry.models[model]) return undefined;
  const rows = await env.model(model).search([], { limit: 1, order }).catch(() => [] as number[]);
  return rows[0];
}

export function registerFormDefaults(): void {
  // Accounting
  registerModelHooks('account.account', {
    defaults: async (env) => ({ account_type: 'asset_current', company_ids: [[6, 0, [env.companyId]]] }),
  });
  registerModelHooks('account.journal', {
    defaults: () => ({ invoice_reference_type: 'invoice', invoice_reference_model: 'odoo' }),
  });

  // Fleet: units of measure for power and distance.
  registerModelHooks('fleet.vehicle', { defaults: () => ({ power_unit: 'power', range_unit: 'km' }) });
  registerModelHooks('fleet.vehicle.model', { defaults: () => ({ power_unit: 'power', range_unit: 'km' }) });

  // Mail and payments
  registerModelHooks('ir.mail_server', { defaults: () => ({ smtp_encryption: 'none', smtp_authentication: 'login' }) });
  registerModelHooks('mail.activity.type', { defaults: () => ({ delay_unit: 'days', delay_count: 0, delay_from: 'current_date' }) });
  // Odoo's `_compute_is_editable`: a response being created is editable (saved
  // ones are, for their author and administrators — SQL in extra-models).
  registerModelHooks('mail.canned.response', { defaults: () => ({ is_editable: true }) });
  registerModelHooks('product.attribute', { defaults: () => ({ display_type: 'radio', create_variant: 'always' }) });
  registerModelHooks('payment.provider', { defaults: () => ({ code: 'none' }) });
  registerModelHooks('payment.method', {
    defaults: () => ({ support_manual_capture: 'none', support_refund: 'none' }),
    // Odoo derives a payment method's technical code from its name.
    beforeCreate: (_env, vals) => (vals.code ? vals : {
      ...vals,
      code: String(vals.name ?? 'method').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40) || 'method',
    }),
  });
  registerModelHooks('calendar.alarm', {
    defaults: () => ({ name: 'Reminder', alarm_type: 'notification', duration: 30, interval: 'minutes' }),
  });

  // Projects: Odoo creates the mail alias and answers to followers. The alias
  // is a record, not a value, so a new project makes one for its tasks.
  registerModelHooks('project.project', {
    defaults: () => ({ alias_contact: 'followers' }),
    beforeCreate: async (env, vals) => {
      if (vals.alias_id || !env.registry.models['mail.alias']) return vals;
      const model = await env.model('ir.model').search([['model', '=', 'project.task']], { limit: 1 }).catch(() => [] as number[]);
      const alias = await env.sudo().model('mail.alias').create({
        alias_name: String(vals.name ?? 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'project',
        alias_model_id: model[0],
        alias_contact: String(vals.alias_contact ?? 'followers'),
      }).catch(() => null);
      return alias ? { ...vals, alias_id: alias } : vals;
    },
  });

  // An appointment resource is backed by a resource record, as in Odoo.
  registerModelHooks('appointment.resource', {
    defaults: () => ({ capacity: 1, sequence: 10 }),
    beforeCreate: async (env, vals) => {
      if (vals.resource_id || !env.registry.models['resource.resource']) return vals;
      const resource = await env.sudo().model('resource.resource').create({
        name: String(vals.name ?? 'Resource'), tz: env.tz, resource_type: 'material', time_efficiency: 100,
      }).catch(() => null);
      return resource ? { ...vals, resource_id: resource } : vals;
    },
  });

  // Signatures
  registerModelHooks('sign.item.type', { defaults: () => ({ field_size: 'short_text' }) });

  // Appointments: a leave ends an hour after it starts; a resource line points
  // at the resource it was opened from.
  registerModelHooks('appointment.leave', {
    defaults: () => {
      const end = new Date(Date.now() + 3_600_000);
      return { date_to: end.toISOString().slice(0, 19).replace('T', ' ') };
    },
  });

  // Gamification challenges print with the default report template.
  registerModelHooks('gamification.challenge', {
    defaults: async (env) => ({ report_template_id: await firstId(env, 'mail.template') }),
  });
}
