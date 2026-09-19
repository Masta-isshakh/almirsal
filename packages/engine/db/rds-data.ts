import {
  BeginTransactionCommand,
  CommitTransactionCommand,
  ExecuteStatementCommand,
  RDSDataClient,
  RollbackTransactionCommand,
  type SqlParameter,
} from '@aws-sdk/client-rds-data';
import type { Database, Queryable, QueryResult, Row } from './types.js';

/**
 * Aurora Data API adapter. Runs the ORM over HTTPS + IAM with no VPC, which
 * is what keeps the production bill at storage-only while idle.
 *
 * The Data API differs from a driver in three ways this adapter hides:
 *  - parameters are named (`:p1`), not positional (`$1`)
 *  - there is no array parameter type, so `= ANY($1)` arrays are expanded
 *    into `ARRAY[:p1_0, :p1_1]` (and `'{}'` when empty)
 *  - transactions are explicit ids passed with every statement
 *
 * Results are requested as JSON (`formatRecordsAs`) so column names come
 * back exactly as selected.
 */

export interface RdsDataOptions {
  clusterArn: string;
  secretArn: string;
  database: string;
  region?: string;
  client?: RDSDataClient;
}

function toParameter(name: string, value: unknown): SqlParameter {
  if (value === null || value === undefined) return { name, value: { isNull: true } };
  if (typeof value === 'boolean') return { name, value: { booleanValue: value } };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { name, value: { longValue: value } } : { name, value: { doubleValue: value } };
  }
  if (value instanceof Date) return { name, value: { stringValue: value.toISOString().slice(0, 19).replace('T', ' ') }, typeHint: 'TIMESTAMP' };
  if (typeof value === 'object') return { name, value: { stringValue: JSON.stringify(value) } };
  return { name, value: { stringValue: String(value) } };
}

/** Rewrite `$n` placeholders to named parameters, expanding arrays. */
export function prepare(text: string, params: unknown[]): { sql: string; parameters: SqlParameter[] } {
  const parameters: SqlParameter[] = [];
  const sql = text.replace(/\$(\d+)/g, (_match, index: string) => {
    const position = Number(index) - 1;
    const value = params[position];
    if (Array.isArray(value)) {
      if (value.length === 0) return `'{}'`;
      const names = value.map((item, i) => {
        const name = `p${index}_${i}`;
        parameters.push(toParameter(name, item));
        return `:${name}`;
      });
      return `ARRAY[${names.join(', ')}]`;
    }
    const name = `p${index}`;
    if (!parameters.some((parameter) => parameter.name === name)) parameters.push(toParameter(name, value));
    return `:${name}`;
  });
  return { sql, parameters };
}

/** How long to keep retrying while a 0-ACU cluster wakes up (it takes ~15 s). */
const RESUME_WAIT_MS = 120_000;

function isResuming(error: unknown): boolean {
  const name = (error as { name?: string })?.name ?? '';
  const message = (error as { message?: string })?.message ?? '';
  return name === 'DatabaseResumingException' || /resuming after being auto-paused/i.test(message);
}

/**
 * An auto-paused cluster answers `DatabaseResumingException` until it is
 * back; the Data API does not wait for it. Poll with a short backoff instead
 * of failing the deploy-time migration or a user's first request.
 */
async function withResume<T>(fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  let delay = 2_000;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (!isResuming(error) || Date.now() - started > RESUME_WAIT_MS) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 1.5, 8_000);
    }
  }
}

export function rdsDataDatabase(options: RdsDataOptions): Database {
  const client = options.client ?? new RDSDataClient({ region: options.region });

  const execute = async <T extends Row>(text: string, params: unknown[], transactionId?: string): Promise<QueryResult<T>> => {
    const { sql, parameters } = prepare(text, params);
    const response = await withResume(() => client.send(new ExecuteStatementCommand({
      resourceArn: options.clusterArn,
      secretArn: options.secretArn,
      database: options.database,
      sql,
      parameters,
      transactionId,
      formatRecordsAs: 'JSON',
      continueAfterTimeout: false,
    })));
    const rows = response.formattedRecords ? (JSON.parse(response.formattedRecords) as T[]) : [];
    return { rows, rowCount: response.numberOfRecordsUpdated ?? rows.length };
  };

  const queryable = (transactionId?: string): Queryable => ({
    query: <T extends Row = Row>(text: string, params: unknown[] = []) => execute<T>(text, params, transactionId),
  });

  return {
    query: queryable().query,
    async transaction(fn) {
      const begun = await withResume(() => client.send(new BeginTransactionCommand({
        resourceArn: options.clusterArn, secretArn: options.secretArn, database: options.database,
      })));
      const transactionId = begun.transactionId!;
      try {
        const value = await fn(queryable(transactionId));
        await client.send(new CommitTransactionCommand({ resourceArn: options.clusterArn, secretArn: options.secretArn, transactionId }));
        return value;
      } catch (error) {
        await client.send(new RollbackTransactionCommand({ resourceArn: options.clusterArn, secretArn: options.secretArn, transactionId }));
        throw error;
      }
    },
  };
}
