'use client';

import { useCallback, useEffect, useState } from 'react';
import { rpc } from '@/lib/client/rpc';
import { useLang, useT } from '@/lib/client/i18n';
import { useNavigation } from '@/lib/client/navigation';
import { useActions } from '@/lib/client/actions';
import { Dropdown } from '../webclient/Navbar';

interface Card {
  id: number; name: string; type: string; color: number; code: string;
  draftCount: number; draftAmount: number; unpaidCount: number; unpaidAmount: number; lateCount: number; lateAmount: number;
  balance: number; lastEntryDate: string | null; toCheck: number; entriesCount: number; due: { label: string; amount: number }[]; currency: string;
}

const TYPE_LABEL: Record<string, { en: string; ar: string }> = {
  sale: { en: 'Customer Invoices', ar: 'فواتير العملاء' }, purchase: { en: 'Vendor Bills', ar: 'فواتير الموردين' }, bank: { en: 'Bank', ar: 'البنك' }, cash: { en: 'Cash', ar: 'النقد' }, general: { en: 'Miscellaneous Operations', ar: 'العمليات المتنوعة' }, credit: { en: 'Credit Card', ar: 'البطاقة الائتمانية' },
};

/**
 * Accounting dashboard (C-8.7, `account_dashboard_kanban`): one card per
 * journal with its live numbers — invoices to validate / unpaid / late and
 * the due-by-week bars for sales and purchase journals, balance and last
 * entry for bank and cash, entries for the miscellaneous journal — with
 * the New / View / Reporting menu and a colour picker on every card.
 */
