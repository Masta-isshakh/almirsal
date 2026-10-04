// Screen check: open every menu action and use it the way a person would —
// switch views, apply a filter, group the rows, open a record, press New —
// and report the screens that do not respond.
//
//   npx tsx scripts/dump-actions.mts dump.json
//   npm install --no-save playwright-core
//   BASE=http://localhost:3053 node scripts/dev/screen-check.js dump.json [out.json]
//
// It reports only real failures: an empty list with its "no records" message
// is a working screen, a view that never renders or an error dialog is not.
// ONLY=slug,slug limits the run while fixing something.
const { chromium } = require('playwright-core');
const { readFileSync, writeFileSync } = require('node:fs');

const BASE = process.env.BASE || 'http://localhost:3053';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const dumpPath = process.argv[2] || 'dump.json';
const outPath = process.argv[3] || '';

const VIEW_OF = {
  list: '.o_list_view', kanban: '.o_kanban_view', form: '.o_form_view', pivot: '.o_pivot_view',
  graph: '.o_graph_view', calendar: '.o_calendar_view', activity: '.o_activity_view', gantt: '.o_gantt_view',
  cohort: '.o_cohort_view', map: '.o_map_view', grid: '.o_grid_view', hierarchy: '.o_hierarchy_view',
};
const ANY_VIEW = Object.values(VIEW_OF).concat(['.o_settings', '.o_account_report', '.o_discuss', '.o_dashboards', '.o_documents', '.o_knowledge', '.o_report_page', '.o_action']).join(', ');

