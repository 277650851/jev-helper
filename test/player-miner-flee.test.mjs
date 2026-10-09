import assert from 'node:assert/strict';
import { specialGroups, executeSpecial, MINER_FLEE_RADIUS, MINER_FLEE_COOLDOWN } from '../src/player/werhd-jev-special.mjs';
import { askableGroups, requestGroupsFrom, engineOwnedMarks, collectTakeovers } from '../src/player/werhd-jev-player.mjs';

// The harvester is the whole income. `baseThreats` already counts one near the base as core infrastructure
// worth defending -- but nothing ever moved one out of the way, so it stood in the open and died while the
// engine was busy defending it. The option is `engineOwned`: the engine issues the move itself, because a
// model answer arriving seconds later is worth nothing to a unit dying now.

const row = (v, over = {}) => Object.fromEntries(Array.from({ length: 11 }, (_, i) => [i, over[i] ?? v]));
const HEAVY = 5;
// Armour index 5 carries 2%. Percent verses require > 2 to count as "can engage", so this cannot hurt a
// heavy target at all -- while a plain damage comparison would still say it is armed.
const CANNOT_HURT_HEAVY = { damage: 900, rof: 40, range: 6, ag: true, versus: row(25, { 5: 2 }) };
const CAN_HURT_HEAVY = { damage: 90, rof: 65, range: 5.75, ag: true, versus: row(25) };

const catalog = {
  YARD: { yard: true, factory: 'BuildingType', label: 'Yard', armor: 'concrete' },
  CMIN: { label: 'Chrono Miner', harvester: true, armor: 'heavy', cost: 1400, speed: 4 },
  HTNK: { label: 'Rhino', armor: 'heavy', category: 'AFV', weapon: CAN_HURT_HEAVY },
  WEAK: { label: 'Peashooter', armor: 'heavy', category: 'AFV', weapon: CANNOT_HURT_HEAVY },
};

const miner = (id, rx, ry) => ({ id, name: 'CMIN', kind: 'CMIN', type: 7, tile: { rx, ry }, hitPoints: 1000, maxHitPoints: 1000, isIdle: true });
const enemyAt = (id, name, rx, ry) => ({ id, name, kind: name, type: 7, tile: { rx, ry }, hitPoints: 400, maxHitPoints: 400, armor: HEAVY, primaryWeapon: catalog[name].weapon });
const moves = [];
let tick = 5000;
const api = {
  ObjectType: { Building: 2, Infantry: 3, Vehicle: 7, Aircraft: 1 },
  ZoneType: { Ground: 0, Air: 1 },
  QueueType: { Structures: 0, Armory: 1, Infantry: 2, Vehicles: 3, Aircrafts: 4, Ships: 5 },
  OrderType: { Move: 0, Attack: 2, ForceAttack: 3, Occupy: 8, DeploySelected: 10, Stop: 11, Repair: 15, EnterTransport: 17 },
  ArmorType: { 0: 'None', 5: 'Heavy', 8: 'Concrete' },
  me: () => ({ credits: 1000, power: { total: 500, drain: 100 } }),
  units: (r) => (r === 'self' ? own : r === 'hostile' ? enemies : []),
  unit: (id) => own.find((u) => u.id === id),
  crates: () => [], move: (ids, x, y) => moves.push({ ids, x, y }), tick: () => tick, time: () => 20,
  map: { size: () => ({ width: 60, height: 60 }), visible: () => true, tile: (x, y) => ({ rx: x, ry: y, landType: 0 }) },
  production: { queues: () => Array.from({ length: 6 }, (_, type) => ({ type, size: 0, maxSize: 99, items: [] })), available: () => [] },
  canPlace: () => true, order: () => true, inRange: () => true, deploy: () => true,
};
let own = []; let enemies = [];
const memory = {};
const run = () => {
  const snapshot = { raw: { units: own, buildings: own.filter((u) => u.type === 2), army: [], enemies, base: own.find((u) => u.name === 'YARD') ? { name: 'YARD', tile: own.find((u) => u.name === 'YARD').tile } : undefined },
    state: { self: { credits: 1000 }, harvesters: 1, economy: { factories: 1 }, airThreatCount: 0, nearbyEnemyCount: enemies.length, baseUnderAttack: false } };
  const groups = {};
  specialGroups(api, catalog, snapshot, memory, groups);
  return groups;
};
const yard = { id: 1, name: 'YARD', kind: 'YARD', type: 2, tile: { rx: 20, ry: 20 }, hitPoints: 1000, maxHitPoints: 1000 };

