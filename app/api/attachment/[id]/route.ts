import { NextResponse } from 'next/server';
import { getEnvironment, getSessionUser } from '@/lib/server/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/attachment/<id>[?download=1] — streams an `ir.attachment` payload
 * (base64 in `datas`, or a redirect for URL attachments) to a logged-in user.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'session_expired' }, { status: 401 });
  const { id } = await params;
  const env = await getEnvironment(user);
  const rows = await env.model('ir.attachment').read(Number(id), ['name', 'mimetype', 'datas', 'type', 'url']).catch(() => []);
  const row = rows[0];
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (row.type === 'url' && row.url) return NextResponse.redirect(String(row.url));
  const raw = String(row.datas ?? '');
  const base64 = raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw;
  const bytes = Buffer.from(base64, 'base64');
  const download = new URL(request.url).searchParams.get('download') === '1';
  const name = encodeURIComponent(String(row.name ?? 'attachment'));
  return new Response(bytes, {
    headers: {
      'Content-Type': String(row.mimetype || 'application/octet-stream'),
      'Content-Length': String(bytes.length),
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${name}`,
      'Cache-Control': 'private, max-age=300',
    },
  });
}
