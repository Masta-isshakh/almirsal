import { registerModelHooks } from '../../engine/orm/hooks.js';
import type { Environment } from '../../engine/orm/env.js';
import { AccessError, UserError } from '../../engine/orm/errors.js';
import { floatRound } from '../../engine/format/index.js';
import { notify } from '../common.js';

type Item = { id: number; move_id: number; account_id: number; company_id: number; currency_id: number | null; partner_id: number | null; state: string; reconcile: boolean; rounding: number; balance: number; residual: number; date: string };

/** Residuals come from actual matched amounts, including partial payments. */
async function items(env: Environment, ids: number[]): Promise<Item[]> {
  if (!ids.length) return [];
  return (await env.cr.query<Item>(
    `SELECT l.id, l.move_id, l.account_id, m.company_id, m.currency_id, l.partner_id, m.state,
      coalesce(a.reconcile, false) AS reconcile, coalesce(c.rounding, .01)::float8 AS rounding,
      (coalesce(l.debit, 0)-coalesce(l.credit, 0))::float8 AS balance,
      (coalesce(l.debit, 0)-coalesce(l.credit, 0)
        -coalesce((SELECT sum(p.amount) FROM account_partial_reconcile p WHERE p.debit_move_id=l.id), 0)
        +coalesce((SELECT sum(p.amount) FROM account_partial_reconcile p WHERE p.credit_move_id=l.id), 0))::float8 AS residual,
      l.date::text AS date
     FROM account_move_line l JOIN account_move m ON m.id=l.move_id
     LEFT JOIN account_account a ON a.id=l.account_id LEFT JOIN res_currency c ON c.id=m.currency_id
     WHERE l.id=ANY($1) ORDER BY l.date, l.id`, [ids])).rows;
}

async function connected(env: Environment, ids: number[]): Promise<number[]> {
  if (!ids.length) return [];
  return (await env.cr.query<{ id: number }>(
    `WITH RECURSIVE linked(id) AS (
      SELECT unnest($1::integer[])
      UNION
      SELECT CASE WHEN p.debit_move_id=l.id THEN p.credit_move_id ELSE p.debit_move_id END
      FROM linked l JOIN account_partial_reconcile p ON p.debit_move_id=l.id OR p.credit_move_id=l.id
    ) SELECT id FROM linked ORDER BY id`, [ids])).rows.map(r => Number(r.id));
}

/** Keep the invoice/payment smart buttons consistent with the matching records. */
async function refresh(env: Environment, ids: number[]): Promise<void> {
  const rows = await items(env, ids);
  for (const row of rows) {
    const residual = floatRound(row.residual, row.rounding);
    await env.cr.query(`UPDATE account_move_line SET amount_residual=$2, reconciled=$3,
      matching_number=CASE WHEN full_reconcile_id IS NOT NULL THEN (SELECT name FROM account_full_reconcile WHERE id=full_reconcile_id)
        WHEN EXISTS (SELECT 1 FROM account_partial_reconcile p WHERE p.debit_move_id=$1 OR p.credit_move_id=$1) THEN 'P' ELSE NULL END WHERE id=$1`,
    [row.id, residual, Math.abs(residual) < row.rounding / 2]);
  }
  const moveIds = [...new Set(rows.map(r => Number(r.move_id)))];
  if (!moveIds.length) return;
  const relation = env.registry.models['account.payment'].fields.reconciled_invoice_ids;
  const payments = (await env.cr.query<{ id: number }>(`SELECT id FROM account_payment WHERE move_id=ANY($1)
    OR id IN (SELECT r."${relation.m2mColumn1}" FROM "${relation.m2mTable}" r WHERE r."${relation.m2mColumn2}"=ANY($1))`, [moveIds])).rows.map(r => Number(r.id));
  if (payments.length) {
    await env.cr.query(`DELETE FROM "${relation.m2mTable}" WHERE "${relation.m2mColumn1}"=ANY($1)`, [payments]);
    await env.cr.query(`INSERT INTO "${relation.m2mTable}" ("${relation.m2mColumn1}", "${relation.m2mColumn2}")
      SELECT DISTINCT pay.id, m.id FROM account_payment pay JOIN account_move_line pl ON pl.move_id=pay.move_id
      JOIN account_partial_reconcile p ON p.debit_move_id=pl.id OR p.credit_move_id=pl.id
      JOIN account_move_line il ON il.id=CASE WHEN p.debit_move_id=pl.id THEN p.credit_move_id ELSE p.debit_move_id END
      JOIN account_move m ON m.id=il.move_id WHERE pay.id=ANY($1) AND m.move_type<>'entry' ON CONFLICT DO NOTHING`, [payments]);
    await env.cr.query(`UPDATE account_payment pay SET is_reconciled=NOT EXISTS (
      SELECT 1 FROM account_move_line l JOIN account_account a ON a.id=l.account_id
      WHERE l.move_id=pay.move_id AND a.account_type IN ('asset_receivable','liability_payable') AND abs(coalesce(l.amount_residual,l.debit-l.credit))>.005)
      WHERE pay.id=ANY($1)`, [payments]);
  }
  await env.model('account.move').recompute(moveIds, ['line_ids'], false);
}

