import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgliteDatabase } from '../engine/db/pglite.js';
import type { Database } from '../engine/db/types.js';
import { syncSchema } from '../engine/schema/ddl.js';
import { loadSeed } from '../engine/seed/load.js';
import { testRegistry } from '../engine/testing/registry.js';
import { Environment } from '../engine/orm/env.js';
import { clearModelHooks } from '../engine/orm/hooks.js';
import { registerApps } from './index.js';

/**
 * Fleet: a vehicle takes its name from its model, a change of driver is kept in
 * the history, contracts warn before and after they run out, and the counters
 * the smart buttons show follow the records.
 */
const registry = testRegistry();
let db: Database;
let env: Environment;
let model: number;
let brand: number;

beforeAll(async () => {
  db = pgliteDatabase();
  await syncSchema(db, registry);
  await loadSeed(db, registry);
  clearModelHooks();
  registerApps(registry);
  env = new Environment({ registry, db, uid: 2, companyIds: [1] });
  brand = await env.model('fleet.vehicle.model.brand').create({ name: 'Renault' });
  model = await env.model('fleet.vehicle.model').create({ name: 'Kangoo', brand_id: brand, vehicle_type: 'car' });
}, 240_000);

afterAll(async () => { await db.close?.(); });

describe('fleet', () => {
  it('names a vehicle after its model and counts it on the model and the brand', async () => {
    const vehicles = env.model('fleet.vehicle');
    const id = await vehicles.create({ model_id: model, license_plate: 'FLEET-001' });
    const [vehicle] = await vehicles.read(id, ['name', 'state_id', 'model_id']);
    expect(vehicle.name).toBe('Renault/Kangoo');
    // Odoo starts a vehicle in the first stage of the pipeline.
    expect(Array.isArray(vehicle.state_id)).toBe(true);
    expect((await env.model('fleet.vehicle.model').read(model, ['vehicle_count']))[0].vehicle_count).toBe(1);
    expect((await env.model('fleet.vehicle.model.brand').read(brand, ['model_count']))[0].model_count).toBe(1);
  });

  it('keeps the drivers history when the driver changes', async () => {
    const vehicles = env.model('fleet.vehicle');
    const id = await vehicles.create({ model_id: model, license_plate: 'FLEET-002' });
    const first = await env.model('res.partner').create({ name: 'First Driver' });
    const second = await env.model('res.partner').create({ name: 'Second Driver' });
    await vehicles.write(id, { driver_id: first });
    await vehicles.write(id, { driver_id: second });
    const logs = await env.model('fleet.vehicle.assignation.log').searchRead([['vehicle_id', '=', id]], ['driver_id', 'date_start', 'date_end'], { order: 'id' });
    expect(logs).toHaveLength(2);
    expect(logs[0].driver_id).toEqual([first, 'First Driver']);
    expect(logs[0].date_end).toBeTruthy();
    expect(logs[1].driver_id).toEqual([second, 'Second Driver']);
    expect(logs[1].date_end).toBeFalsy();
  });

  it('warns before a contract runs out and once it has', async () => {
    const vehicles = env.model('fleet.vehicle');
    const id = await vehicles.create({ model_id: model, license_plate: 'FLEET-003' });
    const contracts = env.model('fleet.vehicle.log.contract');
    const reminders = async () => (await vehicles.read(id, ['contract_renewal_due_soon', 'contract_renewal_overdue', 'contract_count']))[0];
    expect(await reminders()).toMatchObject({ contract_renewal_due_soon: false, contract_renewal_overdue: false, contract_count: 0 });

    const soon = new Date(Date.now() + 8 * 86_400_000).toISOString().slice(0, 10);
    const contract = await contracts.create({ vehicle_id: id, amount: 500, expiration_date: soon });
    expect(await reminders()).toMatchObject({ contract_renewal_due_soon: true, contract_renewal_overdue: false, contract_count: 1 });
    expect((await contracts.read(contract, ['state', 'has_open_contract']))[0]).toMatchObject({ state: 'open', has_open_contract: true });

    const past = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    await contracts.write(contract, { expiration_date: past });
    expect(await reminders()).toMatchObject({ contract_renewal_due_soon: false, contract_renewal_overdue: true });
    expect((await contracts.read(contract, ['state']))[0].state).toBe('expired');
    // The Fleet app finds the vehicles to deal with by these two fields.
    expect(await vehicles.search([['contract_renewal_overdue', '=', true]])).toContain(id);

    await contracts.callButton(contract, 'action_close');
    expect(await reminders()).toMatchObject({ contract_renewal_overdue: false });
  });

  it('reads the odometer from its logs and the service activity from the services', async () => {
    const vehicles = env.model('fleet.vehicle');
    const id = await vehicles.create({ model_id: model, license_plate: 'FLEET-004' });
    expect((await vehicles.read(id, ['service_activity']))[0].service_activity).toBe('none');

    await env.model('fleet.vehicle.odometer').create({ vehicle_id: id, value: 12_000 });
    await env.model('fleet.vehicle.odometer').create({ vehicle_id: id, value: 15_500 });
    expect((await vehicles.read(id, ['odometer']))[0].odometer).toBe(15_500);

    const [serviceType] = await env.model('fleet.service.type').search([]);
    const late = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    await env.model('fleet.vehicle.log.services').create({ vehicle_id: id, service_type_id: serviceType, date_from: late, amount: 120 });
    expect((await vehicles.read(id, ['service_activity']))[0].service_activity).toBe('overdue');
  });
});
