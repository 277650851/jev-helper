import assert from 'node:assert/strict';
import { specialGroups, executeSpecial, rememberSpecial, maintainSpecial, CRATE_TIMEOUT } from '../src/player/werhd-jev-special.mjs';
import { askableGroups, requestGroupsFrom, engineOwnedMarks, collectTakeovers } from '../src/player/werhd-jev-player.mjs';

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
// 5. Only three crates are offered, so WHICH three matters. The listing order is the game's, not a priority:
//    taking the first three can hand the scout a crate across the map while one sits beside the base, and the
//    scout's trip to a frontier is what finds the enemy base at all.
{
  memory.specialTasks = []; memory.specialOrders = new Map();
  own.length = 0;
  own.push({ id: 1, name: 'YARD', kind: 'YARD', type: 2, tile: { rx: 20, ry: 20 }, hitPoints: 1000, maxHitPoints: 1000 });
  for (const id of [2, 3, 4]) own.push({ id, name: 'HTNK', kind: 'HTNK', type: 7, tile: { rx: 22 + id, ry: 20 }, hitPoints: 400, maxHitPoints: 400, isIdle: true, primaryWeapon: catalog.HTNK.weapon });
  // Listed farthest first, nearest LAST -- the order that used to hide the crate beside the base.
  crates = [crate(11, 55, 55), crate(12, 40, 40), crate(13, 50, 50), crate(14, 21, 21)];
  const groups = {};
  specialGroups(api, catalog, snapshot, memory, groups);
  const keys = Object.keys(groups.salvage?.actions ?? {}).filter((k) => k.startsWith('crate_'));
  assert.equal(keys.length, 3, `three crates are offered (${keys.join(',')})`);
  assert.ok(keys.includes('crate_14'), 'the one beside the base is among them even though it is listed last');
  assert.ok(!keys.includes('crate_11'), 'and the farthest is left out');
  assert.deepEqual(keys.sort(), ['crate_12', 'crate_13', 'crate_14'], 'the three nearest, in distance order');
}
// 6. A lone crate is the engine's own decision. Measured on jev-report-20261010-085322: 15 single-option
//    crate questions refused at a median confidence of 0.0074, 11 of them below 0.05 -- the same "no opinion"
//    signature as `defend_base`, and the engine collected them anyway once the fallback ran out.
{
  memory.specialTasks = []; memory.specialOrders = new Map();
  own.length = 0;
  own.push({ id: 1, name: 'YARD', kind: 'YARD', type: 2, tile: { rx: 20, ry: 20 }, hitPoints: 1000, maxHitPoints: 1000 });
  own.push({ id: 2, name: 'HTNK', kind: 'HTNK', type: 7, tile: { rx: 22, ry: 20 }, hitPoints: 400, maxHitPoints: 400, isIdle: true, primaryWeapon: catalog.HTNK.weapon });
  crates = [crate(77, 30, 24)];
  const groups = {};
  specialGroups(api, catalog, snapshot, memory, groups);
  const action = groups.salvage.actions.crate_77;
  assert.equal(action.engineOwned, true, 'the engine owns a lone crate');
  assert.equal(action.auto, 3, 'and the fallback threshold stays 3 for the case where an alternative appears');
  // The takeover pass lifts it, so the question is never put to the model.
  const asked = askableGroups(requestGroupsFrom(groups, memory, 1000));
  assert.ok(!('salvage' in asked), 'so it is not asked about');
  const taken = collectTakeovers(groups, null, engineOwnedMarks(groups), memory, 1000).filter((x) => !(x.id in asked));
  assert.ok(taken.some((x) => x.id === 'salvage' && x.choice === 'crate_77'), 'and the engine collects it');
}
console.log('Upgrade crates: read from crates(), collected with move, released when gone, nearest first, engine-owned when lone');
