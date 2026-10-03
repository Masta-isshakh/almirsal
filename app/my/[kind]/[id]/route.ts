import { NextResponse } from 'next/server';
import type { Environment } from '@engine/orm/env';
import { formatDate, formatMonetary } from '@engine/format/index';
import { openPortalRecord, portalLang, portalUrl } from '@/lib/server/portal';
import { findReport, renderReport } from '@/lib/server/reports';
import { renderPortalPage, type PortalAction } from '@/components/report/PortalPage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `/my/orders/<id>?access_token=…` and `/my/invoices/<id>?access_token=…` — the
 * page a customer sees when they follow the link on a quotation or an invoice.
 * The token in the link is the permission; no session is involved.
 *
 * POST takes the customer's answer: accept (with the name they sign with) or
 * decline (with a reason).
 */

const tr = (rtl: boolean, en: string, ar: string): string => (rtl ? ar : en);

export async function GET(request: Request, context: { params: Promise<{ kind: string; id: string }> }): Promise<Response> {
  const { kind, id } = await context.params;
  const url = new URL(request.url);
  const opened = await openPortalRecord(kind, id, url.searchParams.get('access_token'), await portalLang(null, null, url, request));
  if ('error' in opened) {
    return new NextResponse(opened.error === 404 ? 'Not found' : 'This link is not valid any more.', { status: opened.error });
  }
  const { env, model } = opened;
  const recordId = opened.id;
  // The customer reads their own language, as Odoo writes to them in it.
  const [owner] = await env.model(model).read(recordId, ['partner_id']).catch(() => []);
  const partnerId = Array.isArray(owner?.partner_id) ? Number(owner.partner_id[0]) : null;
  const rtl = (await portalLang(env, partnerId, url, request)) === 'ar_001';

  const reportName = model === 'sale.order' ? 'sale.report_saleorder' : 'account.report_invoice';
  const spec = findReport(reportName) ?? { reportName, model, name: { en: 'Document', ar: 'مستند' } };
  const document = await renderReport(env, spec, recordId);

  const token = url.searchParams.get('access_token') ?? '';
  const printHref = `/report/${encodeURIComponent(spec.reportName)}/${recordId}?print=1`;
  const postUrl = `/my/${kind}/${recordId}?access_token=${encodeURIComponent(token)}${rtl ? '&lang=ar_001' : ''}`;
  const actions: PortalAction[] = [{ id: 'print', label: tr(rtl, 'Print', 'طباعة') }];

  if (model === 'sale.order') {
    const [order] = await env.model('sale.order').read(recordId, ['state', 'name', 'require_signature', 'signed_by', 'signed_on', 'amount_total', 'currency_id']);
    const quotation = order.state === 'draft' || order.state === 'sent';
    const signedBy = typeof order.signed_by === 'string' ? order.signed_by : '';
    if (quotation) {
      actions.unshift({ id: 'decline', label: tr(rtl, 'Decline', 'رفض') });
      actions.unshift({ id: 'accept', label: order.require_signature ? tr(rtl, 'Accept & Sign', 'الموافقة والتوقيع') : tr(rtl, 'Accept', 'موافقة'), primary: true });
    }
    const status = order.state === 'cancel' ? tr(rtl, 'Cancelled', 'ملغى')
      : quotation ? tr(rtl, 'Waiting for your answer', 'بانتظار ردك')
        : tr(rtl, 'Confirmed', 'تم التأكيد');
    return html(renderPortalPage(document, {
      rtl,
      title: `${document.title} ${document.number}`.trim(),
      status,
      statusTone: order.state === 'cancel' ? 'danger' : quotation ? 'waiting' : 'done',
      actions,
      signature: quotation ? {
        prompt: order.require_signature
          ? tr(rtl, 'Type your name to sign this document.', 'اكتب اسمك للتوقيع على هذا المستند.')
          : tr(rtl, 'Confirm that you accept this quotation.', 'أكّد موافقتك على عرض السعر هذا.'),
        nameLabel: tr(rtl, 'Your name', 'اسمك'),
        submitLabel: tr(rtl, 'Accept & Sign', 'الموافقة والتوقيع'),
        declineLabel: tr(rtl, 'Decline', 'رفض'),
        reasonLabel: tr(rtl, 'Reason (optional)', 'السبب (اختياري)'),
      } : undefined,
      signed: signedBy ? {
        label: tr(rtl, 'Signed by', 'وقّع بواسطة'),
        by: signedBy,
        on: order.signed_on ? formatDate(String(order.signed_on).slice(0, 10), rtl ? 'ar_001' : 'en_US') : '',
      } : undefined,
      printHref,
      postUrl,
    }));
  }

  const [move] = await env.model('account.move').read(recordId, ['state', 'payment_state', 'amount_residual', 'currency_id', 'name']);
  const [currency] = await env.model('res.currency').read(Number(Array.isArray(move.currency_id) ? move.currency_id[0] : move.currency_id) || 0, ['name', 'symbol', 'position', 'decimal_places', 'rounding']).catch(() => []);
  const residual = Number(move.amount_residual ?? 0);
  const paid = move.payment_state === 'paid' || move.payment_state === 'reversed';
  return html(renderPortalPage(document, {
    rtl,
    title: `${document.title} ${document.number}`.trim(),
    status: move.state !== 'posted' ? tr(rtl, 'Draft', 'مسودة') : paid ? tr(rtl, 'Paid', 'مدفوعة') : tr(rtl, 'Waiting for payment', 'بانتظار الدفع'),
    statusTone: paid ? 'done' : move.state !== 'posted' ? 'waiting' : 'waiting',
    actions,
    printHref,
    postUrl,
    amountDue: residual > 0 && currency ? {
      label: tr(rtl, 'Amount due', 'المبلغ المستحق'),
      value: formatMonetary(residual, {
        name: String(currency.name ?? ''), symbol: String(currency.symbol ?? ''),
        position: currency.position === 'before' ? 'before' : 'after',
        decimalPlaces: Number(currency.decimal_places ?? 2), rounding: Number(currency.rounding ?? 0.01),
      }),
    } : undefined,
  }));
}

