// Overlay check: open every dropdown on a set of representative screens and
// assert it is actually painted, not merely present in the DOM.
//
//   npm install --no-save playwright-core
//   BASE=http://localhost:3050 LANG_CODE=ar_001 node scripts/dev/overlay-check.js
//
// A menu can be in the layout, have a box and pass a "visible" test while an
// ancestor with `overflow: hidden` clips it to nothing — that is how the
// navbar dropdowns were invisible while every automated check passed. The
// test here is what the eye does: ask the browser what is painted at the
// menu's own centre, and report the ancestor that clips it when nothing is.
const { chromium } = require('playwright-core');

const BASE = process.env.BASE || 'http://localhost:3050';
const LANG = process.env.LANG_CODE || 'en_US';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

// Screens worth checking, with the toggles they carry.
const SCREENS = [
  { name: 'invoice list', path: '/odoo/customer-invoices' },
  { name: 'invoice form', path: '/odoo/customer-invoices/new' },
  { name: 'accounting dashboard', path: '/odoo/accounting' },
  { name: 'journal items', path: '/odoo/items' },
  { name: 'invoice analysis', path: '/odoo/action-152' },
  { name: 'settings', path: '/odoo/settings' },
  { name: 'documents', path: '/odoo/action-815' },
  { name: 'discuss', path: '/odoo/discuss' },
  { name: 'employees', path: '/odoo/employees' },
];

const TOGGLES = [
  '.o_main_navbar .o_dropdown > span',
  '.o_main_navbar .o_dropdown > button',
  '.o_menu_sections .o_nav_entry[aria-haspopup]',
  '.o_control_panel .o_dropdown > span',
  '.o_control_panel .o_dropdown > button',
  '.o_control_panel button[aria-haspopup]',
  '.o_searchview_dropdown_toggler',
  '.o_kanban_record .o_dropdown > span',
  '.o_kanban_record .o_dropdown > button',
  '.o_list_view .o_dropdown > span',
  '.o_optional_columns_toggle',
];

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1366, height: 860 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror ' + String(e).slice(0, 160)));
  await page.goto(BASE + '/web/login', { waitUntil: 'networkidle' });
  await page.fill('input[type="email"], input[name="login"]', 'mastaisshakh@gmail.com');
  await page.fill('input[type="password"]', 'admin');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/odoo/, { timeout: 90000 });
  await page.evaluate(async (l) => { await fetch('/api/auth/lang', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: l }) }); }, LANG);

  // What appeared, and is it painted where it says it is?
  const inspect = () => page.evaluate(() => {
    const out = [];
    const menus = document.querySelectorAll('.o_dropdown_menu, .o_m2o_dropdown, .o_datepicker, .modal');
    for (const menu of menus) {
      const r = menu.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) { out.push({ label: menu.className, empty: true }); continue; }
      const x = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1);
      const y = Math.min(Math.max(r.top + Math.min(r.height / 2, 30), 1), innerHeight - 1);
      const top = document.elementFromPoint(x, y);
      const painted = !!top && (menu === top || menu.contains(top));
      let clipper = null;
      if (!painted) {
        for (let el = menu.parentElement; el && el !== document.documentElement; el = el.parentElement) {
          const cs = getComputedStyle(el);
          const box = el.getBoundingClientRect();
          if ((cs.overflow !== 'visible' || cs.overflowY !== 'visible') && (box.height < r.height - 2 || box.width < r.width - 2)) {
            clipper = `${el.tagName}.${String(el.className).split(' ').slice(0, 2).join('.')} overflow=${cs.overflow}/${cs.overflowY} ${Math.round(box.width)}x${Math.round(box.height)}`;
            break;
          }
        }
      }
      out.push({
        label: String(menu.className).split(' ').slice(0, 2).join('.'),
        box: `${Math.round(r.width)}x${Math.round(r.height)}`,
        painted,
        over: top ? `${top.tagName}.${String(top.className).split(' ').slice(0, 2).join('.')}` : 'nothing',
        clipper,
      });
    }
    return out;
  });

  const problems = [];
  let opened = 0;
  for (const screen of SCREENS) {
    await page.goto(BASE + screen.path, { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(2500);
    for (const selector of TOGGLES) {
      const count = await page.locator(selector).count();
      for (let i = 0; i < count; i += 1) {
        const toggle = page.locator(selector).nth(i);
        const label = (await toggle.textContent().catch(() => '') || await toggle.getAttribute('title').catch(() => '') || selector).replace(/\s+/g, ' ').trim().slice(0, 30);
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(150);
        await toggle.click({ timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(500);
        const menus = await inspect();
        if (!menus.length) continue;
        opened += 1;
        for (const menu of menus) {
          if (menu.empty) continue;
          if (!menu.painted) problems.push(`${screen.name} [${label || selector}] ${menu.label} ${menu.box} hidden behind ${menu.over}${menu.clipper ? ' clipped by ' + menu.clipper : ''}`);
        }
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(150);
      }
    }
    console.log(`${screen.name}: ${opened} overlays opened so far, ${problems.length} problems`);
  }
  console.log(`\n${opened} overlays opened, ${problems.length} problems${errors.length ? `, ${errors.length} page errors` : ''}`);
  for (const p of problems) console.log('FAIL ' + p);
  for (const e of errors) console.log('ERROR ' + e);
  await browser.close();
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error(String(e).slice(0, 400)); process.exit(2); });
