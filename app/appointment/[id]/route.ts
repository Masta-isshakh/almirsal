import { NextResponse } from 'next/server';
import type { Environment } from '@engine/orm/env';
import { getPublicEnvironment } from '@/lib/server/public';
import { portalLang } from '@/lib/server/portal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `/appointment/<appointment type>` — the page a visitor books on: the slots the
 * type offers over the next two weeks, and a short form for their name and
 * email. Booking writes the `calendar.event` and the `appointment.booking.line`
 * Odoo writes, so the meeting turns up in Calendar and on the appointment's own
 * counters.
 *
 * Published types only, and nothing about signing in is involved.
 */

const esc = (value: unknown): string => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tr = (rtl: boolean, en: string, ar: string): string => (rtl ? ar : en);
const DAY = 86_400_000;
/** Odoo's `weekday` on a slot is "1" for Monday … "7" for Sunday. */
const weekdayOf = (date: Date): string => String(date.getUTCDay() === 0 ? 7 : date.getUTCDay());

interface Slot { start: Date; label: string }

async function openType(idText: string, rtl: boolean): Promise<{ env: Environment; type: Record<string, unknown> } | { error: 404 }> {
  const id = Number(idText);
  if (!Number.isInteger(id) || id <= 0) return { error: 404 };
  const env = await getPublicEnvironment(rtl ? 'ar_001' : 'en_US');
  if (!env.registry.models['appointment.type']) return { error: 404 };
  const [type] = await env.model('appointment.type').read(id, ['name', 'appointment_duration', 'is_published', 'active', 'location_id', 'message_intro', 'staff_user_ids', 'schedule_based_on']).catch(() => []);
  if (!type || type.active === false || type.is_published === false) return { error: 404 };
  return { env, type };
}

