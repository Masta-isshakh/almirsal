import type { Environment } from '@engine/orm/env';
import type { I18n, Lang } from '@engine/i18n/types';
import { formatDate, formatMonetary, type CurrencyDef } from '@engine/format/index';
import { getRegistry } from './registry';

/**
 * Printable documents (Part H reports, first slice): a report name and ids
 * become a language-neutral `ReportDocument` that `ReportPage` renders as
 * printable HTML — the browser's "Save as PDF" does the PDF, so nothing
 * runs server-side but a few reads (cheapest possible on AWS, and Arabic
 * shaping comes for free from the browser).
 */

export interface ReportParty { name: string; lines: string[]; vat?: string; email?: string; phone?: string; website?: string }

/**
 * What "Configure Document Layout" chose (`base.document.layout` writes it on
 * the company): the logo, the two colours, the font, the tagline, the footer and
 * the paper format. Odoo's four layouts differ only in how they draw, so the
 * name travels with the document and the stylesheet does the rest.
 */
export interface ReportLayout {
  style: 'light' | 'boxed' | 'bold' | 'striped';
  logo?: string;
  primaryColor: string;
  secondaryColor: string;
  font: string;
  tagline?: string;
  details?: string;
  footer?: string;
  page: { width: number; height: number; margins: { top: number; right: number; bottom: number; left: number } };
}
export interface ReportLine { kind: 'product' | 'section' | 'note'; name: string; quantity?: string; price?: string; discount?: string; taxes?: string; subtotal?: string }
export interface ReportDocument {
  model: string;
  id: number;
  title: string;
  number: string;
  watermark?: string;
  company: ReportParty;
  partner: ReportParty;
  meta: { label: string; value: string }[];
  columns: { key: keyof ReportLine; label: string; numeric?: boolean }[];
  lines: ReportLine[];
  totals: { label: string; value: string; strong?: boolean }[];
  note?: string;
  footer?: string;
  layout?: ReportLayout;
}

export interface ReportSpec { reportName: string; model: string; name: I18n }

type Rec = Record<string, unknown>;
const m2oName = (value: unknown): string => (Array.isArray(value) ? String(value[1] ?? '') : value && typeof value === 'object' ? String((value as Rec).display_name ?? '') : '');
const m2oId = (value: unknown): number | null => (Array.isArray(value) ? Number(value[0]) : value && typeof value === 'object' ? Number((value as Rec).id) : typeof value === 'number' ? value : null);

/** Report by name (`sale.report_saleorder`) or by action-ish key (`sale.action_report_saleorder`). */
export function findReport(key: string): ReportSpec | null {
  const registry = getRegistry();
  const normalised = key.replace('.action_report_', '.report_');
  const report = registry.reports.find((item) => item.reportName === key || item.reportName === normalised);
  if (report) return { reportName: report.reportName, model: report.model, name: report.name };
  if (registry.models[key]) return { reportName: key, model: key, name: registry.models[key].description };
  return null;
}

/** Reports offered for a model (the form's Print menu). */
export function reportsFor(model: string): ReportSpec[] {
  const seen = new Set<string>();
  return getRegistry().reports.filter((item) => item.model === model && item.type !== 'qweb-html')
    .filter((item) => { if (seen.has(item.name.en)) return false; seen.add(item.name.en); return true; })
    .map((item) => ({ reportName: item.reportName, model: item.model, name: item.name }));
}

async function party(env: Environment, model: 'res.company' | 'res.partner', id: number | null): Promise<ReportParty> {
  if (!id) return { name: '', lines: [] };
  const def = env.registry.models[model];
  const wanted = ['name', 'street', 'street2', 'city', 'zip', 'state_id', 'country_id', 'vat', 'email', 'phone', 'website'].filter((name) => def.fields[name]);
  const [row] = await env.sudo().model(model).read(id, wanted);
  if (!row) return { name: '', lines: [] };
  const text = (value: unknown) => (value === false || value == null ? '' : String(value));
  const cityLine = [text(row.zip), text(row.city)].filter(Boolean).join(' ');
  const region = [m2oName(row.state_id), m2oName(row.country_id)].filter(Boolean).join(', ');
  return {
    name: String(row.name ?? ''),
    lines: [text(row.street), text(row.street2), cityLine, region].filter((line) => line.trim()),
    vat: row.vat ? String(row.vat) : undefined, email: row.email ? String(row.email) : undefined, phone: row.phone ? String(row.phone) : undefined, website: row.website ? String(row.website) : undefined,
  };
}

