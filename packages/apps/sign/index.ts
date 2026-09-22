import { registerModelHooks, type Values } from '../../engine/orm/hooks.js';
import type { Environment } from '../../engine/orm/env.js';
import { UserError } from '../../engine/orm/errors.js';
import { addDays, m2o, note, notify, now, randomToken, today, urlAction, windowAction } from '../common.js';

/**
 * D-10 / D-13 / D-12 — Sign, Surveys and Fleet: signature requests with
 * their signers, states and reminders; surveys shared, tested, closed and
 * their live sessions; vehicles, driver changes, contracts (running /
 * expired by dates) and services billed to vendor bills.
 */

async function refreshRequestCounts(env: Environment, requestId: number): Promise<void> {
  const rows = await env.cr.query<{ state: string; n: number }>(`SELECT state, count(*)::int AS n FROM sign_request_item WHERE sign_request_id = $1 GROUP BY state`, [requestId]).catch(() => ({ rows: [] as { state: string; n: number }[] }));
  const total = rows.rows.reduce((s, r) => s + r.n, 0);
  const closed = rows.rows.find((r) => r.state === 'completed')?.n ?? 0;
  await env.cr.query(`UPDATE sign_request SET nb_total = $2, nb_closed = $3, nb_wait = $4 WHERE id = $1`, [requestId, total, closed, total - closed]).catch(() => undefined);
  if (total && closed === total) {
    await env.model('sign.request').write(requestId, { state: 'signed', completion_date: today() });
    await note(env, 'sign.request', requestId, { en: 'Document fully signed.', ar: 'تم توقيع المستند بالكامل.' });
  }
}

