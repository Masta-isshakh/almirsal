import { NextResponse } from 'next/server';
import { serializeError } from '@/lib/server/rpc';
import { getPublicEnvironment } from '@/lib/server/public';
import { kioskCheck, kioskEmployees, kioskKey } from '@/packages/apps/hr/attendance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/kiosk — `{ key, op: 'employees' | 'check', ... }`; the key is the kiosk secret, no session. */
export async function POST(request: Request): Promise<Response> {
  let body: { key?: string; op?: string; search?: string; employeeId?: number; barcode?: string; pin?: string };
  try { body = (await request.json()) as typeof body; } catch { return NextResponse.json({ error: serializeError(new Error('Invalid JSON body')) }, { status: 400 }); }
  try {
    const env = await getPublicEnvironment();
    if (!body.key || body.key !== (await kioskKey(env))) return NextResponse.json({ error: { kind: 'access_denied', message: { en: 'Invalid kiosk key.', ar: 'مفتاح الكشك غير صالح.' } } }, { status: 403 });
    if (body.op === 'employees') return NextResponse.json({ result: await kioskEmployees(env, body.search ?? '') });
    if (body.op === 'check') return NextResponse.json({ result: await kioskCheck(env, { employeeId: body.employeeId ? Number(body.employeeId) : undefined, barcode: body.barcode, pin: body.pin }) });
    return NextResponse.json({ error: serializeError(new Error(`Unknown op ${body.op}`)) }, { status: 400 });
  } catch (error) {
    const payload = serializeError(error);
    return NextResponse.json({ error: payload }, { status: payload.kind === 'user_error' ? 422 : 500 });
  }
}
