import type { SearchArch, SearchFilter, SearchGroupBy } from '@engine/registry/arch';
import type { Domain, FieldDef } from '@engine/registry/types';
import type { I18n, Lang } from '@engine/i18n/types';
import { PyDate, applyRelativeDelta, RelativeDelta } from '@engine/expr/pydate';
import { evaluate, makeScope } from '@engine/expr/evaluate';
import { PyDateTime } from '@engine/expr/pydate';

/**
 * Search view state (B-7): facets, date-period filters, saved favorites.
 * Everything here is pure so the container stays thin and the logic can be
 * reasoned about (and serialised into `ir.filters`).
 */

export interface Facet {
  id: string;
  kind: 'filter' | 'groupby' | 'field' | 'date' | 'favorite';
  label: I18n | string;
  values: (I18n | string)[];
  domain?: Domain;
  groupBy?: string;
  /** The filters this facet stands for (a group of them reads as one facet). */
  names?: string[];
}

/** What a favorite stores (JSON in `ir.filters.context`). */
export interface SearchState {
  filters: string[];
  groupbys: string[];
  texts: { label: string; value: string; domain: Domain }[];
  /** filter name → selected period keys (`month:2026-09`, `quarter:2026-3`, `year:2026`). */
  dates: Record<string, string[]>;
}

export const EMPTY_STATE: SearchState = { filters: [], groupbys: [], texts: [], dates: {} };

export interface EvalEnv {
  uid: number;
  companyIds: number[];
  context: Record<string, unknown>;
}

export function safeEval(source: string | undefined | false, env: EvalEnv, extra: Record<string, unknown> = {}): unknown {
  if (!source) return undefined;
  try {
    return evaluate(source, makeScope({ uid: env.uid, allowedCompanyIds: env.companyIds, context: { ...env.context, ...extra }, now: PyDateTime.fromJsUtc(new Date()), strictNames: false, extra }));
  } catch {
    return undefined;
  }
}

export function groupByField(group: SearchGroupBy): string {
  const match = /'group_by'\s*:\s*'([^']+)'/.exec(group.context);
  return match ? match[1] : group.name;
}

const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

export interface PeriodOption {
  key: string;
  label: string;
  from: PyDate;
  to: PyDate;
  group: 'month' | 'quarter' | 'year';
}

/** The period submenu Odoo shows under a date filter: 3 months, 4 quarters, 3 years. */
export function periodOptions(today: PyDate, lang: Lang): PeriodOption[] {
  const months = lang === 'ar_001' ? MONTHS_AR : MONTHS_EN;
  const options: PeriodOption[] = [];
  for (let back = 0; back < 3; back += 1) {
    const start = applyRelativeDelta(new PyDate(today.year, today.month, 1), new RelativeDelta({ months: -back }));
    options.push({ key: `month:${start.year}-${String(start.month).padStart(2, '0')}`, label: `${months[start.month - 1]}`, from: start, to: applyRelativeDelta(start, new RelativeDelta({ months: 1 })), group: 'month' });
  }
  for (let quarter = 4; quarter >= 1; quarter -= 1) {
    const start = new PyDate(today.year, (quarter - 1) * 3 + 1, 1);
    options.push({ key: `quarter:${today.year}-${quarter}`, label: `Q${quarter}`, from: start, to: applyRelativeDelta(start, new RelativeDelta({ months: 3 })), group: 'quarter' });
  }
  for (let back = 0; back < 3; back += 1) {
    const year = today.year - back;
    options.push({ key: `year:${year}`, label: String(year), from: new PyDate(year, 1, 1), to: new PyDate(year + 1, 1, 1), group: 'year' });
  }
  return options;
}

/** Domain for the selected periods of one date filter (OR of ranges). */
export function dateFilterDomain(field: string, keys: string[], options: PeriodOption[]): Domain {
  const ranges = keys.map((key) => options.find((option) => option.key === key)).filter((option): option is PeriodOption => Boolean(option));
  if (ranges.length === 0) return [];
  const leaves: Domain[] = ranges.map((range) => ['&', [field, '>=', range.from.toString()], [field, '<', range.to.toString()]]);
  return [...Array(leaves.length - 1).fill('|'), ...leaves.flat()];
}

/** The filters of a search view, split into the groups its separators make. */
export function filterGroups(search: SearchArch): SearchFilter[][] {
  const groups: SearchFilter[][] = [[]];
  for (const item of search.filters) {
    if ('separator' in item) { groups.push([]); continue; }
    // A date filter is its own question (it has its own facet), so it never
    // joins a group.
    if (item.date) continue;
    groups[groups.length - 1].push(item);
  }
  return groups.filter((group) => group.length);
}

