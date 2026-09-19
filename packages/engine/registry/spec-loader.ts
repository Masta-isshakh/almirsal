import type { I18n } from '../i18n/types.js';
import { pgIdentifier } from '../db/identifiers.js';
import type {
  ActivityArch,
  Attrs,
  ButtonNode,
  CalendarArch,
  CohortArch,
  Cond,
  FieldNode,
  FormArch,
  FormNode,
  GanttArch,
  GraphArch,
  GridArch,
  HierarchyArch,
  KanbanArch,
  KanbanButton,
  KanbanTemplateSummary,
  ListArch,
  ListColumn,
  ListGroupByHeader,
  MapArch,
  PivotArch,
  PivotField,
  SearchArch,
  SearchField,
  SearchFilter,
  SearchGroupBy,
  SearchPanel,
  SearchPanelField,
  SearchSeparator,
  ViewArch,
  ViewToolbar,
} from './arch.js';
import type {
  AccountReportDef,
  ActionDef,
  ActionTarget,
  ActionType,
  AppIconDef,
  FieldDef,
  FieldType,
  GroupDef,
  MenuDef,
  ModelDef,
  Registry,
  ReportDef,
  SelectionOption,
  ViewDef,
  ViewType,
} from './types.js';

/**
 * Loads the companion export (`odoo_spec.json`) into the typed registry.
 *
 * The export is what the master prompt's Parts E–I were generated from, so
 * this loader is the single place the compact capture format is understood.
 * Everything downstream — ORM, renderers, i18n catalogs, Drizzle schema —
 * reads the typed `Registry` and never the raw JSON.
 */

/* ------------------------------------------------------------------ *
 * Raw export shapes (only what the loader touches; kept loose on purpose)
 * ------------------------------------------------------------------ */

type Raw = Record<string, unknown>;

interface RawField {
  s: string;
  t: string;
  ar?: string;
  rel?: string;
  sel?: string[];
  req?: number;
  ro?: number;
  help?: string;
}

interface RawMenu {
  name: string;
  xmlid: string;
  action: number | false;
  children: number[];
  app: number;
  icon: string;
}

interface RawAction {
  type: string;
  name: string;
  model?: string;
  view_mode?: string;
  domain?: string | false;
  context?: string;
  help?: string;
  xml_id: string;
  path?: string | false;
  target?: string;
  limit?: number;
  views?: string[];
  toolbar?: { print?: string[]; action?: string[] };
  tag?: string;
  params?: unknown;
  url?: string;
}

interface RawActionMeta {
  search_view_id?: [number, string] | false;
  secondary?: boolean;
  binding?: unknown;
}

export interface RawSpec {
  session: { version: string; db: string; langs: string[]; user: string };
  menus_en: Record<string, RawMenu>;
  menus_ar: Record<string, string>;
  menus_root: number[];
  actions: Record<string, RawAction>;
  actions_meta: Record<string, RawActionMeta>;
  views: Record<string, Raw>;
  models: Record<string, Record<string, RawField>>;
  submodels: Record<string, Record<string, RawField>>;
  model_names: Record<string, { name: string; transient: boolean }>;
  reports: { id: number; model: string; name: string; report_name: string; type: string }[];
  account_reports: Raw[];
  app_icons: { id: number; name: string; icon: string; hasData: boolean }[];
  seed: Record<string, Raw[]>;
  README?: string;
}

/* ------------------------------------------------------------------ *
 * Primitive conversions
 * ------------------------------------------------------------------ */

const I18N_SEPARATOR = ' ⇔ ';

/** `"EN ⇔ AR"` → `{en, ar}`; a plain string becomes the same in both. */
export function splitI18n(value: string): I18n {
  const index = value.indexOf(I18N_SEPARATOR);
  if (index === -1) return { en: value, ar: value };
  return {
    en: value.slice(0, index),
    ar: value.slice(index + I18N_SEPARATOR.length),
  };
}

function i18nOf(value: unknown): I18n | undefined {
  if (typeof value !== 'string') return undefined;
  return splitI18n(value);
}

/**
 * Attribute values that are conditions: "1"/"True" and "0"/"False" collapse
 * to booleans; anything else stays a Python expression source.
 */
function condOf(value: unknown): Cond | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value).trim();
  if (text === '1' || text === 'True' || text === 'true') return true;
  if (text === '0' || text === 'False' || text === 'false' || text === '') return false;
  return text;
}

function boolOf(value: unknown): boolean | undefined {
  const cond = condOf(value);
  if (cond === undefined) return undefined;
  return cond === true;
}

function strOf(value: unknown): string | undefined {
  if (value === undefined || value === null || value === false) return undefined;
  return String(value);
}

function numOf(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '' || value === false) return undefined;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Every `decoration-*` attribute keyed by its suffix. */
function decorationsOf(raw: Raw): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('decoration-') && typeof value === 'string') {
      out[key.slice('decoration-'.length)] = value.trim();
    }
  }
  return out;
}

/** Copy the attributes a converter did not lift into typed properties. */
function restAttrs(raw: Raw, consumed: string[]): Attrs {
  const out: Attrs = {};
  for (const [key, value] of Object.entries(raw)) {
    if (consumed.includes(key) || key.startsWith('decoration-')) continue;
    out[key] = value;
  }
  return out;
}

