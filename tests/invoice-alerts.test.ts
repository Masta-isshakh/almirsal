import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgliteDatabase } from '../packages/engine/db/pglite.js';
import type { Database } from '../packages/engine/db/types.js';
import { syncSchema } from '../packages/engine/schema/ddl.js';
import { loadSeed } from '../packages/engine/seed/load.js';
import { testRegistry } from '../packages/engine/testing/registry.js';
import { Environment } from '../packages/engine/orm/env.js';
import { clearModelHooks } from '../packages/engine/orm/hooks.js';
import { registerApps } from '../packages/apps/index.js';

/**
 * The banner above an invoice (Odoo's `alerts`, drawn by the
 * `actionable_errors` widget). It says what stands in the way of posting, and it
 * must stay empty on a document that is fine — a banner on every invoice would
 * be worse than none.
 */
const registry = testRegistry();
let db: Database;
let env: Environment;
let partner: number;

beforeAll(async () => {
  db = pgliteDatabase();
  await syncSchema(db, registry);
  await loadSeed(db, registry);
  clearModelHooks();
  registerApps(registry);
  env = new Environment({ registry, db, uid: 2, companyIds: [1] });
  partner = await env.model('res.partner').create({ name: 'Alerts Customer' });
}, 240_000);

afterAll(async () => { await db.close?.(); });

const alertsOf = async (id: number): Promise<Record<string, { level: string }>> =>
  (await env.model('account.move').read(id, ['alerts']))[0].alerts as Record<string, { level: string }>;

describe('invoice alerts', () => {
  it('says nothing about an invoice that is ready', async () => {
    const id = await env.model('account.move').create({
      move_type: 'out_invoice', partner_id: partner, invoice_date: '2026-09-30',
      invoice_line_ids: [[0, 0, { name: 'Service', quantity: 1, price_unit: 100 }]],
    });
    expect(await alertsOf(id)).toEqual({});
  });

  it('asks for the partner and the lines', async () => {
    const id = await env.model('account.move').create({ move_type: 'out_invoice' });
    expect(await alertsOf(id)).toMatchObject({ no_lines: { level: 'warning' }, no_partner: { level: 'warning' } });
  });

  it('asks a vendor bill for its date', async () => {
    const id = await env.model('account.move').create({
      move_type: 'in_invoice', partner_id: partner,
      invoice_line_ids: [[0, 0, { name: 'Supply', quantity: 1, price_unit: 40 }]],
    });
    expect(Object.keys(await alertsOf(id))).toEqual(['no_invoice_date']);
  });

  it('points at an entry whose sides do not match, and stops once they do', async () => {
    const id = await env.model('account.move').create({ move_type: 'entry', line_ids: [[0, 0, { name: 'One side', debit: 100, credit: 0 }]] });
    expect(await alertsOf(id)).toMatchObject({ unbalanced: { level: 'danger' } });
    await env.model('account.move').write(id, { line_ids: [[0, 0, { name: 'Other side', debit: 0, credit: 100 }]] });
    expect(await alertsOf(id)).toEqual({});
  });

  it('warns when another document of the same partner uses the reference', async () => {
    const values = { move_type: 'in_invoice', partner_id: partner, invoice_date: '2026-09-30', ref: 'SUP-2026-01', invoice_line_ids: [[0, 0, { name: 'Supply', quantity: 1, price_unit: 10 }]] };
    const first = await env.model('account.move').create(values);
    expect(await alertsOf(first)).toEqual({});
    const second = await env.model('account.move').create(values);
    expect(await alertsOf(second)).toMatchObject({ duplicated_ref: { level: 'warning' } });
    // Both sides of the duplicate see it, as in Odoo.
    expect(await alertsOf(first)).toMatchObject({ duplicated_ref: { level: 'warning' } });
    // A different partner with the same reference is not a duplicate.
    const other = await env.model('res.partner').create({ name: 'Another Vendor' });
    const third = await env.model('account.move').create({ ...values, partner_id: other });
    expect(await alertsOf(third)).toEqual({});
  });

  it('keeps quiet once the document is posted', async () => {
    const id = await env.model('account.move').create({ move_type: 'entry' });
    expect(Object.keys(await alertsOf(id))).toContain('no_lines');
    await env.model('account.move').write(id, { state: 'posted' });
    expect(await alertsOf(id)).toEqual({});
  });
});
