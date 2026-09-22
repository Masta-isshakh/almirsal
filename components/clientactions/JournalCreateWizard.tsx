'use client';

import { useState } from 'react';
import { rpc } from '@/lib/client/rpc';
import { useT } from '@/lib/client/i18n';
import { useNavigation } from '@/lib/client/navigation';
import { useUi } from '../webclient/ui';

const TYPES: { type: string; icon: string; label: string; help: string }[] = [
  { type: 'sale', icon: 'fa-file-text-o', label: 'Sales', help: 'Customer invoices and credit notes' },
  { type: 'purchase', icon: 'fa-shopping-cart', label: 'Purchases', help: 'Vendor bills and refunds' },
  { type: 'bank', icon: 'fa-university', label: 'Bank', help: 'Bank statements and payments' },
  { type: 'cash', icon: 'fa-money', label: 'Cash', help: 'Cash register' },
  { type: 'general', icon: 'fa-book', label: 'Miscellaneous', help: 'Manual journal entries' },
];

/** Accounting dashboard › "What type of journal do you want to add?" — creates the journal and opens its form. */
export function JournalCreateWizard({ onDone }: { onDone?: (changed: boolean) => void }) {
  const t = useT();
  const ui = useUi();
  const { navigate } = useNavigation();
  const [busy, setBusy] = useState<string | null>(null);
  const create = async (type: string, label: string) => {
    setBusy(type);
    try {
      const code = `${type.slice(0, 3).toUpperCase()}${Math.floor(Math.random() * 90) + 10}`;
      const id = await rpc<number>('create', 'account.journal', { values: { name: t(label), type, code } });
      onDone?.(true);
      navigate(`/odoo/action-330/${id}`);
    } catch (error) { ui.notify({ type: 'danger', message: String((error as Error).message ?? error) }); }
    setBusy(null);
  };
  return (
    <div className="o_journal_create d-flex flex-wrap gap-3 justify-content-center p-2">
      {TYPES.map((item) => (
        <button key={item.type} type="button" className="o_journal_type" disabled={busy !== null} onClick={() => create(item.type, item.label)}>
          <i className={`fa ${item.icon} fa-2x mb-2`} />
          <div className="fw-bold">{t(item.label)}</div>
          <div className="small text-muted">{t(item.help)}</div>
          {busy === item.type && <i className="fa fa-circle-o-notch fa-spin mt-1" />}
        </button>
      ))}
    </div>
  );
}