export async function reconcileItems(env: Environment, ids: number[]): Promise<void> {
  ids = [...new Set(ids)].sort((a,b) => a-b);
  const accessible=await env.model('account.move.line').read(ids, ['id']);
  if (accessible.length!==ids.length) throw new AccessError({ en: 'Some selected journal items are not accessible.', ar: 'بعض عناصر اليومية المحددة غير متاحة.' });
  await env.cr.query(`SELECT id FROM account_move_line WHERE id=ANY($1) ORDER BY id FOR UPDATE`, [ids]);
  const rows = await items(env, ids);
  if (rows.length < 2) throw new UserError({ en: 'Select matching debit and credit items.', ar: 'اختر بنود مدين ودائن متطابقة.' });
  const first = rows[0];
  if (rows.some(r => r.state !== 'posted')) throw new UserError({ en: 'Only posted journal items can be reconciled.', ar: 'يمكن تسوية عناصر اليومية المرحّلة فقط.' });
  if (!first.reconcile || rows.some(r => r.account_id !== first.account_id || r.company_id !== first.company_id)) {
    throw new UserError({ en: 'Select items on the same reconcilable account and company.', ar: 'اختر بنوداً في نفس الحساب القابل للتسوية والشركة.' });
  }
  if (rows.some(r => r.currency_id !== first.currency_id)) throw new UserError({ en: 'Select items in the same currency.', ar: 'اختر بنوداً بنفس العملة.' });
  if (new Set(rows.filter(r => r.partner_id).map(r => r.partner_id)).size > 1) throw new UserError({ en: 'The selected items belong to different partners.', ar: 'البنود المحددة تخص شركاء مختلفين.' });
  const debits = rows.filter(r => r.residual >= r.rounding / 2);
  const credits = rows.filter(r => r.residual <= -r.rounding / 2);
  if (!debits.length || !credits.length) throw new UserError({ en: 'No unmatched debit and credit remain.', ar: 'لا توجد مبالغ مدين ودائن متبقية للمطابقة.' });
  for (const debit of debits) {
    for (const credit of credits) {
      const amount = floatRound(Math.min(debit.residual, -credit.residual), first.rounding);
      if (amount < first.rounding / 2) continue;
      await env.model('account.partial.reconcile').create({ debit_move_id: debit.id, credit_move_id: credit.id, amount,
        debit_amount_currency: amount, credit_amount_currency: amount, company_id: first.company_id,
        company_currency_id: first.currency_id || false, max_date: debit.date > credit.date ? debit.date : credit.date });
      debit.residual = floatRound(debit.residual-amount, first.rounding);
      credit.residual = floatRound(credit.residual+amount, first.rounding);
    }
  }
  const linked = await connected(env, ids);
  const after = await items(env, linked);
  if (after.every(r => Math.abs(r.residual) < r.rounding / 2)) {
    const full = await env.model('account.full.reconcile').create({ name: '/' });
    await env.model('account.full.reconcile').write(full, { name: `A${full}` });
    await env.cr.query(`UPDATE account_move_line SET full_reconcile_id=$2 WHERE id=ANY($1)`, [linked, full]);
    await env.cr.query(`UPDATE account_partial_reconcile SET full_reconcile_id=$2 WHERE debit_move_id=ANY($1) OR credit_move_id=ANY($1)`, [linked, full]);
  }
  await refresh(env, linked);
}

export async function removeMatches(env: Environment, ids: number[]): Promise<void> {
  const partials = await env.model('account.partial.reconcile').search([ '|', ['debit_move_id','in',ids], ['credit_move_id','in',ids] ]);
  if (partials.length) await env.model('account.partial.reconcile').unlink(partials);
}

export function registerReconciliation(): void {
  registerModelHooks('account.move.line', {
    noCopy: ['matched_debit_ids','matched_credit_ids','full_reconcile_id','matching_number','reconciled'],
    computes: [{ fields: ['amount_residual'], depends: ['debit','credit','balance'], compute: async (env, ids) =>
      Object.fromEntries((await items(env, ids)).map(r => [r.id, { amount_residual: floatRound(r.residual, r.rounding) }])) }],
    methods: {
      action_reconcile: async (env, ids) => { await reconcileItems(env, ids); return notify({ en: 'Journal items reconciled.', ar: 'تمت تسوية عناصر اليومية.' }); },
      remove_move_reconcile: async (env, ids) => { await removeMatches(env, ids); },
      action_unreconcile: async (env, ids) => { await removeMatches(env, ids); },
    },
  });
  registerModelHooks('account.partial.reconcile', {
    onUnlink: async (env, ids) => {
      const parts = await env.model('account.partial.reconcile').read(ids, ['debit_move_id','credit_move_id','full_reconcile_id']);
      const endpoints = parts.flatMap(p => ['debit_move_id','credit_move_id'].map(f => Number((p[f] as [number,string])[0])));
      const linked = await connected(env, endpoints);
      await env.cr.query(`SELECT id FROM account_move_line WHERE id=ANY($1) ORDER BY id FOR UPDATE`, [linked]);
      const fullIds = [...new Set(parts.map(p => Array.isArray(p.full_reconcile_id) ? Number(p.full_reconcile_id[0]) : 0).filter(Boolean))];
      await env.cr.query(`DELETE FROM account_partial_reconcile WHERE id=ANY($1)`, [ids]);
      if (fullIds.length) {
        await env.cr.query(`UPDATE account_move_line SET full_reconcile_id=NULL WHERE full_reconcile_id=ANY($1)`, [fullIds]);
        await env.cr.query(`UPDATE account_partial_reconcile SET full_reconcile_id=NULL WHERE full_reconcile_id=ANY($1)`, [fullIds]);
        await env.model('account.full.reconcile').unlink(fullIds);
      }
      await refresh(env, linked);
    },
  });
}
