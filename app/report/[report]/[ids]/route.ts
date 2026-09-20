import { NextResponse } from 'next/server';
import { getEnvironment, getRequestLang, getSessionUser } from '@/lib/server/session';
import { findReport, renderReport, type ReportDocument } from '@/lib/server/reports';
import { renderReportPage } from '@/components/report/ReportDocument';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `/report/<report_name>/<id[,id]>` — the printable document as a standalone
 * HTML page (outside the web client's layout). `?print=1` opens the print
 * dialog on load; "Save as PDF" there makes the PDF.
 */
export async function GET(request: Request, context: { params: Promise<{ report: string; ids: string }> }): Promise<Response> {
  const { report, ids } = await context.params;
  const url = new URL(request.url);
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL(`/web/login?redirect=${encodeURIComponent(url.pathname + url.search)}`, url));
  const spec = findReport(decodeURIComponent(report));
  if (!spec) return new NextResponse('Unknown report', { status: 404 });
  const lang = await getRequestLang(user);
  const env = await getEnvironment(user, lang);
  const list = ids.split(',').map(Number).filter((id) => id > 0);
  const documents: ReportDocument[] = [];
  for (const id of list) {
    try { documents.push(await renderReport(env, spec, id)); } catch (error) { console.error(`report ${spec.reportName}#${id}`, error); }
  }
  if (documents.length === 0) return new NextResponse('Nothing to print', { status: 404 });
  const rtl = lang === 'ar_001';
  const title = documents.map((doc) => `${doc.title} ${doc.number}`.trim()).join(', ');
  const html = renderReportPage(documents, { rtl, title, backHref: `/odoo/m/${spec.model}/${list[0]}`, autoPrint: url.searchParams.get('print') === '1' });
  return new NextResponse(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
