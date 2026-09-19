import { describe, expect, it } from 'vitest';
import { prepare } from './rds-data.js';

describe('Data API parameter preparation', () => {
  it('renames positional placeholders', () => {
    const { sql, parameters } = prepare('SELECT * FROM t WHERE a = $1 AND b = $2', ['x', 3]);
    expect(sql).toBe('SELECT * FROM t WHERE a = :p1 AND b = :p2');
    expect(parameters).toEqual([
      { name: 'p1', value: { stringValue: 'x' } },
      { name: 'p2', value: { longValue: 3 } },
    ]);
  });

  it('expands arrays for = ANY() and keeps empty arrays valid', () => {
    const { sql, parameters } = prepare('WHERE id = ANY($1) AND s = $2', [[7, 9], 'q']);
    expect(sql).toBe('WHERE id = ANY(ARRAY[:p1_0, :p1_1]) AND s = :p2');
    expect(parameters.map((p) => p.name)).toEqual(['p1_0', 'p1_1', 'p2']);
    expect(prepare('WHERE id = ANY($1)', [[]]).sql).toBe("WHERE id = ANY('{}')");
  });

  it('types nulls, booleans, floats and keeps SQL casts', () => {
    const { sql, parameters } = prepare('INSERT INTO t (a, b, c, d) VALUES ($1, $2, $3::jsonb, $4::timestamp)', [null, true, { k: 1 }, '2026-09-19 10:00:00']);
    expect(sql).toBe('INSERT INTO t (a, b, c, d) VALUES (:p1, :p2, :p3::jsonb, :p4::timestamp)');
    expect(parameters[0].value).toEqual({ isNull: true });
    expect(parameters[1].value).toEqual({ booleanValue: true });
    expect(parameters[2].value).toEqual({ stringValue: '{"k":1}' });
    expect(prepare('$1', [1.5]).parameters[0].value).toEqual({ doubleValue: 1.5 });
  });

  it('reuses a placeholder that appears twice', () => {
    const { sql, parameters } = prepare('WHERE a = $1 OR b = $1', ['v']);
    expect(sql).toBe('WHERE a = :p1 OR b = :p1');
    expect(parameters).toHaveLength(1);
  });
});

describe('auto-pause resume handling', () => {
  it('retries while the cluster reports it is resuming, then succeeds', async () => {
    const { rdsDataDatabase } = await import('./rds-data.js');
    let calls = 0;
    const client = {
      send: async () => {
        calls += 1;
        if (calls < 3) {
          const error = new Error('The Aurora DB instance db-X is resuming after being auto-paused. Please wait a few seconds and try again.');
          error.name = 'DatabaseResumingException';
          throw error;
        }
        return { formattedRecords: JSON.stringify([{ n: 1 }]), numberOfRecordsUpdated: 0 };
      },
    };
    const db = rdsDataDatabase({ clusterArn: 'a', secretArn: 'b', database: 'c', client: client as never });
    const result = await db.query<{ n: number }>('SELECT 1 AS n');
    expect(result.rows).toEqual([{ n: 1 }]);
    expect(calls).toBe(3);
  }, 20_000);

  it('does not retry other errors', async () => {
    const { rdsDataDatabase } = await import('./rds-data.js');
    const client = { send: async () => { throw new Error('syntax error'); } };
    const db = rdsDataDatabase({ clusterArn: 'a', secretArn: 'b', database: 'c', client: client as never });
    await expect(db.query('SELECT')).rejects.toThrow('syntax error');
  });
});