/** Odoo view strings often carry indentation from the XML. */
function tidyExpr(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ *
 * Form nodes
 * ------------------------------------------------------------------ */

const FIELD_CONSUMED = [
  'name', 'widget', 'string', 'placeholder', 'help', 'invisible', 'column_invisible',
  'readonly', 'required', 'hidden', 'nolabel', 'no_label', 'class', 'options', 'domain',
  'context', 'views', 'mode', 'statusbar_visible', 'optional', 'sum', 'avg', 'width',
  'password', 'filename',
];

function convertField(raw: Raw): FieldNode {
  const views = raw.views && typeof raw.views === 'object'
    ? convertEmbeddedViews(raw.views as Raw)
    : undefined;

  const optional = strOf(raw.optional);

  return {
    kind: 'field',
    name: String(raw.name),
    widget: strOf(raw.widget),
    string: i18nOf(raw.string),
    placeholder: i18nOf(raw.placeholder),
    help: i18nOf(raw.help),
    invisible: condOf(raw.invisible),
    columnInvisible: condOf(raw.column_invisible),
    readonly: condOf(raw.readonly),
    required: condOf(raw.required),
    hidden: raw.hidden ? true : undefined,
    nolabel: boolOf(raw.nolabel ?? raw.no_label),
    class: strOf(raw.class),
    options: tidyExpr(raw.options),
    domain: tidyExpr(raw.domain),
    context: tidyExpr(raw.context),
    views,
    mode: strOf(raw.mode),
    statusbarVisible: strOf(raw.statusbar_visible),
    optional: optional === 'show' || optional === 'hide' ? optional : undefined,
    sum: i18nOf(raw.sum),
    avg: i18nOf(raw.avg),
    width: strOf(raw.width),
    password: boolOf(raw.password),
    filename: strOf(raw.filename),
    decorations: decorationsOf(raw),
    attrs: restAttrs(raw, FIELD_CONSUMED),
  };
}

const BUTTON_CONSUMED = [
  'name', 'type', 'string', 'class', 'cls', 'icon', 'invisible', 'context',
  'confirm', 'help', 'title', 'data-hotkey', 'special',
];

function convertButton(raw: Raw): ButtonNode {
  const type = strOf(raw.type);
  return {
    kind: 'button',
    name: strOf(raw.name),
    type: (type === 'object' || type === 'action' || type === 'edit' || type === 'button')
      ? type
      : undefined,
    string: i18nOf(raw.string),
    class: strOf(raw.class ?? raw.cls),
    icon: strOf(raw.icon),
    invisible: condOf(raw.invisible),
    context: tidyExpr(raw.context),
    confirm: i18nOf(raw.confirm),
    help: i18nOf(raw.help),
    title: i18nOf(raw.title),
    hotkey: strOf(raw['data-hotkey']),
    special: strOf(raw.special),
    attrs: restAttrs(raw, BUTTON_CONSUMED),
  };
}

function convertChildren(items: unknown): FormNode[] {
  if (!Array.isArray(items)) return [];
  const out: FormNode[] = [];
  for (const item of items) {
    const node = convertFormNode(item as Raw);
    if (node) out.push(node);
  }
  return out;
}

/**
 * The export wraps each element in a single-key object naming its kind:
 * `{f: {...}}`, `{btn: {...}}`, `{group: {...}, items: [...]}`,
 * `{el: 'div', cls, text, items}`, `{notebook: [...]}`, `{sheet: [...]}`...
 */
export function convertFormNode(raw: Raw): FormNode | null {
  if (!raw || typeof raw !== 'object') return null;

  if (raw.f) return convertField(raw.f as Raw);
  if (raw.btn) return convertButton(raw.btn as Raw);

  if (typeof raw.el === 'string') {
    return {
      kind: 'element',
      tag: raw.el,
      class: strOf(raw.cls ?? raw.class),
      text: i18nOf(raw.text),
      invisible: condOf(raw.invisible),
      children: convertChildren(raw.items),
      attrs: restAttrs(raw, ['el', 'cls', 'class', 'text', 'invisible', 'items']),
    };
  }

  if (raw.group !== undefined) {
    const attrs = (raw.group ?? {}) as Raw;
    return {
      kind: 'group',
      name: strOf(attrs.name),
      string: i18nOf(attrs.string),
      col: numOf(attrs.col),
      colspan: numOf(attrs.colspan),
      class: strOf(attrs.class),
      invisible: condOf(attrs.invisible),
      children: convertChildren(raw.items),
    };
  }

  if (raw.notebook !== undefined) {
    const pages: FormNode[] = convertChildren(raw.notebook);
    return {
      kind: 'notebook',
      pages: pages.filter((page): page is Extract<FormNode, { kind: 'page' }> => page.kind === 'page'),
    };
  }

  if (raw.page !== undefined) {
    const attrs = (raw.page ?? {}) as Raw;
    return {
      kind: 'page',
      name: strOf(attrs.name),
      string: i18nOf(attrs.string),
      invisible: condOf(attrs.invisible),
      children: convertChildren(raw.items),
    };
  }

  if (raw.sheet !== undefined) return { kind: 'sheet', children: convertChildren(raw.sheet) };
  if (raw.header !== undefined) return { kind: 'header', children: convertChildren(raw.header) };
  if (raw.buttonbox !== undefined) return { kind: 'buttonbox', children: convertChildren(raw.buttonbox) };

  if (raw.chatter !== undefined) {
    const attrs = (raw.chatter ?? {}) as Raw;
    return {
      kind: 'chatter',
      reloadOnFollower: boolOf(attrs.reload_on_follower),
      reloadOnPost: boolOf(attrs.reload_on_post),
      reloadOnAttachment: boolOf(attrs.reload_on_attachment),
    };
  }

  if (raw.label !== undefined) {
    const attrs = (raw.label ?? {}) as Raw;
    return {
      kind: 'label',
      for: strOf(attrs.for),
      string: i18nOf(attrs.string),
      class: strOf(attrs.class),
      invisible: condOf(attrs.invisible),
    };
  }

  if (raw.separator !== undefined) {
    const attrs = (raw.separator ?? {}) as Raw;
    return {
      kind: 'separator',
      string: i18nOf(attrs.string),
      class: strOf(attrs.class),
      invisible: condOf(attrs.invisible),
    };
  }

  if (raw.widget !== undefined) {
    const attrs = (raw.widget ?? {}) as Raw;
    return {
      kind: 'widget',
      name: String(attrs.name ?? ''),
      title: i18nOf(attrs.title),
      invisible: condOf(attrs.invisible),
      class: strOf(attrs.class),
      options: tidyExpr(attrs.options),
      attrs: restAttrs(attrs, ['name', 'title', 'invisible', 'class', 'options']),
    };
  }

  if (raw.app !== undefined) {
    const attrs = (raw.app ?? {}) as Raw;
    return {
      kind: 'app',
      name: String(attrs.name ?? ''),
      string: i18nOf(attrs.string) ?? { en: '', ar: '' },
      logo: strOf(attrs.logo),
      children: convertChildren(raw.items),
    };
  }

  if (raw.block !== undefined) {
    const attrs = (raw.block ?? {}) as Raw;
    return {
      kind: 'block',
      name: strOf(attrs.name),
      title: i18nOf(attrs.title),
      invisible: condOf(attrs.invisible),
      children: convertChildren(raw.items),
    };
  }

  if (raw.setting !== undefined) {
    const attrs = (raw.setting ?? {}) as Raw;
    return {
      kind: 'setting',
      id: strOf(attrs.id),
      string: i18nOf(attrs.string),
      help: i18nOf(attrs.help),
      title: i18nOf(attrs.title),
      documentation: strOf(attrs.documentation),
      companyDependent: boolOf(attrs.company_dependent),
      invisible: condOf(attrs.invisible),
      children: convertChildren(raw.items),
    };
  }

  if (raw.create !== undefined) {
    const attrs = (raw.create ?? {}) as Raw;
    return {
      kind: 'create',
      name: strOf(attrs.name),
      string: i18nOf(attrs.string),
      context: tidyExpr(attrs.context),
      invisible: condOf(attrs.invisible),
    };
  }

  // Embedded list/kanban/form objects may appear bare inside `items`.
  if (raw.columns !== undefined) {
    return null;
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * View archs
 * ------------------------------------------------------------------ */

function toolbarOf(raw: unknown): ViewToolbar {
  const source = (raw ?? {}) as { print?: string[]; action?: string[] };
  return {
    print: (source.print ?? []).map(splitI18n),
    action: (source.action ?? []).map(splitI18n),
  };
}

function convertForm(raw: Raw): FormArch {
  const attrs = (raw.attrs ?? {}) as Raw;
  return {
    type: 'form',
    string: i18nOf(attrs.string),
    jsClass: strOf(attrs.js_class),
    class: strOf(attrs.class),
    create: condOf(attrs.create),
    edit: condOf(attrs.edit),
    delete: condOf(attrs.delete),
    duplicate: condOf(attrs.duplicate),
    disableAutofocus: boolOf(attrs.disable_autofocus),
    body: convertChildren(raw.body),
    attrs: restAttrs(attrs, ['string', 'js_class', 'class', 'create', 'edit', 'delete', 'duplicate', 'disable_autofocus']),
  };
}

function convertListColumn(raw: Raw): ListColumn | ButtonNode {
  if (raw.btn) return convertButton(raw.btn as Raw);
  return convertField(raw) as ListColumn;
}

function convertGroupByHeaders(raw: unknown): ListGroupByHeader[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const item = entry as Raw;
    const buttons = convertChildren(item.items).filter(
      (node): node is ButtonNode => node.kind === 'button',
    );
    return { name: String(item.name), buttons };
  });
}

function convertList(raw: Raw): ListArch {
  const attrs = (raw.attrs ?? {}) as Raw;
  const editable = strOf(attrs.editable);
  return {
    type: 'list',
    string: i18nOf(attrs.string),
    jsClass: strOf(attrs.js_class),
    class: strOf(attrs.class),
    editable: editable === 'top' || editable === 'bottom' ? editable : undefined,
    multiEdit: boolOf(attrs.multi_edit),
    sample: boolOf(attrs.sample),
    expand: boolOf(attrs.expand),
    create: condOf(attrs.create),
    edit: condOf(attrs.edit),
    delete: condOf(attrs.delete),
    duplicate: condOf(attrs.duplicate),
    openFormView: boolOf(attrs.open_form_view),
    defaultOrder: strOf(attrs.default_order),
    limit: numOf(attrs.limit),
    decorations: decorationsOf(attrs),
    columns: ((raw.columns ?? []) as Raw[]).map(convertListColumn),
    headerButtons: ((raw.header_buttons ?? []) as Raw[]).map(convertButton),
    groupby: convertGroupByHeaders(raw.groupby),
    control: convertChildren(raw.control),
    attrs: restAttrs(attrs, [
      'string', 'js_class', 'class', 'editable', 'multi_edit', 'sample', 'expand',
      'create', 'edit', 'delete', 'duplicate', 'open_form_view', 'default_order', 'limit',
    ]),
  };
}

function convertKanbanButton(raw: Raw): KanbanButton {
  return {
    name: strOf(raw.name),
    type: strOf(raw.type),
    string: i18nOf(raw.string),
    class: strOf(raw.cls ?? raw.class),
    title: i18nOf(raw.title),
    attrs: restAttrs(raw, ['name', 'type', 'string', 'cls', 'class', 'title']),
  };
}

function convertKanbanTemplate(raw: Raw): KanbanTemplateSummary {
  const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);
  return {
    fields: list(raw.fields),
    widgets: list(raw.widgets),
    widgetsT: list(raw.widgetsT),
    buttons: ((raw.buttons ?? []) as Raw[]).map(convertKanbanButton),
    icons: list(raw.icons),
    texts: list(raw.texts).map(splitI18n),
    classes: list(raw.classes),
    logic: list(raw.logic),
    size: numOf(raw.size) ?? 0,
  };
}

