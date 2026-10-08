import assert from 'node:assert/strict';
import { specialGroups, executeSpecial, rememberSpecial, maintainSpecial } from '../src/player/werhd-jev-special.mjs';

// A crate is a tile on the ground: a unit collects it by standing on it. That is the whole contract these
// tests pin down, because the previous implementation fired a one-shot command nobody owned. The order was
// written into memory, never cleaned up, and the crate stayed marked as "someone is already going there"
// for the rest of the match -- one dispatch and the feature went dark for good.

const tick = { value: 1000 };
const calls = [];

const catalog = {
  YARD: { yard: true, label: 'Yard' },
  DOG: { attackDog: true, label: 'Attack Dog', cost: 200, speed: 10, weapon: { damage: 100, ag: true, range: 1 } },
  GI: { label: 'Conscript', cost: 100, weapon: { damage: 60, ag: true, range: 2 } },
  TANK: { label: 'Medium Tank', cost: 800, weapon: { damage: 200, ag: true, range: 5 } },
  DEF: { isBaseDefense: true, cost: 500, label: 'Pillbox' },
};

const make = (extra = {}) => ({
  id: 1, name: 'YARD', type: 2, tile: { rx: 10, ry: 10 }, hitPoints: 100, maxHitPoints: 100, isIdle: true, ...extra,
});

function scenario({ crates = [], own, scoutId, tickStart = 1000 } = {}) {
  tick.value = tickStart;
  calls.length = 0;
  const base = make();
  const units = [base, ...own];
  const api = {
    tick: () => tick.value,
    crates: () => crates,
    units: (relation) => relation === 'self' ? units : [],
    unit: (id) => units.find((u) => u.id === id),
    order: () => true, canPlace: () => true, sell: () => {},
    move: (ids, x, y) => calls.push(['move', ids, x, y]),
    gather: (ids, x, y) => calls.push(['gather', ids, x, y]),
    ObjectType: { Aircraft: 1, Building: 2, Infantry: 3, Vehicle: 7 },
    OrderType: { Move: 0, Attack: 2, ForceAttack: 3, Occupy: 8, DeploySelected: 10, Stop: 11, Repair: 15, EnterTransport: 17 },
    QueueType: { Structures: 0, Armory: 1, Infantry: 2, Vehicles: 3, Aircrafts: 4, Ships: 5 },
    production: {
      queues: () => Array.from({ length: 6 }, (_, type) => ({ type, size: 0, maxSize: 10 })),
      available: () => [],
    },
    map: { size: () => ({ width: 12, height: 12 }), visible: () => false, tile: () => undefined },
  };
  const snapshot = {
    raw: { units, buildings: [base], army: own.filter((u) => u.type === 3 || u.type === 7), enemies: [], base },
    state: { self: { credits: 10000 }, harvesters: 2, economy: { factories: 1 }, airThreatCount: 0 },
  };
  const memory = scoutId === undefined ? {} : { scoutId };
  const groups = {};
  const events = [];
  const emit = (e) => events.push(e);
  return { api, snapshot, memory, groups, base, units, events, emit };
}

const crate = (id, x, y, extra = {}) => ({ id, name: 'crate', tile: { rx: x, ry: y }, water: false, ...extra });
const options = (groups) => Object.values(groups).flatMap((g) => Object.values(g.actions)).filter((a) => a.kind === 'collect_crate');

// --- the unit walks onto the tile; it does not issue a mining order -------------------------
{
  const s = scenario({ crates: [crate(5, 14, 10)], own: [make({ id: 10, name: 'DOG', type: 3 })] });
  s.memory.scoutId = 10;
  specialGroups(s.api, catalog, s.snapshot, s.memory, s.groups);
  const [action] = options(s.groups);
  assert.ok(action, 'a visible crate must be offered');
  assert.equal(action.crateId, 5);

  const execution = executeSpecial(s.api, action);
  assert.equal(execution.accepted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'move', 'a box is collected by standing on it, not by mining it');
  assert.deepEqual(calls[0][1], [10]);
  assert.deepEqual(calls[0].slice(2), [14, 10]);
  assert.ok(!calls.some((c) => c[0] === 'gather'), 'gather is documented as mining to a named tile');
}

// --- the order becomes a task that owns itself -------------------------------------------
{
  const s = scenario({ crates: [crate(5, 14, 10)], own: [make({ id: 10, name: 'DOG', type: 3 })] });
  s.memory.scoutId = 10;
  specialGroups(s.api, catalog, s.snapshot, s.memory, s.groups);
  const [action] = options(s.groups);
  rememberSpecial(s.memory, action, executeSpecial(s.api, action), s.api.tick());
  assert.equal(s.memory.specialTasks.length, 1, 'a crate pickup must be tracked, not fired and forgotten');
  assert.equal(s.memory.specialOrders.get(10).crateId, 5);
}

// --- picking the box up ends the task and releases the unit ------------------------------
{
  const crates = [crate(5, 14, 10)];
  const s = scenario({ crates, own: [make({ id: 10, name: 'DOG', type: 3 })] });
  s.memory.scoutId = 10;
  specialGroups(s.api, catalog, s.snapshot, s.memory, s.groups);
  const [action] = options(s.groups);
  rememberSpecial(s.memory, action, executeSpecial(s.api, action), s.api.tick());

  crates.length = 0; // the box is gone: collected by our unit or by someone else
  maintainSpecial(s.api, s.memory, s.emit, catalog);
  assert.equal(s.memory.specialTasks.length, 0, 'the task ends when the crate leaves the listing');
  assert.equal(s.memory.specialOrders.has(10), false, 'the unit is released, so it can be given other orders');
  const done = s.events.find((e) => e.task === 'collect_crate');
  assert.equal(done.result, 'collected');
}

