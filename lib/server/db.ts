import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
 * The migration Lambda initialises the database at deploy time; the sync
 * and seed calls here are the local-dev path and a self-heal. On an
 * initialised database they cost two marker lookups.
 */
let instance: Promise<Database> | undefined;

interface AuroraConfig { clusterArn: string; secretArn: string; database: string; region?: string }

/**
 * Aurora Data API settings: explicit env vars win, else the `custom.database`
 * block that `amplify/backend.ts` writes into amplify_outputs.json at deploy.
 */
function auroraConfig(): AuroraConfig | null {
  if (process.env.RODEO_DB_CLUSTER_ARN && process.env.RODEO_DB_SECRET_ARN) {
    return {
      clusterArn: process.env.RODEO_DB_CLUSTER_ARN,
      secretArn: process.env.RODEO_DB_SECRET_ARN,
      database: process.env.RODEO_DB_NAME ?? 'rodeo',
      region: process.env.RODEO_DB_REGION ?? process.env.AWS_REGION,
    };
  }
  try {
    const path = resolve(process.cwd(), 'amplify_outputs.json');
    if (!existsSync(path)) return null;
    const outputs = JSON.parse(readFileSync(path, 'utf8')) as { custom?: { database?: { clusterArn?: string; secretArn?: string; databaseName?: string; region?: string } } };
    const db = outputs.custom?.database;
    if (!db?.clusterArn || !db.secretArn) return null;
    return { clusterArn: db.clusterArn, secretArn: db.secretArn, database: db.databaseName ?? 'rodeo', region: db.region ?? process.env.AWS_REGION };
  } catch {
    return null;
  }
}

async function connect(): Promise<Database> {
  registerApps();
  const registry = getRegistry();
  let db: Database;

  const aurora = auroraConfig();
  if (aurora) {
    const { rdsDataDatabase } = await import('@engine/db/rds-data');
    db = rdsDataDatabase(aurora);
  } else if (process.env.DATABASE_URL) {
    const { default: pg } = await import('pg');
    const { pgDatabase } = await import('@engine/db/pg');
    db = pgDatabase(new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 }));
  } else {
    if (process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.AWS_EXECUTION_ENV) {
      // Deployed without a database: refuse loudly instead of writing to an
      // ephemeral /tmp Postgres that would silently lose every record.
      throw new Error('No database configured: deploy the Amplify backend so amplify_outputs.json carries custom.database, or set RODEO_DB_CLUSTER_ARN / RODEO_DB_SECRET_ARN.');
    }
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
