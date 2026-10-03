// Create check: on every screen that offers New, fill the required fields the
// way a person would, save, confirm the record is there, then delete it.
// This is what proves a screen is live rather than merely drawn.
//
//   npx tsx scripts/dump-actions.mts dump.json
//   npm install --no-save playwright-core
//   BASE=http://localhost:3053 node scripts/dev/create-check.js dump.json [out.json]
//
// A model that cannot be created because something it needs does not exist yet
// (no product, no partner) is reported as "needs data", not as a failure.
// ONLY=slug,slug narrows the run; KEEP=1 leaves the records behind.
const { chromium } = require('playwright-core');
const { readFileSync, writeFileSync } = require('node:fs');

const BASE = process.env.BASE || 'http://localhost:3053';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const KEEP = process.env.KEEP === '1';
const dumpPath = process.argv[2] || 'dump.json';
const outPath = process.argv[3] || '';
const stamp = `Audit ${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`;

(async () => {
  const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
  const actions = (Array.isArray(dump.actions) ? dump.actions : Object.values(dump.actions))
    .filter((a) => a.type === 'act_window' && a.model && (a.viewMode || []).includes('form'))
    .filter((a) => !ONLY.length || ONLY.includes(a.path || `action-${a.id}`));

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 900 } })).newPage();
  let errors = [];
  page.on('pageerror', (e) => errors.push('pageerror ' + String(e).slice(0, 150)));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push('console ' + m.text().slice(0, 150)); });

  await page.goto(BASE + '/web/login', { waitUntil: 'networkidle' });
  await page.fill('input[type="email"], input[name="login"]', 'mastaisshakh@gmail.com');
  await page.fill('input[type="password"]', 'admin');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/odoo/, { timeout: 90000 });

  const settle = async (ms = 200) => {
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(ms);
  };
  // Our dialogs are `.o_dialog`, not bootstrap modals; an error one says so
  // in its header. Anything else on screen is a wizard, not a failure.
  const dialogText = async () => {
    const found = await page.evaluate(() => {
      const dialog = document.querySelector('.o_dialog');
      const toast = document.querySelector('.o_notification.border-danger, .o_notification_danger, .o_notification_warning');
      const text = (node) => (node ? node.textContent.replace(/\s+/g, ' ').trim() : '');
      const title = text(document.querySelector('.o_dialog_header h4'));
      if (dialog && /error|invalid|خطأ|غير صالح/i.test(title + ' ' + text(dialog).slice(0, 200))) return text(dialog).slice(0, 200);
      if (toast) return text(toast).slice(0, 200);
      return null;
    }).catch(() => null);
    if (found) await page.keyboard.press('Escape').catch(() => {});
    return found;
  };

  /** Fill one field, returning what it could not do. */
  async function fillField(field) {
    const box = field.first();
    const select = box.locator('select');
    if (await select.count()) {
      const values = await select.first().locator('option').evaluateAll((o) => o.map((x) => x.value));
      const pick = values.find((v) => v) ?? values[0];
      if (pick === undefined) return 'empty selection';
      await select.first().selectOption(pick).catch(() => {});
      return null;
    }
    const checkbox = box.locator('input[type="checkbox"]');
    if (await checkbox.count()) return null;
    const input = box.locator('input:not([type="checkbox"]), textarea').first();
    if (!(await input.count())) {
      const editable = box.locator('[contenteditable="true"]').first();
      if (await editable.count()) { await editable.fill(stamp).catch(() => {}); return null; }
      return 'no input';
    }
    const isRelational = (await box.getAttribute('class').catch(() => '') || '').includes('o_field_many2one')
      || (await box.locator('.o_m2o_dropdown, .o_input_dropdown').count()) > 0;
    if (isRelational) {
      await input.click().catch(() => {});
      await page.waitForTimeout(400);
      let option = page.locator('.o_m2o_dropdown .o_m2o_item, .o_m2o_dropdown li, .o_m2o_dropdown .o_dropdown_item').first();
      if (!(await option.count())) {
        await input.type('a', { delay: 30 }).catch(() => {});
        await page.waitForTimeout(600);
        option = page.locator('.o_m2o_dropdown .o_m2o_item, .o_m2o_dropdown li, .o_m2o_dropdown .o_dropdown_item').first();
      }
      if (!(await option.count())) return 'needs data';
      const text = ((await option.textContent().catch(() => '')) || '').trim();
      if (/search more|create /i.test(text)) return 'needs data';
      await option.click().catch(() => {});
      await page.waitForTimeout(250);
      return null;
    }
    const type = await input.getAttribute('type').catch(() => 'text');
    const today = new Date();
    const value = type === 'number' ? '1'
      : type === 'date' ? today.toISOString().slice(0, 10)
      : type === 'datetime-local' ? today.toISOString().slice(0, 16)
      : type === 'email' ? 'audit@example.com'
      : stamp;
    await input.fill(value).catch(() => {});
    await input.press('Escape').catch(() => {});
    return null;
  }

  // A record that links to a partner or a product cannot be created on an
  // empty database, so the run starts with a few records to link to and
  // removes them at the end.
  const rpc = (method, model, params) => page.evaluate(async ([method, model, params]) => {
    const response = await fetch('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, model, params }) });
    const body = await response.json();
    if (body.error) throw new Error(body.error.message || 'rpc failed');
    return body.result;
  }, [method, model, params]);

  const fixtures = [];
  const fixture = async (model, values) => {
    try {
      const existing = await rpc('search', model, { domain: [], limit: 1 });
      if (existing && existing.length) return existing[0];
      const id = await rpc('create', model, { values });
      fixtures.push([model, id]);
      return id;
    } catch (error) {
      console.log(`  (fixture ${model}: ${String(error).slice(0, 80)})`);
      return null;
    }
  };
  const partner = await fixture('res.partner', { name: `${stamp} Partner`, email: 'audit@example.com', customer_rank: 1, supplier_rank: 1 });
  const template = await fixture('product.template', { name: `${stamp} Service`, type: 'service', list_price: 100 });
  await fixture('hr.employee', { name: `${stamp} Employee` });
  await fixture('project.project', { name: `${stamp} Project` });
  console.log(`fixtures ready (partner ${partner}, product ${template}), ${fixtures.length} created for this run
`);

  const results = [];
  const problems = [];
  for (const action of actions) {
    const slug = action.path || `action-${action.id}`;
    const label = `${action.name?.en || action.name || slug} (${slug})`;
    errors = [];
    await page.goto(`${BASE}/odoo/${slug}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await settle(400);
    const newButton = page.locator('.o_control_panel button:has-text("New")').first();
    if (!(await newButton.count())) { results.push({ slug, model: action.model, outcome: 'no New button' }); continue; }
    await newButton.click({ timeout: 10000 }).catch(() => {});
    await settle(500);
    if (!(await page.locator('.o_form_view, .modal .o_form_view').count())) {
      problems.push(`${label}: New does not open a form`);
      console.log(`x ${label}: New does not open a form`);
      results.push({ slug, model: action.model, outcome: 'no form' });
      continue;
    }

    // Fill in everything the form offers and leave empty, the way a person
    // does when a save complains: required controls first, then the rest.
    const count = Math.min(await page.evaluate(() => {
      const form = document.querySelector('.o_dialog .o_form_view') || document.querySelector('.o_form_view');
      if (!form) return 0;
      const required = new Set();
      for (const label of form.querySelectorAll('.o_form_label.o_field_required')) {
        const control = label.nextElementSibling;
        if (control) required.add(control);
      }
      // Empty, visible, editable controls — required ones first.
      const empty = [...form.querySelectorAll('.o_field_widget')].filter((widget) => {
        if (widget.offsetParent === null || widget.closest('.o_readonly')) return false;
        const input = widget.querySelector('input:not([type=checkbox]), select, textarea');
        if (!input || input.disabled || input.readOnly) return false;
        return !input.value;
      });
      const ordered = [...empty].sort((a, b) => Number(required.has(b)) - Number(required.has(a)));
      ordered.forEach((widget, index) => widget.setAttribute('data-audit-fill', String(index)));
      return ordered.length;
    }).catch(() => 0), 25);
    let blocked = null;
    for (let i = 0; i < count && !blocked; i += 1) {
      const field = page.locator(`[data-audit-fill="${i}"]`);
      if (!(await field.count()) || !(await field.isVisible().catch(() => false))) continue;
      const note = await fillField(field);
      if (note === 'needs data') blocked = await field.getAttribute('data-name').catch(() => null) ?? 'a link field';
    }
    // A name field is usually the one the record is known by, required or not.
    const name = page.locator('.o_form_view .o_field_widget[data-name="name"] input, .o_form_view .oe_title input').first();
    if (!blocked && (await name.count()) && !(await name.inputValue().catch(() => ''))) await name.fill(stamp).catch(() => {});

    if (blocked) {
      results.push({ slug, model: action.model, outcome: `needs data (${blocked})` });
      console.log(`- ${label}: needs data (${blocked})`);
      await page.keyboard.press('Escape').catch(() => {});
      continue;
    }

    // The save control is Odoo's cloud indicator in the status bar, or the
    // footer button when the form is in a dialog.
    const save = page.locator('.o_form_status_indicator button[title="Alt+S"], .modal .modal-footer button:has-text("Save"), .modal .modal-footer .btn-primary').first();
    if (!(await save.count())) {
      problems.push(`${label}: the form has no Save button`);
      console.log(`x ${label}: the form has no Save button`);
      results.push({ slug, model: action.model, outcome: 'no save button' });
      continue;
    }
    await save.click({ timeout: 10000 }).catch(() => {});
    await settle(700);
    const failure = await dialogText();
    const stillDirty = await page.locator('.o_form_dirty').count();
    if (failure) {
      const wanted = /required|invalid|mandatory|must be set/i.test(failure);
      results.push({ slug, model: action.model, outcome: wanted ? `needs data (${failure.slice(0, 60)})` : `save failed: ${failure}` });
      if (!wanted) { problems.push(`${label}: save failed — ${failure}`); console.log(`x ${label}: save failed — ${failure}`); }
      else console.log(`- ${label}: needs data — ${failure.slice(0, 60)}`);
      await page.keyboard.press('Escape').catch(() => {});
      continue;
    }
    if (stillDirty) {
      problems.push(`${label}: Save leaves the record unsaved`);
      console.log(`x ${label}: Save leaves the record unsaved`);
      results.push({ slug, model: action.model, outcome: 'still dirty after save' });
      continue;
    }

    const saved = /\/odoo\/[^/]+\/\d+/.test(page.url());
    results.push({ slug, model: action.model, outcome: saved ? 'created' : 'saved (no id in url)', errors: errors.slice(0, 2) });
    console.log(`. ${label}: created${errors.length ? ` (console: ${errors[0]})` : ''}`);

    if (saved && !KEEP) {
      const cog = page.locator('.o_control_panel .o_dropdown > span, .o_cp_action_menus button').first();
      if (await cog.count()) {
        await cog.click({ timeout: 6000 }).catch(() => {});
        await page.waitForTimeout(250);
        const del = page.locator('.o_dropdown_menu button:has-text("Delete")').first();
        if (await del.count()) {
          await del.click({ timeout: 6000 }).catch(() => {});
          await page.waitForTimeout(300);
          const confirm = page.locator('.modal button:has-text("Delete"), .modal button:has-text("Ok"), .modal .btn-primary').first();
          if (await confirm.count()) await confirm.click({ timeout: 6000 }).catch(() => {});
          await settle(400);
        }
        await page.keyboard.press('Escape').catch(() => {});
      }
    }
  }

  if (!KEEP) {
    for (const [model, id] of fixtures.reverse()) {
      await rpc('unlink', model, { ids: [id] }).catch(() => {});
    }
  }

  const created = results.filter((r) => r.outcome === 'created').length;
  const needs = results.filter((r) => String(r.outcome).startsWith('needs data')).length;
  console.log(`\n${results.length} screens: ${created} created a record, ${needs} need data first, ${problems.length} failed`);
  for (const p of problems) console.log('FAIL ' + p);
  if (outPath) writeFileSync(outPath, JSON.stringify(results, null, 1), 'utf8');
  await browser.close();
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error(String(e).slice(0, 500)); process.exit(2); });
