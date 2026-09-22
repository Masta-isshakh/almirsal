import type { I18n, I18nHtml } from '../i18n/types.js';
import type { ViewArch, ViewToolbar } from './arch.js';

/* ------------------------------------------------------------------ *
 * Expressions & domains
 * ------------------------------------------------------------------ */

/**
 * A Python-subset source string evaluated against the current record, e.g.
 * `state != 'draft'`, `not partner_id`, `parent.state == 'sale'`,
 * `context.get('hide_pdf_quote_builder')`.
 */
export type Expr = string;

export type DomainOperator =
  | '=' | '!=' | '>' | '>=' | '<' | '<='
  | 'like' | 'ilike' | 'not like' | 'not ilike' | '=like' | '=ilike'
  | 'in' | 'not in'
  | 'child_of' | 'parent_of'
  | 'any' | 'not any';

export type DomainLeaf = [string, DomainOperator, unknown];
export type DomainConnector = '&' | '|' | '!';
export type DomainItem = DomainLeaf | DomainConnector;
/** Odoo polish-notation domain, e.g. ['|', ('a','=',1), ('b','!=',False)]. */
export type Domain = DomainItem[];

/* ------------------------------------------------------------------ *
 * Fields
 * ------------------------------------------------------------------ */

export type FieldType =
  | 'char' | 'text' | 'html'
  | 'integer' | 'float' | 'monetary' | 'boolean'
  | 'date' | 'datetime'
  | 'selection'
  | 'many2one' | 'one2many' | 'many2many'
  | 'binary' | 'image'
  | 'reference' | 'many2one_reference'
  | 'json' | 'properties' | 'properties_definition';

export interface SelectionOption {
  value: string;
  label: I18n;
}

export interface FieldDef {
  name: string;
  type: FieldType;
  label: I18n;
  help?: I18n;
  required?: boolean | Expr;
  readonly?: boolean | Expr;
  /** Target model for relational fields. */
  relation?: string;
  /** For one2many: the many2one field on the comodel pointing back. */
  inverse?: string;
  /** For many2many: relation table and both column names. */
  m2mTable?: string;
  m2mColumn1?: string;
  m2mColumn2?: string;
  selection?: SelectionOption[];
  default?: unknown;
  /** Name of a registered compute function. */
  compute?: string;
  store?: boolean;
  depends?: string[];
  related?: string;
  /** Field holding the res.currency used to render a monetary value. */
  currencyField?: string;
  digits?: [number, number];
  tracking?: boolean | number;
  index?: boolean;
  translate?: boolean;
  companyDependent?: boolean;
  domain?: Domain | Expr;
  groups?: string[];
  copy?: boolean;
  ondelete?: 'cascade' | 'set null' | 'restrict';
  sanitize?: boolean;
  /** binary/image payloads are stored in S3, not in the row. */
  attachment?: boolean;
  /** Models a reference field may point at. */
  referenceModels?: string[];
  /** Sibling char column holding the model name of a many2one_reference. */
  modelField?: string;
  /** properties fields name the parent record that carries the definition. */
  definitionRecordField?: string;
  /**
   * True for columns the loader had to add because the export only captured
   * fields visible in views (e.g. a one2many's back-reference).
   */
  inferred?: boolean;
  /**
   * SQL template of a computed field that has no column: read, searched,
   * grouped and sorted through this expression. Placeholders: `{alias}` (the
   * row's table alias), `{uid}` (the current user id), `{model}` (the model
   * name as a quoted literal). Used for per-user fields such as
   * `my_activity_date_deadline` and `message_is_follower`.
   */
  sqlExpr?: string;
}

/* ------------------------------------------------------------------ *
 * Access control
 * ------------------------------------------------------------------ */

export interface AccessRule {
  /** res.groups xml id, or undefined for "every authenticated user". */
  group?: string;
  read: boolean;
  write: boolean;
  create: boolean;
  unlink: boolean;
}

export interface RecordRule {
  name: string;
  domain: Domain | Expr;
  groups?: string[];
  /** Global rules apply to everyone and are ANDed with group rules. */
  global?: boolean;
  perms: { read: boolean; write: boolean; create: boolean; unlink: boolean };
}

/* ------------------------------------------------------------------ *
 * Methods (business logic invoked by callButton)
 * ------------------------------------------------------------------ */

export interface MethodDef {
  name: string;
  /** Human label, used by the generic "Actions" menu when bound. */
  label?: I18n;
  /** Handler id resolved in the server-side method registry. */
  handler: string;
  /** Guard evaluated server-side before running (raises UserError if false). */
  precondition?: Expr;
  /** Groups allowed to call the method. */
  groups?: string[];
  /** Whether the method may be called on several records at once. */
  multi?: boolean;
}

/* ------------------------------------------------------------------ *
 * Models
 * ------------------------------------------------------------------ */

/** Mixins implemented once in the ORM and reused (A-3). */
export type MixinName =
  | 'mail.thread' | 'mail.activity.mixin' | 'rating.mixin' | 'utm.mixin'
  | 'portal.mixin' | 'image.mixin' | 'avatar.mixin' | 'analytic.mixin'
  | 'sequence.mixin' | 'html.field.history.mixin' | 'resource.mixin';