function convertKanban(raw: Raw): KanbanArch {
  const attrs = (raw.attrs ?? {}) as Raw;
  const templates: Record<string, KanbanTemplateSummary> = {};
  for (const [name, template] of Object.entries((raw.templates ?? {}) as Raw)) {
    if (template && typeof template === 'object') {
      templates[name] = convertKanbanTemplate(template as Raw);
    }
  }
  const progress = raw.progressbar as Raw | null;
  return {
    type: 'kanban',
    class: strOf(attrs.class),
    jsClass: strOf(attrs.js_class),
    sample: boolOf(attrs.sample),
    create: condOf(attrs.create),
    edit: condOf(attrs.edit),
    delete: condOf(attrs.delete),
    canOpen: condOf(attrs.can_open),
    action: strOf(attrs.action),
    actionType: strOf(attrs.type),
    defaultOrder: strOf(attrs.default_order),
    defaultGroupBy: strOf(attrs.default_group_by),
    highlightColor: strOf(attrs.highlight_color),
    groupCreate: condOf(attrs.group_create),
    groupEdit: condOf(attrs.group_edit),
    groupDelete: condOf(attrs.group_delete),
    onCreate: strOf(attrs.on_create),
    quickCreate: condOf(attrs.quick_create),
    quickCreateView: strOf(attrs.quick_create_view),
    fields: ((raw.fields ?? []) as Raw[]).map(convertField),
    progressbar: progress
      ? { field: String(progress.field), colors: String(progress.colors ?? '{}'), sumField: strOf(progress.sum_field) }
      : undefined,
    templates,
    headerButtons: ((raw.header_buttons ?? []) as Raw[]).map(convertButton),
    attrs: restAttrs(attrs, [
      'class', 'js_class', 'sample', 'create', 'edit', 'delete', 'can_open', 'action', 'type',
      'default_order', 'default_group_by', 'highlight_color', 'group_create', 'group_edit',
      'group_delete', 'on_create', 'quick_create', 'quick_create_view',
    ]),
  };
}

