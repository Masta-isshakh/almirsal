// Arabic scan: walk every app's navbar sections and a few screens and report
// any label still rendered in Latin script.
//
//   npm install --no-save playwright-core
//   BASE=http://localhost:3050 node scripts/dev/ar-scan.js
//
// Brand and identifier names (Odoo, PEPPOL, Gmail, A4…) stay in Latin in
// Arabic Odoo too, so a small allow-list keeps them out of the report.
const { chromium } = require('playwright-core');

const BASE = process.env.BASE || 'http://localhost:3050';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ALLOWED = /^(almirsal|odoo|peppol|sepa|iso20022|iban|qr|api|ubl|cii|xml|pdf|csv|html|qweb|gmail|outlook|mapbox|zoom|stun|turn|ice|sfu|gif|klipy|tenor|openai|chatgpt|gemini|google|aadhaar|esign|shopee|avatax|gelato|recaptcha|cloudflare|turnstile|bis|xrechnung|facturx|nlcius|a3|a4|a5|us|uae|gcc|vat|kpi|sla|rfq|utm|crm|erp|hr|it|pin|url|id|sms|ai|v?\d+(\.\d+)*|[a-z]{1,3})$/i;

/** Words that are really Latin text a user would expect translated. */
function latinWords(text) {
  return (text.match(/[A-Za-z][A-Za-z'&./-]*/g) || []).filter((word) => !ALLOWED.test(word));
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1366, height: 860 } })).newPage();
  await page.goto(BASE + '/web/login', { waitUntil: 'networkidle' });
  await page.fill('input[type="email"], input[name="login"]', 'mastaisshakh@gmail.com');
  await page.fill('input[type="password"]', 'admin');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/odoo/, { timeout: 90000 });
  await page.evaluate(async () => { await fetch('/api/auth/lang', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: 'ar_001' }) }); });
  await page.goto(BASE + '/odoo', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  const apps = await page.locator('.o_home_menu .o_app').evaluateAll((list) => list.map((a) => ({ name: a.textContent.trim(), href: a.getAttribute('href') })));
  const problems = [];
  let labels = 0;

  for (const app of apps) {
    await page.goto(BASE + (app.href || '/odoo'), { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(1200);
    const brand = (await page.locator('.o_menu_brand').textContent().catch(() => '')) || '';
    labels += 1;
    if (latinWords(brand).length) problems.push(`app name: ${brand.trim()}`);
    const tabs = await page.locator('.o_menu_sections .o_nav_entry').count();
    for (let i = 0; i < tabs; i += 1) {
      const tab = page.locator('.o_menu_sections .o_nav_entry').nth(i);
      const label = ((await tab.textContent().catch(() => '')) || '').trim();
      labels += 1;
      if (latinWords(label).length) problems.push(`${brand.trim()} > tab "${label}"`);
      const isButton = await tab.evaluate((el) => el.tagName === 'BUTTON').catch(() => false);
      if (!isButton) continue;
      await tab.click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(250);
      const items = await page.locator('.o_menu_sections .o_dropdown_menu a, .o_menu_sections .o_dropdown_menu .o_dropdown_header').allTextContents();
      for (const item of items) {
        labels += 1;
        const latin = latinWords(item);
        if (latin.length) problems.push(`${brand.trim()} > ${label} > "${item.trim()}" (${latin.join(', ')})`);
      }
      await page.keyboard.press('Escape');
      await page.waitForTimeout(120);
    }
  }

  // A few screens: control panel buttons, list headers and form labels.
  for (const path of ['/odoo/customer-invoices', '/odoo/customer-invoices/new', '/odoo/settings', '/odoo/employees']) {
    await page.goto(BASE + path, { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(2500);
    const texts = await page.locator('.o_control_panel button, .o_list_table thead th, .o_form_view label, .o_notebook .nav-link, .o_settings .fw-bold').allTextContents();
    for (const text of texts) {
      labels += 1;
      const latin = latinWords(text);
      if (latin.length) problems.push(`${path} "${text.trim().slice(0, 40)}" (${latin.join(', ')})`);
    }
  }

  console.log(`${labels} labels read, ${problems.length} still in Latin`);
  for (const problem of problems) console.log('  ' + problem);
  await browser.close();
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error(String(e).slice(0, 400)); process.exit(2); });
