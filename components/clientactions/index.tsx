'use client';

import { useEffect, useRef } from 'react';
import type { ActionDef } from '@engine/registry/types';
import { rpc } from '@/lib/client/rpc';
import { useT } from '@/lib/client/i18n';
import { useActions } from '@/lib/client/actions';
import { useNavigation } from '@/lib/client/navigation';
import { useUi } from '../webclient/ui';
import type { SessionInfo } from '../webclient/WebClient';
import { AccountReport } from './AccountReport';
import { DiscussSettingsDialog } from './DiscussSettings';
import { JournalCreateWizard } from './JournalCreateWizard';
import { Discuss } from './Discuss';
import { Dashboards } from './Dashboards';
import { Documents } from './Documents';

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
export function ServerActionPage({ action }: { action: ActionDef }) {
  const t = useT();
  const { doAction } = useActions();
  const ui = useUi();
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    rpc<Record<string, unknown>>('runServerAction', null, { id: String(action.id) })
      .then((result) => doAction(result, {}))
      .catch((error) => ui.notify({ type: 'warning', message: String((error as Error).message ?? error) }));
  }, [action.id, doAction, ui]);
  return (
    <div className="p-5 text-center text-muted">
      <i className="fa fa-circle-o-notch fa-spin fa-2x d-block mb-3 opacity-50" aria-hidden="true" />
      {t(action.name)}
    </div>
  );
}
