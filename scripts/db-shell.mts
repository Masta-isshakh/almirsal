/** Ad-hoc query against the local PGlite database: npx tsx scripts/db-shell.mts "SELECT ..." */
import { pgliteDatabase } from '../packages/engine/db/pglite.js';
const db = pgliteDatabase(process.env.PGLITE_DIR ?? '.pglite');
const sql = process.argv[2] ?? 'SELECT 1';
try {
  const result = await db.query(sql);
  console.log(JSON.stringify(result.rows, null, 1));
} finally {
  await db.close?.();
}
