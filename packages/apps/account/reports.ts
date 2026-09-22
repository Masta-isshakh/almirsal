import type { Environment } from '../../engine/orm/env.js';
import type { Domain } from '../../engine/registry/types.js';
import type { I18n } from '../../engine/i18n/types.js';
import { UserError } from '../../engine/orm/errors.js';

/**
 * Financial reports (C-8.7 / C-13): every `account_report` client action is
 * computed here from `account_move_line` joined to its account, move,
 * journal and partner. Lines follow the C-13 structures (levels, parents,
 * totals); type lines unfold into accounts, ledgers unfold into journal
 * items, and every amount carries the domain of the items behind it so the
 * client can drill down.
 */

export interface ReportOptions {
  reportId: number;
  dateFrom?: string | null;
  dateTo: string;
  /** Include draft entries (Odoo's "Draft Entries" option). */
  includeDraft?: boolean;
  /** Journal ids to restrict to (empty = all). */
  journalIds?: number[];
  /** Partner ids (partner reports). */
  partnerIds?: number[];
  /** Add the previous period as a second column set. */
  comparison?: 'none' | 'previous_period' | 'previous_year';
  unfoldAll?: boolean;
  hideZero?: boolean;
  /** Unfold one line (its id) and return only its children. */
  unfold?: string | null;
  /** Second period for comparisons, computed by the client. */
  compareFrom?: string | null;
  compareTo?: string | null;
}

export interface ReportColumn { label: I18n; type: 'monetary' | 'date' | 'string' | 'integer' | 'percentage'; key?: string }
export interface ReportLine {
  id: string;
  name: I18n;
  level: number;
  parentId?: string;
  values: (number | string | null)[];
  /** Second-period values when a comparison is active. */
  compare?: (number | string | null)[];
  total?: boolean;
  unfoldable?: boolean;
  /** Journal-item domain behind the amount (drill-down). */
  domain?: Domain;
  model?: string;
  resId?: number;
  children?: ReportLine[];
}
export interface ReportResult {
  id: number;
  name: I18n;
  columns: ReportColumn[];
  lines: ReportLine[];
  period: { from: string | null; to: string };
  compare?: { from: string | null; to: string } | null;
  singleDate: boolean;
  note?: I18n;
}

type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const ar = (en: string, arabic: string): I18n => ({ en, ar: arabic });

/** Account types behind each Odoo statement line. */
const ASSET_TYPES: Record<string, string[]> = {
  'Bank and Cash Accounts': ['asset_cash'], Receivables: ['asset_receivable'], 'Current Assets': ['asset_current'], Prepayments: ['asset_prepayments'],
  'Fixed Assets': ['asset_fixed'], 'Non-current Assets': ['asset_non_current'],
};
const LIABILITY_TYPES: Record<string, string[]> = {
  'Current Liabilities': ['liability_current'], 'Credit Card': ['liability_credit_card'], Payables: ['liability_payable'], 'Non-current Liabilities': ['liability_non_current'],
};
const PL_TYPES = ['income', 'income_other', 'expense', 'expense_direct_cost', 'expense_other', 'expense_depreciation'];
const SINGLE_DATE_REPORTS = new Set([4, 8, 9, 10, 17]);

interface Ctx {
  env: Environment;
  options: ReportOptions;
  lang: string;
  fyStart: string;
  registryLines: Map<string, I18n>;
}

function stateClause(alias: string, includeDraft?: boolean): string {
  return includeDraft ? `${alias}.state <> 'cancel'` : `${alias}.state = 'posted'`;
}

/** Fiscal year start for a date, from the company's fiscal year end. */
async function fiscalYearStart(env: Environment, date: string): Promise<string> {
  const company = await env.cr.query<{ d: number | null; m: number | null }>(`SELECT fiscalyear_last_day AS d, fiscalyear_last_month AS m FROM res_company WHERE id = $1`, [env.companyId ?? 1]).catch(() => ({ rows: [] as { d: number | null; m: number | null }[] }));
  const lastDay = Number(company.rows[0]?.d ?? 31) || 31;
  const lastMonth = Number(company.rows[0]?.m ?? 12) || 12;
  const year = Number(date.slice(0, 4));
  const end = new Date(Date.UTC(year, lastMonth - 1, Math.min(lastDay, 28)));
  const fyEndThisYear = new Date(Date.UTC(year, lastMonth, 0)).getTime() >= end.getTime() ? new Date(Date.UTC(year, lastMonth - 1, lastDay)) : end;
  const start = new Date(fyEndThisYear);
  start.setUTCDate(start.getUTCDate() + 1);
  start.setUTCFullYear(start.getUTCFullYear() - 1);
  const iso = start.toISOString().slice(0, 10);
  // If the FY end of `year` is after `date`, the FY started the previous year; else this year.
  return fyEndThisYear.toISOString().slice(0, 10) >= date ? iso : new Date(Date.UTC(year, lastMonth - 1, lastDay) + 86_400_000).toISOString().slice(0, 10);
}

/** Sum of balances per account (or per type) for account types within a date window. */
async function typeBalances(ctx: Ctx, types: string[], from: string | null, to: string, perAccount = false): Promise<Row[]> {
  const { env, options } = ctx;
  const params: unknown[] = [types, to];
  let where = `a.account_type = ANY($1) AND coalesce(l.date, m.date) <= $2::date AND ${stateClause('m', options.includeDraft)}`;
  if (from) { params.push(from); where += ` AND coalesce(l.date, m.date) >= $${params.length}::date`; }
  if (options.journalIds?.length) { params.push(options.journalIds); where += ` AND m.journal_id = ANY($${params.length})`; }
  if (options.partnerIds?.length) { params.push(options.partnerIds); where += ` AND l.partner_id = ANY($${params.length})`; }
  const group = perAccount ? 'a.id, a.code, a.name, a.account_type' : 'a.account_type';
  const select = perAccount ? 'a.id, a.code, a.name, a.account_type' : 'a.account_type';
  const result = await env.cr.query<Row>(
    `SELECT ${select}, coalesce(sum(coalesce(l.balance, coalesce(l.debit, 0) - coalesce(l.credit, 0))), 0)::float8 AS balance,
            coalesce(sum(l.debit), 0)::float8 AS debit, coalesce(sum(l.credit), 0)::float8 AS credit, count(*)::int AS n
     FROM account_move_line l JOIN account_move m ON m.id = l.move_id JOIN account_account a ON a.id = l.account_id
     WHERE ${where} GROUP BY ${group} ORDER BY ${perAccount ? 'a.code' : 'a.account_type'}`, params,
  );
  return result.rows;
}

function itemsDomain(ctx: Ctx, extra: Domain, from: string | null, to: string): Domain {
  const { options } = ctx;
  const domain: Domain = [...extra, ['date', '<=', to], ['parent_state', options.includeDraft ? '!=' : '=', options.includeDraft ? 'cancel' : 'posted']];
  if (from) domain.push(['date', '>=', from]);
  if (options.journalIds?.length) domain.push(['journal_id', 'in', options.journalIds]);
  if (options.partnerIds?.length) domain.push(['partner_id', 'in', options.partnerIds]);
  return domain;
}

