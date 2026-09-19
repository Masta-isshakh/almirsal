import type { Database } from '@engine/db/types';
import { syncSchema } from '@engine/schema/ddl';
import { loadSeed } from '@engine/seed/load';
import { getRegistry } from './registry';
import { registerApps } from '@/packages/apps/index';

/**
 * Picks the database for this deployment, cheapest option first:
 *
 *  1. `RODEO_DB_CLUSTER_ARN` + `RODEO_DB_SECRET_ARN` → Aurora Data API
 *     (production on Amplify Hosting; nothing runs in a VPC)
 *  2. `DATABASE_URL`                                → node-postgres
 *  3. nothing                                       → PGlite in `.pglite/`
 *     (local `npm run dev`, no server to install)
 *
 * On first use the schema is synced and Part I seed loaded. Both are
 * idempotent, so a cold start on an already-initialised database costs one
 * information_schema query.
 */
let instance: Promise<Database> | undefined;

async function connect(): Promise<Database> {
  registerApps();
  const registry = getRegistry();
  let db: Database;

  if (process.env.RODEO_DB_CLUSTER_ARN && process.env.RODEO_DB_SECRET_ARN) {
    const { rdsDataDatabase } = await import('@engine/db/rds-data');
    db = rdsDataDatabase({
      clusterArn: process.env.RODEO_DB_CLUSTER_ARN,
      secretArn: process.env.RODEO_DB_SECRET_ARN,
      database: process.env.RODEO_DB_NAME ?? 'rodeo',
      region: process.env.RODEO_DB_REGION ?? process.env.AWS_REGION,
    });
  } else if (process.env.DATABASE_URL) {
    const { default: pg } = await import('pg');
    const { pgDatabase } = await import('@engine/db/pg');
    db = pgDatabase(new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 }));
  } else {
    const { pgliteDatabase } = await import('@engine/db/pglite');
    db = pgliteDatabase(process.env.PGLITE_DIR ?? '.pglite');
  }

  if (process.env.RODEO_SKIP_MIGRATE !== '1') {
    await syncSchema(db, registry);
    await loadSeed(db, registry);
  }
  return db;
}

export function getDatabase(): Promise<Database> {
  if (!instance) instance = connect().catch((error) => { instance = undefined; throw error; });
  return instance;
}
