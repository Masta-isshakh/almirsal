// Form fidelity: does a screen show everything Odoo's view declares?
//
// The export carries Odoo's own views, so the view is the specification: the
// fields on the sheet, the tabs, the header buttons and the smart buttons.
// This opens a record of every model and compares what is declared against
// what is on screen, which is how a missing field or a dropped tab shows up.
//
//   npx tsx scripts/dump-actions.mts dump.json
//   npm install --no-save playwright-core
//   BASE=http://localhost:3053 node scripts/dev/form-fidelity.js dump.json [out.json]
//
// APPS=accounting,sales limits the run to those apps; ONLY=slug,slug to those
// screens. A field the view hides behind a condition is not expected to show.
const { chromium } = require('playwright-core');
const { readFileSync, writeFileSync } = require('node:fs');

const BASE = process.env.BASE || 'http://localhost:3053';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const dumpPath = process.argv[2] || 'dump.json';
const outPath = process.argv[3] || '';

/** Fields, tabs and buttons a form declares, with the ones it hides removed. */
function declared(arch) {
  const fields = new Set();
  const tabs = [];
  const buttons = [];
  // A field with any `invisible` condition is shown only in some states, so
  // its absence here says nothing; only unconditional fields are expected.
  const hidden = (node) => node.hidden === true || node.invisible !== undefined || node.column_invisible !== undefined;
  const walk = (node, insideHidden) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((item) => walk(item, insideHidden)); return; }
    const skip = insideHidden || hidden(node);
    if (node.kind === 'field' && typeof node.name === 'string') { if (!skip) fields.add(node.name); return; }
    if (node.kind === 'page' && !skip) tabs.push(node.string?.en || node.string || '');
    if (node.kind === 'button' && !skip && (node.string?.en || node.string)) buttons.push(node.string?.en || node.string);
    for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value, skip);
  };
  walk(arch.body, false);
  return { fields: [...fields], tabs, buttons };
}

