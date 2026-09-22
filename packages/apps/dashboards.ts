import type { Environment } from '../engine/orm/env.js';
import type { I18n } from '../engine/i18n/types.js';
import { UserError } from '../engine/orm/errors.js';

/**
 * Dashboards (C-8.3): the seven seeded dashboards computed from live data
 * for a period (with the previous period as baseline): scorecards, charts,
 * tables and benchmark gauges, in the layout of the spreadsheet dashboards
 * of the reference instance.
 */

export interface Scorecard { label: I18n; value: number; format: 'money' | 'int' | 'pct' | 'hours' | 'days' | 'text'; text?: string; baseline?: { pct: number | null; label: I18n } }
export interface Chart { kind: 'line' | 'bar' | 'pie' | 'stacked'; title: I18n; labels: string[]; series: { name: string; values: number[] }[]; format?: 'money' | 'int' }
export interface Table { title: I18n; columns: { label: I18n; format?: 'money' | 'int' | 'pct' | 'text' }[]; rows: (string | number)[][] }
export interface Gauge { label: I18n; value: number; format: 'pct' | 'ratio' | 'money' | 'days'; good: number; bad: number; higherIsBetter: boolean; help: I18n }
export type Block = { type: 'scorecards'; items: Scorecard[] } | { type: 'chart'; chart: Chart } | { type: 'table'; table: Table } | { type: 'gauges'; items: Gauge[] } | { type: 'kpis'; title: I18n; rows: { label: I18n; value: number; previous: number; format: 'money' | 'pct' | 'days' | 'ratio' }[] };
export interface DashboardResult { name: I18n; period: { from: string; to: string }; previous: { from: string; to: string }; blocks: Block[] }

type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const ar = (en: string, arabic: string): I18n => ({ en, ar: arabic });
const pct = (current: number, previous: number): number | null => (previous ? ((current - previous) / Math.abs(previous)) * 100 : current ? 100 : null);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function previousPeriod(from: string, to: string): { from: string; to: string } {
  const a = Date.parse(`${from}T00:00:00Z`); const b = Date.parse(`${to}T00:00:00Z`);
  const days = Math.round((b - a) / 86_400_000) + 1;
  return { from: new Date(a - days * 86_400_000).toISOString().slice(0, 10), to: new Date(b - days * 86_400_000).toISOString().slice(0, 10) };
}

