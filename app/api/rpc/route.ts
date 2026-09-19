import { NextResponse } from 'next/server';
import { dispatch, serializeError, type RpcRequest } from '@/lib/server/rpc';
import { getEnvironment, getRequestLang, getSessionUser } from '@/lib/server/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/rpc — `{ method, model?, params? }` → `{ result }` or `{ error }`. */
export async function POST(request: Request): Promise<Response> {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: { kind: 'session_expired', title: { en: 'Session expired', ar: 'انتهت الجلسة' }, message: { en: 'Please log in again.', ar: 'يرجى تسجيل الدخول مرة أخرى.' } } }, { status: 401 });
  }
  let body: RpcRequest;
  try {
    body = (await request.json()) as RpcRequest;
  } catch {
    return NextResponse.json({ error: serializeError(new Error('Invalid JSON body')) }, { status: 400 });
  }
  try {
    const env = await getEnvironment(user, await getRequestLang(user));
    const result = await dispatch(env, body);
    return NextResponse.json({ result: result ?? null });
  } catch (error) {
    const payload = serializeError(error);
    const status = payload.kind === 'access_error' || payload.kind === 'access_denied' ? 403
      : payload.kind === 'server_error' ? 500 : 422;
    if (status === 500) console.error(error);
    return NextResponse.json({ error: payload }, { status });
  }
}
