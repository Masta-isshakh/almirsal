import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { pgliteDatabase } from '../packages/engine/db/pglite.js';
import type { Database } from '../packages/engine/db/types.js';
import { syncSchema } from '../packages/engine/schema/ddl.js';
import { loadSeed } from '../packages/engine/seed/load.js';
import { testRegistry } from '../packages/engine/testing/registry.js';
import { Environment } from '../packages/engine/orm/env.js';
import { clearModelHooks } from '../packages/engine/orm/hooks.js';
import { registerApps } from '../packages/apps/index.js';
import { verifyJournalHashes } from '../packages/apps/account/integrity.js';

const registry=testRegistry();
let db: Database; let env: Environment; let debit: number; let credit: number; let journal: number; let partner: number;
beforeAll(async () => {
  clearModelHooks(); registerApps(registry);
  db=pgliteDatabase(); await syncSchema(db,registry); await loadSeed(db,registry);
  env=new Environment({ registry,db,uid: 2,companyIds: [1] });
  [debit]=await env.model('account.account').search([['account_type','=','asset_receivable']]);
  [credit]=await env.model('account.account').search([['account_type','=','income']]);
  journal=await env.model('account.journal').create({ name: 'Integrity journal',code: 'SEC',type: 'general',company_id: 1 });
  partner=await env.model('res.partner').create({ name: 'Integrity customer' });
},240_000);
afterAll(async () => { await db.close?.(); });
async function entry(date='2026-02-28'): Promise<number> {
  return env.model('account.move').create({ move_type: 'entry',date,journal_id: journal,
    line_ids: [[0,0,{ name: 'Debit',account_id: debit,debit: 100,credit: 0 }],[0,0,{ name: 'Credit',account_id: credit,debit: 0,credit: 100 }]] });
}
describe('accounting locks and immutable entries', () => {
  it('persists lock dates through the wizard, postpones posting, and protects the hard lock',async () => {
    const w=await env.model('account.change.lock.date').create({ company_id: 1,exception_applies_to: 'me',exception_duration: 'forever',fiscalyear_lock_date: '2026-03-31',hard_lock_date: '2026-02-28' });
    await env.model('account.change.lock.date').callButton(w,'change_lock_date');
    expect((await env.model('res.company').read(1,['fiscalyear_lock_date','hard_lock_date']))[0]).toMatchObject({ fiscalyear_lock_date: '2026-03-31',hard_lock_date: '2026-02-28' });
    const id=await entry(); await env.model('account.move').callButton(id,'action_post');
    expect((await env.model('account.move').read(id,['date']))[0].date).toBe('2026-04-01');
    await expect(env.model('res.company').write(1,{ hard_lock_date: false })).rejects.toMatchObject({ kind: 'user_error' });
    await env.model('res.company').write(1,{ fiscalyear_lock_date: false });
  });
  it('applies sales and tax locks selectively and preserves the document date',async () => {
    await env.model('res.company').write(1,{ sale_lock_date: '2026-05-31',tax_lock_date: '2026-06-30' });
    const tax=await env.model('account.tax').create({ name: 'Lock test VAT',amount: 10,amount_type: 'percent',type_tax_use: 'sale' });
    const id=await env.model('account.move').create({ move_type: 'out_invoice',partner_id: partner,date: '2026-05-15',invoice_date: '2026-05-15',
      invoice_line_ids: [[0,0,{ name: 'Taxed service',quantity: 1,price_unit: 100,tax_ids: [[6,0,[tax]]] }]] });
    await env.model('account.move').callButton(id,'action_post');
    expect((await env.model('account.move').read(id,['date','invoice_date']))[0]).toMatchObject({ date: '2026-07-01',invoice_date: '2026-05-15' });
    const general=await entry('2026-04-10'); await env.model('account.move').callButton(general,'action_post');
    expect((await env.model('account.move').read(general,['date']))[0].date).toBe('2026-04-10');
    await env.model('res.company').write(1,{ sale_lock_date: false,tax_lock_date: false });
  });
  it('uses valid scoped lock exceptions and never bypasses a hard lock',async () => {
    await env.model('res.company').write(1,{ fiscalyear_lock_date: '2026-04-30' });
    const exception=await env.model('account.lock_exception').create({ company_id: 1,user_id: 2,lock_date_field: 'fiscalyear_lock_date',lock_date: '2026-03-15',state: 'active',reason: 'Adjustment' });
    const id=await entry('2026-03-20'); await env.model('account.move').callButton(id,'action_post');
    expect((await env.model('account.move').read(id,['date']))[0].date).toBe('2026-03-20');
    await env.model('account.lock_exception').write(exception,{ state: 'revoked' });
    const locked=await entry('2026-03-20'); await env.model('account.move').callButton(locked,'action_post');
    expect((await env.model('account.move').read(locked,['date']))[0].date).toBe('2026-05-01');
    await env.model('res.company').write(1,{ fiscalyear_lock_date: false });
  });
  it('blocks posted item edits and reset/cancel of entries in locked periods',async () => {
    const id=await entry('2026-07-01'); await env.model('account.move').callButton(id,'action_post');
    const [item]=await env.model('account.move.line').search([['move_id','=',id]]);
    await expect(env.model('account.move.line').write(item,{ debit: 200 })).rejects.toMatchObject({ kind: 'user_error' });
    await expect(env.model('account.move.line').unlink(item)).rejects.toMatchObject({ kind: 'user_error' });
    await expect(env.model('account.move').write(id,{ date: '2026-07-02' })).rejects.toMatchObject({ kind: 'user_error' });
    await env.model('res.company').write(1,{ fiscalyear_lock_date: '2026-07-31' });
    await expect(env.model('account.move').callButton(id,'button_draft')).rejects.toMatchObject({ kind: 'user_error' });
    await expect(env.model('account.move').callButton(id,'button_cancel')).rejects.toMatchObject({ kind: 'user_error' });
    await env.model('res.company').write(1,{ fiscalyear_lock_date: false });
  });
  it('hashes journal history with SHA-256, detects tampering, and gives copies a fresh identity',async () => {
    const a=await entry('2026-08-01'); const b=await entry('2026-08-02');
    await env.model('account.move').callButton([a,b],'action_post');
    await env.model('account.move').callButton(b,'button_hash');
    const rows=await env.model('account.move').read([a,b],['inalterable_hash','secure_sequence_number']);
    expect(rows.every(r => /^[a-f0-9]{64}$/.test(String(r.inalterable_hash)))).toBe(true);
    expect(Number(rows[1].secure_sequence_number)).toBe(Number(rows[0].secure_sequence_number)+1);
    expect(await verifyJournalHashes(env,journal)).toBe(true);
    await expect(env.model('account.move').callButton(a,'button_draft')).rejects.toMatchObject({ kind: 'user_error' });
    await expect(env.model('account.move').write(a,{ inalterable_hash: false })).rejects.toMatchObject({ kind: 'user_error' });
    const copy=await env.model('account.move').copy(a);
    expect((await env.model('account.move').read(copy,['state','inalterable_hash','secure_sequence_number']))[0]).toMatchObject({ state: 'draft',inalterable_hash: false,secure_sequence_number: false });
    await env.cr.query(`UPDATE account_move_line SET debit=debit+1 WHERE id=(SELECT min(id) FROM account_move_line WHERE move_id=$1)`,[a]);
    expect(await verifyJournalHashes(env,journal)).toBe(false);
    await env.cr.query(`UPDATE account_move_line SET debit=debit-1 WHERE id=(SELECT min(id) FROM account_move_line WHERE move_id=$1)`,[a]);
  });
  it('automatically secures posted entries in restricted journals',async () => {
    await env.model('account.journal').write(journal,{ restrict_mode_hash_table: true });
    const id=await entry('2026-09-01'); await env.model('account.move').callButton(id,'action_post');
    expect(String((await env.model('account.move').read(id,['inalterable_hash']))[0].inalterable_hash)).toMatch(/^[a-f0-9]{64}$/);
    expect(await verifyJournalHashes(env,journal)).toBe(true);
  });
});