async function sales(env: Environment, p: { from: string; to: string }, q: { from: string; to: string }): Promise<Block[]> {
  const stats = async (r: { from: string; to: string }) => (await env.cr.query<Row>(
    `SELECT count(*) FILTER (WHERE state IN ('draft', 'sent'))::int AS quotations, count(*) FILTER (WHERE state IN ('sale', 'done'))::int AS orders,
            coalesce(sum(amount_untaxed) FILTER (WHERE state IN ('sale', 'done')), 0)::float8 AS revenue
     FROM sale_order WHERE date_order::date BETWEEN $1::date AND $2::date`, [r.from, r.to])).rows[0] ?? {};
  const cur = await stats(p); const prev = await stats(q);
  const avg = (s: Row) => (num(s.orders) ? num(s.revenue) / num(s.orders) : 0);
  const base = (a: number, b: number) => ({ pct: pct(a, b), label: ar('since last period', 'منذ الفترة السابقة') });
  const monthly = await env.cr.query<{ m: string; v: number }>(`SELECT to_char(date_trunc('month', date_order), 'YYYY-MM') AS m, coalesce(sum(amount_untaxed), 0)::float8 AS v FROM sale_order WHERE state IN ('sale', 'done') AND date_order::date BETWEEN $1::date AND $2::date GROUP BY 1 ORDER BY 1`, [p.from, p.to]);
  const top = async (sql: string) => (await env.cr.query<Row>(sql, [p.from, p.to])).rows;
  const quotations = await top(`SELECT o.name, coalesce(pt.name, '') AS partner, o.amount_untaxed::float8 AS amount FROM sale_order o LEFT JOIN res_partner pt ON pt.id = o.partner_id WHERE o.state IN ('draft', 'sent') AND o.date_order::date BETWEEN $1::date AND $2::date ORDER BY o.amount_untaxed DESC NULLS LAST LIMIT 10`);
  const customers = await top(`SELECT coalesce(pt.name, '') AS partner, count(*)::int AS orders, coalesce(sum(o.amount_untaxed), 0)::float8 AS revenue FROM sale_order o LEFT JOIN res_partner pt ON pt.id = o.partner_id WHERE o.state IN ('sale', 'done') AND o.date_order::date BETWEEN $1::date AND $2::date GROUP BY pt.name ORDER BY revenue DESC LIMIT 10`);
  const teams = await top(`SELECT coalesce(tm.name, '—') AS team, count(*)::int AS orders, coalesce(sum(o.amount_untaxed), 0)::float8 AS revenue FROM sale_order o LEFT JOIN crm_team tm ON tm.id = o.team_id WHERE o.state IN ('sale', 'done') AND o.date_order::date BETWEEN $1::date AND $2::date GROUP BY tm.name ORDER BY revenue DESC LIMIT 10`);
  const sources = await top(`SELECT coalesce(s.name, '—') AS source, count(*)::int AS orders, coalesce(sum(o.amount_untaxed), 0)::float8 AS revenue FROM sale_order o LEFT JOIN utm_source s ON s.id = o.source_id WHERE o.state IN ('sale', 'done') AND o.date_order::date BETWEEN $1::date AND $2::date GROUP BY s.name ORDER BY revenue DESC LIMIT 10`).catch(() => [] as Row[]);
  const people = await top(`SELECT coalesce(pu.name, '—') AS person, count(*)::int AS orders, coalesce(sum(o.amount_untaxed), 0)::float8 AS revenue FROM sale_order o LEFT JOIN res_users u ON u.id = o.user_id LEFT JOIN res_partner pu ON pu.id = u.partner_id WHERE o.state IN ('sale', 'done') AND o.date_order::date BETWEEN $1::date AND $2::date GROUP BY pu.name ORDER BY revenue DESC LIMIT 10`);
  const countries = await top(`SELECT coalesce(c.name, '—') AS country, coalesce(sum(o.amount_untaxed), 0)::float8 AS revenue FROM sale_order o LEFT JOIN res_partner pt ON pt.id = o.partner_id LEFT JOIN res_country c ON c.id = pt.country_id WHERE o.state IN ('sale', 'done') AND o.date_order::date BETWEEN $1::date AND $2::date GROUP BY c.name ORDER BY revenue DESC LIMIT 10`);
  return [
    { type: 'scorecards', items: [
      { label: ar('Quotations', 'عروض الأسعار'), value: num(cur.quotations), format: 'int', baseline: base(num(cur.quotations), num(prev.quotations)) },
      { label: ar('Orders', 'الطلبات'), value: num(cur.orders), format: 'int', baseline: base(num(cur.orders), num(prev.orders)) },
      { label: ar('Revenue', 'الإيرادات'), value: num(cur.revenue), format: 'money', baseline: base(num(cur.revenue), num(prev.revenue)) },
      { label: ar('Average Order', 'متوسط الطلب'), value: avg(cur), format: 'money', baseline: base(avg(cur), avg(prev)) },
    ] },
    { type: 'chart', chart: { kind: 'line', title: ar('Monthly Sales', 'المبيعات الشهرية'), labels: monthly.rows.map((r) => `${MONTHS[Number(r.m.slice(5, 7)) - 1]} ${r.m.slice(0, 4)}`), series: [{ name: 'Revenue', values: monthly.rows.map((r) => num(r.v)) }], format: 'money' } },
    { type: 'table', table: { title: ar('Top Quotations', 'أعلى عروض الأسعار'), columns: [{ label: ar('Quotation', 'عرض السعر') }, { label: ar('Customer', 'العميل') }, { label: ar('Revenue', 'الإيرادات'), format: 'money' }], rows: quotations.map((r) => [String(r.name), String(r.partner), num(r.amount)]) } },
    { type: 'table', table: { title: ar('Top Customers', 'أفضل العملاء'), columns: [{ label: ar('Customer', 'العميل') }, { label: ar('Orders', 'الطلبات'), format: 'int' }, { label: ar('Revenue', 'الإيرادات'), format: 'money' }], rows: customers.map((r) => [String(r.partner), num(r.orders), num(r.revenue)]) } },
    { type: 'table', table: { title: ar('Top Sales Teams', 'أفضل فرق المبيعات'), columns: [{ label: ar('Sales Team', 'فريق المبيعات') }, { label: ar('Orders', 'الطلبات'), format: 'int' }, { label: ar('Revenue', 'الإيرادات'), format: 'money' }], rows: teams.map((r) => [String(r.team), num(r.orders), num(r.revenue)]) } },
    { type: 'table', table: { title: ar('Top Sources', 'أفضل المصادر'), columns: [{ label: ar('Source', 'المصدر') }, { label: ar('Orders', 'الطلبات'), format: 'int' }, { label: ar('Revenue', 'الإيرادات'), format: 'money' }], rows: sources.map((r) => [String(r.source), num(r.orders), num(r.revenue)]) } },
    { type: 'table', table: { title: ar('Top Salespeople', 'أفضل مندوبي المبيعات'), columns: [{ label: ar('Salesperson', 'مندوب المبيعات') }, { label: ar('Orders', 'الطلبات'), format: 'int' }, { label: ar('Revenue', 'الإيرادات'), format: 'money' }], rows: people.map((r) => [String(r.person), num(r.orders), num(r.revenue)]) } },
    { type: 'chart', chart: { kind: 'bar', title: ar('Sales by Country', 'المبيعات حسب الدولة'), labels: countries.map((r) => String(r.country)), series: [{ name: 'Revenue', values: countries.map((r) => num(r.revenue)) }], format: 'money' } },
  ];
}

