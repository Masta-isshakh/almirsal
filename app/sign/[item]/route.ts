import { NextResponse } from 'next/server';
import type { Environment } from '@engine/orm/env';
import { formatDate } from '@engine/format/index';
import { getPublicEnvironment } from '@/lib/server/public';
import { portalLang, tokenMatches } from '@/lib/server/portal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `/sign/<request item>?token=…` — the page a signer outside the company opens
 * from their invitation: what they are asked to sign, the documents to read, and
 * the box where they sign. The token in the link is the permission, as in
 * Odoo's `/sign/document/<id>/<token>`; no session is involved.
 */

const esc = (value: unknown): string => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tr = (rtl: boolean, en: string, ar: string): string => (rtl ? ar : en);

interface Signer { env: Environment; id: number; item: Record<string, unknown>; request: Record<string, unknown> }

async function openSigner(itemText: string, token: string | null, rtl: boolean): Promise<Signer | { error: 403 | 404 }> {
  const id = Number(itemText);
  if (!Number.isInteger(id) || id <= 0) return { error: 404 };
  const env = await getPublicEnvironment(rtl ? 'ar_001' : 'en_US');
  if (!env.registry.models['sign.request.item']) return { error: 404 };
  const [item] = await env.model('sign.request.item').read(id, ['access_token', 'state', 'partner_id', 'role_id', 'sign_request_id', 'signing_date']).catch(() => []);
  // A missing item and a wrong token answer alike (see lib/server/portal).
  if (!item || !token || !tokenMatches(String(item.access_token ?? ''), token)) return { error: 403 };
  const requestId = Array.isArray(item.sign_request_id) ? Number(item.sign_request_id[0]) : Number(item.sign_request_id);
  const [request] = await env.model('sign.request').read(requestId, ['reference', 'subject', 'state', 'validity', 'template_document_ids', 'nb_total', 'nb_closed']).catch(() => []);
  if (!request) return { error: 404 };
  return { env, id, item, request };
}

