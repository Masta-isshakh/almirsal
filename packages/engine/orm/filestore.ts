/**
 * Where a binary payload lives. Odoo keeps an attachment's bytes in a file store
 * and only its key (`store_fname`) in the row; without a store the bytes stay in
 * the row, which is what this build did until now — and what Aurora's Data API
 * cannot carry beyond a megabyte.
 *
 * The apps only know this interface. The Next.js layer registers the real store
 * (S3, from `amplify_outputs.json`) at startup, and a test registers a store in
 * memory, so nothing here needs AWS to be exercised.
 */
export interface FileStore {
  /** Write the bytes under `key`, replacing whatever was there. */
  put(key: string, bytes: Uint8Array, contentType?: string): Promise<void>;
  /** The bytes, or null when the key is not in the store. */
  get(key: string): Promise<Uint8Array | null>;
  /** Remove the key; a key that is not there is not an error. */
  delete(key: string): Promise<void>;
  /** For logs and the health page. */
  readonly description: string;
}

let store: FileStore | null = null;

/** Register the store (or `null` to keep payloads in the database). */
export function setFileStore(next: FileStore | null): void {
  store = next;
}

export function getFileStore(): FileStore | null {
  return store;
}

/** A store in memory: what the tests use, and a safe default for a dev box. */
export function memoryFileStore(): FileStore & { keys: () => string[] } {
  const files = new Map<string, Uint8Array>();
  return {
    description: 'memory',
    put: async (key, bytes) => { files.set(key, bytes); },
    get: async (key) => files.get(key) ?? null,
    delete: async (key) => { files.delete(key); },
    keys: () => [...files.keys()],
  };
}
