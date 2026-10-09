import assert from 'node:assert/strict';
import { collectState, candidateGroups } from '../src/player/werhd-jev-player.mjs';

// Adaptive countering has to reach every group that offers a unit, not just the vehicles one. The infantry
// question is the clearest case: its role scores are ABSTRACT -- anti-infantry and anti-armour measured
// against sample armour -- and they are never zero. A rifleman therefore carried a healthy anti-infantry
// figure into an air raid it cannot touch, and nothing in the question said so. The visible-enemy effect
// is now part of the option text, so an all-air force makes every non-anti-air option read zero.

const catalog = {
  YARD: { yard: true, factory: 'BuildingType', cost: 2500 },
  POWER: { power: 200, cost: 800, factory: 'BuildingType' },
  REF: { refinery: true, cost: 2000, factory: 'BuildingType' },
  MINER: { harvester: true, cost: 1400 },
  BARRACKS: { factory: 'InfantryType', cost: 500 },
  // Our infantry: a rifleman with no anti-air, and a rocket soldier that has it.
  E1: { cost: 100, label: 'GI', armor: 'none', factory: 'InfantryType', speed: 4, techLevel: 1, weapon: { damage: 15, rof: 20, range: 4, ag: true, aa: false, verses: [100, 80, 70, 50, 25, 25, 75, 50, 25, 100, 100] } },
  E2AA: { cost: 300, label: 'Flak Trooper', armor: 'none', factory: 'InfantryType', speed: 4, techLevel: 2, weapon: { damage: 20, rof: 20, range: 4, ag: true, aa: true, verses: [100, 80, 70, 50, 25, 25, 75, 50, 25, 100, 100] } },
  ZEP: { aircraft: true, cost: 2000, label: 'Kirov', armor: 'light', weapon: { damage: 200, rof: 80, range: 3, ag: true, aa: false, verses: [100, 90, 80, 70, 65, 45, 75, 40, 20, 80, 100] } },
  HTNK: { category: 'AFV', cost: 900, label: 'Rhino', armor: 'heavy', weapon: { damage: 90, rof: 65, range: 5.75, ag: true, aa: false, verses: [25, 25, 25, 75, 100, 100, 65, 45, 60, 60, 100] } },
};
const u = (id, name, type, x, y, extra = {}) => ({ id, name, type, tile: { rx: x, ry: y }, hitPoints: 100, maxHitPoints: 100, isIdle: true, primaryWeapon: catalog[name]?.weapon, ...extra });
const own = [u(1, 'YARD', 2, 30, 30), u(2, 'POWER', 2, 26, 30), u(3, 'REF', 2, 30, 35), u(4, 'BARRACKS', 2, 32, 30), u(5, 'MINER', 7, 28, 32)];
let enemies = [];
const api = {
  units: (r) => (r === 'self' ? own : r === 'hostile' || r === 'enemy' ? enemies : []),
  me: () => ({ credits: 5000, power: { total: 300, drain: 100 } }),
  tick: () => 3000, time: () => 200,
  ObjectType: { Building: 2, Infantry: 3, Vehicle: 7, Aircraft: 1 },
  QueueType: { Structures: 0, Armory: 1, Infantry: 2, Vehicles: 3, Aircrafts: 4, Ships: 5 },
  ZoneType: { Ground: 0, Air: 1 },
  ArmorType: { 0: 'None', 3: 'Light', 5: 'Heavy', 8: 'Concrete' },
  map: { size: () => ({ width: 60, height: 60 }), visible: () => true, tile: (x, y) => (x >= 0 && y >= 0 && x < 60 && y < 60 ? { rx: x, ry: y, landType: 0 } : undefined) },
  canPlace: () => true, order: () => {}, crates: () => [],
  production: {
    queues: () => Array.from({ length: 6 }, (_, type) => ({ type, size: 0, maxSize: 99, items: [] })),
    available: (q) => (q === 2 ? ['E1', 'E2AA'] : []).map((name) => ({ name, type: 3 })),
  },
};

const crit = (groups, key) => groups.infantry.criteria[key] ?? '';
const effect = (text) => Number((/Effect against the \d+ enemy units now visible ([\d.]+)/.exec(text) ?? [])[1]);

// 1. An all-air enemy makes the ground-only rifleman read zero, and the text says why.
enemies = [u(100, 'ZEP', 1, 42, 30, { zone: 1 }), u(101, 'ZEP', 1, 43, 30, { zone: 1 })];
let groups = candidateGroups(api, catalog, collectState(api, catalog), {});
assert.equal(effect(crit(groups, 'produce_E1')), 0, 'a rifleman cannot engage aircraft');
assert.match(crit(groups, 'produce_E1'), /cannot engage them/, 'and the option says so rather than implying it works');
assert.ok(effect(crit(groups, 'produce_E2AA')) > 0, 'the rocket soldier can, and shows a real figure');

// 2. Against ground armour the same rifleman is no longer zero -- the number follows the enemy, which is
//    the whole point: the same option text differs between the two states.
enemies = [u(110, 'HTNK', 7, 42, 30), u(111, 'HTNK', 7, 43, 30)];
groups = candidateGroups(api, catalog, collectState(api, catalog), {});
assert.ok(effect(crit(groups, 'produce_E1')) > 0, 'small arms do hurt heavy armour, if little');
assert.doesNotMatch(crit(groups, 'produce_E1'), /cannot engage them/);
const rifleVsArmour = effect(crit(groups, 'produce_E1'));
const rocketVsArmour = effect(crit(groups, 'produce_E2AA'));
assert.ok(rocketVsArmour > rifleVsArmour, `the rocket soldier out-scores the rifleman against armour (${rocketVsArmour} vs ${rifleVsArmour})`);

// 3. With nobody visible there is no such claim: the abstract role scores stay, and no visible-effect
//    sentence is invented for an enemy that is not there.
enemies = [];
groups = candidateGroups(api, catalog, collectState(api, catalog), {});
assert.doesNotMatch(crit(groups, 'produce_E1'), /Effect against the/, 'no visible enemy, no visible-effect claim');
assert.match(crit(groups, 'produce_E1'), /anti-infantry score/, 'the abstract role scores remain');
console.log('Infantry options: the effect against the visible enemy is stated, and is zero for what cannot engage it');
