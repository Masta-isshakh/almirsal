import { PGlite } from '@electric-sql/pglite';
import type { Database, Queryable, QueryResult, Row } from './types.js';

/**
 * In-process Postgres (WASM). Used by the test suite and `npm run dev` when
 * no `DATABASE_URL` is set, so the ORM is exercised against real Postgres
 * semantics — recursive CTEs, ILIKE, jsonb, deferred constraints — without a
 * server. Pass a directory to persist between runs.
 */
export function pgliteDatabase(dataDir?: string): Database & { raw: PGlite } {
  const raw = dataDir ? new PGlite(dataDir) : new PGlite();

  const wrap = (target: PGlite | Parameters<Parameters<PGlite['transaction']>[0]>[0]): Queryable => ({
    async query<T extends Row = Row>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
      const result = await target.query<T>(text, params);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  });

  const base = wrap(raw);
  return {
    raw,
    query: base.query,
    transaction: (fn) => raw.transaction((tx) => fn(wrap(tx))),
    close: () => raw.close(),
  };
}
