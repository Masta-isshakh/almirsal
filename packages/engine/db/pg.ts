import type { Pool, PoolClient } from 'pg';
import type { Database, Queryable, QueryResult, Row } from './types.js';

/** node-postgres adapter, for a directly reachable Postgres (dev/CI). */
export function pgDatabase(pool: Pool): Database {
  const wrap = (target: Pool | PoolClient): Queryable => ({
    async query<T extends Row = Row>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
      const result = await target.query(text, params);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? result.rows.length };
    },
  });

  return {
    query: wrap(pool).query,
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const value = await fn(wrap(client));
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