export async function POST(request: Request, context: { params: Promise<{ kind: string; id: string }> }): Promise<Response> {
  const { kind, id } = await context.params;
  const url = new URL(request.url);
  const rtl = url.searchParams.get('lang') === 'ar_001';
  const opened = await openPortalRecord(kind, id, url.searchParams.get('access_token'), rtl ? 'ar_001' : 'en_US');
  if ('error' in opened) return new NextResponse('This link is not valid any more.', { status: opened.error });
  const { env, model } = opened;
  const recordId = opened.id;
  if (model !== 'sale.order') return new NextResponse('Nothing to answer here.', { status: 400 });

  const form = await request.formData();
  const action = String(form.get('action') ?? '');
  const orders = env.model('sale.order');
  const [order] = await orders.read(recordId, ['state', 'require_signature', 'name']);
  if (order.state !== 'draft' && order.state !== 'sent') return redirectBack(url);

  if (action === 'accept') {
    const name = String(form.get('name') ?? '').trim().slice(0, 120);
    if (order.require_signature && !name) return new NextResponse('A name is needed to sign.', { status: 400 });
    const values: Record<string, unknown> = {};
    if (env.registry.models['sale.order'].fields.signed_by && name) values.signed_by = name;
    if (env.registry.models['sale.order'].fields.signed_on) values.signed_on = new Date().toISOString().slice(0, 19).replace('T', ' ');
    if (Object.keys(values).length) await orders.write(recordId, values);
    await orders.callButton(recordId, 'action_confirm').catch(() => undefined);
    await note(env, recordId, name
      ? { en: `${name} accepted and signed the quotation from the portal.`, ar: `${name} وافق ووقّع على عرض السعر من البوابة.` }
      : { en: 'The customer accepted the quotation from the portal.', ar: 'وافق العميل على عرض السعر من البوابة.' });
    return redirectBack(url);
  }

  if (action === 'decline') {
    const reason = String(form.get('reason') ?? '').trim().slice(0, 240);
    await orders.callButton(recordId, 'action_cancel').catch(() => undefined);
    await note(env, recordId, reason
      ? { en: `The customer declined the quotation from the portal: ${reason}`, ar: `رفض العميل عرض السعر من البوابة: ${reason}` }
      : { en: 'The customer declined the quotation from the portal.', ar: 'رفض العميل عرض السعر من البوابة.' });
    return redirectBack(url);
  }
  return new NextResponse('Unknown action', { status: 400 });
}

/** The answer is kept in the chatter, where the salesperson will see it. */
async function note(env: Environment, id: number, body: { en: string; ar: string }): Promise<void> {
  await env.model('mail.message').create({
    model: 'sale.order', res_id: id, body: `<p>${body.en}</p>`, message_type: 'comment', subtype_xmlid: 'mail.mt_note',
  }).catch(() => undefined);
}

function html(body: string): Response {
  return new NextResponse(body, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

/** After an answer, the same page — which now shows what happened. */
function redirectBack(url: URL): Response {
  return NextResponse.redirect(new URL(url.pathname + url.search, url), 303);
}

export { portalUrl };