function tr(lang: Lang, en: string, ar: string): string { return lang === 'ar_001' ? ar : en; }

/** A4 in millimetres, which is what `report.paperformat` measures in. */
const A4 = { width: 210, height: 297, margins: { top: 20, right: 15, bottom: 20, left: 15 } };

/** The style behind an `external_report_layout_id`, by the view's name. */
function layoutStyle(key: string): ReportLayout['style'] {
  if (/boxed/.test(key)) return 'boxed';
  if (/bold/.test(key)) return 'bold';
  if (/striped/.test(key)) return 'striped';
  return 'light';
}

/** The layout the company saved, with Odoo's defaults where it saved nothing. */
export async function reportLayout(env: Environment, companyId: number | null): Promise<ReportLayout> {
  const fields = env.registry.models['res.company'].fields;
  const wanted = ['logo', 'primary_color', 'secondary_color', 'font', 'external_report_layout_id', 'report_header', 'report_footer', 'company_details', 'paperformat_id']
    .filter((name) => fields[name]);
  const [row] = companyId ? await env.sudo().model('res.company').read(companyId, wanted).catch(() => [] as Rec[]) : [];
  const company = row ?? {};
  let style: ReportLayout['style'] = 'light';
  const layoutId = m2oId(company.external_report_layout_id);
  if (layoutId && env.registry.models['ir.ui.view']) {
    const [view] = await env.sudo().model('ir.ui.view').read(layoutId, ['key', 'name']).catch(() => [] as Rec[]);
    style = layoutStyle(`${String(view?.key ?? '')} ${String(view?.name ?? '')}`.toLowerCase());
  }
  let page = A4;
  const formatId = m2oId(company.paperformat_id);
  if (formatId && env.registry.models['report.paperformat']) {
    const [format] = await env.sudo().model('report.paperformat').read(formatId, ['format', 'page_width', 'page_height', 'margin_top', 'margin_bottom', 'margin_left', 'margin_right', 'orientation']).catch(() => [] as Rec[]);
    if (format) {
      const width = Number(format.page_width) || (format.format === 'Letter' ? 216 : A4.width);
      const height = Number(format.page_height) || (format.format === 'Letter' ? 279 : A4.height);
      const landscape = format.orientation === 'Landscape';
      page = {
        width: landscape ? height : width,
        height: landscape ? width : height,
        margins: {
          top: Number(format.margin_top) || A4.margins.top,
          right: Number(format.margin_right) || A4.margins.right,
          bottom: Number(format.margin_bottom) || A4.margins.bottom,
          left: Number(format.margin_left) || A4.margins.left,
        },
      };
    }
  }
  const text = (value: unknown) => (value === false || value == null || String(value).trim() === '' ? undefined : String(value));
  const logo = typeof company.logo === 'string' && company.logo.length > 32 ? `data:image/png;base64,${company.logo}` : undefined;
  return {
    style,
    logo,
    primaryColor: text(company.primary_color) ?? '#714B67',
    secondaryColor: text(company.secondary_color) ?? '#017E84',
    font: text(company.font) ?? 'Noto Sans',
    tagline: text(company.report_header),
    details: text(company.company_details),
    footer: text(company.report_footer),
    page,
  };
}

async function currencyOf(env: Environment, value: unknown): Promise<CurrencyDef> {
  const id = m2oId(value);
  if (!id) return { name: '', symbol: '', position: 'after', decimalPlaces: 2, rounding: 0.01 };
  const [row] = await env.sudo().model('res.currency').read(id, ['name', 'symbol', 'position', 'decimal_places', 'rounding']);
  return { name: String(row?.name ?? ''), symbol: String(row?.symbol ?? ''), position: row?.position === 'before' ? 'before' : 'after', decimalPlaces: Number(row?.decimal_places ?? 2), rounding: Number(row?.rounding ?? 0.01) };
}

