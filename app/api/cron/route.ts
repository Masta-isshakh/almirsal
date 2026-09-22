import { NextResponse } from 'next/server';
import { getPublicEnvironment } from '@/lib/server/public';
import { runCron } from '@/lib/server/cron';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST (or GET) /api/cron — runs the due scheduled actions. Protected by
 * `RODEO_CRON_KEY` (header `x-cron-key` or `?key=`); disabled when unset.
 * `?force=1` runs every job, `?only=<xmlId>` a single one.
 */
async function handle(request: Request): Promise<Response> {
  const expected = process.env.RODEO_CRON_KEY?.trim();
  if (!expected) return NextResponse.json({ error: 'cron disabled: RODEO_CRON_KEY is not set' }, { status: 404 });
  const url = new URL(request.url);
  const key = request.headers.get('x-cron-key') ?? url.searchParams.get('key');
  if (key !== expected) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const env = await getPublicEnvironment();
  const results = await runCron(env, { force: url.searchParams.get('force') === '1', only: url.searchParams.get('only') ?? undefined });
  return NextResponse.json({ results });
}

export const POST = handle;
export const GET = handle;
