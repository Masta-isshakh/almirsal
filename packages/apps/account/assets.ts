import type { Registry, FieldDef } from '../../engine/registry/types.js';
import type { Environment } from '../../engine/orm/env.js';
import { registerModelHooks, type Values } from '../../engine/orm/hooks.js';
import { UserError, ValidationError } from '../../engine/orm/errors.js';
import { floatRound } from '../../engine/format/index.js';
import { closeDialog, m2o, note, notify, today, windowAction } from '../common.js';

const MODEL_FIELDS = ['method', 'method_number', 'method_period', 'method_progress_factor', 'prorata_computation_type', 'journal_id'];
const ACCOUNT_FIELDS = ['account_asset_id', 'account_depreciation_id', 'account_depreciation_expense_id'];
const BASIS_FIELDS = ['original_value', 'already_depreciated_amount_import', 'company_id', 'currency_id', 'acquisition_date', ...ACCOUNT_FIELDS];
const SCHEDULE_FIELDS = ['method', 'method_number', 'method_period', 'method_progress_factor', 'salvage_value', 'prorata_computation_type', 'resume_date', 'journal_id'];
const STATES: Record<string, string[]> = { draft: ['open', 'cancelled'], open: ['paused', 'close', 'cancelled', 'draft'], paused: ['open', 'close', 'cancelled'], close: ['open'], cancelled: ['draft'] };

async function lockAssets(env: Environment, ids: number[]): Promise<void> {
  if (ids.length) await env.cr.query('SELECT id FROM account_asset WHERE id = ANY($1) ORDER BY id FOR UPDATE', [ids]);
}

async function readAsset(env: Environment, id: number): Promise<Values> {
  const [asset] = await env.model('account.asset').read(id);
  if (!asset) throw new UserError({ en: 'The asset no longer exists.', ar: 'لم يعد الأصل موجوداً.' });
  return asset;
}

async function precision(env: Environment, asset: Values): Promise<number> {
  const company = m2o(asset.company_id) || env.companyId;
  const result = await env.cr.query<{ rounding: number }>(
    'SELECT coalesce(c.rounding, 0.01)::float8 AS rounding FROM res_company co LEFT JOIN res_currency c ON c.id = co.currency_id WHERE co.id = $1', [company],
  );
  return Number(result.rows[0]?.rounding) || 0.01;
}

/** Posted journal amounts, including posted reversals, determine carrying value. */
async function amounts(env: Environment, asset: Values): Promise<{ posted: number; book: number; residual: number; disposed: boolean; rounding: number }> {
  const result = await env.cr.query<{ posted: number; disposed: boolean }>(
    `SELECT coalesce(sum(CASE WHEN coalesce(m.asset_move_type, origin.asset_move_type, 'depreciation') = 'depreciation'
                            AND l.account_id = a.account_depreciation_id THEN coalesce(l.credit, 0) - coalesce(l.debit, 0) ELSE 0 END), 0)::float8 AS posted,
            coalesce(bool_or(m.asset_id = a.id AND m.asset_move_type IN ('sale', 'disposal')), false) AS disposed
     FROM account_asset a LEFT JOIN account_move origin ON origin.asset_id = a.id
     LEFT JOIN account_move m ON m.id = origin.id OR (m.reversed_entry_id = origin.id AND m.asset_id IS NULL)
     LEFT JOIN account_move_line l ON l.move_id = m.id
     WHERE a.id = $1 AND m.state = 'posted'`, [asset.id],
  );
  const rounding = await precision(env, asset);
  const posted = floatRound(Number(result.rows[0]?.posted || 0), rounding);
  const disposed = Boolean(result.rows[0]?.disposed);
  const book = disposed ? 0 : floatRound(Number(asset.original_value || 0) - Number(asset.already_depreciated_amount_import || 0) - posted, rounding);
  return { posted, book, residual: disposed ? 0 : floatRound(Math.max(0, book - Number(asset.salvage_value || 0)), rounding), disposed, rounding };
}

async function refresh(env: Environment, ids: number[]): Promise<void> {
  for (const id of [...new Set(ids)]) {
    const asset = await readAsset(env, id);
    const current = await amounts(env, asset);
    const closed = current.disposed || (asset.state === 'open' && asset.method !== 'no_depreciation' && current.residual <= current.rounding / 2);
    await env.cr.query('UPDATE account_asset SET book_value = $2, value_residual = $3, state = $4 WHERE id = $1', [id, current.book, current.residual, closed ? 'close' : asset.state]);
  }
}

