import { pgliteDatabase } from '../packages/engine/db/pglite.js';
import { syncSchema } from '../packages/engine/schema/ddl.js';
import { testRegistry } from '../packages/engine/testing/registry.js';
import { loadSeed } from '../packages/engine/seed/load.js';

const registry = testRegistry();
const db = pgliteDatabase();
await syncSchema(db, registry);
const report = await loadSeed(db, registry);
console.log('unresolved', report.unresolved.length);
const byField: Record<string, number> = {};
for (const u of report.unresolved) { const k = u.replace(/#\d+/, '').split(' ')[0]; byField[k] = (byField[k] ?? 0) + 1; }
console.log(byField);
console.log(report.unresolved.slice(0, 40).join('\n'));
console.log('ignored', report.ignoredFields.join(', '));
await db.close?.();
