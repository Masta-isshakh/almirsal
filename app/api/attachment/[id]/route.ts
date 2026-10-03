import { NextResponse } from 'next/server';
import { getEnvironment, getSessionUser } from '@/lib/server/session';
import { attachmentPayload } from '@/packages/apps/base/attachments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/attachment/<id>[?download=1] — streams an `ir.attachment` payload to
 * a logged-in user: from the file store when the row holds a key
 * (`store_fname`), from the row when it holds the bytes, or a redirect for a URL
 * attachment.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'session_expired' }, { status: 401 });
  const { id } = await params;
  const env = await getEnvironment(user);
  const payload = await attachmentPayload(env, Number(id));
  if (!payload) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (payload.url) return NextResponse.redirect(payload.url);
  const download = new URL(request.url).searchParams.get('download') === '1';
  const name = encodeURIComponent(payload.name);
  return new Response(new Uint8Array(payload.bytes), {
    headers: {
      'Content-Type': payload.mimetype,
      'Content-Length': String(payload.bytes.length),
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${name}`,
      'Cache-Control': 'private, max-age=300',
    },
  });
}
