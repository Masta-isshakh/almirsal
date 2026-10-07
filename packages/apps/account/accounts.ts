import type { Registry } from '../../engine/registry/types.js';
import type { Environment } from '../../engine/orm/env.js';
import { registerModelHooks, type Values } from '../../engine/orm/hooks.js';
import { UserError, ValidationError } from '../../engine/orm/errors.js';

/** Company ids in the many2many commands used by account create/copy. */
function companyIds(values: unknown): number[] {
  const ids = new Set<number>();
  if (!Array.isArray(values)) return [];
  for (const command of values) {
    if (typeof command === 'number') { ids.add(command); continue; }
    if (!Array.isArray(command)) continue;
    if (command[0] === 6) {
      ids.clear();
      for (const id of Array.isArray(command[2]) ? command[2] : []) ids.add(Number(id));
    } else if (command[0] === 4) ids.add(Number(command[1]));
    else if (command[0] === 2 || command[0] === 3) ids.delete(Number(command[1]));
    else if (command[0] === 5) ids.clear();
  }
  return [...ids].filter((id) => Number.isInteger(id) && id > 0);
}

/** Continue this account type's numbering, including archived accounts. */
async function nextCode(env: Environment, type: string, companies: number[]): Promise<string> {
  const result = await env.cr.query<{ code: string; account_type: string }>(
    `SELECT a.code, a.account_type FROM account_account a
     WHERE coalesce(a.code, '') <> '' AND (
       EXISTS (SELECT 1 FROM account_account_company_ids_rel c WHERE c.account_account_id = a.id AND c.res_company_id = ANY($1))
       OR NOT EXISTS (SELECT 1 FROM account_account_company_ids_rel c WHERE c.account_account_id = a.id)
     )`, [companies],
  );
  const used = new Set(result.rows.map((row) => row.code));
  const numbered = result.rows.filter((row) => row.account_type === type).flatMap((row) => {
    const match = row.code.match(/^(.*?)(\d+)$/);
    return match ? [{ prefix: match[1], digits: match[2], value: BigInt(match[2]) }] : [];
  });
  const numeric = numbered.filter((code) => code.prefix === '');
  const candidates = numeric.length ? numeric : numbered;
  candidates.sort((left, right) => left.value < right.value ? 1 : left.value > right.value ? -1 : left.prefix.localeCompare(right.prefix));
  const last = candidates[0];
  const group = type.split('_')[0];
  const base: Record<string, bigint> = { asset: 100000n, liability: 200000n, equity: 300000n, income: 400000n, expense: 500000n, off: 900000n };
  let number = last ? last.value + 1n : base[group] ?? 100000n;
  const prefix = last?.prefix ?? '';
  const width = last?.digits.length ?? 6;
  let code = `${prefix}${number.toString().padStart(width, '0')}`;
  while (used.has(code)) {
    number += 1n;
    code = `${prefix}${number.toString().padStart(width, '0')}`;
  }
  return code;
}

/** The generic list actions must preserve the accounts and amounts in the books. */
export function registerAccountAccounts(registry: Registry): void {
  if (!registry.models['account.account']) return;
  registerModelHooks('account.account', {
    // Copy account settings; an opening balance belongs to the original ledger.
    // Active comes from the create default, so an archived source gives an active copy.
    noCopy: ['code', 'active', 'opening_debit', 'opening_credit', 'opening_balance', 'current_balance', 'used', 'parent_path'],
    beforeCreate: async (env, values) => {
      // Allocate and validate codes in the same transaction. Account setup is
      // infrequent; this also handles accounts shared between companies.
      await env.cr.query('LOCK TABLE account_account IN SHARE ROW EXCLUSIVE MODE');
      const vals: Values = { ...values };
      const companies = companyIds(vals.company_ids);
      // Captured seed accounts can have no company relation. A new account must have one.
      if (!companies.length) { companies.push(env.companyId); vals.company_ids = [[6, 0, companies]]; }
      vals.code = String(vals.code || '').trim() || await nextCode(env, String(vals.account_type || 'asset_current'), companies);
      return vals;
    },
    beforeWrite: async (env, _ids, values) => {
      if ('code' in values || 'company_ids' in values) await env.cr.query('LOCK TABLE account_account IN SHARE ROW EXCLUSIVE MODE');
      return 'code' in values ? { ...values, code: String(values.code || '').trim() } : values;
    },
    constraints: [async (env, ids) => {
      const conflict = await env.cr.query<{ code: string }>(
        `SELECT a.code FROM account_account a JOIN account_account other ON other.id <> a.id AND other.code = a.code
         WHERE a.id = ANY($1) AND coalesce(a.code, '') <> '' AND (
           EXISTS (SELECT 1 FROM account_account_company_ids_rel ac
                   JOIN account_account_company_ids_rel oc ON oc.res_company_id = ac.res_company_id
                   WHERE ac.account_account_id = a.id AND oc.account_account_id = other.id)
           OR NOT EXISTS (SELECT 1 FROM account_account_company_ids_rel c WHERE c.account_account_id = a.id)
           OR NOT EXISTS (SELECT 1 FROM account_account_company_ids_rel c WHERE c.account_account_id = other.id)
         ) LIMIT 1`, [ids],
      );
      if (conflict.rows[0]) throw new ValidationError({
        en: `Account code ${conflict.rows[0].code} is already used in one of this account's companies. Choose a different code.`,
        ar: `رمز الحساب ${conflict.rows[0].code} مستخدم بالفعل في إحدى شركات هذا الحساب. اختر رمزاً آخر.`,
      });
    }],
    onUnlink: async (env, ids) => {
      // Lock first: a concurrent journal-item insert must not commit between
      // the history check and deletion of an optional foreign-key target.
      await env.cr.query('SELECT id FROM account_account WHERE id = ANY($1) ORDER BY id FOR UPDATE', [ids]);
      const used = await env.cr.query<{ code: string; name: string }>(
        `SELECT a.code, a.name FROM account_account a WHERE a.id = ANY($1)
         AND EXISTS (SELECT 1 FROM account_move_line l WHERE l.account_id = a.id) LIMIT 1`, [ids],
      );
      if (used.rows[0]) throw new UserError({
        en: `You cannot delete account ${used.rows[0].code} ${used.rows[0].name} because it has journal items. Archive it to keep its accounting history.`,
        ar: `لا يمكنك حذف الحساب ${used.rows[0].code} ${used.rows[0].name} لوجود بنود يومية مرتبطة به. أرشفه للاحتفاظ بسجله المحاسبي.`,
      });
    },
  });
}