export async function renderReport(env: Environment, spec: ReportSpec, id: number): Promise<ReportDocument> {
  const lang = env.lang;
  const document = spec.model === 'sale.order' ? await saleOrder(env, spec, id, lang)
    : spec.model === 'account.move' ? await invoice(env, spec, id, lang)
      : await generic(env, spec, id, lang);
  // The company of the record, so a second company prints its own layout.
  const [row] = await env.sudo().model(spec.model).read(id, env.registry.models[spec.model].fields.company_id ? ['company_id'] : []).catch(() => [] as Rec[]);
  document.layout = await reportLayout(env, m2oId(row?.company_id) ?? env.companyId);
  return document;
}

async function saleOrder(env: Environment, spec: ReportSpec, id: number, lang: Lang): Promise<ReportDocument> {
  const orders = env.model('sale.order');
  const [order] = await orders.read(id, ['name', 'state', 'partner_id', 'partner_invoice_id', 'company_id', 'currency_id', 'date_order', 'validity_date', 'client_order_ref', 'payment_term_id', 'user_id', 'note', 'order_line', 'amount_untaxed', 'amount_tax', 'amount_total']);
  if (!order) throw new Error('Order not found');
  const currency = await currencyOf(env, order.currency_id);
  const money = (value: unknown) => formatMonetary(Number(value ?? 0), currency);
  const proForma = spec.reportName.includes('pro_forma');
  const quotation = order.state === 'draft' || order.state === 'sent';
  const title = proForma ? tr(lang, 'PRO-FORMA Invoice', 'فاتورة شكلية') : quotation ? tr(lang, 'Quotation', 'عرض سعر') : tr(lang, 'Order', 'الطلب');
  const lineRows = await env.model('sale.order.line').read(order.order_line as number[], ['name', 'display_type', 'product_uom_qty', 'product_uom_id', 'price_unit', 'discount', 'tax_ids', 'price_subtotal']);
  const taxNames = await taxLabels(env, lineRows);
  const lines: ReportLine[] = lineRows.map((line) => {
    if (line.display_type === 'line_section') return { kind: 'section', name: String(line.name ?? '') };
    if (line.display_type === 'line_note') return { kind: 'note', name: String(line.name ?? '') };
    return {
      kind: 'product', name: String(line.name ?? ''),
      quantity: `${trimNumber(Number(line.product_uom_qty ?? 0))}${m2oName(line.product_uom_id) ? ` ${m2oName(line.product_uom_id)}` : ''}`,
      price: money(line.price_unit), discount: Number(line.discount ?? 0) ? `${trimNumber(Number(line.discount))}%` : '',
      taxes: taxNames(line.tax_ids), subtotal: money(line.price_subtotal),
    };
  });
  const meta = [
    { label: quotation ? tr(lang, 'Quotation Date', 'تاريخ عرض السعر') : tr(lang, 'Order Date', 'تاريخ الطلب'), value: formatDate(String(order.date_order ?? '').slice(0, 10), lang) },
    ...(quotation && order.validity_date ? [{ label: tr(lang, 'Expiration', 'تاريخ الانتهاء'), value: formatDate(String(order.validity_date), lang) }] : []),
    ...(order.client_order_ref ? [{ label: tr(lang, 'Your Reference', 'مرجعكم'), value: String(order.client_order_ref) }] : []),
    ...(m2oName(order.payment_term_id) ? [{ label: tr(lang, 'Payment Terms', 'شروط السداد'), value: m2oName(order.payment_term_id) }] : []),
    ...(m2oName(order.user_id) ? [{ label: tr(lang, 'Salesperson', 'مندوب المبيعات'), value: m2oName(order.user_id) }] : []),
  ];
  return {
    model: 'sale.order', id, title, number: String(order.name ?? ''),
    watermark: order.state === 'cancel' ? tr(lang, 'CANCELLED', 'ملغى') : undefined,
    company: await party(env, 'res.company', m2oId(order.company_id) ?? env.companyId),
    partner: await party(env, 'res.partner', m2oId(order.partner_invoice_id) ?? m2oId(order.partner_id)),
    meta,
    columns: lineColumns(lang),
    lines,
    totals: [
      { label: tr(lang, 'Untaxed Amount', 'المبلغ غير شامل الضريبة'), value: money(order.amount_untaxed) },
      { label: tr(lang, 'Taxes', 'الضرائب'), value: money(order.amount_tax) },
      { label: tr(lang, 'Total', 'الإجمالي'), value: money(order.amount_total), strong: true },
    ],
    note: order.note ? String(order.note) : undefined,
    footer: partyFooter(await party(env, 'res.company', m2oId(order.company_id) ?? env.companyId)),
  };
}

