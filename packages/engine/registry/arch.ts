import type { I18n } from '../i18n/types.js';
import type { ViewType } from './types.js';

/**
 * Typed view archs.
 *
 * The spec's `ViewNode` (tag/attrs/children) is the generic XML mirror; these
 * are the same trees with the structure the renderers actually need spelled
 * out, so a list renderer reads `arch.columns` instead of filtering children
 * by tag. Every unknown attribute is preserved verbatim in `attrs`.
 *
 * Conventions:
 *  - `Cond` attributes (`invisible`, `readonly`, `required`, ...) are raw
 *    Python expression sources, evaluated with `packages/engine/expr`.
 *  - `I18n` attributes were `EN ⇔ AR` in the export and are split on load.
 *  - `decorations` holds every `decoration-*` attribute keyed by suffix
 *    (`danger`, `bf`, `it`, ...).
 */

export type Cond = string | boolean;

export type Attrs = Record<string, unknown>;

/* ------------------------------------------------------------------ *
 * Form nodes
 * ------------------------------------------------------------------ */

export interface FieldNode {
  kind: 'field';
  name: string;
  widget?: string;
  string?: I18n;
  placeholder?: I18n;
  help?: I18n;
  invisible?: Cond;
  /** `column_invisible` in list columns. */
  columnInvisible?: Cond;
  readonly?: Cond;
  required?: Cond;
  /** The `hidden` flag of the export: a field loaded but never rendered. */
  hidden?: boolean;
  nolabel?: boolean;
  class?: string;
  /** Python dict source, e.g. `{'no_open': True}`. */
  options?: string;
  domain?: string;
  context?: string;
  /** Embedded x2many views. */
  views?: Partial<Record<'list' | 'kanban' | 'form', ViewArch>>;
  /** `mode="list,kanban"` for x2many fields. */
  mode?: string;
  statusbarVisible?: string;
  optional?: 'show' | 'hide';
  /** Aggregate labels for list footers. */
  sum?: I18n;
  avg?: I18n;
  width?: string;
  password?: boolean;
  filename?: string;
  decorations: Record<string, string>;
  attrs: Attrs;
}

export type ButtonType = 'object' | 'action' | 'edit' | 'button' | undefined;

export interface ButtonNode {
  kind: 'button';
  name?: string;
  type: ButtonType;
  string?: I18n;
  class?: string;
  icon?: string;
  invisible?: Cond;
  context?: string;
  confirm?: I18n;
  help?: I18n;
  title?: I18n;
  hotkey?: string;
  /** `special="cancel"` / `special="save"` in wizard footers. */
  special?: string;
  attrs: Attrs;
}

export interface ElementNode {
  kind: 'element';
  tag: string;
  class?: string;
  text?: I18n;
  invisible?: Cond;
  children: FormNode[];
  attrs: Attrs;
}

export interface GroupNode {
  kind: 'group';
  name?: string;
  string?: I18n;
  col?: number;
  colspan?: number;
  class?: string;
  invisible?: Cond;
  children: FormNode[];
}

export interface NotebookNode {
  kind: 'notebook';
  pages: PageNode[];
}

export interface PageNode {
  kind: 'page';
  name?: string;
  string?: I18n;
  invisible?: Cond;
  children: FormNode[];
}

export interface SheetNode { kind: 'sheet'; children: FormNode[] }
export interface HeaderNode { kind: 'header'; children: FormNode[] }
export interface ButtonBoxNode { kind: 'buttonbox'; children: FormNode[] }

export interface ChatterNode {
  kind: 'chatter';
  reloadOnFollower?: boolean;
  reloadOnPost?: boolean;
  reloadOnAttachment?: boolean;
}

export interface LabelNode {
  kind: 'label';
  for?: string;
  string?: I18n;
  class?: string;
  invisible?: Cond;
}

export interface SeparatorNode {
  kind: 'separator';
  string?: I18n;
  class?: string;
  invisible?: Cond;
}

/** `<widget name="web_ribbon"/>` and friends. */
export interface WidgetNode {
  kind: 'widget';
  name: string;
  title?: I18n;
  invisible?: Cond;
  class?: string;
  options?: string;
  attrs: Attrs;
}

/** Settings page containers (`res.config.settings` form). */
export interface SettingsAppNode {
  kind: 'app';
  name: string;
  string: I18n;
  logo?: string;
  children: FormNode[];
}

export interface SettingsBlockNode {
  kind: 'block';
  name?: string;
  title?: I18n;
  invisible?: Cond;
  children: FormNode[];
}

