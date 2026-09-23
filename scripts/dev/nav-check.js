// Navbar click-through: every app × every section link and dropdown item,
// with client-side navigation (no page loads), in one language. Asserts that
// a view rendered, the URL changed, the dropdown closed and the navbar
// stayed on the same app. The page-load crawl cannot see this class of
// defect, because it visits every action by URL instead of clicking.
//
//   npm install --no-save playwright-core
//   BASE=http://localhost:3050 LANG_CODE=ar_001 node scripts/dev/nav-check.js
//
// Login: mastaisshakh@gmail.com / admin (the local PGlite admin).
//
// Point BASE at a server that is NOT `next dev` in this folder: two Next
// processes share `.next/` and the loser starts serving 404 chunks, so the
// page renders but never hydrates. Use a production build on another port,
// or a copy of the project in a scratch folder.
const { chromium } = require('playwright-core');

const BASE = process.env.BASE || 'http://localhost:3050';
const LANG = process.env.LANG_CODE || 'en_US';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 160);

// Anything that counts as "a screen rendered".
const SCREENS = ['.o_list_view', '.o_form_view', '.o_kanban_view', '.o_pivot_view', '.o_graph_view', '.o_activity_view',
  '.o_calendar_view', '.o_gantt_view', '.o_cohort_view', '.o_map_view', '.o_grid_view', '.o_hierarchy_view',
  '.o_account_report', '.o_settings', '.o_discuss', '.o_discuss_settings', '.o_dashboards', '.o_documents',
  '.o_report_page', '.o_kiosk_main', '.o_action', '.o_client_action', '.o_view_controller'];

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1366, height: 860 } })).newPage();
  let errors = [];
  page.on('pageerror', (e) => errors.push('pageerror ' + String(e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push('console ' + m.text().slice(0, 200)); });
  page.on('response', async (r) => { if (r.url().includes('/api/') && r.status() >= 400) errors.push('http ' + r.status() + ' ' + r.url().slice(BASE.length) + ' ' + (await r.text().catch(() => '')).slice(0, 150)); });

  await page.goto(BASE + '/web/login', { waitUntil: 'networkidle' });
  await page.fill('input[type="email"], input[name="login"]', 'mastaisshakh@gmail.com');
  await page.fill('input[type="password"]', 'admin');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/odoo/, { timeout: 90000 });
  await page.evaluate(async (l) => { await fetch('/api/auth/lang', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: l }) }); }, LANG);
  await page.goto(BASE + '/odoo', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  const state = () => page.evaluate((sel) => ({
    found: sel.filter((s) => document.querySelector(s)),
    brand: (document.querySelector('.o_menu_brand') || {}).textContent || '',
    url: location.pathname,
  }), SCREENS).catch(() => ({ found: [], brand: '', url: '' }));

  // Wait for the move to land: the network goes quiet, then a screen appears.
  // A dev server compiles a route on its first visit and a full page load
  // (the kiosk) starts late, so an empty screen gets a second look.
  const settle = async () => {
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    let s = await state();
    if (!s.found.length) {
      await page.waitForSelector(SCREENS.join(', '), { timeout: 10000 }).catch(() => {});
      s = await state();
    }
    return s;
  };

  // Tag the screen on display, so the next move can be told apart from it:
  // without this a check can measure the outgoing view and pass on stale
  // content.
  const markScreen = () => page.evaluate(() => {
    const host = document.querySelector('.o_action_manager');
    if (host && host.firstElementChild) host.firstElementChild.setAttribute('data-nav-old', '1');
  }).catch(() => {});

  // A menu item can move twice: to the action's own path, and then wherever
  // its result sends you (a server action opening the kiosk). Wait until the
  // address stops changing.
  const urlSettled = async (quiet = 1200, max = 12000) => {
    const start = Date.now();
    let last = page.url();
    let since = Date.now();
    while (Date.now() - start < max) {
      await page.waitForTimeout(200);
      const now = page.url();
      if (now !== last) { last = now; since = Date.now(); } else if (Date.now() - since >= quiet) return;
    }
  };

  const apps = await page.locator('.o_home_menu .o_app').evaluateAll((as) => as.map((a) => ({ name: a.textContent.trim(), href: a.getAttribute('href') })));
  console.log(`${apps.length} apps, language ${LANG}`);
  const problems = [];
  let visits = 0;
  let printed = 0;

  for (const { name: app, href: appHref } of apps) {
    // Re-entering an app is a plain URL load: clicking the home-menu tile can
    // miss while the grid is still rendering, and this check is about the
    // navbar, not the home menu.
    const openApp = async () => {
      await page.goto(BASE + (appHref || '/odoo'), { waitUntil: 'networkidle' }).catch(() => {});
      await page.waitForFunction((n) => { const b = document.querySelector('.o_menu_brand'); return !!b && b.textContent.trim() === n; }, app, { timeout: 20000 }).catch(() => {});
      // A page load paints the navbar before React attaches: clicking a tab
      // before hydration does nothing, so wait for the handlers.
      await page.waitForFunction(() => {
        const el = document.querySelector('.o_menu_sections .o_nav_entry');
        return !!el && Object.keys(el).some((k) => k.startsWith('__react'));
      }, { timeout: 20000 }).catch(() => {});
      return settle();
    };
    errors = [];
    const home = await openApp();
    visits++;
    const brand0 = clean(home.brand);
    if (brand0 !== app || !home.found.length || errors.length) problems.push(`${app}: opening the app -> brand=${brand0} screens=${home.found.join(',')} ${errors.join(';')}`);

    // Every module's Configuration > Settings opens the Settings app, and
    // Kiosk Mode leaves the web client on purpose: both are expected.
    const handover = (url) => /\/odoo\/settings(\?|#|$)/.test(url) || !url.startsWith('/odoo');

    const visit = async (name, click, href) => {
      errors = [];
      const before = page.url();
      await markScreen();
      await click();
      await urlSettled();
      await page.waitForFunction(() => !document.querySelector('[data-nav-old]'), { timeout: 15000 }).catch(() => {});
      const s = await settle();
      visits++;
      const brand = clean(s.brand);
      const url = s.url || page.url().slice(BASE.length);
      const expected = handover(url);
      const left = !url.startsWith('/odoo');
      const stuck = page.url() === before && href && !before.endsWith(href) && !s.found.length;
      const dropdownOpen = await page.locator('.o_menu_sections .o_dropdown_menu').count();
      const bad = errors.length || !s.found.length || (brand !== brand0 && !expected) || stuck || dropdownOpen;
      if (bad) problems.push(`${name} => ${url} screens=${s.found.join(',') || 'NONE'} brand=${brand}${stuck ? ' URL DID NOT CHANGE' : ''}${dropdownOpen ? ' DROPDOWN STILL OPEN' : ''} ${errors.join(';')}`);
      else if (expected && (left || brand !== brand0)) console.log(`  ${name} -> ${left ? url : brand} (expected)`);
      if (left || brand !== brand0) await openApp();
    };

    const tabs = await page.locator('.o_menu_sections .o_nav_entry').allTextContents();
    for (let i = 0; i < tabs.length; i++) {
      const label = clean(tabs[i]);
      const entry = () => page.locator('.o_menu_sections .o_nav_entry').nth(i);
      const isLink = await entry().evaluate((el) => el.tagName === 'A').catch(() => false);
      if (isLink) {
        const href = await entry().getAttribute('href').catch(() => null);
        await visit(`${app} > ${label}`, async () => { await entry().click({ timeout: 15000 }).catch((e) => errors.push('click ' + String(e).slice(0, 90))); }, href);
        continue;
      }
      // Opening a section: click the tab, and make sure the dropdown is there
      // (a click can land while the navbar is still re-rendering).
      const openSection = async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          await entry().click({ timeout: 15000 }).catch(() => {});
          const ok = await page.locator('.o_menu_sections .o_dropdown_menu').first().waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);
          if (ok) return true;
          await page.waitForTimeout(400);
        }
        return false;
      };
      if (!(await openSection())) { problems.push(`${app} > ${label}: the section did not open`); continue; }
      const count = await page.locator('.o_menu_sections .o_dropdown_menu a').count();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(100);
      for (let k = 0; k < count; k++) {
        const item = () => page.locator('.o_menu_sections .o_dropdown_menu a').nth(k);
        if (!(await openSection())) { problems.push(`${app} > ${label}: the section did not reopen`); break; }
        const label2 = clean(await item().textContent().catch(() => '?'));
        const href = await item().getAttribute('href').catch(() => null);
        await visit(`${app} > ${label} > ${label2}`, async () => { await item().click({ timeout: 15000 }).catch((e) => errors.push('item click ' + String(e).slice(0, 90))); }, href);
      }
    }
    console.log(`${app}: ${tabs.length} tabs, ${problems.length} problems so far`);
    for (const p of problems.slice(printed)) console.log('  x ' + p);
    printed = problems.length;
  }

  console.log(`\n${visits} visits, ${problems.length} problems`);
  for (const p of problems) console.log('FAIL ' + p);
  await browser.close();
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error(String(e).slice(0, 400)); process.exit(2); });
