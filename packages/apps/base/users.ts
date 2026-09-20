import { registerModelHooks, type Values } from '../../engine/orm/hooks.js';
import type { Environment } from '../../engine/orm/env.js';
import { UserError, ValidationError } from '../../engine/orm/errors.js';
import { m2oId } from './index.js';

/**
 * Settings › Users (D-16): a user is a partner plus a login. Creating one
 * creates its partner, mirrors name/email both ways, applies the default
 * "User" role group and — when an identity provider is plugged in (Cognito
 * on AWS) — provisions the account and sends the invitation email.
 */

export interface IdentityProvider {
  /** Create the account and send the invitation; resolve to the provider's user id. */
  invite(email: string, name: string, options: { resend?: boolean }): Promise<string | null>;
  /** Enable / disable sign-in. */
  setEnabled(email: string, enabled: boolean): Promise<void>;
  /** Set a permanent password (local admin resets). */
  setPassword?(email: string, password: string): Promise<void>;
}

let provider: IdentityProvider | null = null;

export function setIdentityProvider(next: IdentityProvider | null): void {
  provider = next;
}

export function getIdentityProvider(): IdentityProvider | null {
  return provider;
}

const DEFAULT_GROUP_NAMES = ['Role / User', 'Default access for new users', 'Receive notifications in Odoo'];

async function defaultGroupIds(env: Environment): Promise<number[]> {
  if (!env.registry.models['res.groups']) return [];
  const rows = await env.cr.query<{ id: number }>(`SELECT id FROM res_groups WHERE name = ANY($1)`, [DEFAULT_GROUP_NAMES]);
  return rows.rows.map((row) => Number(row.id));
}

function normaliseLogin(login: unknown): string {
  return String(login ?? '').trim().toLowerCase();
}

async function hashPassword(password: string): Promise<string> {
  const { scryptSync, randomBytes } = await import('node:crypto');
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
}

function isEmail(text: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
}