export interface SettingNode {
  kind: 'setting';
  id?: string;
  string?: I18n;
  help?: I18n;
  title?: I18n;
  documentation?: string;
  companyDependent?: boolean;
  invisible?: Cond;
  children: FormNode[];
}

/** `<control><create string="Add a line"/></control>` for x2many lists. */
export interface CreateControlNode {
  kind: 'create';
  name?: string;
  string?: I18n;
  context?: string;
  invisible?: Cond;
}

export type FormNode =
  | FieldNode
  | ButtonNode
  | ElementNode
  | GroupNode
  | NotebookNode
  | PageNode
  | SheetNode
  | HeaderNode
  | ButtonBoxNode
  | ChatterNode
  | LabelNode
  | SeparatorNode
  | WidgetNode
  | SettingsAppNode
  | SettingsBlockNode
  | SettingNode
  | CreateControlNode;

/* ------------------------------------------------------------------ *
 * Per-view archs
 * ------------------------------------------------------------------ */

export interface FormArch {
  type: 'form';
  string?: I18n;
  jsClass?: string;
  class?: string;
  create?: Cond;
  edit?: Cond;
  delete?: Cond;
  duplicate?: Cond;
  disableAutofocus?: boolean;
  body: FormNode[];
  attrs: Attrs;
}

export interface ListColumn extends Omit<FieldNode, 'kind'> {
  kind: 'field';
}

export interface ListGroupByHeader {
  name: string;
  buttons: ButtonNode[];
}

export interface ListArch {
  type: 'list';
  string?: I18n;
  jsClass?: string;
  class?: string;
  editable?: 'top' | 'bottom';
  multiEdit?: boolean;
  sample?: boolean;
  expand?: boolean;
  create?: Cond;
  edit?: Cond;
  delete?: Cond;
  duplicate?: Cond;
  openFormView?: boolean;
  defaultOrder?: string;
  limit?: number;
  decorations: Record<string, string>;
  columns: (ListColumn | ButtonNode)[];
  headerButtons: ButtonNode[];
  /** Buttons rendered in group-header rows, per grouped field. */
  groupby: ListGroupByHeader[];
  /** `<control>` children: `create` buttons and the `delete` element. */
  control: FormNode[];
  attrs: Attrs;
}

/**
 * The export only summarises kanban card templates (fields, widgets, texts,
 * buttons, conditional logic) rather than preserving the QWeb layout, so the
 * renderer composes cards from this summary plus per-model layout rules.
 */
export interface KanbanTemplateSummary {
  fields: string[];
  /** `field:widget` or `field:widget {options}` pairs. */
  widgets: string[];
  widgetsT: string[];
  buttons: KanbanButton[];
  icons: string[];
  texts: I18n[];
  classes: string[];
  /** Conditional-rendering hints such as `set:installed`. */
  logic: string[];
  size: number;
}

export interface KanbanButton {
  name?: string;
  type?: string;
  string?: I18n;
  class?: string;
  title?: I18n;
  attrs: Attrs;
}

export interface KanbanProgressBar {
  field: string;
  /** JSON source mapping values to bootstrap colours. */
  colors: string;
  sumField?: string;
}

export interface KanbanArch {
  type: 'kanban';
  class?: string;
  jsClass?: string;
  sample?: boolean;
  create?: Cond;
  edit?: Cond;
  delete?: Cond;
  canOpen?: Cond;
  /** `action`/`type` for cards that open an action instead of the form. */
  action?: string;
  actionType?: string;
  defaultOrder?: string;
  defaultGroupBy?: string;
  highlightColor?: string;
  groupCreate?: Cond;
  groupEdit?: Cond;
  groupDelete?: Cond;
  onCreate?: string;
  quickCreate?: Cond;
  quickCreateView?: string;
  fields: FieldNode[];
  progressbar?: KanbanProgressBar;
  templates: Record<string, KanbanTemplateSummary>;
  headerButtons: ButtonNode[];
  attrs: Attrs;
}

export interface SearchField {
  name: string;
  string?: I18n;
  filterDomain?: string;
  operator?: string;
  domain?: string;
  context?: string;
  hidden?: boolean;
  invisible?: Cond;
}

export interface SearchFilter {
  name: string;
  string?: I18n;
  domain?: string;
  help?: I18n;
  invisible?: Cond;
  /** Date filter over this field (renders the period submenu). */
  date?: string;
  defaultPeriod?: string;
  context?: string;
}

export type SearchSeparator = { separator: true };

