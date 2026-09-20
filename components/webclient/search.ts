import type { SearchArch, SearchFilter, SearchGroupBy } from '@engine/registry/arch';
import type { Domain } from '@engine/registry/types';
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

/** Rebuild the facet list from a serialisable state and the search arch. */
export function facetsFromState(state: SearchState, search: SearchArch | null, env: EvalEnv, today: PyDate, lang: Lang): Facet[] {
  const facets: Facet[] = [];
  if (!search) return facets;
  const options = periodOptions(today, lang);
  for (const name of state.filters) {
    const filter = search.filters.find((item): item is SearchFilter => 'name' in item && item.name === name);
    if (!filter) continue;
    facets.push({ id: `filter:${name}`, kind: 'filter', label: filter.string ?? name, values: [filter.string ?? name], domain: (safeEval(filter.domain, env) as Domain) ?? [] });
  }
  for (const [name, keys] of Object.entries(state.dates)) {
    const filter = search.filters.find((item): item is SearchFilter => 'name' in item && item.name === name);
    if (!filter?.date || keys.length === 0) continue;
    facets.push({
      id: `date:${name}`, kind: 'date', label: filter.string ?? name,
      values: keys.map((key) => options.find((option) => option.key === key)?.label ?? key),
      domain: dateFilterDomain(filter.date, keys, options),
    });
  }
  for (const name of state.groupbys) {
    const group = search.groupbys.find((item) => item.name === name);
    if (group) facets.push({ id: `groupby:${name}`, kind: 'groupby', label: group.string ?? name, values: [group.string ?? name], groupBy: groupByField(group) });
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