export function registerUsers(): void {
  registerModelHooks('res.users', {
    displayName: (_env, record) => String(record.name || record.login || record.id),
    searchFields: ['login', 'email'],
    defaults: async (env) => ({
      lang: env.lang,
      tz: env.tz || 'Asia/Riyadh',
      notification_type: 'email',
      outgoing_mail_server_type: 'default',
      odoobot_state: 'disabled',
      share: false,
      active: true,
      state: 'new',
      role: 'group_user',
      color_scheme: 'light',
      company_id: env.companyId,
      company_ids: [[6, 0, [env.companyId]]],
      group_ids: [[6, 0, await defaultGroupIds(env)]],
    }),
    onchange: {
      login: async (_env, values) => {
        const login = normaliseLogin(values.login);
        return login && !values.email ? { value: { email: login } } : {};
      },
      role: async (env, values) => {
        // Administrator role adds the "Role / Administrator" group; User removes it.
        const admin = await env.cr.query<{ id: number }>(`SELECT id FROM res_groups WHERE name = 'Role / Administrator' LIMIT 1`);
        const adminId = admin.rows[0] ? Number(admin.rows[0].id) : null;
        if (!adminId) return {};
        const current = Array.isArray(values.group_ids) ? (values.group_ids as unknown[]).map((item) => (typeof item === 'number' ? item : m2oId(item))).filter((id): id is number => typeof id === 'number') : [];
        const next = values.role === 'group_system' ? [...new Set([...current, adminId])] : current.filter((id) => id !== adminId);
        return { value: { group_ids: [[6, 0, next]] } };
      },
    },
    beforeCreate: async (env, vals) => {
      const out: Values = { ...vals };
      const login = normaliseLogin(out.login);
      if (!login) throw new ValidationError({ en: 'A login is required.', ar: 'اسم الدخول مطلوب.' });
      out.login = login;
      const existing = await env.cr.query<{ id: number }>(`SELECT id FROM res_users WHERE lower(login) = $1`, [login]);
      if (existing.rows.length) throw new ValidationError({ en: 'You can not have two users with the same login!', ar: 'لا يمكن أن يكون هناك مستخدمان بنفس اسم الدخول!' });
      if (!out.email && isEmail(login)) out.email = login;
      const name = String(out.name ?? '').trim();
      if (!name) throw new ValidationError({ en: 'A name is required.', ar: 'الاسم مطلوب.' });
      if (!m2oId(out.partner_id)) {
        const partnerVals: Values = { name, email: out.email ?? false, type: 'contact', is_company: false, lang: out.lang ?? env.lang, tz: out.tz ?? 'Asia/Riyadh', active: true };
        if (out.phone) partnerVals.phone = out.phone;
        if (out.image_1920) partnerVals.image_1920 = out.image_1920;
        const partnerFields = env.registry.models['res.partner'].fields;
        for (const key of Object.keys(partnerVals)) if (!partnerFields[key]) delete partnerVals[key];
        if (partnerFields.company_id) partnerVals.company_id = false;
        out.partner_id = await env.sudo().model('res.partner').create(partnerVals);
      }
      // name/email/phone are stored on both rows so list views and the login join agree.
      if (out.state === undefined) out.state = 'new';
      const plain = String(out.new_password || out.password || '');
      delete out.new_password;
      out.password = plain ? await hashPassword(plain) : false;
      return out;
    },
    beforeWrite: async (env, ids, vals) => {
      const out: Values = { ...vals };
      if ('login' in out) {
        const login = normaliseLogin(out.login);
        if (!login) throw new ValidationError({ en: 'A login is required.', ar: 'اسم الدخول مطلوب.' });
        const dup = await env.cr.query<{ id: number }>(`SELECT id FROM res_users WHERE lower(login) = $1 AND NOT (id = ANY($2))`, [login, ids]);
        if (dup.rows.length) throw new ValidationError({ en: 'You can not have two users with the same login!', ar: 'لا يمكن أن يكون هناك مستخدمان بنفس اسم الدخول!' });
        out.login = login;
      }
      // Mirror partner values.
      const partnerVals: Values = {};
      for (const key of ['name', 'email', 'phone', 'image_1920']) if (key in out && env.registry.models['res.partner'].fields[key]) partnerVals[key] = out[key];
      if (Object.keys(partnerVals).length) {
        const rows = await env.cr.query<{ partner_id: number | null }>(`SELECT partner_id FROM res_users WHERE id = ANY($1)`, [ids]);
        const partnerIds = rows.rows.map((row) => row.partner_id).filter((id): id is number => id != null).map(Number);
        if (partnerIds.length) await env.sudo().model('res.partner').write(partnerIds, partnerVals);
      }
      if ('new_password' in out) {
        const password = String(out.new_password ?? '');
        delete out.new_password;
        if (password) {
          out.password = await hashPassword(password);
          if (provider?.setPassword) {
            const logins = await env.cr.query<{ login: string }>(`SELECT login FROM res_users WHERE id = ANY($1)`, [ids]);
            for (const row of logins.rows) await provider.setPassword(row.login, password);
          }
        }
      }
      if ('active' in out && provider) {
        const logins = await env.cr.query<{ login: string }>(`SELECT login FROM res_users WHERE id = ANY($1)`, [ids]);
        for (const row of logins.rows) {
          try { await provider.setEnabled(row.login, Boolean(out.active)); } catch { /* not provisioned yet */ }
        }
      }
      return out;
    },
    onCreate: async (env, ids) => {
      if (!provider) return;
      const rows = await env.cr.query<{ id: number; login: string; name: string | null }>(`SELECT u.id, u.login, p.name FROM res_users u LEFT JOIN res_partner p ON p.id = u.partner_id WHERE u.id = ANY($1)`, [ids]);
      for (const row of rows.rows) {
        const login = String(row.login ?? '');
        if (!isEmail(login)) continue;
        try {
          const sub = await provider.invite(login, row.name ?? login, {});
          if (sub && env.registry.models['res.users'].fields.cognito_sub) await env.cr.query(`UPDATE res_users SET cognito_sub = $2 WHERE id = $1`, [row.id, sub]);
        } catch (error) {
          throw new UserError({ en: `The account could not be created in the identity provider: ${(error as Error).message}`, ar: `تعذر إنشاء الحساب في مزود الهوية: ${(error as Error).message}` });
        }
      }
    },
    onUnlink: async (env, ids) => {
      if (ids.includes(env.uid)) throw new UserError({ en: 'You cannot delete the user you are currently logged in as.', ar: 'لا يمكنك حذف المستخدم الذي سجلت الدخول به حالياً.' });
      if (ids.includes(1) || ids.includes(2)) throw new UserError({ en: 'You cannot delete the administrator user.', ar: 'لا يمكنك حذف المستخدم المدير.' });
      if (provider) {
        const logins = await env.cr.query<{ login: string }>(`SELECT login FROM res_users WHERE id = ANY($1)`, [ids]);
        for (const row of logins.rows) { try { await provider.setEnabled(row.login, false); } catch { /* ignore */ } }
      }
    },
    computes: [{
      fields: ['companies_count', 'active_partner'],
      depends: ['company_ids', 'partner_id', 'active'],
      compute: async (env, ids) => {
        const companies = env.registry.models['res.users'].fields.company_ids;
        const counts = companies?.m2mTable
          ? await env.cr.query<{ id: number; n: number }>(`SELECT "${companies.m2mColumn1}" AS id, count(*)::int AS n FROM "${companies.m2mTable}" WHERE "${companies.m2mColumn1}" = ANY($1) GROUP BY 1`, [ids])
          : { rows: [] as { id: number; n: number }[] };
        const partners = await env.cr.query<{ id: number; active: boolean | null }>(`SELECT u.id, p.active FROM res_users u LEFT JOIN res_partner p ON p.id = u.partner_id WHERE u.id = ANY($1)`, [ids]);
        const out: Record<number, Values> = {};
        for (const id of ids) out[id] = { companies_count: counts.rows.find((row) => Number(row.id) === id)?.n ?? 0, active_partner: partners.rows.find((row) => Number(row.id) === id)?.active ?? true };
        return out;
      },
    }],
    methods: {
      /** "Send an Invitation Email" (state = new): (re)send through the identity provider. */
      action_reset_password: async (env, ids) => {
        const rows = await env.cr.query<{ id: number; login: string; name: string | null }>(`SELECT u.id, u.login, p.name FROM res_users u LEFT JOIN res_partner p ON p.id = u.partner_id WHERE u.id = ANY($1)`, [ids]);
        if (!provider) {
          throw new UserError({
            en: 'No identity provider is configured: the user signs in with the password set on this form (Preferences › Change password) or with the first password they type.',
            ar: 'لم يتم إعداد مزود هوية: يسجل المستخدم الدخول بكلمة المرور المحددة في هذا النموذج أو بأول كلمة مرور يكتبها.',
          });
        }
        for (const row of rows.rows) {
          if (!isEmail(row.login)) throw new UserError({ en: `"${row.login}" is not an email address.`, ar: `"${row.login}" ليس عنوان بريد إلكتروني.` });
          const sub = await provider.invite(row.login, row.name ?? row.login, { resend: true });
          if (sub && env.registry.models['res.users'].fields.cognito_sub) await env.cr.query(`UPDATE res_users SET cognito_sub = $2 WHERE id = $1`, [row.id, sub]);
        }
        return {
          type: 'ir.actions.client', tag: 'display_notification',
          params: { type: 'success', message: { en: `Invitation sent to ${rows.rows.map((row) => row.login).join(', ')}.`, ar: `تم إرسال الدعوة إلى ${rows.rows.map((row) => row.login).join('، ')}.` } },
        };
      },
      action_related_contact: async (env, ids) => {
        const row = await env.cr.query<{ partner_id: number | null }>(`SELECT partner_id FROM res_users WHERE id = $1`, [ids[0]]);
        const partnerId = row.rows[0]?.partner_id;
        if (!partnerId) throw new UserError({ en: 'This user has no contact.', ar: 'لا توجد جهة اتصال لهذا المستخدم.' });
        return { type: 'ir.actions.act_window', res_model: 'res.partner', res_id: Number(partnerId), view_mode: 'form', target: 'current', name: { en: 'Contact', ar: 'جهة الاتصال' } };
      },
      action_create_employee: async () => {
        throw new UserError({ en: 'Employees are created from the Employees app.', ar: 'يتم إنشاء الموظفين من تطبيق الموظفين.' });
      },
      action_show_groups: async () => undefined,
      action_show_accesses: async () => undefined,
      action_open_employees: async () => undefined,
      preference_save: async () => ({ type: 'ir.actions.client', tag: 'reload' }),
      preference_change_password: async () => ({ type: 'ir.actions.act_window', res_model: 'res.users', view_mode: 'form', target: 'new', name: { en: 'Change Password', ar: 'تغيير كلمة المرور' } }),
    },
  });
}