/** Statement line over account types, unfolding into accounts. */
async function typeLine(ctx: Ctx, id: string, name: I18n, types: string[], sign: 1 | -1, from: string | null, to: string, level: number, parentId?: string, compare?: { from: string | null; to: string } | null): Promise<ReportLine> {
  const rows = await typeBalances(ctx, types, from, to);
  const value = sign * rows.reduce((s, r) => s + num(r.balance), 0);
  const line: ReportLine = { id, name, level, parentId, values: [value], unfoldable: true, domain: itemsDomain(ctx, [['account_id.account_type', 'in', types]], from, to) };
  if (compare) {
    const before = await typeBalances(ctx, types, compare.from, compare.to);
    line.compare = [sign * before.reduce((s, r) => s + num(r.balance), 0)];
  }
  if (ctx.options.unfoldAll || ctx.options.unfold === id) {
    const accounts = await typeBalances(ctx, types, from, to, true);
    line.children = accounts.map((a) => ({
      id: `${id}:acc:${a.id}`, name: ar(`${a.code} ${a.name}`, `${a.code} ${a.name}`), level: level + 2, parentId: id, values: [sign * num(a.balance)],
      domain: itemsDomain(ctx, [['account_id', '=', Number(a.id)]], from, to), model: 'account.account', resId: Number(a.id),
    }));
  }
  return line;
}

function sumLine(id: string, name: I18n, children: ReportLine[], level: number, parentId?: string, compare = false): ReportLine {
  const values = [children.reduce((s, c) => s + num(c.values[0]), 0)];
  const line: ReportLine = { id, name, level, parentId, values, total: true };
  if (compare) line.compare = [children.reduce((s, c) => s + num(c.compare?.[0]), 0)];
  return line;
}

/** Label from the registry export (Arabic included) or a fallback. */
function label(ctx: Ctx, en: string, arabic?: string): I18n {
  return ctx.registryLines.get(en) ?? ar(en, arabic ?? en);
}

/* ------------------------------------------------------------------ *
 * Reports
 * ------------------------------------------------------------------ */