export interface SqlConstraintDef {
  name: string;
  sql: string;
  message: I18n;
}

export interface ModelDef {
  /** Dotted technical name, e.g. sale.order. */
  name: string;
  description: I18n;
  /** Physical table, e.g. sale_order. */
  table: string;
  /** Field used as display_name. */
  recName: string;
  /** Default ordering, e.g. "date_order desc, id desc". */
  order: string;
  fields: Record<string, FieldDef>;
  inherits?: MixinName[];
  /** _inherits delegation: comodel name -> the many2one field holding it. */
  delegates?: Record<string, string>;
  sqlConstraints?: SqlConstraintDef[];
  access: AccessRule[];
  recordRules?: RecordRule[];
  methods?: Record<string, MethodDef>;
  /** Transient models (wizards) are garbage-collected and have no rules. */
  transient?: boolean;
  /**
   * Reporting models are SQL views over the business tables (Odoo's
   * `_auto = False`): the SELECT that defines the view. Read-only.
   */
  sqlView?: string;
  /** Registered _check_* python-constraint handler ids. */
  constraints?: string[];
}

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */

export type ViewType =
  | 'list' | 'form' | 'kanban' | 'search' | 'calendar' | 'pivot' | 'graph'
  | 'gantt' | 'activity' | 'map' | 'cohort' | 'grid' | 'hierarchy';

export interface ViewDef {
  /** Composite key `model|type|id`, the form actions reference views by. */
  key: string;
  /** Database view id, or null for views the export captured without one. */
  id: number | null;
  model: string;
  type: ViewType;
  /** Technical xml id, when the export names one (`source`). */
  xmlId?: string;
  arch: ViewArch;
  toolbar: ViewToolbar;
  inheritId?: number;
  priority?: number;
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

export type ActionType = 'act_window' | 'client' | 'server' | 'report' | 'url';

export type ActionTarget = 'current' | 'new' | 'fullscreen' | 'main';

export interface ActionDef {
  id: number | string;
  xmlId: string;
  type: ActionType;
  name: I18n;
  model?: string;
  /** Order of the view switcher buttons. */
  viewMode?: ViewType[];
  /** View bindings as composite keys (`model|type|id`), in switcher order. */
  views?: string[];
  /** Search view key, when the action binds one. */
  searchView?: string;
  /** Python source of the action domain, or false. */
  domain?: Expr | false;
  /** Python dict source of the action context. */
  context?: Expr;
  target?: ActionTarget | 'self';
  help?: I18nHtml;
  searchViewId?: number;
  limit?: number;
  /** URL slug, e.g. "orders" -> /odoo/orders. */
  path?: string;
  /** Client action name for type: 'client'. */
  tag?: string;
  params?: unknown;
  url?: string;
  reportName?: string;
  groups?: string[];
  bindingModel?: string;
  bindingType?: 'action' | 'report';
  /** Gear-menu Print / Action entries captured from the live view. */
  toolbar?: ViewToolbar;
  /** True when the action is only reachable from another screen, never a menu. */
  secondary?: boolean;
}

/* ------------------------------------------------------------------ *
 * Menus
 * ------------------------------------------------------------------ */

export interface MenuDef {
  id: number;
  xmlId: string;
  name: I18n;
  parentId?: number;
  sequence: number;
  actionId?: ActionDef['id'];
  groups?: string[];
  /** App icon identifier for root menus (B-5). */
  webIcon?: string;
  children: MenuDef[];
}

/* ------------------------------------------------------------------ *
 * The registry
 * ------------------------------------------------------------------ */

export interface GroupDef {
  id: number;
  name: I18n;
  fullName: string;
  /** The privilege (category) the group belongs to, e.g. "Sales". */
  privilege?: string;
  comment?: string;
}

export interface ReportDef {
  id: number;
  model: string;
  name: I18n;
  reportName: string;
  type: string;
}

export interface AccountReportLine {
  name: I18n;
  parent?: string;
  level: number;
}

export interface AccountReportDef {
  id: number;
  name: I18n;
  filters: string[];
  defaultPeriod?: string;
  columns: string[];
  lines: AccountReportLine[];
}

export interface AppIconDef {
  menuId: number;
  name: string;
  /** `module,path` of the original icon, for the redrawn SVG lookup. */
  icon: string;
  hasData: boolean;
}

export interface SessionInfo {
  version: string;
  db: string;
  langs: string[];
  user: string;
}

export interface Registry {
  session: SessionInfo;
  models: Record<string, ModelDef>;
  views: Record<string, ViewDef>;
  actions: Record<string, ActionDef>;
  /** Root menus (the 22 apps) in home-menu order, each with its subtree. */
  menus: MenuDef[];
  /** Flat index of every menu by id. */
  menuIndex: Record<number, MenuDef>;
  groups: Record<string, GroupDef>;
  reports: ReportDef[];
  accountReports: AccountReportDef[];
  appIcons: AppIconDef[];
  /** Default records per model, exactly as captured (Part I). */
  seed: Record<string, Record<string, unknown>[]>;
}
