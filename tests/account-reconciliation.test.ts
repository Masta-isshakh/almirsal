import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgliteDatabase } from '../packages/engine/db/pglite.js';
import type { Database } from '../packages/engine/db/types.js';
import { syncSchema } from '../packages/engine/schema/ddl.js';
import { loadSeed } from '../packages/engine/seed/load.js';
import { testRegistry } from '../packages/engine/testing/registry.js';
import { Environment } from '../packages/engine/orm/env.js';
import { clearModelHooks } from '../packages/engine/orm/hooks.js';
import { registerApps } from '../packages/apps/index.js';

const registry = testRegistry();
let db: Database;
let env: Environment;
let customer: number;
let receivable: number;
let income: number;
let expense: number;
beforeAll(async () => {
  clearModelHooks(); registerApps(registry);
  db = pgliteDatabase(); await syncSchema(db, registry); await loadSeed(db, registry);
  env = new Environment({ registry, db, uid: 2, companyIds: [1] });
  customer = await env.model('res.partner').create({ name: 'Matching customer' });
  [receivable] = await env.model('account.account').search([['account_type','=','asset_receivable']]);
  [income] = await env.model('account.account').search([['account_type','=','income']]);
  [expense] = await env.model('account.account').search([['account_type','=','expense']]);
  await env.model('account.account').write(receivable,{ reconcile: true });
},240_000);
afterAll(async () => { await db.close?.(); });

async function invoice(amount: number, partner=customer): Promise<number> {
  const id = await env.model('account.move').create({ move_type: 'out_invoice',partner_id: partner,
    invoice_line_ids: [[0,0,{ name: 'Service',quantity: 1,price_unit: amount,tax_ids: [[6,0,[]]] }]] });
  await env.model('account.move').callButton(id,'action_post'); return id;
}
async function payment(amount: number, partner=customer, type='inbound'): Promise<number> {
  const id = await env.model('account.payment').create({ partner_id: partner,amount,payment_type: type });
  await env.model('account.payment').callButton(id,'action_post'); return id;
}
async function register(ids: number[], values: Record<string,unknown>={}): Promise<void> {
  const model = env.with({ context: { active_ids: ids,active_model: 'account.move' } }).model('account.payment.register');
  const id = await model.create(values); await model.callButton(id,'action_create_payments');
}
async function journalItem(amount: number, account=receivable, draft=false): Promise<number> {
  const id = await env.model('account.move').create({ move_type: 'entry',partner_id: customer,
    line_ids: [[0,0,{ name: 'Match',account_id: account,partner_id: customer,debit: Math.max(amount,0),credit: Math.max(-amount,0) }],
      [0,0,{ name: 'Offset',account_id: income,debit: Math.max(-amount,0),credit: Math.max(amount,0) }]] });
  if (!draft) await env.model('account.move').callButton(id,'action_post');
  return (await env.model('account.move.line').search([['move_id','=',id],['account_id','=',account]]))[0];
}

