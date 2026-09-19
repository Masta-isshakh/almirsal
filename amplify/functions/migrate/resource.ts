import { defineFunction } from '@aws-amplify/backend';

/**
 * Initialises the database at deploy time: schema sync + Part I seed over
 * the Data API. Runs inside the region (~1–2 minutes on a fresh cluster)
 * with a 15-minute budget, so the web tier never bootstraps in a request.
 */
export const migrate = defineFunction({
  name: 'rodeo-migrate',
  entry: './handler.ts',
  runtime: 22,
  timeoutSeconds: 900,
  memoryMB: 1024,
});
