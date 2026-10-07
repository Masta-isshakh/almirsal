import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgliteDatabase } from '../packages/engine/db/pglite.js';
import type { Database } from '../packages/engine/db/types.js';
import type { Domain } from '../packages/engine/registry/types.js';
import { syncSchema } from '../packages/engine/schema/ddl.js';
import { loadSeed } from '../packages/engine/seed/load.js';
import { testRegistry } from '../packages/engine/testing/registry.js';
import { Environment } from '../packages/engine/orm/env.js';
import { clearModelHooks, type Values } from '../packages/engine/orm/hooks.js';
import { registerApps } from '../packages/apps/index.js';

const registry = testRegistry();
let db: Database;
let env: Environment;
let fixed: number;
let accumulated: number;
let expense: number;
let journal: number;

beforeAll(async () => {
  db = pgliteDatabase();
  clearModelHooks();
  // App registration installs the native modification wizard before schema sync.
  registerApps(registry);
  await syncSchema(db, registry);
  await loadSeed(db, registry);
  env = new Environment({ registry, db, uid: 2, companyIds: [1], superuser: true });
  fixed = await env.model('account.account').create({ name: 'Asset original cost', account_type: 'asset_fixed' });
  accumulated = await env.model('account.account').create({ name: 'Accumulated depreciation', account_type: 'asset_non_current' });
  expense = await env.model('account.account').create({ name: 'Depreciation expense', account_type: 'expense_depreciation' });
  [journal] = await env.model('account.journal').search([['type', '=', 'general']], { limit: 1 });
}, 240_000);

afterAll(async () => { await db?.close?.(); });

async function asset(overrides: Values = {}): Promise<number> {
  return env.model('account.asset').create({ name: 'Equipment', original_value: 1000, salvage_value: 100, method: 'linear', method_number: 4, method_period: '1', acquisition_date: '2024-01-31', account_asset_id: fixed, account_depreciation_id: accumulated, account_depreciation_expense_id: expense, journal_id: journal, ...overrides });
}

async function board(id: number, state?: string): Promise<Values[]> {
  const domain: Domain = [['asset_id', '=', id], ['asset_move_type', '=', 'depreciation']];
  if (state) domain.push(['state', '=', state]);
  return env.model('account.move').searchRead(domain, ['id', 'date', 'state', 'depreciation_value', 'asset_depreciated_value', 'asset_remaining_value', 'line_ids'], { order: 'date asc, id asc' });
}

async function wizard(id: number, changes: Values): Promise<void> {
  const wizardEnv = env.with({ context: { default_asset_id: id } });
  const record = await wizardEnv.model('account.asset.modify').create({ date: '2024-02-01', ...changes });
  await wizardEnv.model('account.asset.modify').callButton(record, 'modify');
}

