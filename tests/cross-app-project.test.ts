import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgliteDatabase } from '../packages/engine/db/pglite.js';
import type { Database } from '../packages/engine/db/types.js';
import { syncSchema } from '../packages/engine/schema/ddl.js';
import { loadSeed } from '../packages/engine/seed/load.js';
import { testRegistry } from '../packages/engine/testing/registry.js';
import { Environment } from '../packages/engine/orm/env.js';
import { clearModelHooks, type ActionResult } from '../packages/engine/orm/hooks.js';
import type { Domain } from '../packages/engine/registry/types.js';
import { registerApps } from '../packages/apps/index.js';

const registry = testRegistry();
let db: Database;
let env: Environment;
let partner: number;
let product: number;

beforeAll(async () => {
  db = pgliteDatabase();
  await syncSchema(db, registry);
  await loadSeed(db, registry);
  clearModelHooks();
  registerApps(registry);
  env = new Environment({ registry, db, uid: 2, companyIds: [1], superuser: true });
  partner = await env.model('res.partner').create({ name: 'Project customer' });
  const template = await env.model('product.template').create({ name: 'Project service', type: 'service', list_price: 100 });
  [product] = await env.model('product.product').search([['product_tmpl_id', '=', template]]);
}, 240_000);

afterAll(async () => { await db?.close?.(); });

async function soldWork() {
  const project = await env.model('project.project').create({ name: 'Customer implementation' });
  const order = await env.model('sale.order').create({ partner_id: partner, order_line: [[0, 0, { product_id: product, product_uom_qty: 2 }]] });
  const [line] = await env.model('sale.order.line').search([['order_id', '=', order]]);
  const task = await env.model('project.task').create({ name: 'Implement service', project_id: project, sale_line_id: line });
  return { project, order, line, task };
}

async function actionRecords(project: number | number[], method: string): Promise<number[]> {
  const action = await env.model('project.project').callButton(project, method) as ActionResult;
  return env.model(String(action.res_model)).search(action.domain as Domain);
}

describe('Project → Sales → Accounting and Documents', () => {
  it('opens orders and their lines through a task sales link, without including unrelated sales', async () => {
    const work = await soldWork();
    await soldWork();
    expect(await actionRecords(work.project, 'action_view_sos')).toEqual([work.order]);
    expect(await actionRecords(work.project, 'action_view_sols')).toEqual([work.line]);
    expect(await env.model('project.task').callButton(work.task, 'action_view_so')).toMatchObject({ res_model: 'sale.order', res_id: work.order });
  });

  it('includes direct project orders and combines links across multiple projects', async () => {
    const first = await soldWork();
    const second = await soldWork();
    const direct = await env.model('sale.order').create({ partner_id: partner, project_id: first.project });
    await env.model('project.project').write(first.project, { sale_order_id: first.order, reinvoiced_sale_order_id: second.order });
    expect((await actionRecords([first.project, second.project], 'action_view_sos')).sort()).toEqual([first.order, second.order, direct].sort());
  });

  it('finds invoices by sales-line relationships even when their origin text changes', async () => {
    const work = await soldWork();
    await env.model('sale.order').callButton(work.order, 'action_confirm');
    const wizardEnv = env.with({ context: { active_model: 'sale.order', active_ids: [work.order], active_id: work.order } });
    const wizard = await wizardEnv.model('sale.advance.payment.inv').create({ advance_payment_method: 'delivered' });
    const action = await wizardEnv.model('sale.advance.payment.inv').callButton(wizard, 'create_invoices') as { res_id: number };
    await env.model('account.move').write(action.res_id, { invoice_origin: 'Edited reference' });
    await env.model('account.move').create({ partner_id: partner, move_type: 'out_invoice', invoice_origin: (await env.model('sale.order').read(work.order, ['name']))[0].name });
    expect(await actionRecords(work.project, 'action_open_project_invoices')).toEqual([action.res_id]);
  });

  it('includes documents on archived tasks and excludes another project’s documents', async () => {
    const work = await soldWork();
    const other = await soldWork();
    const attachments = env.model('ir.attachment');
    const projectFile = await attachments.create({ name: 'Project brief.txt', type: 'binary', res_model: 'project.project', res_id: work.project });
    const taskFile = await attachments.create({ name: 'Task notes.txt', type: 'binary', res_model: 'project.task', res_id: work.task });
    await attachments.create({ name: 'Unrelated notes.txt', type: 'binary', res_model: 'project.task', res_id: other.task });
    await env.model('project.task').write(work.task, { active: false });
    expect((await actionRecords(work.project, 'action_open_documents')).sort()).toEqual([projectFile, taskFile].sort());
    expect(await actionRecords(work.project, 'action_view_sos')).toEqual([work.order]);
  });

  it('returns empty lists for a project without sales or documents', async () => {
    const project = await env.model('project.project').create({ name: 'Internal project' });
    for (const method of ['action_view_sos', 'action_view_sols', 'action_open_project_invoices', 'action_open_documents']) {
      expect(await actionRecords(project, method)).toEqual([]);
    }
  });
});
