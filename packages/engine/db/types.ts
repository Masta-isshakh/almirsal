/**
 * The minimal database surface the ORM needs. Three adapters implement it:
 *
 *  - `pglite.ts`  — in-process WASM Postgres for tests and local dev
 *  - `pg.ts`      — node-postgres pool for a reachable Postgres
 *  - `rds-data.ts` (in amplify/) — the Aurora Data API, so production Lambdas
 *    need no VPC, NAT Gateway or RDS Proxy (the cheapest Aurora path)
 *
 * Statements use `$1, $2…` placeholders; adapters translate if they must.
 */

export type Row = Record<string, unknown>;

export interface QueryResult<T extends Row = Row> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T extends Row = Row>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Database extends Queryable {
  /** Run `fn` inside a transaction; rethrows after rollback. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}