async function product(env: Environment, p: { from: string; to: string }): Promise<Block[]> {
  const rows = (await env.cr.query<Row>(
    `SELECT coalesce(pp.name, '—') AS product, coalesce(pc.name, '—') AS category, coalesce(sum(r.product_uom_qty), 0)::float8 AS units, coalesce(sum(r.price_subtotal), 0)::float8 AS revenue
     FROM sale_report r LEFT JOIN product_product pp ON pp.id = r.product_id LEFT JOIN product_category pc ON pc.id = r.categ_id
     WHERE r.state IN ('sale', 'done') AND r.date::date BETWEEN $1::date AND $2::date GROUP BY pp.name, pc.name ORDER BY revenue DESC LIMIT 15`, [p.from, p.to])).rows;
  const byUnits = [...rows].sort((a, b) => num(b.units) - num(a.units));
  const byCategory = new Map<string, number>();
  for (const r of rows) byCategory.set(String(r.category), (byCategory.get(String(r.category)) ?? 0) + num(r.units));
  const bestCategory = [...byCategory.entries()].sort((a, b) => b[1] - a[1])[0];
  return [
    { type: 'scorecards', items: [
      { label: ar('Best Seller', 'الأكثر مبيعاً'), value: num(byUnits[0]?.units), format: 'text', text: byUnits[0] ? `${byUnits[0].product} · ${num(byUnits[0].units)} ${'sold'}` : '—' },
      { label: ar('Best Category', 'أفضل فئة'), value: bestCategory?.[1] ?? 0, format: 'text', text: bestCategory ? `${bestCategory[0]} · ${bestCategory[1]} sold` : '—' },
    ] },
    { type: 'chart', chart: { kind: 'bar', title: ar('Best Sellers by Revenue', 'الأكثر مبيعاً حسب الإيرادات'), labels: rows.slice(0, 10).map((r) => String(r.product)), series: [{ name: 'Revenue', values: rows.slice(0, 10).map((r) => num(r.revenue)) }], format: 'money' } },
    { type: 'chart', chart: { kind: 'bar', title: ar('Best Sellers by Units Sold', 'الأكثر مبيعاً حسب الوحدات'), labels: byUnits.slice(0, 10).map((r) => String(r.product)), series: [{ name: 'Units', values: byUnits.slice(0, 10).map((r) => num(r.units)) }], format: 'int' } },
    { type: 'table', table: { title: ar('Best Selling Products', 'المنتجات الأكثر مبيعاً'), columns: [{ label: ar('Product', 'المنتج') }, { label: ar('Category', 'الفئة') }, { label: ar('Units', 'الوحدات'), format: 'int' }, { label: ar('Revenue', 'الإيرادات'), format: 'money' }], rows: rows.map((r) => [String(r.product), String(r.category), num(r.units), num(r.revenue)]) } },
  ];
}

async function rental(env: Environment, p: { from: string; to: string }, q: { from: string; to: string }): Promise<Block[]> {
  const stats = async (r: { from: string; to: string }) => (await env.cr.query<Row>(`SELECT count(*) FILTER (WHERE state IN ('sale', 'done'))::int AS rentals, count(*) FILTER (WHERE state IN ('draft', 'sent'))::int AS quotations, coalesce(sum(price) FILTER (WHERE state IN ('sale', 'done')), 0)::float8 AS revenue, coalesce(sum(quantity), 0)::float8 AS qty, coalesce(sum(qty_delivered), 0)::float8 AS picked FROM sale_rental_report WHERE date BETWEEN $1::date AND $2::date`, [r.from, r.to])).rows[0] ?? {};
  const cur = await stats(p); const prev = await stats(q);
  const daily = await env.cr.query<{ d: string; v: number }>(`SELECT date::text AS d, coalesce(sum(price), 0)::float8 AS v FROM sale_rental_report WHERE state IN ('sale', 'done') AND date BETWEEN $1::date AND $2::date GROUP BY 1 ORDER BY 1`, [p.from, p.to]);
  const top = async (sql: string) => (await env.cr.query<Row>(sql, [p.from, p.to])).rows;
  const people = await top(`SELECT coalesce(pu.name, '—') AS k, coalesce(sum(r.quantity), 0)::float8 AS ordered, coalesce(sum(r.price), 0)::float8 AS revenue FROM sale_rental_report r LEFT JOIN res_users u ON u.id = r.user_id LEFT JOIN res_partner pu ON pu.id = u.partner_id WHERE r.state IN ('sale', 'done') AND r.date BETWEEN $1::date AND $2::date GROUP BY pu.name ORDER BY revenue DESC LIMIT 10`);
  const products = await top(`SELECT coalesce(pp.name, '—') AS k, coalesce(sum(r.quantity), 0)::float8 AS ordered, coalesce(sum(r.price), 0)::float8 AS revenue FROM sale_rental_report r LEFT JOIN product_product pp ON pp.id = r.product_id WHERE r.state IN ('sale', 'done') AND r.date BETWEEN $1::date AND $2::date GROUP BY pp.name ORDER BY revenue DESC LIMIT 10`);
  const customers = await top(`SELECT coalesce(pt.name, '—') AS k, coalesce(sum(r.quantity), 0)::float8 AS ordered, coalesce(sum(r.price), 0)::float8 AS revenue FROM sale_rental_report r LEFT JOIN res_partner pt ON pt.id = r.partner_id WHERE r.state IN ('sale', 'done') AND r.date BETWEEN $1::date AND $2::date GROUP BY pt.name ORDER BY revenue DESC LIMIT 10`);
  const table = (title: I18n, col: I18n, rows: Row[]): Block => ({ type: 'table', table: { title, columns: [{ label: col }, { label: ar('Ordered', 'المطلوب'), format: 'int' }, { label: ar('Revenue', 'الإيرادات'), format: 'money' }], rows: rows.map((r) => [String(r.k), num(r.ordered), num(r.revenue)]) } });
  return [
    { type: 'scorecards', items: [
      { label: ar('Rentals', 'التأجيرات'), value: num(cur.rentals), format: 'int', baseline: { pct: pct(num(cur.rentals), num(prev.rentals)), label: ar('since last period', 'منذ الفترة السابقة') } },
      { label: ar('Revenue', 'الإيرادات'), value: num(cur.revenue), format: 'money', baseline: { pct: pct(num(cur.revenue), num(prev.revenue)), label: ar('since last period', 'منذ الفترة السابقة') } },
      { label: ar('Quotations', 'عروض الأسعار'), value: num(cur.quotations), format: 'int', baseline: { pct: pct(num(cur.quotations), num(prev.quotations)), label: ar('since last period', 'منذ الفترة السابقة') } },
      { label: ar('Ordered Qty', 'الكمية المطلوبة'), value: num(cur.qty), format: 'int' }, { label: ar('Picked-up Qty', 'الكمية المستلمة'), value: num(cur.picked), format: 'int' },
    ] },
    { type: 'chart', chart: { kind: 'line', title: ar('Daily Rentals', 'التأجيرات اليومية'), labels: daily.rows.map((r) => r.d.slice(5)), series: [{ name: 'Revenue', values: daily.rows.map((r) => num(r.v)) }], format: 'money' } },
    table(ar('Top Salespeople', 'أفضل مندوبي المبيعات'), ar('Salesperson', 'مندوب المبيعات'), people), table(ar('Top Products', 'أفضل المنتجات'), ar('Product', 'المنتج'), products), table(ar('Top Customers', 'أفضل العملاء'), ar('Customer', 'العميل'), customers),
  ];
}

