import test from 'node:test';
import assert from 'node:assert/strict';
import { maybeRepairVehicles, VEHICLE_REPAIR_COOLDOWN, VEHICLE_REPAIR_FLOOR, REPAIR_BUILDINGS, REPAIR_YARDS } from '../src/player/werhd-jev-special.mjs';

// Two ways a vehicle can be repaired, both from `docs/rules(规则文件).ini` and both ending as the order the G key
// fires, `OrderType.Repair` (15), carrying the object to be repaired:
//   * `UnitRepair=yes` buildings -- the three service depots and the neutral `CAOUTP` Tech Outpost (the shipyards
//     carry the same field but repair naval units, not tanks): the DAMAGED vehicle is sent to the building;
//   * an engineer inside an IFV -- `[FV]` is Passengers=1/Gunner=yes/WeaponCount=13, so its weapon is its
//     passenger's: the REPAIR VEHICLE is sent to the damaged unit.
const catalog = {
  GADEPT: { label: 'Service Depot', unitRepair: true }, GAYARD: { label: 'Shipyard', unitRepair: true },
  MTNK: { label: 'Grizzly Battle Tank', cost: 750 }, FV: { label: 'IFV', passengers: 1, gunner: true },
  ENGINEER: { label: 'Engineer', engineer: true },
};
const REPAIR = 15;
const tank = (over = {}) => ({ id: 10, name: 'MTNK', type: 7, isIdle: true, hitPoints: 300, maxHitPoints: 750, tile: { rx: 5, ry: 5 }, ...over });
const depot = (name = 'GADEPT') => ({ id: 20, name, type: 2, isIdle: false, hitPoints: 1000, maxHitPoints: 1000, tile: { rx: 8, ry: 5 } });
const ifv = (over = {}) => ({ id: 30, name: 'FV', type: 7, isIdle: false, transport: { occupied: 1, capacity: 1, unitIds: [99] }, tile: { rx: 6, ry: 5 }, ...over });
const run = ({ own = [tank(), depot()], credits = 5000, memory = {}, resolveCargo = true, tick = 50000 } = {}) => {
  const calls = [], events = [];
  const api = {
    tick: () => tick,
    me: () => ({ credits }),
    ObjectType: { Building: 2, Vehicle: 7 },
    OrderType: { Repair: REPAIR },
    // Cargo identities are own-only; a build that does not expose them returns undefined here, and this path
    // then has to stand down rather than guess.
    unit: (id) => (resolveCargo && id === 99 ? { id: 99, name: 'ENGINEER' } : undefined),
    units: (r) => (r === 'self' ? own : []),
    order: (ids, order) => { calls.push([ids, order]); return true; },
  };
  maybeRepairVehicles(api, catalog, (memory = { ...memory }), (e) => events.push(e));
  return { calls, events, memory };
};

test('a damaged tank is sent to a UnitRepair building', () => {
  const { calls, events, memory } = run();
  assert.deepEqual(calls, [[[10], { type: REPAIR, target: { objectId: 20 } }]], 'the tank repairs AT the depot');
  assert.match(events[0].description, /Grizzly Battle Tank #10/);
  assert.equal(events[0].ids[0], 10);
  assert.equal(memory.repairAt, 50000, 'and the cooldown starts');
});

test('an engineer inside an IFV makes it the repair vehicle, and it is the one ordered', () => {
  const { calls, events } = run({ own: [tank(), depot(), ifv()] });
  assert.deepEqual(calls, [[[30], { type: REPAIR, target: { objectId: 10 } }]], 'the repair vehicle goes to the tank');
  assert.equal(events[0].targetId, 10);
});

test('cargo identities that do not resolve never turn an IFV into a repairer', () => {
  // Same shape, but `api.unit` cannot name the passenger: the depot path is the one taken, not a guess.
  const { calls } = run({ own: [tank(), depot(), ifv()], resolveCargo: false });
  assert.deepEqual(calls, [[[10], { type: REPAIR, target: { objectId: 20 } }]]);
});

test('only idle vehicles with real damage, and only on a cooldown', () => {
  assert.deepEqual(run({ own: [tank({ hitPoints: 700 }), depot()] }).calls, [], 'a scratch is not worth the credits');
  assert.deepEqual(run({ own: [tank({ isIdle: false }), depot()] }).calls, [], 'a vehicle under fire gets no repair order');
  assert.deepEqual(run({ own: [tank(), depot('GAYARD')] }).calls, [], 'a shipyard has the field but repairs naval units, not tanks');
  assert.deepEqual(run({ memory: { repairAt: 50000 - VEHICLE_REPAIR_COOLDOWN + 1 } }).calls, [], 'one tick short of the cooldown');
  assert.equal(run({ memory: { repairAt: 50000 - VEHICLE_REPAIR_COOLDOWN } }).calls.length, 1, 'a full cooldown later it may order again');
});

test('a repair never spends the last of the money', () => {
  assert.deepEqual(run({ credits: VEHICLE_REPAIR_FLOOR - 1 }).calls, []);
  assert.equal(run({ credits: VEHICLE_REPAIR_FLOOR }).calls.length, 1);
});

test('the worst vehicle is the one repaired, and a loaded transport is never the patient', () => {
  const bad = tank({ id: 11, hitPoints: 100 }), worse = tank({ id: 12, hitPoints: 50 });
  assert.deepEqual(run({ own: [bad, worse, depot()] }).calls, [[[12], { type: REPAIR, target: { objectId: 20 } }]], 'the lowest health goes first');
  const loaded = tank({ id: 13, hitPoints: 100, transport: { occupied: 1, capacity: 1, unitIds: [99] } });
  assert.deepEqual(run({ own: [loaded, depot()] }).calls, [], 'its passenger is the point of it');
});

test('with neither a repair building nor a repair vehicle, nothing is ordered', () => {
  assert.deepEqual(run({ own: [tank()] }).calls, []);
  assert.deepEqual(run({ own: [tank(), depot()], resolveCargo: false }).calls.length, 1, 'the depot alone is enough');
});

test('a damaged ship goes to a shipyard, not to a service depot', () => {
  const ship = { id: 40, name: 'DEST', type: 7, isIdle: true, hitPoints: 100, maxHitPoints: 600, tile: { rx: 5, ry: 5 } };
  const shipCatalog = { ...catalog, DEST: { label: 'Destroyer', naval: true } };
  const calls = [];
  const api = {
    tick: () => 50000, me: () => ({ credits: 5000 }), ObjectType: { Building: 2, Vehicle: 7 }, OrderType: { Repair: REPAIR },
    unit: () => undefined, units: () => [ship, depot('GAYARD'), depot('GADEPT')], order: (ids, order) => { calls.push([ids, order]); return true; },
  };
  maybeRepairVehicles(api, shipCatalog, {}, () => {});
  assert.deepEqual(calls, [[[40], { type: REPAIR, target: { objectId: 20 } }]], 'the shipyard #20, not the depot');
});

test('the building lists are the ones that repair vehicles, not the shipyards', () => {
  assert.deepEqual([...REPAIR_BUILDINGS].sort(), ['CADEPT', 'CAOUTP', 'GADEPT', 'NADEPT']);
  assert.deepEqual([...REPAIR_YARDS].sort(), ['CAYARD', 'GAYARD', 'NAYARD']);
});
