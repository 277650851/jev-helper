import assert from 'node:assert/strict';
import { specialGroups } from '../src/player/werhd-jev-special.mjs';

// An armed IFV's weapon IS its passenger's weapon, so the passenger to load must be the one that can engage
// what is visible. The ranking used to be `effectiveness`, which averages raw damage and never asks whether a
// weapon can fire at a target at all -- so an anti-air-only passenger scored on damage alone and was loaded
// against a tank it cannot shoot. `counterValue` applies `canEngageTarget`, which is what every other
// adaptation decision uses.

const row = (v, over = {}) => Object.fromEntries(Array.from({ length: 11 }, (_, i) => [i, over[i] ?? v]));
// Armour index 5 is `heavy`. The enemy tank carries it.
const ARMOR_HEAVY = 5;
const catalog = {
  YARD: { yard: true, factory: 'BuildingType', label: 'Yard', armor: 'concrete' },
  // The gunner IFV: no weapon of its own worth counting, one passenger seat.
  IFV: {
    label: 'IFV', cost: 600, armor: 'light', factory: 'UnitType', category: 'AFV', gunner: true, sizeLimit: 1,
    speed: 6, transport: { capacity: 1 },
    weapon: { damage: 10, rof: 30, range: 4, ag: true, aa: false, versus: row(0.25) },
  },
  // 2% against heavy: `canEngageTarget` refuses it (percent verses require > 2) while the raw damage
  // makes `effectiveness` prefer it. Index 0 carries 25, so the row is read as percentages.
  FLAK: { label: 'Flak Trooper', cost: 300, armor: 'none', factory: 'InfantryType', speed: 4, size: 1, weapon: { damage: 4000, rof: 20, range: 5, ag: true, aa: true, versus: row(25, { 5: 2 }) } },
  // Can hurt armour, lower damage.
  GGI: { label: 'Guardian GI', cost: 300, armor: 'none', factory: 'InfantryType', speed: 4, size: 1, weapon: { damage: 40, rof: 20, range: 4, ag: true, aa: false, versus: row(25) } },
  HTNK: { label: 'Rhino', armor: 'heavy', category: 'AFV', weapon: { damage: 90, rof: 65, range: 5.75, ag: true, versus: row(25) } },
};

const own = [
  { id: 1, name: 'YARD', kind: 'YARD', type: 2, tile: { rx: 20, ry: 20 }, hitPoints: 1000, maxHitPoints: 1000 },
  { id: 2, name: 'IFV', kind: 'IFV', type: 7, tile: { rx: 22, ry: 20 }, hitPoints: 200, maxHitPoints: 200, isIdle: true, transport: { occupied: 0, capacity: 1 } },
  { id: 3, name: 'FLAK', kind: 'FLAK', type: 3, tile: { rx: 21, ry: 21 }, hitPoints: 100, maxHitPoints: 100, isIdle: true, primaryWeapon: catalog.FLAK.weapon },
  { id: 4, name: 'GGI', kind: 'GGI', type: 3, tile: { rx: 23, ry: 21 }, hitPoints: 100, maxHitPoints: 100, isIdle: true, primaryWeapon: catalog.GGI.weapon },
];
const enemy = { id: 900, name: 'HTNK', kind: 'HTNK', type: 7, tile: { rx: 26, ry: 20 }, hitPoints: 400, maxHitPoints: 400, zone: 0, armor: ARMOR_HEAVY, primaryWeapon: catalog.HTNK.weapon };
const base = { name: 'YARD', tile: { rx: 20, ry: 20 } };

const api = {
  ObjectType: { Building: 2, Infantry: 3, Vehicle: 7, Aircraft: 1 },
  ZoneType: { Ground: 0, Air: 1 },
  QueueType: { Structures: 0, Armory: 1, Infantry: 2, Vehicles: 3, Aircrafts: 4, Ships: 5 },
  OrderType: { Move: 0, Attack: 2, ForceAttack: 3, Occupy: 8, DeploySelected: 10, Stop: 11, Repair: 15, EnterTransport: 17 },
  ArmorType: { 0: 'None', 5: 'Heavy', 8: 'Concrete' },
  me: () => ({ credits: 5000, power: { total: 500, drain: 100 } }),
  units: () => own, unit: (id) => own.find((u) => u.id === id),
  tick: () => 100, time: () => 3,
  map: { size: () => ({ width: 60, height: 60 }), visible: () => true, tile: (x, y) => (x >= 0 && y >= 0 && x < 60 && y < 60 ? { rx: x, ry: y, landType: 0 } : undefined) },
  production: { queues: () => Array.from({ length: 6 }, (_, type) => ({ type, size: 0, maxSize: 99, items: [] })), available: () => [] },
  canPlace: () => true, order: () => {}, inRange: () => true, crates: () => [],
  distance: (a, b) => Math.hypot(a.rx - b.rx, a.ry - b.ry),
};

const snapshot = {
  raw: { units: own, buildings: [own[0]], army: [own[1]], enemies: [enemy], base },
  state: { self: { credits: 5000 }, harvesters: 2, economy: { factories: 1 }, airThreatCount: 0, nearbyEnemyCount: 1, baseUnderAttack: false },
};
const groups = {};
const memory = {};
specialGroups(api, catalog, snapshot, memory, groups);

const loads = Object.values(groups).flatMap((g) => Object.values(g.actions)).filter((a) => a?.kind === 'load');
assert.equal(loads.length, 1, 'the gunner IFV is crewed');
assert.deepEqual(loads[0].ids, [4], 'the passenger is the one that can engage the visible armour, not the one with the most damage');
console.log('IFV crew: the passenger is ranked by what it can engage, not by raw damage');
