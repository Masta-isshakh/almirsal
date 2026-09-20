import { NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

/**
 * Log out: drop the local session cookie and every Cognito token cookie the
 * Amplify client stored (`CognitoIdentityServiceProvider.<client>.<user>.*`),
 * so the next request has no identity at all.
 */
export async function POST(request: Request): Promise<Response> {
  const response = NextResponse.json({ ok: true });
  const names = (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim().split('=')[0]).filter(Boolean);
  for (const name of names) {
    if (name === SESSION_COOKIE || name.startsWith('CognitoIdentityServiceProvider.') || name.startsWith('amplify-')) {
      response.cookies.set(name, '', { path: '/', maxAge: 0 });
    }
  }
  response.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 });
  return response;
}