function convertSearchField(raw: Raw): SearchField {
  return {
    name: String(raw.name),
    string: i18nOf(raw.string),
    filterDomain: tidyExpr(raw.filter_domain),
    operator: strOf(raw.operator),
    domain: tidyExpr(raw.domain),
    context: tidyExpr(raw.context),
    hidden: raw.hidden ? true : undefined,
    invisible: condOf(raw.invisible),
  };
}

function convertSearchFilter(raw: Raw): SearchFilter | SearchSeparator {
  if (raw.sep) return { separator: true };
  return {
    name: String(raw.name),
    string: i18nOf(raw.string),
    domain: tidyExpr(raw.domain),
    help: i18nOf(raw.help),
    invisible: condOf(raw.invisible),
    date: strOf(raw.date),
    defaultPeriod: strOf(raw.default_period),
    context: tidyExpr(raw.context),
  };
}

function convertSearchGroupBy(raw: Raw): SearchGroupBy {
  return {
    name: String(raw.name),
    string: i18nOf(raw.string),
    context: tidyExpr(raw.context) ?? '{}',
    domain: tidyExpr(raw.domain),
    invisible: condOf(raw.invisible),
  };
}

function convertSearchPanel(raw: Raw | null): SearchPanel | undefined {
  if (!raw) return undefined;
  const attrs = (raw.attrs ?? {}) as Raw;
  const fields: SearchPanelField[] = ((raw.fields ?? []) as Raw[]).map((field) => ({
    name: String(field.name),
    string: i18nOf(field.string),
    expand: boolOf(field.expand),
    enableCounters: boolOf(field.enable_counters),
    select: strOf(field.select),
    icon: strOf(field.icon),
    color: strOf(field.color),
    groupby: strOf(field.groupby),
    limit: numOf(field.limit),
    hierarchize: boolOf(field.hierarchize),
    attrs: restAttrs(field, ['name', 'string', 'expand', 'enable_counters', 'select', 'icon', 'color', 'groupby', 'limit', 'hierarchize']),
  }));
  return {
    class: strOf(attrs.class),
    fields,
    attrs: restAttrs(attrs, ['class']),
  };
}

function convertSearch(raw: Raw): SearchArch {
  return {
    type: 'search',
    fields: ((raw.fields ?? []) as Raw[]).map(convertSearchField),
    filters: ((raw.filters ?? []) as Raw[]).map(convertSearchFilter),
    groupbys: ((raw.groupbys ?? []) as Raw[]).map(convertSearchGroupBy),
    searchpanel: convertSearchPanel((raw.searchpanel ?? null) as Raw | null),
    savedFilters: Array.isArray(raw.saved_filters) ? raw.saved_filters.map(String) : [],
    attrs: {},
  };
}

function convertCalendar(raw: Raw): CalendarArch {
  const attrs = (raw.attrs ?? {}) as Raw;
  return {
    type: 'calendar',
    string: i18nOf(attrs.string),
    jsClass: strOf(attrs.js_class),
    dateStart: String(attrs.date_start ?? ''),
    dateStop: strOf(attrs.date_stop),
    dateDelay: strOf(attrs.date_delay),
    allDay: strOf(attrs.all_day),
    color: strOf(attrs.color),
    mode: strOf(attrs.mode),
    quickCreate: condOf(attrs.quick_create),
    quickCreateViewId: strOf(attrs.quick_create_view_id),
    eventOpenPopup: condOf(attrs.event_open_popup),
    eventLimit: numOf(attrs.event_limit),
    showUnusualDays: boolOf(attrs.show_unusual_days),
    formViewId: strOf(attrs.form_view_id),
    scales: strOf(attrs.scales),
    fields: ((raw.fields ?? []) as Raw[]).map(convertField),
    attrs: restAttrs(attrs, [
      'string', 'js_class', 'date_start', 'date_stop', 'date_delay', 'all_day', 'color', 'mode',
      'quick_create', 'quick_create_view_id', 'event_open_popup', 'event_limit',
      'show_unusual_days', 'form_view_id', 'scales',
    ]),
  };
}

function convertPivotField(raw: Raw): PivotField {
  return {
    name: String(raw.name),
    type: strOf(raw.type),
    interval: strOf(raw.interval),
    string: i18nOf(raw.string),
    widget: strOf(raw.widget),
    invisible: condOf(raw.invisible),
  };
}