/** `a`, or `a | b | c` — Odoo's prefix form. */
export function orDomains(domains: Domain[]): Domain {
  const real = domains.filter((domain) => domain.length);
  if (real.length <= 1) return real[0] ?? [];
  return [...Array(real.length - 1).fill('|'), ...real.flat()] as Domain;
}

/**
 * What to call a filter or a group by. Odoo's views leave the label off about
 * thirty entries (`<filter name="groupby_category" context="{'group_by':
 * 'category'}"/>`), and Odoo then shows the field's own label — so a technical
 * name never reaches the screen.
 */
export function entryLabel(
  entry: { name?: string; string?: I18n; context?: string; date?: string },
  fields: Record<string, FieldDef> = {},
): I18n | string {
  if (entry.string) return entry.string;
  const grouped = entry.context ? /'group_by'\s*:\s*'([^']+)'/.exec(entry.context)?.[1] : undefined;
  const field = fields[(grouped ?? entry.date ?? '').split(':')[0]];
  if (field?.label) return field.label;
  // Last resort: the name as words, titled the way Odoo labels things, so the
  // Arabic side can translate it like any other label.
  const words = (entry.name ?? '')
    .replace(/^(group_?by_?|group_|filter_)/, '')
    .replace(/_ids?$/, '')
    .replace(/^my(?=[a-z])/, 'my_')
    .split('_')
    .filter(Boolean);
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ') || (entry.name ?? '');
}

/** Rebuild the facet list from a serialisable state and the search arch. */
export function facetsFromState(state: SearchState, search: SearchArch | null, env: EvalEnv, today: PyDate, lang: Lang, fields: Record<string, FieldDef> = {}): Facet[] {
  const facets: Facet[] = [];
  if (!search) return facets;
  const options = periodOptions(today, lang);
  // Odoo reads the filters between two separators as one question: picking
  // Invoices and Receipts asks for either, not for both at once. Each group of
  // chosen filters is therefore one facet, and its domains are OR-ed.
  for (const group of filterGroups(search)) {
    const chosen = group.filter((filter) => state.filters.includes(filter.name));
    if (!chosen.length) continue;
    const domains = chosen.map((filter) => (safeEval(filter.domain, env) as Domain) ?? []).filter((domain) => domain.length);
    facets.push({
      id: `filter:${chosen.map((filter) => filter.name).join('|')}`,
      kind: 'filter',
      label: entryLabel(chosen[0], fields),
      values: chosen.map((filter) => entryLabel(filter, fields)),
      domain: orDomains(domains),
      names: chosen.map((filter) => filter.name),
    });
  }
  for (const [name, keys] of Object.entries(state.dates)) {
    const filter = search.filters.find((item): item is SearchFilter => 'name' in item && item.name === name);
    if (!filter?.date || keys.length === 0) continue;
    facets.push({
      id: `date:${name}`, kind: 'date', label: entryLabel(filter, fields),
      values: keys.map((key) => options.find((option) => option.key === key)?.label ?? key),
      domain: dateFilterDomain(filter.date, keys, options),
    });
  }
  for (const name of state.groupbys) {
    const group = search.groupbys.find((item) => item.name === name);
    if (!group) continue;
    const label = entryLabel(group, fields);
    facets.push({ id: `groupby:${name}`, kind: 'groupby', label, values: [label], groupBy: groupByField(group) });
  }
  state.texts.forEach((text, index) => {
    facets.push({ id: `field:${index}:${text.value}`, kind: 'field', label: text.label, values: [text.value], domain: text.domain });
  });
  return facets;
}

/** Initial state from `search_default_*` context keys. */
export function stateFromContext(context: Record<string, unknown>, search: SearchArch | null): SearchState {
  const state: SearchState = { filters: [], groupbys: [], texts: [], dates: {} };
  if (!search) return state;
  for (const [key, value] of Object.entries(context)) {
    if (!key.startsWith('search_default_') || !value) continue;
    const name = key.slice('search_default_'.length);
    const filter = search.filters.find((item): item is SearchFilter => 'name' in item && item.name === name);
    if (filter?.domain) { state.filters.push(name); continue; }
    if (filter?.date) { state.dates[name] = [`month:${new Date().toISOString().slice(0, 7)}`]; continue; }
    if (search.groupbys.some((item) => item.name === name)) state.groupbys.push(name);
  }
  return state;
}

/** Text typed in the search box → a field facet using the first search field's filter_domain. */
export function textFacetDomain(text: string, search: SearchArch, recName: string, env: EvalEnv): { label: string; domain: Domain } {
  const field = search.fields[0];
  if (field?.filterDomain) {
    const domain = safeEval(field.filterDomain, env, { self: text }) as Domain | undefined;
    if (Array.isArray(domain)) return { label: field.string?.en ?? field.name, domain };
  }
  return { label: field?.string?.en ?? field?.name ?? 'Search', domain: [[field?.name ?? recName, 'ilike', text]] };
}
