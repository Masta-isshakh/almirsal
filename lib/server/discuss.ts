import type { Environment } from '@engine/orm/env';
import { UserError } from '@engine/orm/errors';
import { partnerOfUser, postMessage } from '@engine/orm/mail';
import { setParameter } from '@engine/schema/ddl';

/**
 * Discuss (C-8.1) data: channels and direct messages of the user with
 * unread counters, the inbox (notifications addressed to the user), starred
 * messages, thread messages, posting, joining/leaving and starting chats.
 * Read positions are kept per user in `ir.config_parameter`
 * (`rodeo.discuss.seen.<uid>` → { channelId: lastMessageId }).
 */

type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

export interface ChannelInfo { id: number; name: string; type: string; description: string | null; memberCount: number; unread: number; lastMessageId: number; member: boolean; partnerName?: string | null }
export interface MessageInfo { id: number; body: string; date: string; authorId: number | null; authorName: string; subject: string | null; type: string; starred: boolean; model: string | null; resId: number | null; recordName: string | null; notificationId?: number }

async function seen(env: Environment): Promise<Record<string, number>> {
  const row = await env.cr.query<{ value: string }>(`SELECT value FROM ir_config_parameter WHERE key = $1`, [`rodeo.discuss.seen.${env.uid}`]);
  try { return row.rows[0] ? JSON.parse(row.rows[0].value) : {}; } catch { return {}; }
}

export async function discussInit(env: Environment): Promise<{ partnerId: number | null; channels: ChannelInfo[]; chats: ChannelInfo[]; joinable: ChannelInfo[]; inbox: number; starred: number }> {
  const partnerId = await partnerOfUser(env, env.uid);
  const seenMap = await seen(env);
  const rows = await env.cr.query<Row>(
    `SELECT c.id, c.name, c.channel_type, c.description, (SELECT count(*) FROM discuss_channel_member m WHERE m.discuss_channel_id = c.id)::int AS members,
            EXISTS (SELECT 1 FROM discuss_channel_member m WHERE m.discuss_channel_id = c.id AND m.partner_id = $1) AS member,
            coalesce((SELECT max(id) FROM mail_message mm WHERE mm.model = 'discuss.channel' AND mm.res_id = c.id), 0)::int AS last_id,
            (SELECT string_agg(p.name, ', ') FROM discuss_channel_member m JOIN res_partner p ON p.id = m.partner_id WHERE m.discuss_channel_id = c.id AND m.partner_id <> $1) AS others
     FROM discuss_channel c WHERE coalesce(c.active, true) ORDER BY c.channel_type, c.name`, [partnerId],
  );
  const toInfo = (r: Row): ChannelInfo => {
    const lastId = num(r.last_id);
    const seenId = num(seenMap[String(r.id)]);
    return { id: num(r.id), name: String(r.name ?? ''), type: String(r.channel_type ?? 'channel'), description: (r.description as string) ?? null, memberCount: num(r.members), member: Boolean(r.member), lastMessageId: lastId, unread: 0, partnerName: (r.others as string) ?? null, ...(lastId > seenId ? { unread: 0 } : {}) };
  };
  const infos = rows.rows.map(toInfo);
  // Unread = messages after the seen position, not authored by me.
  for (const info of infos) {
    if (!info.member) continue;
    const count = await env.cr.query<{ n: number }>(`SELECT count(*)::int AS n FROM mail_message WHERE model = 'discuss.channel' AND res_id = $1 AND id > $2 AND (author_id IS NULL OR author_id <> $3) AND message_type <> 'notification'`, [info.id, num(seenMap[String(info.id)]), partnerId]);
    info.unread = num(count.rows[0]?.n);
  }
  const inbox = await env.cr.query<{ n: number }>(`SELECT count(*)::int AS n FROM mail_notification WHERE res_partner_id = $1 AND coalesce(is_read, false) = false`, [partnerId]).catch(() => ({ rows: [{ n: 0 }] }));
  const starred = await env.cr.query<{ n: number }>(`SELECT count(*)::int AS n FROM mail_message_starred_partner_ids_rel WHERE res_partner_id = $1`, [partnerId]).catch(() => ({ rows: [{ n: 0 }] }));
  return {
    partnerId,
    channels: infos.filter((c) => c.member && c.type !== 'chat'),
    chats: infos.filter((c) => c.member && c.type === 'chat').map((c) => ({ ...c, name: c.partnerName || c.name })),
    joinable: infos.filter((c) => !c.member && c.type === 'channel'),
    inbox: num(inbox.rows[0]?.n), starred: num(starred.rows[0]?.n),
  };
}

