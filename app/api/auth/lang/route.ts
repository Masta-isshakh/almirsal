import { NextResponse } from 'next/server';
import { LANG_COOKIE, getSessionUser } from '@/lib/server/session';
import { getDatabase } from '@/lib/server/db';

/** Switch the interface language; persisted on the user when logged in. */
export async function POST(request: Request): Promise<Response> {
  const { lang } = (await request.json()) as { lang?: string };
  if (lang !== 'en_US' && lang !== 'ar_001') return NextResponse.json({ error: 'bad_lang' }, { status: 400 });
  const user = await getSessionUser();
  if (user) {
    const db = await getDatabase();
    await db.query(`UPDATE res_users SET lang = $1 WHERE id = $2`, [lang, user.uid]);
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(LANG_COOKIE, lang, { path: '/', maxAge: 365 * 86400, sameSite: 'lax' });
  return response;
}
