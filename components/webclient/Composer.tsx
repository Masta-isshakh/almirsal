'use client';

import { useEffect, useState } from 'react';
import { rpc } from '@/lib/client/rpc';
import { useT } from '@/lib/client/i18n';
import { useUi } from './ui';

interface Recipient { id: number; name: string; email: string }
interface Defaults { subject: string; body: string; partnerIds: number[]; reportName: string | null; recipients: Recipient[]; configured: boolean }

/**
 * "Send by email" (Part G composer): recipients with their addresses,
 * subject, message, the printable document inline, Send / Discard. The
 * server logs the email in the chatter and marks the document as sent.
 */
export function Composer({ model, resId, onDone }: { model: string; resId: number; onDone: (sent: boolean) => void }) {
  const t = useT();
  const ui = useUi();
  const [defaults, setDefaults] = useState<Defaults | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [attach, setAttach] = useState(true);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<Recipient[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    rpc<Defaults>('composerDefaults', model, { id: resId }).then((loaded) => {
      setDefaults(loaded);
      setSubject(loaded.subject);
      setBody(loaded.body.replace(/<\/p>\s*<p>/g, '\n\n').replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, ''));
      setRecipients(loaded.recipients);
    }).catch(() => onDone(false));
  }, [model, resId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (query.trim().length < 2) { setOptions([]); return; }
    const handle = setTimeout(async () => {
      const rows = await rpc<{ id: number; name: string; email: string | false }[]>('searchRead', 'res.partner', { domain: ['|', ['name', 'ilike', query], ['email', 'ilike', query]], fields: ['name', 'email'], limit: 8 }, { silent: true }).catch(() => []);
      setOptions(rows.map((row) => ({ id: row.id, name: row.name, email: row.email || '' })).filter((row) => !recipients.some((r) => r.id === row.id)));
    }, 200);
    return () => clearTimeout(handle);
  }, [query, recipients]);

  const send = async () => {
    if (!defaults) return;
    if (recipients.length === 0) { ui.notify({ type: 'warning', message: { en: 'Add at least one recipient.', ar: 'أضف مستلماً واحداً على الأقل.' } }); return; }
    setBusy(true);
    try {
      const html = body.split(/\n{2,}/).map((paragraph) => `<p>${paragraph.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br/>')}</p>`).join('');
      const result = await rpc<{ sent: boolean; recipients: string[] }>('sendDocument', model, { id: resId, partnerIds: recipients.map((r) => r.id), subject, body: html, reportName: attach ? defaults.reportName : null });
      ui.notify(result.sent
        ? { type: 'success', message: { en: `Email sent to ${result.recipients.join(', ')}.`, ar: `تم إرسال البريد إلى ${result.recipients.join('، ')}.` } }
        : { type: 'warning', sticky: true, message: { en: 'Logged in the chatter, but not emailed: set RODEO_MAIL_FROM (a verified SES sender) on the deployment to send mail.', ar: 'تم التسجيل في المحادثة دون إرسال بريد: اضبط RODEO_MAIL_FROM (مرسل SES موثق) على النشر لإرسال البريد.' } });
      onDone(true);
    } catch { setBusy(false); }
  };

  if (!defaults) return <div className="o_loading_indicator" />;
  return (
    <div className="o_composer">
      {!defaults.configured && <div className="alert alert-info py-2 small">{t('No outgoing mail server is configured: the message will be logged in the chatter only.')}</div>}
      <div className="mb-3">
        <label className="o_form_label">{t('To')}</label>
        <div className="d-flex flex-wrap align-items-center gap-1 border-bottom pb-1" style={{ position: 'relative' }}>
          {recipients.map((recipient) => (
            <span key={recipient.id} className={`badge rounded-pill ${recipient.email ? 'text-bg-secondary' : 'text-bg-danger'}`} title={recipient.email || t('No email address')}>
              {recipient.name}{recipient.email ? ` <${recipient.email}>` : ''}
              <button type="button" className="btn-close btn-close-white ms-1" style={{ fontSize: 8 }} aria-label="Remove" onClick={() => setRecipients((list) => list.filter((r) => r.id !== recipient.id))} />
            </span>
          ))}
          <input className="o_input" style={{ flex: '1 1 160px' }} placeholder={t('Add a contact...')} value={query} onChange={(event) => setQuery(event.target.value)} />
          {options.length > 0 && (
            <div className="o_m2o_dropdown" style={{ top: '100%' }}>
              {options.map((option) => <div key={option.id} className="o_m2o_dropdown_item" onMouseDown={() => { setRecipients((list) => [...list, option]); setQuery(''); setOptions([]); }}>{option.name} <span className="text-muted">{option.email || t('(no email)')}</span></div>)}
            </div>
          )}
        </div>
      </div>
      <div className="mb-3">
        <label className="o_form_label">{t('Subject')}</label>
        <input className="o_input w-100" value={subject} onChange={(event) => setSubject(event.target.value)} />
      </div>
      <div className="mb-3">
        <textarea className="form-control" rows={8} value={body} onChange={(event) => setBody(event.target.value)} />
      </div>
      {defaults.reportName && (
        <label className="d-flex align-items-center gap-2 mb-3">
          <input type="checkbox" className="form-check-input m-0" checked={attach} onChange={(event) => setAttach(event.target.checked)} />
          <span><i className="fa fa-file-text-o me-1 text-muted" />{t('Include the document in the email')}</span>
        </label>
      )}
      <div className="o_dialog_footer px-0 pb-0">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={send}><i className="fa fa-paper-plane me-1" />{busy ? t('Sending...') : t('Send')}</button>
        <button type="button" className="btn btn-secondary" onClick={() => onDone(false)}>{t('Discard')}</button>
      </div>
    </div>
  );
}
