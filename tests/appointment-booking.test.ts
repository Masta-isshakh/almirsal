import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgliteDatabase } from '../packages/engine/db/pglite.js';
import type { Database } from '../packages/engine/db/types.js';
import { syncSchema } from '../packages/engine/schema/ddl.js';
import { loadSeed } from '../packages/engine/seed/load.js';
import { testRegistry } from '../packages/engine/testing/registry.js';
import { Environment } from '../packages/engine/orm/env.js';
import { clearModelHooks } from '../packages/engine/orm/hooks.js';
import { registerApps } from '../packages/apps/index.js';

/**
 * Booking from the public page (`app/appointment/[id]`): a booked slot becomes
 * the `calendar.event` and the `appointment.booking.line` Odoo writes, so the
 * meeting shows in Calendar and the appointment's counters see it.
 */
const registry = testRegistry();
let db: Database;
let env: Environment;

beforeAll(async () => {
  db = pgliteDatabase();
  await syncSchema(db, registry);
  await loadSeed(db, registry);
  clearModelHooks();
  registerApps(registry);
  env = new Environment({ registry, db, uid: 2, companyIds: [1], superuser: true });
}, 240_000);

afterAll(async () => { await db.close?.(); });

describe('appointment booking', () => {
  it('books the slot as a meeting with the visitor on it', async () => {
    const type = await env.model('appointment.type').create({ name: 'Product demo', appointment_duration: 1, is_published: true });
    await env.model('appointment.slot').create({ appointment_type_id: type, weekday: '1', start_hour: 9, end_hour: 12 });

    // What the route writes once a visitor picks a time.
    const partner = await env.model('res.partner').create({ name: 'Website Visitor', email: 'visitor@example.com' });
    const event = await env.model('calendar.event').create({
      name: 'Product demo - Website Visitor',
      start: '2026-10-05 09:00:00', stop: '2026-10-05 10:00:00', duration: 1,
      partner_ids: [[6, 0, [partner]]], appointment_type_id: type,
    });
    const line = await env.model('appointment.booking.line').create({ appointment_type_id: type, calendar_event_id: event, capacity_reserved: 1, capacity_used: 1 });

    const [meeting] = await env.model('calendar.event').read(event, ['name', 'start', 'partner_ids', 'appointment_type_id', 'attendees_count']);
    expect(meeting.name).toBe('Product demo - Website Visitor');
    expect(meeting.partner_ids).toContain(partner);
    expect(meeting.appointment_type_id).toEqual([type, 'Product demo']);
    expect((await env.model('appointment.booking.line').read(line, ['capacity_reserved']))[0].capacity_reserved).toBe(1);

    // The appointment's own screens find it.
    expect(await env.model('calendar.event').searchCount([['appointment_type_id', '=', type]])).toBe(1);
    expect(await env.model('appointment.booking.line').searchCount([['appointment_type_id', '=', type]])).toBe(1);
  });

  it('keeps a slot out of the offer once it is taken', async () => {
    const type = await env.model('appointment.type').create({ name: 'Consultation', appointment_duration: 1, is_published: true });
    await env.model('appointment.slot').create({ appointment_type_id: type, weekday: '3', start_hour: 14, end_hour: 15 });
    const start = '2026-10-07 14:00:00';
    await env.model('calendar.event').create({ name: 'Taken', start, stop: '2026-10-07 15:00:00', duration: 1, appointment_type_id: type });
    const taken = await env.model('calendar.event').searchRead([['appointment_type_id', '=', type], ['start', '>=', '2026-10-01 00:00:00']], ['start']);
    expect(taken.map((event) => String(event.start))).toContain(start);
  });

  it('is not offered when the type is unpublished or archived', async () => {
    const hidden = await env.model('appointment.type').create({ name: 'Internal only', appointment_duration: 1, is_published: false });
    expect((await env.model('appointment.type').read(hidden, ['is_published']))[0].is_published).toBe(false);
    const archived = await env.model('appointment.type').create({ name: 'Old offer', appointment_duration: 1, is_published: true, active: false });
    expect(await env.model('appointment.type').search([['id', '=', archived]])).toEqual([]);
  });
});
