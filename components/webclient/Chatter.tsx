'use client';

import { useCallback, useEffect, useState } from 'react';
import { PyDate } from '@engine/expr/pydate';
import { formatDateTime, formatRelativeDate } from '@engine/format/index';
import { rpc } from '@/lib/client/rpc';
import { useLang, useT } from '@/lib/client/i18n';
import { avatarColor } from './Navbar';
import type { SessionInfo } from './WebClient';

type Rec = Record<string, unknown>;

interface Tracking { field_name: string; old_value_char: string | null; new_value_char: string | null; old_value_float: number | null; new_value_float: number | null; old_value_integer: number | null; new_value_integer: number | null; mail_message_id: number }

/**
 * A-4 §17 (first slice): "Send message" / "Log note" composer, the message
 * feed with authors, relative dates, note background and tracking values
 * ("Status: Quotation → Sales Order").
 */
export function Chatter({ model, recordId, user }: { model: string; recordId: number; user: SessionInfo }) {
  const t = useT();
  const lang = useLang();
  const [messages, setMessages] = useState<Rec[]>([]);
  const [tracking, setTracking] = useState<Record<number, Tracking[]>>({});
  const [mode, setMode] = useState<'message' | 'note' | null>(null);
  const [body, setBody] = useState('');

  const load = useCallback(async () => {
    const rows = await rpc<Rec[]>('searchRead', 'mail.message', {
      domain: [['model', '=', model], ['res_id', '=', recordId]],
      fields: ['body', 'author_id', 'date', 'message_type', 'is_internal', 'subject'],
      order: 'date desc, id desc', limit: 50,
    }, { silent: true });
    setMessages(rows);
    const ids = rows.map((row) => row.id as number);
    if (ids.length) {
      const values = await rpc<Tracking[]>('searchRead', 'mail.tracking.value', {
        domain: [['mail_message_id', 'in', ids]],
        fields: ['field_name', 'old_value_char', 'new_value_char', 'old_value_float', 'new_value_float', 'old_value_integer', 'new_value_integer', 'mail_message_id'],
      }, { silent: true });
      const map: Record<number, Tracking[]> = {};
      for (const value of values) {
        const id = Array.isArray(value.mail_message_id) ? (value.mail_message_id as unknown as [number, string])[0] : value.mail_message_id;
        (map[id] ??= []).push(value);
      }
      setTracking(map);
    }
  }, [model, recordId]);

  useEffect(() => { load().catch(() => undefined); }, [load]);

  const send = async () => {
    if (!body.trim()) return;
    await rpc('messagePost', model, { id: recordId, body: `<p>${body.replace(/\n/g, '<br/>')}</p>`, isNote: mode === 'note' });
    setBody('');
    setMode(null);
    await load();
  };

  const today = PyDate.parse(new Date().toISOString().slice(0, 10))!;

  return (
    <div className="o_chatter">
      <div className="o_chatter_topbar">
        <button type="button" className={`btn ${mode === 'message' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode(mode === 'message' ? null : 'message')}>{t('Send message')}</button>
        <button type="button" className={`btn ${mode === 'note' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode(mode === 'note' ? null : 'note')}>{t('Log note')}</button>
        <button type="button" className="btn btn-secondary" title={t('Activities')}><i className="fa fa-clock-o me-1" />{t('Activities')}</button>
        <span className="ms-auto text-muted small"><i className="fa fa-user-o me-1" />0</span>
      </div>
      {mode && (
        <div className="o_chatter_composer">
          <textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder={mode === 'note' ? t('Log an internal note...') : t('Send a message to followers...')} autoFocus />
          <div className="d-flex gap-2 mt-2">
            <button type="button" className="btn btn-primary btn-sm" onClick={send}>{mode === 'note' ? t('Log') : t('Send')}</button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMode(null)}>{t('Discard')}</button>
          </div>
        </div>
      )}
      <div className="o_thread">
        {messages.map((message) => {
          const author = Array.isArray(message.author_id) ? String((message.author_id as [number, string])[1]) : user.name;
          const values = tracking[message.id as number] ?? [];
          const isNote = Boolean(message.is_internal) && message.message_type === 'comment';
          return (
            <div key={message.id as number} className={`o_message ${isNote ? 'o_message_note' : ''}`}>
              <span className="o_avatar" style={{ background: avatarColor(author) }}>{author.slice(0, 1).toUpperCase()}</span>
              <div className="flex-grow-1">
                <div className="o_message_header">
                  <span className="o_message_author">{author}</span>
                  <span className="o_message_date" title={formatDateTime(String(message.date), lang)}>{formatRelativeDate(String(message.date), today, lang)}</span>
                </div>
                {typeof message.body === 'string' && message.body !== '' && <div className="o_message_body" dangerouslySetInnerHTML={{ __html: message.body }} />}
                {values.map((value, index) => (
                  <div key={index} className="o_message_tracking">
                    {value.field_name}: {String(value.old_value_char ?? value.old_value_float ?? value.old_value_integer ?? '')}
                    <span className="o_tracking_arrow">→</span>{String(value.new_value_char ?? value.new_value_float ?? value.new_value_integer ?? '')}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
