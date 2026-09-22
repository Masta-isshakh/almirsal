import { registerModelHooks, type Values } from '../../engine/orm/hooks.js';
import type { Environment } from '../../engine/orm/env.js';
import { UserError } from '../../engine/orm/errors.js';
import { nextByCode } from '../../engine/orm/sequence.js';
import { postMessage } from '../../engine/orm/mail.js';
import { ensureSequence, m2o, note, notify, now, openRecords, today, windowAction } from '../common.js';

/**
 * D-11 — Approvals: a request takes its rules from its category (which
 * fields are required, default approvers, manager approval, minimum
 * approvers, automated numbering), moves New → Submitted → Approved /
 * Refused / Cancelled through the approvers' individual statuses, notifies
 * approvers with an activity, and can turn its product lines into RFQs.
 */

const REQUIRED_FIELDS: [flag: string, field: string, label: { en: string; ar: string }][] = [
  ['has_date', 'date', { en: 'Date', ar: 'التاريخ' }], ['has_period', 'date_start', { en: 'Period', ar: 'الفترة' }], ['has_quantity', 'quantity', { en: 'Quantity', ar: 'الكمية' }],
  ['has_amount', 'amount', { en: 'Amount', ar: 'المبلغ' }], ['has_reference', 'reference', { en: 'Reference', ar: 'المرجع' }], ['has_partner', 'partner_id', { en: 'Contact', ar: 'جهة الاتصال' }],
  ['has_location', 'location', { en: 'Location', ar: 'الموقع' }],
];

async function categoryOf(env: Environment, categoryId: number): Promise<Values | null> {
  const rows = await env.sudo().model('approval.category').read(categoryId, ['name', 'automated_sequence', 'sequence_code', 'manager_approval', 'approval_minimum', 'requirer_document', 'has_product', 'approver_ids', ...REQUIRED_FIELDS.map(([flag]) => flag)]);
  return rows[0] ?? null;
}

/** The manager (user) of the requester's employee record. */
async function managerUser(env: Environment, ownerId: number): Promise<number | null> {
  if (!env.registry.models['hr.employee']) return null;
  const row = await env.cr.query<{ uid: number | null }>(`SELECT m.user_id AS uid FROM hr_employee e JOIN hr_employee m ON m.id = e.parent_id WHERE e.user_id = $1 AND coalesce(e.active, true) ORDER BY e.id LIMIT 1`, [ownerId]);
  return row.rows[0]?.uid ?? null;
}

/** Recompute the request status from its approvers. */
async function refreshStatus(env: Environment, requestId: number): Promise<string> {
  const [request] = await env.model('approval.request').read(requestId, ['request_status', 'approval_minimum', 'category_id']);
  if (!['pending', 'approved'].includes(String(request.request_status))) return String(request.request_status);
  const approvers = await env.model('approval.approver').searchRead([['approval_request_id', '=', requestId]], ['status', 'required', 'sequence', 'user_id'], { order: 'sequence asc, id asc' });
  if (approvers.some((a) => a.status === 'refused')) { await env.model('approval.request').write(requestId, { request_status: 'refused' }); return 'refused'; }
  const approved = approvers.filter((a) => a.status === 'approved');
  const requiredOk = approvers.filter((a) => a.required).every((a) => a.status === 'approved');
  const minimum = Math.max(1, Number(request.approval_minimum ?? 1));
  if (requiredOk && approved.length >= Math.min(minimum, approvers.length || 1) && approvers.length > 0) {
    await env.model('approval.request').write(requestId, { request_status: 'approved' });
    return 'approved';
  }
  // Sequential approvals: the next waiting approver becomes pending.
  const nextWaiting = approvers.find((a) => a.status === 'waiting');
  if (nextWaiting && !approvers.some((a) => a.status === 'pending')) await env.model('approval.approver').write(nextWaiting.id as number, { status: 'pending' });
  await env.model('approval.request').write(requestId, { request_status: 'pending' });
  return 'pending';
}

async function myApprover(env: Environment, requestId: number): Promise<Values | null> {
  const rows = await env.model('approval.approver').searchRead([['approval_request_id', '=', requestId], ['user_id', '=', env.uid]], ['status', 'required'], { limit: 1 });
  return rows[0] ?? null;
}