async function balance(env: Environment, types: string[], from: string | null, to: string, column: 'balance' | 'debit' | 'credit' = 'balance'): Promise<number> {
  const params: unknown[] = [types, to];
  let where = `a.account_type = ANY($1) AND coalesce(l.date, m.date) <= $2::date AND m.state = 'posted'`;
  if (from) { params.push(from); where += ` AND coalesce(l.date, m.date) >= $3::date`; }
  const expr = column === 'balance' ? `coalesce(l.balance, coalesce(l.debit, 0) - coalesce(l.credit, 0))` : `coalesce(l.${column}, 0)`;
  const r = await env.cr.query<{ v: number }>(`SELECT coalesce(sum(${expr}), 0)::float8 AS v FROM account_move_line l JOIN account_move m ON m.id = l.move_id JOIN account_account a ON a.id = l.account_id WHERE ${where}`, params);
  return num(r.rows[0]?.v);
}

const ASSETS = ['asset_cash', 'asset_receivable', 'asset_current', 'asset_prepayments', 'asset_fixed', 'asset_non_current'];
const CURRENT_ASSETS = ['asset_cash', 'asset_receivable', 'asset_current', 'asset_prepayments'];
const LIABILITIES = ['liability_current', 'liability_credit_card', 'liability_payable', 'liability_non_current'];
const CURRENT_LIABILITIES = ['liability_current', 'liability_credit_card', 'liability_payable'];

async function financials(env: Environment, p: { from: string; to: string }) {
  const revenue = -(await balance(env, ['income'], p.from, p.to));
  const otherIncome = -(await balance(env, ['income_other'], p.from, p.to));
  const cogs = await balance(env, ['expense_direct_cost'], p.from, p.to);
  const opex = await balance(env, ['expense'], p.from, p.to);
  const otherExp = await balance(env, ['expense_other', 'expense_depreciation'], p.from, p.to);
  const gross = revenue - cogs; const operating = gross - opex; const net = operating + otherIncome - otherExp;
  const cashIn = await balance(env, ['asset_cash'], p.from, p.to, 'debit'); const cashOut = await balance(env, ['asset_cash'], p.from, p.to, 'credit');
  const closing = await balance(env, ['asset_cash'], null, p.to);
  const receivables = await balance(env, ['asset_receivable'], null, p.to); const payables = -(await balance(env, ['liability_payable'], null, p.to));
  const assets = await balance(env, ASSETS, null, p.to); const liabilities = -(await balance(env, LIABILITIES, null, p.to));
  const currentAssets = await balance(env, CURRENT_ASSETS, null, p.to); const currentLiabilities = -(await balance(env, CURRENT_LIABILITIES, null, p.to));
  const equity = -(await balance(env, ['equity', 'equity_unaffected'], null, p.to)) + net;
  const days = Math.max(1, Math.round((Date.parse(p.to) - Date.parse(p.from)) / 86_400_000) + 1);
  const purchases = cogs + opex + otherExp;
  return { revenue, otherIncome, cogs, opex, otherExp, gross, operating, net, cashIn, cashOut, closing, receivables, payables, assets, liabilities, currentAssets, currentLiabilities, equity, days, purchases, expenses: opex + otherExp };
}