function requireState(asset: Values, allowed: string[]): void {
  if (!allowed.includes(String(asset.state))) throw new UserError({ en: `This action is unavailable for an asset in state ${asset.state}.`, ar: `هذا الإجراء غير متاح لأصل في حالة ${asset.state}.` });
}

function validDate(value: unknown): string {
  const date = String(value || '').slice(0, 10);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new ValidationError({ en: 'Enter a valid date.', ar: 'أدخل تاريخاً صحيحاً.' });
  return date;
}

/** Anchor to the first of the month, avoiding Jan 29/30/31 overflow into March. */
function periodEnd(start: string, months: number, index: number): string {
  const [year, month] = start.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1 + months * (index + 1), 0)).toISOString().slice(0, 10);
}

async function postedMoves(env: Environment, id: number): Promise<Values[]> {
  return env.model('account.move').searchRead([['asset_id', '=', id], ['state', '=', 'posted'], '|', ['asset_move_type', '=', 'depreciation'], ['asset_move_type', '=', false]], ['id', 'date', 'depreciation_value'], { order: 'date asc, id asc' });
}

async function removeDrafts(env: Environment, id: number): Promise<void> {
  const drafts = await env.model('account.move').search([['asset_id', '=', id], ['state', '=', 'draft'], '|', ['asset_move_type', '=', 'depreciation'], ['asset_move_type', '=', false]]);
  if (drafts.length) await env.model('account.move').unlink(drafts);
}

async function rebuild(env: Environment, id: number): Promise<void> {
  await lockAssets(env, [id]);
  const asset = await readAsset(env, id);
  requireState(asset, ['draft', 'open', 'paused']);
  const current = await amounts(env, asset);
  if (current.disposed) throw new UserError({ en: 'A disposed asset cannot be depreciated again.', ar: 'لا يمكن إهلاك أصل تم التصرف فيه مرة أخرى.' });
  const posted = await postedMoves(env, id);
  const count = Math.ceil(Number(asset.method_number));
  const months = Number(asset.method_period);
  if (asset.method !== 'no_depreciation' && (!Number.isFinite(count) || count <= 0 || ![1, 12].includes(months))) throw new ValidationError({ en: 'Set a positive depreciation duration and a monthly or yearly period.', ar: 'حدد مدة إهلاك موجبة وفترة شهرية أو سنوية.' });
  const slots = count - posted.length;
  if (asset.method !== 'no_depreciation' && current.residual > current.rounding / 2 && slots <= 0) throw new UserError({ en: 'The duration must include remaining periods after the posted depreciation entries.', ar: 'يجب أن تتضمن المدة فترات متبقية بعد قيود الإهلاك المرحّلة.' });
  if (asset.method !== 'no_depreciation' && current.residual > current.rounding / 2 && (!m2o(asset.account_depreciation_id) || !m2o(asset.account_depreciation_expense_id))) throw new UserError({ en: 'Set the depreciation and expense accounts before computing the schedule.', ar: 'حدد حسابي الإهلاك والمصروف قبل احتساب الجدول.' });
  await removeDrafts(env, id);
  if (asset.method === 'no_depreciation' || current.residual <= current.rounding / 2) { await refresh(env, [id]); return; }
  const start = validDate(asset.acquisition_date || today());
  const latest = posted.at(-1)?.date ? String(posted.at(-1)!.date).slice(0, 10) : '';
  const resume = asset.resume_date ? validDate(asset.resume_date) : '';
  const dates: string[] = [];
  let calendarIndex = posted.length;
  for (let i = 0; i < slots; i++) {
    let date = periodEnd(start, months, calendarIndex++);
    while ((latest && date <= latest) || (resume && date < resume) || (dates.length && date <= dates.at(-1)!)) date = periodEnd(start, months, calendarIndex++);
    dates.push(date);
  }
  let remaining = current.residual;
  let cumulative = Number(asset.already_depreciated_amount_import || 0) + current.posted;
  const factor = Number(asset.method_progress_factor) || 2 / count;
  for (let i = 0; i < slots && remaining > current.rounding / 2; i++) {
    let amount = remaining / (slots - i);
    if (asset.method === 'degressive') amount = Math.min(remaining, (Number(asset.original_value || 0) - cumulative) * factor);
    if (asset.method === 'degressive_then_linear') amount = Math.max(amount, (Number(asset.original_value || 0) - cumulative) * factor);
    if (i === slots - 1) amount = remaining;
    amount = floatRound(Math.min(remaining, amount), current.rounding);
    if (amount <= 0) continue;
    remaining = floatRound(remaining - amount, current.rounding);
    cumulative = floatRound(cumulative + amount, current.rounding);
    await env.model('account.move').create({
      move_type: 'entry', date: dates[i], journal_id: m2o(asset.journal_id) || false, ref: `${asset.name} (${posted.length + i + 1}/${count})`, asset_id: id,
      asset_move_type: 'depreciation', depreciation_value: amount, asset_depreciated_value: cumulative, asset_remaining_value: remaining,
      company_id: m2o(asset.company_id) || env.companyId, currency_id: m2o(asset.currency_id) || false,
      line_ids: [[0, 0, { name: asset.name, account_id: m2o(asset.account_depreciation_expense_id), debit: amount, credit: 0 }], [0, 0, { name: asset.name, account_id: m2o(asset.account_depreciation_id), debit: 0, credit: amount }]],
    });
  }
  await refresh(env, [id]);
}

