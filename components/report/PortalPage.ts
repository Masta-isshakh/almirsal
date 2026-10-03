import type { ReportDocument } from '@/lib/server/reports';
import { renderReportDocument, REPORT_CSS } from './ReportDocument';

/**
 * The page a customer sees when they follow the link on a quotation or an
 * invoice: the document itself, what it is waiting for, and the buttons Odoo's
 * portal offers — Accept & Sign, Decline, Print, and the amount due on an
 * invoice. Rendered as an HTML string, like the printed document, so the page
 * needs no client bundle.
 */

const esc = (value: unknown): string => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface PortalAction { id: 'accept' | 'decline' | 'print'; label: string; primary?: boolean }

export interface PortalPageOptions {
  rtl: boolean;
  title: string;
  /** What the document is waiting for, in one line. */
  status: string;
  statusTone: 'waiting' | 'done' | 'danger';
  actions: PortalAction[];
  /** `Accept & Sign` asks for a name; the note says what signing means. */
  signature?: { prompt: string; nameLabel: string; submitLabel: string; declineLabel: string; reasonLabel: string };
  signed?: { by: string; on: string; label: string };
  printHref: string;
  postUrl: string;
  amountDue?: { label: string; value: string };
}

export function renderPortalPage(document: ReportDocument, options: PortalPageOptions): string {
  const { rtl, title, status, statusTone, actions, signature, signed, printHref, postUrl, amountDue } = options;
  const accept = actions.find((action) => action.id === 'accept');
  const decline = actions.find((action) => action.id === 'decline');
  return `<!DOCTYPE html>
<html lang="${rtl ? 'ar' : 'en'}" dir="${rtl ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;500;700&family=Noto+Sans+Arabic:wght@400;500;700&display=swap" />
<style>:root { --o-report-primary: ${esc(document.layout?.primaryColor ?? '#714B67')}; --o-report-secondary: ${esc(document.layout?.secondaryColor ?? '#017E84')}; --o-report-font: "Noto Sans", "Noto Sans Arabic", system-ui, sans-serif; --o-report-width: 210mm; --o-report-height: 297mm; --o-report-margin-top: 18mm; --o-report-margin-right: 16mm; --o-report-margin-bottom: 22mm; --o-report-margin-left: 16mm; }
${REPORT_CSS}
${PORTAL_CSS}</style>
</head>
<body class="o_portal">
<div class="o_portal_bar">
  <span class="o_portal_title">${esc(title)}</span>
  <span class="o_portal_status o_portal_status_${statusTone}">${esc(status)}</span>
</div>
<div class="o_portal_actions">
  ${accept ? `<button type="button" class="o_portal_button o_portal_primary" id="o_portal_accept">${esc(accept.label)}</button>` : ''}
  ${decline ? `<button type="button" class="o_portal_button" id="o_portal_decline">${esc(decline.label)}</button>` : ''}
  <a class="o_portal_button" href="${esc(printHref)}">${esc(actions.find((action) => action.id === 'print')?.label ?? (rtl ? 'طباعة' : 'Print'))}</a>
  ${amountDue ? `<span class="o_portal_due">${esc(amountDue.label)}: <strong>${esc(amountDue.value)}</strong></span>` : ''}
</div>
${signed ? `<div class="o_portal_signed">${esc(signed.label)} ${esc(signed.by)} — ${esc(signed.on)}</div>` : ''}
${signature ? `
<form class="o_portal_sign" id="o_portal_sign" method="post" action="${esc(postUrl)}" hidden>
  <input type="hidden" name="action" value="accept" />
  <p>${esc(signature.prompt)}</p>
  <label>${esc(signature.nameLabel)}<input name="name" required autocomplete="name" /></label>
  <button type="submit" class="o_portal_button o_portal_primary">${esc(signature.submitLabel)}</button>
</form>
<form class="o_portal_sign" id="o_portal_decline_form" method="post" action="${esc(postUrl)}" hidden>
  <input type="hidden" name="action" value="decline" />
  <label>${esc(signature.reasonLabel)}<input name="reason" /></label>
  <button type="submit" class="o_portal_button">${esc(signature.declineLabel)}</button>
</form>` : ''}
${renderReportDocument(document, rtl)}
<script>
var accept = document.getElementById("o_portal_accept");
var decline = document.getElementById("o_portal_decline");
var signForm = document.getElementById("o_portal_sign");
var declineForm = document.getElementById("o_portal_decline_form");
function show(form, other) { if (!form) return; other && (other.hidden = true); form.hidden = false; var input = form.querySelector("input:not([type=hidden])"); input && input.focus(); }
accept && accept.addEventListener("click", function () { signForm ? show(signForm, declineForm) : document.getElementById("o_portal_plain_accept").submit(); });
decline && decline.addEventListener("click", function () { show(declineForm, signForm); });
</script>
${signature ? '' : `
<form id="o_portal_plain_accept" method="post" action="${esc(postUrl)}" hidden><input type="hidden" name="action" value="accept" /></form>`}
</body>
</html>`;
}

export const PORTAL_CSS = `
  body.o_portal { background: #f3f4f6; }
  .o_portal_bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 24px; background: var(--o-report-primary); color: #fff; }
  .o_portal_title { font-weight: 700; }
  .o_portal_status { border-radius: 999px; padding: 2px 12px; font-size: 12px; background: rgba(255,255,255,.2); }
  .o_portal_status_done { background: #16a34a; }
  .o_portal_status_danger { background: #dc2626; }
  .o_portal_actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 14px 24px; background: #fff; border-bottom: 1px solid #e5e7eb; }
  .o_portal_button { display: inline-block; border: 1px solid var(--o-report-primary); background: #fff; color: var(--o-report-primary); border-radius: 4px; padding: 7px 16px; font: inherit; font-weight: 500; cursor: pointer; text-decoration: none; }
  .o_portal_primary { background: var(--o-report-primary); color: #fff; }
  .o_portal_due { margin-inline-start: auto; color: #374151; }
  .o_portal_signed { padding: 10px 24px; background: #ecfdf5; color: #065f46; border-bottom: 1px solid #a7f3d0; }
  .o_portal_sign { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; padding: 14px 24px; background: #fff; border-bottom: 1px solid #e5e7eb; }
  .o_portal_sign p { margin: 0; flex: 1 1 100%; color: #4b5563; font-size: 13px; }
  .o_portal_sign label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #4b5563; }
  .o_portal_sign input { border: 1px solid #d1d5db; border-radius: 4px; padding: 7px 10px; font: inherit; min-width: 220px; }
  @media print { .o_portal_bar, .o_portal_actions, .o_portal_sign, .o_portal_signed { display: none; } body.o_portal { background: #fff; } }
`;
