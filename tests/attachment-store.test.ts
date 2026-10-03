import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pgliteDatabase } from '../packages/engine/db/pglite.js';
import type { Database } from '../packages/engine/db/types.js';
import { syncSchema } from '../packages/engine/schema/ddl.js';
import { loadSeed } from '../packages/engine/seed/load.js';
import { testRegistry } from '../packages/engine/testing/registry.js';
import { Environment } from '../packages/engine/orm/env.js';
import { clearModelHooks } from '../packages/engine/orm/hooks.js';
import { memoryFileStore, setFileStore } from '../packages/engine/orm/filestore.js';
import { registerApps } from '../packages/apps/index.js';
import { attachmentPayload } from '../packages/apps/base/attachments.js';

/**
 * Attachment payloads belong in the file store, as in Odoo: the row keeps the
 * key, the size and the checksum. It is not only about disk — Aurora's Data API
 * refuses a result over a megabyte, so a large attachment kept in the row could
 * not be read back at all.
 */
const registry = testRegistry();
let db: Database;
let env: Environment;

const base64 = (size: number, fill = 7): string => Buffer.alloc(size, fill).toString('base64');

beforeAll(async () => {
  db = pgliteDatabase();
  await syncSchema(db, registry);
  await loadSeed(db, registry);
  clearModelHooks();
  registerApps(registry);
  env = new Environment({ registry, db, uid: 2, companyIds: [1], superuser: true });
}, 240_000);

afterEach(() => { setFileStore(null); });
afterAll(async () => { await db.close?.(); });

describe('attachments with a file store', () => {
  it('writes the payload to the store and keeps the key on the row', async () => {
    const store = memoryFileStore();
    setFileStore(store);
    const attachments = env.model('ir.attachment');
    const id = await attachments.create({ name: 'contract.pdf', mimetype: 'application/pdf', datas: base64(300_000), res_model: 'sale.order', res_id: 1 });

    const [row] = await attachments.read(id, ['store_fname', 'datas', 'file_size', 'checksum']);
    expect(String(row.store_fname)).toMatch(/^attachments\/sale\.order\/1\/[0-9a-f-]{36}\.pdf$/);
    expect(row.datas).toBe(false);
    expect(row.file_size).toBe(300_000);
    expect(String(row.checksum)).toMatch(/^[0-9a-f]{40}$/);
    expect(store.keys()).toEqual([String(row.store_fname)]);

    // And it reads back byte for byte, which is what the download route serves.
    const payload = await attachmentPayload(env, id);
    expect(payload?.bytes.length).toBe(300_000);
    expect(payload?.bytes.every((byte) => byte === 7)).toBe(true);
    expect(payload?.mimetype).toBe('application/pdf');
  });

  it('leaves a small payload in the row, where one read is cheaper', async () => {
    const store = memoryFileStore();
    setFileStore(store);
    const id = await env.model('ir.attachment').create({ name: 'icon.png', mimetype: 'image/png', datas: base64(900) });
    const [row] = await env.model('ir.attachment').read(id, ['store_fname', 'datas', 'file_size']);
    expect(row.store_fname).toBeFalsy();
    expect(String(row.datas).length).toBeGreaterThan(0);
    expect(row.file_size).toBe(900);
    expect(store.keys()).toEqual([]);
    expect((await attachmentPayload(env, id))?.bytes.length).toBe(900);
  });

  it('keeps everything in the row when there is no store, and still measures it', async () => {
    setFileStore(null);
    const id = await env.model('ir.attachment').create({ name: 'big.bin', datas: base64(200_000) });
    const [row] = await env.model('ir.attachment').read(id, ['store_fname', 'datas', 'file_size', 'checksum']);
    expect(row.store_fname).toBeFalsy();
    expect(String(row.datas).length).toBeGreaterThan(0);
    // The size and the checksum are Odoo's, store or no store: the Documents
    // list prints the size.
    expect(row.file_size).toBe(200_000);
    expect(String(row.checksum)).toMatch(/^[0-9a-f]{40}$/);
    expect((await attachmentPayload(env, id))?.bytes.length).toBe(200_000);
  });

  it('replaces the object when the payload is written again, and leaves nothing behind', async () => {
    const store = memoryFileStore();
    setFileStore(store);
    const attachments = env.model('ir.attachment');
    const id = await attachments.create({ name: 'draft.pdf', datas: base64(150_000, 1) });
    const first = String((await attachments.read(id, ['store_fname']))[0].store_fname);

    await attachments.write(id, { datas: base64(150_000, 2) });
    const second = String((await attachments.read(id, ['store_fname']))[0].store_fname);
    expect(second).not.toBe(first);
    expect(store.keys()).toEqual([second]);
    const payload = await attachmentPayload(env, id);
    expect(payload?.bytes[0]).toBe(2);
  });

  it('removes the object when the attachment is deleted', async () => {
    const store = memoryFileStore();
    setFileStore(store);
    const attachments = env.model('ir.attachment');
    const id = await attachments.create({ name: 'gone.pdf', datas: base64(120_000) });
    expect(store.keys()).toHaveLength(1);
    await attachments.unlink(id);
    expect(store.keys()).toEqual([]);
    expect(await attachmentPayload(env, id)).toBeNull();
  });

  it('says nothing is there when the key has no object behind it', async () => {
    const store = memoryFileStore();
    setFileStore(store);
    const id = await env.model('ir.attachment').create({ name: 'lost.pdf', datas: base64(120_000) });
    const key = String((await env.model('ir.attachment').read(id, ['store_fname']))[0].store_fname);
    await store.delete(key);
    // A broken attachment must not read as an empty file.
    expect(await attachmentPayload(env, id)).toBeNull();
  });

  it('follows a url attachment instead of reading bytes', async () => {
    const id = await env.model('ir.attachment').create({ name: 'Website', type: 'url', url: 'https://example.com/file.pdf' });
    const payload = await attachmentPayload(env, id);
    expect(payload?.url).toBe('https://example.com/file.pdf');
    expect(payload?.bytes.length).toBe(0);
  });
});