async function messageRows(env: Environment, where: string, params: unknown[], partnerId: number | null, limit = 60): Promise<MessageInfo[]> {
  const rows = await env.cr.query<Row>(
    `SELECT m.id, m.body, to_char(m.date, 'YYYY-MM-DD HH24:MI:SS') AS date, m.author_id, coalesce(p.name, m.email_from, 'System') AS author_name, m.subject, m.message_type, m.model, m.res_id, m.record_name,
            EXISTS (SELECT 1 FROM mail_message_starred_partner_ids_rel s WHERE s.mail_message_id = m.id AND s.res_partner_id = $${params.length + 1}) AS starred
     FROM mail_message m LEFT JOIN res_partner p ON p.id = m.author_id WHERE ${where} ORDER BY m.id DESC LIMIT ${Math.max(1, Math.min(200, limit))}`, [...params, partnerId],
  );
  return rows.rows.reverse().map((r) => ({ id: num(r.id), body: String(r.body ?? ''), date: String(r.date ?? ''), authorId: r.author_id === null ? null : num(r.author_id), authorName: String(r.author_name ?? ''), subject: (r.subject as string) ?? null, type: String(r.message_type ?? 'comment'), starred: Boolean(r.starred), model: (r.model as string) ?? null, resId: r.res_id === null ? null : num(r.res_id), recordName: (r.record_name as string) ?? null }));
}

export async function discussThread(env: Environment, box: string, channelId?: number, after?: number): Promise<{ messages: MessageInfo[]; channel?: ChannelInfo | null; members?: { id: number; name: string; email: string | null }[] }> {
  const partnerId = await partnerOfUser(env, env.uid);
  if (box === 'inbox') {
    const rows = await env.cr.query<{ id: number; nid: number }>(`SELECT n.mail_message_id AS id, n.id AS nid FROM mail_notification n WHERE n.res_partner_id = $1 AND coalesce(n.is_read, false) = false ORDER BY n.id DESC LIMIT 100`, [partnerId]).catch(() => ({ rows: [] as { id: number; nid: number }[] }));
    const ids = rows.rows.map((r) => num(r.id));
    const messages = ids.length ? await messageRows(env, `m.id = ANY($1)`, [ids], partnerId, 100) : [];
    return { messages: messages.map((m) => ({ ...m, notificationId: rows.rows.find((r) => num(r.id) === m.id)?.nid })) };
  }
  if (box === 'starred') return { messages: await messageRows(env, `m.id IN (SELECT mail_message_id FROM mail_message_starred_partner_ids_rel WHERE res_partner_id = $1)`, [partnerId], partnerId, 100) };
  if (box === 'history') return { messages: await messageRows(env, `m.id IN (SELECT n.mail_message_id FROM mail_notification n WHERE n.res_partner_id = $1 AND coalesce(n.is_read, false) = true)`, [partnerId], partnerId, 100) };
  if (!channelId) return { messages: [] };
  const params: unknown[] = [channelId];
  let where = `m.model = 'discuss.channel' AND m.res_id = $1`;
  if (after) { params.push(after); where += ` AND m.id > $2`; }
  const messages = await messageRows(env, where, params, partnerId, after ? 200 : 60);
  // Opening a channel marks it read up to its last message.
  if (!after) {
    const last = await env.cr.query<{ id: number | null }>(`SELECT max(id) AS id FROM mail_message WHERE model = 'discuss.channel' AND res_id = $1`, [channelId]);
    const map = await seen(env);
    map[String(channelId)] = num(last.rows[0]?.id);
    await setParameter(env.cr, `rodeo.discuss.seen.${env.uid}`, JSON.stringify(map));
  }
  const channelRow = (await discussInit(env)).channels.concat((await discussInit(env)).chats, (await discussInit(env)).joinable).find((c) => c.id === channelId) ?? null;
  const members = await env.cr.query<{ id: number; name: string; email: string | null }>(`SELECT p.id, p.name, p.email FROM discuss_channel_member m JOIN res_partner p ON p.id = m.partner_id WHERE m.discuss_channel_id = $1 ORDER BY p.name`, [channelId]);
  return { messages, channel: channelRow, members: members.rows };
}