// 1. An attacker in reach that can actually hurt the miner makes the engine move it, without asking.
{
  own = [yard, miner(50, 30, 30)];
  enemies = [enemyAt(900, 'HTNK', 30 + MINER_FLEE_RADIUS - 1, 30)];
  tick = 5000; memory.minerFleeAt = new Map();
  const action = run().salvage?.actions?.flee_miner_50;
  assert.ok(action, 'the miner is moved out of reach');
  assert.equal(action.engineOwned, true, 'and the engine does it itself: a late answer is worthless to a dying unit');
  // The invariant that matters, whichever destination was picked: it ends up farther from the attacker.
  const dist = (a, b) => Math.hypot((a.rx ?? a.x) - (b.rx ?? b.x), (a.ry ?? a.y) - (b.ry ?? b.y));
  assert.ok(dist(action.tile, enemies[0].tile) > dist(own[1].tile, enemies[0].tile),
    `it ends up farther from the threat (${action.tile.x},${action.tile.y})`);
  assert.deepEqual([action.tile.x, action.tile.y], [20, 20], 'here the yard is the safer place, so it goes home');
}

// 1b. When the yard is closer to the attacker than the miner is, running home would run toward the enemy, so
//     the miner steps away from the threat on the opposite bearing instead. The enemy has to be AT the yard
//     for that: with the yard far away it is always the safer place.
{
  own = [yard, miner(50, 23, 20)];
  enemies = [enemyAt(900, 'HTNK', 21, 20)];
  tick = 5500; memory.minerFleeAt = new Map();
  const action = run().salvage?.actions?.flee_miner_50;
  assert.ok(action, 'still moved out of reach');
  assert.ok(action.tile.x > 23 && action.tile.y === 20,
    `with the yard beside the enemy it steps away instead (${action.tile.x},${action.tile.y})`);
}

// 2. An attacker whose weapon cannot touch the miner is not a reason to abandon the ore field.
{
  own = [yard, miner(50, 30, 30)];
  enemies = [enemyAt(901, 'WEAK', 31, 30)];
  tick = 6000; memory.minerFleeAt = new Map();
  assert.equal(run().salvage?.actions?.flee_miner_50, undefined, 'a weapon that cannot engage the miner does not scare it off');
}

// 3. An attacker out of reach is not either.
{
  own = [yard, miner(50, 30, 30)];
  enemies = [enemyAt(902, 'HTNK', 30 + MINER_FLEE_RADIUS + 4, 30)];
  tick = 7000; memory.minerFleeAt = new Map();
  assert.equal(run().salvage?.actions?.flee_miner_50, undefined, 'distance matters');
}

// 4. The cooldown keeps it from re-issuing every turn while the miner is walking.
{
  own = [yard, miner(50, 30, 30)];
  enemies = [enemyAt(903, 'HTNK', 31, 30)];
  tick = 8000; memory.minerFleeAt = new Map();
  assert.ok(run().salvage?.actions?.flee_miner_50, 'first turn: ordered');
  tick = 8000 + MINER_FLEE_COOLDOWN - 1;
  assert.equal(run().salvage?.actions?.flee_miner_50, undefined, 'and not again inside the cooldown');
  tick = 8000 + MINER_FLEE_COOLDOWN + 1;
  assert.ok(run().salvage?.actions?.flee_miner_50, 'after it, still under fire, ordered again');
}

// 5. The executor issues the documented `move`, and reports a miner that is already gone.
{
  moves.length = 0;
  const action = { type: 'special', kind: 'flee_miner', ids: [50], tile: { x: 36, y: 30 } };
  assert.equal(executeSpecial(api, action).accepted, true);
  assert.deepEqual(moves, [{ ids: [50], x: 36, y: 30 }]);
  assert.equal(executeSpecial(api, { ...action, ids: [999] }).reason, 'unit_gone');
}
// 6. And the loop it feeds actually acts on it. An option that is offered but never taken is dead code: the
//    takeover pass picks it up only when it is the group's single real choice, which is exactly the case here
//    (no crates, nothing to sell), and `askableGroups` must drop the question rather than ask it.
{
  own = [yard, miner(50, 30, 30)];
  enemies = [enemyAt(904, 'HTNK', 30 + MINER_FLEE_RADIUS - 1, 30)];
  tick = 9000; memory.minerFleeAt = new Map();
  const groups = run();
  const asked = askableGroups(requestGroupsFrom(groups, memory, tick));
  assert.ok(!('salvage' in asked), 'the engine does not ask about an emergency it has already decided');
  const taken = collectTakeovers(groups, null, engineOwnedMarks(groups), memory, tick).filter((x) => !(x.id in asked));
  const flee = taken.find((x) => x.id === 'salvage');
  assert.ok(flee, 'and the takeover pass takes it');
  assert.equal(flee.choice, 'flee_miner_50');
  assert.equal(flee.reason, 'engine_decided');
  assert.equal(flee.action.kind, 'flee_miner', 'so the escape reaches the executor rather than staying an option');
}
console.log('Harvester escape: a miner an attacker can actually hurt is moved out of reach, without a round trip');
