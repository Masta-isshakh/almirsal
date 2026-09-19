import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse } from '../expr/parse.js';
import type { FormNode, ViewArch } from './arch.js';
import type { Registry } from './types.js';
import { collectMessages, loadRegistry, splitI18n, type ExtraModels, type RawSpec } from './spec-loader.js';

/**
 * Loads the real export and checks the whole registry, not a fixture: the
 * point is to prove every screen in the live instance is representable and
 * every expression it carries is parseable (A-8).
 */

let spec: RawSpec;
let registry: Registry;

beforeAll(() => {
  const path = resolve(process.cwd(), 'registry/odoo_spec.json');
  spec = JSON.parse(readFileSync(path, 'utf8')) as RawSpec;
  const extra = JSON.parse(readFileSync(resolve(process.cwd(), 'registry/extra-models.json'), 'utf8')) as ExtraModels;
  registry = loadRegistry(spec, extra);
});

describe('splitI18n', () => {
  it('splits the EN ⇔ AR notation', () => {
    expect(splitI18n('Confirm ⇔ تأكيد')).toEqual({ en: 'Confirm', ar: 'تأكيد' });
  });

  it('duplicates a plain string into both languages', () => {
    expect(splitI18n('Download')).toEqual({ en: 'Download', ar: 'Download' });
  });
});

describe('registry counts match the live instance', () => {
  it('has the 22 apps in home-menu order', () => {
    expect(registry.menus.map((menu) => menu.name.en)).toEqual([
      'Discuss', 'Calendar', 'Appointments', 'To-do', 'Knowledge', 'Sales', 'Dashboards',
      'Rental', 'Accounting', 'Documents', 'Project', 'Planning', 'Helpdesk', 'Surveys',
      'Purchase', 'Sign', 'Employees', 'Attendances', 'Fleet', 'Approvals', 'Apps', 'Settings',
    ]);
    expect(registry.appIcons).toHaveLength(22);
  });

  it('indexes all 330 menus with Arabic names', () => {
    expect(Object.keys(registry.menuIndex)).toHaveLength(330);
    expect(registry.menuIndex[262].name).toEqual({ en: 'Calendar', ar: 'التقويم' });
  });

  it('loads 277 actions and 668 views', () => {
    expect(Object.keys(registry.actions)).toHaveLength(277);
    expect(Object.keys(registry.views)).toHaveLength(668);
  });

  it('loads every model and submodel with its fields', () => {
    const capturedModels = new Set([...Object.keys(spec.models), ...Object.keys(spec.submodels)]);
    expect(Object.keys(registry.models).length).toBeGreaterThan(capturedModels.size + 70);

    // 4,164 captured fields, minus duplicates across models/submodels, plus
    // the synthesized one2many back-references.
    const captured = Object.values(registry.models)
      .reduce((sum, model) => sum + Object.values(model.fields).filter((f) => !f.inferred).length, 0);
    expect(captured).toBeGreaterThan(3900);
  });

  it('loads the seed, reports and financial reports', () => {
    expect(registry.seed['res.currency']).toHaveLength(170);
    expect(registry.reports).toHaveLength(29);
    expect(registry.accountReports).toHaveLength(19);
    expect(Object.keys(registry.groups)).toHaveLength(89);
  });
});