async function accounting(env: Environment, p: { from: string; to: string }, q: { from: string; to: string }): Promise<Block[]> {
  const cur = await financials(env, p); const prev = await financials(env, q);
  const monthly = await env.cr.query<{ m: string; v: number }>(`SELECT to_char(date_trunc('month', invoice_date), 'YYYY-MM') AS m, coalesce(sum(price_subtotal), 0)::float8 AS v FROM account_invoice_report WHERE state = 'posted' AND move_type IN ('out_invoice', 'out_refund') AND invoice_date BETWEEN $1::date AND $2::date GROUP BY 1 ORDER BY 1`, [p.from, p.to]);
  const ratio = (a: number, b: number) => (b ? a / b : 0);
  const kpi = (label: I18n, value: number, previous: number, format: 'money' | 'pct' | 'days' | 'ratio') => ({ label, value, previous, format });
  return [
    { type: 'scorecards', items: [
      { label: ar('Current income', 'الدخل الحالي'), value: cur.revenue + cur.otherIncome, format: 'money', baseline: { pct: pct(cur.revenue + cur.otherIncome, prev.revenue + prev.otherIncome), label: ar('vs last period', 'مقارنة بالفترة السابقة') } },
      { label: ar('Receivables', 'المدينون'), value: cur.receivables, format: 'money', baseline: { pct: null, label: ar('to receive', 'للتحصيل') } },
      { label: ar('Current expense', 'المصروف الحالي'), value: cur.purchases, format: 'money', baseline: { pct: pct(cur.purchases, prev.purchases), label: ar('vs last period', 'مقارنة بالفترة السابقة') } },
      { label: ar('Payables', 'الدائنون'), value: cur.payables, format: 'money', baseline: { pct: null, label: ar('to pay', 'للدفع') } },
    ] },
    { type: 'chart', chart: { kind: 'line', title: ar('Invoiced', 'المفوتر'), labels: monthly.rows.map((r) => `${MONTHS[Number(r.m.slice(5, 7)) - 1]} ${r.m.slice(0, 4)}`), series: [{ name: 'Invoiced', values: monthly.rows.map((r) => num(r.v)) }], format: 'money' } },
    { type: 'kpis', title: ar('Cash', 'النقد'), rows: [kpi(ar('Cash received', 'النقد المستلم'), cur.cashIn, prev.cashIn, 'money'), kpi(ar('Cash spent', 'النقد المنفق'), cur.cashOut, prev.cashOut, 'money'), kpi(ar('Cash surplus', 'الفائض النقدي'), cur.cashIn - cur.cashOut, prev.cashIn - prev.cashOut, 'money'), kpi(ar('Closing bank balance', 'رصيد الإقفال البنكي'), cur.closing, prev.closing, 'money')] },
    { type: 'kpis', title: ar('Performance', 'الأداء'), rows: [kpi(ar('Gross profit margin', 'هامش الربح الإجمالي'), ratio(cur.gross, cur.revenue) * 100, ratio(prev.gross, prev.revenue) * 100, 'pct'), kpi(ar('Net profit margin', 'هامش الربح الصافي'), ratio(cur.net, cur.revenue) * 100, ratio(prev.net, prev.revenue) * 100, 'pct'), kpi(ar('Return on investments', 'العائد على الاستثمار'), ratio(cur.net, cur.assets) * 100, ratio(prev.net, prev.assets) * 100, 'pct'), kpi(ar('Financial independence', 'الاستقلال المالي'), ratio(cur.equity, cur.assets) * 100, ratio(prev.equity, prev.assets) * 100, 'pct')] },
    { type: 'kpis', title: ar('Position', 'المركز'), rows: [kpi(ar('Average debtors days', 'متوسط أيام المدينين'), ratio(cur.receivables, cur.revenue) * cur.days, ratio(prev.receivables, prev.revenue) * prev.days, 'days'), kpi(ar('Average creditors days', 'متوسط أيام الدائنين'), ratio(cur.payables, cur.purchases) * cur.days, ratio(prev.payables, prev.purchases) * prev.days, 'days'), kpi(ar('Short term cash forecast', 'توقعات النقد قصيرة الأجل'), cur.receivables - cur.payables, prev.receivables - prev.payables, 'money')] },
    { type: 'kpis', title: ar('Liquidity', 'السيولة'), rows: [kpi(ar('Cash asset ratio', 'نسبة الأصول النقدية'), ratio(cur.closing, cur.currentLiabilities), ratio(prev.closing, prev.currentLiabilities), 'ratio'), kpi(ar('Quick ratio', 'النسبة السريعة'), ratio(cur.closing + cur.receivables, cur.currentLiabilities), ratio(prev.closing + prev.receivables, prev.currentLiabilities), 'ratio'), kpi(ar('Current assets to liabilities', 'الأصول المتداولة إلى الالتزامات'), ratio(cur.currentAssets, cur.currentLiabilities), ratio(prev.currentAssets, prev.currentLiabilities), 'ratio'), kpi(ar('Working capital', 'رأس المال العامل'), cur.currentAssets - cur.currentLiabilities, prev.currentAssets - prev.currentLiabilities, 'money')] },
    { type: 'kpis', title: ar('Profitability', 'الربحية'), rows: [kpi(ar('Income', 'الدخل'), cur.revenue, prev.revenue, 'money'), kpi(ar('Cost of revenue', 'تكلفة الإيرادات'), cur.cogs, prev.cogs, 'money'), kpi(ar('Gross profit', 'الربح الإجمالي'), cur.gross, prev.gross, 'money'), kpi(ar('Expenses', 'المصروفات'), cur.expenses, prev.expenses, 'money'), kpi(ar('Net profit', 'صافي الربح'), cur.net, prev.net, 'money')] },
    { type: 'kpis', title: ar('Balance sheet', 'الميزانية العمومية'), rows: [kpi(ar('Receivable', 'المدينون'), cur.receivables, prev.receivables, 'money'), kpi(ar('Payables', 'الدائنون'), cur.payables, prev.payables, 'money'), kpi(ar('Net assets', 'صافي الأصول'), cur.assets - cur.liabilities, prev.assets - prev.liabilities, 'money')] },
    { type: 'kpis', title: ar('Solvency', 'الملاءة'), rows: [kpi(ar('Debt to Equity', 'الدين إلى حقوق الملكية'), ratio(cur.liabilities, cur.equity), ratio(prev.liabilities, prev.equity), 'ratio'), kpi(ar('Solvency', 'الملاءة'), ratio(cur.assets, cur.liabilities), ratio(prev.assets, prev.liabilities), 'ratio'), kpi(ar('Debt ratio', 'نسبة الدين'), ratio(cur.liabilities, cur.assets) * 100, ratio(prev.liabilities, prev.assets) * 100, 'pct'), kpi(ar('Financial balance', 'التوازن المالي'), cur.equity - (cur.assets - cur.currentAssets), prev.equity - (prev.assets - prev.currentAssets), 'money')] },
  ];
}

