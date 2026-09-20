import type { ReportDocument } from '@/lib/server/reports';

/**
 * The printable A4 layout shared by every report: company header, document
 * title + number, customer block, key facts, lines table, totals, note and
 * footer. Rendered as an HTML string (route handlers may not use
 * react-dom/server), escaped field by field.
 */
const esc = (value: unknown): string => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderReportDocument(doc: ReportDocument, rtl: boolean): string {
  const vat = rtl ? 'الرقم الضريبي' : 'VAT';
  const party = (lines: string[]) => lines.map((line) => `<div>${esc(line)}</div>`).join('');
  const columns = doc.columns;
  const lines = doc.lines.map((line) => (line.kind === 'product'
    ? `<tr>${columns.map((column) => `<td class="${column.numeric ? 'num' : ''}">${esc(line[column.key])}</td>`).join('')}</tr>`
    : `<tr class="${line.kind === 'section' ? 'o_report_section' : 'o_report_note_line'}"><td colspan="${columns.length}">${esc(line.name)}</td></tr>`)).join('');
  return `
<article class="o_report_page">
  ${doc.watermark ? `<div class="o_report_watermark">${esc(doc.watermark)}</div>` : ''}
  <header class="o_report_header">
    <div class="o_report_company">
      <div class="o_report_company_name">${esc(doc.company.name)}</div>
      ${party(doc.company.lines)}
      ${doc.company.vat ? `<div>${vat}: ${esc(doc.company.vat)}</div>` : ''}
    </div>
    <div class="o_report_brand">${esc(doc.company.name.slice(0, 1).toUpperCase())}</div>
  </header>
  <div class="o_report_addresses">
    <div class="o_report_partner">
      <div class="o_report_partner_name">${esc(doc.partner.name)}</div>
      ${party(doc.partner.lines)}
      ${doc.partner.vat ? `<div>${vat}: ${esc(doc.partner.vat)}</div>` : ''}
    </div>
  </div>
  <h1 class="o_report_title">${esc(doc.title)} ${doc.number ? `<span class="o_report_number">${esc(doc.number)}</span>` : ''}</h1>
  ${doc.meta.length ? `<div class="o_report_meta">${doc.meta.map((item) => `<div class="o_report_meta_item"><div class="o_report_meta_label">${esc(item.label)}</div><div class="o_report_meta_value">${esc(item.value)}</div></div>`).join('')}</div>` : ''}
  ${columns.length ? `<table class="o_report_lines"><thead><tr>${columns.map((column) => `<th class="${column.numeric ? 'num' : ''}">${esc(column.label)}</th>`).join('')}</tr></thead><tbody>${lines || `<tr><td colspan="${columns.length}" class="o_report_empty">—</td></tr>`}</tbody></table>` : ''}
  ${doc.totals.length ? `<div class="o_report_totals"><table><tbody>${doc.totals.map((total) => `<tr class="${total.strong ? 'strong' : ''}"><td>${esc(total.label)}</td><td class="num">${esc(total.value)}</td></tr>`).join('')}</tbody></table></div>` : ''}
  ${doc.note ? `<div class="o_report_notes">${doc.note}</div>` : ''}
  ${doc.footer ? `<footer class="o_report_footer">${esc(doc.footer)}</footer>` : ''}
</article>`;
}

export function renderReportPage(documents: ReportDocument[], options: { rtl: boolean; title: string; backHref: string; autoPrint: boolean }): string {
  const { rtl, title, backHref, autoPrint } = options;
  return `<!DOCTYPE html>
<html lang="${rtl ? 'ar' : 'en'}" dir="${rtl ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;500;700&family=Noto+Sans+Arabic:wght@400;500;700&display=swap" />
<style>${REPORT_CSS}</style>
</head>
<body>
<div class="o_report_toolbar">
  <span>${esc(title)}</span>
  <span class="o_report_toolbar_actions">
    <button type="button" id="o_report_print">${rtl ? 'طباعة / حفظ PDF' : 'Print / Save as PDF'}</button>
    <a href="${esc(backHref)}">${rtl ? 'رجوع' : 'Back'}</a>
  </span>
</div>
${documents.map((doc) => renderReportDocument(doc, rtl)).join('\n')}
<script>
document.getElementById("o_report_print").addEventListener("click",function(){window.print()});
${autoPrint ? 'window.addEventListener("load",function(){setTimeout(function(){window.print()},400)});' : ''}
</script>
</body>
</html>`;
}

