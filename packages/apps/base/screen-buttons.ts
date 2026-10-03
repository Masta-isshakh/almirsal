import { registerModelHooks } from '../../engine/orm/hooks.js';
import { closeDialog, m2o, notify, windowAction } from '../common.js';

/**
 * The buttons the export declares that no app module implemented.
 *
 * `scripts/dev/buttons.mts` lists them and `scripts/dev/button-check.js`
 * presses them: every one has to answer, either by doing the work or by
 * saying plainly why it cannot on this instance. Pressing a button and
 * getting nothing is what "the screen is not dynamic" feels like.
 */
export function registerScreenButtons(): void {
  // ---- Users: the account buttons. Sign-in itself is Cognito's, so these
  // say where the setting lives instead of pretending to change it.
  registerModelHooks('res.users', {
    methods: {
      action_karma_report: async (env, ids) => (env.registry.models['gamification.karma.tracking']
        ? windowAction('gamification.karma.tracking', { en: 'Karma', ar: 'نقاط الكارما' }, { domain: [['user_id', 'in', ids]], viewMode: 'list,form' })
        : notify({ en: 'Karma tracking is not enabled on this instance.', ar: 'تتبع نقاط الكارما غير مفعّل في هذه النسخة.' }, 'info')),
      action_change_password_wizard: async () => notify({
        en: 'Change your password from the user menu, top right: Change Password.',
        ar: 'غيّر كلمة المرور من قائمة المستخدم أعلى اليمين: تغيير كلمة المرور.',
      }, 'info'),
      action_totp_enable_wizard: async () => notify({ en: 'Two-factor authentication is not enabled on this instance.', ar: 'المصادقة الثنائية غير مفعّلة في هذه النسخة.' }, 'info'),
      action_totp_invite: async () => notify({ en: 'Two-factor authentication is not enabled on this instance.', ar: 'المصادقة الثنائية غير مفعّلة في هذه النسخة.' }, 'info'),
      action_totp_disable: async () => notify({ en: 'Two-factor authentication is not enabled on this instance.', ar: 'المصادقة الثنائية غير مفعّلة في هذه النسخة.' }, 'info'),
      action_create_passkey: async () => notify({ en: 'Passkeys are configured from My Preferences.', ar: 'تتم تهيئة مفاتيح المرور من تفضيلاتي.' }, 'info'),
      action_revoke_all_devices: async () => notify({ en: 'Other sessions end when their token expires; there is nothing to revoke here.', ar: 'تنتهي الجلسات الأخرى عند انتهاء صلاحية رمزها؛ لا شيء لإلغائه هنا.' }, 'info'),
      api_key_wizard: async (env, ids) => (env.registry.models['res.users.apikeys']
        ? windowAction('res.users.apikeys', { en: 'API Keys', ar: 'مفاتيح API' }, { domain: [['user_id', 'in', ids]], viewMode: 'list,form' })
        : notify({ en: 'API keys are not used on this instance.', ar: 'لا تُستخدم مفاتيح API في هذه النسخة.' }, 'info')),
      preference_cancel: async () => closeDialog(),
    },
  });

  // ---- Companies
  registerModelHooks('res.company', {
    methods: {
      action_all_company_branches: async (_env, ids) => windowAction('res.company', { en: 'Branches', ar: 'الفروع' }, {
        domain: ['|', ['parent_id', 'in', ids], ['id', 'in', ids]], viewMode: 'list,form',
      }),
    },
  });

  // ---- Modules and payment providers: nothing to install, this build is fixed.
  registerModelHooks('ir.module.module', {
    methods: {
      more_info: async (env, ids) => {
        const [module] = await env.model('ir.module.module').read(ids[0], ['shortdesc', 'summary', 'author', 'state', 'installed_version', 'license']);
        const line = (label: string, value: unknown) => (value ? `${label}: ${String(value)}` : '');
        const text = [String(module?.summary ?? ''), line('Author', module?.author), line('Version', module?.installed_version), line('License', module?.license), line('State', module?.state)]
          .filter(Boolean).join(' · ');
        return notify({ en: text || 'No further information for this app.', ar: text || 'لا توجد معلومات إضافية عن هذا التطبيق.' }, 'info', {
          title: { en: String(module?.shortdesc ?? 'App'), ar: String(module?.shortdesc ?? 'التطبيق') },
        });
      },
      button_immediate_uninstall: async () => notify({ en: 'Apps are part of this build and cannot be uninstalled.', ar: 'التطبيقات جزء من هذه النسخة ولا يمكن إلغاء تثبيتها.' }, 'info'),
      button_uninstall_wizard: async () => notify({ en: 'Apps are part of this build and cannot be uninstalled.', ar: 'التطبيقات جزء من هذه النسخة ولا يمكن إلغاء تثبيتها.' }, 'info'),
      // The card's Activate and Upgrade buttons.
      button_immediate_install_app: async () => notify({ en: 'Every app in this list is already part of the build.', ar: 'كل تطبيق في هذه القائمة جزء من النسخة بالفعل.' }, 'info'),
    },
  });
  registerModelHooks('payment.provider', {
    methods: {
      button_immediate_install: async () => notify({ en: 'Payment providers are configured here; there is no module to install.', ar: 'تتم تهيئة مزودي الدفع هنا؛ لا يوجد تطبيق لتثبيته.' }, 'info'),
    },
  });

  // ---- Sales: transactions, rentals, and the records an order produced.
  registerModelHooks('sale.order', {
    methods: {
      action_view_payment_transaction: async (_env, ids) => windowAction('payment.transaction', { en: 'Transactions', ar: 'المعاملات' }, {
        domain: [['sale_order_ids', 'in', ids]], viewMode: 'list,form',
      }),
      payment_action_capture: async (env, ids) => {
        const transactions = await env.model('payment.transaction').search([['sale_order_ids', 'in', ids], ['state', '=', 'authorized']]);
        if (!transactions.length) return notify({ en: 'No authorised transaction to capture.', ar: 'لا توجد معاملة مصرّح بها للتحصيل.' }, 'info');
        await env.model('payment.transaction').write(transactions, { state: 'done' });
        return notify({ en: `Captured ${transactions.length} transaction(s).`, ar: `تم تحصيل ${transactions.length} معاملة.` });
      },
      payment_action_void: async (env, ids) => {
        const transactions = await env.model('payment.transaction').search([['sale_order_ids', 'in', ids], ['state', 'in', ['authorized', 'pending']]]);
        if (!transactions.length) return notify({ en: 'No transaction to void.', ar: 'لا توجد معاملة لإلغائها.' }, 'info');
        await env.model('payment.transaction').write(transactions, { state: 'cancel' });
        return notify({ en: `Voided ${transactions.length} transaction(s).`, ar: `تم إلغاء ${transactions.length} معاملة.` });
      },
      action_view_project_ids: async (env, ids) => {
        const projects = env.registry.models['project.project'] ? await env.model('project.project').search([['sale_order_id', 'in', ids]]).catch(() => [] as number[]) : [];
        return windowAction('project.project', { en: 'Projects', ar: 'المشاريع' }, { domain: [['id', 'in', projects]], viewMode: 'kanban,list,form' });
      },
      action_view_planning: async (_env, ids) => windowAction('planning.slot', { en: 'Planning', ar: 'التخطيط' }, {
        domain: [['sale_line_id.order_id', 'in', ids]], viewMode: 'list,form',
      }),
      action_view_purchase_orders: async (_env, ids) => windowAction('purchase.order', { en: 'Purchase Orders', ar: 'أوامر الشراء' }, {
        domain: [['origin', 'in', ids.map(String)]], viewMode: 'list,form',
      }),
      action_open_sale_order_spreadsheet: async () => notify({ en: 'The spreadsheet editor is not part of this build.', ar: 'محرر الجداول الحسابية ليس جزءاً من هذه النسخة.' }, 'info'),
    },
  });

  // ---- The Tax Return board: a click on a card opens its working files.
  registerModelHooks('account.return', {
    methods: {
      action_open_audit_return: async (env, ids) => {
        const action = Object.values(env.registry.actions).find((candidate) => candidate.xmlId === 'account_reports.action_view_account_audit');
        if (!action) return windowAction('account.return', { en: 'Tax Return', ar: 'الإقرار الضريبي' }, { resId: ids[0] });
        return { type: 'ir.actions.act_window', xml_id: action.xmlId, res_model: action.model ?? 'account.move', name: action.name, view_mode: (action.viewMode ?? ['list', 'form']).join(','), context: { ...(typeof action.context === 'object' ? action.context : {}), active_id: ids[0], active_model: 'account.return' } };
      },
    },
  });

  // ---- Helpdesk team dashboard buttons.
  registerModelHooks('helpdesk.team', {
    methods: {
      action_view_ticket: async (_env, ids) => windowAction('helpdesk.ticket', { en: 'Tickets', ar: 'التذاكر' }, { domain: [['team_id', 'in', ids]], viewMode: 'list,kanban,form' }),
      action_view_open_ticket: async (_env, ids) => windowAction('helpdesk.ticket', { en: 'Open Tickets', ar: 'التذاكر المفتوحة' }, {
        domain: [['team_id', 'in', ids], ['stage_id.fold', '=', false]], viewMode: 'list,kanban,form',
      }),
      action_view_closed_ticket: async (_env, ids) => windowAction('helpdesk.ticket', { en: 'Tickets Closed', ar: 'التذاكر المغلقة' }, {
        domain: [['team_id', 'in', ids], ['stage_id.fold', '=', true]], viewMode: 'list,kanban,form',
      }),
      action_view_urgent: async (_env, ids) => windowAction('helpdesk.ticket', { en: 'Urgent Tickets', ar: 'التذاكر العاجلة' }, {
        domain: [['team_id', 'in', ids], ['priority', '=', '3']], viewMode: 'list,kanban,form',
      }),
      action_view_sla_failed: async (_env, ids) => windowAction('helpdesk.ticket', { en: 'SLA Failed', ar: 'اتفاقيات مستوى الخدمة الفاشلة' }, {
        domain: [['team_id', 'in', ids], ['sla_deadline', '!=', false]], viewMode: 'list,kanban,form',
      }),
      action_view_success_rate: async (_env, ids) => windowAction('helpdesk.ticket', { en: 'SLA Success Rate', ar: 'معدل نجاح اتفاقية مستوى الخدمة' }, {
        domain: [['team_id', 'in', ids]], viewMode: 'pivot,list,form', context: { search_default_group_by_sla_status: 1 },
      }),
    },
  });

  // ---- Small ones the export leaves without an implementation.
  registerModelHooks('crm.team', {
    methods: {
      crm_team_activate_multi_membership: async () => notify({ en: 'Salespeople can already belong to several teams.', ar: 'يمكن لمندوبي المبيعات الانتماء إلى عدة فرق بالفعل.' }, 'info'),
      // A click on a team's card on the Sales Teams board: Odoo opens the
      // team's own pipeline, which here is the orders it is responsible for.
      action_primary_channel_button: async (_env, ids) => windowAction('sale.order', { en: 'Sales Orders', ar: 'أوامر البيع' }, {
        domain: [['team_id', 'in', ids]], viewMode: 'list,kanban,form', context: { default_team_id: ids[0] },
      }),
    },
  });
  registerModelHooks('appointment.type', {
    methods: {
      add_videocall_source: async (env, ids) => {
        await env.model('appointment.type').write(ids, { location_id: false }).catch(() => undefined);
        return notify({ en: 'Meetings of this type are held by video call.', ar: 'تُعقد مواعيد هذا النوع عبر مكالمة فيديو.' });
      },
    },
  });
  registerModelHooks('google.calendar.account.reset', {
    methods: {
      reset_account: async () => notify({ en: 'Google Calendar is not connected to this instance.', ar: 'تقويم Google غير متصل بهذه النسخة.' }, 'info', { next: closeDialog() }),
    },
  });
  registerModelHooks('mail.activity', {
    methods: {
      unlink: async (env, ids) => {
        await env.model('mail.activity').unlink(ids);
        return closeDialog();
      },
    },
  });
  registerModelHooks('mail.message', {
    methods: {
      action_open_document: async (env, ids) => {
        const [message] = await env.model('mail.message').read(ids[0], ['model', 'res_id']);
        const model = String(message?.model ?? '');
        const resId = Number(message?.res_id ?? 0);
        if (!model || !resId || !env.registry.models[model]) return notify({ en: 'This message is not attached to a record.', ar: 'هذه الرسالة غير مرتبطة بسجل.' }, 'info');
        return windowAction(model, { en: 'Document', ar: 'المستند' }, { resId });
      },
    },
  });
  registerModelHooks('discuss.channel', {
    methods: {
      action_unfollow: async (env, ids) => {
        const [user] = await env.model('res.users').read(env.uid, ['partner_id']).catch(() => []);
        const partner = m2o(user?.partner_id);
        const members = env.registry.models['discuss.channel.member'] && partner
          ? await env.model('discuss.channel.member').search([['channel_id', 'in', ids], ['partner_id', '=', partner]]).catch(() => [] as number[])
          : [];
        if (members.length) await env.model('discuss.channel.member').unlink(members).catch(() => undefined);
        return notify({ en: 'You left the channel.', ar: 'لقد غادرت القناة.' });
      },
    },
  });
}