async function invoicing(env: Environment, p: { from: string; to: string }, q: { from: string; to: string }): Promise<Block[]> {
  const stats = async (r: { from: string; to: string }) => (await env.cr.query<Row>(`SELECT count(*)::int AS n, coalesce(sum(amount_untaxed_signed), 0)::float8 AS invoiced, count(*) FILTER (WHERE payment_state IN ('not_paid', 'partial'))::int AS unpaid FROM account_move WHERE state = 'posted' AND move_type IN ('out_invoice', 'out_refund') AND invoice_date BETWEEN $1::date AND $2::date`, [r.from, r.to])).rows[0] ?? {};
  const cur = await stats(p); const prev = await stats(q);
  const fin = await financials(env, p);
  const dso = fin.revenue ? (fin.receivables / fin.revenue) * fin.days : 0;
  const monthly = await env.cr.query<{ m: string; v: number }>(`SELECT to_char(date_trunc('month', invoice_date), 'YYYY-MM') AS m, coalesce(sum(amount_untaxed_signed), 0)::float8 AS v FROM account_move WHERE state = 'posted' AND move_type IN ('out_invoice', 'out_refund') AND invoice_date BETWEEN $1::date AND $2::date GROUP BY 1 ORDER BY 1`, [p.from, p.to]);
  const invoices = (await env.cr.query<Row>(`SELECT m.name, coalesce(pt.name, '') AS partner, coalesce(pu.name, '') AS person, m.payment_state, m.amount_total::float8 AS total FROM account_move m LEFT JOIN res_partner pt ON pt.id = m.partner_id LEFT JOIN res_users u ON u.id = m.invoice_user_id LEFT JOIN res_partner pu ON pu.id = u.partner_id WHERE m.state = 'posted' AND m.move_type = 'out_invoice' AND m.invoice_date BETWEEN $1::date AND $2::date ORDER BY m.amount_total DESC LIMIT 10`, [p.from, p.to])).rows;
  const countries = (await env.cr.query<Row>(`SELECT coalesce(c.name, '—') AS k, coalesce(sum(m.amount_untaxed_signed), 0)::float8 AS v FROM account_move m LEFT JOIN res_partner pt ON pt.id = m.partner_id LEFT JOIN res_country c ON c.id = pt.country_id WHERE m.state = 'posted' AND m.move_type IN ('out_invoice', 'out_refund') AND m.invoice_date BETWEEN $1::date AND $2::date GROUP BY c.name ORDER BY v DESC LIMIT 10`, [p.from, p.to])).rows;
  const products = (await env.cr.query<Row>(`SELECT coalesce(pp.name, '—') AS k, coalesce(sum(r.price_subtotal), 0)::float8 AS v FROM account_invoice_report r LEFT JOIN product_product pp ON pp.id = r.product_id WHERE r.state = 'posted' AND r.move_type IN ('out_invoice', 'out_refund') AND r.invoice_date BETWEEN $1::date AND $2::date GROUP BY pp.name ORDER BY v DESC LIMIT 10`, [p.from, p.to])).rows;
  const status = (s: unknown) => (s === 'paid' || s === 'in_payment' ? 'Paid' : s === 'partial' ? 'Partially Paid' : 'Not Paid');
  return [
    { type: 'scorecards', items: [
      { label: ar('Invoiced', 'المفوتر'), value: num(cur.invoiced), format: 'money', baseline: { pct: pct(num(cur.invoiced), num(prev.invoiced)), label: ar(`${num(cur.unpaid)} unpaid`, `${num(cur.unpaid)} غير مدفوعة`) } },
      { label: ar('Average Invoice', 'متوسط الفاتورة'), value: num(cur.n) ? num(cur.invoiced) / num(cur.n) : 0, format: 'money', baseline: { pct: null, label: ar(`${num(cur.n)} invoices`, `${num(cur.n)} فاتورة`) } },
      { label: ar('DSO', 'فترة التحصيل'), value: Math.round(dso), format: 'days', baseline: { pct: null, label: ar('days, in current period', 'يوم، في الفترة الحالية') } },
    ] },
    { type: 'chart', chart: { kind: 'bar', title: ar('Invoiced by Month', 'المفوتر حسب الشهر'), labels: monthly.rows.map((r) => `${MONTHS[Number(r.m.slice(5, 7)) - 1]} ${r.m.slice(0, 4)}`), series: [{ name: 'Invoiced', values: monthly.rows.map((r) => num(r.v)) }], format: 'money' } },
    { type: 'table', table: { title: ar('Top Invoices', 'أعلى الفواتير'), columns: [{ label: ar('Reference', 'المرجع') }, { label: ar('Customer', 'العميل') }, { label: ar('Salesperson', 'مندوب المبيعات') }, { label: ar('Status', 'الحالة') }, { label: ar('Total', 'الإجمالي'), format: 'money' }], rows: invoices.map((r) => [String(r.name), String(r.partner), String(r.person), status(r.payment_state), num(r.total)]) } },
    { type: 'table', table: { title: ar('Country', 'الدولة'), columns: [{ label: ar('Country', 'الدولة') }, { label: ar('Invoiced', 'المفوتر'), format: 'money' }], rows: countries.map((r) => [String(r.k), num(r.v)]) } },
    { type: 'table', table: { title: ar('Top Products', 'أفضل المنتجات'), columns: [{ label: ar('Product', 'المنتج') }, { label: ar('Invoiced', 'المفوتر'), format: 'money' }], rows: products.map((r) => [String(r.k), num(r.v)]) } },
  ];
}