export interface SearchGroupBy {
  name: string;
  string?: I18n;
  /** `{'group_by': 'field'}` source. */
  context: string;
  domain?: string;
  invisible?: Cond;
}

export interface SearchPanelField {
  name: string;
  string?: I18n;
  expand?: boolean;
  enableCounters?: boolean;
  select?: string;
  icon?: string;
  color?: string;
  groupby?: string;
  limit?: number;
  hierarchize?: boolean;
  attrs: Attrs;
}

export interface SearchPanel {
  class?: string;
  fields: SearchPanelField[];
  attrs: Attrs;
}

export interface SearchArch {
  type: 'search';
  fields: SearchField[];
  filters: (SearchFilter | SearchSeparator)[];
  groupbys: SearchGroupBy[];
  searchpanel?: SearchPanel;
  savedFilters: string[];
  attrs: Attrs;
}

export interface CalendarArch {
  type: 'calendar';
  string?: I18n;
  jsClass?: string;
  dateStart: string;
  dateStop?: string;
  dateDelay?: string;
  allDay?: string;
  color?: string;
  mode?: string;
  quickCreate?: Cond;
  quickCreateViewId?: string;
  eventOpenPopup?: Cond;
  eventLimit?: number;
  showUnusualDays?: boolean;
  formViewId?: string;
  scales?: string;
  fields: FieldNode[];
  attrs: Attrs;
}

export interface PivotField {
  name: string;
  /** `row`, `col` or `measure`. */
  type?: string;
  interval?: string;
  string?: I18n;
  widget?: string;
  invisible?: Cond;
}

export interface PivotArch {
  type: 'pivot';
  string?: I18n;
  jsClass?: string;
  sample?: boolean;
  disableLinking?: boolean;
  defaultOrder?: string;
  fields: PivotField[];
  attrs: Attrs;
}

export interface GraphArch {
  type: 'graph';
  string?: I18n;
  jsClass?: string;
  sample?: boolean;
  chartType?: 'bar' | 'line' | 'pie';
  stacked?: boolean;
  order?: string;
  disableLinking?: boolean;
  fields: PivotField[];
  attrs: Attrs;
}

export interface GanttArch {
  type: 'gantt';
  string?: I18n;
  jsClass?: string;
  sample?: boolean;
  dateStart: string;
  dateStop: string;
  defaultScale?: string;
  scales?: string;
  color?: string;
  defaultGroupBy?: string;
  displayUnavailability?: boolean;
  totalRow?: boolean;
  precision?: string;
  plan?: Cond;
  formViewId?: string;
  pillLabel?: boolean;
  progress?: string;
  dependencyField?: string;
  consolidation?: string;
  decorations: Record<string, string>;
  fields: FieldNode[];
  templates: string[];
  popoverFields: string[];
  attrs: Attrs;
}

export interface ActivityArch {
  type: 'activity';
  string?: I18n;
  jsClass?: string;
  fields: FieldNode[];
  templates: unknown;
  attrs: Attrs;
}

export interface GridRange {
  name: string;
  string?: I18n;
  span: string;
  step: string;
}

export interface GridArch {
  type: 'grid';
  string?: I18n;
  jsClass?: string;
  edit?: Cond;
  fields: PivotField[];
  ranges: GridRange[];
  attrs: Attrs;
}

export interface MapArch {
  type: 'map';
  string?: I18n;
  jsClass?: string;
  resPartner?: string;
  routing?: boolean;
  fields: FieldNode[];
  attrs: Attrs;
}

export interface HierarchyArch {
  type: 'hierarchy';
  string?: I18n;
  jsClass?: string;
  childField?: string;
  parentField?: string;
  draggable?: boolean;
  fields: FieldNode[];
  attrs: Attrs;
}

export interface CohortArch {
  type: 'cohort';
  string?: I18n;
  jsClass?: string;
  sample?: boolean;
  dateStart: string;
  dateStop: string;
  interval?: string;
  mode?: string;
  timeline?: string;
  measure?: string;
  fields: FieldNode[];
  attrs: Attrs;
}

export type ViewArch =
  | FormArch
  | ListArch
  | KanbanArch
  | SearchArch
  | CalendarArch
  | PivotArch
  | GraphArch
  | GanttArch
  | ActivityArch
  | GridArch
  | MapArch
  | HierarchyArch
  | CohortArch;

export type ArchOf<T extends ViewType> = Extract<ViewArch, { type: T }>;

/** Entries a view's gear/action menu offers, captured from the live toolbar. */
export interface ViewToolbar {
  print: I18n[];
  action: I18n[];
}