async function invoice(env: Environment, spec: ReportSpec, id: number, lang: Lang): Promise<ReportDocument> {
  const moves = env.model('account.move');
  const [move] = await moves.read(id, ['name', 'state', 'move_type', 'partner_id', 'company_id', 'currency_id', 'invoice_date', 'invoice_date_due', 'invoice_origin', 'ref', 'payment_reference', 'invoice_payment_term_id', 'invoice_user_id', 'narration', 'invoice_line_ids', 'amount_untaxed', 'amount_tax', 'amount_total', 'amount_residual']);
  if (!move) throw new Error('Invoice not found');
  const currency = await currencyOf(env, move.currency_id);
  const money = (value: unknown) => formatMonetary(Number(value ?? 0), currency);
  const type = String(move.move_type ?? 'out_invoice');
  const draft = move.state === 'draft';
  const base = type === 'out_refund' ? tr(lang, 'Credit Note', 'إشعار دائن') : type === 'in_invoice' ? tr(lang, 'Vendor Bill', 'فاتورة مورد') : type === 'in_refund' ? tr(lang, 'Vendor Credit Note', 'إشعار دائن للمورد') : tr(lang, 'Invoice', 'فاتورة');
  const title = draft ? `${tr(lang, 'Draft', 'مسودة')} ${base}` : base;
  const lineRows = await env.model('account.move.line').read(move.invoice_line_ids as number[], ['name', 'display_type', 'quantity', 'product_uom_id', 'price_unit', 'discount', 'tax_ids', 'price_subtotal']);
  const taxNames = await taxLabels(env, lineRows);
  const lines: ReportLine[] = lineRows.map((line) => {
    if (line.display_type === 'line_section') return { kind: 'section', name: String(line.name ?? '') };
    if (line.display_type === 'line_note') return { kind: 'note', name: String(line.name ?? '') };
    return {
      kind: 'product', name: String(line.name ?? ''),
      quantity: `${trimNumber(Number(line.quantity ?? 0))}${m2oName(line.product_uom_id) ? ` ${m2oName(line.product_uom_id)}` : ''}`,
      price: money(line.price_unit), discount: Number(line.discount ?? 0) ? `${trimNumber(Number(line.discount))}%` : '',
      taxes: taxNames(line.tax_ids), subtotal: money(line.price_subtotal),
    };
  });
  const meta = [
    ...(move.invoice_date ? [{ label: tr(lang, 'Invoice Date', 'تاريخ الفاتورة'), value: formatDate(String(move.invoice_date), lang) }] : []),
    ...(move.invoice_date_due ? [{ label: tr(lang, 'Due Date', 'تاريخ الاستحقاق'), value: formatDate(String(move.invoice_date_due), lang) }] : []),
    ...(move.invoice_origin ? [{ label: tr(lang, 'Source', 'المصدر'), value: String(move.invoice_origin) }] : []),
    ...(move.ref ? [{ label: tr(lang, 'Reference', 'المرجع'), value: String(move.ref) }] : []),
    ...(m2oName(move.invoice_payment_term_id) ? [{ label: tr(lang, 'Payment Terms', 'شروط السداد'), value: m2oName(move.invoice_payment_term_id) }] : []),
  ];
  const totals = [
    { label: tr(lang, 'Untaxed Amount', 'المبلغ غير شامل الضريبة'), value: money(move.amount_untaxed) },
    { label: tr(lang, 'Taxes', 'الضرائب'), value: money(move.amount_tax) },
    { label: tr(lang, 'Total', 'الإجمالي'), value: money(move.amount_total), strong: true },
  ];
  if (!draft && !spec.reportName.endsWith('report_invoice') && Number(move.amount_residual ?? 0) !== Number(move.amount_total ?? 0)) {
    totals.push({ label: tr(lang, 'Paid', 'المدفوع'), value: money(Number(move.amount_total ?? 0) - Number(move.amount_residual ?? 0)) });
    totals.push({ label: tr(lang, 'Amount Due', 'المبلغ المستحق'), value: money(move.amount_residual), strong: true });
  }
  const company = await party(env, 'res.company', m2oId(move.company_id) ?? env.companyId);
  return {
    model: 'account.move', id, title, number: draft ? '' : String(move.name ?? ''),
    watermark: move.state === 'cancel' ? tr(lang, 'CANCELLED', 'ملغى') : undefined,
    company, partner: await party(env, 'res.partner', m2oId(move.partner_id)),
    meta, columns: lineColumns(lang), lines, totals,
    note: [move.payment_reference ? `${tr(lang, 'Payment Communication', 'مرجع الدفع')}: ${move.payment_reference}` : '', move.narration ? String(move.narration) : ''].filter(Boolean).join('<br/>') || undefined,
    footer: partyFooter(company),
  };
}