async function benchmark(env: Environment, p: { from: string; to: string }): Promise<Block[]> {
  const f = await financials(env, p);
  const ratio = (a: number, b: number) => (b ? a / b : 0);
  const g = (label: I18n, value: number, format: Gauge['format'], good: number, bad: number, higherIsBetter: boolean, help: I18n): Gauge => ({ label, value, format, good, bad, higherIsBetter, help });
  return [{ type: 'gauges', items: [
    g(ar('Gross profit margin', 'هامش الربح الإجمالي'), ratio(f.gross, f.revenue) * 100, 'pct', 50, 20, true, ar('(Net sales – COGS) / Net sales. Above 50%: hugely profitable; below 20%: hard to become profitable — possible issue in the business model.', '(صافي المبيعات − تكلفة البضاعة) / صافي المبيعات. فوق 50%: مربح جداً؛ تحت 20%: من الصعب تحقيق الربحية — مشكلة محتملة في نموذج العمل.')),
    g(ar('Net profit margin', 'هامش الربح الصافي'), ratio(f.net, f.revenue) * 100, 'pct', 10, 3, true, ar('Net income / Revenue. Below 3%: not efficient; above 10%: very efficient — possible issue in direct and indirect costs.', 'صافي الدخل / الإيرادات. تحت 3%: غير فعال؛ فوق 10%: فعال جداً — مشكلة محتملة في التكاليف المباشرة وغير المباشرة.')),
    g(ar('Operating margin', 'هامش التشغيل'), ratio(f.operating, f.revenue) * 100, 'pct', 10, 5, true, ar('EBIT / Net sales. Below 5% / above 10% — possible issue in COGS.', 'الربح قبل الفوائد والضرائب / صافي المبيعات. تحت 5% / فوق 10% — مشكلة محتملة في تكلفة البضاعة.')),
    g(ar('Debt-to-equity', 'الدين إلى حقوق الملكية'), ratio(f.liabilities, f.equity), 'ratio', 2.5, 5, false, ar('Total liabilities / Total shareholders equity. Below 2.5: mature company; above 5: lots of debt — possible issue in resources allocation.', 'إجمالي الالتزامات / إجمالي حقوق المساهمين. تحت 2.5: شركة ناضجة؛ فوق 5: ديون كثيرة — مشكلة محتملة في تخصيص الموارد.')),
    g(ar('Current ratio', 'النسبة الجارية'), ratio(f.currentAssets, f.currentLiabilities), 'ratio', 1.5, 1, true, ar('Current assets / Current liabilities. Above 1.5: strong; below 1: weak — possible issue with asset distribution and cash availability.', 'الأصول المتداولة / الالتزامات المتداولة. فوق 1.5: قوي؛ تحت 1: ضعيف — مشكلة محتملة في توزيع الأصول وتوفر النقد.')),
    g(ar('Cash flow ratio', 'نسبة التدفق النقدي'), ratio(f.cashIn - f.cashOut, f.currentLiabilities), 'ratio', 1, 0.8, true, ar('Cash flow / Current liabilities. Above 1 / below 0.8: number of times you can pay off current debts with the cash generated per year.', 'التدفق النقدي / الالتزامات المتداولة. فوق 1 / تحت 0.8: عدد المرات التي يمكنك فيها سداد الديون الحالية بالنقد المتولد سنوياً.')),
    g(ar('Working capital', 'رأس المال العامل'), f.currentAssets - f.currentLiabilities, 'money', 0, 0, true, ar('Current assets – Current liabilities. Above 0 / below 0 — possible issues in cash availability at short term.', 'الأصول المتداولة − الالتزامات المتداولة. فوق 0 / تحت 0 — مشاكل محتملة في توفر النقد على المدى القصير.')),
    g(ar('Quick ratio', 'النسبة السريعة'), ratio(f.closing + f.receivables, f.currentLiabilities), 'ratio', 1, 0.7, true, ar('Quick assets / Current liabilities. Above 1: highly solvent; below 0.7: stuck with non-liquid assets.', 'الأصول السريعة / الالتزامات المتداولة. فوق 1: ملاءة عالية؛ تحت 0.7: عالق بأصول غير سائلة.')),
    g(ar('Average debtor days', 'متوسط أيام المدينين'), ratio(f.receivables, f.revenue) * f.days, 'days', 45, 60, false, ar('Sales on account / Average AR. Below 45 / above 60 — possible issue in payment terms.', 'المبيعات الآجلة / متوسط الذمم المدينة. تحت 45 / فوق 60 — مشكلة محتملة في شروط الدفع.')),
    g(ar('Average payable days', 'متوسط أيام الدائنين'), ratio(f.payables, f.purchases) * f.days, 'days', 45, 60, false, ar('Net credit purchases / Average AP. Below 45 / above 60.', 'صافي المشتريات الآجلة / متوسط الذمم الدائنة. تحت 45 / فوق 60.')),
  ] }];
}