async function balanceSheet(ctx: Ctx): Promise<ReportLine[]> {
  const to = ctx.options.dateTo;
  const cmp = ctx.options.compareTo ? { from: null, to: ctx.options.compareTo } : null;
  const hasCompare = Boolean(cmp);
  const lines: ReportLine[] = [];
  const currentAssetChildren: ReportLine[] = [];
  for (const [name, types] of Object.entries(ASSET_TYPES).slice(0, 4)) currentAssetChildren.push(await typeLine(ctx, `bs:${name}`, label(ctx, name), types, 1, null, to, 5, 'bs:Current Assets', cmp));
  const currentAssets = sumLine('bs:Current Assets', label(ctx, 'Current Assets'), currentAssetChildren, 3, 'bs:ASSETS', hasCompare);
  const fixed = await typeLine(ctx, 'bs:Fixed Assets', label(ctx, 'Fixed Assets'), ASSET_TYPES['Fixed Assets'], 1, null, to, 3, 'bs:ASSETS', cmp);
  const nonCurrent = await typeLine(ctx, 'bs:Non-current Assets', label(ctx, 'Non-current Assets'), ASSET_TYPES['Non-current Assets'], 1, null, to, 3, 'bs:ASSETS', cmp);
  const assets = sumLine('bs:ASSETS', label(ctx, 'ASSETS'), [currentAssets, fixed, nonCurrent], 0, undefined, hasCompare);
  lines.push(assets, currentAssets, ...currentAssetChildren, fixed, nonCurrent);

  const currentLiabChildren: ReportLine[] = [];
  for (const [name, types] of Object.entries(LIABILITY_TYPES).slice(0, 3)) currentLiabChildren.push(await typeLine(ctx, `bs:L:${name}`, label(ctx, name), types, -1, null, to, 5, 'bs:L:Current Liabilities', cmp));
  const currentLiab = sumLine('bs:L:Current Liabilities', label(ctx, 'Current Liabilities'), currentLiabChildren, 3, 'bs:LIABILITIES', hasCompare);
  const nonCurrentLiab = await typeLine(ctx, 'bs:L:Non-current Liabilities', label(ctx, 'Non-current Liabilities'), LIABILITY_TYPES['Non-current Liabilities'], -1, null, to, 3, 'bs:LIABILITIES', cmp);
  const liabilities = sumLine('bs:LIABILITIES', label(ctx, 'LIABILITIES'), [currentLiab, nonCurrentLiab], 0, undefined, hasCompare);
  lines.push(liabilities, currentLiab, ...currentLiabChildren, nonCurrentLiab);

  const equity = await typeLine(ctx, 'bs:Equity', label(ctx, 'Equity'), ['equity'], -1, null, to, 3, 'bs:EQUITY', cmp);
  const currentYear = await typeLine(ctx, 'bs:Current Year Unallocated Earnings', label(ctx, 'Current Year Unallocated Earnings'), PL_TYPES, -1, ctx.fyStart, to, 5, 'bs:Earnings', cmp ? { from: await fiscalYearStart(ctx.env, cmp.to), to: cmp.to } : null);
  const previousPl = await typeBalances(ctx, PL_TYPES, null, new Date(Date.parse(`${ctx.fyStart}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10));
  const unaffected = await typeBalances(ctx, ['equity_unaffected'], null, to);
  const previous: ReportLine = {
    id: 'bs:Previous Years Earnings', name: label(ctx, 'Previous Years Earnings', 'أرباح السنوات السابقة'), level: 5, parentId: 'bs:Earnings',
    values: [-(previousPl.reduce((s, r) => s + num(r.balance), 0) + unaffected.reduce((s, r) => s + num(r.balance), 0))],
    domain: itemsDomain(ctx, ['|', ['account_id.account_type', '=', 'equity_unaffected'], '&', ['account_id.account_type', 'in', PL_TYPES], ['date', '<', ctx.fyStart]], null, to),
  };
  if (cmp) previous.compare = [previous.values[0]];
  const earnings = sumLine('bs:Earnings', label(ctx, 'Earnings'), [currentYear, previous], 3, 'bs:EQUITY', hasCompare);
  const oci: ReportLine = { id: 'bs:OCI', name: label(ctx, 'Other Comprehensive Income', 'الدخل الشامل الآخر'), level: 3, parentId: 'bs:EQUITY', values: [0], compare: cmp ? [0] : undefined };
  const equityTotal = sumLine('bs:EQUITY', label(ctx, 'EQUITY (& EARNINGS)'), [equity, earnings, oci], 0, undefined, hasCompare);
  lines.push(equityTotal, equity, earnings, currentYear, previous, oci);
  lines.push(sumLine('bs:L+E', label(ctx, 'LIABILITIES + EQUITY'), [liabilities, equityTotal], 0, undefined, hasCompare));
  lines.push(await typeLine(ctx, 'bs:OFF', label(ctx, 'OFF BALANCE SHEET ACCOUNTS'), ['off_balance'], 1, null, to, 0, undefined, cmp));
  return lines;
}

async function profitAndLoss(ctx: Ctx): Promise<ReportLine[]> {
  const { dateFrom, dateTo } = ctx.options;
  const from = dateFrom ?? ctx.fyStart;
  const cmp = ctx.options.compareTo ? { from: ctx.options.compareFrom ?? null, to: ctx.options.compareTo } : null;
  const hasCompare = Boolean(cmp);
  const revenue = await typeLine(ctx, 'pl:Revenue', label(ctx, 'Revenue'), ['income'], -1, from, dateTo, 3, 'pl:Gross Profit', cmp);
  const costs = await typeLine(ctx, 'pl:Costs of Revenue', label(ctx, 'Costs of Revenue'), ['expense_direct_cost'], -1, from, dateTo, 3, 'pl:Gross Profit', cmp);
  const gross = sumLine('pl:Gross Profit', label(ctx, 'Gross Profit'), [revenue, costs], 0, undefined, hasCompare);
  const opex = await typeLine(ctx, 'pl:Operating Expenses', label(ctx, 'Operating Expenses'), ['expense'], -1, from, dateTo, 3, 'pl:Operating Income', cmp);
  const operating = sumLine('pl:Operating Income', label(ctx, 'Operating Income (or Loss)'), [gross, opex], 0, undefined, hasCompare);
  const otherIncome = await typeLine(ctx, 'pl:Other Income', label(ctx, 'Other Income'), ['income_other'], -1, from, dateTo, 3, 'pl:Net Profit', cmp);
  const otherExpenses = await typeLine(ctx, 'pl:Other Expenses', label(ctx, 'Other Expenses'), ['expense_other', 'expense_depreciation'], -1, from, dateTo, 3, 'pl:Net Profit', cmp);
  const net = sumLine('pl:Net Profit', label(ctx, 'Net Profit'), [operating, otherIncome, otherExpenses], 0, undefined, hasCompare);
  const allocations = await typeLine(ctx, 'pl:Allocations', label(ctx, 'Allocations and Withdrawals'), ['equity_unaffected'], -1, from, dateTo, 3, 'pl:Net Left', cmp);
  const left = sumLine('pl:Net Left', label(ctx, 'Net Profit Left After Allocations and Withdrawals'), [net, allocations], 0, undefined, hasCompare);
  return [gross, revenue, costs, operating, opex, net, otherIncome, otherExpenses, left, allocations];
}

async function executiveSummary(ctx: Ctx): Promise<ReportLine[]> {
  const { dateTo } = ctx.options;
  const from = ctx.options.dateFrom ?? ctx.fyStart;
  const cash = await typeBalances(ctx, ['asset_cash'], from, dateTo);
  const received = cash.reduce((s, r) => s + num(r.debit), 0);
  const spent = cash.reduce((s, r) => s + num(r.credit), 0);
  const closing = (await typeBalances(ctx, ['asset_cash'], null, dateTo)).reduce((s, r) => s + num(r.balance), 0);
  const pl = await profitAndLoss(ctx);
  const v = (id: string) => num(pl.find((l) => l.id === id)?.values[0]);
  const revenue = v('pl:Revenue'); const costOfRevenue = v('pl:Costs of Revenue'); const gross = v('pl:Gross Profit');
  const expenses = v('pl:Operating Expenses') + v('pl:Other Expenses'); const net = v('pl:Net Profit');
  const receivables = (await typeBalances(ctx, ['asset_receivable'], null, dateTo)).reduce((s, r) => s + num(r.balance), 0);
  const payables = -(await typeBalances(ctx, ['liability_payable'], null, dateTo)).reduce((s, r) => s + num(r.balance), 0);
  const assets = (await typeBalances(ctx, Object.values(ASSET_TYPES).flat(), null, dateTo)).reduce((s, r) => s + num(r.balance), 0);
  const liabilities = -(await typeBalances(ctx, Object.values(LIABILITY_TYPES).flat(), null, dateTo)).reduce((s, r) => s + num(r.balance), 0);
  const currentAssets = (await typeBalances(ctx, Object.values(ASSET_TYPES).slice(0, 4).flat(), null, dateTo)).reduce((s, r) => s + num(r.balance), 0);
  const currentLiabilities = -(await typeBalances(ctx, Object.values(LIABILITY_TYPES).slice(0, 3).flat(), null, dateTo)).reduce((s, r) => s + num(r.balance), 0);
  const days = Math.max(1, Math.round((Date.parse(dateTo) - Date.parse(from)) / 86_400_000) + 1);
  const purchases = -costOfRevenue - expenses;
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  const L = (id: string, en: string, values: (number | string | null)[], parent?: string, level = 3): ReportLine => ({ id, name: label(ctx, en), level, parentId: parent, values });
  return [
    L('es:Cash', 'Cash', [null], undefined, 0),
    L('es:received', 'Cash received', [received], 'es:Cash'), L('es:spent', 'Cash spent', [-spent], 'es:Cash'), L('es:surplus', 'Cash surplus', [received - spent], 'es:Cash'), L('es:closing', 'Closing bank balance', [closing], 'es:Cash'),
    L('es:Profitability', 'Profitability', [null], undefined, 0),
    L('es:revenue', 'Revenue', [revenue], 'es:Profitability'), L('es:cost', 'Cost of Revenue', [costOfRevenue], 'es:Profitability'), L('es:gross', 'Gross profit', [gross], 'es:Profitability'), L('es:expenses', 'Expenses', [expenses], 'es:Profitability'), L('es:net', 'Net Profit', [net], 'es:Profitability'),
    L('es:BS', 'Balance Sheet', [null], undefined, 0),
    L('es:rec', 'Receivables', [receivables], 'es:BS'), L('es:pay', 'Payables', [payables], 'es:BS'), L('es:netassets', 'Net assets', [assets - liabilities], 'es:BS'),
    L('es:Performance', 'Performance', [null], undefined, 0),
    L('es:gpm', 'Gross profit margin (gross profit / operating income)', [revenue ? pct(gross / revenue) : '0.00%'], 'es:Performance'),
    L('es:npm', 'Net profit margin (net profit / revenue)', [revenue ? pct(net / revenue) : '0.00%'], 'es:Performance'),
    L('es:roi', 'Return on investments (net profit / assets)', [assets ? pct(net / assets) : '0.00%'], 'es:Performance'),
    L('es:Position', 'Position', [null], undefined, 0),
    L('es:debtors', 'Average debtors days', [revenue ? Math.round((receivables / revenue) * days) : 0], 'es:Position'),
    L('es:creditors', 'Average creditors days', [purchases ? Math.round((payables / purchases) * days) : 0], 'es:Position'),
    L('es:forecast', 'Short term cash forecast', [receivables - payables], 'es:Position'),
    L('es:ratio', 'Current assets to liabilities', [currentLiabilities ? Number((currentAssets / currentLiabilities).toFixed(2)) : 0], 'es:Position'),
  ];
}

async function cashFlow(ctx: Ctx): Promise<ReportLine[]> {
  const { dateTo } = ctx.options;
  const from = ctx.options.dateFrom ?? ctx.fyStart;
  const dayBefore = new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const opening = (await typeBalances(ctx, ['asset_cash'], null, dayBefore)).reduce((s, r) => s + num(r.balance), 0);
  const closing = (await typeBalances(ctx, ['asset_cash'], null, dateTo)).reduce((s, r) => s + num(r.balance), 0);
  // Classify cash movements by the counterpart of the same entry.
  const params: unknown[] = [from, dateTo];
  const flows = await ctx.env.cr.query<Row>(
    `SELECT CASE WHEN EXISTS (SELECT 1 FROM account_move_line c JOIN account_account ca ON ca.id = c.account_id WHERE c.move_id = l.move_id AND ca.account_type = 'asset_receivable') THEN 'customers'
                 WHEN EXISTS (SELECT 1 FROM account_move_line c JOIN account_account ca ON ca.id = c.account_id WHERE c.move_id = l.move_id AND ca.account_type = 'liability_payable') THEN 'suppliers'
                 WHEN EXISTS (SELECT 1 FROM account_move_line c JOIN account_account ca ON ca.id = c.account_id WHERE c.move_id = l.move_id AND ca.account_type IN ('asset_fixed', 'asset_non_current')) THEN 'investing'
                 WHEN EXISTS (SELECT 1 FROM account_move_line c JOIN account_account ca ON ca.id = c.account_id WHERE c.move_id = l.move_id AND ca.account_type IN ('equity', 'liability_non_current')) THEN 'financing'
                 ELSE 'unclassified' END AS kind,
            coalesce(sum(l.debit), 0)::float8 AS cash_in, coalesce(sum(l.credit), 0)::float8 AS cash_out
     FROM account_move_line l JOIN account_move m ON m.id = l.move_id JOIN account_account a ON a.id = l.account_id
     WHERE a.account_type = 'asset_cash' AND coalesce(l.date, m.date) BETWEEN $1::date AND $2::date AND ${stateClause('m', ctx.options.includeDraft)}
     GROUP BY 1`, params,
  );
  const get = (kind: string, key: 'cash_in' | 'cash_out') => num(flows.rows.find((r) => r.kind === kind)?.[key]);
  const L = (id: string, en: string, arabic: string, values: (number | null)[], parent?: string, level = 3, total = false): ReportLine => ({ id, name: ar(en, arabic), level, parentId: parent, values, total });
  const operating = get('customers', 'cash_in') - get('suppliers', 'cash_out') + get('customers', 'cash_out') * -1 * 0 - get('suppliers', 'cash_in') * 0;
  const opIn = get('customers', 'cash_in'); const opOut = get('suppliers', 'cash_out'); const opAdvIn = get('suppliers', 'cash_in'); const opAdvOut = get('customers', 'cash_out');
  const inv = get('investing', 'cash_in') - get('investing', 'cash_out');
  const fin = get('financing', 'cash_in') - get('financing', 'cash_out');
  const unc = get('unclassified', 'cash_in') - get('unclassified', 'cash_out');
  void operating;
  return [
    L('cf:open', 'Cash and cash equivalents, beginning of period', 'النقد وما في حكمه، بداية الفترة', [opening], undefined, 0, true),
    L('cf:net', 'Net increase in cash and cash equivalents', 'صافي الزيادة في النقد وما في حكمه', [closing - opening], undefined, 0, true),
    L('cf:op', 'Cash flows from operating activities', 'التدفقات النقدية من الأنشطة التشغيلية', [opIn + opAdvIn - opOut - opAdvOut], undefined, 1),
    L('cf:op:adv', 'Advance Payments received from customers', 'الدفعات المقدمة المستلمة من العملاء', [opAdvIn], 'cf:op'),
    L('cf:op:in', 'Cash received from operating activities', 'النقد المستلم من الأنشطة التشغيلية', [opIn], 'cf:op'),
    L('cf:op:advout', 'Advance payments made to suppliers', 'الدفعات المقدمة المدفوعة للموردين', [-opAdvOut], 'cf:op'),
    L('cf:op:out', 'Cash paid for operating activities', 'النقد المدفوع للأنشطة التشغيلية', [-opOut], 'cf:op'),
    L('cf:inv', 'Cash flows from investing & extraordinary activities', 'التدفقات النقدية من الأنشطة الاستثمارية والاستثنائية', [inv], undefined, 1),
    L('cf:inv:in', 'Cash in', 'النقد الداخل', [get('investing', 'cash_in')], 'cf:inv'), L('cf:inv:out', 'Cash out', 'النقد الخارج', [-get('investing', 'cash_out')], 'cf:inv'),
    L('cf:fin', 'Cash flows from financing activities', 'التدفقات النقدية من الأنشطة التمويلية', [fin], undefined, 1),
    L('cf:fin:in', 'Cash in', 'النقد الداخل', [get('financing', 'cash_in')], 'cf:fin'), L('cf:fin:out', 'Cash out', 'النقد الخارج', [-get('financing', 'cash_out')], 'cf:fin'),
    L('cf:unc', 'Cash flows from unclassified activities', 'التدفقات النقدية من الأنشطة غير المصنفة', [unc], undefined, 1),
    L('cf:unc:in', 'Cash in', 'النقد الداخل', [get('unclassified', 'cash_in')], 'cf:unc'), L('cf:unc:out', 'Cash out', 'النقد الخارج', [-get('unclassified', 'cash_out')], 'cf:unc'),
    L('cf:close', 'Cash and cash equivalents, closing balance', 'النقد وما في حكمه، رصيد الإقفال', [closing], undefined, 0, true),
  ];
}

async function trialBalance(ctx: Ctx): Promise<ReportLine[]> {
  const { dateTo } = ctx.options;
  const from = ctx.options.dateFrom ?? ctx.fyStart;
  const params: unknown[] = [from, dateTo];
  let extra = '';
  if (ctx.options.journalIds?.length) { params.push(ctx.options.journalIds); extra += ` AND m.journal_id = ANY($${params.length})`; }
  const rows = await ctx.env.cr.query<Row>(
    `SELECT a.id, a.code, a.name,
            coalesce(sum(CASE WHEN coalesce(l.date, m.date) < $1::date THEN l.debit END), 0)::float8 AS init_debit,
            coalesce(sum(CASE WHEN coalesce(l.date, m.date) < $1::date THEN l.credit END), 0)::float8 AS init_credit,
            coalesce(sum(CASE WHEN coalesce(l.date, m.date) >= $1::date THEN l.debit END), 0)::float8 AS debit,
            coalesce(sum(CASE WHEN coalesce(l.date, m.date) >= $1::date THEN l.credit END), 0)::float8 AS credit
     FROM account_move_line l JOIN account_move m ON m.id = l.move_id JOIN account_account a ON a.id = l.account_id
     WHERE coalesce(l.date, m.date) <= $2::date AND ${stateClause('m', ctx.options.includeDraft)}${extra}
     GROUP BY a.id, a.code, a.name ORDER BY a.code`, params,
  );
  const lines: ReportLine[] = rows.rows.map((r) => {
    const initial = num(r.init_debit) - num(r.init_credit);
    const end = initial + num(r.debit) - num(r.credit);
    return {
      id: `tb:${r.id}`, name: ar(`${r.code} ${r.name}`, `${r.code} ${r.name}`), level: 1, model: 'account.account', resId: Number(r.id),
      values: [initial > 0 ? initial : 0, initial < 0 ? -initial : 0, num(r.debit), num(r.credit), end > 0 ? end : 0, end < 0 ? -end : 0],
      domain: itemsDomain(ctx, [['account_id', '=', Number(r.id)]], null, dateTo),
    };
  });
  const totals = [0, 1, 2, 3, 4, 5].map((i) => lines.reduce((s, l) => s + num(l.values[i]), 0));
  lines.push({ id: 'tb:total', name: ar('Total', 'الإجمالي'), level: 0, values: totals, total: true });
  return lines;
}

async function ledger(ctx: Ctx, by: 'account' | 'partner' | 'journal'): Promise<ReportLine[]> {
  const { dateTo } = ctx.options;
  const from = ctx.options.dateFrom ?? (by === 'account' ? ctx.fyStart : null);
  const params: unknown[] = [dateTo];
  let where = `coalesce(l.date, m.date) <= $1::date AND ${stateClause('m', ctx.options.includeDraft)}`;
  if (from) { params.push(from); where += ` AND coalesce(l.date, m.date) >= $${params.length}::date`; }
  if (ctx.options.journalIds?.length) { params.push(ctx.options.journalIds); where += ` AND m.journal_id = ANY($${params.length})`; }
  if (ctx.options.partnerIds?.length) { params.push(ctx.options.partnerIds); where += ` AND l.partner_id = ANY($${params.length})`; }
  if (by === 'partner') where += ` AND a.account_type IN ('asset_receivable', 'liability_payable')`;
  const key = by === 'account' ? 'a.id, a.code, a.name' : by === 'partner' ? 'p.id, p.name' : 'j.id, j.code, j.name';
  const join = by === 'partner' ? 'LEFT JOIN res_partner p ON p.id = l.partner_id' : by === 'journal' ? 'JOIN account_journal j ON j.id = m.journal_id' : '';
  const rows = await ctx.env.cr.query<Row>(
    `SELECT ${key} AS id_key, ${by === 'account' ? "a.code || ' ' || a.name" : by === 'partner' ? "coalesce(p.name, '')" : "j.code || ' ' || j.name"} AS name, ${by === 'account' ? 'a.id' : by === 'partner' ? 'p.id' : 'j.id'} AS rid,
            coalesce(sum(l.debit), 0)::float8 AS debit, coalesce(sum(l.credit), 0)::float8 AS credit, count(DISTINCT m.id)::int AS docs, count(*)::int AS n
     FROM account_move_line l JOIN account_move m ON m.id = l.move_id JOIN account_account a ON a.id = l.account_id ${join}
     WHERE ${where} GROUP BY ${key} ORDER BY 2`, params,
  );
  const lines: ReportLine[] = [];
  for (const r of rows.rows) {
    const rid = r.rid === null ? 0 : Number(r.rid);
    const id = `${by}:${rid}`;
    const field = by === 'account' ? 'account_id' : by === 'partner' ? 'partner_id' : 'journal_id';
    const leaf: Domain = rid ? [[field, '=', rid]] : [[field, '=', false]];
    if (by === 'partner') leaf.push(['account_id.account_type', 'in', ['asset_receivable', 'liability_payable']]);
    const line: ReportLine = {
      id, name: ar(String(r.name || (by === 'partner' ? 'Unknown Partner' : '')), String(r.name || (by === 'partner' ? 'شريك غير معروف' : ''))), level: 1, unfoldable: true,
      values: by === 'journal' ? [num(r.docs), 0, num(r.debit), num(r.credit), num(r.debit) - num(r.credit)] : [num(r.debit), num(r.credit), num(r.debit) - num(r.credit)],
      domain: itemsDomain(ctx, leaf, from, dateTo), model: by === 'account' ? 'account.account' : by === 'partner' ? 'res.partner' : 'account.journal', resId: rid || undefined,
    };
    if (ctx.options.unfoldAll || ctx.options.unfold === id) {
      const itemParams: unknown[] = [dateTo];
      let itemWhere = `coalesce(l.date, m.date) <= $1::date AND ${stateClause('m', ctx.options.includeDraft)}`;
      if (from) { itemParams.push(from); itemWhere += ` AND coalesce(l.date, m.date) >= $${itemParams.length}::date`; }
      if (rid) { itemParams.push(rid); itemWhere += ` AND ${by === 'account' ? 'l.account_id' : by === 'partner' ? 'l.partner_id' : 'm.journal_id'} = $${itemParams.length}`; } else itemWhere += ` AND l.partner_id IS NULL`;
      if (by === 'partner') itemWhere += ` AND a.account_type IN ('asset_receivable', 'liability_payable')`;
      const items = await ctx.env.cr.query<Row>(
        `SELECT l.id, coalesce(l.date, m.date) AS date, m.name AS move_name, l.name AS label, j.code AS journal, a.code AS account, p.name AS partner, l.debit::float8 AS debit, l.credit::float8 AS credit, l.date_maturity, l.matching_number
         FROM account_move_line l JOIN account_move m ON m.id = l.move_id JOIN account_account a ON a.id = l.account_id LEFT JOIN account_journal j ON j.id = m.journal_id LEFT JOIN res_partner p ON p.id = l.partner_id
         WHERE ${itemWhere} ORDER BY coalesce(l.date, m.date), l.id LIMIT 500`, itemParams,
      );
      let running = 0;
      line.children = items.rows.map((it) => {
        running += num(it.debit) - num(it.credit);
        const dateText = String(it.date ?? '').slice(0, 10);
        const title = `${dateText} · ${it.move_name ?? ''} · ${it.label ?? ''}`;
        return {
          id: `${id}:item:${it.id}`, name: ar(title, title), level: 3, parentId: id, model: 'account.move.line', resId: Number(it.id),
          values: by === 'journal' ? [String(it.account ?? ''), String(it.partner ?? ''), num(it.debit), num(it.credit), running] : by === 'partner'
            ? [String(it.journal ?? ''), String(it.account ?? ''), dateText, String(it.date_maturity ?? '').slice(0, 10), String(it.matching_number ?? ''), num(it.debit), num(it.credit), running]
            : [String(it.partner ?? ''), num(it.debit), num(it.credit), running],
        };
      });
    }
    lines.push(line);
  }
  const totals = lines.length ? lines[0].values.map((_, i) => (typeof lines[0].values[i] === 'number' ? lines.reduce((s, l) => s + num(l.values[i]), 0) : null)) : [];
  if (lines.length) lines.push({ id: `${by}:total`, name: ar('Total', 'الإجمالي'), level: 0, values: totals, total: true });
  return lines;
}

async function aged(ctx: Ctx, kind: 'receivable' | 'payable'): Promise<ReportLine[]> {
  const { dateTo } = ctx.options;
  const params: unknown[] = [dateTo, kind === 'receivable' ? 'asset_receivable' : 'liability_payable'];
  let extra = '';
  if (ctx.options.partnerIds?.length) { params.push(ctx.options.partnerIds); extra += ` AND l.partner_id = ANY($${params.length})`; }
  const sign = kind === 'receivable' ? 1 : -1;
  const rows = await ctx.env.cr.query<Row>(
    `SELECT p.id AS pid, coalesce(p.name, '') AS partner, l.id, coalesce(l.date, m.date) AS date, coalesce(l.date_maturity, coalesce(l.date, m.date)) AS due, m.name AS move_name, a.code AS account,
            (${sign} * coalesce(l.amount_residual, coalesce(l.balance, coalesce(l.debit, 0) - coalesce(l.credit, 0))))::float8 AS residual
     FROM account_move_line l JOIN account_move m ON m.id = l.move_id JOIN account_account a ON a.id = l.account_id LEFT JOIN res_partner p ON p.id = l.partner_id
     WHERE a.account_type = $2 AND coalesce(l.date, m.date) <= $1::date AND coalesce(l.reconciled, false) = false AND ${stateClause('m', ctx.options.includeDraft)}${extra}
     ORDER BY p.name, coalesce(l.date, m.date)`, params,
  );
  const bucket = (due: string): number => {
    const days = Math.floor((Date.parse(dateTo) - Date.parse(due)) / 86_400_000);
    if (days <= 0) return 0; if (days <= 30) return 1; if (days <= 60) return 2; if (days <= 90) return 3; if (days <= 120) return 4; return 5;
  };
  const byPartner = new Map<number, { name: string; values: number[]; items: Row[] }>();
  for (const r of rows.rows) {
    const residual = num(r.residual);
    if (Math.abs(residual) < 0.005) continue;
    const pid = r.pid === null ? 0 : Number(r.pid);
    const entry = byPartner.get(pid) ?? { name: String(r.partner || (kind === 'receivable' ? 'Unknown Partner' : 'Unknown Partner')), values: [0, 0, 0, 0, 0, 0, 0], items: [] };
    const b = bucket(String(r.due).slice(0, 10));
    entry.values[b] += residual; entry.values[6] += residual; entry.items.push(r);
    byPartner.set(pid, entry);
  }
  const lines: ReportLine[] = [];
  for (const [pid, entry] of byPartner) {
    const id = `aged:${pid}`;
    const line: ReportLine = {
      id, name: ar(entry.name, entry.name), level: 1, unfoldable: true, values: ['', '', '', ...entry.values], model: 'res.partner', resId: pid || undefined,
      domain: itemsDomain(ctx, [['partner_id', pid ? '=' : '=', pid || false], ['account_id.account_type', '=', kind === 'receivable' ? 'asset_receivable' : 'liability_payable'], ['reconciled', '=', false]], null, dateTo),
    };
    if (ctx.options.unfoldAll || ctx.options.unfold === id) {
      line.children = entry.items.map((it) => {
        const values: (number | string)[] = [String(it.date).slice(0, 10), '', String(it.account ?? ''), 0, 0, 0, 0, 0, 0, num(it.residual)];
        values[3 + bucket(String(it.due).slice(0, 10))] = num(it.residual);
        return { id: `${id}:item:${it.id}`, name: ar(String(it.move_name ?? ''), String(it.move_name ?? '')), level: 3, parentId: id, values, model: 'account.move.line', resId: Number(it.id) };
      });
    }
    lines.push(line);
  }
  const totals = [0, 1, 2, 3, 4, 5, 6].map((i) => lines.reduce((s, l) => s + num(l.values[3 + i]), 0));
  lines.push({ id: 'aged:total', name: ar('Total', 'الإجمالي'), level: 0, values: ['', '', '', ...totals], total: true });
  return lines;
}

async function taxReport(ctx: Ctx): Promise<ReportLine[]> {
  const { dateTo } = ctx.options;
  const from = ctx.options.dateFrom ?? ctx.fyStart;
  const rel = ctx.env.registry.models['account.move.line'].fields.tax_ids;
  const params: unknown[] = [from, dateTo];
  const taxes = await ctx.env.cr.query<Row>(
    `SELECT t.id, t.name, t.type_tax_use, t.amount, t.amount_type,
            coalesce((SELECT sum(-coalesce(b.balance, coalesce(b.debit, 0) - coalesce(b.credit, 0))) FROM ${rel?.m2mTable ?? 'account_move_line_tax_ids_rel'} r JOIN account_move_line b ON b.id = r.${rel?.m2mColumn1 ?? 'account_move_line_id'} JOIN account_move bm ON bm.id = b.move_id
                      WHERE r.${rel?.m2mColumn2 ?? 'account_tax_id'} = t.id AND coalesce(b.date, bm.date) BETWEEN $1::date AND $2::date AND ${stateClause('bm', ctx.options.includeDraft)}), 0)::float8 AS net,
            coalesce((SELECT sum(-coalesce(x.balance, coalesce(x.debit, 0) - coalesce(x.credit, 0))) FROM account_move_line x JOIN account_move xm ON xm.id = x.move_id
                      WHERE x.tax_line_id = t.id AND coalesce(x.date, xm.date) BETWEEN $1::date AND $2::date AND ${stateClause('xm', ctx.options.includeDraft)}), 0)::float8 AS tax
     FROM account_tax t WHERE coalesce(t.active, true) ORDER BY t.type_tax_use, t.sequence, t.id`, params,
  );
  const lines: ReportLine[] = [];
  for (const use of ['sale', 'purchase'] as const) {
    const group = taxes.rows.filter((r) => r.type_tax_use === use);
    if (!group.length) continue;
    const sign = use === 'sale' ? 1 : -1;
    const children: ReportLine[] = group.map((r) => ({
      id: `tax:${r.id}`, name: ar(String(r.name), String(r.name)), level: 3, parentId: `tax:${use}`, values: [sign * num(r.net), sign * num(r.tax)], model: 'account.tax', resId: Number(r.id),
      domain: itemsDomain(ctx, ['|', ['tax_line_id', '=', Number(r.id)], ['tax_ids', 'in', [Number(r.id)]]], from, dateTo),
    }));
    lines.push({ id: `tax:${use}`, name: use === 'sale' ? ar('Sales', 'المبيعات') : ar('Purchases', 'المشتريات'), level: 0, total: true, values: [children.reduce((s, c) => s + num(c.values[0]), 0), children.reduce((s, c) => s + num(c.values[1]), 0)] }, ...children);
  }
  const sales = lines.find((l) => l.id === 'tax:sale'); const purchases = lines.find((l) => l.id === 'tax:purchase');
  lines.push({ id: 'tax:total', name: ar('Tax to pay (Sales − Purchases)', 'الضريبة المستحقة (المبيعات − المشتريات)'), level: 0, total: true, values: [num(sales?.values[0]) - num(purchases?.values[0]), num(sales?.values[1]) - num(purchases?.values[1])] });
  return lines;
}

async function deferred(ctx: Ctx, kind: 'revenue' | 'expense'): Promise<ReportLine[]> {
  const { dateTo } = ctx.options;
  const from = ctx.options.dateFrom ?? dateTo.slice(0, 8) + '01';
  const params: unknown[] = [from, dateTo];
  const rows = await ctx.env.cr.query<Row>(
    `SELECT l.id, m.name AS move_name, l.name AS label, a.code || ' ' || a.name AS account, l.deferred_start_date AS ds, l.deferred_end_date AS de,
            abs(coalesce(l.balance, coalesce(l.debit, 0) - coalesce(l.credit, 0)))::float8 AS total
     FROM account_move_line l JOIN account_move m ON m.id = l.move_id JOIN account_account a ON a.id = l.account_id
     WHERE l.deferred_start_date IS NOT NULL AND l.deferred_end_date IS NOT NULL AND a.account_type IN (${kind === 'revenue' ? "'income', 'income_other'" : "'expense', 'expense_direct_cost', 'expense_other'"})
       AND ${stateClause('m', ctx.options.includeDraft)} AND l.deferred_start_date <= $2::date AND l.deferred_end_date >= $1::date
     ORDER BY a.code, l.deferred_start_date`, params,
  );
  const lines: ReportLine[] = rows.rows.map((r) => {
    const ds = Date.parse(String(r.ds).slice(0, 10)); const de = Date.parse(String(r.de).slice(0, 10));
    const span = Math.max(1, (de - ds) / 86_400_000 + 1);
    const share = (a: number, b: number) => (Math.max(0, Math.min(de, b) - Math.max(ds, a) + 86_400_000) / 86_400_000 / span) * num(r.total);
    const before = share(-Infinity, Date.parse(from) - 86_400_000);
    const current = share(Date.parse(from), Date.parse(dateTo));
    const later = Math.max(0, num(r.total) - before - current);
    const title = `${r.account} · ${r.move_name} · ${r.label ?? ''}`;
    return { id: `def:${r.id}`, name: ar(title, title), level: 1, values: [num(r.total), 0, before, current, later], model: 'account.move.line', resId: Number(r.id) };
  });
  const totals = [0, 1, 2, 3, 4].map((i) => lines.reduce((s, l) => s + num(l.values[i]), 0));
  lines.push({ id: 'def:total', name: ar('Total', 'الإجمالي'), level: 0, total: true, values: totals });
  return lines;
}

async function depreciation(ctx: Ctx): Promise<ReportLine[]> {
  const { dateTo } = ctx.options;
  const from = ctx.options.dateFrom ?? `${dateTo.slice(0, 4)}-01-01`;
  const rows = await ctx.env.cr.query<Row>(
    `SELECT s.id, s.name, s.acquisition_date, s.method, s.method_number, s.method_period, s.original_value::float8 AS original_value, s.book_value::float8 AS book_value, s.salvage_value::float8 AS salvage, s.state, g.name AS group_name, acc.code || ' ' || acc.name AS account
     FROM account_asset s LEFT JOIN account_asset_group g ON g.id = s.asset_group_id LEFT JOIN account_account acc ON acc.id = s.account_asset_id
     WHERE s.state IN ('open', 'close', 'paused') AND coalesce(s.active, true) ORDER BY acc.code, s.acquisition_date`, [],
  ).catch(() => ({ rows: [] as Row[] }));
  const lines: ReportLine[] = rows.rows.map((r) => {
    const original = num(r.original_value); const book = num(r.book_value);
    const depreciated = original - book;
    const months = Number(r.method_number ?? 0) * (Number(r.method_period ?? 12) || 12);
    const rate = months ? `${((12 / months) * 100).toFixed(2)}%` : '';
    const title = `${r.account ?? ''} · ${r.name}`;
    return { id: `asset:${r.id}`, name: ar(title, title), level: 1, model: 'account.asset', resId: Number(r.id), values: [String(r.acquisition_date ?? '').slice(0, 10), String(r.method ?? 'linear'), rate, original, 0, 0, original, depreciated, 0, 0, depreciated, book] };
  });
  void from;
  const totals = [3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => lines.reduce((s, l) => s + num(l.values[i]), 0));
  lines.push({ id: 'asset:total', name: ar('Total', 'الإجمالي'), level: 0, total: true, values: ['', '', '', ...totals] });
  return lines;
}

async function bankReconciliation(ctx: Ctx): Promise<ReportLine[]> {
  const { dateTo } = ctx.options;
  const journals = await ctx.env.cr.query<Row>(`SELECT j.id, j.name, j.default_account_id FROM account_journal j WHERE j.type = 'bank' AND coalesce(j.active, true) ORDER BY j.sequence, j.id`, []);
  const lines: ReportLine[] = [];
  for (const j of journals.rows) {
    const gl = await ctx.env.cr.query<Row>(
      `SELECT coalesce(sum(coalesce(l.balance, coalesce(l.debit, 0) - coalesce(l.credit, 0))), 0)::float8 AS balance FROM account_move_line l JOIN account_move m ON m.id = l.move_id
       WHERE l.account_id = $1 AND coalesce(l.date, m.date) <= $2::date AND ${stateClause('m', ctx.options.includeDraft)}`, [j.default_account_id, dateTo],
    );
    const outstanding = await ctx.env.cr.query<Row>(
      `SELECT coalesce(sum(CASE WHEN l.debit > 0 THEN l.debit END), 0)::float8 AS receipts, coalesce(sum(CASE WHEN l.credit > 0 THEN l.credit END), 0)::float8 AS payments
       FROM account_move_line l JOIN account_move m ON m.id = l.move_id JOIN account_account a ON a.id = l.account_id
       WHERE m.journal_id = $1 AND a.account_type = 'asset_current' AND coalesce(l.reconciled, false) = false AND coalesce(l.date, m.date) <= $2::date AND ${stateClause('m', ctx.options.includeDraft)}`, [j.id, dateTo],
    );
    const balance = num(gl.rows[0]?.balance); const receipts = num(outstanding.rows[0]?.receipts); const payments = num(outstanding.rows[0]?.payments);
    const jid = `bank:${j.id}`;
    lines.push(
      { id: jid, name: ar(String(j.name), String(j.name)), level: 0, total: true, values: [balance + receipts - payments] },
      { id: `${jid}:bal`, name: label(ctx, 'Balance of Bank', 'رصيد البنك'), level: 1, parentId: jid, values: [balance], domain: itemsDomain(ctx, [['account_id', '=', Number(j.default_account_id)]], null, dateTo) },
      { id: `${jid}:stmt`, name: label(ctx, 'Last statement balance', 'رصيد آخر كشف حساب'), level: 3, parentId: `${jid}:bal`, values: [balance] },
      { id: `${jid}:out`, name: label(ctx, 'Outstanding Receipts/Payments', 'المدفوعات/الإيصالات المستحقة'), level: 1, parentId: jid, values: [receipts - payments] },
      { id: `${jid}:rec`, name: label(ctx, '(+) Outstanding Receipts', '(+) الإيصالات المستحقة'), level: 3, parentId: `${jid}:out`, values: [receipts] },
      { id: `${jid}:pay`, name: label(ctx, '(-) Outstanding Payments', '(-) المدفوعات المستحقة'), level: 3, parentId: `${jid}:out`, values: [-payments] },
    );
  }
  return lines;
}

async function fiscalReport(ctx: Ctx): Promise<ReportLine[]> {
  const { dateTo } = ctx.options;
  const from = ctx.options.dateFrom ?? `${Number(dateTo.slice(0, 4)) - 1}-01-01`;
  const rows = await ctx.env.cr.query<Row>(
    `SELECT c.id, c.name, coalesce(sum(-coalesce(l.balance, coalesce(l.debit, 0) - coalesce(l.credit, 0))), 0)::float8 AS base
     FROM account_fiscal_category c LEFT JOIN account_account a ON a.fiscal_category_id = c.id
     LEFT JOIN account_move_line l ON l.account_id = a.id LEFT JOIN account_move m ON m.id = l.move_id AND ${stateClause('m', ctx.options.includeDraft)} AND coalesce(l.date, m.date) BETWEEN $1::date AND $2::date
     GROUP BY c.id, c.name ORDER BY c.sequence, c.id`, [from, dateTo],
  ).catch(() => ({ rows: [] as Row[] }));
  return rows.rows.map((r) => ({ id: `fc:${r.id}`, name: ar(String(r.name), String(r.name)), level: 1, values: [num(r.base), '', num(r.base)], model: 'account.fiscal.category', resId: Number(r.id) }));
}

export async function computeAccountReport(env: Environment, options: ReportOptions): Promise<ReportResult> {
  const def = env.registry.accountReports.find((r) => r.id === options.reportId);
  if (!def) throw new UserError({ en: `Unknown financial report ${options.reportId}`, ar: `تقرير مالي غير معروف ${options.reportId}` });
  const dateTo = options.dateTo || new Date().toISOString().slice(0, 10);
  const ctx: Ctx = {
    env, options: { ...options, dateTo }, lang: env.lang, fyStart: await fiscalYearStart(env, dateTo),
    registryLines: new Map(def.lines.filter((l) => l.name?.en).map((l) => [l.name.en, l.name])),
  };
  const money = (en: string, arabic: string): ReportColumn => ({ label: ar(en, arabic), type: 'monetary' });
  const text = (en: string, arabic: string): ReportColumn => ({ label: ar(en, arabic), type: 'string' });
  let columns: ReportColumn[] = [money('Balance', 'الرصيد')];
  let lines: ReportLine[] = [];
  let note: I18n | undefined;
  switch (options.reportId) {
    case 4: lines = await balanceSheet(ctx); break;
    case 7: lines = await profitAndLoss(ctx); break;
    case 6: lines = await executiveSummary(ctx); break;
    case 5: lines = await cashFlow(ctx); break;
    case 12: columns = [money('Initial Balance Debit', 'الرصيد الافتتاحي مدين'), money('Initial Balance Credit', 'الرصيد الافتتاحي دائن'), money('Debit', 'مدين'), money('Credit', 'دائن'), money('End Balance Debit', 'الرصيد الختامي مدين'), money('End Balance Credit', 'الرصيد الختامي دائن')]; lines = await trialBalance(ctx); break;
    case 11: columns = [text('Partner', 'الشريك'), money('Debit', 'مدين'), money('Credit', 'دائن'), money('Balance', 'الرصيد')]; lines = await ledger(ctx, 'account'); break;
    case 14: columns = [text('Journal', 'دفتر اليومية'), text('Account', 'الحساب'), text('Invoice Date', 'تاريخ الفاتورة'), text('Due Date', 'تاريخ الاستحقاق'), text('Matching', 'المطابقة'), money('Debit', 'مدين'), money('Credit', 'دائن'), money('Balance', 'الرصيد')]; lines = await ledger(ctx, 'partner'); break;
    case 20: columns = [text('Account', 'الحساب'), text('Partner', 'الشريك'), money('Debit', 'مدين'), money('Credit', 'دائن'), money('Balance', 'الرصيد')]; lines = await ledger(ctx, 'journal'); break;
    case 9: case 10: columns = [text('Invoice Date', 'تاريخ الفاتورة'), text('Currency', 'العملة'), text('Account', 'الحساب'), money('At Date', 'في التاريخ'), money('1 - 30', '1 - 30'), money('31 - 60', '31 - 60'), money('61 - 90', '61 - 90'), money('91 - 120', '91 - 120'), money('Older', 'أقدم'), money('Total', 'الإجمالي')]; lines = await aged(ctx, options.reportId === 9 ? 'receivable' : 'payable'); break;
    case 1: columns = [money('Net', 'الصافي'), money('Tax', 'الضريبة')]; lines = await taxReport(ctx); break;
    case 18: case 19: columns = [money('Total', 'الإجمالي'), money('Not Started', 'لم يبدأ'), money('Before', 'قبل'), money('Current', 'الحالي'), money('Later', 'لاحقاً')]; lines = await deferred(ctx, options.reportId === 19 ? 'revenue' : 'expense'); break;
    case 23: columns = [text('Acquisition Date', 'تاريخ الاقتناء'), text('Method', 'الطريقة'), text('Rate', 'المعدل'), money('Assets: from', 'الأصول: من'), money('Assets: +', 'الأصول: +'), money('Assets: −', 'الأصول: −'), money('Assets: to', 'الأصول: إلى'), money('Depreciation: from', 'الإهلاك: من'), money('Depreciation: +', 'الإهلاك: +'), money('Depreciation: −', 'الإهلاك: −'), money('Depreciation: to', 'الإهلاك: إلى'), money('Book Value', 'القيمة الدفترية')]; lines = await depreciation(ctx); break;
    case 8: lines = await bankReconciliation(ctx); break;
    case 22: columns = [money('Base Total', 'إجمالي الأساس'), text('Rate', 'المعدل'), money('Fiscal Amount', 'المبلغ الضريبي')]; lines = await fiscalReport(ctx); break;
    case 13: columns = [text('Country Code', 'رمز الدولة'), text('VAT Number', 'الرقم الضريبي'), money('Amount', 'المبلغ')]; lines = []; note = ar('No intra-EU sales in this period: the EC Sales List is empty.', 'لا توجد مبيعات داخل الاتحاد الأوروبي في هذه الفترة: قائمة مبيعات الاتحاد الأوروبي فارغة.'); break;
    case 17: columns = [money('Balance in Foreign Currency', 'الرصيد بالعملة الأجنبية'), money('Balance at Operation Rate', 'الرصيد بسعر العملية'), money('Balance at Current Rate', 'الرصيد بالسعر الحالي'), money('Adjustment', 'التسوية')]; lines = [{ id: 'ucg:adjust', name: ar('Accounts To Adjust', 'حسابات للتسوية'), level: 0, values: [0, 0, 0, 0], total: true }, { id: 'ucg:excluded', name: ar('Excluded Accounts', 'الحسابات المستبعدة'), level: 0, values: [0, 0, 0, 0], total: true }]; note = ar('All entries are in the company currency: nothing to adjust.', 'جميع القيود بعملة الشركة: لا شيء للتسوية.'); break;
    case 21: lines = await profitAndLoss(ctx); note = ar('Annual statements combine the Profit and Loss below with the Balance Sheet as of the end date.', 'تجمع البيانات السنوية بين الأرباح والخسائر أدناه والميزانية العمومية حتى تاريخ النهاية.'); break;
    default: lines = [];
  }
  if (options.hideZero) lines = lines.filter((l) => l.total || l.level === 0 || l.values.some((v) => typeof v === 'number' ? Math.abs(v) > 0.005 : Boolean(v)));
  const single = SINGLE_DATE_REPORTS.has(options.reportId);
  return {
    id: def.id, name: def.name, columns, lines, singleDate: single,
    period: { from: single ? null : (options.dateFrom ?? ctx.fyStart), to: dateTo },
    compare: options.compareTo ? { from: options.compareFrom ?? null, to: options.compareTo } : null,
    note,
  };
}
