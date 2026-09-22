// Navbar click-through: every app × every section link and dropdown item,
// with client-side navigation (no page loads), in one language. Asserts a
// view rendered, the URL changed, the dropdown closed and the navbar stayed
// on the same app. Needs a running server and Chrome:
//
//   npm install --no-save playwright-core
//   BASE=http://localhost:3050 LANG_CODE=ar_001 node scripts/dev/nav-check.js
//
// Login: mastaisshakh@gmail.com / admin (the local PGlite admin).
const { chromium } = require('playwright-core');
const BASE = process.env.BASE || 'http://localhost:3051';
const LANG = process.env.LANG_CODE || 'en_US';
const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 160);
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
  const page = await ctx.newPage();
  let errors = [];
  page.on('pageerror', (e) => errors.push('pageerror ' + String(e).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push('console ' + m.text().slice(0, 300)); });
  page.on('response', async (r) => { if (r.url().includes('/api/') && r.status() >= 400) errors.push('http ' + r.status() + ' ' + r.url().slice(BASE.length) + ' ' + (await r.text().catch(() => '')).slice(0, 200)); });
  await page.goto(BASE + '/web/login', { waitUntil: 'networkidle' });
  await page.fill('input[type="email"], input[name="login"]', 'mastaisshakh@gmail.com'); await page.fill('input[type="password"]', 'admin'); await page.click('button[type="submit"]');
  await page.waitForURL(/\/odoo/, { timeout: 60000 });
  await page.evaluate(async (l) => { await fetch('/api/auth/lang', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: l }) }); }, LANG);
  await page.goto(BASE + '/odoo', { waitUntil: 'networkidle' }); await page.waitForTimeout(800);
  const apps = await page.locator('.o_home_menu .o_app').evaluateAll((as) => as.map((a) => ({ href: a.getAttribute('href'), name: a.textContent.trim() })));
  console.log('apps:', apps.length);
  const state = () => page.evaluate(() => {
    const sel = ['.o_list_view', '.o_form_view', '.o_kanban_view', '.o_pivot_view', '.o_graph_view', '.o_activity_view', '.o_calendar_view', '.o_gantt_view', '.o_cohort_view', '.o_map_view', '.o_grid_view', '.o_hierarchy_view', '.o_action', '.o_account_report', '.o_settings', '.o_client_action', '.o_form_settings', '.o_view_controller', '.o_discuss', '.o_discuss_settings', '.o_dashboards', '.o_documents', '.o_home_menu', '.o_report_page'];
    return { found: sel.filter((s) => document.querySelector(s)), text: document.body.innerText.length };
  }).catch(() => ({ found: [], text: 0 }));
  // A link may leave the web client on purpose (Kiosk Mode opens /kiosk/<key> in this tab): that is a pass, then come back.
  const left = async (label) => {
    if (page.url().includes('/odoo')) return false;
    console.log(`  ${label} left the web client for ${page.url().slice(BASE.length)} (ok)`);
    await page.goBack({ waitUntil: 'networkidle' }).catch(() => page.goto(BASE + '/odoo', { waitUntil: 'networkidle' }));
    await page.waitForTimeout(500);
    return true;
  };
  const settle = async () => { await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}); await page.waitForTimeout(400); };
  const problems = []; let visits = 0; let printed = 0;
  for (const app of apps) {
    errors = [];
    await page.locator('.o_navbar_apps_menu').click().catch(() => {}); await page.waitForTimeout(300);
    const appLink = page.locator('.o_home_menu .o_app', { hasText: app.name }).first();
    if (!(await appLink.count())) { await page.goto(BASE + '/odoo', { waitUntil: 'networkidle' }); }
    await page.locator('.o_home_menu .o_app', { hasText: app.name }).first().click(); await page.waitForTimeout(1500);
    const brand0 = clean(await page.locator('.o_menu_brand').textContent().catch(() => ''));
    const s0 = await state(); visits++;
    if (brand0 !== app.name || !s0.found.length || errors.length) problems.push(`${app.name}: open app -> brand=${brand0} views=${s0.found.join(',')} ${errors.join(';')}`);
    const tabs = await page.locator('.o_menu_sections .o_nav_entry').allTextContents();
    for (let i = 0; i < tabs.length; i++) {
      const entry = page.locator('.o_menu_sections .o_nav_entry').nth(i);
      const isLink = await entry.evaluate((el) => el.tagName === 'A').catch(() => false);
      const label = clean(tabs[i]);
      if (isLink) {
        errors = []; const before = page.url();
        const href = await entry.getAttribute('href');
        await entry.click({ timeout: 10000 }).catch((e) => errors.push('click ' + String(e).slice(0, 100))); await settle();
        visits++;
        if (await left(`${app.name} > ${label}`)) continue;
        const s = await state();
        const brand = clean(await page.locator('.o_menu_brand').textContent().catch(() => ''));
        const stuck = page.url() === before && href && !before.endsWith(href) && !s.found.length;
        if (errors.length || !s.found.length || brand !== brand0 || stuck) problems.push(`${app.name} > ${label} => ${page.url().slice(BASE.length)} views=${s.found.join(',')} brand=${brand}${stuck ? ' URL DID NOT CHANGE' : ''} ${errors.join(';')}`);
        continue;
      }
      await entry.click({ timeout: 10000 }).catch(() => {}); await page.waitForTimeout(300);
      const count = await page.locator('.o_menu_sections .o_dropdown_menu a').count();
      await page.keyboard.press('Escape'); await page.waitForTimeout(100);
      for (let k = 0; k < count; k++) {
        errors = [];
        await page.locator('.o_menu_sections .o_nav_entry').nth(i).click({ timeout: 10000 }).catch((e) => errors.push('tab click ' + String(e).slice(0, 100))); await page.waitForTimeout(300);
        const item = page.locator('.o_menu_sections .o_dropdown_menu a').nth(k);
        const label2 = clean(await item.textContent().catch(() => '?')); const href = await item.getAttribute('href').catch(() => null);
        const before = page.url();
        await item.click({ timeout: 10000 }).catch((e) => errors.push('item click ' + String(e).slice(0, 100))); await settle();
        visits++;
        if (await left(`${app.name} > ${label} > ${label2}`)) continue;
        const s = await state();
        const brand = clean(await page.locator('.o_menu_brand').textContent().catch(() => ''));
        const stuck = page.url() === before && href && !before.endsWith(href) && !s.found.length;
        const open = await page.locator('.o_menu_sections .o_dropdown_menu').count();
        if (errors.length || !s.found.length || brand !== brand0 || stuck || open) problems.push(`${app.name} > ${label} > ${label2} => ${page.url().slice(BASE.length)} views=${s.found.join(',')} brand=${brand}${stuck ? ' URL DID NOT CHANGE' : ''}${open ? ' DROPDOWN STILL OPEN' : ''} ${errors.join(';')}`);
      }
    }
    console.log(`${app.name}: ${tabs.length} tabs done, problems so far ${problems.length}`);
    for (const p of problems.slice(printed)) console.log('  ✗ ' + p);
    printed = problems.length;
  }
  console.log(`\n${visits} visits, ${problems.length} problems`);
  for (const p of problems) console.log('✗ ' + p);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