async function generic(env: Environment, spec: ReportSpec, id: number, lang: Lang): Promise<ReportDocument> {
  const def = env.registry.models[spec.model];
  const names = Object.values(def.fields).filter((f) => ['char', 'date', 'datetime', 'selection', 'many2one', 'float', 'integer', 'monetary', 'boolean'].includes(f.type) && !['id', 'create_uid', 'write_uid'].includes(f.name)).slice(0, 24).map((f) => f.name);
  const [row] = await env.model(spec.model).read(id, [...names, 'display_name']);
  const meta = names.filter((name) => row[name] !== false && row[name] !== null && row[name] !== '').map((name) => {
    const field = def.fields[name];
    const value = row[name];
    const text = field.type === 'many2one' ? m2oName(value) : field.type === 'selection' ? (lang === 'ar_001' ? field.selection?.find((o) => o.value === value)?.label.ar : field.selection?.find((o) => o.value === value)?.label.en) ?? String(value) : field.type === 'date' ? formatDate(String(value), lang) : String(value);
    return { label: lang === 'ar_001' ? field.label.ar || field.label.en : field.label.en, value: text };
  });
  const company = await party(env, 'res.company', env.companyId);
  return { model: spec.model, id, title: lang === 'ar_001' ? spec.name.ar || spec.name.en : spec.name.en, number: String(row.display_name ?? ''), company, partner: { name: '', lines: [] }, meta, columns: [], lines: [], totals: [], footer: partyFooter(company) };
}

function lineColumns(lang: Lang): ReportDocument['columns'] {
  return [
    { key: 'name', label: tr(lang, 'Description', 'الوصف') }, { key: 'quantity', label: tr(lang, 'Quantity', 'الكمية'), numeric: true },
    { key: 'price', label: tr(lang, 'Unit Price', 'سعر الوحدة'), numeric: true }, { key: 'discount', label: tr(lang, 'Disc.%', 'خصم %'), numeric: true },
    { key: 'taxes', label: tr(lang, 'Taxes', 'الضرائب') }, { key: 'subtotal', label: tr(lang, 'Amount', 'المبلغ'), numeric: true },
  ];
}

async function taxLabels(env: Environment, lines: Rec[]): Promise<(value: unknown) => string> {
  const ids = [...new Set(lines.flatMap((line) => (Array.isArray(line.tax_ids) ? (line.tax_ids as unknown[]).map((v) => m2oId(v) ?? Number(v)) : [])))].filter((v) => Number.isFinite(v) && v > 0);
  const names = ids.length && env.registry.models['account.tax'] ? await env.sudo().model('account.tax').displayNames(ids) : new Map<number, string>();
  return (value: unknown) => (Array.isArray(value) ? (value as unknown[]).map((v) => names.get(m2oId(v) ?? Number(v)) ?? '').filter(Boolean).join(', ') : '');
}

function partyFooter(company: ReportParty): string {
  return [company.name, ...company.lines, company.phone, company.email, company.website, company.vat ? `VAT: ${company.vat}` : ''].filter(Boolean).join(' · ');
}

function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '');
}