(async () => {
  const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
  const actions = (Array.isArray(dump.actions) ? dump.actions : Object.values(dump.actions))
    .filter((a) => a.type === 'act_window' && a.model)
    .filter((a) => !ONLY.length || ONLY.includes(a.path || `action-${a.id}`));

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 900 } })).newPage();
  let errors = [];
  page.on('pageerror', (e) => errors.push('pageerror ' + String(e).slice(0, 160)));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push('console ' + m.text().slice(0, 160)); });
  page.on('response', async (r) => {
    if (r.url().includes('/api/') && r.status() >= 400) errors.push(`http ${r.status()} ${(await r.text().catch(() => '')).slice(0, 160)}`);
  });

  await page.goto(BASE + '/web/login', { waitUntil: 'networkidle' });
  await page.fill('input[type="email"], input[name="login"]', 'mastaisshakh@gmail.com');
  await page.fill('input[type="password"]', 'admin');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/odoo/, { timeout: 90000 });

  const settle = async () => {
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForSelector(ANY_VIEW, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(150);
  };
  /** The dialog Odoo shows on a server error; anything in it is a failure. */
  const errorDialog = async () => {
    const text = await page.evaluate(() => {
      const read = (node) => (node ? node.textContent.replace(/\s+/g, ' ').trim() : '');
      const dialog = document.querySelector('.o_dialog');
      const title = read(document.querySelector('.o_dialog_header h4'));
      if (dialog && /error|invalid|خطأ|غير صالح/i.test(title)) return read(dialog).slice(0, 120);
      const toast = document.querySelector('.o_notification.border-danger, .o_notification_danger');
      return toast ? read(toast).slice(0, 120) : null;
    }).catch(() => null);
    if (text) await page.keyboard.press('Escape').catch(() => {});
    return text;
  };
  const shown = () => page.evaluate((sel) => {
    const found = sel.split(', ').filter((s) => document.querySelector(s));
    const rows = document.querySelectorAll('.o_data_row, .o_kanban_record:not(.o_kanban_ghost)').length;
    const empty = !!document.querySelector('.o_view_nocontent, .o_nocontent_help, .o_empty_state');
    return { found, rows, empty };
  }, ANY_VIEW);

  const results = [];
  const problems = [];
  for (const action of actions) {
    const slug = action.path || `action-${action.id}`;
    const label = `${action.name?.en || action.name || slug} (${slug})`;
    const fails = [];
    errors = [];
    await page.goto(`${BASE}/odoo/${slug}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await settle();

    const first = await shown();
    const dialog = await errorDialog();
    if (dialog) fails.push(`opens with an error: ${dialog}`);
    if (!first.found.length) fails.push('no view rendered');
    if (errors.length) fails.push(`errors on open: ${errors.slice(0, 2).join(' | ')}`);

    // 1. every view in the switcher must render its own view
    // A screen with its own layout (Knowledge, Discuss, dashboards) has no
    // view switcher, and nothing to switch.
    const hasSwitcher = await page.locator('.o_switch_view').count();
    const modes = hasSwitcher ? (action.viewMode || []).filter((m) => VIEW_OF[m] && m !== 'form') : [];
    for (const mode of modes.slice(1)) {
      errors = [];
      const button = page.locator(`.o_switch_view[title="${mode}"]`);
      if (!(await button.count())) { fails.push(`no ${mode} button in the view switcher`); continue; }
      await button.first().click({ timeout: 8000 }).catch(() => {});
      await settle();
      const ok = await page.locator(VIEW_OF[mode]).count();
      const bad = await errorDialog();
      if (!ok) fails.push(`${mode} view does not render`);
      if (bad) fails.push(`${mode} view errors: ${bad}`);
      if (errors.length) fails.push(`${mode} view: ${errors.slice(0, 1).join('')}`);
    }
    if (modes.length > 1) { await page.goto(`${BASE}/odoo/${slug}`, { waitUntil: 'domcontentloaded' }).catch(() => {}); await settle(); }

    // 2. a search filter must apply and come off again
    errors = [];
    // The facets as text: a second filter of the same group joins the facet it
    // is part of ("Invoices or Receipts"), so counting them says too little.
    const facetText = async () => (await page.locator('.o_searchview_facet').allTextContents()).join(' | ');
    const facetsBefore = await facetText();
    const filterToggle = page.locator('.o_searchview_dropdown_toggler, .o_control_panel .o_dropdown > span').first();
    if (await filterToggle.count()) {
      await filterToggle.click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(250);
      const item = page.locator('.o_control_panel .o_dropdown_menu button.o_dropdown_item').first();
      if (await item.count()) {
        const name = ((await item.textContent().catch(() => '')) || '').trim().slice(0, 30);
        await item.click({ timeout: 8000 }).catch(() => {});
        await settle();
        // A date filter opens its periods instead of applying at once.
        const period = page.locator('.o_control_panel .o_dropdown_menu button.o_dropdown_item').nth(1);
        if ((await facetText()) === facetsBefore && (await period.count())) {
          await period.click({ timeout: 8000 }).catch(() => {});
          await settle();
        }
        const facetsChanged = (await facetText()) !== facetsBefore;
        const bad = await errorDialog();
        const after = await shown();
        if (!facetsChanged) fails.push(`filter "${name}" changes nothing`);
        if (bad) fails.push(`filter "${name}" errors: ${bad}`);
        if (!after.found.length) fails.push(`filter "${name}" leaves no view`);
        if (errors.length) fails.push(`filter "${name}": ${errors.slice(0, 1).join('')}`);
      }
      await page.keyboard.press('Escape').catch(() => {});
    }

    // 3. group by must group the rows
    errors = [];
    await page.goto(`${BASE}/odoo/${slug}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await settle();
    const groupToggle = page.locator('.o_control_panel .o_dropdown > span').nth(1);
    if (await groupToggle.count()) {
      await groupToggle.click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(250);
      const item = page.locator('.o_control_panel .o_dropdown_menu button.o_dropdown_item').first();
      if (await item.count()) {
        const name = ((await item.textContent().catch(() => '')) || '').trim().slice(0, 30);
        await item.click({ timeout: 8000 }).catch(() => {});
        await settle();
        const bad = await errorDialog();
        const grouped = await page.locator('.o_group_header, .o_kanban_group, .o_pivot_table, .o_graph_view').count();
        const after = await shown();
        if (bad) fails.push(`group by "${name}" errors: ${bad}`);
        else if (!grouped && !after.empty && after.rows) fails.push(`group by "${name}" does not group`);
        if (errors.length) fails.push(`group by "${name}": ${errors.slice(0, 1).join('')}`);
      }
      await page.keyboard.press('Escape').catch(() => {});
    }

    // 4. New must open a form with fields
    errors = [];
    await page.goto(`${BASE}/odoo/${slug}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await settle();
    const newButton = page.locator('.o_control_panel button:has-text("New")').first();
    const hasNew = await newButton.count();
    if (hasNew) {
      await newButton.click({ timeout: 8000 }).catch(() => {});
      await settle();
      const bad = await errorDialog();
      // An editable list adds the new row in place, with its editors.
      const inline = await page.locator('tr.o_selected_row .o_field_widget').count();
      const form = (await page.locator('.o_form_view, .o_dialog .o_form_view').count()) || inline;
      const fields = (await page.locator('.o_form_view .o_field_widget, .o_dialog .o_field_widget').count()) || inline;
      if (bad) fails.push(`New errors: ${bad}`);
      else if (!form) fails.push('New opens no form');
      else if (!fields) fails.push('New opens a form with no fields');
      if (errors.length) fails.push(`New: ${errors.slice(0, 1).join('')}`);
      await page.keyboard.press('Escape').catch(() => {});
    }

    // 5. an existing record must open
    errors = [];
    await page.goto(`${BASE}/odoo/${slug}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await settle();
    const state = await shown();
    let opened = 'no records';
    if (state.rows) {
      const before = page.url();
      const row = page.locator('.o_data_row, .o_kanban_record:not(.o_kanban_ghost)').first();
      await row.click({ timeout: 8000 }).catch(() => {});
      await settle();
      const bad = await errorDialog();
      const inline = await page.locator('tr.o_selected_row .o_field_widget').count();
      const form = (await page.locator('.o_form_view').count()) || inline;
      const fields = (await page.locator('.o_form_view .o_field_widget').count()) || inline;
      // An editable list edits the row in place instead of opening a form.
      // A card can open its form, or take you somewhere else entirely —
      // Discuss channels open the conversation, a helpdesk team its tickets.
      // Only a click that changes nothing at all is a failure, and a kanban
      // the export marks as not openable is not meant to react.
      const after = await shown();
      const moved = page.url() !== before || after.found.join() !== state.found.join();
      const openable = !(action.viewMode || []).includes('kanban') || form > 0 || moved;
      if (bad) fails.push(`opening a record errors: ${bad}`);
      else if (form && !fields) fails.push('a record opens a form with no fields');
      else if (!form && !moved && openable) fails.push('clicking a record does nothing');
      if (errors.length) fails.push(`record: ${errors.slice(0, 1).join('')}`);
      opened = form ? `form with ${fields} fields` : moved ? `moved to ${page.url().slice(BASE.length)}` : 'no reaction';
    }

    results.push({ slug, model: action.model, rows: state.rows, modes: action.viewMode, hasNew: !!hasNew, opened, fails });
    if (fails.length) { problems.push(`${label}: ${fails.join('; ')}`); console.log(`x ${label}\n    ${fails.join('\n    ')}`); }
    else console.log(`. ${label} — ${state.rows} rows, ${(action.viewMode || []).join('/')}${hasNew ? ', New ok' : ''}`);
  }

  console.log(`\n${results.length} screens checked, ${problems.length} with problems`);
  if (outPath) writeFileSync(outPath, JSON.stringify(results, null, 1), 'utf8');
  await browser.close();
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error(String(e).slice(0, 500)); process.exit(2); });