// --- a unit that dies mid-trip releases the crate instead of writing it off ---------------
{
  const crates = [crate(5, 14, 10)];
  const s = scenario({ crates, own: [make({ id: 10, name: 'DOG', type: 3 }), make({ id: 11, name: 'DOG', type: 3, tile: { rx: 12, ry: 12 } })] });
  s.memory.scoutId = 10;
  specialGroups(s.api, catalog, s.snapshot, s.memory, s.groups);
  const [action] = options(s.groups);
  assert.equal(action.ids[0], 10, 'the scout is the one sent');
  rememberSpecial(s.memory, action, executeSpecial(s.api, action), s.api.tick());

  s.units.splice(1, 1); // the scout is gone, the spare dog is not
  maintainSpecial(s.api, s.memory, s.emit, catalog);
  assert.equal(s.memory.specialTasks.length, 0);
  assert.equal(s.memory.specialOrders.has(10), false);
  assert.equal(s.events.find((e) => e.task === 'collect_crate').result, 'unit_lost');

  // ...and the crate is offered again on the next turn, to whoever is left.
  const next = {};
  specialGroups(s.api, catalog, s.snapshot, s.memory, next);
  const offered = options(next);
  assert.equal(offered.length, 1, 'a crate dropped mid-trip must not stay blocked for the match');
  assert.equal(offered[0].ids[0], 11);
}

// --- a unit that stops short of the box is nudged again, then given up on ----------------
{
  const crates = [crate(5, 14, 10)];
  const s = scenario({ crates, own: [make({ id: 10, name: 'DOG', type: 3 })] });
  s.memory.scoutId = 10;
  specialGroups(s.api, catalog, s.snapshot, s.memory, s.groups);
  const [action] = options(s.groups);
  rememberSpecial(s.memory, action, executeSpecial(s.api, action), s.api.tick());

  calls.length = 0;
  tick.value += 130; // still idle short of the crate
  maintainSpecial(s.api, s.memory, s.emit, catalog);
  assert.deepEqual(calls.map((c) => c[0]), ['move'], 'an interrupted trip is re-issued');
  assert.equal(s.memory.specialTasks.length, 1);

  tick.value += 4000; // long past any reasonable walk
  maintainSpecial(s.api, s.memory, s.emit, catalog);
  assert.equal(s.memory.specialTasks.length, 0, 'an unreachable crate is abandoned, not retried forever');
  assert.equal(s.events.find((e) => e.task === 'collect_crate').result, 'timeout');
  assert.equal(s.memory.specialOrders.has(10), false);
}

// --- a crate already being fetched must not hide the others ------------------------------
{
  const crates = [crate(5, 14, 10), crate(6, 16, 12)];
  const s = scenario({
    crates,
    own: [make({ id: 10, name: 'DOG', type: 3 }), make({ id: 11, name: 'DOG', type: 3, tile: { rx: 12, ry: 12 } })],
  });
  s.memory.scoutId = 10;
  specialGroups(s.api, catalog, s.snapshot, s.memory, s.groups);
  const [first] = options(s.groups);
  rememberSpecial(s.memory, first, executeSpecial(s.api, first), s.api.tick());

  // A fresh turn: `candidateGroups` rebuilds the group set every decision, so the second call starts
  // from an empty one exactly as the engine does.
  const next = {};
  specialGroups(s.api, catalog, s.snapshot, s.memory, next);
  const offered = options(next);
  assert.equal(offered.length, 1, 'the crate under way is not offered twice');
  assert.equal(offered[0].crateId, 6, 'and it does not take the rest of the listing down with it');
  assert.notEqual(offered[0].ids[0], 10, 'the second box gets a different unit');
}

// --- two boxes, two units: the same id is never handed to both --------------------------
{
  const s = scenario({
    crates: [crate(5, 14, 10), crate(6, 16, 12)],
    own: [make({ id: 10, name: 'DOG', type: 3 }), make({ id: 11, name: 'DOG', type: 3, tile: { rx: 12, ry: 12 } })],
  });
  s.memory.scoutId = 10;
  specialGroups(s.api, catalog, s.snapshot, s.memory, s.groups);
  const offered = options(s.groups);
  assert.equal(offered.length, 2);
  assert.equal(new Set(offered.map((a) => a.ids[0])).size, 2, 'one unit per crate: two sent to one box is one wasted');
}

// --- a crate under water is not a pickup target ------------------------------------------
{
  const s = scenario({ crates: [crate(5, 14, 10, { water: true })], own: [make({ id: 10, name: 'DOG', type: 3 })] });
  s.memory.scoutId = 10;
  specialGroups(s.api, catalog, s.snapshot, s.memory, s.groups);
  assert.equal(options(s.groups).length, 0, 'a crate in the water cannot be walked onto');
}

// --- a crate that vanished between planning and executing is refused ----------------------
{
  const s = scenario({ crates: [crate(5, 14, 10)], own: [make({ id: 10, name: 'DOG', type: 3 })] });
  s.memory.scoutId = 10;
  specialGroups(s.api, catalog, s.snapshot, s.memory, s.groups);
  const [action] = options(s.groups);
  s.api.crates = () => [];
  assert.equal(executeSpecial(s.api, action).accepted, false, 'do not send a unit to empty ground');
  assert.deepEqual(calls, []);
}
