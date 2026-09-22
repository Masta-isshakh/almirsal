'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { rpc } from '@/lib/client/rpc';
import { useLang, useT } from '@/lib/client/i18n';
import { useNavigation } from '@/lib/client/navigation';
import { useUi } from '../webclient/ui';
import type { SessionInfo } from '../webclient/WebClient';

interface Channel { id: number; name: string; type: string; description: string | null; memberCount: number; unread: number; lastMessageId: number; member: boolean }
interface Message { id: number; body: string; date: string; authorId: number | null; authorName: string; subject: string | null; type: string; starred: boolean; model: string | null; resId: number | null; recordName: string | null; notificationId?: number }
interface Init { partnerId: number | null; channels: Channel[]; chats: Channel[]; joinable: Channel[]; inbox: number; starred: number }
type Box = 'inbox' | 'starred' | 'history' | 'channel';

function initials(name: string): string { return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join(''); }

/** Type-ahead over the contacts that have a user (people you can chat with). */
function PartnerPicker({ placeholder, onPick }: { placeholder: string; onPick: (id: number) => void }) {
  const [results, setResults] = useState<[number, string][]>([]);
  useEffect(() => { rpc<[number, string][]>('nameSearch', 'res.partner', { name: '', domain: [['user_ids', '!=', false]], limit: 8 }, { silent: true }).then(setResults).catch(() => setResults([])); }, []);
  return (
    <div>
      <input className="form-control" autoFocus placeholder={placeholder} onChange={(e) => { rpc<[number, string][]>('nameSearch', 'res.partner', { name: e.target.value, domain: [['user_ids', '!=', false]], limit: 8 }, { silent: true }).then(setResults).catch(() => setResults([])); }} />
      <div className="list-group mt-2">{results.map(([id, name]) => <button key={id} type="button" className="list-group-item list-group-item-action" onClick={() => onPick(id)}>{name}</button>)}</div>
    </div>
  );
}
function hue(name: string): number { let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 360; }

/**
 * Discuss (C-8.1): sidebar with Inbox / Starred / History, channels and
 * direct messages (join, create, start a chat), the thread with messages
 * grouped by day, star / mark-as-read actions, a composer (Enter sends,
 * Shift+Enter breaks the line) and a light poll every 8 s for new messages.
 * URL: `/odoo/discuss?active_id=discuss.channel_<id>` or `mail.box_inbox`.
 */
