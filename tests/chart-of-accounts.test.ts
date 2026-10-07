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

beforeAll(async () => {
  db = pgliteDatabase();
  await syncSchema(db, registry);
  await loadSeed(db, registry);
  clearModelHooks();
  registerApps(registry);
  env = new Environment({ registry, db, uid: 2, companyIds: [1], superuser: true });
}, 240_000);

afterAll(async () => { await db?.close?.(); });

async function entry(account: number, state: 'draft' | 'posted' = 'draft') {
  const counterpart = await env.model('account.account').create({ name: 'Entry counterpart', account_type: 'equity' });
  const move = await env.model('account.move').create({
    move_type: 'entry', line_ids: [
      [0, 0, { account_id: account, name: 'Account activity', debit: 125, credit: 0 }],
      [0, 0, { account_id: counterpart, name: 'Counterpart', debit: 0, credit: 125 }],
    ],
  });
  if (state === 'posted') await env.model('account.move').callButton(move, 'action_post');
  return move;
}

describe('Chart of Accounts list actions', () => {
  it('classifies new accounts in all five categories and updates the category when their type changes', async () => {
    const accounts = env.model('account.account');
    const categories = [
      ['asset_current', 'asset'], ['liability_current', 'liability'],
      ['equity', 'equity'], ['income', 'income'], ['expense', 'expense'],
    ];
    const created: number[] = [];
    for (const [type, group] of categories) {
      const id = await accounts.create({ name: `Category test ${group}`, account_type: type });
      created.push(id);
      expect((await accounts.read(id, ['internal_group']))[0].internal_group).toBe(group);
      expect(await accounts.search([['id', '=', id], ['internal_group', '=', group]])).toEqual([id]);
    }
    await accounts.write(created[0], { account_type: 'expense_direct_cost' });
    expect(await accounts.search([['id', '=', created[0]], ['internal_group', '=', 'asset']])).toEqual([]);
    expect(await accounts.search([['id', '=', created[0]], ['internal_group', '=', 'expense']])).toEqual([created[0]]);
  });

  it('allocates different codes for simultaneous account copies', async () => {
    const accounts = env.model('account.account');
    const source = await accounts.create({ name: 'Concurrent account copies', account_type: 'asset_current' });
    const copies = await Promise.all(Array.from({ length: 3 }, () => accounts.copy(source)));
    const rows = await accounts.read([source, ...copies], ['code']);
    expect(new Set(rows.map((row) => row.code)).size).toBe(4);
  });

  it('duplicates account settings into an active account with an unused code, including archived code reservations', async () => {
    const accounts = env.model('account.account');
    const source = await accounts.create({ code: '9900000', name: 'Travel expense', account_type: 'expense', description: 'Employee travel', reconcile: true });
    // A code belonging to a different account type still cannot be reused.
    await accounts.create({ code: '9900001', name: 'Reserved archived code', account_type: 'asset_current', active: false });
    await accounts.write(source, { active: false });
    const copied = await accounts.copy(source);
    const [copy] = await accounts.read(copied, ['code', 'name', 'active', 'account_type', 'description', 'reconcile', 'company_ids', 'opening_balance']);
    expect(copy).toMatchObject({ code: '9900002', name: 'Travel expense (copy)', active: true, account_type: 'expense', description: 'Employee travel', reconcile: true, company_ids: [1], opening_balance: 0 });
    const second = await accounts.copy(source);
    expect((await accounts.read(second, ['code']))[0].code).toBe('9900003');
    expect((await accounts.read(source, ['active', 'code']))[0]).toMatchObject({ active: false, code: '9900000' });
  });

  it('rejects duplicate codes in overlapping companies, including archived accounts, and rolls back edits', async () => {
    const accounts = env.model('account.account');
    const archived = await accounts.create({ code: 'SAME-COMPANY', name: 'Archived code owner', active: false });
    await expect(accounts.create({ code: ' SAME-COMPANY ', name: 'Duplicate' })).rejects.toMatchObject({ kind: 'validation_error' });
    const other = await accounts.create({ code: 'OTHER-CODE', name: 'Other account' });
    await expect(accounts.write(other, { code: 'SAME-COMPANY' })).rejects.toMatchObject({ kind: 'validation_error' });
    expect((await accounts.read(other, ['code']))[0].code).toBe('OTHER-CODE');
    expect((await accounts.read(archived, ['active']))[0].active).toBe(false);

    const companyPartner = await env.model('res.partner').create({ name: 'Second accounting company', is_company: true });
    const company = await env.model('res.company').create({ name: 'Second accounting company', partner_id: companyPartner });
    const elsewhere = await accounts.create({ code: 'SAME-COMPANY', name: 'Separate company account', company_ids: [[6, 0, [company]]] });
    expect(elsewhere).toBeTruthy();
    await expect(accounts.write(elsewhere, { company_ids: [[6, 0, [company, 1]]] })).rejects.toMatchObject({ kind: 'validation_error' });
    expect((await accounts.read(elsewhere, ['company_ids']))[0].company_ids).toEqual([company]);
  });

  it('deletes unused accounts but preserves every account referenced by draft or posted journal items', async () => {
    const accounts = env.model('account.account');
    const unused = await accounts.create({ name: 'Unused account' });
    await accounts.unlink(unused);
    expect(await accounts.search([['id', '=', unused]], { activeTest: false })).toEqual([]);

    for (const state of ['draft', 'posted'] as const) {
      const used = await accounts.create({ name: `Used by ${state} journal entry`, account_type: 'asset_current' });
      const move = await entry(used, state);
      const anotherUnused = await accounts.create({ name: 'Must survive rejected batch delete' });
      await expect(accounts.unlink([anotherUnused, used])).rejects.toMatchObject({ kind: 'user_error' });
      expect(await accounts.search([['id', 'in', [anotherUnused, used]]])).toHaveLength(2);
      const lines = await env.model('account.move.line').searchRead([['move_id', '=', move], ['account_id', '=', used]], ['account_id', 'debit', 'credit']);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ debit: 125, credit: 0 });
      expect((lines[0].account_id as [number, string])[0]).toBe(used);
    }
  });

  it('archives and restores accounts without changing posted amounts, and includes inactive accounts in search and export reads', async () => {
    const accounts = env.model('account.account');
    const used = await accounts.create({ name: 'Archive accounting history', account_type: 'asset_current' });
    const move = await entry(used, 'posted');
    const before = (await accounts.read(used, ['current_balance']))[0].current_balance;
    await accounts.write(used, { active: false });
    const inactive = [['id', '=', used], ['active', '=', false]] as import('../packages/engine/registry/types.js').Domain;
    expect(await accounts.search(inactive)).toEqual([used]);
    expect(await accounts.searchCount(inactive)).toBe(1);
    expect((await accounts.searchWithCount(inactive)).ids).toEqual([used]);
    const exportRows = await accounts.searchRead(inactive, ['code', 'name', 'current_balance']);
    expect(exportRows).toHaveLength(1);
    expect(exportRows[0].current_balance).toBe(before);
    const selectedExport = await env.with({ context: { active_test: false } }).model('account.account').searchRead([['id', 'in', [used]]], ['code', 'name', 'current_balance']);
    expect(selectedExport.map((row) => row.id)).toEqual([used]);
    expect((await accounts.readGroup(inactive, ['current_balance:sum'], [])).length).toBe(1);
    await accounts.write(used, { active: true });
    expect((await accounts.read(used, ['active', 'current_balance']))[0]).toMatchObject({ active: true, current_balance: before });
    expect(await env.model('account.move.line').searchCount([['move_id', '=', move], ['account_id', '=', used]])).toBe(1);
  });

  it('duplicates account settings without copying draft or posted opening balances into the books', async () => {
    const accounts = env.model('account.account');
    const source = await accounts.create({ name: 'Opening balance source', account_type: 'asset_current' });
    await accounts.write(source, { opening_debit: 450 });
    const openingLines = [['move_id.ref', '=', 'Opening Journal Entry']] as import('../packages/engine/registry/types.js').Domain;
    const before = await env.model('account.move.line').searchRead(openingLines, ['account_id', 'debit', 'credit']);
    const draftCopy = await accounts.copy(source);
    expect((await accounts.read(draftCopy, ['opening_debit', 'opening_credit', 'opening_balance', 'current_balance']))[0]).toMatchObject({ opening_debit: 0, opening_credit: 0, opening_balance: 0, current_balance: 0 });
    expect(await env.model('account.move.line').searchRead(openingLines, ['account_id', 'debit', 'credit'])).toEqual(before);
    await accounts.callButton(source, 'action_validate_opening_move');
    const postedCopy = await accounts.copy(source);
    expect((await accounts.read(postedCopy, ['opening_balance', 'current_balance']))[0]).toMatchObject({ opening_balance: 0, current_balance: 0 });
    expect((await accounts.read(source, ['opening_balance', 'current_balance']))[0]).toMatchObject({ opening_balance: 450, current_balance: 450 });
    expect(await env.model('account.move.line').searchRead(openingLines, ['account_id', 'debit', 'credit'])).toEqual(before);
  });
});
