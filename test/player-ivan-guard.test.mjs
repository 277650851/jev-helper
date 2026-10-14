import assert from 'node:assert/strict';
import { specialGroups, executeSpecial } from '../src/player/werhd-jev-special.mjs';

// Crazy Ivan plants a timed bomb on our units or buildings, and an engineer set to Guard clears the bombs
// around it -- the game's own G key, which is `OrderType.Guard = 5` in the player API, so this needs no new
// interface. What a script cannot do is SEE the bomb: `PlayerConsoleUnit` has no `bomb` field and there is
// no event stream, so a visible Ivan is the only warning there is and the trigger has to be the threat.
const catalog = {
  YARD: { yard: true, factory: 'BuildingType', label: 'Yard', armor: 'concrete' },
  ENG: { label: 'Engineer', engineer: true, armor: 'none', cost: 500 },
  IVAN: { label: 'Crazy Ivan', armor: 'none', category: 'Soldier', weapon: { damage: 5, rof: 40, range: 3, ag: true, versus: [1, 1, 1, 1, 1, 1] } },
  MTNK: { label: 'Grizzly', armor: 'heavy', category: 'AFV', weapon: { damage: 65, rof: 60, range: 5, ag: true, versus: [1, 1, 1, 1, 1, 1] } },
};
const unit = (id, name, type, rx, ry, extra = {}) => ({ id, name, kind: name, type, tile: { rx, ry }, hitPoints: 200, maxHitPoints: 200, isIdle: true, primaryWeapon: catalog[name].weapon, ...extra });
const yard = unit(1, 'YARD', 2, 20, 20);
let own = [], enemies = [], tick = 5000;
const moves = [], orders = [];
const api = {
  ObjectType: { Building: 2, Infantry: 3, Vehicle: 7, Aircraft: 1 },
  ZoneType: { Ground: 0, Air: 1 },
  QueueType: { Structures: 0, Armory: 1, Infantry: 2, Vehicles: 3, Aircrafts: 4, Ships: 5 },
  OrderType: { Move: 0, Attack: 2, Guard: 5, Capture: 7, Occupy: 8, DeploySelected: 10, Stop: 11, Repair: 15 },
  ArmorType: { 0: 'None', 5: 'Heavy', 8: 'Concrete' },
  me: () => ({ credits: 1000, power: { total: 500, drain: 100 } }),
  units: (r) => (r === 'self' ? own : r === 'hostile' ? enemies : []),
  unit: (id) => own.find((u) => u.id === id),
  crates: () => [], move: (ids, x, y) => moves.push({ ids, x, y }), tick: () => tick, time: () => 20,
  map: { size: () => ({ width: 60, height: 60 }), visible: () => true, tile: (x, y) => ({ rx: x, ry: y, landType: 0 }) },
  production: { queues: () => Array.from({ length: 6 }, (_, type) => ({ type, size: 0, maxSize: 99, items: [] })), available: () => [] },
  canPlace: () => true, order: (ids, type, target) => orders.push({ ids, type, target }), inRange: () => true, deploy: () => true,
};
const memory = {};
const run = () => {
  const snapshot = { raw: { units: own, buildings: own.filter((u) => u.type === 2), army: [], enemies, base: { name: 'YARD', tile: yard.tile } },
    state: { self: { credits: 1000 }, harvesters: 1, economy: { factories: 1 }, airThreatCount: 0, nearbyEnemyCount: enemies.length, baseUnderAttack: false } };
  const groups = {};
  specialGroups(api, catalog, snapshot, memory, groups);
  return groups;
};

{
  own = [yard, unit(50, 'ENG', 3, 40, 40), unit(60, 'MTNK', 7, 22, 22)];
  enemies = [unit(900, 'IVAN', 3, 24, 24)];
  tick = 5000; memory.ivanGuardAt = new Map(); moves.length = 0; orders.length = 0;
  const action = run().salvage?.actions?.defuse_guard_50;
  assert.ok(action, 'a visible Ivan puts an idle engineer on guard duty over the units it would tag');
  assert.equal(action.engineOwned, true, 'the engine does it itself; the bomb has a timer');
  assert.equal(action.threatId, 900);

  // 20 tiles away: walk first. Guard stops a unit where it stands, so guarding from across the map parks the
  // engineer on empty ground and clears nothing.
  assert.equal(executeSpecial(api, action).accepted, true);
  assert.equal(orders.length, 0, 'no Guard order is issued from 20 tiles away');
  assert.deepEqual(moves.at(-1).ids, [50]);

  // On arrival the Guard order is the one that actually clears the bombs.
  own[1] = unit(50, 'ENG', 3, 24, 24);
  assert.equal(executeSpecial(api, action).accepted, true);
  assert.deepEqual(orders.at(-1), { ids: [50], type: 5, target: undefined }, 'arrived: Guard, the game G key');
}

{
  // A dead engineer means no option at all.
  own = [yard, unit(60, 'MTNK', 7, 22, 22)];
  enemies = [unit(900, 'IVAN', 3, 24, 24)];
  tick = 9000; memory.ivanGuardAt = new Map();
  assert.equal(run().salvage?.actions?.defuse_guard_50, undefined, 'no engineer, no guard duty');
}

{
  // The cooldown: one engineer is not re-ordered every turn while the Ivan sits in sight.
  own = [yard, unit(50, 'ENG', 3, 24, 24)];
  enemies = [unit(900, 'IVAN', 3, 24, 24)];
  tick = 9000; memory.ivanGuardAt = new Map();
  assert.ok(run().salvage?.actions?.defuse_guard_50, 'the first order goes out');
  assert.equal(run().salvage?.actions?.defuse_guard_50, undefined, 'and not again on the next turn');
}

console.log('Crazy Ivan: a visible Ivan puts an idle engineer on Guard, walking first, and the guard order is what clears the bombs');
