import { describe, expect, it } from 'vitest';
import { renderPortalPage } from '../components/report/PortalPage.js';
import type { ReportDocument } from '../lib/server/reports.js';

/**
 * The portal shows a document to somebody outside the company, so what reaches
 * that page is checked here: a note or a footer written in the back office is
 * html, and it must not be able to carry a script to a customer's browser.
 */
const document = (note: string): ReportDocument => ({
  model: 'sale.order',
  id: 1,
  title: 'Quotation',
  number: 'S00001',
  company: { name: 'Almirsal', lines: ['Riyadh'] },
  partner: { name: 'Customer', lines: [] },
  meta: [],
  columns: [{ key: 'name', label: 'Description' }],
  lines: [{ kind: 'product', name: 'Service' }],
  totals: [{ label: 'Total', value: '100.00', strong: true }],
  note,
  layout: {
    style: 'light', primaryColor: '#714B67', secondaryColor: '#017E84', font: 'Noto Sans',
    footer: '<p onmouseover="steal()">Bank: 1<script>alert(1)</script></p>',
    page: { width: 210, height: 297, margins: { top: 20, right: 15, bottom: 20, left: 15 } },
  },
});

const page = (note: string): string => renderPortalPage(document(note), {
  rtl: false, title: 'Quotation S00001', status: 'Waiting for your answer', statusTone: 'waiting',
  actions: [{ id: 'print', label: 'Print' }], printHref: '/report/sale.report_saleorder/1', postUrl: '/my/orders/1?access_token=x',
});

describe('what the portal will render', () => {
  it('keeps the words of a note and drops the script', () => {
    const html = page('<p>Payment within 15 days</p><script>alert("xss")</script>');
    expect(html).toContain('Payment within 15 days');
    expect(html).not.toContain('alert("xss")');
    expect(html).not.toContain('<script>alert');
  });

  it('drops event handlers and javascript urls', () => {
    const html = page('<p onclick="steal()">Terms</p><a href="javascript:steal()">here</a>');
    expect(html).toContain('Terms');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('javascript:');
  });

  it('cleans the footer the company saved as well', () => {
    const html = page('<p>Fine</p>');
    expect(html).toContain('Bank: 1');
    expect(html).not.toContain('onmouseover');
    expect(html).not.toContain('alert(1)');
  });

  it('escapes the values around it', () => {
    const html = renderPortalPage({ ...document('<p>ok</p>'), number: 'S<script>1' }, {
      rtl: false, title: 'Quotation S<script>1', status: 'Waiting', statusTone: 'waiting',
      actions: [{ id: 'print', label: 'Print' }], printHref: '/report/x/1', postUrl: '/my/orders/1?access_token=x',
    });
    expect(html).toContain('S&lt;script&gt;1');
    expect(html).not.toContain('<script>1');
  });
});
