import { NextResponse } from 'next/server';
import { getDatabase } from '@/lib/server/db';
import { SESSION_COOKIE, cognitoConfigured, encodeSession, hashPassword, verifyPassword } from '@/lib/server/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Local password login (when Cognito is not configured). The first login of
 * a user who has no password yet sets it — this is how the seeded admin
 * gets in on a fresh sandbox — unless `RODEO_STRICT_LOGIN=1`.
 */
export async function POST(request: Request): Promise<Response> {
  if (cognitoConfigured() && process.env.RODEO_LOCAL_LOGIN !== '1') {
    return NextResponse.json({ error: 'Use Cognito sign-in' }, { status: 400 });
  }
  const { login, password } = (await request.json()) as { login?: string; password?: string };
  if (!login || !password) return NextResponse.json({ error: 'wrong_login' }, { status: 401 });

  const db = await getDatabase();
  const found = await db.query<{ id: number; password: string | null; active: boolean | null }>(
    `SELECT id, password, active FROM res_users WHERE lower(login) = lower($1) LIMIT 1`, [login],
  );
  const user = found.rows[0];
  if (!user || user.active === false) return NextResponse.json({ error: 'wrong_login' }, { status: 401 });

  if (!user.password) {
    if (process.env.RODEO_STRICT_LOGIN === '1') return NextResponse.json({ error: 'wrong_login' }, { status: 401 });
    await db.query(`UPDATE res_users SET password = $1 WHERE id = $2`, [hashPassword(password), user.id]);
  } else if (!verifyPassword(password, user.password)) {
    return NextResponse.json({ error: 'wrong_login' }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true, uid: Number(user.id) });
  response.cookies.set(SESSION_COOKIE, encodeSession(Number(user.id)), {
    httpOnly: true, sameSite: 'lax', path: '/', secure: process.env.NODE_ENV === 'production', maxAge: 30 * 86400,
  });
  return response;
}