async function linkedAssets(env: Environment, ids: number[]): Promise<number[]> {
  if (!ids.length) return [];
  const result = await env.cr.query<{ asset_id: number }>('SELECT DISTINCT coalesce(m.asset_id, origin.asset_id) AS asset_id FROM account_move m LEFT JOIN account_move origin ON origin.id = m.reversed_entry_id WHERE m.id = ANY($1)', [ids]);
  return result.rows.map((row) => Number(row.asset_id)).filter(Boolean);
}

async function defaultsFromModel(env: Environment, id: number): Promise<Values> {
  const [model] = await env.model('account.depreciation.model').read(id, [...MODEL_FIELDS, 'salvage_value_percent']);
  if (!model) return {};
  const values: Values = {};
  for (const key of MODEL_FIELDS) if (model[key] !== false && model[key] !== undefined) values[key] = key === 'journal_id' ? m2o(model[key]) : model[key];
  return values;
}

function installWizard(registry: Registry): void {
  const field = (name: string, type: FieldDef['type'], en: string, ar: string, extra: Partial<FieldDef> = {}): FieldDef => ({ name, type, label: { en, ar }, ...extra });
  const selections = registry.models['account.asset'].fields;
  registry.models['account.asset'].fields.method_progress_factor ??= field('method_progress_factor', 'float', 'Declining Factor', 'عامل الانخفاض');
  registry.models['account.asset'].fields.pause_date ??= field('pause_date', 'date', 'Paused From', 'متوقف من');
  registry.models['account.asset'].fields.resume_date ??= field('resume_date', 'date', 'Resume From', 'استئناف من');
  registry.models['account.asset'].fields.depreciation_move_ids.copy = false;
  const fields: Record<string, FieldDef> = {
    asset_id: field('asset_id', 'many2one', 'Asset', 'الأصل', { required: true, relation: 'account.asset', readonly: true }),
    operation: field('operation', 'selection', 'Action', 'الإجراء', { required: true, selection: [{ value: 'modify', label: { en: 'Modify Depreciation', ar: 'تعديل الإهلاك' } }, { value: 'pause', label: { en: 'Pause', ar: 'إيقاف مؤقت' } }, { value: 'dispose', label: { en: 'Sell or Dispose', ar: 'بيع أو تصرف' } }] }),
    date: field('date', 'date', 'Effective Date', 'تاريخ السريان', { required: true }),
    original_value: field('original_value', 'monetary', 'Asset Value', 'قيمة الأصل'),
    salvage_value: field('salvage_value', 'monetary', 'Not Depreciable', 'غير قابل للإهلاك'),
    method: { ...selections.method, readonly: false }, method_number: { ...selections.method_number, readonly: false }, method_period: { ...selections.method_period, readonly: false },
    method_progress_factor: field('method_progress_factor', 'float', 'Declining Factor', 'عامل الانخفاض'),
    account_id: field('account_id', 'many2one', 'Gain or Loss Account', 'حساب الربح أو الخسارة', { relation: 'account.account' }),
    sale_invoice_line_id: field('sale_invoice_line_id', 'many2one', 'Sale Invoice Line', 'بند فاتورة البيع', { relation: 'account.move.line' }),
    reason: field('reason', 'char', 'Reason', 'السبب'),
  };
  registry.models['account.asset.modify'] ??= { name: 'account.asset.modify', description: { en: 'Modify Asset', ar: 'تعديل الأصل' }, table: 'account_asset_modify', recName: 'reason', order: 'id', fields, access: [], transient: true };
  const node = (name: string, invisible?: string) => ({ kind: 'field' as const, name, decorations: {}, attrs: {}, ...(invisible ? { invisible } : {}) });
  registry.views['account.asset.modify|form|rodeo'] = {
    key: 'account.asset.modify|form|rodeo', id: null, model: 'account.asset.modify', type: 'form', toolbar: { print: [], action: [] },
    arch: { type: 'form', attrs: {}, string: { en: 'Modify Asset', ar: 'تعديل الأصل' }, body: [
      { kind: 'group', children: [node('asset_id'), node('operation'), node('date'), node('reason')] },
      { kind: 'group', invisible: "operation != 'modify'", children: [node('original_value'), node('salvage_value'), node('method'), node('method_number'), node('method_period'), node('method_progress_factor', "method not in ['degressive', 'degressive_then_linear']")] },
      { kind: 'group', invisible: "operation == 'pause'", children: [node('account_id'), node('sale_invoice_line_id', "operation != 'dispose'")] },
      { kind: 'element', tag: 'footer', attrs: {}, children: [{ kind: 'button', type: 'object', name: 'modify', string: { en: 'Apply', ar: 'تطبيق' }, class: 'btn-primary', attrs: {} }, { kind: 'button', type: 'object', special: 'cancel', string: { en: 'Discard', ar: 'تجاهل' }, class: 'btn-secondary', attrs: {} }] },
    ] },
  };
}

