// Search check: the Filters and Group By entries a screen offers are drawn
// from Odoo's own search view, so they are always all there — what can fail is
// what happens when one is pressed. A filter whose domain names a column the
// registry does not have, or a group by on a field the reader cannot group,
// answers with a server error and leaves the screen empty. This presses every
// one of them and reports the ones that break.
//
//   npx tsx scripts/dump-actions.mts dump.json
//   npm install --no-save playwright-core
//   BASE=http://localhost:3053 node scripts/dev/search-check.js dump.json [out.json]
//
// MODULES=account,sale narrows the run to the actions those Odoo modules
// define; ONLY=slug,slug to named screens; MAX caps the entries per screen.
const { chromium } = require('playwright-core');
const { readFileSync, writeFileSync } = require('node:fs');

const BASE = process.env.BASE || 'http://localhost:3053';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const MODULES = (process.env.MODULES || '').split(',').filter(Boolean);
const MAX = Number(process.env.MAX || 10);
const dumpPath = process.argv[2] || 'dump.json';
const outPath = process.argv[3] || '';
const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

(async () => {
  const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
  const actions = (Array.isArray(dump.actions) ? dump.actions : Object.values(dump.actions))
    .filter((a) => a.type === 'act_window' && a.model)
    .filter((a) => (a.viewMode || []).some((mode) => ['list', 'kanban'].includes(mode)))
    .filter((a) => !ONLY.length || ONLY.includes(a.path || `action-${a.id}`))
    .filter((a) => !MODULES.length || MODULES.includes(String(a.xmlId || '').split('.')[0]));

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 900 } })).newPage();
  let errors = [];
  page.on('pageerror', (e) => errors.push('pageerror ' + String(e).slice(0, 160)));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push('console ' + m.text().slice(0, 160)); });
  page.on('response', async (r) => {
    if (!r.url().includes('/api/rpc') || r.status() === 200) return;
    const body = await r.text().catch(() => '');
    const kind = /"kind"\s*:\s*"([a-z_]+)"/.exec(body)?.[1] ?? 'server_error';
    // A refusal written for the person is fine; a crash is not.
    if (!['user_error', 'validation_error', 'access_error', 'missing_error'].includes(kind)) errors.push(`server error: ${body.slice(0, 160)}`);
  });

  await page.goto(BASE + '/web/login', { waitUntil: 'networkidle' });
  await page.fill('input[type="email"], input[name="login"]', 'mastaisshakh@gmail.com');
  await page.fill('input[type="password"]', 'admin');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/odoo/, { timeout: 90000 });

  const settle = async (ms = 350) => {
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(ms);
  };
  // The search dropdown is one of several on a screen, so its columns are found
  // by their own headers rather than by position.
  const column = (name) => page.locator(`div:has(> .o_dropdown_header:has-text("${name}"))`).first();
  const openSearch = async () => {
    // The caret opens the dropdown; the input itself keeps a click for typing.
    await page.locator('.o_searchview .fa-caret-down').first().click({ timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(250);
    return column('Filters');
  };
  /** The screen is still a screen: a view, or the empty state, is drawn. */
  const alive = () => page.evaluate(() => Boolean(document.querySelector(
    '.o_list_view, .o_kanban_view, .o_pivot_view, .o_graph_view, .o_calendar_view, .o_gantt_view, .o_map_view, .o_cohort_view, .o_activity_view, .o_hierarchy_view, .o_grid_view, .o_view_nocontent, .o_client_action',
  )));

  const problems = [];
  const results = [];
  let pressed = 0;

  for (const action of actions) {
    const slug = action.path || `action-${action.id}`;
    const label = action.name?.en || action.name || slug;
    const open = async () => {
      await page.goto(`${BASE}/odoo/${slug}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await settle();
    };
    await open();
    if (!(await alive())) continue;

    const menu = await openSearch();
    if (!(await menu.count())) continue;
    const filterNames = (await column('Filters').locator('button.o_dropdown_item').allTextContents()).map(clean).filter(Boolean);
    const groupNames = (await column('Group By').locator('button.o_dropdown_item').allTextContents()).map(clean).filter(Boolean);
    await page.keyboard.press('Escape').catch(() => {});

    /** Press one entry of one column and check the screen survived. */
    const pressEntry = async (header, index, name, kind) => {
      errors = [];
      await open();
      await openSearch();
      const entry = column(header).locator('button.o_dropdown_item').nth(index);
      if (!(await entry.count())) return;
      // A filter the action applies by default (`search_default_…`) comes up
      // ticked, and pressing it takes it off; a filter of a group already in
      // play joins its facet ("Invoices or Receipts"). Either way the facets
      // read differently afterwards, which is the answer to look for.
      const facetText = async () => (await page.locator('.o_searchview_facet').allTextContents()).join(' | ');
      const facetsBefore = await facetText();
      await entry.click({ timeout: 6000 }).catch((e) => errors.push('click ' + String(e).slice(0, 80)));
      await settle(450);
      // A date filter opens a submenu of periods; take the first period.
      const submenu = column(header).locator('.ps-4 button.o_dropdown_item').first();
      if (await submenu.count()) {
        await submenu.click({ timeout: 4000 }).catch(() => {});
        await settle(400);
      }
      await page.keyboard.press('Escape').catch(() => {});
      await settle(200);
      pressed += 1;
      const standing = await alive();
      const facets = await facetText();
      results.push({ slug, model: action.model, kind, name, standing, facets, facetsBefore, errors: errors.slice(0, 1) });
      if (errors.length) {
        problems.push(`${label} > ${kind} "${name}": ${errors[0]}`);
        console.log(`x ${label} > ${kind} "${name}": ${errors[0]}`);
      } else if (!standing) {
        problems.push(`${label} > ${kind} "${name}": the view disappeared`);
        console.log(`x ${label} > ${kind} "${name}": the view disappeared`);
      } else if (facets === facetsBefore) {
        problems.push(`${label} > ${kind} "${name}": the search did not change`);
        console.log(`x ${label} > ${kind} "${name}": the search did not change`);
      } else {
        console.log(`. ${label} > ${kind} "${name}"`);
      }
    };

    for (let i = 0; i < Math.min(filterNames.length, MAX); i += 1) await pressEntry('Filters', i, filterNames[i], 'filter');
    for (let i = 0; i < Math.min(groupNames.length, MAX); i += 1) await pressEntry('Group By', i, groupNames[i], 'group by');
  }

  console.log(`\n${pressed} search entries pressed on ${new Set(results.map((r) => r.slug)).size} screens, ${problems.length} broken`);
  for (const p of problems) console.log('FAIL ' + p);
  if (outPath) writeFileSync(outPath, JSON.stringify(results, null, 1), 'utf8');
  await browser.close();
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error(String(e).slice(0, 500)); process.exit(2); });