function convertPivot(raw: Raw): PivotArch {
  const attrs = (raw.attrs ?? {}) as Raw;
  return {
    type: 'pivot',
    string: i18nOf(attrs.string),
    jsClass: strOf(attrs.js_class),
    sample: boolOf(attrs.sample),
    disableLinking: boolOf(attrs.disable_linking),
    defaultOrder: strOf(attrs.default_order),
    fields: ((raw.fields ?? []) as Raw[]).map(convertPivotField),
    attrs: restAttrs(attrs, ['string', 'js_class', 'sample', 'disable_linking', 'default_order']),
  };
}

function convertGraph(raw: Raw): GraphArch {
  const attrs = (raw.attrs ?? {}) as Raw;
  const chartType = strOf(attrs.type);
  return {
    type: 'graph',
    string: i18nOf(attrs.string),
    jsClass: strOf(attrs.js_class),
    sample: boolOf(attrs.sample),
    chartType: chartType === 'bar' || chartType === 'line' || chartType === 'pie' ? chartType : undefined,
    stacked: boolOf(attrs.stacked),
    order: strOf(attrs.order),
    disableLinking: boolOf(attrs.disable_linking),
    fields: ((raw.fields ?? []) as Raw[]).map(convertPivotField),
    attrs: restAttrs(attrs, ['string', 'js_class', 'sample', 'type', 'stacked', 'order', 'disable_linking']),
  };
}

function convertGantt(raw: Raw): GanttArch {
  const attrs = (raw.attrs ?? {}) as Raw;
  return {
    type: 'gantt',
    string: i18nOf(attrs.string),
    jsClass: strOf(attrs.js_class),
    sample: boolOf(attrs.sample),
    dateStart: String(attrs.date_start ?? ''),
    dateStop: String(attrs.date_stop ?? ''),
    defaultScale: strOf(attrs.default_scale),
    scales: strOf(attrs.scales),
    color: strOf(attrs.color),
    defaultGroupBy: strOf(attrs.default_group_by),
    displayUnavailability: boolOf(attrs.display_unavailability),
    totalRow: boolOf(attrs.total_row),
    precision: strOf(attrs.precision),
    plan: condOf(attrs.plan),
    formViewId: strOf(attrs.form_view_id),
    pillLabel: boolOf(attrs.pill_label),
    progress: strOf(attrs.progress),
    dependencyField: strOf(attrs.dependency_field),
    consolidation: strOf(attrs.consolidation),
    decorations: decorationsOf(attrs),
    fields: ((raw.fields ?? []) as Raw[]).map(convertField),
    templates: Array.isArray(raw.templates) ? raw.templates.map(String) : [],
    popoverFields: Array.isArray(raw.popover_fields) ? raw.popover_fields.map(String) : [],
    attrs: restAttrs(attrs, [
      'string', 'js_class', 'sample', 'date_start', 'date_stop', 'default_scale', 'scales',
      'color', 'default_group_by', 'display_unavailability', 'total_row', 'precision', 'plan',
      'form_view_id', 'pill_label', 'progress', 'dependency_field', 'consolidation',
    ]),
  };
}

function convertActivity(raw: Raw): ActivityArch {
  const attrs = (raw.attrs ?? {}) as Raw;
  return {
    type: 'activity',
    string: i18nOf(attrs.string),
    jsClass: strOf(attrs.js_class),
    fields: ((raw.fields ?? []) as Raw[]).map(convertField),
    templates: raw.templates ?? [],
    attrs: restAttrs(attrs, ['string', 'js_class']),
  };
}

function convertGrid(raw: Raw): GridArch {
  const attrs = (raw.attrs ?? {}) as Raw;
  return {
    type: 'grid',
    string: i18nOf(attrs.string),
    jsClass: strOf(attrs.js_class),
    edit: condOf(attrs.edit),
    fields: ((raw.fields ?? []) as Raw[]).map(convertPivotField),
    ranges: ((raw.ranges ?? []) as Raw[]).map((range) => ({
      name: String(range.name),
      string: i18nOf(range.string),
      span: String(range.span ?? ''),
      step: String(range.step ?? ''),
    })),
    attrs: restAttrs(attrs, ['string', 'js_class', 'edit']),
  };
}

function convertMap(raw: Raw): MapArch {
  const attrs = (raw.attrs ?? {}) as Raw;
  return {
    type: 'map',
    string: i18nOf(attrs.string),
    jsClass: strOf(attrs.js_class),
    resPartner: strOf(attrs.res_partner),
    routing: boolOf(attrs.routing),
    fields: ((raw.fields ?? []) as Raw[]).map(convertField),
    attrs: restAttrs(attrs, ['string', 'js_class', 'res_partner', 'routing']),
  };
}

function convertHierarchy(raw: Raw): HierarchyArch {
  const attrs = (raw.attrs ?? {}) as Raw;
  return {
    type: 'hierarchy',
    string: i18nOf(attrs.string),
    jsClass: strOf(attrs.js_class),
    childField: strOf(attrs.child_field),
    parentField: strOf(attrs.parent_field),
    draggable: boolOf(attrs.draggable),
    fields: ((raw.fields ?? []) as Raw[]).map(convertField),
    attrs: restAttrs(attrs, ['string', 'js_class', 'child_field', 'parent_field', 'draggable']),
  };
}

function convertCohort(raw: Raw): CohortArch {
  const attrs = (raw.attrs ?? {}) as Raw;
  return {
    type: 'cohort',
    string: i18nOf(attrs.string),
    jsClass: strOf(attrs.js_class),
    sample: boolOf(attrs.sample),
    dateStart: String(attrs.date_start ?? ''),
    dateStop: String(attrs.date_stop ?? ''),
    interval: strOf(attrs.interval),
    mode: strOf(attrs.mode),
    timeline: strOf(attrs.timeline),
    measure: strOf(attrs.measure),
    fields: ((raw.fields ?? []) as Raw[]).map(convertField),
    attrs: restAttrs(attrs, ['string', 'js_class', 'sample', 'date_start', 'date_stop', 'interval', 'mode', 'timeline', 'measure']),
  };
}

