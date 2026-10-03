import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgliteDatabase } from '../packages/engine/db/pglite.js';
import type { Database } from '../packages/engine/db/types.js';
import { syncSchema } from '../packages/engine/schema/ddl.js';
import { loadSeed } from '../packages/engine/seed/load.js';
import { testRegistry } from '../packages/engine/testing/registry.js';
import { Environment } from '../packages/engine/orm/env.js';
import { clearModelHooks } from '../packages/engine/orm/hooks.js';
import { registerApps } from '../packages/apps/index.js';
import { portalLang } from '../lib/server/portal.js';

/**
 * A public page answers in the reader's language: what the link asks for, else
 * the language on their contact, else what their browser asks for. Odoo writes
 * to a customer in the language on their contact, and so does this.
 */
const registry = testRegistry();
let db: Database;
let env: Environment;

beforeAll(async () => {
  db = pgliteDatabase();
  await syncSchema(db, registry);
  await loadSeed(db, registry);
  clearModelHooks();
  registerApps(registry);
  env = new Environment({ registry, db, uid: 2, companyIds: [1], superuser: true });
}, 240_000);

afterAll(async () => { await db.close?.(); });

const ask = (headers: Record<string, string> = {}) => new Request('https://example.com/my/orders/1', { headers });

describe('the language of a public page', () => {
  it('does what the link asks', async () => {
    expect(await portalLang(null, null, new URL('https://x/my/orders/1?lang=ar_001'), ask())).toBe('ar_001');
    expect(await portalLang(null, null, new URL('https://x/my/orders/1?lang=en_US'), ask({ 'accept-language': 'ar' }))).toBe('en_US');
  });

  it('follows the language on the contact', async () => {
    const arabic = await env.model('res.partner').create({ name: 'زبون', lang: 'ar_001' });
    const english = await env.model('res.partner').create({ name: 'Customer', lang: 'en_US' });
    expect(await portalLang(env, arabic, new URL('https://x/my/orders/1'), ask())).toBe('ar_001');
    // The contact's language wins over the browser's.
    expect(await portalLang(env, english, new URL('https://x/my/orders/1'), ask({ 'accept-language': 'ar,en' }))).toBe('en_US');
  });

  it('falls back to the browser, then to English', async () => {
    // A contact whose language was never set: the browser decides.
    const nameless = await env.model('res.partner').create({ name: 'No Language', lang: false });
    expect(await portalLang(env, nameless, new URL('https://x/my/orders/1'), ask({ 'accept-language': 'ar-SA,ar;q=0.9' }))).toBe('ar_001');
    expect(await portalLang(env, nameless, new URL('https://x/my/orders/1'), ask({ 'accept-language': 'fr-FR,fr;q=0.9' }))).toBe('en_US');
    expect(await portalLang(null, null, new URL('https://x/my/orders/1'), ask())).toBe('en_US');
  });
});
