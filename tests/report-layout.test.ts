import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgliteDatabase } from '../packages/engine/db/pglite.js';
import type { Database } from '../packages/engine/db/types.js';
import { syncSchema } from '../packages/engine/schema/ddl.js';
import { loadSeed } from '../packages/engine/seed/load.js';
import { testRegistry } from '../packages/engine/testing/registry.js';
import { Environment } from '../packages/engine/orm/env.js';
import { clearModelHooks } from '../packages/engine/orm/hooks.js';
import { registerApps } from '../packages/apps/index.js';
import { findReport, renderReport, reportLayout } from '../lib/server/reports.js';
import { renderReportPage } from '../components/report/ReportDocument.js';

/**
 * "Configure Document Layout" must reach the printed page: the logo, the two
 * colours, the font, the tagline, the footer and the paper format. Before this,
 * the wizard saved them and every report ignored them.
 */
const registry = testRegistry();
let db: Database;
let env: Environment;

beforeAll(async () => {
  db = pgliteDatabase();
  await syncSchema(db, registry);
  await loadSeed(db, registry);
  clearModelHooks();
  registerApps(registry);
  env = new Environment({ registry, db, uid: 2, companyIds: [1], superuser: true });
}, 240_000);

afterAll(async () => { await db.close?.(); });

describe('document layout', () => {
  it('falls back to Odoo\'s defaults when the company saved nothing', async () => {
    const layout = await reportLayout(env, 1);
    expect(layout).toMatchObject({ style: 'light', primaryColor: '#714B67', secondaryColor: '#017E84' });
    expect(layout.page).toEqual({ width: 210, height: 297, margins: { top: 20, right: 15, bottom: 20, left: 15 } });
  });

  it('carries what the wizard saves onto the page', async () => {
    const wizard = env.model('base.document.layout');
    const values = await wizard.defaultGet();
    expect(values).toMatchObject({ company_id: 1, primary_color: '#714B67' });
    const id = await wizard.create({
      ...values,
      primary_color: '#123456',
      secondary_color: '#abcdef',
      font: 'Roboto',
      report_header: 'We sell the best',
      report_footer: '<p>Bank: 1234</p>',
      logo: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF/gg8AAAAASUVORK5CYII=',
    });
    await wizard.callButton(id, 'document_layout_save');

    const layout = await reportLayout(env, 1);
    expect(layout).toMatchObject({ primaryColor: '#123456', secondaryColor: '#abcdef', font: 'Roboto', tagline: 'We sell the best' });
    expect(layout.logo).toMatch(/^data:image\/png;base64,/);
    expect(layout.footer).toContain('Bank: 1234');

    // And the page uses them, rather than the built-in purple.
    const partner = await env.model('res.partner').create({ name: 'Layout Customer' });
    const order = await env.model('sale.order').create({ partner_id: partner });
    const spec = findReport('sale.report_saleorder');
    expect(spec).toBeTruthy();
    const document = await renderReport(env, spec!, order);
    const html = renderReportPage([document], { rtl: false, title: 'Quotation', backHref: '/odoo', autoPrint: false });
    expect(html).toContain('--o-report-primary: #123456');
    expect(html).toContain('"Roboto"');
    expect(html).toContain('data:image/png;base64,');
    expect(html).toContain('We sell the best');
    expect(html).toContain('Bank: 1234');
    expect(html).toContain('@page { size: 210mm 297mm');
  });

  it('follows the paper format the company chose', async () => {
    const letter = await env.model('report.paperformat').create({ name: 'US Letter', format: 'Letter', page_width: 216, page_height: 279, margin_top: 25, margin_bottom: 25, margin_left: 20, margin_right: 20, orientation: 'Portrait' });
    await env.sudo().model('res.company').write(1, { paperformat_id: letter });
    const layout = await reportLayout(env, 1);
    expect(layout.page).toEqual({ width: 216, height: 279, margins: { top: 25, right: 20, bottom: 25, left: 20 } });

    await env.sudo().model('report.paperformat').write(letter, { orientation: 'Landscape' });
    expect((await reportLayout(env, 1)).page).toMatchObject({ width: 279, height: 216 });
  });

  it('keeps scripts out of the html the company supplies', async () => {
    await env.sudo().model('res.company').write(1, { report_footer: '<p onclick="steal()">Call us<script>alert(1)</script></p>' });
    const partner = await env.model('res.partner').create({ name: 'Safe Customer' });
    const order = await env.model('sale.order').create({ partner_id: partner });
    const document = await renderReport(env, findReport('sale.report_saleorder')!, order);
    const html = renderReportPage([document], { rtl: false, title: 'Quotation', backHref: '/odoo', autoPrint: false });
    expect(html).toContain('Call us');
    expect(html).not.toContain('alert(1)');
    expect(html).not.toContain('onclick');
  });
});