export function Discuss({ context, user }: { context: Record<string, unknown>; user?: SessionInfo }) {
  const t = useT();
  const lang = useLang();
  const ui = useUi();
  const { navigate } = useNavigation();
  const [init, setInit] = useState<Init | null>(null);
  const [box, setBox] = useState<Box>('inbox');
  const [channelId, setChannelId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [members, setMembers] = useState<{ id: number; name: string; email: string | null }[]>([]);
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [showMembers, setShowMembers] = useState(false);
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const lastId = useRef(0);

  const active = typeof context.active_id === 'string' ? context.active_id : typeof context.default_active_id === 'string' ? context.default_active_id : (typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('active_id') : null);

  const refreshInit = useCallback(async () => { const data = await rpc<Init>('discussInit', null, {}, { silent: true }); setInit(data); return data; }, []);
  useEffect(() => {
    void (async () => {
      const data = await refreshInit();
      const m = /discuss\.channel_(\d+)/.exec(String(active ?? ''));
      if (m) { setBox('channel'); setChannelId(Number(m[1])); }
      else if (active === 'mail.box_starred') setBox('starred');
      else if (active === 'mail.box_history') setBox('history');
      else if (active === 'mail.box_inbox' || !data.channels.length) setBox('inbox');
      else { setBox('channel'); setChannelId(data.channels[0].id); }
    })();
  }, [active, refreshInit]);

  const loadThread = useCallback(async (after?: number) => {
    const data = await rpc<{ messages: Message[]; channel?: Channel | null; members?: { id: number; name: string; email: string | null }[] }>('discussThread', null, { box, channelId, after }, { silent: true }).catch(() => ({ messages: [] as Message[], members: undefined as { id: number; name: string; email: string | null }[] | undefined }));
    if (after) { if (data.messages.length) setMessages((list) => [...list, ...data.messages.filter((m) => !list.some((x) => x.id === m.id))]); }
    else { setMessages(data.messages); setMembers(data.members ?? []); }
    const newest = data.messages[data.messages.length - 1];
    if (newest) lastId.current = Math.max(lastId.current, newest.id);
  }, [box, channelId]);
  useEffect(() => { lastId.current = 0; void loadThread().then(() => refreshInit()); }, [loadThread, refreshInit]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [messages.length]);

  // Poll: new messages in the open channel, counters for the others.
  useEffect(() => {
    const timer = setInterval(async () => {
      const poll = await rpc<{ channels: Record<number, number>; inbox: number }>('discussPoll', null, {}, { silent: true }).catch(() => null);
      if (!poll) return;
      if (box === 'channel' && channelId && (poll.channels[channelId] ?? 0) > lastId.current) await loadThread(lastId.current);
      setInit((current) => current ? { ...current, inbox: poll.inbox, channels: current.channels.map((c) => ({ ...c, unread: c.id === channelId ? 0 : Math.max(c.unread, (poll.channels[c.id] ?? 0) > c.lastMessageId ? c.unread + 1 : c.unread), lastMessageId: poll.channels[c.id] ?? c.lastMessageId })), chats: current.chats.map((c) => ({ ...c, unread: c.id === channelId ? 0 : (poll.channels[c.id] ?? 0) > c.lastMessageId ? c.unread + 1 : c.unread, lastMessageId: poll.channels[c.id] ?? c.lastMessageId })) } : current);
    }, 8000);
    return () => clearInterval(timer);
  }, [box, channelId, loadThread]);

  const open = (nextBox: Box, id: number | null = null) => { setBox(nextBox); setChannelId(id); setShowMembers(false); const activeId = nextBox === 'channel' ? `discuss.channel_${id}` : `mail.box_${nextBox}`; window.history.replaceState(null, '', `/odoo/discuss?active_id=${activeId}`); };
  const send = async () => {
    if (!draft.trim() || !channelId || busy) return;
    setBusy(true);
    try { const message = await rpc<Message>('discussPost', null, { channelId, body: draft }); if (message) { setMessages((list) => [...list, message]); lastId.current = Math.max(lastId.current, message.id); } setDraft(''); }
    catch (error) { ui.notify({ type: 'danger', message: String((error as Error).message ?? error) }); }
    setBusy(false);
  };
  const pickPartner = (title: string, onPick: (id: number) => void) => {
    let dialogId = 0;
    dialogId = ui.openDialog({ title: { en: title, ar: title }, size: 'sm', footer: null, body: <PartnerPicker placeholder={t('Search a person…')} onPick={(id) => { ui.closeDialog(dialogId); onPick(id); }} /> });
  };
  const newChannel = () => {
    let name = ''; let dialogId = 0;
    dialogId = ui.openDialog({
      title: { en: 'New Channel', ar: 'قناة جديدة' }, size: 'sm',
      body: <input className="form-control" autoFocus placeholder={t('Channel name')} onChange={(e) => { name = e.target.value; }} onKeyDown={(e) => { if (e.key === 'Enter') (document.getElementById(`o_discuss_create_${dialogId}`) as HTMLButtonElement)?.click(); }} />,
      footer: <button id={`o_discuss_create_${dialogId}`} type="button" className="btn btn-primary" onClick={async () => { if (!name.trim()) return; ui.closeDialog(dialogId); const id = await rpc<number>('discussCreateChannel', null, { name, type: 'channel' }); await refreshInit(); open('channel', id); }}>{t('Create')}</button>,
    });
  };
  const startChat = () => pickPartner(t('New Message'), async (partnerId) => { const id = await rpc<number>('discussChat', null, { partnerId }); await refreshInit(); open('channel', id); });
  const addPeople = () => pickPartner(t('Add People'), async (partnerId) => {
    if (!channelId) return;
    await rpc('discussAddMember', null, { channelId, partnerId });
    await loadThread();
    ui.notify({ type: 'success', message: { en: 'Member added.', ar: 'تمت إضافة العضو.' } });
  });
  const star = async (m: Message) => { const starred = await rpc<boolean>('discussStar', null, { messageId: m.id }); setMessages((list) => list.map((x) => (x.id === m.id ? { ...x, starred } : x))); void refreshInit(); };
  const markRead = async (ids?: number[]) => { await rpc('discussMarkRead', null, { notificationIds: ids }); await loadThread(); await refreshInit(); };
  const current = box === 'channel' ? [...(init?.channels ?? []), ...(init?.chats ?? []), ...(init?.joinable ?? [])].find((c) => c.id === channelId) ?? null : null;
  const filtered = (list: Channel[]) => list.filter((c) => !search || c.name.toLowerCase().includes(search.toLowerCase()));
  const dayOf = (date: string) => date.slice(0, 10);
  const dayLabel = (day: string) => { const today = new Date().toISOString().slice(0, 10); const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10); return day === today ? t('Today') : day === yesterday ? t('Yesterday') : new Date(`${day}T00:00:00Z`).toLocaleDateString(lang === 'ar_001' ? 'ar-EG-u-nu-latn' : 'en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); };
  const grouped = useMemo(() => { const out: { day: string; items: Message[] }[] = []; for (const m of messages) { const day = dayOf(m.date); const last = out[out.length - 1]; if (last && last.day === day) last.items.push(m); else out.push({ day, items: [m] }); } return out; }, [messages]);
  const title = box === 'inbox' ? t('Inbox') : box === 'starred' ? t('Starred') : box === 'history' ? t('History') : current?.name ?? '';

  return (
    <div className="o_discuss">
      <aside className="o_discuss_sidebar">
        <div className="o_discuss_sidebar_top">
          <button type="button" className="btn btn-primary btn-sm" onClick={startChat}><i className="fa fa-video-camera me-1" />{t('Meeting')}</button>
          <input className="form-control form-control-sm o_discuss_search" placeholder={t('Search')} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="o_discuss_section">
          <div className="o_discuss_section_title">{t('Mailboxes')}</div>
          {(['inbox', 'starred', 'history'] as Box[]).map((b) => (
            <button key={b} type="button" className={`o_discuss_item ${box === b ? 'active' : ''}`} onClick={() => open(b)}>
              <i className={`fa ${b === 'inbox' ? 'fa-inbox' : b === 'starred' ? 'fa-star-o' : 'fa-history'} me-2`} />{t(b === 'inbox' ? 'Inbox' : b === 'starred' ? 'Starred' : 'History')}
              {b === 'inbox' && (init?.inbox ?? 0) > 0 && <span className="o_discuss_badge">{init?.inbox}</span>}
              {b === 'starred' && (init?.starred ?? 0) > 0 && <span className="o_discuss_badge o_discuss_badge_muted">{init?.starred}</span>}
            </button>
          ))}
        </div>
        <div className="o_discuss_section">
          <div className="o_discuss_section_title"><span># {t('Channels')}</span><button type="button" className="o_discuss_plus" title={t('Add channel')} onClick={newChannel}><i className="fa fa-plus" /></button></div>
          {filtered(init?.channels ?? []).map((c) => (
            <button key={c.id} type="button" className={`o_discuss_item ${box === 'channel' && channelId === c.id ? 'active' : ''} ${c.unread ? 'fw-bold' : ''}`} onClick={() => open('channel', c.id)}>
              <span className="o_discuss_hash">#</span>{c.name}{c.unread > 0 && <span className="o_discuss_badge">{c.unread}</span>}
            </button>
          ))}
          {filtered(init?.joinable ?? []).map((c) => (
            <button key={c.id} type="button" className="o_discuss_item text-muted" onClick={async () => { await rpc('discussJoin', null, { channelId: c.id }); await refreshInit(); open('channel', c.id); }} title={t('Join')}>
              <span className="o_discuss_hash">#</span>{c.name}<i className="fa fa-sign-in ms-auto small" />
            </button>
          ))}
        </div>
        <div className="o_discuss_section">
          <div className="o_discuss_section_title"><span><i className="fa fa-users me-1" />{t('Direct Messages')}</span><button type="button" className="o_discuss_plus" title={t('Start a conversation')} onClick={startChat}><i className="fa fa-plus" /></button></div>
          {filtered(init?.chats ?? []).map((c) => (
            <button key={c.id} type="button" className={`o_discuss_item ${box === 'channel' && channelId === c.id ? 'active' : ''} ${c.unread ? 'fw-bold' : ''}`} onClick={() => open('channel', c.id)}>
              <span className="o_discuss_avatar_sm" style={{ background: `hsl(${hue(c.name)}, 68%, 52%)` }}>{initials(c.name)}</span>{c.name}{c.unread > 0 && <span className="o_discuss_badge">{c.unread}</span>}
            </button>
          ))}
        </div>
      </aside>
      <section className="o_discuss_thread">
        <header className="o_discuss_header">
          <div className="d-flex align-items-center gap-2 flex-grow-1 min-w-0">
            {box === 'channel' && current && <span className="o_discuss_avatar" style={{ background: current.type === 'chat' ? `hsl(${hue(current.name)}, 68%, 52%)` : 'var(--o-brand-primary)' }}>{current.type === 'chat' ? initials(current.name) : '#'}</span>}
            <div className="min-w-0">
              <div className="fw-bold text-truncate">{title}</div>
              {current?.description && <div className="small text-muted text-truncate">{current.description}</div>}
            </div>
          </div>
          <div className="d-flex align-items-center gap-1">
            {box === 'inbox' && messages.length > 0 && <button type="button" className="btn btn-secondary btn-sm" onClick={() => markRead()}>{t('Mark all as read')}</button>}
            {box === 'starred' && messages.length > 0 && <button type="button" className="btn btn-secondary btn-sm" onClick={async () => { await rpc('discussUnstarAll', null, {}); await loadThread(); await refreshInit(); }}>{t('Unstar all')}</button>}
            {box === 'channel' && current && <button type="button" className={`btn btn-sm ${showMembers ? 'btn-primary' : 'btn-secondary'}`} title={t('Members')} onClick={() => setShowMembers((s) => !s)}><i className="fa fa-users" /> {members.length}</button>}
            {box === 'channel' && current && current.type !== 'chat' && <button type="button" className="btn btn-secondary btn-sm" title={t('Add People')} onClick={addPeople}><i className="fa fa-user-plus" /></button>}
            {box === 'channel' && current && current.type !== 'chat' && <button type="button" className="btn btn-secondary btn-sm" title={t('Leave Channel')} onClick={async () => { await rpc('discussLeave', null, { channelId }); await refreshInit(); open('inbox'); }}><i className="fa fa-sign-out" /></button>}
          </div>
        </header>
        <div className="o_discuss_body">
          <div className="o_discuss_messages">
            {messages.length === 0 && (
              <div className="o_discuss_empty">
                <i className={`fa ${box === 'inbox' ? 'fa-check-circle' : box === 'starred' ? 'fa-star-o' : box === 'history' ? 'fa-history' : 'fa-comments-o'} fa-3x mb-3 opacity-25`} />
                <div className="fw-bold">{box === 'inbox' ? t('Congratulations, your inbox is empty') : box === 'starred' ? t('No starred messages') : box === 'history' ? t('No history messages') : current ? `${t('Welcome to')} ${current.type === 'chat' ? current.name : `#${current.name}`}!` : t('Select a conversation')}</div>
                <div className="text-muted small">{box === 'inbox' ? t('New messages appear here.') : box === 'channel' && current ? (current.type === 'chat' ? t('This is the start of your direct chat.') : `${t('This is the start of the')} #${current.name} ${t('channel')}`) : ''}</div>
              </div>
            )}
            {grouped.map((group) => (
              <div key={group.day}>
                <div className="o_discuss_day"><span>{dayLabel(group.day)}</span></div>
                {group.items.map((m, index) => {
                  const prev = group.items[index - 1];
                  const sameAuthor = prev && prev.authorId === m.authorId && Date.parse(m.date.replace(' ', 'T')) - Date.parse(prev.date.replace(' ', 'T')) < 60_000;
                  const mine = init?.partnerId != null && m.authorId === init.partnerId;
                  if (m.type === 'notification' && box === 'channel') return <div key={m.id} className="o_discuss_system" dangerouslySetInnerHTML={{ __html: m.body }} />;
                  return (
                    <div key={m.id} className={`o_discuss_message ${sameAuthor ? 'o_discuss_message_squashed' : ''} ${mine ? 'o_discuss_message_mine' : ''}`}>
                      {!sameAuthor ? <span className="o_discuss_avatar" style={{ background: `hsl(${hue(m.authorName)}, 68%, 52%)` }}>{initials(m.authorName) || '?'}</span> : <span className="o_discuss_avatar_spacer" />}
                      <div className="o_discuss_message_body">
                        {!sameAuthor && <div className="o_discuss_message_head"><span className="fw-bold">{m.authorName}</span><span className="text-muted small ms-2" title={m.date}>{m.date.slice(11, 16)}</span>{m.model && m.model !== 'discuss.channel' && <button type="button" className="btn btn-link btn-sm p-0 ms-2" onClick={() => navigate(`/odoo/m/${m.model}/${m.resId}`)}>{m.recordName || m.model}</button>}</div>}
                        {m.subject && <div className="small fw-bold">{m.subject}</div>}
                        <div className="o_discuss_bubble" dangerouslySetInnerHTML={{ __html: m.body }} />
                      </div>
                      <div className="o_discuss_message_actions">
                        <button type="button" className={`btn btn-link btn-sm p-0 ${m.starred ? 'text-warning' : 'text-muted'}`} title={t('Mark as Todo')} onClick={() => star(m)}><i className={`fa ${m.starred ? 'fa-star' : 'fa-star-o'}`} /></button>
                        {box === 'inbox' && m.notificationId && <button type="button" className="btn btn-link btn-sm p-0 text-muted ms-1" title={t('Mark as Read')} onClick={() => markRead([m.notificationId!])}><i className="fa fa-check" /></button>}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
            <div ref={bottom} />
          </div>
          {showMembers && box === 'channel' && (
            <aside className="o_discuss_members">
              <div className="fw-bold small text-uppercase text-muted mb-2">{t('Members')} · {members.length}</div>
              {members.map((p) => <div key={p.id} className="d-flex align-items-center gap-2 py-1"><span className="o_discuss_avatar_sm" style={{ background: `hsl(${hue(p.name)}, 68%, 52%)` }}>{initials(p.name)}</span><span className="text-truncate">{p.name}{p.id === init?.partnerId ? ` (${t('You')})` : ''}</span></div>)}
            </aside>
          )}
        </div>
        {box === 'channel' && current && (
          <div className="o_discuss_composer">
            <span className="o_discuss_avatar_sm" style={{ background: `hsl(${hue(user?.name ?? 'me')}, 68%, 52%)` }}>{initials(user?.name ?? '')}</span>
            <textarea className="form-control" rows={1} placeholder={`${t('Message')} ${current.type === 'chat' ? current.name : `#${current.name}`}…`} value={draft} onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
            <button type="button" className="btn btn-primary" disabled={!draft.trim() || busy} onClick={send} title={t('Send')}><i className="fa fa-paper-plane" /></button>
          </div>
        )}
      </section>
    </div>
  );
}