export async function discussPost(env: Environment, channelId: number, body: string): Promise<MessageInfo | null> {
  const text = String(body ?? '').trim();
  if (!text) throw new UserError({ en: 'The message is empty.', ar: 'الرسالة فارغة.' });
  const partnerId = await partnerOfUser(env, env.uid);
  const member = await env.cr.query<{ n: number }>(`SELECT count(*)::int AS n FROM discuss_channel_member WHERE discuss_channel_id = $1 AND partner_id = $2`, [channelId, partnerId]);
  if (!member.rows[0]?.n) await discussJoin(env, channelId);
  const html = text.startsWith('<') ? text : `<p>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br/>')}</p>`;
  const id = await postMessage(env, 'discuss.channel', channelId, { body: html, messageType: 'comment' });
  await env.cr.query(`UPDATE discuss_channel SET last_interest_dt = now() WHERE id = $1`, [channelId]).catch(() => undefined);
  const map = await seen(env); map[String(channelId)] = id; await setParameter(env.cr, `rodeo.discuss.seen.${env.uid}`, JSON.stringify(map));
  const [message] = await messageRows(env, `m.id = $1`, [id], partnerId, 1);
  return message ?? null;
}

export async function discussJoin(env: Environment, channelId: number): Promise<void> {
  const partnerId = await partnerOfUser(env, env.uid);
  if (!partnerId) return;
  const exists = await env.cr.query<{ n: number }>(`SELECT count(*)::int AS n FROM discuss_channel_member WHERE discuss_channel_id = $1 AND partner_id = $2`, [channelId, partnerId]);
  if (!exists.rows[0]?.n) await env.sudo().model('discuss.channel.member').create({ discuss_channel_id: channelId, partner_id: partnerId });
  await env.cr.query(`UPDATE discuss_channel SET member_count = (SELECT count(*) FROM discuss_channel_member WHERE discuss_channel_id = $1) WHERE id = $1`, [channelId]).catch(() => undefined);
}

export async function discussLeave(env: Environment, channelId: number): Promise<void> {
  const partnerId = await partnerOfUser(env, env.uid);
  await env.cr.query(`DELETE FROM discuss_channel_member WHERE discuss_channel_id = $1 AND partner_id = $2`, [channelId, partnerId]);
  await env.cr.query(`UPDATE discuss_channel SET member_count = (SELECT count(*) FROM discuss_channel_member WHERE discuss_channel_id = $1) WHERE id = $1`, [channelId]).catch(() => undefined);
}

export async function discussCreateChannel(env: Environment, name: string, type: 'channel' | 'group', partnerIds: number[] = []): Promise<number> {
  const partnerId = await partnerOfUser(env, env.uid);
  const id = await env.sudo().model('discuss.channel').create({ name: name.trim() || 'New channel', channel_type: type, active: true });
  for (const pid of [...new Set([partnerId, ...partnerIds])]) if (pid) await env.sudo().model('discuss.channel.member').create({ discuss_channel_id: id, partner_id: pid });
  await env.cr.query(`UPDATE discuss_channel SET member_count = (SELECT count(*) FROM discuss_channel_member WHERE discuss_channel_id = $1) WHERE id = $1`, [id]).catch(() => undefined);
  await postMessage(env, 'discuss.channel', id, { body: `<p>${env.lang === 'ar_001' ? 'تم إنشاء القناة' : 'Channel created'}</p>`, messageType: 'notification' }).catch(() => undefined);
  return id;
}