describe('accounting matching and payment allocation', () => {
  it('partially matches unequal posted items and creates a full matching record when completed', async () => {
    const debit = await journalItem(100); const first = await journalItem(-40); const second = await journalItem(-60);
    await env.model('account.move.line').callButton([debit,first],'action_reconcile');
    expect((await env.model('account.move.line').read(debit,['amount_residual','matching_number','reconciled']))[0]).toMatchObject({ amount_residual: 60,matching_number: 'P',reconciled: false });
    await env.model('account.move.line').callButton([debit,second],'action_reconcile');
    const rows = await env.model('account.move.line').read([debit,first,second],['amount_residual','matching_number','full_reconcile_id','reconciled']);
    expect(rows.every(r => r.amount_residual===0 && r.reconciled && /^A\d+$/.test(String(r.matching_number)))).toBe(true);
    expect(new Set(rows.map(r => (r.full_reconcile_id as [number,string])[0])).size).toBe(1);
    await env.model('account.move.line').callButton(first,'action_unreconcile');
    expect((await env.model('account.move.line').read(debit,['amount_residual','matching_number','full_reconcile_id']))[0]).toMatchObject({ amount_residual: 40,matching_number: 'P',full_reconcile_id: false });
  });
  it('rejects draft items and balancing different accounts without changing matching records', async () => {
    const debit = await journalItem(30); const draft = await journalItem(-30,receivable,true); const wrong = await journalItem(-30,expense);
    const count = await env.model('account.partial.reconcile').searchCount([]);
    await expect(env.model('account.move.line').callButton([debit,draft],'action_reconcile')).rejects.toMatchObject({ kind: 'user_error' });
    await expect(env.model('account.move.line').callButton([debit,wrong],'action_reconcile')).rejects.toMatchObject({ kind: 'user_error' });
    expect(await env.model('account.partial.reconcile').searchCount([])).toBe(count);
  });
  it('posts standalone payments as balanced entries and rejects negative amounts', async () => {
    const id = await payment(45);
    const [p] = await env.model('account.payment').read(id,['move_id']);
    const [m] = await env.model('account.move').read((p.move_id as [number,string])[0],['state','posted_before','line_ids']);
    expect(m).toMatchObject({ state: 'posted',posted_before: true });
    const lines = await env.model('account.move.line').read(m.line_ids as number[],['debit','credit']);
    expect(lines.reduce((s,l) => s+Number(l.debit)-Number(l.credit),0)).toBe(0);
    const negative = await env.model('account.payment').create({ amount: -10 });
    await expect(env.model('account.payment').callButton(negative,'action_post')).rejects.toMatchObject({ kind: 'user_error' });
  });
  it('allocates a single payment across invoices without paying the same amount twice', async () => {
    const a = await invoice(100); const b = await invoice(100); const pay = await payment(150);
    await env.model('account.move').callButton(a,'js_assign_outstanding_line',{ payment_id: pay });
    await env.model('account.move').callButton(b,'js_assign_outstanding_line',{ payment_id: pay });
    expect((await env.model('account.move').read([a,b],['amount_residual'])).map(r => r.amount_residual)).toEqual([0,50]);
    await expect(env.model('account.move').callButton(b,'js_assign_outstanding_line',{ payment_id: pay })).rejects.toMatchObject({ kind: 'user_error' });
    await env.model('account.move').callButton(a,'js_remove_outstanding_partial',{ payment_id: pay });
    expect((await env.model('account.move').read([a,b],['amount_residual'])).map(r => r.amount_residual)).toEqual([100,50]);
    expect((await env.model('account.payment').read(pay,['reconciled_invoice_ids']))[0].reconciled_invoice_ids).toEqual([b]);
  });
  it('groups compatible invoices into one payment and cancellation restores every residual', async () => {
    const a = await invoice(75); const b = await invoice(25);
    await register([a,b],{ group_payment: true });
    const payments = await env.model('account.payment').search([['reconciled_invoice_ids','in',[a,b]]]);
    expect(payments).toHaveLength(1);
    expect((await env.model('account.payment').read(payments,['amount','reconciled_invoice_ids']))[0]).toMatchObject({ amount: 100,reconciled_invoice_ids: [a,b] });
    await env.model('account.payment').callButton(payments,'action_cancel');
    expect((await env.model('account.move').read([a,b],['amount_residual','payment_state'])).map(r => [r.amount_residual,r.payment_state])).toEqual([[75,'not_paid'],[25,'not_paid']]);
    const [p] = await env.model('account.payment').read(payments,['move_id']);
    expect((await env.model('account.move').read((p.move_id as [number,string])[0],['state']))[0].state).toBe('cancel');
  });
  it('books a payment difference to the selected account and keeps actual cash separate', async () => {
    const id = await invoice(100);
    await register([id],{ amount: 95,payment_difference_handling: 'reconcile',writeoff_account_id: expense,writeoff_label: 'Small balance' });
    expect((await env.model('account.move').read(id,['amount_residual','payment_state']))[0]).toMatchObject({ amount_residual: 0,payment_state: 'paid' });
    const [p] = await env.model('account.payment').searchRead([['reconciled_invoice_ids','in',[id]]],['amount','move_id']);
    expect(p.amount).toBe(95);
    const writeoff = await env.model('account.move.line').searchRead([['move_id','=',(p.move_id as [number,string])[0]],['account_id','=',expense]],['name','debit','credit']);
    expect(writeoff[0]).toMatchObject({ name: 'Small balance',debit: 5,credit: 0 });
    const missing = await invoice(20);
    await expect(register([missing],{ amount: 15,payment_difference_handling: 'reconcile' })).rejects.toMatchObject({ kind: 'user_error' });
    expect((await env.model('account.move').read(missing,['amount_residual']))[0].amount_residual).toBe(20);
  });
  it('keeps an overpayment available for another invoice', async () => {
    const a = await invoice(100); await register([a],{ amount: 120 });
    const [pay] = await env.model('account.payment').search([['reconciled_invoice_ids','in',[a]]]);
    expect((await env.model('account.payment').read(pay,['amount','is_reconciled']))[0]).toMatchObject({ amount: 120,is_reconciled: false });
    const b = await invoice(20); await env.model('account.move').callButton(b,'js_assign_outstanding_line',{ payment_id: pay });
    expect((await env.model('account.move').read(b,['amount_residual']))[0].amount_residual).toBe(0);
  });
  it('refuses incompatible payment directions and editing confirmed financial details', async () => {
    const a = await invoice(25); const pay = await payment(25,customer,'outbound');
    await expect(env.model('account.move').callButton(a,'js_assign_outstanding_line',{ payment_id: pay })).rejects.toMatchObject({ kind: 'user_error' });
    await expect(env.model('account.payment').write(pay,{ amount: 50 })).rejects.toMatchObject({ kind: 'user_error' });
  });
  it('updates the journal entry when a payment is reset, edited and confirmed again',async () => {
    const pay=await payment(30);
    await env.model('account.payment').callButton(pay,'action_draft');
    await env.model('account.payment').write(pay,{ amount: 45 });
    await env.model('account.payment').callButton(pay,'action_post');
    const [p]=await env.model('account.payment').read(pay,['move_id']);
    const rows=await env.model('account.move.line').searchRead([['move_id','=',(p.move_id as [number,string])[0]]],['debit','credit']);
    expect(rows.reduce((s,r) => s+Number(r.debit),0)).toBe(45);
    expect(rows.reduce((s,r) => s+Number(r.credit),0)).toBe(45);
  });
});