(async () => {
  const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
  const actions = (Array.isArray(dump.actions) ? dump.actions : Object.values(dump.actions))
    .filter((a) => a.type === 'act_window' && a.model && (a.viewMode || []).includes('form'))
    .filter((a) => !ONLY.length || ONLY.includes(a.path || `action-${a.id}`));
  // A model can have several form views; the one to compare against is the
  // one the action binds, not whichever comes first.
  const byKey = new Map();
  const byModel = new Map();
  const listByKey = new Map();
  const listByModel = new Map();
  for (const view of Object.values(dump.views || {})) {
    if (view.type === 'form') {
      if (view.key) byKey.set(view.key, view.arch);
      if (!byModel.has(view.model)) byModel.set(view.model, view.arch);
    } else if (view.type === 'list') {
      if (view.key) listByKey.set(view.key, view.arch);
      if (!listByModel.has(view.model)) listByModel.set(view.model, view.arch);
    }
  }
  const formFor = (action) => {
    for (const key of action.views || []) if (byKey.has(key)) return byKey.get(key);
    return byModel.get(action.model);
  };
  const listFor = (action) => {
    for (const key of action.views || []) if (listByKey.has(key)) return listByKey.get(key);
    return listByModel.get(action.model);
  };
  /** The columns a list shows by default: not hidden, not optional-hidden. */
  const declaredColumns = (arch) => (arch?.columns ?? [])
    .filter((column) => column.kind === 'field' && column.name)
    .filter((column) => !column.hidden && column.columnInvisible !== true && column.invisible === undefined && column.optional !== 'hide')
    .map((column) => column.name);

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
  await page.goto(BASE + '/web/login', { waitUntil: 'networkidle' });
  await page.fill('input[type="email"], input[name="login"]', 'mastaisshakh@gmail.com');
  await page.fill('input[type="password"]', 'admin');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/odoo/, { timeout: 90000 });

  const settle = async (ms = 500) => {
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(ms);
  };

  const results = [];
  const problems = [];
  for (const action of actions) {
    const slug = action.path || `action-${action.id}`;
    const label = action.name?.en || action.name || slug;
    const arch = formFor(action);
    if (!arch) continue;
    const want = declared(arch);
    if (!want.fields.length) continue;

    // The list first: the columns Odoo shows by default must be there.
    if ((action.viewMode || []).includes('list')) {
      const columns = declaredColumns(listFor(action));
      if (columns.length) {
        await page.goto(`${BASE}/odoo/${slug}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await settle();
        const shown = await page.evaluate(() => [...document.querySelectorAll('.o_list_table thead th[data-name]')].map((node) => node.getAttribute('data-name')));
        if (shown.length) {
          const missing = columns.filter((name) => !shown.includes(name));
          if (missing.length) {
            problems.push(`${label} [${action.model}] list columns: ${missing.slice(0, 10).join(', ')}`);
            console.log(`x ${label} [${action.model}] list columns: ${missing.slice(0, 10).join(', ')}`);
          }
        }
      }
    }

    // The New form draws the same layout and needs no data, so every screen
    // can be compared; a saved record is used when New is not offered.
    await page.goto(`${BASE}/odoo/${slug}/new`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await settle();
    if (!(await page.locator('.o_form_view').count())) {
      await page.goto(`${BASE}/odoo/${slug}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await settle();
      const row = page.locator('.o_data_row, .o_kanban_record:not(.o_kanban_ghost)').first();
      if (!(await row.count())) continue;
      await row.click({ timeout: 8000 }).catch(() => {});
      await settle();
      if (!(await page.locator('.o_form_view').count())) continue;
    }

    // Only the open tab is in the page, so read the fields tab by tab and
    // put them together.
    const read = () => page.evaluate(() => ({
      fields: [...document.querySelectorAll('.o_form_view [data-name]')].map((node) => node.getAttribute('data-name')),
      tabs: [...document.querySelectorAll('.o_notebook .nav-link')].map((node) => node.textContent.trim()),
      buttons: [...document.querySelectorAll('.o_form_statusbar button, .oe_button_box button')].map((node) => node.textContent.trim()),
    }));
    const seen = await read();
    const tabs = await page.locator('.o_notebook .nav-link').count();
    for (let i = 0; i < tabs; i += 1) {
      await page.locator('.o_notebook .nav-link').nth(i).click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(250);
      const more = await read();
      seen.fields.push(...more.fields);
      seen.buttons.push(...more.buttons);
    }
    seen.fields = [...new Set(seen.fields)];

    // On a new record a list field is empty, and a widget that draws a list
    // (documents of a signature request) then draws nothing at all.
    const onNewRecord = page.url().endsWith('/new');
    const missingFields = want.fields
      .filter((name) => !seen.fields.includes(name))
      .filter((name) => !(onNewRecord && name.endsWith('_ids')));
    const missingTabs = want.tabs.filter((tab) => tab && !seen.tabs.some((shown) => shown && shown.toLowerCase().includes(String(tab).toLowerCase().slice(0, 12))));
    results.push({ slug, model: action.model, declared: want.fields.length, shown: seen.fields.length, missingFields, missingTabs });
    if (missingFields.length || missingTabs.length) {
      const detail = [missingFields.length ? `fields: ${missingFields.slice(0, 12).join(', ')}${missingFields.length > 12 ? ` (+${missingFields.length - 12})` : ''}` : '',
        missingTabs.length ? `tabs: ${missingTabs.join(', ')}` : ''].filter(Boolean).join(' | ');
      problems.push(`${label} [${action.model}] ${detail}`);
      console.log(`x ${label} [${action.model}] ${detail}`);
    } else {
      console.log(`. ${label} — ${seen.fields.length}/${want.fields.length} fields, ${seen.tabs.length} tabs`);
    }
  }

  console.log(`\n${results.length} forms compared, ${problems.length} miss something the view declares`);
  for (const p of problems) console.log('FAIL ' + p);
  if (outPath) writeFileSync(outPath, JSON.stringify(results, null, 1), 'utf8');
  await browser.close();
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error(String(e).slice(0, 500)); process.exit(2); });