/** A direct message thread with a partner (reused when it already exists). */
export async function discussChat(env: Environment, partnerId: number): Promise<number> {
  const me = await partnerOfUser(env, env.uid);
  if (!me) throw new UserError({ en: 'Your user has no contact record.', ar: 'ليس لمستخدمك سجل جهة اتصال.' });
  const existing = await env.cr.query<{ id: number }>(
    `SELECT c.id FROM discuss_channel c WHERE c.channel_type = 'chat'
       AND EXISTS (SELECT 1 FROM discuss_channel_member m WHERE m.discuss_channel_id = c.id AND m.partner_id = $1)
       AND EXISTS (SELECT 1 FROM discuss_channel_member m WHERE m.discuss_channel_id = c.id AND m.partner_id = $2)
       AND (SELECT count(*) FROM discuss_channel_member m WHERE m.discuss_channel_id = c.id) = ${partnerId === me ? 1 : 2} LIMIT 1`, [me, partnerId],
  );
  if (existing.rows[0]) return num(existing.rows[0].id);
  const names = await env.cr.query<{ name: string }>(`SELECT name FROM res_partner WHERE id = ANY($1) ORDER BY name`, [[me, partnerId]]);
  const id = await env.sudo().model('discuss.channel').create({ name: names.rows.map((r) => r.name).join(', '), channel_type: 'chat', active: true });
  for (const pid of new Set([me, partnerId])) await env.sudo().model('discuss.channel.member').create({ discuss_channel_id: id, partner_id: pid });
  await env.cr.query(`UPDATE discuss_channel SET member_count = (SELECT count(*) FROM discuss_channel_member WHERE discuss_channel_id = $1) WHERE id = $1`, [id]).catch(() => undefined);
  return id;
}

export async function discussStar(env: Environment, messageId: number): Promise<boolean> {
  const partnerId = await partnerOfUser(env, env.uid);
  const exists = await env.cr.query<{ n: number }>(`SELECT count(*)::int AS n FROM mail_message_starred_partner_ids_rel WHERE mail_message_id = $1 AND res_partner_id = $2`, [messageId, partnerId]);
  if (exists.rows[0]?.n) { await env.cr.query(`DELETE FROM mail_message_starred_partner_ids_rel WHERE mail_message_id = $1 AND res_partner_id = $2`, [messageId, partnerId]); return false; }
  await env.cr.query(`INSERT INTO mail_message_starred_partner_ids_rel (mail_message_id, res_partner_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [messageId, partnerId]);
  return true;
}

export async function discussMarkRead(env: Environment, notificationIds?: number[]): Promise<void> {
  const partnerId = await partnerOfUser(env, env.uid);
  if (notificationIds?.length) await env.cr.query(`UPDATE mail_notification SET is_read = true, read_date = now() WHERE id = ANY($1) AND res_partner_id = $2`, [notificationIds, partnerId]);
  else await env.cr.query(`UPDATE mail_notification SET is_read = true, read_date = now() WHERE res_partner_id = $1 AND coalesce(is_read, false) = false`, [partnerId]);
}

export async function discussUnstarAll(env: Environment): Promise<void> {
  const partnerId = await partnerOfUser(env, env.uid);
  await env.cr.query(`DELETE FROM mail_message_starred_partner_ids_rel WHERE res_partner_id = $1`, [partnerId]);
}

/** Cheap poll: the newest message id of every channel the user is in, plus the inbox count. */
export async function discussPoll(env: Environment): Promise<{ channels: Record<number, number>; inbox: number }> {
  const partnerId = await partnerOfUser(env, env.uid);
  const rows = await env.cr.query<{ id: number; last: number }>(`SELECT c.id, coalesce((SELECT max(id) FROM mail_message mm WHERE mm.model = 'discuss.channel' AND mm.res_id = c.id), 0)::int AS last FROM discuss_channel c JOIN discuss_channel_member m ON m.discuss_channel_id = c.id WHERE m.partner_id = $1`, [partnerId]);
  const inbox = await env.cr.query<{ n: number }>(`SELECT count(*)::int AS n FROM mail_notification WHERE res_partner_id = $1 AND coalesce(is_read, false) = false`, [partnerId]).catch(() => ({ rows: [{ n: 0 }] }));
  return { channels: Object.fromEntries(rows.rows.map((r) => [num(r.id), num(r.last)])), inbox: num(inbox.rows[0]?.n) };
}