export function convertArch(type: ViewType, raw: Raw): ViewArch {
  switch (type) {
    case 'form': return convertForm(raw);
    case 'list': return convertList(raw);
    case 'kanban': return convertKanban(raw);
    case 'search': return convertSearch(raw);
    case 'calendar': return convertCalendar(raw);
    case 'pivot': return convertPivot(raw);
    case 'graph': return convertGraph(raw);
    case 'gantt': return convertGantt(raw);
    case 'activity': return convertActivity(raw);
    case 'grid': return convertGrid(raw);
    case 'map': return convertMap(raw);
    case 'hierarchy': return convertHierarchy(raw);
    case 'cohort': return convertCohort(raw);
  }
}

function convertEmbeddedViews(raw: Raw): FieldNode['views'] {
  const out: FieldNode['views'] = {};
  for (const [type, view] of Object.entries(raw)) {
    if (type === 'list' || type === 'kanban' || type === 'form') {
      out[type] = convertArch(type, view as Raw);
    }
  }
  return out;
}

const VIEW_TYPES: ViewType[] = [
  'list', 'form', 'kanban', 'search', 'calendar', 'pivot', 'graph',
  'gantt', 'activity', 'map', 'cohort', 'grid', 'hierarchy',
];

export function convertView(key: string, raw: Raw): ViewDef {
  const [model, typeText, idText] = key.split('|');
  const type = typeText as ViewType;
  if (!VIEW_TYPES.includes(type)) {
    throw new Error(`Unknown view type ${typeText} in ${key}`);
  }
  return {
    key,
    id: idText === 'false' ? null : Number(idText),
    model,
    type,
    xmlId: strOf(raw.source),
    arch: convertArch(type, raw),
    toolbar: toolbarOf(raw.toolbar),
  };
}

/* ------------------------------------------------------------------ *
 * Models
 * ------------------------------------------------------------------ */

const FIELD_TYPES = new Set<FieldType>([
  'char', 'text', 'html', 'integer', 'float', 'monetary', 'boolean', 'date', 'datetime',
  'selection', 'many2one', 'one2many', 'many2many', 'binary', 'image', 'reference',
  'many2one_reference', 'json', 'properties', 'properties_definition',
]);

function convertSelection(values: string[]): SelectionOption[] {
  return values.map((entry) => {
    const index = entry.indexOf('=');
    const value = index === -1 ? entry : entry.slice(0, index);
    const label = index === -1 ? entry : entry.slice(index + 1);
    return { value, label: splitI18n(label) };
  });
}

export function tableNameOf(model: string): string {
  return model.replace(/\./g, '_');
}


function convertFieldDef(name: string, raw: RawField): FieldDef {
  const type = FIELD_TYPES.has(raw.t as FieldType) ? (raw.t as FieldType) : 'char';
  const field: FieldDef = {
    name,
    type,
    label: { en: raw.s, ar: raw.ar ?? raw.s },
  };
  if (raw.help) field.help = { en: raw.help, ar: raw.help };
  if (raw.req) field.required = true;
  if (raw.ro) field.readonly = true;
  if (raw.rel) field.relation = raw.rel;
  if (raw.sel) field.selection = convertSelection(raw.sel);
  // Binary payloads live in S3; every image is a binary in the export.
  if (type === 'binary' || type === 'image') field.attachment = true;
  // Monetary fields render with the record's currency unless told otherwise.
  if (type === 'monetary') field.currencyField = 'currency_id';
  return field;
}

/**
 * The export does not carry one2many inverses or many2many relation tables.
 * The inverse is the comodel's many2one back to this model; when several
 * candidates exist the conventional `<model>_id` name wins, then the first.
 */
function inferInverse(
  model: string,
  field: FieldDef,
  models: Record<string, ModelDef>,
): string | undefined {
  if (!field.relation) return undefined;
  const comodel = models[field.relation];
  if (!comodel) return undefined;

  const candidates = Object.values(comodel.fields).filter(
    (candidate) => candidate.type === 'many2one' && candidate.relation === model,
  );
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0].name;

  const conventional = `${model.split('.').pop()}_id`;
  const byConvention = candidates.find((candidate) => candidate.name === conventional);
  if (byConvention) return byConvention.name;

  // Prefer a required link: that is almost always the owning relation.
  const required = candidates.find((candidate) => candidate.required === true);
  return (required ?? candidates[0]).name;
}

/**
 * many2many fields that are the two ends of ONE relation. Odoo stores each
 * pair in a single table; without the export naming those tables, the pairs
 * are declared here so both sides read and write the same rows.
 */
const M2M_PAIRS: [string, string][] = [
  ['res.users.group_ids', 'res.groups.user_ids'],
  ['product.template.product_tag_ids', 'product.tag.product_template_ids'],
  ['project.project.type_ids', 'project.task.type.project_ids'],
  ['res.country.country_group_ids', 'res.country.group.country_ids'],
  ['helpdesk.team.stage_ids', 'helpdesk.stage.team_ids'],
  ['res.partner.category_id', 'res.partner.category.partner_ids'],
  ['hr.employee.category_ids', 'hr.employee.category.employee_ids'],
  ['res.users.company_ids', 'res.company.user_ids'],
  ['account.journal.journal_group_ids', 'account.journal.group.excluded_journal_ids'],
  ['sale.order.template.line.product_document_ids', 'product.document.sale_order_template_line_ids'],
];

function m2mTableFor(model: string, field: FieldDef): Pick<FieldDef, 'm2mTable' | 'm2mColumn1' | 'm2mColumn2'> {
  const left = tableNameOf(model);
  const right = tableNameOf(field.relation ?? 'unknown');
  return {
    m2mTable: pgIdentifier(`${left}_${field.name}_rel`),
    m2mColumn1: `${left}_id`,
    // Self-referencing relations need distinct column names.
    m2mColumn2: left === right ? `${right}_other_id` : `${right}_id`,
  };
}

