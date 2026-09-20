'use client';

import type { I18n } from '@engine/i18n/types';

/** Error payload returned by `/api/rpc`, shaped like `OrmError.serialize()`. */
export interface RpcErrorPayload {
  kind: string;
  title: I18n;
  message: I18n;
  data?: unknown;
  debug?: string;
}

export class RpcError extends Error {
  readonly payload: RpcErrorPayload;
  readonly status: number;
  constructor(payload: RpcErrorPayload, status: number) {
    super(payload.message?.en ?? payload.kind);
    this.payload = payload;
    this.status = status;
  }
}

type Listener = (error: RpcError) => void;
const listeners = new Set<Listener>();
const pendingListeners = new Set<(count: number) => void>();
let pendingCount = 0;

/** Subscribe to every RPC error (the WebClient shows the Odoo-style dialog). */
export function onRpcError(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Subscribe to the number of in-flight calls (progress bar). */
export function onRpcPending(listener: (count: number) => void): () => void {
  pendingListeners.add(listener);
  listener(pendingCount);
  return () => pendingListeners.delete(listener);
}

function setPending(delta: number): void {
  pendingCount = Math.max(0, pendingCount + delta);
  pendingListeners.forEach((listener) => listener(pendingCount));
}

export interface RpcOptions {
  silent?: boolean;
  context?: Record<string, unknown>;
  /** Cache the result for this many ms (reads of reference data). */
  cacheMs?: number;
}

interface Call { method: string; model?: string; params: Record<string, unknown>; context?: Record<string, unknown> }
interface Queued { call: Call; silent: boolean; resolve: (value: unknown) => void; reject: (error: RpcError) => void }

const queue: Queued[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const WRITE_METHODS = new Set(['create', 'write', 'unlink', 'webSave', 'callButton', 'toggleActive', 'copy', 'messagePost', 'sendDocument']);

/**
 * Calls made in the same tick travel in one HTTP request (`/api/rpc` with
 * `{calls: [...]}`); the server runs them concurrently. Fewer requests
 * means fewer cold SSR compute instances on Amplify, and one session
 * lookup instead of six when a form opens.
 */
function enqueue(call: Call, silent: boolean): Promise<unknown> {
  return new Promise((resolve, reject) => {
    queue.push({ call, silent, resolve, reject });
    if (!flushTimer) flushTimer = setTimeout(flush, 0);
  });
}

async function flush(): Promise<void> {
  flushTimer = null;
  const batch = queue.splice(0, queue.length);
  if (batch.length === 0) return;
  setPending(1);
  try {
    if (batch.length === 1) {
      const [item] = batch;
      const { result, error, status } = await post(item.call);
      if (error) item.reject(raise(error, status, item.silent)); else item.resolve(result);
      return;
    }
    const response = await fetch('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ calls: batch.map((item) => item.call) }) });
    const body = (await response.json()) as { results?: { result?: unknown; error?: RpcErrorPayload }[]; error?: RpcErrorPayload };
    if (!response.ok || !body.results) {
      const error = body.error ?? { kind: 'server_error', title: { en: 'Error', ar: 'خطأ' }, message: { en: response.statusText, ar: response.statusText } };
      for (const item of batch) item.reject(raise(error, response.status, item.silent));
      return;
    }
    batch.forEach((item, index) => {
      const entry = body.results![index] ?? {};
      if (entry.error) item.reject(raise(entry.error, 422, item.silent)); else item.resolve(entry.result);
    });
  } catch (error) {
    const payload = { kind: 'server_error', title: { en: 'Error', ar: 'خطأ' }, message: { en: String(error), ar: String(error) } };
    for (const item of batch) item.reject(raise(payload, 0, item.silent));
  } finally {
    setPending(-1);
  }
}

async function post(call: Call): Promise<{ result?: unknown; error?: RpcErrorPayload; status: number }> {
  const response = await fetch('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(call) });
  const body = (await response.json()) as { result?: unknown; error?: RpcErrorPayload };
  if (!response.ok && !body.error) return { error: { kind: 'server_error', title: { en: 'Error', ar: 'خطأ' }, message: { en: response.statusText, ar: response.statusText } }, status: response.status };
  return { ...body, status: response.status };
}

function raise(payload: RpcErrorPayload, status: number, silent: boolean): RpcError {
  const error = new RpcError(payload, status);
  if (payload.kind === 'session_expired' && typeof window !== 'undefined') {
    window.location.href = `/web/login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`;
  }
  if (!silent) listeners.forEach((listener) => listener(error));
  return error;
}

/* Small read cache for reference data (currencies, activity types, …). */
const cache = new Map<string, { at: number; value: Promise<unknown> }>();

/** Drop cached reads (after a write, or a language switch). */
export function clearRpcCache(prefix?: string): void {
  for (const key of [...cache.keys()]) if (!prefix || key.startsWith(prefix)) cache.delete(key);
}

export async function rpc<T = unknown>(method: string, model: string | null, params: Record<string, unknown> = {}, options: RpcOptions = {}): Promise<T> {
  const call: Call = { method, model: model ?? undefined, params, context: options.context };
  if (WRITE_METHODS.has(method)) {
    // A write invalidates cached reads of the same model.
    clearRpcCache(`${model ?? ''}|`);
  }
  if (options.cacheMs) {
    const key = `${model ?? ''}|${method}|${JSON.stringify(params)}|${JSON.stringify(options.context ?? null)}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < options.cacheMs) return hit.value as Promise<T>;
    const value = enqueue(call, Boolean(options.silent)).catch((error) => { cache.delete(key); throw error; });
    cache.set(key, { at: Date.now(), value });
    return value as Promise<T>;
  }
  return enqueue(call, Boolean(options.silent)) as Promise<T>;
}
