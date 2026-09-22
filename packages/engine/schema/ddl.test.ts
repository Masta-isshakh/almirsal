import { describe, expect, it } from 'vitest';
import { pgliteDatabase } from '../db/pglite.js';
import { testRegistry } from '../testing/registry.js';
import { allTables, generateDdl, sqlTypeOf, syncSchema, viewDdl } from './ddl.js';

describe('schema', () => {
  const registry = testRegistry();

  it('maps field types to Postgres types', () => {
    const order = registry.models['sale.order'].fields;
    expect(sqlTypeOf(order.name)).toBe('varchar');
    expect(sqlTypeOf(order.amount_total)).toBe('numeric');
    expect(sqlTypeOf(order.partner_id)).toBe('integer');
    expect(sqlTypeOf(order.date_order)).toBe('timestamp');
    expect(sqlTypeOf(order.order_line)).toBeNull();
    expect(sqlTypeOf(order.tag_ids)).toBeNull();
  });

  it('keeps every identifier within the 63-byte Postgres limit', () => {
    for (const table of allTables(registry)) {
      expect(table.name.length, table.name).toBeLessThanOrEqual(63);
      for (const column of table.columns) expect(column.name.length).toBeLessThanOrEqual(63);
    }
  });

  it('gives symmetric many2many pairs one shared relation table', () => {
    const users = registry.models['res.users'].fields.group_ids;
    const groups = registry.models['res.groups'].fields.user_ids;
    expect(users.m2mTable).toBe(groups.m2mTable);
    expect(users.m2mColumn1).toBe(groups.m2mColumn2);
    expect(users.m2mColumn2).toBe(groups.m2mColumn1);
  });

  it('generates a DDL script for the whole registry', () => {
    const ddl = generateDdl(registry);
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "sale_order"');
    expect(ddl).toContain('"partner_id" integer');
    expect(ddl).toContain('REFERENCES "res_partner" ("id") ON DELETE RESTRICT DEFERRABLE');
    expect(ddl.split('\n').length).toBeGreaterThan(1000);
  });

  it('creates the full schema in Postgres and is idempotent', async () => {
    const db = pgliteDatabase();
    try {
      const first = await syncSchema(db, registry);
      expect(first.tablesCreated.length).toBe(allTables(registry).length);
      expect(first.foreignKeysAdded).toBeGreaterThan(500);

      const second = await syncSchema(db, registry);
      expect(second.skipped).toBe(true);
      const forced = await syncSchema(db, registry, { force: true });
      expect(forced.tablesCreated).toEqual([]);
      expect(forced.columnsAdded).toEqual([]);
      expect(forced.foreignKeysAdded).toBe(0);

      const count = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
      );
      expect(Number(count.rows[0].n)).toBe(allTables(registry).length);
      // Reporting models are views over the business tables, recreated on every sync.
      const views = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM information_schema.views WHERE table_schema = current_schema()`);
      expect(Number(views.rows[0].n)).toBe(viewDdl(registry).length);
      expect(viewDdl(registry).length).toBeGreaterThan(10);
      expect(forced.viewsCreated).toBe(viewDdl(registry).length);
      const analysis = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM sale_report`);
      expect(analysis.rows[0].n).toBe('0');
    } finally {
      await db.close?.();
    }
  }, 120_000);
});