export function AccountingDashboard({ domain }: { domain: unknown[] }) {
  const t = useT();
  const lang = useLang();
  const { navigate } = useNavigation();
  const { doAction } = useActions();
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    const ids = await rpc<number[]>('search', 'account.journal', { domain, limit: 100, order: 'sequence asc, id asc' }, { silent: true }).catch(() => [] as number[]);
    const rows = await rpc<Card[]>('journalDashboard', null, { ids }, { silent: true }).catch(() => [] as Card[]);
    setCards(ids.length ? rows.filter((c) => ids.includes(c.id)) : rows);
    setLoading(false);
  }, [JSON.stringify(domain)]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);

  const money = (n: number, c: string) => `${n.toLocaleString(lang === 'ar_001' ? 'ar-EG-u-nu-latn' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${c}`.trim();
  const openMoves = (card: Card, extra: unknown[], name: string) => {
    const types = card.type === 'sale' ? ['out_invoice', 'out_refund'] : card.type === 'purchase' ? ['in_invoice', 'in_refund'] : ['entry'];
    void doAction({ type: 'ir.actions.act_window', res_model: 'account.move', name: { en: name, ar: name }, view_mode: 'list,form', domain: [['journal_id', '=', card.id], ['move_type', 'in', types], ...extra], context: { default_journal_id: card.id, default_move_type: types[0] } }, {});
  };
  const newMove = (card: Card) => {
    const type = card.type === 'sale' ? 'out_invoice' : card.type === 'purchase' ? 'in_invoice' : 'entry';
    const slug = type === 'out_invoice' ? 'customer-invoices' : type === 'in_invoice' ? 'vendor-bills' : 'action-279';
    navigate(`/odoo/${slug}/new?defaults=${encodeURIComponent(JSON.stringify({ journal_id: card.id, move_type: type }))}`);
  };
  const setColor = async (card: Card, color: number) => { await rpc('write', 'account.journal', { ids: [card.id], values: { color } }); await load(); };
  const maxDue = (card: Card) => Math.max(1, ...card.due.map((d) => d.amount));

  return (
    <div className="o_kanban_view o_account_dashboard">
      {loading && <div className="o_loading_indicator" />}
      {!loading && cards.length === 0 && <div className="p-5 text-center text-muted"><i className="fa fa-book fa-2x d-block mb-2 opacity-50" />{t('No journal to display. Create one from Configuration › Journals.')}</div>}
      {cards.map((card) => (
        <div key={card.id} className="o_journal_card" style={{ borderInlineStartColor: card.color ? `var(--o-color-${card.color})` : 'var(--o-border)' }}>
          <div className="o_journal_head">
            <div>
              <div className="o_journal_title" onClick={() => openMoves(card, [], card.name)}>{card.name}</div>
              <div className="small text-muted">{t(TYPE_LABEL[card.type] ?? { en: card.type, ar: card.type })}</div>
            </div>
            <Dropdown end toggle={() => <span className="o_journal_menu_toggle" title={t('Menu')}><i className="fa fa-ellipsis-v" /></span>}>
              <div className="o_journal_menu">
                <div className="o_journal_menu_col">
                  <div className="o_journal_menu_title">{t('View')}</div>
                  {(card.type === 'sale' || card.type === 'purchase') && <button type="button" className="o_dropdown_item" onClick={() => openMoves(card, [], card.type === 'sale' ? t('Invoices') : t('Bills'))}>{card.type === 'sale' ? t('Invoices') : t('Bills')}</button>}
                  {(card.type === 'sale' || card.type === 'purchase') && <button type="button" className="o_dropdown_item" onClick={() => openMoves(card, [['move_type', 'in', card.type === 'sale' ? ['out_refund'] : ['in_refund']]], t('Credit Notes'))}>{t('Credit Notes')}</button>}
                  {(card.type === 'bank' || card.type === 'cash') && <button type="button" className="o_dropdown_item" onClick={() => navigate(`/odoo/items?view_type=list&domain=${encodeURIComponent(JSON.stringify([['journal_id', '=', card.id]]))}`)}>{t('Transactions')}</button>}
                  <button type="button" className="o_dropdown_item" onClick={() => navigate(`/odoo/items?view_type=list&domain=${encodeURIComponent(JSON.stringify([['journal_id', '=', card.id]]))}`)}>{t('Journal Items')}</button>
                  <button type="button" className="o_dropdown_item" onClick={() => openMoves(card, [], t('Journal Entries'))}>{t('Journal Entries')}</button>
                </div>
                <div className="o_journal_menu_col">
                  <div className="o_journal_menu_title">{t('New')}</div>
                  <button type="button" className="o_dropdown_item" onClick={() => newMove(card)}>{card.type === 'sale' ? t('Invoice') : card.type === 'purchase' ? t('Bill') : t('Entry')}</button>
                  {(card.type === 'sale' || card.type === 'purchase') && <button type="button" className="o_dropdown_item" onClick={() => navigate(`/odoo/${card.type === 'sale' ? 'customer-credit-notes' : 'vendor-refunds'}/new?defaults=${encodeURIComponent(JSON.stringify({ journal_id: card.id, move_type: card.type === 'sale' ? 'out_refund' : 'in_refund' }))}`)}>{t('Credit Note')}</button>}
                  {(card.type === 'bank' || card.type === 'cash') && <button type="button" className="o_dropdown_item" onClick={() => navigate(`/odoo/customer-payments/new?defaults=${encodeURIComponent(JSON.stringify({ journal_id: card.id }))}`)}>{t('Payment')}</button>}
                </div>
                <div className="o_journal_menu_col">
                  <div className="o_journal_menu_title">{t('Reporting')}</div>
                  {card.type === 'sale' && <button type="button" className="o_dropdown_item" onClick={() => navigate('/odoo/customer-invoices-analysis')}>{t('Invoice Analysis')}</button>}
                  {card.type === 'purchase' && <button type="button" className="o_dropdown_item" onClick={() => navigate('/odoo/vendor-bills-analysis')}>{t('Bills Analysis')}</button>}
                  {(card.type === 'sale' || card.type === 'purchase') && <button type="button" className="o_dropdown_item" onClick={() => navigate(card.type === 'sale' ? '/odoo/aged-receivable' : '/odoo/aged-payable')}>{card.type === 'sale' ? t('Aged Receivable') : t('Aged Payable')}</button>}
                  {(card.type === 'bank' || card.type === 'cash') && <button type="button" className="o_dropdown_item" onClick={() => navigate('/odoo/reconciliation-report')}>{t('Bank Matching')}</button>}
                  <button type="button" className="o_dropdown_item" onClick={() => navigate('/odoo/journal-report')}>{t('Journal Audit')}</button>
                  <button type="button" className="o_dropdown_item" onClick={() => navigate('/odoo/general-ledger')}>{t('General Ledger')}</button>
                  <div className="o_journal_menu_title mt-2">{t('Configuration')}</div>
                  <button type="button" className="o_dropdown_item" onClick={() => navigate(`/odoo/action-330/${card.id}`)}>{t('Journal')}</button>
                  <div className="o_journal_colors">{Array.from({ length: 12 }, (_, i) => <span key={i} className={`o_journal_color ${card.color === i ? 'active' : ''}`} style={{ background: i ? `var(--o-color-${i})` : '#fff' }} onClick={(e) => { e.stopPropagation(); void setColor(card, i); }} />)}</div>
                </div>
              </div>
            </Dropdown>
          </div>
          <div className="o_journal_body">
            {(card.type === 'sale' || card.type === 'purchase') && (
              <>
                <div className="d-flex gap-2 mb-2">
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => newMove(card)}>{card.type === 'sale' ? t('New Invoice') : t('New Bill')}</button>
                  {card.type === 'purchase' && <span className="small text-muted align-self-center">{t('Upload a PDF or create a bill manually.')}</span>}
                </div>
                <div className="o_journal_bars">
                  {card.due.map((d) => (
                    <div key={d.label} className="o_journal_bar" title={money(d.amount, card.currency)}>
                      <div className="o_journal_bar_fill" style={{ height: `${Math.max(4, (d.amount / maxDue(card)) * 100)}%`, background: d.label === 'Due' ? 'var(--o-danger)' : 'var(--o-brand-primary)' }} />
                      <div className="o_journal_bar_label">{t(d.label)}</div>
                    </div>
                  ))}
                </div>
                <div className="o_journal_stats">
                  <button type="button" className="o_journal_stat" onClick={() => openMoves(card, [['state', '=', 'draft']], t('To Validate'))}><span>{card.draftCount} {t('to validate')}</span><span className="o_journal_amount">{money(card.draftAmount, card.currency)}</span></button>
                  <button type="button" className="o_journal_stat" onClick={() => openMoves(card, [['state', '=', 'posted'], ['payment_state', 'in', ['not_paid', 'partial']]], t('Unpaid'))}><span>{card.unpaidCount} {card.type === 'sale' ? t('unpaid invoices') : t('bills to pay')}</span><span className="o_journal_amount">{money(card.unpaidAmount, card.currency)}</span></button>
                  {card.lateCount > 0 && <button type="button" className="o_journal_stat text-danger" onClick={() => openMoves(card, [['state', '=', 'posted'], ['payment_state', 'in', ['not_paid', 'partial']], ['invoice_date_due', '<', new Date().toISOString().slice(0, 10)]], t('Late'))}><span>{card.lateCount} {t('late')}</span><span className="o_journal_amount">{money(card.lateAmount, card.currency)}</span></button>}
                  {card.toCheck > 0 && <button type="button" className="o_journal_stat text-warning" onClick={() => openMoves(card, [['review_state', '=', 'to_check']], t('To Check'))}><span>{card.toCheck} {t('to check')}</span></button>}
                </div>
              </>
            )}
            {(card.type === 'bank' || card.type === 'cash' || card.type === 'credit') && (
              <>
                <div className="d-flex gap-2 mb-2">
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => navigate(`/odoo/customer-payments/new?defaults=${encodeURIComponent(JSON.stringify({ journal_id: card.id }))}`)}>{t('New Transaction')}</button>
                  {card.draftCount > 0 && <button type="button" className="btn btn-secondary btn-sm" onClick={() => openMoves(card, [['state', '=', 'draft']], t('Draft Entries'))}>{card.draftCount} {t('to post')}</button>}
                </div>
                <div className="o_journal_balance"><span className="text-muted small">{t('Balance in GL')}</span><span className="fs-5 fw-bold">{money(card.balance, card.currency)}</span></div>
                <div className="small text-muted">{card.lastEntryDate ? `${t('Last entry')}: ${card.lastEntryDate.slice(0, 10)}` : t('No entry yet')} · {card.entriesCount} {t('entries')}</div>
              </>
            )}
            {!['sale', 'purchase', 'bank', 'cash', 'credit'].includes(card.type) && (
              <>
                <div className="d-flex gap-2 mb-2"><button type="button" className="btn btn-primary btn-sm" onClick={() => newMove(card)}>{t('New Entry')}</button></div>
                <div className="o_journal_stats">
                  <button type="button" className="o_journal_stat" onClick={() => openMoves(card, [['state', '=', 'draft']], t('Draft Entries'))}><span>{card.draftCount} {t('draft entries')}</span></button>
                  <button type="button" className="o_journal_stat" onClick={() => openMoves(card, [], t('Journal Entries'))}><span>{card.entriesCount} {t('entries')}</span>{card.lastEntryDate && <span className="text-muted">{card.lastEntryDate.slice(0, 10)}</span>}</button>
                </div>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
