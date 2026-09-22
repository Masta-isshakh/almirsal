'use client';

import type { ActionDef } from '@engine/registry/types';
import { useT } from '@/lib/client/i18n';
import { useNavigation } from '@/lib/client/navigation';
import { useUi } from '../webclient/ui';
import type { SessionInfo } from '../webclient/WebClient';
import { AccountReport } from './AccountReport';
import { DiscussSettingsDialog } from './DiscussSettings';
import { JournalCreateWizard } from './JournalCreateWizard';
import { Discuss } from './Discuss';
import { Dashboards } from './Dashboards';
import { Documents } from './Documents';
import { GreenSavings } from './GreenSavings';

/**
 * Client actions (`ir.actions.client`, C-8): the tag names the screen.
 * Screens that are not built yet render an explicit placeholder rather than
 * a silent failure, so every menu item still opens something.
 */
export const CLIENT_ACTION_TAGS: Record<string, string> = {
  account_report: 'Financial report',
  'mail.action_discuss': 'Discuss',
  action_spreadsheet_dashboard: 'Dashboards',
  'mail.discuss_notification_settings_action': 'Notification settings',
  'mail.discuss_call_settings_action': 'Voice & video settings',
  journal_create_wizard: 'Create a journal',
  account_import_guide: 'Import guide',
  document_action_preference: 'Documents',
};

export function ClientAction({ action, context, user, onDone }: { action: ActionDef; context: Record<string, unknown>; user?: SessionInfo; onDone?: (changed: boolean) => void }) {
  const t = useT();
  switch (action.tag) {
    case 'account_report': return <AccountReport action={action} context={context} />;
    case 'mail.action_discuss': return <Discuss context={context} user={user} />;
    case 'action_spreadsheet_dashboard': return <Dashboards context={context} />;
    case 'document_action_preference': return <Documents context={context} user={user} />;
    case 'mail.discuss_notification_settings_action': return <DiscussSettingsDialog kind="notifications" user={user} onDone={onDone} />;
    case 'mail.discuss_call_settings_action': return <DiscussSettingsDialog kind="call" user={user} onDone={onDone} />;
    case 'journal_create_wizard': return <JournalCreateWizard onDone={onDone} />;
    case 'account_import_guide': return <ImportGuide />;
    default:
      return (
        <div className="p-5 text-center text-muted">
          <i className="fa fa-window-maximize fa-2x d-block mb-3 opacity-50" aria-hidden="true" />
          <div className="fw-bold">{t(action.name)}</div>
          <div className="small">{t('This screen is being built.')} <code>{action.tag}</code></div>
        </div>
      );
  }
}

/** Accounting › Configuration › Import guide: what can be imported and how. */
function ImportGuide() {
  const t = useT();
  const { navigate } = useNavigation();
  const rows: [string, string, string][] = [
    ['Chart of Accounts', 'account.account', 'action-304'], ['Journals', 'account.journal', 'action-330'], ['Taxes', 'account.tax', 'action-305'],
    ['Customers & Vendors', 'res.partner', 'customers'], ['Products', 'product.template', 'products'], ['Customer Invoices', 'account.move', 'customer-invoices'], ['Vendor Bills', 'account.move', 'vendor-bills'],
  ];
  return (
    <div className="o_form_sheet_bg p-4">
      <div className="o_form_sheet" style={{ maxWidth: 900 }}>
        <h2>{t('Accounting Import Guide')}</h2>
        <p className="text-muted">{t('Open a list, use ⚙ › Import to upload a CSV or XLSX file with the columns of that model, map the columns, test, then import. Records are matched by name or external id.')}</p>
        <table className="o_list_table">
          <thead><tr><th>{t('Data')}</th><th>{t('Model')}</th><th /></tr></thead>
          <tbody>
            {rows.map(([label, model, slug]) => (
              <tr key={model}><td>{t(label)}</td><td><code>{model}</code></td><td className="text-end"><button type="button" className="btn btn-link btn-sm" onClick={() => navigate(`/odoo/${slug}`)}>{t('Open')} <i className="fa fa-arrow-right" /></button></td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** A URL bound to an `ir.actions.server`: run it and follow its result. */
/**
 * A menu bound to an `ir.actions.report`: Odoo renders the qweb-html report
 * in place. The export has one (Sign › Reports › Green Savings).
 */
export function ReportAction({ action }: { action: ActionDef }) {
  const t = useT();
  if (action.reportName === 'sign.green_savings_report') return <GreenSavings />;
  return (
    <div className="o_report_page p-5 text-center text-muted">
      <i className="fa fa-print fa-3x d-block mb-3 opacity-50" aria-hidden="true" />
      <h2 className="fs-4">{t(action.name)}</h2>
      <p>{t({ en: 'This report prints from a record: open one and use its Print menu.', ar: 'يُطبع هذا التقرير من سجل: افتح سجلاً واستخدم قائمة الطباعة.' })}</p>
    </div>
  );
}