export function registerApprovals(): void {
  registerModelHooks('approval.request', {
    defaults: (env) => ({ request_status: 'new', request_owner_id: env.uid, company_id: env.companyId, active: true }),
    noCopy: ['request_status', 'date_confirmed', 'approver_ids', 'message_ids', 'activity_ids'],
    tracked: ['request_status', 'request_owner_id'],
    creationMessage: { en: 'Approval request created', ar: 'تم إنشاء طلب الموافقة' },
    beforeCreate: async (env, vals) => {
      const out = { ...vals };
      const categoryId = m2o(out.category_id);
      if (!categoryId) return out;
      const category = await categoryOf(env, categoryId);
      if (!category) return out;
      for (const flag of REQUIRED_FIELDS.map(([f]) => f).concat(['has_product', 'requirer_document'])) if (category[flag] !== undefined && out[flag] === undefined) out[flag] = category[flag];
      if (out.approval_minimum === undefined) out.approval_minimum = category.approval_minimum ?? 1;
      if (category.automated_sequence && category.sequence_code && (!out.name || out.name === 'New')) {
        await ensureSequence(env, String(category.sequence_code), String(category.sequence_code));
        out.name = await nextByCode(env, String(category.sequence_code));
      }
      if (!out.name) out.name = String(category.name ?? 'Approval');
      return out;
    },
    onCreate: async (env, ids) => {
      for (const id of ids) {
        const [request] = await env.model('approval.request').read(id, ['category_id', 'request_owner_id', 'approver_ids']);
        if ((request.approver_ids as number[]).length) continue;
        const categoryId = m2o(request.category_id);
        if (!categoryId) continue;
        const category = await categoryOf(env, categoryId);
        const approvers: { user_id: number; required: boolean; sequence: number }[] = [];
        if (category?.manager_approval) {
          const manager = await managerUser(env, m2o(request.request_owner_id) || env.uid);
          if (manager) approvers.push({ user_id: manager, required: true, sequence: 1 });
        }
        if (env.registry.models['approval.category.approver']) {
          const rows = await env.cr.query<{ user_id: number; required: boolean | null; sequence: number | null }>(`SELECT user_id, required, sequence FROM approval_category_approver WHERE approval_category_id = $1 AND user_id IS NOT NULL ORDER BY sequence, id`, [categoryId]);
          for (const row of rows.rows) if (!approvers.some((a) => a.user_id === Number(row.user_id))) approvers.push({ user_id: Number(row.user_id), required: Boolean(row.required), sequence: 10 + Number(row.sequence ?? 0) });
        }
        for (const approver of approvers) await env.model('approval.approver').create({ approval_request_id: id, user_id: approver.user_id, required: approver.required, sequence: approver.sequence, status: 'new', company_id: env.companyId });
      }
    },
    methods: {
      action_confirm: async (env, ids) => {
        const requests = env.model('approval.request');
        for (const id of ids) {
          const [request] = await requests.read(id, ['request_status', 'name', 'requirer_document', 'approver_ids', 'category_id', 'request_owner_id', ...REQUIRED_FIELDS.map(([, f]) => f), ...REQUIRED_FIELDS.map(([flag]) => flag), 'has_product', 'product_line_ids']);
          if (request.request_status !== 'new') throw new UserError({ en: 'Only requests to submit can be submitted.', ar: 'يمكن تقديم الطلبات في حالة "للتقديم" فقط.' });
          const missing = REQUIRED_FIELDS.filter(([flag, field]) => request[flag] === 'required' && (request[field] === false || request[field] === null || request[field] === undefined || request[field] === '' || request[field] === 0)).map(([, , label]) => label);
          if (request.has_product === 'required' && !(request.product_line_ids as number[]).length) missing.push({ en: 'Products', ar: 'المنتجات' });
          if (missing.length) throw new UserError({ en: `Please fill in: ${missing.map((m) => m.en).join(', ')}.`, ar: `يرجى تعبئة: ${missing.map((m) => m.ar).join('، ')}.` });
          if (request.requirer_document === 'required') {
            const attachments = await env.cr.query<{ n: number }>(`SELECT count(*)::int AS n FROM ir_attachment WHERE res_model = 'approval.request' AND res_id = $1`, [id]).catch(() => ({ rows: [{ n: 0 }] }));
            if (!attachments.rows[0]?.n) throw new UserError({ en: 'This category requires a document: attach it before submitting.', ar: 'تتطلب هذه الفئة مستنداً: أرفقه قبل التقديم.' });
          }
          const approverIds = request.approver_ids as number[];
          if (!approverIds.length) throw new UserError({ en: 'You have to add at least one approver to submit your request.', ar: 'يجب إضافة معتمد واحد على الأقل لتقديم طلبك.' });
          const approvers = await env.model('approval.approver').read(approverIds, ['sequence', 'user_id']);
          const sequential = new Set(approvers.map((a) => a.sequence)).size > 1;
          approvers.sort((a, b) => Number(a.sequence) - Number(b.sequence));
          for (const [index, approver] of approvers.entries()) {
            const status = sequential && index > 0 ? 'waiting' : 'pending';
            await env.model('approval.approver').write(approver.id as number, { status });
            const userId = m2o(approver.user_id);
            if (status === 'pending' && userId && env.registry.models['mail.activity']) {
              await env.sudo().model('mail.activity').create({ res_model: 'approval.request', res_id: id, user_id: userId, summary: `Approval request: ${request.name}`, date_deadline: today() }).catch(() => undefined);
            }
          }
          await requests.write(id, { request_status: 'pending', date_confirmed: now() });
          await note(env, 'approval.request', id, { en: 'Request submitted for approval.', ar: 'تم تقديم الطلب للموافقة.' });
        }
      },
      action_approve: async (env, ids) => {
        for (const id of ids) {
          const mine = await myApprover(env, id);
          if (!mine) throw new UserError({ en: 'You are not an approver of this request.', ar: 'لست معتمداً لهذا الطلب.' });
          if (mine.status === 'waiting') throw new UserError({ en: 'A previous approver must approve first.', ar: 'يجب أن يوافق المعتمد السابق أولاً.' });
          await env.model('approval.approver').write(mine.id as number, { status: 'approved' });
          await env.cr.query(`UPDATE mail_activity SET active = false WHERE res_model = 'approval.request' AND res_id = $1 AND user_id = $2`, [id, env.uid]).catch(() => undefined);
          const status = await refreshStatus(env, id);
          await note(env, 'approval.request', id, status === 'approved' ? { en: 'Request approved.', ar: 'تمت الموافقة على الطلب.' } : { en: 'Approved by one approver; waiting for the others.', ar: 'وافق معتمد واحد؛ بانتظار الآخرين.' });
        }
      },
      action_refuse: async (env, ids) => {
        for (const id of ids) {
          const mine = await myApprover(env, id);
          if (!mine) throw new UserError({ en: 'You are not an approver of this request.', ar: 'لست معتمداً لهذا الطلب.' });
          await env.model('approval.approver').write(mine.id as number, { status: 'refused' });
          await env.cr.query(`UPDATE mail_activity SET active = false WHERE res_model = 'approval.request' AND res_id = $1`, [id]).catch(() => undefined);
          await refreshStatus(env, id);
          await note(env, 'approval.request', id, { en: 'Request refused.', ar: 'تم رفض الطلب.' });
        }
      },
      action_withdraw: async (env, ids) => {
        for (const id of ids) {
          const mine = await myApprover(env, id);
          if (!mine) throw new UserError({ en: 'You are not an approver of this request.', ar: 'لست معتمداً لهذا الطلب.' });
          await env.model('approval.approver').write(mine.id as number, { status: 'pending' });
          await refreshStatus(env, id);
          await note(env, 'approval.request', id, { en: 'Approval withdrawn.', ar: 'تم سحب الموافقة.' });
        }
      },
      action_draft: async (env, ids) => {
        await env.model('approval.request').write(ids, { request_status: 'new', date_confirmed: false });
        await env.cr.query(`UPDATE approval_approver SET status = 'new' WHERE approval_request_id = ANY($1)`, [ids]);
      },
      action_cancel: async (env, ids) => {
        await env.model('approval.request').write(ids, { request_status: 'cancel' });
        await env.cr.query(`UPDATE approval_approver SET status = 'cancel' WHERE approval_request_id = ANY($1)`, [ids]);
        await env.cr.query(`UPDATE mail_activity SET active = false WHERE res_model = 'approval.request' AND res_id = ANY($1)`, [ids]).catch(() => undefined);
      },
      /** "Create RFQ's": one purchase order per vendor from the product lines. */
      action_create_purchase_orders: async (env, ids) => {
        if (!env.registry.models['purchase.order']) throw new UserError({ en: 'The Purchase app is not available.', ar: 'تطبيق المشتريات غير متاح.' });
        const created: number[] = [];
        for (const id of ids) {
          const [request] = await env.model('approval.request').read(id, ['name', 'product_line_ids', 'request_status']);
          if (request.request_status !== 'approved') throw new UserError({ en: 'Only approved requests can create RFQs.', ar: 'يمكن للطلبات المعتمدة فقط إنشاء طلبات عروض الأسعار.' });
          const lines = await env.model('approval.product.line').read(request.product_line_ids as number[], ['product_id', 'description', 'quantity', 'product_uom_id', 'seller_id']);
          const byVendor = new Map<number, Values[]>();
          for (const line of lines) {
            let vendor = 0;
            const sellerId = m2o(line.seller_id);
            if (sellerId) { const s = await env.cr.query<{ partner_id: number | null }>(`SELECT partner_id FROM product_supplierinfo WHERE id = $1`, [sellerId]).catch(() => ({ rows: [] as { partner_id: number | null }[] })); vendor = s.rows[0]?.partner_id ?? 0; }
            if (!vendor) { const productId = m2o(line.product_id); const s = productId ? await env.cr.query<{ partner_id: number | null }>(`SELECT si.partner_id FROM product_supplierinfo si JOIN product_product p ON p.product_tmpl_id = si.product_tmpl_id WHERE p.id = $1 ORDER BY si.sequence LIMIT 1`, [productId]).catch(() => ({ rows: [] as { partner_id: number | null }[] })) : { rows: [] as { partner_id: number | null }[] }; vendor = s.rows[0]?.partner_id ?? 0; }
            if (!vendor) throw new UserError({ en: `No vendor is set for ${line.description || 'a product line'}: add a vendor on the product or the line.`, ar: `لم يتم تحديد مورد لـ ${line.description || 'بند منتج'}: أضف مورداً على المنتج أو البند.` });
            (byVendor.get(vendor) ?? byVendor.set(vendor, []).get(vendor)!).push({ product_id: m2o(line.product_id), name: line.description || undefined, product_qty: line.quantity ?? 1, uom_id: m2o(line.product_uom_id) || false });
          }
          for (const [vendor, poLines] of byVendor) {
            const poId = await env.model('purchase.order').create({ partner_id: vendor, origin: String(request.name), order_line: poLines.map((l) => [0, 0, l]) });
            created.push(poId);
          }
          if (created.length) await note(env, 'approval.request', id, { en: `${created.length} request(s) for quotation created.`, ar: `تم إنشاء ${created.length} طلب عرض سعر.` });
        }
        return openRecords('purchase.order', { en: 'Requests for Quotation', ar: 'طلبات عروض الأسعار' }, created);
      },
      action_open_purchase_orders: async (env, ids) => {
        const [request] = await env.model('approval.request').read(ids[0], ['name']);
        return windowAction('purchase.order', { en: 'Requests for Quotation', ar: 'طلبات عروض الأسعار' }, { domain: [['origin', '=', String(request.name)]] });
      },
      action_get_attachment_view: async (_env, ids) => windowAction('ir.attachment', { en: 'Documents', ar: 'المستندات' }, { domain: [['res_model', '=', 'approval.request'], ['res_id', 'in', ids]], viewMode: 'kanban,list,form', context: { default_res_model: 'approval.request', default_res_id: ids[0] } }),
    },
  });

  registerModelHooks('approval.approver', {
    defaults: (env) => ({ status: 'new', required: false, sequence: 10, company_id: env.companyId }),
    onCreate: async (env, ids) => {
      for (const id of ids) {
        const [approver] = await env.model('approval.approver').read(id, ['approval_request_id', 'user_id']);
        const requestId = m2o(approver.approval_request_id);
        if (!requestId) continue;
        const [request] = await env.model('approval.request').read(requestId, ['request_status']);
        if (request.request_status === 'pending') await env.model('approval.approver').write(id, { status: 'pending' });
      }
    },
    methods: {
      action_approve: async (env, ids) => { for (const id of ids) { const [a] = await env.model('approval.approver').read(id, ['approval_request_id']); await env.model('approval.request').callButton(m2o(a.approval_request_id) as number, 'action_approve'); } },
      action_refuse: async (env, ids) => { for (const id of ids) { const [a] = await env.model('approval.approver').read(id, ['approval_request_id']); await env.model('approval.request').callButton(m2o(a.approval_request_id) as number, 'action_refuse'); } },
    },
  });

  registerModelHooks('approval.category', {
    defaults: (env) => ({ active: true, company_id: env.companyId, approval_minimum: 1, manager_approval: false, automated_sequence: false, requirer_document: 'optional', has_partner: 'optional', has_date: 'optional', has_period: 'no', has_product: 'no', has_quantity: 'no', has_amount: 'no', has_reference: 'no', has_payment_method: 'no', has_location: 'no' }),
    methods: {
      create_request: async (_env, ids) => windowAction('approval.request', { en: 'New Request', ar: 'طلب جديد' }, { resId: undefined, viewMode: 'form', context: { default_category_id: ids[0], form_view_initial_mode: 'edit' } }),
      action_to_review: async (env, ids) => windowAction('approval.request', { en: 'To Review', ar: 'للمراجعة' }, { domain: [['category_id', 'in', ids], ['request_status', '=', 'pending'], ['approver_ids.user_id', '=', env.uid]], viewMode: 'kanban,list,form' }),
    },
  });

  registerModelHooks('approval.product.line', {
    defaults: () => ({ quantity: 1 }),
    beforeCreate: async (env, vals) => {
      const out = { ...vals };
      const productId = m2o(out.product_id);
      if (productId && !out.description) {
        const p = await env.cr.query<{ name: string; uom_id: number | null }>(`SELECT p.name, t.uom_id FROM product_product p JOIN product_template t ON t.id = p.product_tmpl_id WHERE p.id = $1`, [productId]);
        out.description = p.rows[0]?.name ?? '';
        if (!out.product_uom_id && p.rows[0]?.uom_id) out.product_uom_id = p.rows[0].uom_id;
      }
      return out;
    },
  });
  void postMessage; void notify;
}