/**
 * Models the export references but never captured (their fields appeared in
 * no view), plus infrastructure models the ORM needs. Same raw format.
 */
export interface ExtraModels {
  model_names: Record<string, { name: string; transient: boolean }>;
  models: Record<string, Record<string, RawField>>;
}

export function convertModels(spec: RawSpec, extra?: ExtraModels): Record<string, ModelDef> {
  const models: Record<string, ModelDef> = {};

  // 21 models appear in both lists; union their fields (main capture wins).
  // Extra definitions fill gaps only: a captured field is never overridden.
  const sources: Record<string, Record<string, RawField>> = {};
  for (const [name, fields] of Object.entries(extra?.models ?? {})) sources[name] = { ...fields };
  for (const [name, fields] of Object.entries(spec.submodels)) {
    sources[name] = { ...(sources[name] ?? {}), ...fields };
  }
  for (const [name, fields] of Object.entries(spec.models)) {
    sources[name] = { ...(sources[name] ?? {}), ...fields };
  }
  const modelNames = { ...(extra?.model_names ?? {}), ...spec.model_names };

  for (const [name, fields] of Object.entries(sources)) {
    const meta = modelNames[name];
    const description = meta ? splitI18n(meta.name) : { en: name, ar: name };
    const converted: Record<string, FieldDef> = {};
    for (const [fieldName, raw] of Object.entries(fields)) {
      converted[fieldName] = convertFieldDef(fieldName, raw);
    }
    models[name] = {
      name,
      description,
      table: tableNameOf(name),
      recName: converted.name ? 'name' : (converted.display_name ? 'display_name' : 'id'),
      order: 'id',
      fields: converted,
      access: [],
      transient: meta?.transient ?? false,
    };
  }

  // Second pass: relational metadata that needs every model in place.
  for (const [name, model] of Object.entries(models)) {
    for (const field of Object.values(model.fields)) {
      if (field.type === 'one2many') {
        field.inverse = inferInverse(name, field, models) ?? synthesizeInverse(name, model, field, models);
        // A required back-reference means the line belongs to its parent and
        // goes with it (Odoo declares these ondelete='cascade').
        const inverse = field.relation && field.inverse ? models[field.relation]?.fields[field.inverse] : undefined;
        if (inverse && inverse.type === 'many2one' && inverse.required === true && !inverse.ondelete) {
          inverse.ondelete = 'cascade';
        }
      } else if (field.type === 'many2many') {
        Object.assign(field, m2mTableFor(name, field));
      }
    }
  }

  // Third pass: the declared symmetric pairs share one relation table.
  for (const [left, right] of M2M_PAIRS) {
    const [leftModel, leftField] = splitFieldRef(left);
    const [rightModel, rightField] = splitFieldRef(right);
    const a = models[leftModel]?.fields[leftField];
    const b = models[rightModel]?.fields[rightField];
    if (!a || !b || a.type !== 'many2many' || b.type !== 'many2many') continue;
    b.m2mTable = a.m2mTable;
    b.m2mColumn1 = a.m2mColumn2;
    b.m2mColumn2 = a.m2mColumn1;
  }

  return models;
}

/** `sale.order.line.product_id` → [`sale.order.line`, `product_id`]. */
function splitFieldRef(ref: string): [string, string] {
  const index = ref.lastIndexOf('.');
  return [ref.slice(0, index), ref.slice(index + 1)];
}

/**
 * The export only captured fields that appear in some view, so a comodel is
 * often missing the many2one that points back at its parent. The ORM still
 * needs that column, so it is added here:
 *
 *  - a polymorphic comodel (`res_model` + `res_id`, e.g. mail.activity) links
 *    through `res_id`, exactly as Odoo does;
 *  - otherwise a `<parent_table>_id` many2one is created on the comodel and
 *    flagged `inferred`, so nothing downstream mistakes it for a captured
 *    field with a known label.
 */
function synthesizeInverse(
  model: string,
  parent: ModelDef,
  field: FieldDef,
  models: Record<string, ModelDef>,
): string | undefined {
  if (!field.relation) return undefined;
  const comodel = models[field.relation];
  if (!comodel) return undefined;

  if (comodel.fields.res_model && comodel.fields.res_id) return 'res_id';

  const inverseName = `${tableNameOf(model)}_id`;
  if (!comodel.fields[inverseName]) {
    comodel.fields[inverseName] = {
      name: inverseName,
      type: 'many2one',
      relation: model,
      label: parent.description,
      ondelete: 'cascade',
      inferred: true,
    };
  }
  return inverseName;
}

/* ------------------------------------------------------------------ *
 * Actions, menus, groups, reports, icons
 * ------------------------------------------------------------------ */

const ACTION_TYPES: Record<string, ActionType> = {
  act_window: 'act_window',
  'ir.actions.act_window': 'act_window',
  'ir.actions.client': 'client',
  'ir.actions.server': 'server',
  'ir.actions.report': 'report',
  'ir.actions.act_url': 'url',
};

export function convertActions(spec: RawSpec): Record<string, ActionDef> {
  const out: Record<string, ActionDef> = {};
  for (const [id, raw] of Object.entries(spec.actions)) {
    const meta = spec.actions_meta[id] ?? {};
    const type = ACTION_TYPES[raw.type] ?? 'act_window';
    const views = raw.views ?? [];
    const searchView = views.find((key) => key.split('|')[1] === 'search');
    const target = strOf(raw.target) as ActionTarget | 'self' | undefined;

    const action: ActionDef = {
      id: Number(id),
      xmlId: raw.xml_id,
      type,
      // Action names are English-only in the export; the menu carries Arabic.
      name: splitI18n(raw.name),
      help: raw.help ? splitI18n(raw.help) : undefined,
      path: strOf(raw.path),
      target: target ?? 'current',
      secondary: meta.secondary ? true : undefined,
    };

    if (type === 'act_window') {
      action.model = raw.model;
      action.viewMode = (raw.view_mode ?? '').split(',').map((mode) => mode.trim()).filter(Boolean) as ViewType[];
      action.views = views.filter((key) => key !== searchView);
      action.searchView = searchView;
      action.domain = typeof raw.domain === 'string' ? tidyExpr(raw.domain) : false;
      action.context = tidyExpr(raw.context) ?? '{}';
      action.limit = raw.limit;
      action.toolbar = toolbarOf(raw.toolbar);
      if (meta.search_view_id) action.searchViewId = meta.search_view_id[0];
    }
    if (type === 'client') {
      action.tag = raw.tag;
      action.params = raw.params;
      action.context = tidyExpr(raw.context) ?? '{}';
    }
    if (type === 'url') action.url = raw.url;
    if (type === 'report') action.reportName = raw.xml_id;

    out[id] = action;
  }
  return out;
}

