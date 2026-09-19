import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgliteDatabase } from '../db/pglite.js';
import type { Database } from '../db/types.js';
import { syncSchema } from '../schema/ddl.js';
import { testRegistry } from '../testing/registry.js';
import { Environment } from '../orm/env.js';
import { loadSeed, type SeedReport } from './load.js';

const registry = testRegistry();
let db: Database;
let report: SeedReport;

beforeAll(async () => {
  db = pgliteDatabase();
  await syncSchema(db, registry);
  report = await loadSeed(db, registry);
}, 240_000);

afterAll(async () => { await db.close?.(); });

describe('seed', () => {
  it('loads every captured default record', () => {
    expect(report.inserted['res.currency']).toBe(170);
    expect(report.inserted['res.country']).toBe(251);
    expect(report.inserted['account.account']).toBe(169);
    expect(report.inserted['res.groups']).toBe(89);
    expect(report.inserted['knowledge.article']).toBe(64);
    expect(report.inserted['mail.template']).toBe(59);
    expect(report.inserted['res.company']).toBe(1);
    expect(report.inserted['res.users']).toBe(1);
  });

  it('resolves display-name references', async () => {
    const env = new Environment({ registry, db, uid: 2, superuser: true });
    const [company] = await env.model('res.company').read(1, ['currency_id', 'country_id', 'name']);
    expect(company.currency_id).toEqual([156, 'QAR']);
    expect((company.country_id as [number, string])[1]).toBe('Qatar');

    const [journal] = await env.model('account.journal').read(8, ['default_account_id', 'code']);
    expect(journal.code).toBe('INV');
    expect((journal.default_account_id as [number, string])[1]).toContain('Sales Account');

    const [product] = await env.model('product.template').read(1, ['categ_id', 'name']);
    expect((product.categ_id as [number, string])[1]).toBe('Services');
  });

  it('links x2many ids and stores Arabic translations', async () => {
    const env = new Environment({ registry, db, uid: 2, superuser: true });
    const [user] = await env.model('res.users').read(2, ['group_ids', 'company_ids', 'login']);
    expect(user.login).toBe('mastaisshakh@gmail.com');
    expect((user.group_ids as number[]).length).toBeGreaterThan(10);
    expect(user.company_ids).toEqual([1]);

    const translation = await db.query<{ value: string }>(
      `SELECT value FROM ir_translation WHERE res_model = 'account.journal' AND res_id = 8 AND field_name = 'name' AND lang = 'ar_001'`,
    );
    expect(translation.rows[0].value).toBe('المبيعات');
  });

  it('continues identity sequences after the explicit ids', async () => {
    const env = new Environment({ registry, db, uid: 2, superuser: true });
    const id = await env.model('res.currency').create({ name: 'XTS', symbol: 'X', position: 'after', decimal_places: 2 });
    const max = await db.query<{ m: number }>(`SELECT max("id") AS m FROM res_currency WHERE "id" <> $1`, [id]);
    expect(id).toBeGreaterThan(Number(max.rows[0].m));
  });

  it('is idempotent and skips entirely once the marker is set', async () => {
    const again = await loadSeed(db, registry);
    expect(again.alreadyLoaded).toBe(true);
    const forced = await loadSeed(db, registry, { force: true });
    expect(forced.alreadyLoaded).toBe(false);
    expect(Object.values(forced.inserted).reduce((a, b) => a + b, 0)).toBe(0);
  }, 120_000);

  it('creates name-only comodels on demand and reports the rest', async () => {
    const formats = await db.query<{ name: string }>(`SELECT name FROM report_paperformat ORDER BY name`);
    expect(formats.rows.map((row) => row.name)).toContain('A4 Label Sheet');
    // Knowledge template articles have no name in the export; nothing else is unresolved.
    const other = report.unresolved.filter((entry) => !entry.startsWith('knowledge.article#'));
    expect(other).toEqual(['uom.uom#9.relative_uom_id = "cm"']);
  });
});
