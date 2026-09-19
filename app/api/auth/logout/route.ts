import { NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/lib/server/session';

export async function POST(): Promise<Response> {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 });
  return response;
}
