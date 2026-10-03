import { createHash, randomUUID } from 'node:crypto';
import { registerModelHooks, type Values } from '../../engine/orm/hooks.js';
import type { Environment } from '../../engine/orm/env.js';
import { getFileStore } from '../../engine/orm/filestore.js';

/**
 * Where an attachment's bytes go. Odoo writes them to its file store and keeps
 * only the key in `store_fname`; the row carries the bytes only when there is no
 * store. This does the same: with a store registered, anything past
 * `INLINE_LIMIT` is written to the store, and the row keeps the key, the size and
 * the checksum.
 *
 * It matters beyond disk space: Aurora's Data API refuses a statement whose
 * result passes a megabyte, so a large attachment kept in the row cannot be read
 * back at all.
 */

/** Small payloads (an icon, a signature) stay in the row: one read, no round trip. */
const INLINE_LIMIT = 64 * 1024;

const base64Of = (value: unknown): string => {
  const raw = typeof value === 'string' ? value : '';
  return raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw;
};

/** `attachments/<model>/<id>/<uuid>` — the layout `amplify/storage` grants. */
function keyFor(values: Values, name: string): string {
  const model = String(values.res_model ?? 'misc').replace(/[^a-z0-9._-]/gi, '_');
  const id = Number(values.res_id) || 0;
  const extension = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase();
  return `attachments/${model}/${id}/${randomUUID()}${extension ? `.${extension}` : ''}`;
}

/**
 * Measure the payload — Odoo keeps the size and a sha1 of every attachment —
 * and move it into the store when there is one and it is worth it.
 */
async function offload(values: Values): Promise<Values> {
  if (values.datas === undefined) return values;
  const base64 = base64Of(values.datas);
  if (!base64) return values;
  const bytes = Buffer.from(base64, 'base64');
  const out: Values = { ...values, file_size: bytes.length, checksum: createHash('sha1').update(bytes).digest('hex') };
  const store = getFileStore();
  if (!store || bytes.length < INLINE_LIMIT) return out;
  const key = keyFor(values, String(values.name ?? ''));
  await store.put(key, bytes, typeof values.mimetype === 'string' ? values.mimetype : undefined);
  out.store_fname = key;
  // The bytes are in the store now; the row keeps the key.
  out.datas = false;
  return out;
}

/** The bytes of an attachment, from the store or from the row. */
export async function attachmentPayload(env: Environment, id: number): Promise<{ bytes: Buffer; name: string; mimetype: string; url: string | null } | null> {
  const [row] = await env.model('ir.attachment').read(id, ['name', 'mimetype', 'datas', 'store_fname', 'type', 'url']).catch(() => []);
  if (!row) return null;
  const name = String(row.name ?? 'attachment');
  const mimetype = String(row.mimetype || 'application/octet-stream');
  if (row.type === 'url' && row.url) return { bytes: Buffer.alloc(0), name, mimetype, url: String(row.url) };
  const key = typeof row.store_fname === 'string' ? row.store_fname : '';
  if (key) {
    const store = getFileStore();
    const bytes = store ? await store.get(key).catch(() => null) : null;
    // A key with nothing behind it is a broken attachment, not an empty one.
    if (!bytes) return null;
    return { bytes: Buffer.from(bytes), name, mimetype, url: null };
  }
  return { bytes: Buffer.from(base64Of(row.datas), 'base64'), name, mimetype, url: null };
}

export function registerAttachments(): void {
  registerModelHooks('ir.attachment', {
    // Odoo's own default: an attachment holds bytes unless it names a URL.
    defaults: () => ({ type: 'binary' }),
    beforeCreate: (_env, values) => offload(values),
    beforeWrite: async (env, ids, values) => {
      if (values.datas === undefined) return values;
      const next = await offload(values);
      // Replacing the payload leaves the old object behind otherwise.
      if (next.store_fname !== undefined || next.datas !== undefined) await removeObjects(env, ids);
      return next;
    },
    onUnlink: async (env, ids) => { await removeObjects(env, ids); },
  });
}

/** Drop whatever these attachments hold in the store. */
async function removeObjects(env: Environment, ids: number[]): Promise<void> {
  const store = getFileStore();
  if (!store || !ids.length) return;
  const rows = await env.sudo().model('ir.attachment').read(ids, ['store_fname']).catch(() => []);
  for (const row of rows) {
    const key = typeof row.store_fname === 'string' ? row.store_fname : '';
    if (key) await store.delete(key).catch(() => undefined);
  }
}
