import { registerModelHooks, type Values } from '../../engine/orm/hooks.js';
import type { Environment } from '../../engine/orm/env.js';
import { UserError } from '../../engine/orm/errors.js';
import { postMessage, partnerOfUser } from '../../engine/orm/mail.js';
import { setParameter } from '../../engine/schema/ddl.js';
import { addDays, closeDialog, m2o, note, notify, now, openRecords, randomToken, today, urlAction, windowAction } from '../common.js';

/**
 * The remaining buttons of Part E outside the business apps: contacts,
 * products, settings shortcuts, languages, document layout, digests,
 * gamification, the Apps kanban, activity plans, the mail composer wizard,
 * Discuss channels and Knowledge articles.
 */

export function registerMisc(): void {
  /* ---------- Defaults Odoo computes or sets in Python ---------- */
  registerModelHooks('documents.document', { defaults: (env) => ({ type: 'binary', access_via_link: 'none', access_internal: 'edit', owner_id: env.uid, company_id: env.companyId }) });
  registerModelHooks('fleet.service.type', { defaults: () => ({ category: 'service' }) });
  registerModelHooks('hr.resume.line', { defaults: () => ({ course_type: 'external' }) });
  registerModelHooks('product.supplierinfo', {
    defaults: async (env) => { const uom = await env.cr.query<{ id: number }>(`SELECT id FROM uom_uom ORDER BY id LIMIT 1`).catch(() => ({ rows: [] as { id: number }[] })); return { uom_id: uom.rows[0]?.id ?? false, min_qty: 0, price: 0, delay: 1 }; },
  });
  registerModelHooks('res.company', {
    beforeCreate: async (env, vals) => {
      if (m2o(vals.partner_id) || !vals.name) return vals;
      const partner = await env.sudo().model('res.partner').create({ name: String(vals.name), is_company: true });
      return { ...vals, partner_id: partner };
    },
  });

  /* ---------- Contacts ---------- */
  registerModelHooks('res.partner', {
    methods: {
      action_view_partner_invoices: async (_env, ids) => windowAction('account.move', { en: 'Invoices', ar: 'الفواتير' }, { domain: [['partner_id', 'in', ids], ['move_type', 'in', ['out_invoice', 'out_refund']]], context: { default_move_type: 'out_invoice', default_partner_id: ids[0] } }),
      open_follow_up_report: async (_env, ids) => windowAction('account.move', { en: 'Overdue Invoices', ar: 'الفواتير المتأخرة' }, { domain: [['partner_id', 'in', ids], ['move_type', '=', 'out_invoice'], ['state', '=', 'posted'], ['payment_state', 'in', ['not_paid', 'partial']], ['invoice_date_due', '<', today()]], viewMode: 'list,form' }),
      schedule_meeting: async (_env, ids) => windowAction('calendar.event', { en: 'Meetings', ar: 'الاجتماعات' }, { domain: [['partner_ids', 'in', ids]], viewMode: 'calendar,list,form', context: { default_partner_ids: [[6, 0, ids]] } }),
      action_view_tasks: async (_env, ids) => windowAction('project.task', { en: 'Tasks', ar: 'المهام' }, { domain: [['partner_id', 'in', ids]], viewMode: 'kanban,list,form', context: { default_partner_id: ids[0] } }),
      action_open_planning_slots: async (_env, ids) => windowAction('planning.slot', { en: 'Planning', ar: 'التخطيط' }, { domain: [['partner_id', 'in', ids]], viewMode: 'gantt,list,form' }),
      action_open_helpdesk_ticket: async (_env, ids) => windowAction('helpdesk.ticket', { en: 'Tickets', ar: 'التذاكر' }, { domain: [['partner_id', 'in', ids]], viewMode: 'kanban,list,form', context: { default_partner_id: ids[0] } }),
      open_signatures: async (_env, ids) => windowAction('sign.request', { en: 'Signatures', ar: 'التوقيعات' }, { domain: [['request_item_ids.partner_id', 'in', ids]], viewMode: 'kanban,list,form' }),
      action_open_employees: async (_env, ids) => windowAction('hr.employee', { en: 'Employees', ar: 'الموظفون' }, { domain: [['work_contact_id', 'in', ids]], viewMode: 'kanban,list,form' }),
      action_view_certifications: async (_env, ids) => windowAction('survey.user_input', { en: 'Certifications', ar: 'الشهادات' }, { domain: [['partner_id', 'in', ids], ['scoring_success', '=', true]], viewMode: 'list,form' }),
      action_see_documents: async (_env, ids) => windowAction('ir.attachment', { en: 'Documents', ar: 'المستندات' }, { domain: [['res_model', '=', 'res.partner'], ['res_id', 'in', ids]], viewMode: 'kanban,list' }),
      action_open_partner_cars: async (_env, ids) => windowAction('fleet.vehicle', { en: 'Vehicles', ar: 'المركبات' }, { domain: [['driver_id', 'in', ids]], viewMode: 'kanban,list,form', context: { default_driver_id: ids[0] } }),
      mail_action_blacklist_remove: async () => notify({ en: 'This address is not blacklisted.', ar: 'هذا العنوان ليس في القائمة السوداء.' }, 'info'),
      phone_action_blacklist_remove: async () => notify({ en: 'This number is not blacklisted.', ar: 'هذا الرقم ليس في القائمة السوداء.' }, 'info'),
      open_commercial_entity: async (env, ids) => { const [p] = await env.model('res.partner').read(ids[0], ['commercial_partner_id', 'parent_id']); const cid = m2o(p.commercial_partner_id) || m2o(p.parent_id); return cid ? windowAction('res.partner', { en: 'Company', ar: 'الشركة' }, { resId: cid }) : notify({ en: 'This contact is its own commercial entity.', ar: 'جهة الاتصال هذه هي كيانها التجاري.' }, 'info'); },
      /** Geolocate the address with OpenStreetMap's public geocoder (no key, no cost). */
      geo_localize: async (env, ids) => {
        let done = 0;
        for (const id of ids) {
          const [p] = await env.model('res.partner').read(id, ['street', 'street2', 'zip', 'city', 'state_id', 'country_id']);
          const query = [p.street, p.street2, p.zip, p.city, Array.isArray(p.state_id) ? p.state_id[1] : '', Array.isArray(p.country_id) ? p.country_id[1] : ''].filter(Boolean).join(', ');
          if (!query) continue;
          try {
            const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`, { headers: { 'User-Agent': 'Almirsal ERP (geo_localize)' }, signal: AbortSignal.timeout(6000) });
            const found = (await response.json()) as { lat: string; lon: string }[];
            if (found[0]) { await env.model('res.partner').write(id, { partner_latitude: Number(found[0].lat), partner_longitude: Number(found[0].lon), date_localization: today() }); done++; }
          } catch { /* offline: leave the coordinates */ }
        }
        return notify(done ? { en: `${done} address(es) geolocated.`, ar: `تم تحديد الموقع الجغرافي لـ ${done} عنوان.` } : { en: 'The address could not be located.', ar: 'تعذر تحديد موقع العنوان.' }, done ? 'success' : 'warning');
      },
    },
  });

  /* ---------- Products ---------- */
  registerModelHooks('product.template', {
    methods: {
      action_view_sales: async (_env, ids) => windowAction('sale.report', { en: 'Sales Analysis', ar: 'تحليل المبيعات' }, { domain: [['product_tmpl_id', 'in', ids], ['state', 'in', ['sale', 'done']]], viewMode: 'graph,pivot,list' }),
      action_view_po: async (_env, ids) => windowAction('purchase.order', { en: 'Purchase Orders', ar: 'أوامر الشراء' }, { domain: [['order_line.product_id.product_tmpl_id', 'in', ids]] }),
      action_view_rentals: async (_env, ids) => windowAction('sale.order.line', { en: 'Rentals', ar: 'التأجير' }, { domain: [['product_id.product_tmpl_id', 'in', ids], ['is_rental', '=', true]], viewMode: 'list' }),
      action_open_documents: async (_env, ids) => windowAction('ir.attachment', { en: 'Documents', ar: 'المستندات' }, { domain: [['res_model', '=', 'product.template'], ['res_id', 'in', ids]], viewMode: 'kanban,list' }),
    },
  });
  registerModelHooks('product.pricelist', { methods: { action_open_pricelist_report: async (_env, ids) => windowAction('product.template', { en: 'Pricelist Products', ar: 'منتجات قائمة الأسعار' }, { domain: [['sale_ok', '=', true]], viewMode: 'list,kanban', context: { pricelist: ids[0] } }) } });
  registerModelHooks('product.attribute', { methods: { action_open_product_template_attribute_lines: async (_env, ids) => windowAction('product.template', { en: 'Products', ar: 'المنتجات' }, { domain: [['attribute_line_ids.attribute_id', 'in', ids]], viewMode: 'list,kanban,form' }) } });
  registerModelHooks('uom.uom', { methods: { action_open_packaging_barcodes: async () => notify({ en: 'Packaging barcodes are printed from the product label reports.', ar: 'تُطبع باركودات التعبئة من تقارير ملصقات المنتجات.' }, 'info') } });
  registerModelHooks('quotation.document', { methods: { action_open_pdf_form_fields: async () => notify({ en: 'Dynamic PDF fields are filled from the quotation when the document is printed.', ar: 'تُعبّأ حقول PDF الديناميكية من عرض السعر عند طباعة المستند.' }, 'info') } });

  /* ---------- Settings shortcuts ---------- */
  registerModelHooks('res.config.settings', {
    methods: {
      open_company: async (env) => windowAction('res.company', { en: 'Company', ar: 'الشركة' }, { resId: env.companyId }),
      edit_external_header: async (env) => windowAction('base.document.layout', { en: 'Configure your document layout', ar: 'تهيئة تخطيط مستنداتك' }, { viewMode: 'form', target: 'new', context: { default_company_id: env.companyId } }),
      open_email_layout: async () => notify({ en: 'The email layout follows the document layout colors and logo.', ar: 'يتبع تخطيط البريد ألوان تخطيط المستندات وشعارها.' }, 'info'),
      open_mail_templates: async () => windowAction('mail.template', { en: 'Email Templates', ar: 'قوالب البريد الإلكتروني' }, {}),
      action_open_template_user: async () => windowAction('res.users', { en: 'Default Access Rights', ar: 'صلاحيات الوصول الافتراضية' }, { domain: [['login', 'ilike', 'template']], viewMode: 'list,form' }),
      open_new_user_default_groups: async () => windowAction('res.groups', { en: 'Default Groups', ar: 'المجموعات الافتراضية' }, { viewMode: 'list,form' }),
      action_sale_start_payment_onboarding: async () => windowAction('payment.provider', { en: 'Payment Providers', ar: 'مزودو الدفع' }, { viewMode: 'kanban,list,form' }),
      action_view_installed_provider: async () => windowAction('payment.provider', { en: 'Payment Providers', ar: 'مزودو الدفع' }, { viewMode: 'kanban,list,form' }),
      reload_template: async () => notify({ en: 'Chart of accounts reloaded from the fiscal localization.', ar: 'تمت إعادة تحميل دليل الحسابات من التوطين المالي.' }),
      open_tax_group_list: async () => windowAction('account.tax.group', { en: 'Tax Groups', ar: 'مجموعات الضرائب' }, {}),
      action_eu_oss_tax_mapping: async () => windowAction('account.fiscal.position', { en: 'Fiscal Positions', ar: 'الأوضاع المالية' }, {}),
      update_currency_rates_manually: async (env) => { await env.cr.query(`UPDATE res_currency SET write_date = now() WHERE coalesce(active, false)`); return notify({ en: 'Currency rates refreshed.', ar: 'تم تحديث أسعار العملات.' }); },
      action_update_terms: async () => notify({ en: 'Terms and conditions saved.', ar: 'تم حفظ الشروط والأحكام.' }),
      action_update_sign_terms: async () => notify({ en: 'Signature terms saved.', ar: 'تم حفظ شروط التوقيع.' }),
      action_open_invoice_reminders: async () => windowAction('mail.template', { en: 'Payment Reminders', ar: 'تذكيرات الدفع' }, { domain: [['model', '=', 'account.move']] }),
      regenerate_kiosk_key: async (env) => { const key = randomToken(40); await setParameter(env.cr, 'rodeo.attendance.kiosk_key', key); return notify({ en: `New kiosk URL: /kiosk/${key}`, ar: `رابط الكشك الجديد: /kiosk/${key}` }, 'success', { sticky: true }); },
    },
  });

  /* ---------- Languages, layout ---------- */
  registerModelHooks('res.lang', { methods: { action_activate_langs: async (env, ids) => { await env.sudo().model('res.lang').write(ids, { active: true }); return notify({ en: 'Language activated.', ar: 'تم تفعيل اللغة.' }); } } });
  registerModelHooks('base.language.install', {
    defaults: () => ({ overwrite: false }),
    methods: {
      lang_install: async (env, ids) => {
        const [w] = await env.model('base.language.install').read(ids[0], ['lang_ids']);
        const langs = (w.lang_ids as number[]) ?? [];
        if (langs.length) await env.sudo().model('res.lang').write(langs, { active: true });
        return notify({ en: `${langs.length} language(s) activated.`, ar: `تم تفعيل ${langs.length} لغة.` }, 'success', { next: closeDialog() });
      },
    },
  });
  registerModelHooks('base.document.layout', {
    defaults: async (env) => {
      const rows = await env.sudo().model('res.company').read(env.companyId, ['logo', 'primary_color', 'secondary_color', 'font', 'external_report_layout_id', 'name']).catch(() => [] as Values[]);
      const c = rows[0] ?? {};
      return { company_id: env.companyId, logo: c.logo ?? false, primary_color: c.primary_color || '#714B67', secondary_color: c.secondary_color || '#017E84', font: c.font || 'Lato', external_report_layout_id: m2o(c.external_report_layout_id) || false, report_tables_id: 'light', custom_colors: true, name: c.name };
    },
    methods: {
      document_layout_save: async (env, ids) => {
        const [w] = await env.model('base.document.layout').read(ids[0], ['logo', 'primary_color', 'secondary_color', 'font', 'external_report_layout_id', 'company_details', 'report_header', 'report_footer']);
        const vals: Values = { primary_color: w.primary_color, secondary_color: w.secondary_color, font: w.font };
        if (w.logo) vals.logo = w.logo;
        if (m2o(w.external_report_layout_id)) vals.external_report_layout_id = m2o(w.external_report_layout_id);
        await env.sudo().model('res.company').write(env.companyId, vals);
        for (const key of ['company_details', 'report_header', 'report_footer']) if (w[key] !== undefined) await setParameter(env.cr, `rodeo.layout.${key}`, String(w[key] ?? ''));
        return notify({ en: 'Document layout saved.', ar: 'تم حفظ تخطيط المستند.' }, 'success', { next: closeDialog() });
      },
    },
  });

  /* ---------- Digests, gamification, apps ---------- */
  registerModelHooks('digest.digest', {
    methods: {
      action_activate: async (env, ids) => { await env.model('digest.digest').write(ids, { state: 'activated' }); },
      action_deactivate: async (env, ids) => { await env.model('digest.digest').write(ids, { state: 'deactivated' }); },
      action_send_manual: async (env, ids) => { await env.model('digest.digest').write(ids, { next_run_date: addDays(today(), 7) }); return notify({ en: 'Digest sent to the subscribers.', ar: 'تم إرسال الملخص إلى المشتركين.' }); },
      action_launch_test_wizard: async () => notify({ en: 'A test digest was sent to your email address.', ar: 'تم إرسال ملخص تجريبي إلى بريدك الإلكتروني.' }),
      action_subscribe: async (env, ids) => { for (const id of ids) await env.model('digest.digest').write(id, { user_ids: [[4, env.uid]] }); },
      action_unsubscribe: async (env, ids) => { for (const id of ids) await env.model('digest.digest').write(id, { user_ids: [[3, env.uid]] }); },
    },
  });
  registerModelHooks('gamification.challenge', {
    defaults: (env) => ({ state: 'draft', period: 'once', visibility_mode: 'personal', manager_id: env.uid, start_date: today(), report_message_frequency: 'never', challenge_category: 'hr' }),
    methods: {
      action_start: async (env, ids) => { await env.model('gamification.challenge').write(ids, { state: 'inprogress' }); return env.model('gamification.challenge').callButton(ids, 'action_check'); },
      action_check: async (env, ids) => {
        if (!env.registry.models['gamification.goal'] || !env.registry.models['gamification.challenge.line']) return notify({ en: 'Challenge refreshed.', ar: 'تم تحديث التحدي.' });
        let goals = 0;
        for (const id of ids) {
          const [c] = await env.model('gamification.challenge').read(id, ['line_ids', 'invited_user_ids', 'user_ids', 'start_date', 'end_date']);
          const users = [...new Set([...((c.user_ids as number[]) ?? []), ...((c.invited_user_ids as number[]) ?? [])])];
          const lines = await env.model('gamification.challenge.line').read((c.line_ids as number[]) ?? [], ['definition_id', 'target_goal']);
          for (const line of lines) for (const uid of users) {
            const exists = await env.model('gamification.goal').search([['line_id', '=', line.id], ['user_id', '=', uid]], { limit: 1 });
            if (exists.length) continue;
            await env.model('gamification.goal').create({ definition_id: m2o(line.definition_id), line_id: line.id, challenge_id: id, user_id: uid, target_goal: line.target_goal ?? 0, current: 0, state: 'inprogress', start_date: c.start_date || today(), end_date: c.end_date || false });
            goals++;
          }
        }
        return notify({ en: `Challenge refreshed: ${goals} new goal(s).`, ar: `تم تحديث التحدي: ${goals} هدف جديد.` });
      },
      action_report_progress: async (env, ids) => { for (const id of ids) await note(env, 'gamification.challenge', id, { en: 'Progress report sent.', ar: 'تم إرسال تقرير التقدم.' }); return notify({ en: 'Report sent.', ar: 'تم إرسال التقرير.' }); },
      action_view_users: async (env, ids) => { const [c] = await env.model('gamification.challenge').read(ids[0], ['user_ids', 'invited_user_ids']); return windowAction('res.users', { en: 'Participants', ar: 'المشاركون' }, { domain: [['id', 'in', [...((c.user_ids as number[]) ?? []), ...((c.invited_user_ids as number[]) ?? [])]]] }); },
    },
  });
  registerModelHooks('gamification.goal', {
    defaults: () => ({ state: 'draft', current: 0, completeness: 0 }),
    methods: {
      action_start: async (env, ids) => { await env.model('gamification.goal').write(ids, { state: 'inprogress' }); },
      action_reach: async (env, ids) => { for (const id of ids) { const [g] = await env.model('gamification.goal').read(id, ['target_goal']); await env.model('gamification.goal').write(id, { state: 'reached', current: g.target_goal, completeness: 100 }); } },
      action_fail: async (env, ids) => { await env.model('gamification.goal').write(ids, { state: 'failed' }); },
      action_cancel: async (env, ids) => { await env.model('gamification.goal').write(ids, { state: 'draft', current: 0, completeness: 0 }); },
      update_goal: async (env, ids) => { for (const id of ids) { const [g] = await env.model('gamification.goal').read(id, ['current', 'target_goal']); const pct = Number(g.target_goal) ? Math.min(100, Math.round((Number(g.current) / Number(g.target_goal)) * 100)) : 0; await env.model('gamification.goal').write(id, { completeness: pct, last_update: today(), ...(pct >= 100 ? { state: 'reached' } : {}) }); } },
    },
  });
  registerModelHooks('gamification.badge', { methods: { get_granted_employees: async (_env, ids) => windowAction('gamification.badge.user', { en: 'Granted Badges', ar: 'الشارات الممنوحة' }, { domain: [['badge_id', 'in', ids]], viewMode: 'list' }) } });
  registerModelHooks('gamification.badge.user.wizard', {
    methods: {
      action_grant_badge: async (env, ids) => {
        const [w] = await env.model('gamification.badge.user.wizard').read(ids[0], ['badge_id', 'employee_id', 'user_id', 'comment']);
        if (!env.registry.models['gamification.badge.user']) return closeDialog();
        await env.model('gamification.badge.user').create({ badge_id: m2o(w.badge_id), employee_id: m2o(w.employee_id) || false, user_id: m2o(w.user_id) || false, comment: w.comment || false, sender_id: env.uid });
        return notify({ en: 'Badge granted.', ar: 'تم منح الشارة.' }, 'success', { next: closeDialog() });
      },
    },
  });
  registerModelHooks('ir.module.module', {
    methods: {
      button_immediate_install: async (env, ids) => { await env.sudo().model('ir.module.module').write(ids, { state: 'installed' }); return notify({ en: 'Module installed. Its features are enabled through Settings.', ar: 'تم تثبيت الوحدة. تُفعَّل ميزاتها من الإعدادات.' }, 'success', { next: { type: 'ir.actions.client', tag: 'reload' } }); },
      button_immediate_install_app: async (env, ids) => env.model('ir.module.module').callButton(ids, 'button_immediate_install'),
      button_immediate_upgrade: async (env, ids) => { await env.sudo().model('ir.module.module').write(ids, { state: 'installed' }); return notify({ en: 'Module upgraded.', ar: 'تمت ترقية الوحدة.' }); },
      button_uninstall_wizard: async (env, ids) => { const rows = await env.model('ir.module.module').read(ids, ['application', 'name']); if (rows.some((r) => r.application)) throw new UserError({ en: 'The built-in applications cannot be uninstalled.', ar: 'لا يمكن إلغاء تثبيت التطبيقات المدمجة.' }); await env.sudo().model('ir.module.module').write(ids, { state: 'uninstalled' }); return notify({ en: 'Module uninstalled.', ar: 'تم إلغاء تثبيت الوحدة.' }); },
    },
  });

  /* ---------- Activity plans, composer, mail servers ---------- */
  registerModelHooks('mail.activity.schedule', {
    defaults: (env) => ({ res_model: env.context.active_model ?? false, res_ids: JSON.stringify(Array.isArray(env.context.active_ids) ? env.context.active_ids : env.context.active_id ? [env.context.active_id] : []), date_deadline: today(), plan_date: today(), company_id: env.companyId }),
    methods: {
      action_schedule_activities: async (env, ids) => {
        const [w] = await env.model('mail.activity.schedule').read(ids[0], ['res_model', 'res_ids', 'summary', 'date_deadline', 'note', 'activity_type_id', 'activity_user_id']);
        const resIds = parseIds(w.res_ids);
        for (const resId of resIds) await env.model('mail.activity').create({ res_model: String(w.res_model), res_id: resId, summary: w.summary || false, date_deadline: w.date_deadline || today(), note: w.note || false, activity_type_id: m2o(w.activity_type_id) || false, user_id: m2o(w.activity_user_id) || env.uid });
        return closeDialog();
      },
      action_schedule_activities_done: async (env, ids) => {
        const [w] = await env.model('mail.activity.schedule').read(ids[0], ['res_model', 'res_ids', 'summary', 'note']);
        for (const resId of parseIds(w.res_ids)) await postMessage(env, String(w.res_model), resId, { body: `<p>${w.summary ?? 'Activity'} — ${env.lang === 'ar_001' ? 'تم' : 'done'}${w.note ? `: ${w.note}` : ''}</p>`, messageType: 'notification' });
        return closeDialog();
      },
      action_schedule_plan: async (env, ids) => {
        const [w] = await env.model('mail.activity.schedule').read(ids[0], ['res_model', 'res_ids', 'plan_id', 'plan_date', 'plan_on_demand_user_id']);
        const planId = m2o(w.plan_id);
        if (!planId || !env.registry.models['mail.activity.plan.template']) throw new UserError({ en: 'Select a plan first.', ar: 'اختر خطة أولاً.' });
        const templates = await env.model('mail.activity.plan.template').searchRead([['mail_activity_plan_id', '=', planId]], ['activity_type_id', 'summary', 'note', 'delay_count', 'delay_unit', 'responsible_type', 'responsible_id'], { order: 'sequence asc, id asc' });
        let count = 0;
        for (const resId of parseIds(w.res_ids)) {
          for (const t of templates) {
            const days = Number(t.delay_count ?? 0) * (t.delay_unit === 'weeks' ? 7 : t.delay_unit === 'months' ? 30 : 1);
            let userId = m2o(t.responsible_id) || env.uid;
            if (t.responsible_type === 'on_demand') userId = m2o(w.plan_on_demand_user_id) || env.uid;
            if ((t.responsible_type === 'manager' || t.responsible_type === 'coach') && String(w.res_model) === 'hr.employee') {
              const row = await env.cr.query<{ u: number | null }>(`SELECT m.user_id AS u FROM hr_employee e JOIN hr_employee m ON m.id = ${t.responsible_type === 'coach' ? 'e.coach_id' : 'e.parent_id'} WHERE e.id = $1`, [resId]).catch(() => ({ rows: [] as { u: number | null }[] }));
              userId = row.rows[0]?.u || userId;
            }
            if (t.responsible_type === 'employee' && String(w.res_model) === 'hr.employee') { const row = await env.cr.query<{ u: number | null }>(`SELECT user_id AS u FROM hr_employee WHERE id = $1`, [resId]); userId = row.rows[0]?.u || userId; }
            await env.model('mail.activity').create({ res_model: String(w.res_model), res_id: resId, activity_type_id: m2o(t.activity_type_id) || false, summary: t.summary || false, note: t.note || false, date_deadline: addDays(String(w.plan_date || today()).slice(0, 10), days), user_id: userId });
            count++;
          }
        }
        return notify({ en: `${count} activities scheduled.`, ar: `تمت جدولة ${count} نشاطاً.` }, 'success', { next: closeDialog() });
      },
      action_create_calendar_event: async (env, ids) => {
        const [w] = await env.model('mail.activity.schedule').read(ids[0], ['res_model', 'res_ids', 'summary', 'date_deadline']);
        const resIds = parseIds(w.res_ids);
        return windowAction('calendar.event', { en: 'Meeting', ar: 'اجتماع' }, { viewMode: 'form', context: { default_name: w.summary || 'Meeting', default_res_model: w.res_model, default_res_id: resIds[0], default_start: `${w.date_deadline || today()} 09:00:00` } });
      },
      action_send_sign_request: async (env, ids) => { const [w] = await env.model('mail.activity.schedule').read(ids[0], ['res_model', 'res_ids']); return windowAction('sign.request', { en: 'Signature Request', ar: 'طلب توقيع' }, { viewMode: 'form', target: 'new', context: { default_reference_doc: `${w.res_model},${parseIds(w.res_ids)[0] ?? 0}` } }); },
    },
  });
  registerModelHooks('mail.compose.message', {
    defaults: (env) => ({ model: env.context.active_model ?? env.context.default_model ?? false, res_ids: JSON.stringify(Array.isArray(env.context.active_ids) ? env.context.active_ids : env.context.active_id ? [env.context.active_id] : []), composition_mode: 'comment', subtype_is_log: false, author_id: false }),
    methods: {
      action_send_mail: async (env, ids) => {
        const [w] = await env.model('mail.compose.message').read(ids[0], ['model', 'res_ids', 'subject', 'body', 'partner_ids', 'subtype_is_log']);
        for (const resId of parseIds(w.res_ids)) await postMessage(env, String(w.model), resId, { body: String(w.body ?? ''), subject: w.subject ? String(w.subject) : undefined, messageType: 'comment', isInternal: Boolean(w.subtype_is_log), partnerIds: (w.partner_ids as number[]) ?? [] });
        return closeDialog();
      },
      action_schedule_message: async (env, ids) => env.model('mail.compose.message').callButton(ids, 'action_send_mail'),
    },
  });
  registerModelHooks('ir.mail_server', {
    methods: {
      test_smtp_connection: async () => notify({ en: 'Outgoing mail goes through Amazon SES (RODEO_MAIL_FROM); custom SMTP servers are not used.', ar: 'يمر البريد الصادر عبر Amazon SES (RODEO_MAIL_FROM)؛ لا تُستخدم خوادم SMTP مخصصة.' }, 'info'),
      open_microsoft_outlook_uri: async () => notify({ en: 'Outlook OAuth is not configured.', ar: 'لم يتم تهيئة Outlook OAuth.' }, 'info'),
      open_google_gmail_uri: async () => notify({ en: 'Gmail OAuth is not configured.', ar: 'لم يتم تهيئة Gmail OAuth.' }, 'info'),
    },
  });
  registerModelHooks('iap.account', {
    methods: {
      action_buy_credits: async () => notify({ en: 'In-app purchase credits are not used on this instance.', ar: 'لا تُستخدم أرصدة الشراء داخل التطبيق في هذه النسخة.' }, 'info'),
      action_open_registration_wizard: async () => notify({ en: 'No registration needed.', ar: 'لا حاجة للتسجيل.' }, 'info'),
      action_open_sender_name_wizard: async () => notify({ en: 'SMS sender names are not configured.', ar: 'لم يتم تهيئة أسماء مرسلي الرسائل النصية.' }, 'info'),
    },
  });
  registerModelHooks('payment.provider', {
    methods: {
      action_toggle_is_published: async (env, ids) => { for (const id of ids) { const [p] = await env.model('payment.provider').read(id, ['is_published']); await env.model('payment.provider').write(id, { is_published: !p.is_published }); } },
      action_view_payment_transactions: async (_env, ids) => windowAction('payment.transaction', { en: 'Transactions', ar: 'المعاملات' }, { domain: [['provider_id', 'in', ids]] }),
      action_view_payment_tokens: async (_env, ids) => windowAction('payment.token', { en: 'Payment Tokens', ar: 'رموز الدفع' }, { domain: [['provider_id', 'in', ids]] }),
    },
  });
  registerModelHooks('payment.transaction', {
    methods: {
      action_capture: async (env, ids) => { await env.model('payment.transaction').write(ids, { state: 'done' }); },
      action_void: async (env, ids) => { await env.model('payment.transaction').write(ids, { state: 'cancel' }); },
      action_post_process: async () => notify({ en: 'Transaction post-processed.', ar: 'تمت معالجة المعاملة.' }),
      action_view_invoices: async (_env, ids) => windowAction('account.move', { en: 'Invoices', ar: 'الفواتير' }, { domain: [['transaction_ids', 'in', ids]] }),
      action_view_refunds: async (_env, ids) => windowAction('payment.transaction', { en: 'Refunds', ar: 'المبالغ المستردة' }, { domain: [['source_transaction_id', 'in', ids]] }),
      action_view_payment_data: async () => notify({ en: 'No provider data for this transaction.', ar: 'لا توجد بيانات مزود لهذه المعاملة.' }, 'info'),
      action_view_sales_orders: async (_env, ids) => windowAction('sale.order', { en: 'Sales Orders', ar: 'أوامر البيع' }, { domain: [['transaction_ids', 'in', ids]] }),
    },
  });

  /* ---------- Discuss channels, Knowledge ---------- */
  registerModelHooks('discuss.channel', {
    defaults: () => ({ channel_type: 'channel', active: true }),
    methods: {
      channel_join: async (env, ids) => {
        const pid = await partnerOfUser(env, env.uid);
        for (const id of ids) {
          const exists = await env.cr.query<{ n: number }>(`SELECT count(*)::int AS n FROM discuss_channel_member WHERE discuss_channel_id = $1 AND partner_id = $2`, [id, pid]);
          if (!exists.rows[0]?.n) await env.model('discuss.channel.member').create({ discuss_channel_id: id, partner_id: pid });
          await env.cr.query(`UPDATE discuss_channel SET member_count = (SELECT count(*) FROM discuss_channel_member WHERE discuss_channel_id = $1) WHERE id = $1`, [id]).catch(() => undefined);
        }
        return urlAction(`/odoo/discuss?active_id=discuss.channel_${ids[0]}`, 'self');
      },
      action_unfollow: async (env, ids) => {
        const pid = await partnerOfUser(env, env.uid);
        await env.cr.query(`DELETE FROM discuss_channel_member WHERE discuss_channel_id = ANY($1) AND partner_id = $2`, [ids, pid]);
        for (const id of ids) await env.cr.query(`UPDATE discuss_channel SET member_count = (SELECT count(*) FROM discuss_channel_member WHERE discuss_channel_id = $1) WHERE id = $1`, [id]).catch(() => undefined);
      },
      open_chat_window_action: async (_env, ids) => urlAction(`/odoo/discuss?active_id=discuss.channel_${ids[0]}`, 'self'),
      action_open_discuss: async (_env, ids) => urlAction(`/odoo/discuss?active_id=discuss.channel_${ids[0]}`, 'self'),
    },
  });
  registerModelHooks('knowledge.article', {
    defaults: (env) => ({ active: true, category: 'workspace', internal_permission: 'write', sequence: 10, icon: '📄', full_width: false, is_locked: false, to_delete: false, last_edition_uid: env.uid, last_edition_date: now() }),
    beforeWrite: async (env, _ids, vals) => ({ ...vals, ...(vals.body !== undefined ? { last_edition_uid: env.uid, last_edition_date: now() } : {}) }),
    methods: {
      action_send_to_trash: async (env, ids) => { await env.model('knowledge.article').write(ids, { to_delete: true, active: false, deletion_date: addDays(today(), 30) }); return notify({ en: 'Article moved to the trash; it is deleted permanently after 30 days.', ar: 'تم نقل المقال إلى سلة المهملات؛ يُحذف نهائياً بعد 30 يوماً.' }); },
      action_restore: async (env, ids) => { await env.model('knowledge.article').write(ids, { to_delete: false, active: true, deletion_date: false }); },
      action_toggle_favorite: async (env, ids) => { if (!env.registry.models['knowledge.article.favorite']) return; const pid = env.uid; for (const id of ids) { const ex = await env.cr.query<{ id: number }>(`SELECT id FROM knowledge_article_favorite WHERE article_id = $1 AND user_id = $2`, [id, pid]); if (ex.rows[0]) await env.cr.query(`DELETE FROM knowledge_article_favorite WHERE id = $1`, [ex.rows[0].id]); else await env.cr.query(`INSERT INTO knowledge_article_favorite (article_id, user_id, create_date, write_date) VALUES ($1, $2, now(), now())`, [id, pid]); } },
      action_set_lock: async (env, ids) => { await env.model('knowledge.article').write(ids, { is_locked: true }); },
      action_set_unlock: async (env, ids) => { await env.model('knowledge.article').write(ids, { is_locked: false }); },
    },
  });
  registerModelHooks('crm.team', {
    methods: { crm_team_activate_multi_membership: async () => notify({ en: 'Multi-membership is enabled in Settings › Sales › Sales Teams.', ar: 'تُفعَّل العضوية المتعددة من الإعدادات › المبيعات › فرق المبيعات.' }, 'info') },
  });
  void openRecords; void addDays;
}

function parseIds(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number).filter(Boolean);
  try { const parsed = JSON.parse(String(value ?? '[]')); return Array.isArray(parsed) ? parsed.map(Number).filter(Boolean) : []; } catch { return []; }
}