describe('Asset depreciation and lifecycle', () => {
  it('creates a balanced month-end board without treating planned entries as posted depreciation', async () => {
    const id = await asset();
    await env.model('account.asset').callButton(id, 'compute_depreciation_board');
    const rows = await board(id);
    expect(rows.map((row) => row.date)).toEqual(['2024-01-31', '2024-02-29', '2024-03-31', '2024-04-30']);
    expect(rows.map((row) => row.depreciation_value)).toEqual([225, 225, 225, 225]);
    expect(rows.at(-1)).toMatchObject({ asset_depreciated_value: 900, asset_remaining_value: 0 });
    expect((await env.model('account.asset').read(id, ['state', 'book_value', 'value_residual']))[0]).toMatchObject({ state: 'draft', book_value: 1000, value_residual: 900 });
    for (const row of rows) {
      const lines = await env.model('account.move.line').read(row.line_ids as number[], ['debit', 'credit']);
      expect(lines.reduce((sum, line) => sum + Number(line.debit) - Number(line.credit), 0)).toBeCloseTo(0);
    }
    await expect(env.model('account.move').callButton(Number(rows[0].id), 'action_post')).rejects.toMatchObject({ kind: 'user_error' });
  });

  it('subtracts actual posted amounts when rebuilding, preserves posted entries, and closes at salvage value', async () => {
    const id = await asset();
    await env.model('account.asset').callButton(id, 'validate');
    const [first] = await board(id);
    await env.model('account.move').callButton(Number(first.id), 'action_post');
    expect((await env.model('account.asset').read(id, ['state', 'book_value', 'value_residual']))[0]).toMatchObject({ state: 'open', book_value: 775, value_residual: 675 });
    await env.model('account.asset').callButton(id, 'compute_depreciation_board');
    const rebuilt = await board(id);
    expect(rebuilt).toHaveLength(4);
    expect(rebuilt[0]).toMatchObject({ id: first.id, state: 'posted', depreciation_value: 225 });
    expect(rebuilt.slice(1).reduce((sum, row) => sum + Number(row.depreciation_value), 0)).toBe(675);
    for (const row of rebuilt.slice(1)) await env.model('account.move').callButton(Number(row.id), 'action_post');
    expect((await env.model('account.asset').read(id, ['state', 'book_value', 'value_residual']))[0]).toMatchObject({ state: 'close', book_value: 100, value_residual: 0 });
    await expect(env.model('account.asset').callButton(id, 'set_to_running')).rejects.toMatchObject({ kind: 'user_error' });
    await expect(env.model('account.asset').callButton(id, 'set_to_draft')).rejects.toMatchObject({ kind: 'user_error' });
    await expect(env.model('account.asset').unlink(id)).rejects.toMatchObject({ kind: 'user_error' });
  });

  it('uses company currency precision and puts the final rounding difference into the last period', async () => {
    const [company] = await env.model('res.company').read(1, ['currency_id']);
    const currency = await env.model('res.currency').create({ name: 'TEST-3DP', symbol: 'T', rounding: 0.001, decimal_places: 3, active: true });
    await env.model('res.company').write(1, { currency_id: currency });
    try {
      const id = await asset({ original_value: 10, salvage_value: 0, method_number: 3, acquisition_date: '2024-01-29' });
      await env.model('account.asset').callButton(id, 'validate');
      expect((await board(id)).map((row) => row.depreciation_value)).toEqual([3.333, 3.334, 3.333]);
      expect((await board(id)).reduce((sum, row) => sum + Number(row.depreciation_value), 0)).toBeCloseTo(10, 8);
      expect((await env.model('account.asset').read(id, ['book_value']))[0].book_value).toBe(10);
    } finally { await env.model('res.company').write(1, { currency_id: (company.currency_id as [number, string])[0] }); }
  });

  it('subtracts imported depreciation and respects declining factors and no-depreciation assets', async () => {
    const imported = await asset({ already_depreciated_amount_import: 100 });
    await env.model('account.asset').callButton(imported, 'validate');
    expect((await board(imported)).map((row) => row.depreciation_value)).toEqual([200, 200, 200, 200]);
    expect((await env.model('account.asset').read(imported, ['book_value', 'value_residual']))[0]).toMatchObject({ book_value: 900, value_residual: 800 });
    const declining = await asset({ method: 'degressive', method_progress_factor: 0.5 });
    await env.model('account.asset').callButton(declining, 'validate');
    expect((await board(declining)).map((row) => row.depreciation_value)).toEqual([500, 250, 125, 25]);
    const land = await asset({ method: 'no_depreciation', salvage_value: 0 });
    await env.model('account.asset').callButton(land, 'validate');
    expect(await board(land)).toEqual([]);
    expect((await env.model('account.asset').read(land, ['state', 'book_value']))[0]).toMatchObject({ state: 'open', book_value: 1000 });
  });

  it('opens a real modification wizard, pauses posting, and resumes future periods without moving posted history', async () => {
    const id = await asset();
    await env.model('account.asset').callButton(id, 'validate');
    expect(await env.model('account.asset').callButton(id, 'action_asset_modify')).toMatchObject({ type: 'ir.actions.act_window', res_model: 'account.asset.modify', target: 'new' });
    const rows = await board(id);
    await env.model('account.move').callButton(Number(rows[0].id), 'action_post');
    await wizard(id, { operation: 'pause', date: '2024-02-15' });
    expect((await env.model('account.asset').read(id, ['state']))[0].state).toBe('paused');
    await expect(env.model('account.move').callButton(Number(rows[1].id), 'action_post')).rejects.toMatchObject({ kind: 'user_error' });
    await expect(env.model('account.asset').callButton(id, 'resume_after_pause', { date: '2024-02-01' })).rejects.toMatchObject({ kind: 'user_error' });
    await env.model('account.asset').callButton(id, 'resume_after_pause', { date: '2024-04-15' });
    const resumed = await board(id);
    expect(resumed[0]).toMatchObject({ id: rows[0].id, date: '2024-01-31', state: 'posted' });
    expect(resumed.slice(1).map((row) => row.date)).toEqual(['2024-04-30', '2024-05-31', '2024-06-30']);
    expect((await env.model('account.asset').read(id, ['state', 'book_value']))[0]).toMatchObject({ state: 'open', book_value: 775 });
  });

  it('modifies remaining duration and records value changes as balanced revaluations', async () => {
    const id = await asset();
    await env.model('account.asset').callButton(id, 'validate');
    const [first] = await board(id);
    await env.model('account.move').callButton(Number(first.id), 'action_post');
    await expect(env.model('account.asset').write(id, { original_value: 1200 })).rejects.toMatchObject({ kind: 'user_error' });
    await expect(env.model('account.asset').write(id, { acquisition_date: '2023-12-31' })).rejects.toMatchObject({ kind: 'user_error' });
    await wizard(id, { operation: 'modify', original_value: 1200, method_number: 5, account_id: expense, reason: 'Improvement' });
    const revalues = await env.model('account.move').searchRead([['asset_id', '=', id], ['asset_move_type', '=', 'positive_revaluation']], ['state', 'line_ids']);
    expect(revalues).toHaveLength(1);
    expect(revalues[0].state).toBe('posted');
    const lines = await env.model('account.move.line').read(revalues[0].line_ids as number[], ['debit', 'credit']);
    expect(lines.reduce((sum, row) => sum + Number(row.debit) - Number(row.credit), 0)).toBeCloseTo(0);
    const schedule = await board(id);
    expect(schedule[0].id).toBe(first.id);
    expect(schedule.slice(1).reduce((sum, row) => sum + Number(row.depreciation_value), 0)).toBeCloseTo(875);
    expect((await env.model('account.asset').read(id, ['original_value', 'book_value', 'value_residual']))[0]).toMatchObject({ original_value: 1200, book_value: 975, value_residual: 875 });
    await expect(wizard(id, { operation: 'modify', method_number: 1 })).rejects.toMatchObject({ kind: 'user_error' });
    expect((await env.model('account.asset').read(id, ['method_number']))[0].method_number).toBe(5);
  });

  it('disposes an asset through balanced cost, depreciation and loss lines, retaining its posted history', async () => {
    const id = await asset();
    await env.model('account.asset').callButton(id, 'validate');
    const [first] = await board(id);
    await env.model('account.move').callButton(Number(first.id), 'action_post');
    await expect(env.model('account.asset').callButton(id, 'set_to_cancelled')).rejects.toMatchObject({ kind: 'user_error' });
    await wizard(id, { operation: 'dispose', account_id: expense, reason: 'Retired equipment' });
    expect((await env.model('account.asset').read(id, ['state', 'book_value', 'value_residual']))[0]).toMatchObject({ state: 'close', book_value: 0, value_residual: 0 });
    expect(await board(id)).toHaveLength(1);
    expect((await board(id))[0].id).toBe(first.id);
    const [move] = await env.model('account.move').searchRead([['asset_id', '=', id], ['asset_move_type', '=', 'disposal']], ['state', 'line_ids']);
    expect(move.state).toBe('posted');
    const lines = await env.model('account.move.line').read(move.line_ids as number[], ['account_id', 'debit', 'credit']);
    const byAccount = (account: number) => lines.find((line) => (line.account_id as [number, string])[0] === account);
    expect(byAccount(fixed)).toMatchObject({ credit: 1000 });
    expect(byAccount(accumulated)).toMatchObject({ debit: 225 });
    expect(byAccount(expense)).toMatchObject({ debit: 775 });
    await expect(env.model('account.asset').write(id, { state: 'open' })).rejects.toMatchObject({ kind: 'user_error' });
  });

  it('protects invalid lifecycle transitions and duplicates asset settings without copying posted moves', async () => {
    const id = await asset();
    await expect(env.model('account.asset').callButton(id, 'resume_after_pause')).rejects.toMatchObject({ kind: 'user_error' });
    await env.model('account.asset').callButton(id, 'validate');
    const [first] = await board(id);
    await env.model('account.move').callButton(Number(first.id), 'action_post');
    const copied = await env.model('account.asset').copy(id);
    expect((await env.model('account.asset').read(copied, ['state', 'book_value', 'value_residual', 'depreciation_move_ids']))[0]).toMatchObject({ state: 'draft', book_value: 1000, value_residual: 900, depreciation_move_ids: [] });
    await expect(env.model('account.asset').callButton(id, 'validate')).rejects.toMatchObject({ kind: 'user_error' });
    const unused = await asset();
    await env.model('account.asset').callButton(unused, 'validate');
    await env.model('account.asset').callButton(unused, 'set_to_cancelled');
    expect(await board(unused)).toEqual([]);
    await env.model('account.asset').callButton(unused, 'set_to_draft');
    expect((await env.model('account.asset').read(unused, ['state']))[0].state).toBe('draft');
  });
});
