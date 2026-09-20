'use client';

import type { I18n } from '@engine/i18n/types';

/** Error payload returned by `/api/rpc`, shaped like `OrmError.toJSON()`. */
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

/** Subscribe to every RPC error (the WebClient shows the Odoo-style dialog). */
export function onRpcError(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function rpc<T = unknown>(method: string, model: string | null, params: Record<string, unknown> = {}, options: { silent?: boolean; context?: Record<string, unknown> } = {}): Promise<T> {
  const response = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, model: model ?? undefined, params, context: options.context }),
  });
  const body = (await response.json()) as { result?: T; error?: RpcErrorPayload };
  if (!response.ok || body.error) {
    const error = new RpcError(body.error ?? { kind: 'server_error', title: { en: 'Error', ar: 'خطأ' }, message: { en: response.statusText, ar: response.statusText } }, response.status);
    if (error.payload.kind === 'session_expired' && typeof window !== 'undefined') {
      window.location.href = `/web/login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    }
    if (!options.silent) listeners.forEach((listener) => listener(error));
    throw error;
  }
  return body.result as T;
}