async function modify(env: Environment, wizard: Values): Promise<void> {
  const id = m2o(wizard.asset_id);
  if (!id) throw new UserError({ en: 'Select an asset.', ar: 'اختر أصلاً.' });
  await lockAssets(env, [id]);
  const asset = await readAsset(env, id);
  requireState(asset, ['open', 'paused']);
  const date = validDate(wizard.date);
  const posted = await postedMoves(env, id);
  if (date < String(asset.acquisition_date).slice(0, 10) || (posted.length && date < String(posted.at(-1)!.date).slice(0, 10))) throw new UserError({ en: 'The effective date must follow acquisition and posted depreciation.', ar: 'يجب أن يأتي تاريخ السريان بعد الاقتناء والإهلاك المرحّل.' });
  if (wizard.operation === 'pause') { await env.model('account.asset').write(id, { state: 'paused', pause_date: date }); return; }
  const current = await amounts(env, asset);
  if (wizard.operation === 'dispose') {
    const fixed = m2o(asset.account_asset_id); const accumulated = m2o(asset.account_depreciation_id); const gainLoss = m2o(wizard.account_id);
    if (!fixed || !accumulated || !gainLoss) throw new UserError({ en: 'Set the fixed asset, accumulated depreciation, and gain or loss accounts.', ar: 'حدد حسابات الأصل الثابت والإهلاك المتراكم والربح أو الخسارة.' });
    let proceeds = 0; let salesAccount: number | false = false;
    const invoiceLine = m2o(wizard.sale_invoice_line_id);
    if (invoiceLine) {
      const [line] = await env.model('account.move.line').read(invoiceLine, ['move_id', 'account_id', 'price_subtotal']);
      const [invoice] = await env.model('account.move').read(m2o(line?.move_id) as number, ['state', 'move_type', 'company_id']);
      salesAccount = m2o(line?.account_id);
      if (!line || !invoice || invoice.state !== 'posted' || invoice.move_type !== 'out_invoice' || m2o(invoice.company_id) !== m2o(asset.company_id) || !salesAccount) throw new UserError({ en: 'Select a posted customer invoice line from the asset company.', ar: 'اختر بند فاتورة عميل مرحّلة من شركة الأصل.' });
      proceeds = floatRound(Number(line.price_subtotal || 0), current.rounding);
    }
    const depreciation = floatRound(Number(asset.original_value || 0) - current.book, current.rounding);
    const difference = floatRound(current.book - proceeds, current.rounding);
    const lines: unknown[] = [[0, 0, { name: asset.name, account_id: fixed, debit: 0, credit: Number(asset.original_value) }]];
    if (depreciation) lines.push([0, 0, { name: asset.name, account_id: accumulated, debit: depreciation, credit: 0 }]);
    if (proceeds) lines.push([0, 0, { name: asset.name, account_id: salesAccount, debit: proceeds, credit: 0 }]);
    if (difference) lines.push([0, 0, { name: asset.name, account_id: gainLoss, debit: Math.max(difference, 0), credit: Math.max(-difference, 0) }]);
    const move = await env.model('account.move').create({ move_type: 'entry', date, journal_id: m2o(asset.journal_id) || false, company_id: m2o(asset.company_id), currency_id: m2o(asset.currency_id), asset_id: id, asset_move_type: invoiceLine ? 'sale' : 'disposal', ref: `${asset.name}: ${wizard.reason || (invoiceLine ? 'Sale' : 'Disposal')}`, line_ids: lines });
    await env.model('account.move').callButton(move, 'action_post');
    await removeDrafts(env, id);
    await env.model('account.asset').write(id, { state: 'close' });
    await refresh(env, [id]);
    return;
  }
  if (wizard.operation !== 'modify') throw new ValidationError({ en: 'Choose a supported asset action.', ar: 'اختر إجراء أصل مدعوماً.' });
  const vals: Values = {};
  for (const key of ['original_value', 'salvage_value', 'method', 'method_number', 'method_period', 'method_progress_factor']) vals[key] = wizard[key];
  const delta = floatRound(Number(wizard.original_value) - Number(asset.original_value), current.rounding);
  if (delta && posted.length) {
    const account = m2o(wizard.account_id); const fixed = m2o(asset.account_asset_id);
    if (!account || !fixed) throw new UserError({ en: 'Choose the fixed asset and gain or loss accounts for the value adjustment.', ar: 'اختر حسابي الأصل الثابت والربح أو الخسارة لتعديل القيمة.' });
    const move = await env.model('account.move').create({ move_type: 'entry', date, journal_id: m2o(asset.journal_id) || false, company_id: m2o(asset.company_id), currency_id: m2o(asset.currency_id), asset_id: id, asset_move_type: delta > 0 ? 'positive_revaluation' : 'negative_revaluation', ref: `${asset.name}: ${wizard.reason || 'Value adjustment'}`, line_ids: [[0, 0, { name: asset.name, account_id: fixed, debit: Math.max(delta, 0), credit: Math.max(-delta, 0) }], [0, 0, { name: asset.name, account_id: account, debit: Math.max(-delta, 0), credit: Math.max(delta, 0) }]] });
    await env.model('account.move').callButton(move, 'action_post');
  }
  await env.with({ context: { asset_value_adjustment: id } }).model('account.asset').write(id, vals);
  await rebuild(env, id);
}