export const REPORT_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; background: #e5e7eb; font-family: "Noto Sans", "Noto Sans Arabic", system-ui, sans-serif; color: #111827; font-size: 13px; }
  .o_report_toolbar { position: sticky; top: 0; display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 10px 24px; background: #714b67; color: #fff; z-index: 2; }
  .o_report_toolbar_actions { display: flex; gap: 12px; align-items: center; }
  .o_report_toolbar button { background: #fff; color: #714b67; border: 0; border-radius: 4px; padding: 6px 14px; font-weight: 700; cursor: pointer; font-family: inherit; }
  .o_report_toolbar a { color: #fff; }
  .o_report_page { position: relative; width: 210mm; min-height: 297mm; margin: 24px auto; padding: 18mm 16mm 22mm; background: #fff; box-shadow: 0 4px 24px rgba(0,0,0,.15); page-break-after: always; }
  .o_report_watermark { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 96px; font-weight: 700; color: rgba(220, 53, 69, 0.12); transform: rotate(-24deg); pointer-events: none; }
  .o_report_header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #714b67; padding-bottom: 10px; margin-bottom: 18px; }
  .o_report_company_name { font-size: 18px; font-weight: 700; color: #714b67; }
  .o_report_brand { width: 56px; height: 56px; border-radius: 10px; background: #714b67; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 28px; font-weight: 700; }
  .o_report_addresses { display: flex; justify-content: flex-end; margin-bottom: 18px; }
  .o_report_partner { min-width: 220px; }
  .o_report_partner_name { font-weight: 700; font-size: 14px; }
  .o_report_title { font-size: 22px; font-weight: 500; margin: 0 0 14px; }
  .o_report_number { font-weight: 700; }
  .o_report_meta { display: flex; flex-wrap: wrap; gap: 24px; margin-bottom: 16px; }
  .o_report_meta_label { font-weight: 700; font-size: 12px; color: #4b5563; }
  .o_report_lines { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
  .o_report_lines th { text-align: start; border-bottom: 2px solid #111827; padding: 6px 6px; font-size: 12px; }
  .o_report_lines td { padding: 6px 6px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  .o_report_lines .num, .o_report_totals .num { text-align: end; white-space: nowrap; direction: ltr; }
  .o_report_section td { font-weight: 700; background: #f3f4f6; }
  .o_report_note_line td { font-style: italic; color: #4b5563; }
  .o_report_empty { text-align: center; color: #9ca3af; }
  .o_report_totals { display: flex; justify-content: flex-end; margin-bottom: 18px; }
  .o_report_totals table { min-width: 260px; border-collapse: collapse; }
  .o_report_totals td { padding: 4px 8px; }
  .o_report_totals tr.strong td { font-weight: 700; font-size: 15px; border-top: 2px solid #111827; }
  .o_report_notes { margin-top: 12px; color: #374151; }
  .o_report_footer { position: absolute; left: 16mm; right: 16mm; bottom: 10mm; border-top: 1px solid #e5e7eb; padding-top: 6px; font-size: 11px; color: #6b7280; text-align: center; }
  @page { size: A4; margin: 0; }
  @media print {
    body { background: #fff; }
    .o_report_toolbar { display: none; }
    .o_report_page { margin: 0; box-shadow: none; width: auto; min-height: 297mm; }
  }
`;