export async function GET(request: Request, context: { params: Promise<{ item: string }> }): Promise<Response> {
  const { item: itemText } = await context.params;
  const url = new URL(request.url);
  let rtl = url.searchParams.get('lang') === 'ar_001';
  const opened = await openSigner(itemText, url.searchParams.get('token'), rtl);
  if ('error' in opened) return new NextResponse(opened.error === 404 ? 'Not found' : 'This link is not valid any more.', { status: opened.error });
  const { env, id, item, request: signRequest } = opened;
  // The signer reads their own language.
  rtl = (await portalLang(env, Array.isArray(item.partner_id) ? Number(item.partner_id[0]) : null, url, request)) === 'ar_001';

  const documents = await env.model('sign.document').read((signRequest.template_document_ids as number[]) ?? [], ['name', 'attachment_id', 'num_pages']).catch(() => []);
  const signed = item.state === 'completed';
  const cancelled = item.state === 'canceled' || signRequest.state === 'canceled';
  const role = Array.isArray(item.role_id) ? String(item.role_id[1] ?? '') : '';
  const who = Array.isArray(item.partner_id) ? String(item.partner_id[1] ?? '') : '';
  const token = url.searchParams.get('token') ?? '';
  const post = `/sign/${id}?token=${encodeURIComponent(token)}${rtl ? '&lang=ar_001' : ''}`;

  const body = `<!DOCTYPE html>
<html lang="${rtl ? 'ar' : 'en'}" dir="${rtl ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(signRequest.reference)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;500;700&family=Noto+Sans+Arabic:wght@400;500;700&display=swap" />
<style>${SIGN_CSS}</style>
</head>
<body>
<main class="o_sign_card">
  <h1>${esc(signRequest.subject || signRequest.reference)}</h1>
  <p class="o_sign_meta">
    ${esc(tr(rtl, 'For', 'إلى'))}: <strong>${esc(who)}</strong>${role ? ` · ${esc(role)}` : ''}
    ${signRequest.validity ? ` · ${esc(tr(rtl, 'Valid until', 'صالح حتى'))} ${esc(formatDate(String(signRequest.validity).slice(0, 10), rtl ? 'ar_001' : 'en_US'))}` : ''}
  </p>
  ${documents.length ? `<ul class="o_sign_documents">${documents.map((document) => {
    const attachment = Array.isArray(document.attachment_id) ? Number(document.attachment_id[0]) : Number(document.attachment_id);
    const label = `${String(document.name ?? '')}${document.num_pages ? ` · ${document.num_pages} ${tr(rtl, 'page(s)', 'صفحة')}` : ''}`;
    return `<li>${attachment ? `<a href="/api/attachment/${attachment}" target="_blank" rel="noreferrer">${esc(label)}</a>` : esc(label)}</li>`;
  }).join('')}</ul>` : `<p class="o_sign_empty">${esc(tr(rtl, 'No document is attached to this request.', 'لا يوجد مستند مرفق بهذا الطلب.'))}</p>`}

  ${cancelled ? `<div class="o_sign_banner o_sign_cancelled">${esc(tr(rtl, 'This request was cancelled.', 'تم إلغاء هذا الطلب.'))}</div>`
    : signed ? `<div class="o_sign_banner o_sign_done">${esc(tr(rtl, 'You signed this document', 'قمت بتوقيع هذا المستند'))} ${item.signing_date ? esc(formatDate(String(item.signing_date).slice(0, 10), rtl ? 'ar_001' : 'en_US')) : ''}</div>`
      : `<form method="post" action="${esc(post)}" class="o_sign_form">
    <p>${esc(tr(rtl, 'Type your full name to sign. Your name and the date are kept with the document.', 'اكتب اسمك الكامل للتوقيع. يُحفظ اسمك والتاريخ مع المستند.'))}</p>
    <label>${esc(tr(rtl, 'Your full name', 'اسمك الكامل'))}<input name="name" required autocomplete="name" value="${esc(who)}" /></label>
    <button type="submit">${esc(tr(rtl, 'Sign', 'توقيع'))}</button>
  </form>`}
  <p class="o_sign_progress">${esc(tr(rtl, 'Signed', 'تم التوقيع'))}: ${esc(signRequest.nb_closed ?? 0)}/${esc(signRequest.nb_total ?? 0)}</p>
</main>
</body>
</html>`;
  return new NextResponse(body, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request, context: { params: Promise<{ item: string }> }): Promise<Response> {
  const { item: itemText } = await context.params;
  const url = new URL(request.url);
  const rtl = url.searchParams.get('lang') === 'ar_001';
  const opened = await openSigner(itemText, url.searchParams.get('token'), rtl);
  if ('error' in opened) return new NextResponse('This link is not valid any more.', { status: opened.error });
  const { env, id, item, request: signRequest } = opened;
  if (item.state === 'completed') return NextResponse.redirect(new URL(url.pathname + url.search, url), 303);
  if (item.state === 'canceled' || signRequest.state === 'canceled') return new NextResponse('This request was cancelled.', { status: 409 });

  const form = await request.formData();
  const name = String(form.get('name') ?? '').trim().slice(0, 120);
  if (!name) return new NextResponse('A name is needed to sign.', { status: 400 });

  const fields = env.registry.models['sign.request.item'].fields;
  const values: Record<string, unknown> = { state: 'completed' };
  if (fields.signing_date) values.signing_date = new Date().toISOString().slice(0, 10);
  // The typed name is what was signed with; it is kept as the signature.
  if (fields.signature) values.signature = Buffer.from(name, 'utf8').toString('base64');
  await env.model('sign.request.item').write(id, values);
  const requestId = Array.isArray(item.sign_request_id) ? Number(item.sign_request_id[0]) : Number(item.sign_request_id);
  await env.model('mail.message').create({
    model: 'sign.request', res_id: requestId, message_type: 'comment', subtype_xmlid: 'mail.mt_note',
    body: `<p>${esc(name)} signed from the link.</p>`,
  }).catch(() => undefined);
  if (env.registry.models['sign.log']) {
    await env.model('sign.log').create({ sign_request_id: requestId, action: 'sign', log_date: new Date().toISOString().slice(0, 19).replace('T', ' ') }).catch(() => undefined);
  }
  return NextResponse.redirect(new URL(url.pathname + url.search, url), 303);
}

const SIGN_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #f3f4f6; font-family: "Noto Sans", "Noto Sans Arabic", system-ui, sans-serif; color: #111827; }
  .o_sign_card { background: #fff; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.12); padding: 28px 32px; max-width: 560px; width: calc(100% - 32px); margin: 32px auto; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  .o_sign_meta { color: #4b5563; font-size: 13px; margin: 0 0 18px; }
  .o_sign_documents { margin: 0 0 18px; padding-inline-start: 20px; }
  .o_sign_documents a { color: #714b67; }
  .o_sign_empty { color: #6b7280; font-size: 13px; }
  .o_sign_banner { border-radius: 6px; padding: 10px 14px; margin-bottom: 14px; }
  .o_sign_done { background: #ecfdf5; color: #065f46; }
  .o_sign_cancelled { background: #fef2f2; color: #991b1b; }
  .o_sign_form p { color: #4b5563; font-size: 13px; }
  .o_sign_form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #4b5563; margin-bottom: 14px; }
  .o_sign_form input { border: 1px solid #d1d5db; border-radius: 4px; padding: 9px 12px; font: inherit; }
  .o_sign_form button { background: #714b67; color: #fff; border: 0; border-radius: 4px; padding: 9px 20px; font: inherit; font-weight: 700; cursor: pointer; }
  .o_sign_progress { color: #6b7280; font-size: 12px; margin: 18px 0 0; }
`;
