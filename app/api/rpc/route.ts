import { NextResponse } from 'next/server';
import { dispatch, serializeError, type RpcRequest } from '@/lib/server/rpc';
import { getEnvironment, getRequestLang, getSessionUser, invalidateSessionCache } from '@/lib/server/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WRITE_METHODS = new Set(['create', 'write', 'unlink', 'webSave', 'callButton', 'toggleActive', 'copy']);
const ACCESS_MODELS = new Set(['res.users', 'res.groups', 'res.company']);

function statusOf(kind: string): number {
  return kind === 'access_error' || kind === 'access_denied' ? 403 : kind === 'server_error' ? 500 : 422;
}

/**
 * POST /api/rpc — `{ method, model?, params?, context? }` → `{ result }` or
 * `{ error }`; or a batch `{ calls: [...] }` → `{ results: [...] }`, the
 * calls running concurrently (each is its own transaction).
 */
export async function POST(request: Request): Promise<Response> {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: { kind: 'session_expired', title: { en: 'Session expired', ar: 'انتهت الجلسة' }, message: { en: 'Please log in again.', ar: 'يرجى تسجيل الدخول مرة أخرى.' } } }, { status: 401 });
  }
  let body: RpcRequest & { calls?: RpcRequest[] };
  try {
    body = (await request.json()) as RpcRequest & { calls?: RpcRequest[] };
  } catch {
    return NextResponse.json({ error: serializeError(new Error('Invalid JSON body')) }, { status: 400 });
  }
  const lang = await getRequestLang(user);
  const run = async (call: RpcRequest): Promise<{ result?: unknown; error?: ReturnType<typeof serializeError> }> => {
    try {
      const env = await getEnvironment(user, lang);
      const result = await dispatch(env, call);
      // Access rights changed: the cached session user must be re-read.
      if (WRITE_METHODS.has(call.method) && call.model && ACCESS_MODELS.has(call.model)) invalidateSessionCache();
      return { result: result ?? null };
    } catch (error) {
      const payload = serializeError(error);
      if (statusOf(payload.kind) === 500) console.error(error);
      return { error: payload };
    }
  };

  if (Array.isArray(body.calls)) {
    const results = await Promise.all(body.calls.slice(0, 50).map(run));
    return NextResponse.json({ results });
  }
  const outcome = await run(body);
  if (outcome.error) return NextResponse.json({ error: outcome.error }, { status: statusOf(outcome.error.kind) });
  return NextResponse.json({ result: outcome.result });
}
