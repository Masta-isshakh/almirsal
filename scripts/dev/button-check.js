// Button check: press the controls a record screen offers — the buttons on a
// kanban card, the header buttons, the smart buttons and the cog menu — and
// report any that do nothing at all. A screen can render perfectly and still
// be dead to the touch, and nothing else in the suite catches that.
//
//   npx tsx scripts/dump-actions.mts dump.json
//   npm install --no-save playwright-core
//   BASE=http://localhost:3053 node scripts/dev/button-check.js dump.json [out.json]
//
// ONLY=slug,slug narrows the run.
const { chromium } = require('playwright-core');
const { readFileSync, writeFileSync } = require('node:fs');

const BASE = process.env.BASE || 'http://localhost:3053';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const dumpPath = process.argv[2] || 'dump.json';
const outPath = process.argv[3] || '';
const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
// Controls that destroy or duplicate a record are left alone.
const SKIP = /delete|unlink|archive|duplicate|remove/i;

(async () => {
  const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
  const actions = (Array.isArray(dump.actions) ? dump.actions : Object.values(dump.actions))
    .filter((a) => a.type === 'act_window' && a.model && (a.viewMode || []).includes('form'))
    .filter((a) => !ONLY.length || ONLY.includes(a.path || `action-${a.id}`));

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 900 } })).newPage();
  let errors = [];
  // A button can answer by opening a tab (a report) or by a call the server
  // accepted without anything visible changing (a flag toggled on the record).
  let popups = 0;
  let calls = 0;
  page.on('pageerror', (e) => errors.push('pageerror ' + String(e).slice(0, 150)));
  // A failed request already reports itself below; the console copy is noise.
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push('console ' + m.text().slice(0, 150)); });
  page.context().on('page', () => { popups += 1; });
  page.on('response', async (r) => {
    if (!r.url().includes('/api/rpc')) return;
    if (r.status() === 200) { calls += 1; return; }
    // A refusal the app wrote for the person (no work email, nothing to
    // capture) is the button working; only a crash is a failure.
    const body = await r.text().catch(() => '');
    const kind = /"kind"\s*:\s*"([a-z_]+)"/.exec(body)?.[1] ?? 'server_error';
    if (['user_error', 'validation_error', 'access_error', 'missing_error'].includes(kind)) calls += 1;
    else errors.push(`server error: ${body.slice(0, 140)}`);
  });

  await page.goto(BASE + '/web/login', { waitUntil: 'networkidle' });
  await page.fill('input[type="email"], input[name="login"]', 'mastaisshakh@gmail.com');
  await page.fill('input[type="password"]', 'admin');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/odoo/, { timeout: 90000 });

  const settle = async (ms = 400) => {
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(ms);
  };
  /** Everything that tells us the press was heard. */
  const snapshot = () => page.evaluate(() => {
    const read = (node) => (node ? node.textContent.replace(/\s+/g, ' ').trim() : '');
    return {
      url: location.pathname + location.search,
      dialog: document.querySelectorAll('.o_dialog').length,
      toast: document.querySelectorAll('.o_notification').length,
      statusbar: read(document.querySelector('.o_form_statusbar')),
      sheet: read(document.querySelector('.o_form_sheet_bg')).slice(0, 600),
      views: ['.o_form_view', '.o_list_view', '.o_kanban_view', '.o_pivot_view', '.o_graph_view', '.o_calendar_view', '.o_client_action']
        .filter((s) => document.querySelector(s)).join(','),
    };
  }).catch(() => ({ url: '', dialog: 0, toast: 0, statusbar: '', sheet: '', views: '' }));

  const results = [];
  const problems = [];
  let pressed = 0;

  /** Press one control and say whether the screen answered. */
  const press = async (name, kind, locator, where) => {
    errors = [];
    popups = 0;
    calls = 0;
    const before = await snapshot();
    await locator.click({ timeout: 8000 }).catch((e) => errors.push('click ' + String(e).slice(0, 80)));
    await settle(700);
    const after = await snapshot();
    pressed += 1;
    const moved = after.url !== before.url || after.views !== before.views;
    const spoke = after.dialog > before.dialog || after.toast > before.toast;
    const changed = after.statusbar !== before.statusbar || after.sheet !== before.sheet;
    const opened = popups > 0;
    const answered = calls > 0;
    results.push({ slug: where.slug, model: where.model, kind, button: name, moved, spoke, changed, opened, answered, errors: errors.slice(0, 1) });
    if (errors.length) {
      problems.push(`${where.label} > ${kind} "${name}": ${errors[0]}`);
      console.log(`x ${where.label} > ${kind} "${name}": ${errors[0]}`);
    } else if (!moved && !spoke && !changed && !opened && !answered) {
      problems.push(`${where.label} > ${kind} "${name}": nothing happens`);
      console.log(`x ${where.label} > ${kind} "${name}": nothing happens`);
    } else {
      console.log(`. ${where.label} > ${kind} "${name}"${moved ? ' -> moved' : ''}${spoke ? ' -> dialog' : ''}${changed ? ' -> changed' : ''}${opened ? ' -> new tab' : ''}${!moved && !spoke && !changed && !opened ? ' -> server call' : ''}`);
    }
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(150);
  };

  for (const action of actions) {
    const slug = action.path || `action-${action.id}`;
    const where = { slug, model: action.model, label: action.name?.en || action.name || slug };
    const open = async () => {
      await page.goto(`${BASE}/odoo/${slug}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await settle(300);
    };
    await open();

    // Buttons printed on a kanban card: on the boards whose cards do not open
    // a form (apps, departments, approvals) these are the only way in.
    const cardSelector = '.o_kanban_record:not(.o_kanban_ghost) .o_kanban_card_buttons button';
    const cards = Math.min(await page.locator(cardSelector).count(), 4);
    for (let i = 0; i < cards; i += 1) {
      await open();
      const button = page.locator(cardSelector).nth(i);
      if (!(await button.count()) || !(await button.isVisible().catch(() => false))) continue;
      const name = clean(await button.textContent().catch(() => '')).slice(0, 30) || `card button ${i + 1}`;
      if (SKIP.test(name)) continue;
      await press(name, 'card button', button, where);
    }

    await open();
    const row = page.locator('.o_data_row, .o_kanban_record:not(.o_kanban_ghost)').first();
    if (!(await row.count())) continue;
    await row.click({ timeout: 8000 }).catch(() => {});
    await settle();
    if (!(await page.locator('.o_form_view').count())) continue;
    const recordUrl = page.url();
    const reopen = async () => {
      await page.goto(recordUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await settle(300);
    };

    for (const [kind, selector] of [
      ['header button', '.o_form_statusbar .o_statusbar_buttons button'],
      ['smart button', '.oe_button_box button, .o_form_view .oe_stat_button'],
    ]) {
      const count = Math.min(await page.locator(selector).count(), 8);
      for (let i = 0; i < count; i += 1) {
        await reopen();
        const button = page.locator(selector).nth(i);
        if (!(await button.count()) || !(await button.isVisible().catch(() => false))) continue;
        const name = clean(await button.textContent().catch(() => '')).slice(0, 34) || `${kind} ${i + 1}`;
        if (SKIP.test(name)) continue;
        await press(name, kind, button, where);
      }
    }

    // The cog menu on the record: print, send, model actions.
    const cogSelector = '.o_control_panel .o_dropdown > span, .o_cp_action_menus button';
    if (await page.locator(cogSelector).count()) {
      await reopen();
      await page.locator(cogSelector).first().click({ timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(250);
      const entries = Math.min(await page.locator('.o_control_panel .o_dropdown_menu button.o_dropdown_item').count(), 5);
      await page.keyboard.press('Escape').catch(() => {});
      for (let i = 0; i < entries; i += 1) {
        await reopen();
        await page.locator(cogSelector).first().click({ timeout: 6000 }).catch(() => {});
        await page.waitForTimeout(250);
        const item = page.locator('.o_control_panel .o_dropdown_menu button.o_dropdown_item').nth(i);
        if (!(await item.count())) continue;
        const name = clean(await item.textContent().catch(() => '')).slice(0, 30) || `entry ${i + 1}`;
        if (SKIP.test(name)) continue;
        await press(name, 'cog menu', item, where);
      }
    }
  }

  console.log(`\n${pressed} controls pressed on ${new Set(results.map((r) => r.slug)).size} screens, ${problems.length} did nothing`);
  for (const p of problems) console.log('FAIL ' + p);
  if (outPath) writeFileSync(outPath, JSON.stringify(results, null, 1), 'utf8');
  await browser.close();
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error(String(e).slice(0, 500)); process.exit(2); });