export function registerAccountAssets(registry: Registry): void {
  installWizard(registry);
  registerModelHooks('account.asset', {
    defaults: (env) => ({ state: 'draft', method: 'linear', method_number: 5, method_period: '12', method_progress_factor: 0, prorata_computation_type: 'none', acquisition_date: today(), company_id: env.companyId, original_value: 0, salvage_value: 0, already_depreciated_amount_import: 0 }),
    noCopy: ['state', 'book_value', 'value_residual', 'already_depreciated_amount_import', 'depreciation_move_ids', 'original_move_line_ids', 'account_move_id', 'pause_date', 'resume_date'],
    tracked: ['state', 'original_value', 'method_number'],
    beforeCreate: async (env, values) => {
      const out = { ...values };
      const modelId = m2o(out.model_id);
      if (modelId) Object.assign(out, await defaultsFromModel(env, modelId));
      const company = m2o(out.company_id) || env.companyId;
      const [co] = await env.model('res.company').read(company, ['currency_id']);
      out.currency_id = m2o(co.currency_id) || false;
      const fixed = m2o(out.account_asset_id);
      if (fixed) {
        const [account] = await env.model('account.account').read(fixed, ['asset_depreciation_account_id', 'asset_expense_account_id']);
        if (!m2o(out.account_depreciation_id)) out.account_depreciation_id = m2o(account.asset_depreciation_account_id);
        if (!m2o(out.account_depreciation_expense_id)) out.account_depreciation_expense_id = m2o(account.asset_expense_account_id);
      }
      return out;
    },
    beforeWrite: async (env, ids, vals) => {
      await lockAssets(env, ids);
      for (const id of ids) {
        const asset = await readAsset(env, id);
        const posted = await postedMoves(env, id);
        if ('state' in vals && vals.state !== asset.state) {
          if (!STATES[String(asset.state)]?.includes(String(vals.state))) throw new UserError({ en: 'This asset state transition is unavailable.', ar: 'هذا الانتقال بين حالات الأصل غير متاح.' });
          if (vals.state === 'draft' && posted.length) throw new UserError({ en: 'An asset with posted depreciation cannot return to draft.', ar: 'لا يمكن إعادة أصل له إهلاك مرحّل إلى المسودة.' });
          if (vals.state === 'cancelled' && posted.length) throw new UserError({ en: 'Use Sell or Dispose for an asset with posted depreciation.', ar: 'استخدم البيع أو التصرف لأصل له إهلاك مرحّل.' });
          if (vals.state === 'open' && (await amounts(env, asset)).disposed) throw new UserError({ en: 'A disposed asset cannot return to running.', ar: 'لا يمكن إعادة أصل تم التصرف فيه إلى حالة جاري.' });
        }
        if (asset.state === 'close' || asset.state === 'cancelled') {
          if ([...BASIS_FIELDS, ...SCHEDULE_FIELDS].some((key) => key in vals)) throw new UserError({ en: 'Reopen the asset before changing its depreciation settings.', ar: 'أعد فتح الأصل قبل تغيير إعدادات الإهلاك.' });
        }
        if (posted.length && BASIS_FIELDS.some((key) => key in vals && (key.endsWith('_id') ? m2o(vals[key]) !== m2o(asset[key]) : vals[key] !== asset[key]))) {
          const permitted = env.context.asset_value_adjustment === id && Object.keys(vals).every((key) => !BASIS_FIELDS.includes(key) || key === 'original_value');
          if (!permitted) throw new UserError({ en: 'Use Modify Depreciation to change the value of an asset with posted entries; its original accounting basis is protected.', ar: 'استخدم تعديل الإهلاك لتغيير قيمة أصل له قيود مرحّلة؛ أساسه المحاسبي الأصلي محمي.' });
        }
      }
      return vals;
    },
    constraints: [async (env, ids) => {
      for (const id of ids) {
        const asset = await readAsset(env, id); const current = await amounts(env, asset);
        const original = Number(asset.original_value); const salvage = Number(asset.salvage_value); const imported = Number(asset.already_depreciated_amount_import);
        if (![original, salvage, imported].every(Number.isFinite) || original < 0 || salvage < 0 || imported < 0 || salvage + imported + current.posted > original + current.rounding / 2) throw new ValidationError({ en: 'Asset value must cover salvage value and all imported or posted depreciation.', ar: 'يجب أن تغطي قيمة الأصل القيمة المتبقية وجميع مبالغ الإهلاك المستوردة أو المرحّلة.' });
        if (!['linear', 'degressive', 'degressive_then_linear', 'no_depreciation'].includes(String(asset.method))) throw new ValidationError({ en: 'Choose a supported depreciation method.', ar: 'اختر طريقة إهلاك مدعومة.' });
        if (Number(asset.method_progress_factor) < 0 || Number(asset.method_progress_factor) > 1) throw new ValidationError({ en: 'The declining factor must be between zero and one.', ar: 'يجب أن يكون عامل الانخفاض بين صفر وواحد.' });
      }
    }],
    computes: [{ fields: ['book_value', 'value_residual'], depends: ['original_value', 'salvage_value', 'already_depreciated_amount_import', 'depreciation_move_ids.state', 'depreciation_move_ids.line_ids'], compute: async (env, ids) => {
      const values: Record<number, Values> = {};
      for (const id of ids) { const asset = await readAsset(env, id); const current = await amounts(env, asset); values[id] = { book_value: current.book, value_residual: current.residual }; }
      return values;
    } }],
    onUnlink: async (env, ids) => { await lockAssets(env, ids); for (const id of ids) { if ((await postedMoves(env, id)).length || (await amounts(env, await readAsset(env, id))).disposed) throw new UserError({ en: 'Archive an asset with posted accounting entries instead of deleting it.', ar: 'أرشف أصلاً له قيود محاسبية مرحّلة بدلاً من حذفه.' }); await removeDrafts(env, id); } },
    onchange: {
      model_id: async (env, values) => m2o(values.model_id) ? { value: await defaultsFromModel(env, m2o(values.model_id) as number) } : {},
      original_value: async (_env, values) => ({ value: { book_value: Number(values.original_value || 0) - Number(values.already_depreciated_amount_import || 0), value_residual: Number(values.original_value || 0) - Number(values.already_depreciated_amount_import || 0) - Number(values.salvage_value || 0) } }),
    },
    methods: {
      compute_depreciation_board: async (env, ids) => { for (const id of ids) await rebuild(env, id); },
      validate: async (env, ids) => { await lockAssets(env, ids); for (const id of ids) { const asset = await readAsset(env, id); requireState(asset, ['draft']); if (Number(asset.original_value) <= 0) throw new UserError({ en: 'Set a positive asset value before confirming.', ar: 'حدد قيمة أصل موجبة قبل التأكيد.' }); await rebuild(env, id); await env.model('account.asset').write(id, { state: 'open' }); await refresh(env, [id]); await note(env, 'account.asset', id, { en: 'Asset confirmed: depreciation running.', ar: 'تم تأكيد الأصل: الإهلاك جارٍ.' }); } },
      resume_after_pause: async (env, ids, context) => { await lockAssets(env, ids); for (const id of ids) { const asset = await readAsset(env, id); requireState(asset, ['paused']); const date = validDate(context.date || today()); if (asset.pause_date && date < String(asset.pause_date).slice(0, 10)) throw new UserError({ en: 'Resume date cannot precede the pause date.', ar: 'لا يمكن أن يسبق تاريخ الاستئناف تاريخ الإيقاف.' }); await env.model('account.asset').write(id, { resume_date: date }); await rebuild(env, id); await env.model('account.asset').write(id, { state: 'open' }); await refresh(env, [id]); } },
      set_to_running: async (env, ids) => { await lockAssets(env, ids); for (const id of ids) { const asset = await readAsset(env, id); requireState(asset, ['close']); if ((await amounts(env, asset)).residual <= 0) throw new UserError({ en: 'The asset has no remaining depreciable value.', ar: 'لا توجد قيمة متبقية قابلة للإهلاك للأصل.' }); await env.model('account.asset').write(id, { state: 'open' }); await rebuild(env, id); } },
      action_asset_modify: async (env, ids) => { for (const id of ids) requireState(await readAsset(env, id), ['open', 'paused']); if (ids.length !== 1) throw new UserError({ en: 'Modify one asset at a time.', ar: 'عدّل أصلاً واحداً في كل مرة.' }); return windowAction('account.asset.modify', { en: 'Modify Asset', ar: 'تعديل الأصل' }, { viewMode: 'form', target: 'new', context: { default_asset_id: ids[0] } }); },
      set_to_cancelled: async (env, ids) => { await env.model('account.asset').write(ids, { state: 'cancelled' }); for (const id of ids) await removeDrafts(env, id); },
      set_to_draft: async (env, ids) => { await env.model('account.asset').write(ids, { state: 'draft' }); },
      action_open_linked_assets: async (_env, ids) => windowAction('account.asset', { en: 'Linked Assets', ar: 'الأصول المرتبطة' }, { domain: [['parent_id', 'in', ids]] }),
      open_related_entries: async (_env, ids) => windowAction('account.move', { en: 'Related Entries', ar: 'القيود المرتبطة' }, { domain: [['asset_id', 'in', ids]] }),
      open_entries: async (_env, ids) => windowAction('account.move', { en: 'Depreciation Entries', ar: 'قيود الإهلاك' }, { domain: [['asset_id', 'in', ids], ['asset_move_type', '=', 'depreciation']] }),
      open_increase: async (_env, ids) => windowAction('account.asset', { en: 'Gross Increases', ar: 'الزيادات الإجمالية' }, { domain: [['parent_id', 'in', ids]] }),
      open_parent_id: async (env, ids) => { const asset = await readAsset(env, ids[0]); return m2o(asset.parent_id) ? windowAction('account.asset', { en: 'Parent Asset', ar: 'الأصل الرئيسي' }, { resId: m2o(asset.parent_id) as number }) : notify({ en: 'This asset has no parent.', ar: 'ليس لهذا الأصل أصل رئيسي.' }, 'info'); },
      action_open_linked_loans: async (_env, ids) => windowAction('account.loan', { en: 'Loans', ar: 'القروض' }, { domain: [['asset_group_id.asset_ids', 'in', ids]] }),
      action_open_vehicle: async (env, ids) => { const asset = await readAsset(env, ids[0]); return m2o(asset.vehicle_id) ? windowAction('fleet.vehicle', { en: 'Vehicle', ar: 'المركبة' }, { resId: m2o(asset.vehicle_id) as number }) : notify({ en: 'No vehicle is linked to this asset.', ar: 'لا توجد مركبة مرتبطة بهذا الأصل.' }, 'info'); },
    },
  });
  registerModelHooks('account.move', {
    noCopy: ['asset_id', 'asset_move_type', 'depreciation_value', 'asset_depreciated_value', 'asset_remaining_value'],
    beforeWrite: async (env, ids, vals) => {
      const assets = await linkedAssets(env, ids); await lockAssets(env, assets);
      if (vals.state === 'posted') for (const id of ids) { const [move] = await env.model('account.move').read(id, ['asset_id', 'asset_move_type', 'state']); if (m2o(move.asset_id) && move.state !== 'posted') requireState(await readAsset(env, m2o(move.asset_id) as number), move.asset_move_type === 'depreciation' || !move.asset_move_type ? ['open'] : ['open', 'paused']); }
      if ('depreciation_value' in vals) {
        const rows = await env.model('account.move').read(ids, ['state', 'asset_id', 'asset_move_type']);
        if (rows.some((row) => row.state === 'posted')) throw new UserError({ en: 'Posted depreciation amounts cannot be edited.', ar: 'لا يمكن تعديل مبالغ الإهلاك المرحّلة.' });
        for (const move of rows) if (m2o(move.asset_id) && (!move.asset_move_type || move.asset_move_type === 'depreciation')) {
          const asset = await readAsset(env, m2o(move.asset_id) as number);
          const amount = floatRound(Number(vals.depreciation_value), await precision(env, asset));
          if (!Number.isFinite(amount) || amount <= 0) throw new ValidationError({ en: 'Depreciation must be a positive amount.', ar: 'يجب أن يكون الإهلاك مبلغاً موجباً.' });
          const lines = await env.model('account.move.line').searchRead([['move_id', '=', move.id]], ['id', 'account_id']);
          if (lines.length !== 2) throw new UserError({ en: 'Edit the journal items directly for a depreciation entry with more than two lines.', ar: 'عدّل بنود اليومية مباشرة لقيد إهلاك له أكثر من بندين.' });
          for (const line of lines) {
            const debit = m2o(line.account_id) === m2o(asset.account_depreciation_expense_id);
            await env.model('account.move.line').write(Number(line.id), { debit: debit ? amount : 0, credit: debit ? 0 : amount });
          }
        }
      }
      return vals;
    },
    onWrite: async (env, ids) => { await refresh(env, await linkedAssets(env, ids)); },
  });
  registerModelHooks('account.asset.modify', {
    defaults: async (env) => { const id = Number(env.context.default_asset_id || env.context.active_id || 0); if (!id) return { operation: 'modify', date: today() }; const asset = await readAsset(env, id); const defaults: Values = { asset_id: id, operation: 'modify', date: today() }; for (const key of ['original_value', 'salvage_value', 'method', 'method_number', 'method_period', 'method_progress_factor']) defaults[key] = asset[key]; return defaults; },
    methods: { modify: async (env, ids) => { for (const id of ids) { const [wizard] = await env.model('account.asset.modify').read(id); await modify(env, wizard); } return closeDialog(); } },
  });
}
