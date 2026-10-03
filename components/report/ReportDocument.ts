import type { ReportDocument, ReportLayout } from '@/lib/server/reports';

/**
 * The printable page shared by every report: company header, document title and
 * number, customer block, key facts, lines table, totals, note and footer.
 * Rendered as an HTML string (route handlers may not use react-dom/server),
 * escaped field by field.
 *
 * What "Configure Document Layout" chose travels with the document — the logo,
 * the two colours, the font, the tagline, the footer and the paper format — and
 * Odoo's four layouts (Light, Boxed, Bold, Striped) are the same page drawn
 * differently, so the style name goes on the page and the stylesheet does the
 * rest.
 */
const esc = (value: unknown): string => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Html from the database (a footer, the details block, a document note): no scripts. */
const safeHtml = (value: string): string => value
  .replace(/<\s*(script|style|iframe|object|embed|link|meta)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
  .replace(/<\s*(script|style|iframe|object|embed|link|meta)\b[^>]*>/gi, '')
  .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  .replace(/javascript:/gi, '');

const DEFAULT_LAYOUT: ReportLayout = {
  style: 'light',
  primaryColor: '#714B67',
  secondaryColor: '#017E84',
  font: 'Noto Sans',
  page: { width: 210, height: 297, margins: { top: 20, right: 15, bottom: 20, left: 15 } },
};

export function renderReportDocument(doc: ReportDocument, rtl: boolean): string {
  const layout = doc.layout ?? DEFAULT_LAYOUT;
  const vat = rtl ? 'الرقم الضريبي' : 'VAT';
  const party = (lines: string[]) => lines.map((line) => `<div>${esc(line)}</div>`).join('');
  const columns = doc.columns;
  const lines = doc.lines.map((line) => (line.kind === 'product'
    ? `<tr>${columns.map((column) => `<td class="${column.numeric ? 'num' : ''}">${esc(line[column.key])}</td>`).join('')}</tr>`
    : `<tr class="${line.kind === 'section' ? 'o_report_section' : 'o_report_note_line'}"><td colspan="${columns.length}">${esc(line.name)}</td></tr>`)).join('');
  const brand = layout.logo
    ? `<img class="o_report_logo" src="${esc(layout.logo)}" alt="${esc(doc.company.name)}" />`
    : `<div class="o_report_brand">${esc(doc.company.name.slice(0, 1).toUpperCase())}</div>`;
  return `
<article class="o_report_page" data-layout="${esc(layout.style)}">
  ${doc.watermark ? `<div class="o_report_watermark">${esc(doc.watermark)}</div>` : ''}
  <header class="o_report_header">
    <div class="o_report_company">
      <div class="o_report_company_name">${esc(doc.company.name)}</div>
      ${layout.tagline ? `<div class="o_report_tagline">${esc(layout.tagline)}</div>` : ''}
      ${layout.details ? `<div class="o_report_details">${safeHtml(layout.details)}</div>` : party(doc.company.lines)}
      ${doc.company.vat ? `<div>${vat}: ${esc(doc.company.vat)}</div>` : ''}
    </div>
    ${brand}
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
  ${doc.note ? `<div class="o_report_notes">${safeHtml(doc.note)}</div>` : ''}
  <footer class="o_report_footer">
    ${layout.footer ? `<div class="o_report_footer_custom">${safeHtml(layout.footer)}</div>` : ''}
    ${doc.footer ? `<div>${esc(doc.footer)}</div>` : ''}
  </footer>
</article>`;
}

export function renderReportPage(documents: ReportDocument[], options: { rtl: boolean; title: string; backHref: string; autoPrint: boolean }): string {
  const { rtl, title, backHref, autoPrint } = options;
  const layout = documents[0]?.layout ?? DEFAULT_LAYOUT;
  const { page } = layout;
  // The font the layout names, loaded from Google Fonts beside the two the
  // page always needs (Arabic among them).
  const families = ['Noto Sans:wght@400;500;700', 'Noto Sans Arabic:wght@400;500;700'];
  if (layout.font && !/noto sans/i.test(layout.font)) families.push(`${layout.font}:wght@400;500;700`);
  const fontsHref = `https://fonts.googleapis.com/css2?${families.map((family) => `family=${encodeURIComponent(family).replace(/%3A/g, ':').replace(/%40/g, '@').replace(/%3B/g, ';')}`).join('&')}&display=swap`;
  const variables = [
    `--o-report-primary: ${cssColor(layout.primaryColor, DEFAULT_LAYOUT.primaryColor)}`,
    `--o-report-secondary: ${cssColor(layout.secondaryColor, DEFAULT_LAYOUT.secondaryColor)}`,
    `--o-report-font: ${cssFont(layout.font)}`,
    `--o-report-width: ${page.width}mm`,
    `--o-report-height: ${page.height}mm`,
    `--o-report-margin-top: ${page.margins.top}mm`,
    `--o-report-margin-right: ${page.margins.right}mm`,
    `--o-report-margin-bottom: ${page.margins.bottom}mm`,
    `--o-report-margin-left: ${page.margins.left}mm`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="${rtl ? 'ar' : 'en'}" dir="${rtl ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="stylesheet" href="${esc(fontsHref)}" />
<style>:root { ${variables}; }
@page { size: ${page.width}mm ${page.height}mm; margin: 0; }
${REPORT_CSS}</style>
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

/** A colour the company saved, if it is one; else the default. */
function cssColor(value: string | undefined, fallback: string): string {
  return value && /^(#[0-9a-f]{3,8}|rgb\(|rgba\(|hsl\(|[a-z]+)$/i.test(value.trim()) ? value.trim() : fallback;
}

/** A font family name, quoted, with the fallbacks every page needs. */
function cssFont(value: string | undefined): string {
  const name = (value ?? '').replace(/["'\\;{}]/g, '').trim();
  return `${name ? `"${name}", ` : ''}"Noto Sans", "Noto Sans Arabic", system-ui, sans-serif`;
}

export const REPORT_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; background: #e5e7eb; font-family: var(--o-report-font); color: #111827; font-size: 13px; }
  .o_report_toolbar { position: sticky; top: 0; display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 10px 24px; background: var(--o-report-primary); color: #fff; z-index: 2; }
  .o_report_toolbar_actions { display: flex; gap: 12px; align-items: center; }
  .o_report_toolbar button { background: #fff; color: var(--o-report-primary); border: 0; border-radius: 4px; padding: 6px 14px; font-weight: 700; cursor: pointer; font-family: inherit; }
  .o_report_toolbar a { color: #fff; }
  .o_report_page { position: relative; width: var(--o-report-width); min-height: var(--o-report-height); margin: 24px auto; padding: var(--o-report-margin-top) var(--o-report-margin-right) var(--o-report-margin-bottom) var(--o-report-margin-left); background: #fff; box-shadow: 0 4px 24px rgba(0,0,0,.15); page-break-after: always; }
  .o_report_watermark { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 96px; font-weight: 700; color: rgba(220, 53, 69, 0.12); transform: rotate(-24deg); pointer-events: none; }
  .o_report_header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid var(--o-report-primary); padding-bottom: 10px; margin-bottom: 18px; }
  .o_report_company_name { font-size: 18px; font-weight: 700; color: var(--o-report-primary); }
  .o_report_tagline { color: var(--o-report-secondary); font-size: 12px; margin-bottom: 4px; }
  .o_report_details p { margin: 0; }
  .o_report_logo { max-height: 22mm; max-width: 60mm; object-fit: contain; }
  .o_report_brand { width: 56px; height: 56px; border-radius: 10px; background: var(--o-report-primary); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 28px; font-weight: 700; }
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
  .o_report_footer { position: absolute; left: var(--o-report-margin-left); right: var(--o-report-margin-right); bottom: calc(var(--o-report-margin-bottom) / 2); border-top: 1px solid #e5e7eb; padding-top: 6px; font-size: 11px; color: #6b7280; text-align: center; }
  .o_report_footer p { margin: 0; }

  /* Odoo's four layouts: the same page, drawn differently. */
  .o_report_page[data-layout="boxed"] .o_report_header { border: 1px solid var(--o-report-primary); border-bottom-width: 1px; padding: 10px; }
  .o_report_page[data-layout="boxed"] .o_report_lines th, .o_report_page[data-layout="boxed"] .o_report_lines td { border: 1px solid #d1d5db; }
  .o_report_page[data-layout="boxed"] .o_report_partner { border: 1px solid #d1d5db; padding: 8px; }
  .o_report_page[data-layout="bold"] .o_report_header { background: var(--o-report-primary); color: #fff; padding: 12px; border-bottom: 0; }
  .o_report_page[data-layout="bold"] .o_report_company_name, .o_report_page[data-layout="bold"] .o_report_tagline { color: #fff; }
  .o_report_page[data-layout="bold"] .o_report_brand { background: #fff; color: var(--o-report-primary); }
  .o_report_page[data-layout="bold"] .o_report_lines th { background: var(--o-report-secondary); color: #fff; border-bottom: 0; }
  .o_report_page[data-layout="striped"] .o_report_lines tbody tr:nth-child(odd) td { background: #f9fafb; }
  .o_report_page[data-layout="striped"] .o_report_lines th { border-bottom-color: var(--o-report-primary); }

  @media print {
    body { background: #fff; }
    .o_report_toolbar { display: none; }
    .o_report_page { margin: 0; box-shadow: none; width: auto; min-height: var(--o-report-height); }
  }
`;
