import assert from 'node:assert/strict';
import { specialGroups, executeSpecial, rememberSpecial, maintainSpecial, CRATE_TIMEOUT } from '../src/player/werhd-jev-special.mjs';

// Upgrade crates come from `werhd.crates()`, a listing separate from `units()` that is locally visible only
// (`docs/player-console-api.md:81`), so nothing else in the engine has ever seen one. Collecting is a plain
// `move` onto the tile: `gather` is documented as "采矿到明确地格" for a harvester
// (`docs/player-console-api.md:178`), which is a different verb.

const catalog = {
  YARD: { yard: true, factory: 'BuildingType', label: 'Yard', armor: 'concrete' },
  HTNK: { label: 'Rhino', armor: 'heavy', category: 'AFV', cost: 900, weapon: { damage: 90, rof: 65, range: 5.75, ag: true, versus: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [i, 100])) } },
};

const crate = (id, rx, ry, extra = {}) => ({ id, name: 'Money Crate', tile: { rx, ry }, water: false, ...extra });
let crates = [];
const moves = [];
let tick = 1000;

const own = [
  { id: 1, name: 'YARD', kind: 'YARD', type: 2, tile: { rx: 20, ry: 20 }, hitPoints: 1000, maxHitPoints: 1000 },
  { id: 2, name: 'HTNK', kind: 'HTNK', type: 7, tile: { rx: 22, ry: 20 }, hitPoints: 400, maxHitPoints: 400, isIdle: true, primaryWeapon: catalog.HTNK.weapon },
];
const api = {
  ObjectType: { Building: 2, Infantry: 3, Vehicle: 7, Aircraft: 1 },
  ZoneType: { Ground: 0, Air: 1 },
  QueueType: { Structures: 0, Armory: 1, Infantry: 2, Vehicles: 3, Aircrafts: 4, Ships: 5 },
  OrderType: { Move: 0, Attack: 2, ForceAttack: 3, Occupy: 8, DeploySelected: 10, Stop: 11, Repair: 15, EnterTransport: 17 },
  ArmorType: { 0: 'None', 5: 'Heavy', 8: 'Concrete' },
  me: () => ({ credits: 1000, power: { total: 500, drain: 100 } }),
  units: (r) => (r === 'self' ? own : []), unit: (id) => own.find((u) => u.id === id),
  crates: () => crates,
  move: (ids, x, y) => moves.push({ ids, x, y }),
  tick: () => tick, time: () => 20,
  map: { size: () => ({ width: 60, height: 60 }), visible: () => true, tile: (x, y) => ({ rx: x, ry: y, landType: 0 }) },
  production: { queues: () => Array.from({ length: 6 }, (_, type) => ({ type, size: 0, maxSize: 99, items: [] })), available: () => [] },
  canPlace: () => true, order: () => true, inRange: () => true, deploy: () => true,
};
const snapshot = {
  raw: { units: own, buildings: [own[0]], army: [own[1]], enemies: [], base: { name: 'YARD', tile: { rx: 20, ry: 20 } } },
  state: { self: { credits: 1000 }, harvesters: 1, economy: { factories: 1 }, airThreatCount: 0, nearbyEnemyCount: 0, baseUnderAttack: false },
};
const memory = {};

// 1. A visible crate becomes an option, and the option carries the crate's tile.
crates = [crate(77, 30, 24)];
specialGroups(api, catalog, snapshot, memory, {});
assert.equal(snapshot.state.infrastructure.crates, 1, 'the crate count reaches the state so a unit that walks off is explained');

{
  const groups = {};
  specialGroups(api, catalog, snapshot, memory, groups);
  const action = groups.salvage?.actions?.crate_77;
  assert.ok(action, 'the crate is offered');
  assert.equal(action.kind, 'collect_crate');
  assert.equal(action.crateId, 77, 'the option is keyed by crate id, which is what the busy set records');
  assert.deepEqual(action.ids, [2], 'one unit is assigned');
}

// 2. The executor re-reads the crate list and moves the unit onto the tile — with `move`, not `gather`.
{
  moves.length = 0;
  const execution = executeSpecial(api, { type: 'special', kind: 'collect_crate', ids: [2], crateId: 77 });
  assert.equal(execution.accepted, true);
  assert.deepEqual(moves, [{ ids: [2], x: 30, y: 24 }], 'the unit is moved onto the crate tile');
  assert.equal(execution.crateId, 77);
}

// 3. A crate looted between the option and the order sends nobody to empty ground.
{
  moves.length = 0;
  crates = [];
  const execution = executeSpecial(api, { type: 'special', kind: 'collect_crate', ids: [2], crateId: 77 });
  assert.equal(execution.accepted, false);
  assert.equal(execution.reason, 'crate_gone');
  assert.deepEqual(moves, [], 'and no order is issued');
}

// 4. The task is remembered, and released the moment the crate is gone. Without that the crate stays marked
//    "someone is walking to it" for the rest of the match and the crates skipped because of it are lost.
{
  memory.specialTasks = []; memory.specialOrders = new Map();
  crates = [crate(77, 30, 24)];
  const action = { type: 'special', kind: 'collect_crate', ids: [2], crateId: 77 };
  rememberSpecial(memory, action, { accepted: true }, tick);
  assert.equal(memory.specialTasks.length, 1, 'the pickup is tracked as a task');
  assert.equal(memory.specialOrders.get(2)?.crateId, 77, 'and the order records which crate, for the busy set');

  const events = [];
  crates = [];
  maintainSpecial(api, memory, (e) => events.push(e), catalog);
  assert.equal(memory.specialTasks.length, 0, 'a crate that is gone ends the task');
  assert.equal(memory.specialOrders.has(2), false, 'and releases the unit');
  assert.ok(events.some((e) => e.result === 'collected'), 'reporting it as collected');

  // A living crate keeps the task alive, and a unit that sat still is nudged again after CRATE_RESEND.
  memory.specialTasks = []; memory.specialOrders = new Map();
  crates = [crate(78, 31, 25)];
  const stuck = { type: 'special', kind: 'collect_crate', ids: [2], crateId: 78 };
  rememberSpecial(memory, stuck, { accepted: true }, tick);
  memory.specialTasks[0].submitted = tick - 1000;
  moves.length = 0;
  maintainSpecial(api, memory, (e) => events.push(e), catalog);
  assert.equal(memory.specialTasks.length, 1, 'a crate still on the map keeps the task');
  assert.deepEqual(moves, [{ ids: [2], x: 31, y: 25 }], 'and an idle unit is nudged back toward it');

  // Past CRATE_TIMEOUT the trip is abandoned even though the crate is still listed.
  memory.specialTasks[0].started = tick - CRATE_TIMEOUT - 1;
  maintainSpecial(api, memory, (e) => events.push(e), catalog);
  assert.equal(memory.specialTasks.length, 0, 'a trip that never completes is abandoned');
  assert.equal(memory.specialOrders.has(2), false);
}
console.log('Upgrade crates: read from crates(), collected with move, and released when the box is gone');