/** The bookable moments of the next fortnight, from the type's weekly slots. */
async function slotsOf(env: Environment, typeId: number, duration: number): Promise<Slot[]> {
  const slots = await env.model('appointment.slot').searchRead([['appointment_type_id', '=', typeId]], ['weekday', 'start_hour', 'end_hour', 'allday', 'start_datetime'], { limit: 200 }).catch(() => []);
  if (!slots.length) return [];
  const taken = new Set((await env.model('calendar.event').searchRead([['appointment_type_id', '=', typeId], ['start', '>=', new Date().toISOString().slice(0, 19).replace('T', ' ')]], ['start'], { limit: 500 }).catch(() => []))
    .map((event) => String(event.start ?? '').slice(0, 16)));
  const out: Slot[] = [];
  const now = Date.now();
  for (let day = 0; day < 14 && out.length < 60; day += 1) {
    const date = new Date(now + day * DAY);
    const weekday = weekdayOf(date);
    for (const slot of slots.filter((candidate) => String(candidate.weekday ?? '') === weekday)) {
      const step = Math.max(0.25, Number(duration) || 1);
      for (let hour = Number(slot.start_hour ?? 0); hour + step <= Number(slot.end_hour ?? 0) + 0.001; hour += step) {
        const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), Math.floor(hour), Math.round((hour % 1) * 60)));
        if (start.getTime() < now) continue;
        const key = start.toISOString().slice(0, 16).replace('T', ' ');
        if (taken.has(key)) continue;
        out.push({ start, label: key });
      }
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime()).slice(0, 60);
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  const url = new URL(request.url);
  const rtl = (await portalLang(null, null, url, request)) === 'ar_001';
  const opened = await openType(id, rtl);
  if ('error' in opened) return new NextResponse('Not found', { status: 404 });
  const { env, type } = opened;
  const booked = url.searchParams.get('booked');
  if (booked) {
    const [event] = await env.model('calendar.event').read(Number(booked), ['name', 'start']).catch(() => []);
    return page(rtl, String(type.name ?? ''), event
      ? `<div class="o_appointment_done">${esc(tr(rtl, 'Your appointment is booked for', 'تم تحديد موعدك في'))} <strong>${esc(String(event.start ?? '').slice(0, 16))}</strong> (UTC).</div>`
      : `<div class="o_appointment_done">${esc(tr(rtl, 'Your appointment is booked.', 'تم تحديد موعدك.'))}</div>`);
  }

  const slots = await slotsOf(env, Number(id), Number(type.appointment_duration ?? 1));
  const duration = Number(type.appointment_duration ?? 1);
  const where = Array.isArray(type.location_id) ? String(type.location_id[1] ?? '') : '';
  return page(rtl, String(type.name ?? ''), `
    <p class="o_appointment_meta">
      ${esc(tr(rtl, 'Duration', 'المدة'))}: ${esc(duration >= 1 ? `${duration} ${tr(rtl, 'hour(s)', 'ساعة')}` : `${Math.round(duration * 60)} ${tr(rtl, 'minutes', 'دقيقة')}`)}
      ${where ? ` · ${esc(where)}` : ''}
    </p>
    ${type.message_intro ? `<div class="o_appointment_intro">${String(type.message_intro)}</div>` : ''}
    ${slots.length ? `
    <form method="post" action="/appointment/${encodeURIComponent(id)}${rtl ? '?lang=ar_001' : ''}">
      <label class="o_appointment_label" for="slot">${esc(tr(rtl, 'Pick a time (UTC)', 'اختر وقتاً (UTC)'))}</label>
      <select id="slot" name="slot" required>
        ${slots.map((slot) => `<option value="${esc(slot.start.toISOString().slice(0, 19).replace('T', ' '))}">${esc(slot.label)}</option>`).join('')}
      </select>
      <label class="o_appointment_label" for="name">${esc(tr(rtl, 'Your name', 'اسمك'))}</label>
      <input id="name" name="name" required autocomplete="name" />
      <label class="o_appointment_label" for="email">${esc(tr(rtl, 'Your email', 'بريدك الإلكتروني'))}</label>
      <input id="email" name="email" type="email" required autocomplete="email" />
      <button type="submit">${esc(tr(rtl, 'Book', 'احجز'))}</button>
    </form>` : `<p class="o_appointment_empty">${esc(tr(rtl, 'There is no free time on this calendar at the moment.', 'لا يوجد وقت متاح في هذا التقويم حالياً.'))}</p>`}`);
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  const url = new URL(request.url);
  const rtl = (await portalLang(null, null, url, request)) === 'ar_001';
  const opened = await openType(id, rtl);
  if ('error' in opened) return new NextResponse('Not found', { status: 404 });
  const { env, type } = opened;

  const form = await request.formData();
  const start = String(form.get('slot') ?? '').slice(0, 19);
  const name = String(form.get('name') ?? '').trim().slice(0, 120);
  const email = String(form.get('email') ?? '').trim().slice(0, 240);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(start) || !name || !email) return new NextResponse('Fill in the time, your name and your email.', { status: 400 });

  // Only a time this page offered, so a posted form cannot book anything else.
  const offered = await slotsOf(env, Number(id), Number(type.appointment_duration ?? 1));
  if (!offered.some((slot) => slot.start.toISOString().slice(0, 19).replace('T', ' ') === start)) {
    return new NextResponse('That time is not free any more.', { status: 409 });
  }

  const duration = Number(type.appointment_duration ?? 1) || 1;
  const stop = new Date(new Date(`${start.replace(' ', 'T')}Z`).getTime() + duration * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');
  const partners = env.model('res.partner');
  const [existing] = await partners.searchRead([['email', '=', email]], ['id'], { limit: 1 }).catch(() => []);
  const partner = existing ? Number(existing.id) : await partners.create({ name, email });

  const staff = ((type.staff_user_ids as number[]) ?? [])[0];
  const event = await env.model('calendar.event').create({
    name: `${type.name} - ${name}`,
    start,
    stop,
    duration,
    partner_ids: [[6, 0, [partner]]],
    appointment_type_id: Number(id),
    ...(staff ? { user_id: staff } : {}),
  });
  if (env.registry.models['appointment.booking.line']) {
    await env.model('appointment.booking.line').create({
      appointment_type_id: Number(id), calendar_event_id: event, capacity_reserved: 1, capacity_used: 1,
      ...(staff ? { appointment_user_id: staff } : {}),
    }).catch(() => undefined);
  }
  const done = new URL(url.pathname, url);
  done.searchParams.set('booked', String(event));
  if (rtl) done.searchParams.set('lang', 'ar_001');
  return NextResponse.redirect(done, 303);
}

function page(rtl: boolean, title: string, inner: string): Response {
  const body = `<!DOCTYPE html>
<html lang="${rtl ? 'ar' : 'en'}" dir="${rtl ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;500;700&family=Noto+Sans+Arabic:wght@400;500;700&display=swap" />
<style>${APPOINTMENT_CSS}</style>
</head>
<body>
<main class="o_appointment_card">
  <h1>${esc(title)}</h1>
  ${inner}
</main>
</body>
</html>`;
  return new NextResponse(body, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

const APPOINTMENT_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; background: #f3f4f6; font-family: "Noto Sans", "Noto Sans Arabic", system-ui, sans-serif; color: #111827; }
  .o_appointment_card { background: #fff; max-width: 520px; width: calc(100% - 32px); margin: 32px auto; padding: 28px 32px; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.12); }
  h1 { font-size: 22px; margin: 0 0 6px; }
  .o_appointment_meta { color: #4b5563; font-size: 13px; margin: 0 0 14px; }
  .o_appointment_intro { color: #4b5563; margin-bottom: 14px; }
  .o_appointment_label { display: block; font-size: 12px; color: #4b5563; margin: 12px 0 4px; }
  .o_appointment_card select, .o_appointment_card input { width: 100%; border: 1px solid #d1d5db; border-radius: 4px; padding: 9px 12px; font: inherit; }
  .o_appointment_card button { margin-top: 18px; background: #714b67; color: #fff; border: 0; border-radius: 4px; padding: 10px 22px; font: inherit; font-weight: 700; cursor: pointer; }
  .o_appointment_done { background: #ecfdf5; color: #065f46; border-radius: 6px; padding: 12px 14px; }
  .o_appointment_empty { color: #6b7280; }
`;
