import test from 'node:test';
import assert from 'node:assert/strict';
import { specialGroups, TANYA_COOLDOWN } from '../src/player/werhd-jev-special.mjs';
import { unitPurpose } from '../src/unit-role.mjs';

// Tanya is the other half of the Ivan problem and takes a different answer: an engineer on Guard clears a
// bomb, but nothing an engineer can do stops a hero who kills infantry outright. She has to be killed, and the
// cheap unit that does that is a dog (200 credits, one-shots infantry). "Send a tank" is not the answer
// either -- `[TANY]` in rules(规则文件).ini is `Crushable=no` and `Armor=flak`, so a tank neither drives over
// her nor is immune to her pistols; a gun that reaches her still works, which is what `canUnitHurt` decides.
const catalog = {
  YARD: { yard: true, factory: 'BuildingType', label: 'Yard', armor: 'concrete' },
  ADOG: { label: 'Attack Dog', attackDog: true, armor: 'none', category: 'Soldier', cost: 200, weapon: { damage: 100, rof: 30, range: 1.5, ag: true, versus: [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0] } },
  ENG: { label: 'Engineer', engineer: true, armor: 'none', cost: 500 },
  MTNK: { label: 'Grizzly', armor: 'heavy', category: 'AFV', cost: 750, weapon: { damage: 65, rof: 60, range: 5, ag: true, versus: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1] } },
  TANY: { label: 'Tanya', armor: 'flak', category: 'Soldier', cost: 1400, weapon: { damage: 125, rof: 20, range: 4, ag: true, versus: [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0] } },
};
const unit = (id, name, type, x, y, extra = {}) => ({ id, name, type, tile: { rx: x, ry: y }, hitPoints: 200, maxHitPoints: 200, isIdle: true, primaryWeapon: catalog[name]?.weapon, ...extra });
const yard = unit(1, 'YARD', 2, 20, 20);
let own = [], enemies = [], tick = 5000;
const orders = [];
const api = {
  ObjectType: { Building: 2, Infantry: 3, Vehicle: 7, Aircraft: 1 },
  ZoneType: { Ground: 0, Air: 1 },
  QueueType: { Structures: 0, Armory: 1, Infantry: 2, Vehicles: 3, Aircrafts: 4, Ships: 5 },
  OrderType: { Move: 0, Attack: 2, Guard: 5, Capture: 7, Occupy: 8, Repair: 15 },
  ArmorType: { 0: 'None', 1: 'Flak', 5: 'Heavy', 8: 'Concrete' },
  me: () => ({ credits: 1000, power: { total: 500, drain: 100 } }),
  units: (r) => (r === 'self' ? own : r === 'hostile' ? enemies : []),
  unit: (id) => [...own, ...enemies].find((u) => u.id === id),
  crates: () => [], move: () => {}, tick: () => tick, time: () => 20,
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

test('a visible Tanya draws a dog at her, ahead of a closer tank', () => {
  own = [yard, unit(50, 'ADOG', 3, 40, 40), unit(60, 'MTNK', 7, 22, 22)];
  enemies = [unit(900, 'TANY', 3, 24, 24)];
  tick = 5000; memory.tanyaAt = new Map(); orders.length = 0;
  const action = run().salvage?.actions?.tanya_900;
  assert.ok(action, 'the hero puts a killer on her');
  assert.deepEqual(action.ids, [50], 'the dog goes, not the tank standing two tiles away');
  assert.equal(action.targetId, 900);
  assert.equal(action.threatId, 900);
  assert.deepEqual(action.order, { type: 2, target: { objectId: 900 } });
  // Instant, like the Ivan guard: a hero walking toward a building is not a question worth a round trip.
  assert.equal(action.engineOwned, true);
  assert.match(run().salvage.criteria.tanya_900, /Crushable=no/);
});

test('with no dog, the nearest unit that can actually hurt her goes', () => {
  own = [yard, unit(60, 'MTNK', 7, 26, 26), unit(61, 'ENG', 3, 21, 21)];
  enemies = [unit(900, 'TANY', 3, 24, 24)];
  tick = 9000; memory.tanyaAt = new Map();
  const action = run().salvage?.actions?.tanya_900;
  assert.ok(action, 'a gun that reaches her is enough');
  assert.deepEqual(action.ids, [60], 'the tank, not the engineer beside her');
});

test('an engineer alone cannot answer a hero, and nothing is offered', () => {
  own = [yard, unit(61, 'ENG', 3, 21, 21)];
  enemies = [unit(900, 'TANY', 3, 24, 24)];
  tick = 9000; memory.tanyaAt = new Map();
  const actions = run().salvage?.actions ?? {};
  assert.equal(actions.tanya_900, undefined, 'no weapon, no option');
});

test('the cooldown keeps one killer from being re-ordered every turn', () => {
  own = [yard, unit(50, 'ADOG', 3, 40, 40)];
  enemies = [unit(900, 'TANY', 3, 24, 24)];
  tick = 9000; memory.tanyaAt = new Map();
  assert.ok(run().salvage?.actions?.tanya_900, 'the first order goes out');
  assert.equal(run().salvage?.actions?.tanya_900, undefined, 'and not again on the next turn');
  tick = 9000 + TANYA_COOLDOWN + 1;
  assert.ok(run().salvage?.actions?.tanya_900, 'but it is tried again once the window passes');
});

test('the dictionary spelling TANYA is matched too, because the purpose table was keyed on it', () => {
  own = [yard, unit(50, 'ADOG', 3, 40, 40)];
  enemies = [unit(900, 'TANYA', 3, 24, 24)];
  tick = 12000; memory.tanyaAt = new Map();
  assert.ok(run().salvage?.actions?.tanya_900, 'a unit named TANYA is the same hero');
});

test('the purpose table now answers for the id the game actually uses', () => {
  // `[TANY]` is the section in rules(规则文件).ini and `TANYA` is the dictionary ID that is not a section at
  // all (docs/ra2-unit-catalog.md line 24). The row was keyed on TANYA, so the model was never told what the
  // Allied hero does -- a gap, and this is the line that closes it.
  assert.match(unitPurpose('TANY') ?? '', /hero/);
  assert.match(unitPurpose('TANY') ?? '', /C4/);
  assert.equal(unitPurpose('TANY'), unitPurpose('TANYA'), 'both spellings give the same line');
});
