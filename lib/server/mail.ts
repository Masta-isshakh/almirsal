import type { Environment } from '@engine/orm/env';
import { postMessage } from '@engine/orm/mail';
import { UserError } from '@engine/orm/errors';
import { getSetting } from '@/packages/apps/base/settings';
import { findReport, renderReport } from './reports';
import { renderReportDocument, REPORT_CSS } from '@/components/report/ReportDocument';

/**
 * Outgoing email (Part G "Send"): Amazon SES v2 when a sender is configured
 * (`RODEO_MAIL_FROM` env or the Settings "Alias Domain / Email From"), else
 * the message is only logged in the chatter and the user is told. SES is the
 * cheapest transport on AWS ($0.10 per 1,000 emails, no fixed cost).
 */

export interface OutgoingMail { to: { email: string; name?: string }[]; subject: string; html: string; text?: string; replyTo?: string }

export interface MailTransport { send(mail: OutgoingMail & { from: string }): Promise<string> }

let transport: MailTransport | null | undefined;

function senderAddress(): string | null {
  return process.env.RODEO_MAIL_FROM?.trim() || null;
}

async function sesTransport(): Promise<MailTransport | null> {
  if (transport !== undefined) return transport;
  if (!senderAddress()) { transport = null; return null; }
  try {
    const { SESv2Client, SendEmailCommand } = await import('@aws-sdk/client-sesv2');
    const client = new SESv2Client({ region: process.env.RODEO_MAIL_REGION ?? process.env.AWS_REGION ?? 'ap-south-1' });
    transport = {
      async send(mail) {
        const result = await client.send(new SendEmailCommand({
          FromEmailAddress: mail.from,
          Destination: { ToAddresses: mail.to.map((to) => (to.name ? `"${to.name.replace(/"/g, '')}" <${to.email}>` : to.email)) },
          ReplyToAddresses: mail.replyTo ? [mail.replyTo] : undefined,
          Content: { Simple: { Subject: { Data: mail.subject, Charset: 'UTF-8' }, Body: { Html: { Data: mail.html, Charset: 'UTF-8' }, Text: { Data: mail.text ?? mail.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), Charset: 'UTF-8' } } } },
        }));
        return result.MessageId ?? '';
      },
    };
  } catch {
    transport = null;
  }
  return transport;
}

/** Test seam. */
export function setMailTransport(next: MailTransport | null | undefined): void {
  transport = next;
}

export function mailConfigured(): boolean {
  return Boolean(senderAddress());
}

export interface SendDocumentOptions {
  model: string;
  id: number;
  partnerIds: number[];
  subject: string;
  body: string;
  /** Report to render inline under the message. */
  reportName?: string | null;
}

/**
 * Send a document by email: the message, then the printable document
 * inline (tables render everywhere; recipients "print to PDF" if they need
 * a file). The email is logged in the chatter with its recipients.
 */
export async function sendDocumentMail(env: Environment, options: SendDocumentOptions): Promise<{ sent: boolean; messageId: number; recipients: string[] }> {
  const partners = await env.sudo().model('res.partner').read(options.partnerIds, ['name', 'email']);
  const recipients = partners.filter((partner) => typeof partner.email === 'string' && partner.email.includes('@')).map((partner) => ({ email: String(partner.email), name: String(partner.name ?? '') }));
  if (recipients.length === 0) throw new UserError({ en: 'None of the recipients has an email address.', ar: 'لا يملك أي من المستلمين عنوان بريد إلكتروني.' });

  let documentHtml = '';
  if (options.reportName) {
    const spec = findReport(options.reportName);
    if (spec) {
      const doc = await renderReport(env, spec, options.id);
      documentHtml = `<hr style="border:0;border-top:1px solid #e5e7eb;margin:24px 0"/><style>${REPORT_CSS.replace(/\.o_report_page \{[^}]*\}/, '.o_report_page { background:#fff; padding: 16px; }')}</style>${renderReportDocument(doc, env.lang === 'ar_001')}`;
    }
  }
  const [author] = await env.sudo().model('res.users').read(env.uid, ['name', 'email', 'login']);
  const company = await env.sudo().model('res.company').read(env.companyId, ['name', 'email']);
  const from = senderAddress();
  const html = `<div dir="${env.lang === 'ar_001' ? 'rtl' : 'ltr'}" style="font-family:Noto Sans,system-ui,sans-serif;font-size:14px;color:#111827">${options.body}${documentHtml}<p style="color:#6b7280;font-size:12px;margin-top:24px">${String(company[0]?.name ?? '')}</p></div>`;

  const active = await sesTransport();
  let sent = false;
  if (active && from) {
    await active.send({ from, to: recipients, subject: options.subject, html, replyTo: typeof author?.email === 'string' && author.email ? author.email : undefined });
    sent = true;
  }
  const messageId = await postMessage(env, options.model, options.id, {
    body: `${options.body}${sent ? '' : `<p style="color:#b45309"><i>${env.lang === 'ar_001' ? 'لم يتم الإرسال: لم يتم إعداد خادم بريد صادر (RODEO_MAIL_FROM).' : 'Not sent: no outgoing mail server is configured (RODEO_MAIL_FROM).'}</i></p>`}`,
    subject: options.subject, messageType: 'email', isInternal: false, partnerIds: options.partnerIds,
  });
  return { sent, messageId, recipients: recipients.map((r) => r.email) };
}