export function convertMenus(spec: RawSpec): { roots: MenuDef[]; index: Record<number, MenuDef> } {
  const index: Record<number, MenuDef> = {};

  const build = (id: number, parentId: number | undefined, sequence: number): MenuDef => {
    const raw = spec.menus_en[String(id)];
    if (!raw) throw new Error(`Menu ${id} referenced but not exported`);
    const menu: MenuDef = {
      id,
      xmlId: raw.xmlid,
      name: { en: raw.name, ar: spec.menus_ar[String(id)] ?? raw.name },
      parentId,
      sequence,
      actionId: raw.action === false ? undefined : raw.action,
      webIcon: parentId === undefined ? raw.icon : undefined,
      children: [],
    };
    index[id] = menu;
    menu.children = raw.children.map((childId, position) => build(childId, id, position));
    return menu;
  };

  const roots = spec.menus_root.map((id, position) => build(id, undefined, position));
  return { roots, index };
}

export function convertGroups(spec: RawSpec): Record<string, GroupDef> {
  const out: Record<string, GroupDef> = {};
  for (const raw of spec.seed['res.groups'] ?? []) {
    const id = Number(raw.id);
    out[String(id)] = {
      id,
      name: { en: String(raw.name), ar: String(raw.name_ar ?? raw.name) },
      fullName: String(raw.full_name ?? raw.name),
      privilege: strOf(raw.privilege_id),
      comment: strOf(raw.comment),
    };
  }
  return out;
}

function convertReports(spec: RawSpec): ReportDef[] {
  return spec.reports.map((raw) => ({
    id: raw.id,
    model: raw.model,
    name: splitI18n(raw.name),
    reportName: raw.report_name,
    type: raw.type,
  }));
}

function convertAccountReports(spec: RawSpec): AccountReportDef[] {
  return spec.account_reports.map((raw) => ({
    id: Number(raw.id),
    name: splitI18n(String(raw.name)),
    filters: Array.isArray(raw.filters) ? raw.filters.map(String) : [],
    defaultPeriod: strOf(raw.default_period),
    columns: Array.isArray(raw.columns) ? raw.columns.map(String) : [],
    lines: ((raw.lines ?? []) as Raw[]).map((line) => ({
      name: { en: String(line.n), ar: String(line.ar ?? line.n) },
      parent: strOf(line.p),
      level: numOf(line.lvl) ?? 0,
    })),
  }));
}

function convertAppIcons(spec: RawSpec): AppIconDef[] {
  return spec.app_icons.map((raw) => ({
    menuId: raw.id,
    name: raw.name,
    icon: raw.icon,
    hasData: raw.hasData,
  }));
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export function loadRegistry(spec: RawSpec, extra?: ExtraModels): Registry {
  const views: Record<string, ViewDef> = {};
  for (const [key, raw] of Object.entries(spec.views)) {
    views[key] = convertView(key, raw);
  }

  const { roots, index } = convertMenus(spec);

  return {
    session: spec.session,
    models: convertModels(spec, extra),
    views,
    actions: convertActions(spec),
    menus: roots,
    menuIndex: index,
    groups: convertGroups(spec),
    reports: convertReports(spec),
    accountReports: convertAccountReports(spec),
    appIcons: convertAppIcons(spec),
    seed: spec.seed,
  };
}

/* ------------------------------------------------------------------ *
 * i18n catalog extraction
 * ------------------------------------------------------------------ */

/**
 * Every `EN ⇔ AR` pair in the export, keyed by the English text exactly like
 * an Odoo PO file, plus the model field labels and selection labels.
 */
export function collectMessages(spec: RawSpec): { en: Record<string, string>; ar: Record<string, string> } {
  const ar: Record<string, string> = {};

  const add = (en: string, arabic: string) => {
    if (!en || en === arabic) return;
    if (!(en in ar)) ar[en] = arabic;
  };

  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.includes(I18N_SEPARATOR)) {
        const { en, ar: arabic } = splitI18n(value);
        add(en, arabic);
      }
      return;
    }
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };

  visit(spec.views);
  visit(spec.reports);
  visit(spec.account_reports);
  visit(spec.model_names);

  for (const [id, menu] of Object.entries(spec.menus_en)) {
    add(menu.name, spec.menus_ar[id] ?? menu.name);
  }

  for (const source of [spec.models, spec.submodels]) {
    for (const fields of Object.values(source)) {
      for (const field of Object.values(fields)) {
        if (field.ar) add(field.s, field.ar);
        for (const entry of field.sel ?? []) {
          const label = entry.slice(entry.indexOf('=') + 1);
          if (label.includes(I18N_SEPARATOR)) {
            const { en, ar: arabic } = splitI18n(label);
            add(en, arabic);
          }
        }
      }
    }
  }

  for (const records of Object.values(spec.seed)) {
    for (const record of records) {
      if (typeof record.name === 'string' && typeof record.name_ar === 'string') {
        add(record.name, record.name_ar);
      }
    }
  }

  const en: Record<string, string> = {};
  for (const key of Object.keys(ar)) en[key] = key;
  return { en, ar };
}