async function helpdesk(env: Environment, p: { from: string; to: string }): Promise<Block[]> {
  const s = (await env.cr.query<Row>(`SELECT count(*)::int AS n, avg(rating_avg)::float8 AS rating, avg(assign_hours)::float8 AS assign, avg(first_response_hours)::float8 AS respond, avg(close_hours)::float8 AS close FROM helpdesk_ticket WHERE create_date::date BETWEEN $1::date AND $2::date`, [p.from, p.to])).rows[0] ?? {};
  const stages = (await env.cr.query<Row>(`SELECT coalesce(st.name, '—') AS k, count(*)::int AS n FROM helpdesk_ticket t LEFT JOIN helpdesk_stage st ON st.id = t.stage_id WHERE t.create_date::date BETWEEN $1::date AND $2::date GROUP BY st.name, st.sequence ORDER BY st.sequence`, [p.from, p.to])).rows;
  const teams = (await env.cr.query<Row>(`SELECT coalesce(tm.name, '—') AS team, coalesce(st.name, '—') AS stage, count(*)::int AS n FROM helpdesk_ticket t LEFT JOIN helpdesk_team tm ON tm.id = t.team_id LEFT JOIN helpdesk_stage st ON st.id = t.stage_id WHERE t.create_date::date BETWEEN $1::date AND $2::date GROUP BY tm.name, st.name, st.sequence ORDER BY tm.name, st.sequence`, [p.from, p.to])).rows;
  const customers = (await env.cr.query<Row>(`SELECT coalesce(pt.name, '—') AS k, count(*)::int AS n FROM helpdesk_ticket t LEFT JOIN res_partner pt ON pt.id = t.partner_id WHERE t.create_date::date BETWEEN $1::date AND $2::date GROUP BY pt.name ORDER BY n DESC LIMIT 10`, [p.from, p.to])).rows;
  const rel = env.registry.models['helpdesk.ticket']?.fields.tag_ids;
  const tags = rel?.m2mTable ? (await env.cr.query<Row>(`SELECT coalesce(g.name, '—') AS k, count(*)::int AS n FROM "${rel.m2mTable}" r JOIN helpdesk_tag g ON g.id = r."${rel.m2mColumn2}" JOIN helpdesk_ticket t ON t.id = r."${rel.m2mColumn1}" WHERE t.create_date::date BETWEEN $1::date AND $2::date GROUP BY g.name ORDER BY n DESC LIMIT 10`, [p.from, p.to]).catch(() => ({ rows: [] as Row[] }))).rows : [];
  const teamNames = [...new Set(teams.map((r) => String(r.team)))]; const stageNames = [...new Set(teams.map((r) => String(r.stage)))];
  return [
    { type: 'scorecards', items: [
      { label: ar('Tickets', 'التذاكر'), value: num(s.n), format: 'int' }, { label: ar('Rating', 'التقييم'), value: num(s.rating), format: 'text', text: `${num(s.rating).toFixed(1)} / 5` },
      { label: ar('Time to Assign', 'وقت الإسناد'), value: num(s.assign), format: 'hours' }, { label: ar('Time to Respond', 'وقت الرد'), value: num(s.respond), format: 'hours' }, { label: ar('Time to Close', 'وقت الإغلاق'), value: num(s.close), format: 'hours' },
    ] },
    { type: 'chart', chart: { kind: 'pie', title: ar('Ticket Stage', 'مرحلة التذكرة'), labels: stages.map((r) => String(r.k)), series: [{ name: 'Tickets', values: stages.map((r) => num(r.n)) }], format: 'int' } },
    { type: 'chart', chart: { kind: 'stacked', title: ar('Tickets per Team', 'التذاكر حسب الفريق'), labels: teamNames, series: stageNames.map((stage) => ({ name: stage, values: teamNames.map((team) => num(teams.find((r) => String(r.team) === team && String(r.stage) === stage)?.n)) })), format: 'int' } },
    { type: 'table', table: { title: ar('Top Customers', 'أفضل العملاء'), columns: [{ label: ar('Customer', 'العميل') }, { label: ar('Tickets', 'التذاكر'), format: 'int' }], rows: customers.map((r) => [String(r.k), num(r.n)]) } },
    { type: 'table', table: { title: ar('Tickets by Tags', 'التذاكر حسب العلامات'), columns: [{ label: ar('Tag', 'العلامة') }, { label: ar('Tickets', 'التذاكر'), format: 'int' }], rows: tags.map((r) => [String(r.k), num(r.n)]) } },
  ];
}

export async function computeDashboard(env: Environment, name: string, from: string, to: string): Promise<DashboardResult> {
  const p = { from, to }; const q = previousPeriod(from, to);
  const key = name.toLowerCase();
  const names: Record<string, I18n> = { sales: ar('Sales', 'المبيعات'), product: ar('Product', 'المنتج'), rental: ar('Rental', 'التأجير'), accounting: ar('Accounting', 'المحاسبة'), invoicing: ar('Invoicing', 'الفوترة'), benchmark: ar('Benchmark', 'المقارنة المعيارية'), helpdesk: ar('Helpdesk', 'مكتب المساعدة') };
  let blocks: Block[];
  switch (key) {
    case 'sales': blocks = await sales(env, p, q); break;
    case 'product': blocks = await product(env, p); break;
    case 'rental': blocks = await rental(env, p, q); break;
    case 'accounting': blocks = await accounting(env, p, q); break;
    case 'invoicing': blocks = await invoicing(env, p, q); break;
    case 'benchmark': blocks = await benchmark(env, p); break;
    case 'helpdesk': blocks = await helpdesk(env, p); break;
    default: throw new UserError({ en: `Unknown dashboard ${name}`, ar: `لوحة بيانات غير معروفة ${name}` });
  }
  return { name: names[key] ?? ar(name, name), period: p, previous: q, blocks };
}
