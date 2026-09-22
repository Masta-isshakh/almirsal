import { Environment } from '@engine/orm/env';
import { getDatabase } from './db';
import { getRegistry } from './registry';

/**
 * A superuser environment for public endpoints (attendance kiosk, cron):
 * no session, acting as the lowest-numbered active user so audit columns
 * keep a valid author.
 */
export async function getPublicEnvironment(lang: 'en_US' | 'ar_001' = 'en_US'): Promise<Environment> {
  const db = await getDatabase();
  const row = await db.query<{ id: number }>(`SELECT id FROM res_users WHERE coalesce(active, true) ORDER BY id LIMIT 1`);
  return new Environment({ registry: getRegistry(), db, uid: Number(row.rows[0]?.id ?? 1), lang, companyIds: [1], superuser: true });
}
