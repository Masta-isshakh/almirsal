import { rdsDataDatabase } from '../../../packages/engine/db/rds-data.js';
import { loadRegistry, type ExtraModels, type RawSpec } from '../../../packages/engine/registry/spec-loader.js';
import { syncSchema } from '../../../packages/engine/schema/ddl.js';
import { brandCompany, loadSeed } from '../../../packages/engine/seed/load.js';
import spec from '../../../registry/odoo_spec.json';
import extra from '../../../registry/extra-models.json';

/**
 * Invoked by the CloudFormation trigger after the Aurora cluster is created
 * (and again whenever this code changes). Idempotent: markers in
 * `ir_config_parameter` make a no-op run a couple of queries.
 */
export const handler = async (): Promise<Record<string, unknown>> => {
  const db = rdsDataDatabase({
    clusterArn: process.env.DB_CLUSTER_ARN!,
    secretArn: process.env.DB_SECRET_ARN!,
    database: process.env.DB_NAME ?? 'rodeo',
    region: process.env.AWS_REGION,
  });
  const registry = loadRegistry(spec as unknown as RawSpec, extra as unknown as ExtraModels);

  const started = Date.now();
  const schema = await syncSchema(db, registry);
  const seed = await loadSeed(db, registry);
  await brandCompany(db);
  const summary = {
    seconds: Math.round((Date.now() - started) / 1000),
    schema: { skipped: schema.skipped, tablesCreated: schema.tablesCreated.length, columnsAdded: schema.columnsAdded.length, foreignKeysAdded: schema.foreignKeysAdded },
    seed: { alreadyLoaded: seed.alreadyLoaded, inserted: Object.values(seed.inserted).reduce((a, b) => a + b, 0), unresolved: seed.unresolved.length },
  };
  console.log(JSON.stringify(summary));
  return summary;
};