export function registerSignSurveyFleet(): void {
  /* ---------- Sign ---------- */
  registerModelHooks('sign.template', {
    defaults: (env) => ({ active: true, user_id: env.uid, signature_request_validity: 60, is_sharing: false, color: 0, in_progress_count: 0, signed_count: 0 }),
    methods: {
      open_requests: async (_env, ids) => windowAction('sign.request', { en: 'Signature Requests', ar: 'طلبات التوقيع' }, { domain: [['template_id', 'in', ids]], viewMode: 'kanban,list,form', context: { default_template_id: ids[0] } }),
      send_template: async (_env, ids) => windowAction('sign.request', { en: 'New Signature Request', ar: 'طلب توقيع جديد' }, { viewMode: 'form', target: 'new', context: { default_template_id: ids[0] } }),
      go_to_custom_template: async (_env, ids) => windowAction('sign.template', { en: 'Template', ar: 'القالب' }, { resId: ids[0] }),
      action_share: async (env, ids) => { await env.model('sign.template').write(ids, { is_sharing: true }); return notify({ en: `Share link: /sign/share/${ids[0]}`, ar: `رابط المشاركة: /sign/share/${ids[0]}` }, 'info', { sticky: true }); },
      stop_sharing: async (env, ids) => { await env.model('sign.template').write(ids, { is_sharing: false }); },
    },
  });
  registerModelHooks('sign.request', {
    defaults: (env) => ({ state: 'sent', active: true, send_channel: 'email', reminder_enabled: false, reminder: 7, validity: addDays(today(), 60), nb_total: 0, nb_wait: 0, nb_closed: 0, create_uid: env.uid }),
    tracked: ['state'],
    creationMessage: { en: 'Signature request created', ar: 'تم إنشاء طلب التوقيع' },
    beforeCreate: async (env, vals) => {
      const out = { ...vals };
      const templateId = m2o(out.template_id);
      if (templateId) {
        const [t] = await env.model('sign.template').read(templateId, ['name', 'signature_request_validity', 'sign_item_role_ids']);
        if (!out.reference) { const n = await env.cr.query<{ n: number }>(`SELECT count(*)::int AS n FROM sign_request WHERE template_id = $1`, [templateId]); out.reference = `${t.name}-${Number(n.rows[0]?.n ?? 0) + 1}`; }
        if (!out.subject) out.subject = `Signature Request - ${t.name}`;
        if (t.signature_request_validity) out.validity = addDays(today(), Number(t.signature_request_validity));
      }
      if (!out.reference) out.reference = `Request ${randomToken(6)}`;
      return out;
    },
    onCreate: async (env, ids) => { for (const id of ids) { await refreshRequestCounts(env, id); await env.model('sign.template').callButton([], 'noop').catch(() => undefined); } },
    methods: {
      action_send: async (env, ids) => {
        for (const id of ids) {
          const [r] = await env.model('sign.request').read(id, ['request_item_ids', 'state']);
          if (!(r.request_item_ids as number[]).length) throw new UserError({ en: 'Add at least one signer before sending.', ar: 'أضف موقّعاً واحداً على الأقل قبل الإرسال.' });
          await env.cr.query(`UPDATE sign_request_item SET is_mail_sent = true, state = 'sent' WHERE sign_request_id = $1 AND state <> 'completed'`, [id]);
          await env.model('sign.request').write(id, { state: 'sent' });
          await note(env, 'sign.request', id, { en: 'Signature request sent to the signers.', ar: 'تم إرسال طلب التوقيع إلى الموقّعين.' });
        }
        return notify({ en: 'Signature request sent.', ar: 'تم إرسال طلب التوقيع.' });
      },
      send_signature_accesses: async (env, ids) => { for (const id of ids) await note(env, 'sign.request', id, { en: 'Reminder sent to the signers who have not signed yet.', ar: 'تم إرسال تذكير إلى الموقّعين الذين لم يوقّعوا بعد.' }); return notify({ en: 'Reminder sent.', ar: 'تم إرسال التذكير.' }); },
      cancel: async (env, ids) => { await env.cr.query(`UPDATE sign_request_item SET state = 'canceled' WHERE sign_request_id = ANY($1) AND state <> 'completed'`, [ids]); await env.model('sign.request').write(ids, { state: 'canceled' }); },
      get_sign_request_documents: async (env, ids) => { const [r] = await env.model('sign.request').read(ids[0], ['state']); return r.state === 'signed' ? urlAction(`/report/sign.sign_request_logs_user/${ids[0]}?print=1`) : notify({ en: 'The signed document is available once every signer has signed.', ar: 'يتوفر المستند الموقّع بعد توقيع جميع الموقّعين.' }, 'info'); },
      go_to_document: async (_env, ids) => windowAction('sign.request', { en: 'Document', ar: 'المستند' }, { resId: ids[0] }),
      action_open_selected_requests_spreadsheet: async () => notify({ en: 'Export the answers from the list view: select the requests, then ⚙ › Export.', ar: 'صدّر الإجابات من عرض القائمة: حدد الطلبات ثم ⚙ › تصدير.' }, 'info'),
      /** The current user signs their own item. */
      sign_now: async (env, ids) => {
        const partner = (await env.cr.query<{ p: number | null }>(`SELECT partner_id AS p FROM res_users WHERE id = $1`, [env.uid])).rows[0]?.p;
        for (const id of ids) {
          const items = await env.cr.query<{ id: number }>(`SELECT id FROM sign_request_item WHERE sign_request_id = $1 AND partner_id = $2 AND state = 'sent'`, [id, partner]);
          if (!items.rows.length) throw new UserError({ en: 'You are not a pending signer of this request.', ar: 'لست موقّعاً معلقاً لهذا الطلب.' });
          await env.cr.query(`UPDATE sign_request_item SET state = 'completed' WHERE id = ANY($1)`, [items.rows.map((r) => r.id)]);
          if (env.registry.models['sign.log']) await env.model('sign.log').create({ sign_request_id: id, action: 'sign', log_date: now(), user_id: env.uid, partner_id: partner }).catch(() => undefined);
          await refreshRequestCounts(env, id);
        }
        return notify({ en: 'Signed.', ar: 'تم التوقيع.' });
      },
    },
  });
  registerModelHooks('sign.request.item', {
    defaults: () => ({ state: 'sent', is_mail_sent: false }),
    beforeCreate: async (env, vals) => { const out = { ...vals }; const pid = m2o(out.partner_id); if (pid && !out.signer_email) { const p = await env.cr.query<{ email: string | null }>(`SELECT email FROM res_partner WHERE id = $1`, [pid]); out.signer_email = p.rows[0]?.email ?? false; } return out; },
    onCreate: async (env, ids) => { const rows = await env.cr.query<{ r: number }>(`SELECT DISTINCT sign_request_id AS r FROM sign_request_item WHERE id = ANY($1)`, [ids]); for (const row of rows.rows) await refreshRequestCounts(env, Number(row.r)); },
    onWrite: async (env, ids, vals) => { if ('state' in vals) { const rows = await env.cr.query<{ r: number }>(`SELECT DISTINCT sign_request_id AS r FROM sign_request_item WHERE id = ANY($1)`, [ids]); for (const row of rows.rows) await refreshRequestCounts(env, Number(row.r)); } },
    methods: {
      action_sign: async (env, ids) => { await env.model('sign.request.item').write(ids, { state: 'completed' }); },
      action_resend: async (env, ids) => { await env.model('sign.request.item').write(ids, { is_mail_sent: true }); return notify({ en: 'Invitation resent.', ar: 'تمت إعادة إرسال الدعوة.' }); },
    },
  });

  /* ---------- Surveys ---------- */
  registerModelHooks('survey.survey', {
    defaults: (env) => ({ active: true, user_id: env.uid, survey_type: 'survey', questions_layout: 'page_per_question', questions_selection: 'all', progression_mode: 'percent', access_mode: 'public', users_login_required: false, users_can_go_back: false, scoring_type: 'no_scoring', access_token: randomToken(24), session_state: false, certification: false, is_attempts_limited: false, is_time_limited: false }),
    tracked: ['title', 'survey_type', 'scoring_type'],
    beforeCreate: async (_env, vals) => ({ ...vals, access_token: vals.access_token || randomToken(24) }),
    methods: {
      action_send_survey: async (env, ids) => {
        const [s] = await env.model('survey.survey').read(ids[0], ['access_token', 'title', 'question_and_page_ids']);
        if (!(s.question_and_page_ids as number[]).length) throw new UserError({ en: 'Add at least one question before sharing the survey.', ar: 'أضف سؤالاً واحداً على الأقل قبل مشاركة الاستطلاع.' });
        return notify({ en: `Share this link: /survey/start/${s.access_token}`, ar: `شارك هذا الرابط: /survey/start/${s.access_token}` }, 'info', { sticky: true, title: { en: String(s.title), ar: String(s.title) } });
      },
      action_test_survey: async (env, ids) => { const [s] = await env.model('survey.survey').read(ids[0], ['access_token']); const input = await env.model('survey.user_input').create({ survey_id: ids[0], test_entry: true, state: 'new' }); return windowAction('survey.user_input', { en: 'Test Entry', ar: 'إدخال تجريبي' }, { resId: input, context: { access_token: s.access_token } }); },
      action_result_survey: async (_env, ids) => windowAction('survey.user_input', { en: 'Results', ar: 'النتائج' }, { domain: [['survey_id', 'in', ids], ['test_entry', '=', false]], viewMode: 'list,graph,pivot,form' }),
      action_start_session: async (env, ids) => { await env.model('survey.survey').write(ids, { session_state: 'ready', session_code: String(Math.floor(1000 + Math.random() * 9000)) }); return notify({ en: 'Live session ready: share the session code with the participants.', ar: 'الجلسة المباشرة جاهزة: شارك رمز الجلسة مع المشاركين.' }); },
      action_open_session_manager: async (env, ids) => { await env.model('survey.survey').write(ids, { session_state: 'in_progress' }); const [s] = await env.model('survey.survey').read(ids[0], ['session_code']); return notify({ en: `Session ${s.session_code} in progress.`, ar: `الجلسة ${s.session_code} جارية.` }, 'info', { sticky: true }); },
      action_end_session: async (env, ids) => { await env.model('survey.survey').write(ids, { session_state: false, session_code: false }); },
      action_survey_open_linked_spreadsheet: async () => notify({ en: 'Export the answers from Participants: select them, then ⚙ › Export.', ar: 'صدّر الإجابات من المشاركين: حددهم ثم ⚙ › تصدير.' }, 'info'),
      action_unarchive: async (env, ids) => { await env.model('survey.survey').write(ids, { active: true }); },
      action_archive: async (env, ids) => { await env.model('survey.survey').write(ids, { active: false }); },
      action_survey_user_input: async (_env, ids) => windowAction('survey.user_input', { en: 'Participations', ar: 'المشاركات' }, { domain: [['survey_id', 'in', ids]], viewMode: 'list,form' }),
      action_survey_user_input_certified: async (_env, ids) => windowAction('survey.user_input', { en: 'Certified', ar: 'المعتمدون' }, { domain: [['survey_id', 'in', ids], ['scoring_success', '=', true]], viewMode: 'list,form' }),
      action_survey_user_input_completed: async (_env, ids) => windowAction('survey.user_input', { en: 'Completed', ar: 'المكتملة' }, { domain: [['survey_id', 'in', ids], ['state', '=', 'done']], viewMode: 'list,form' }),
      action_survey_preview_certification_template: async (_env, ids) => urlAction(`/report/survey.certification_report_view/${ids[0]}`),
    },
  });
  registerModelHooks('survey.user_input', {
    defaults: () => ({ state: 'new', test_entry: false, access_token: randomToken(24), attempts_number: 1 }),
    beforeCreate: async (_env, vals) => ({ ...vals, access_token: vals.access_token || randomToken(24) }),
    onCreate: async (env, ids) => { const rows = await env.cr.query<{ s: number }>(`SELECT DISTINCT survey_id AS s FROM survey_user_input WHERE id = ANY($1)`, [ids]); for (const r of rows.rows) await env.cr.query(`UPDATE survey_survey SET answer_count = (SELECT count(*) FROM survey_user_input WHERE survey_id = $1 AND coalesce(test_entry, false) = false), answer_done_count = (SELECT count(*) FROM survey_user_input WHERE survey_id = $1 AND state = 'done') WHERE id = $1`, [r.s]).catch(() => undefined); },
    methods: {
      action_resend: async (env, ids) => { for (const id of ids) await note(env, 'survey.user_input', id, { en: 'Invitation resent.', ar: 'تمت إعادة إرسال الدعوة.' }); return notify({ en: 'Invitation resent.', ar: 'تمت إعادة إرسال الدعوة.' }); },
      action_print_answers: async (_env, ids) => windowAction('survey.user_input.line', { en: 'Answers', ar: 'الإجابات' }, { domain: [['user_input_id', 'in', ids]], viewMode: 'list' }),
      action_redirect_to_attempts: async (env, ids) => { const [u] = await env.model('survey.user_input').read(ids[0], ['survey_id', 'partner_id', 'email']); return windowAction('survey.user_input', { en: 'Attempts', ar: 'المحاولات' }, { domain: [['survey_id', '=', m2o(u.survey_id)], '|', ['partner_id', '=', m2o(u.partner_id) || 0], ['email', '=', u.email || '']], viewMode: 'list,form' }); },
    },
  });

  /* ---------- Fleet ---------- */
  registerModelHooks('fleet.vehicle', {
    defaults: async (env) => {
      const state = await env.cr.query<{ id: number }>(`SELECT id FROM fleet_vehicle_state ORDER BY sequence, id LIMIT 1`).catch(() => ({ rows: [] as { id: number }[] }));
      return { active: true, company_id: env.companyId, vehicle_type: 'car', odometer_unit: 'kilometers', fuel_type: 'gasoline', transmission: 'automatic', state_id: state.rows[0]?.id ?? false, contract_state: 'futur', plan_to_change_vehicle: false, order_date: today() };
    },
    tracked: ['driver_id', 'state_id', 'license_plate'],
    searchFields: ['license_plate', 'vin_sn'],
    displayName: (_env, record) => [record.model_name ?? record.name, record.license_plate].filter(Boolean).map(String).join(' / ') || String(record.name ?? ''),
    displayNameFields: ['name', 'license_plate', 'model_name'],
    beforeCreate: async (env, vals) => {
      const out = { ...vals };
      const modelId = m2o(out.model_id);
      if (modelId && !out.name) { const m = await env.cr.query<{ name: string; brand: string | null }>(`SELECT m.name, b.name AS brand FROM fleet_vehicle_model m LEFT JOIN fleet_vehicle_model_brand b ON b.id = m.brand_id WHERE m.id = $1`, [modelId]); out.name = [m.rows[0]?.brand, m.rows[0]?.name].filter(Boolean).join('/'); }
      return out;
    },
    onWrite: async (env, ids, vals) => {
      if ('driver_id' in vals && env.registry.models['fleet.vehicle.assignation.log']) {
        for (const id of ids) {
          await env.cr.query(`UPDATE fleet_vehicle_assignation_log SET date_end = $2::date WHERE vehicle_id = $1 AND date_end IS NULL`, [id, today()]).catch(() => undefined);
          if (m2o(vals.driver_id)) await env.model('fleet.vehicle.assignation.log').create({ vehicle_id: id, driver_id: m2o(vals.driver_id), date_start: today() }).catch(() => undefined);
        }
      }
    },
    methods: {
      action_accept_driver_change: async (env, ids) => {
        for (const id of ids) {
          const [v] = await env.model('fleet.vehicle').read(id, ['future_driver_id', 'future_driver_employee_id']);
          if (!m2o(v.future_driver_id)) throw new UserError({ en: 'No future driver is set.', ar: 'لم يتم تحديد سائق مستقبلي.' });
          await env.model('fleet.vehicle').write(id, { driver_id: m2o(v.future_driver_id), driver_employee_id: m2o(v.future_driver_employee_id) || false, future_driver_id: false, future_driver_employee_id: false, plan_to_change_vehicle: false, next_assignation_date: false });
          await note(env, 'fleet.vehicle', id, { en: 'New driver applied.', ar: 'تم تطبيق السائق الجديد.' });
        }
      },
      action_view_bills: async (_env, ids) => windowAction('account.move', { en: 'Vendor Bills', ar: 'فواتير الموردين' }, { domain: [['line_ids.vehicle_id', 'in', ids], ['move_type', 'in', ['in_invoice', 'in_refund']]], context: { default_move_type: 'in_invoice' } }),
      action_open_employee: async (env, ids) => { const [v] = await env.model('fleet.vehicle').read(ids[0], ['driver_employee_id']); const eid = m2o(v.driver_employee_id); return eid ? windowAction('hr.employee', { en: 'Employee', ar: 'الموظف' }, { resId: eid }) : notify({ en: 'The driver is not an employee.', ar: 'السائق ليس موظفاً.' }, 'info'); },
      open_assignation_logs: async (_env, ids) => windowAction('fleet.vehicle.assignation.log', { en: 'Drivers History', ar: 'سجل السائقين' }, { domain: [['vehicle_id', 'in', ids]], viewMode: 'list' }),
      return_action_to_open: async (env, ids) => { const kind = String(env.context.xml_id ?? ''); if (kind.includes('odometer')) return windowAction('fleet.vehicle.odometer', { en: 'Odometer', ar: 'عداد المسافات' }, { domain: [['vehicle_id', 'in', ids]], context: { default_vehicle_id: ids[0] } }); if (kind.includes('contract')) return windowAction('fleet.vehicle.log.contract', { en: 'Contracts', ar: 'العقود' }, { domain: [['vehicle_id', 'in', ids]], context: { default_vehicle_id: ids[0] } }); return windowAction('fleet.vehicle.log.services', { en: 'Services', ar: 'الخدمات' }, { domain: [['vehicle_id', 'in', ids]], context: { default_vehicle_id: ids[0] } }); },
      action_open_documents: async (_env, ids) => windowAction('ir.attachment', { en: 'Documents', ar: 'المستندات' }, { domain: [['res_model', '=', 'fleet.vehicle'], ['res_id', 'in', ids]], viewMode: 'kanban,list' }),
      action_open_odometer_report: async (_env, ids) => windowAction('fleet.vehicle.odometer.report', { en: 'Odometer Analysis', ar: 'تحليل عداد المسافات' }, { domain: [['vehicle_id', 'in', ids]], viewMode: 'graph,pivot,list' }),
    },
  });
  registerModelHooks('fleet.vehicle.log.contract', {
    defaults: (env) => ({ active: true, company_id: env.companyId, state: 'open', start_date: today(), cost_frequency: 'monthly', user_id: env.uid, date: today() }),
    tracked: ['state', 'expiration_date'],
    beforeCreate: async (_env, vals) => contractState({ ...vals }),
    beforeWrite: async (_env, _ids, vals) => ('start_date' in vals || 'expiration_date' in vals) && !('state' in vals) ? contractState({ ...vals }) : vals,
    methods: {
      action_close: async (env, ids) => { await env.model('fleet.vehicle.log.contract').write(ids, { state: 'closed' }); },
      action_reactivate: async (env, ids) => { await env.model('fleet.vehicle.log.contract').write(ids, { state: 'open' }); },
      action_open_employee: async (env, ids) => { const [c] = await env.model('fleet.vehicle.log.contract').read(ids[0], ['purchaser_employee_id']); const eid = m2o(c.purchaser_employee_id); return eid ? windowAction('hr.employee', { en: 'Employee', ar: 'الموظف' }, { resId: eid }) : notify({ en: 'No employee is linked to this contract.', ar: 'لا يوجد موظف مرتبط بهذا العقد.' }, 'info'); },
    },
  });
  registerModelHooks('fleet.vehicle.log.services', {
    defaults: (env) => ({ active: true, company_id: env.companyId, date_from: today(), state: 'new', amount: 0 }),
    tracked: ['state', 'amount'],
    methods: {
      action_create_account_move: async (env, ids) => {
        const created: number[] = [];
        for (const id of ids) {
          const [s] = await env.model('fleet.vehicle.log.services').read(id, ['description', 'amount', 'vendor_id', 'vehicle_id', 'account_move_line_id', 'date_from']);
          if (m2o(s.account_move_line_id)) throw new UserError({ en: 'This service is already billed.', ar: 'هذه الخدمة مفوترة بالفعل.' });
          if (!m2o(s.vendor_id)) throw new UserError({ en: 'Set the vendor first.', ar: 'حدد المورد أولاً.' });
          const bill = await env.with({ context: { default_move_type: 'in_invoice' } }).model('account.move').create({ move_type: 'in_invoice', partner_id: m2o(s.vendor_id), invoice_date: String(s.date_from || today()).slice(0, 10), invoice_line_ids: [[0, 0, { name: String(s.description || 'Vehicle service'), quantity: 1, price_unit: Number(s.amount ?? 0), vehicle_id: m2o(s.vehicle_id) || false }]] });
          const line = await env.cr.query<{ id: number }>(`SELECT id FROM account_move_line WHERE move_id = $1 AND coalesce(display_type, 'product') = 'product' ORDER BY id LIMIT 1`, [bill]);
          await env.model('fleet.vehicle.log.services').write(id, { account_move_line_id: line.rows[0]?.id ?? false, account_move_state: 'draft' });
          created.push(bill);
        }
        return windowAction('account.move', { en: 'Vendor Bill', ar: 'فاتورة المورد' }, { resId: created[0], context: { default_move_type: 'in_invoice' } });
      },
      action_open_account_move: async (env, ids) => { const [s] = await env.model('fleet.vehicle.log.services').read(ids[0], ['account_move_line_id']); const lid = m2o(s.account_move_line_id); const move = lid ? (await env.cr.query<{ move_id: number }>(`SELECT move_id FROM account_move_line WHERE id = $1`, [lid])).rows[0]?.move_id : null; return move ? windowAction('account.move', { en: 'Vendor Bill', ar: 'فاتورة المورد' }, { resId: Number(move) }) : notify({ en: 'No bill is linked to this service.', ar: 'لا توجد فاتورة مرتبطة بهذه الخدمة.' }, 'info'); },
    },
  });
  registerModelHooks('fleet.vehicle.odometer', {
    defaults: () => ({ date: today(), value: 0 }),
    onCreate: async (env, ids) => { const rows = await env.model('fleet.vehicle.odometer').read(ids, ['vehicle_id', 'value']); for (const r of rows) if (m2o(r.vehicle_id)) await env.cr.query(`UPDATE fleet_vehicle SET odometer = greatest(coalesce(odometer, 0), $2) WHERE id = $1`, [m2o(r.vehicle_id), Number(r.value ?? 0)]).catch(() => undefined); },
  });
  registerModelHooks('fleet.vehicle.model', { methods: { action_model_vehicle: async (_env, ids) => windowAction('fleet.vehicle', { en: 'Vehicles', ar: 'المركبات' }, { domain: [['model_id', 'in', ids]], viewMode: 'kanban,list,form', context: { default_model_id: ids[0] } }) } });
  registerModelHooks('fleet.vehicle.model.brand', { methods: { action_brand_model: async (_env, ids) => windowAction('fleet.vehicle.model', { en: 'Models', ar: 'الطرازات' }, { domain: [['brand_id', 'in', ids]], context: { default_brand_id: ids[0] } }) } });
}

function contractState(vals: Values): Values {
  const start = vals.start_date ? String(vals.start_date).slice(0, 10) : today();
  const end = vals.expiration_date ? String(vals.expiration_date).slice(0, 10) : null;
  const t = today();
  if (vals.state === 'closed') return vals;
  vals.state = start > t ? 'futur' : end && end < t ? 'expired' : 'open';
  if (end) vals.days_left = Math.max(0, Math.round((Date.parse(end) - Date.parse(t)) / 86_400_000));
  vals.expires_today = end === t;
  return vals;
}