/** Default subject / body / recipients for the composer, per document type. */
export async function composerDefaults(env: Environment, model: string, id: number): Promise<{ subject: string; body: string; partnerIds: number[]; reportName: string | null; recipients: { id: number; name: string; email: string }[] }> {
  const ar = env.lang === 'ar_001';
  const company = (await env.sudo().model('res.company').read(env.companyId, ['name']))[0];
  const companyName = String(company?.name ?? '');
  const signature = await getSetting<string>(env, 'signature', '');
  let subject = '';
  let body = '';
  let partnerId: number | null = null;
  let reportName: string | null = null;
  if (model === 'sale.order') {
    const [order] = await env.model(model).read(id, ['name', 'state', 'partner_id', 'client_order_ref', 'amount_total', 'currency_id']);
    const quotation = order.state === 'draft' || order.state === 'sent';
    const ref = order.client_order_ref ? ` (${order.client_order_ref})` : '';
    subject = `${companyName} ${quotation ? (ar ? 'عرض سعر' : 'Quotation') : (ar ? 'طلب' : 'Order')} ${order.name}${ref}`;
    partnerId = Array.isArray(order.partner_id) ? Number(order.partner_id[0]) : null;
    const partnerName = Array.isArray(order.partner_id) ? String(order.partner_id[1]) : '';
    body = ar
      ? `<p>مرحباً ${partnerName}،</p><p>${quotation ? 'تجدون أدناه عرض السعر' : 'تجدون أدناه طلبكم'} <strong>${order.name}</strong> من ${companyName}.</p><p>لا تترددوا في التواصل معنا لأي استفسار.</p>`
      : `<p>Hello ${partnerName},</p><p>Your ${quotation ? 'quotation' : 'order'} <strong>${order.name}</strong> from ${companyName} is below.</p><p>Do not hesitate to contact us if you have any question.</p>`;
    reportName = quotation ? 'sale.report_saleorder' : 'sale.report_saleorder';
  } else if (model === 'account.move') {
    const [move] = await env.model(model).read(id, ['name', 'state', 'partner_id', 'move_type', 'amount_total', 'invoice_date_due']);
    const credit = String(move.move_type ?? '').endsWith('refund');
    subject = `${companyName} ${credit ? (ar ? 'إشعار دائن' : 'Credit Note') : (ar ? 'فاتورة' : 'Invoice')} ${move.state === 'draft' ? '' : move.name}`.trim();
    partnerId = Array.isArray(move.partner_id) ? Number(move.partner_id[0]) : null;
    const partnerName = Array.isArray(move.partner_id) ? String(move.partner_id[1]) : '';
    body = ar
      ? `<p>مرحباً ${partnerName}،</p><p>تجدون أدناه ${credit ? 'الإشعار الدائن' : 'الفاتورة'} <strong>${move.name}</strong> من ${companyName}${move.invoice_date_due ? `، مستحقة في ${move.invoice_date_due}` : ''}.</p>`
      : `<p>Hello ${partnerName},</p><p>Here is your ${credit ? 'credit note' : 'invoice'} <strong>${move.name}</strong> from ${companyName}${move.invoice_date_due ? `, due on ${move.invoice_date_due}` : ''}.</p>`;
    reportName = 'account.report_invoice_with_payments';
  } else {
    const [row] = await env.model(model).read(id, ['display_name', ...(env.registry.models[model].fields.partner_id ? ['partner_id'] : [])]);
    subject = `${companyName}: ${row.display_name}`;
    partnerId = Array.isArray(row.partner_id) ? Number(row.partner_id[0]) : null;
    body = `<p>${ar ? 'مرحباً' : 'Hello'},</p><p>${row.display_name}</p>`;
  }
  if (signature) body += `<p>${signature}</p>`;
  const recipients = partnerId ? (await env.sudo().model('res.partner').read(partnerId, ['name', 'email'])).map((p) => ({ id: p.id as number, name: String(p.name ?? ''), email: typeof p.email === 'string' ? p.email : '' })) : [];
  return { subject, body, partnerIds: recipients.map((r) => r.id), reportName, recipients };
}