describe('referential integrity', () => {
  it('every menu action exists', () => {
    const missing = Object.values(registry.menuIndex)
      .filter((menu) => menu.actionId !== undefined && !registry.actions[String(menu.actionId)])
      .map((menu) => `${menu.id}:${menu.actionId}`);
    expect(missing).toEqual([]);
  });

  it('every action view binding resolves to a loaded view', () => {
    const missing: string[] = [];
    for (const action of Object.values(registry.actions)) {
      for (const key of action.views ?? []) {
        if (!registry.views[key]) missing.push(`${action.id}:${key}`);
      }
      if (action.searchView && !registry.views[action.searchView]) {
        missing.push(`${action.id}:${action.searchView}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every view belongs to a loaded model', () => {
    const missing = Object.values(registry.views)
      .filter((view) => !registry.models[view.model])
      .map((view) => view.key);
    expect(missing).toEqual([]);
  });

  it('every relational field points at a loaded model', () => {
    const missing: string[] = [];
    for (const model of Object.values(registry.models)) {
      for (const field of Object.values(model.fields)) {
        if (field.relation && !registry.models[field.relation]) {
          missing.push(`${model.name}.${field.name} -> ${field.relation}`);
        }
      }
    }
    // Every relation must resolve now that extra-models.json fills the gaps.
    expect(missing).toEqual([]);
  });

  it('infers an inverse for nearly every one2many', () => {
    const unresolved: string[] = [];
    let total = 0;
    for (const model of Object.values(registry.models)) {
      for (const field of Object.values(model.fields)) {
        if (field.type !== 'one2many') continue;
        total += 1;
        if (!field.inverse) unresolved.push(`${model.name}.${field.name} -> ${field.relation}`);
      }
    }
    expect(total).toBeGreaterThan(100);
    // Inverses on uncaptured comodels cannot exist; everything else must resolve.
    const onLoaded = unresolved.filter((entry) => registry.models[entry.split(' -> ')[1]]);
    expect(onLoaded).toEqual([]);
  });

  it('links polymorphic comodels through res_id and flags synthesized columns', () => {
    expect(registry.models['hr.employee'].fields.activity_ids.inverse).toBe('res_id');
    const inverse = registry.models['sale.order.template'].fields.sale_order_template_line_ids.inverse;
    expect(inverse).toBeTruthy();
    const column = registry.models['sale.order.template.line'].fields[inverse as string];
    expect(column.type).toBe('many2one');
    expect(column.relation).toBe('sale.order.template');
    expect(column.inferred).toBe(true);
    // A captured inverse is never marked inferred.
    expect(registry.models['sale.order.line'].fields.order_id.inferred).toBeUndefined();
  });

  it('gives every many2many a relation table', () => {
    for (const model of Object.values(registry.models)) {
      for (const field of Object.values(model.fields)) {
        if (field.type === 'many2many') {
          expect(field.m2mTable, `${model.name}.${field.name}`).toBeTruthy();
          expect(field.m2mColumn1).not.toBe(field.m2mColumn2);
        }
      }
    }
  });
});

describe('typed archs', () => {
  it('converts the sale order form with its header buttons and statusbar', () => {
    const view = registry.views['sale.order|form|1190'];
    expect(view.arch.type).toBe('form');
    const arch = view.arch as Extract<ViewArch, { type: 'form' }>;
    expect(arch.jsClass).toBe('sale_order_form');
    expect(arch.string).toEqual({ en: 'Sales Order', ar: 'أمر البيع' });

    const header = arch.body.find((node) => node.kind === 'header');
    expect(header?.kind).toBe('header');
    const buttons = (header as Extract<FormNode, { kind: 'header' }>).children
      .filter((node): node is Extract<FormNode, { kind: 'button' }> => node.kind === 'button');
    const confirm = buttons.find((button) => button.name === 'action_confirm');
    expect(confirm?.string).toEqual({ en: 'Confirm', ar: 'تأكيد' });
    expect(confirm?.hotkey).toBe('q');
    expect(confirm?.invisible).toBe("state != 'sent'");

    const statusbar = (header as Extract<FormNode, { kind: 'header' }>).children
      .find((node) => node.kind === 'field' && node.name === 'state');
    expect(statusbar?.kind).toBe('field');
    expect((statusbar as Extract<FormNode, { kind: 'field' }>).statusbarVisible).toBe('draft,sent,sale');
  });

  it('converts list columns with optional, aggregates and decorations', () => {
    const arch = registry.views['sale.order|list|1188'].arch as Extract<ViewArch, { type: 'list' }>;
    expect(arch.multiEdit).toBe(true);
    expect(arch.sample).toBe(true);
    expect(arch.decorations.muted).toBe("state == 'cancel'");

    const total = arch.columns.find((column) => column.kind === 'field' && column.name === 'amount_total');
    expect(total?.kind).toBe('field');
    const column = total as Extract<typeof total, { kind: 'field' }>;
    expect(column.widget).toBe('monetary');
    expect(column.optional).toBe('show');
    expect(column.sum).toEqual({ en: 'Total Tax Included', ar: 'الإجمالي شامل الضريبة' });
    expect(column.decorations.info).toBe("invoice_status == 'to invoice'");
    expect(column.decorations.bf).toBe('1');

    expect(arch.headerButtons[0].string).toEqual({ en: 'Create Invoices', ar: 'إنشاء الفواتير' });
  });

  it('converts the search view with filters, separators, date filters and group-bys', () => {
    const arch = registry.views['sale.order|search|1193'].arch as Extract<ViewArch, { type: 'search' }>;
    expect(arch.fields[0].filterDomain).toContain("('name', 'ilike', self)");
    const dateFilter = arch.filters.find((filter) => 'name' in filter && filter.name === 'filter_create_date');
    expect(dateFilter && 'date' in dateFilter ? dateFilter.date : undefined).toBe('create_date');
    expect(arch.filters.some((filter) => 'separator' in filter)).toBe(true);
    expect(arch.groupbys.find((group) => group.name === 'customer')?.context).toBe("{'group_by': 'partner_id'}");
  });

  it('converts the kanban progress bar and card summary', () => {
    const arch = registry.views['sale.order|kanban|1189'].arch as Extract<ViewArch, { type: 'kanban' }>;
    expect(arch.progressbar?.field).toBe('activity_state');
    expect(arch.templates.card.fields).toContain('amount_total');
    expect(arch.templates.card.widgets).toContain('amount_total:monetary');
  });

  it('converts gantt, calendar and grid specifics', () => {
    const gantt = registry.views['planning.slot|gantt|1857'].arch as Extract<ViewArch, { type: 'gantt' }>;
    expect(gantt.dateStart).toBe('start_datetime');
    expect(gantt.defaultGroupBy).toBe('resource_ids');
    expect(gantt.totalRow).toBe(true);
    expect(gantt.decorations.info).toBe("state == '1_draft'");

    const calendar = registry.views['calendar.event|calendar|1276'].arch as Extract<ViewArch, { type: 'calendar' }>;
    expect(calendar.dateStart).toBe('start');
    expect(calendar.allDay).toBe('allday');
    expect(calendar.eventLimit).toBe(5);

    const grid = registry.views['account.analytic.line|grid|1002'].arch as Extract<ViewArch, { type: 'grid' }>;
    expect(grid.ranges.map((range) => range.name)).toEqual(['year', 'month']);
  });

  it('converts embedded x2many views inside form fields', () => {
    const arch = registry.views['sale.order|form|1190'].arch as Extract<ViewArch, { type: 'form' }>;
    let orderLine: Extract<FormNode, { kind: 'field' }> | undefined;
    const walk = (nodes: FormNode[]): void => {
      for (const node of nodes) {
        if (node.kind === 'field' && node.name === 'order_line') orderLine = node;
        if ('children' in node) walk(node.children);
        if (node.kind === 'notebook') walk(node.pages);
      }
    };
    walk(arch.body);
    expect(orderLine?.views?.list?.type).toBe('list');
    expect(orderLine?.views?.form?.type).toBe('form');
  });

  it('converts the settings page into app/block/setting nodes', () => {
    const arch = registry.views['res.config.settings|form|180'].arch as Extract<ViewArch, { type: 'form' }>;
    const apps: string[] = [];
    const walk = (nodes: FormNode[]): void => {
      for (const node of nodes) {
        if (node.kind === 'app') apps.push(node.name);
        if ('children' in node) walk(node.children);
      }
    };
    walk(arch.body);
    expect(apps).toContain('general_settings');
    expect(apps).toContain('sale_management');
    // 13 apps expose a settings section in this instance.
    expect(apps.length).toBe(13);
  });
});

describe('models', () => {
  it('converts field labels, selections, flags and relations', () => {
    const order = registry.models['sale.order'];
    expect(order.description).toEqual({ en: 'Sales Order', ar: 'أمر البيع' });
    expect(order.fields.partner_id).toMatchObject({
      type: 'many2one', relation: 'res.partner', required: true,
      label: { en: 'Customer', ar: 'العميل' },
    });
    expect(order.fields.state.selection?.map((option) => option.value)).toEqual(['draft', 'sent', 'sale', 'cancel']);
    expect(order.fields.state.selection?.[2].label).toEqual({ en: 'Sales Order', ar: 'أمر البيع' });
    expect(order.fields.state.readonly).toBe(true);
    expect(order.fields.order_line.inverse).toBe('order_id');
    expect(order.fields.amount_total.currencyField).toBe('currency_id');
  });

  it('keeps selection values containing spaces intact', () => {
    const state = registry.models['ir.module.module'].fields.state;
    expect(state.selection?.some((option) => option.value === 'to upgrade')).toBe(true);
  });

  it('flags transient wizard models', () => {
    expect(registry.models['base.language.install']?.transient).toBe(true);
    expect(registry.models['sale.order'].transient).toBe(false);
  });
});

describe('actions and menus', () => {
  it('converts an act_window action with its views in switcher order', () => {
    const action = registry.actions['449'];
    expect(action.type).toBe('act_window');
    expect(action.model).toBe('sale.order');
    expect(action.path).toBe('orders');
    expect(action.viewMode).toEqual(['list', 'kanban', 'form', 'calendar', 'pivot', 'graph', 'activity', 'map']);
    expect(action.views?.[0]).toBe('sale.order|list|1186');
    expect(action.searchView).toBe('sale.order|search|1194');
    expect(action.context).toBe("{'search_default_sales' : 1}");
  });

  it('converts client, server, report and url actions', () => {
    expect(registry.actions['372']).toMatchObject({ type: 'client', tag: 'account_report', path: 'balance-sheet' });
    expect(registry.actions['301'].type).toBe('server');
    expect(registry.actions['432']).toMatchObject({ type: 'report', reportName: 'sale.action_report_saleorder' });
    expect(registry.actions['131']).toMatchObject({ type: 'url', url: '/odoo/settings#discuss_setting' });
  });

  it('builds the menu tree with parent links and sequences', () => {
    const calendar = registry.menuIndex[262];
    expect(calendar.parentId).toBeUndefined();
    expect(calendar.children.map((child) => child.id)).toEqual([263, 303, 304, 264]);
    expect(calendar.children[1].parentId).toBe(262);
    expect(calendar.children[1].sequence).toBe(1);
    expect(calendar.webIcon).toBe('data');
  });
});

describe('A-8: every expression in every view parses', () => {
  function collectExpressions(): { source: string; where: string }[] {
    const out: { source: string; where: string }[] = [];
    const push = (value: unknown, where: string) => {
      if (typeof value === 'string' && value.trim()) out.push({ source: value, where });
    };

    const visitFormNodes = (nodes: FormNode[], where: string): void => {
      for (const node of nodes) {
        if ('invisible' in node) push(node.invisible, `${where} invisible`);
        if (node.kind === 'field') {
          push(node.readonly, `${where}.${node.name} readonly`);
          push(node.required, `${where}.${node.name} required`);
          push(node.columnInvisible, `${where}.${node.name} column_invisible`);
          push(node.domain, `${where}.${node.name} domain`);
          push(node.context, `${where}.${node.name} context`);
          push(node.options, `${where}.${node.name} options`);
          for (const [key, expr] of Object.entries(node.decorations)) push(expr, `${where}.${node.name} decoration-${key}`);
          if (node.views) {
            for (const [type, arch] of Object.entries(node.views)) visitArch(arch, `${where}.${node.name}[${type}]`);
          }
        }
        if (node.kind === 'button') push(node.context, `${where} button ${node.name} context`);
        if (node.kind === 'create') push(node.context, `${where} create context`);
        if ('children' in node) visitFormNodes(node.children, where);
        if (node.kind === 'notebook') visitFormNodes(node.pages, where);
      }
    };

    const visitArch = (arch: ViewArch, where: string): void => {
      switch (arch.type) {
        case 'form':
          visitFormNodes(arch.body, where);
          push(arch.create, `${where} create`);
          push(arch.edit, `${where} edit`);
          push(arch.delete, `${where} delete`);
          break;
        case 'list':
          for (const [key, expr] of Object.entries(arch.decorations)) push(expr, `${where} decoration-${key}`);
          visitFormNodes(arch.columns, where);
          visitFormNodes(arch.headerButtons, where);
          visitFormNodes(arch.control, where);
          for (const group of arch.groupby) visitFormNodes(group.buttons, `${where} groupby ${group.name}`);
          break;
        case 'kanban':
          visitFormNodes(arch.fields, where);
          visitFormNodes(arch.headerButtons, where);
          break;
        case 'search':
          for (const field of arch.fields) {
            push(field.filterDomain, `${where} field ${field.name} filter_domain`);
            push(field.domain, `${where} field ${field.name} domain`);
            push(field.context, `${where} field ${field.name} context`);
          }
          for (const filter of arch.filters) {
            if ('separator' in filter) continue;
            push(filter.domain, `${where} filter ${filter.name} domain`);
            push(filter.context, `${where} filter ${filter.name} context`);
            push(filter.invisible, `${where} filter ${filter.name} invisible`);
          }
          for (const group of arch.groupbys) {
            push(group.context, `${where} groupby ${group.name} context`);
            push(group.domain, `${where} groupby ${group.name} domain`);
          }
          break;
        case 'gantt':
          for (const [key, expr] of Object.entries(arch.decorations)) push(expr, `${where} decoration-${key}`);
          visitFormNodes(arch.fields, where);
          push(arch.precision, `${where} precision`);
          break;
        case 'calendar':
        case 'activity':
        case 'map':
        case 'hierarchy':
        case 'cohort':
          visitFormNodes(arch.fields, where);
          break;
        default:
          break;
      }
    };

    for (const view of Object.values(registry.views)) visitArch(view.arch, view.key);
    for (const action of Object.values(registry.actions)) {
      push(action.domain, `action ${action.id} domain`);
      push(action.context, `action ${action.id} context`);
    }
    return out;
  }

  it('parses every invisible/readonly/required/domain/context/options/decoration string', () => {
    const expressions = collectExpressions();
    expect(expressions.length).toBeGreaterThan(5000);

    const failures: string[] = [];
    for (const { source, where } of expressions) {
      try {
        parse(source);
      } catch (error) {
        failures.push(`${where}: ${JSON.stringify(source)} — ${(error as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe('i18n catalog', () => {
  it('extracts thousands of EN → AR pairs keyed by English', () => {
    const { en, ar } = collectMessages(spec);
    expect(Object.keys(ar).length).toBeGreaterThan(3000);
    expect(ar.Confirm).toBe('تأكيد');
    expect(ar.Calendar).toBe('التقويم');
    expect(ar.Customer).toBe('العميل');
    expect(en.Confirm).toBe('Confirm');
  });
});
