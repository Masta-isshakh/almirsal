import { readFileSync } from 'node:fs';
import { loadRegistry } from '../../packages/engine/registry/spec-loader.js';
import { pgliteDatabase } from '../../packages/engine/db/pglite.js';
import { syncSchema, viewDdl } from '../../packages/engine/schema/ddl.js';
const r = loadRegistry(JSON.parse(readFileSync('registry/odoo_spec.json', 'utf8')), JSON.parse(readFileSync('registry/extra-models.json', 'utf8')));
const db = pgliteDatabase();
const views = viewDdl(r);
const noViews = { ...r, models: Object.fromEntries(Object.entries(r.models).filter(([, v]) => !v.sqlView)) };
await syncSchema(db, noViews as any);
for (const v of views) {
  try { await db.query(v.sql); console.log('OK  ', v.table); }
  catch (e) { console.log('FAIL', v.table, String((e as Error).message).slice(0, 200)); }
}
await db.close?.();
