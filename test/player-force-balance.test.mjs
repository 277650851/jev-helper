import assert from 'node:assert/strict';
import { counterAverage, assessStrategy } from '../src/player/werhd-jev-strategy.mjs';

// Force balance is what decides `suppressed`, and `suppressed` is what tells the engine it is losing the local
// fight. Both sides were summed with `effectiveness`, which averages raw damage over the target list and never
// asks whether a weapon can fire at a target -- so a defender that cannot touch a single one of the threats
// still counted as a full contributor and hid the loss.

const row = (v, over = {}) => Object.fromEntries(Array.from({ length: 11 }, (_, i) => [i, over[i] ?? v]));
const HEAVY = 5;

// Index 5 carries 2%. Percent verses require > 2 to count as "can engage", so this weapon cannot hurt a heavy
// target at all -- yet `effectiveness` still returns damage x 0.02 > 0.
const CANNOT_HURT_HEAVY = { damage: 1000, rof: 40, range: 6, ag: true, aa: true, versus: row(25, { 5: 2 }) };
const CAN_HURT_HEAVY = { damage: 40, rof: 20, range: 5, ag: true, versus: row(25) };

const catalog = {
  USELESS: { label: 'AA only', armor: 'none', factory: 'InfantryType', weapon: CANNOT_HURT_HEAVY },
  USEFUL: { label: 'GI', armor: 'none', factory: 'InfantryType', weapon: CAN_HURT_HEAVY },
  HTNK: { label: 'Rhino', armor: 'heavy', category: 'AFV', weapon: { damage: 90, rof: 65, range: 5.75, ag: true, versus: row(25) } },
  YARD: { yard: true, factory: 'BuildingType', label: 'Yard', armor: 'concrete' },
};

const unit = (id, name, x, y) => ({ id, name, kind: name, type: 3, tile: { rx: x, ry: y }, hitPoints: 100, maxHitPoints: 100, armor: name === 'HTNK' ? HEAVY : 0, primaryWeapon: catalog[name].weapon });
const tank = (id, x, y) => ({ ...unit(id, 'HTNK', x, y), type: 7 });

// 1. The helper itself: an ungated average counts a unit that cannot engage, `counterAverage` does not.
{
  const threats = [tank(900, 24, 20), tank(901, 25, 21), tank(902, 24, 22)];
  assert.ok(counterAverage(catalog.USELESS, threats, catalog, { ObjectType: { Infantry: 3, Vehicle: 7 }, ZoneType: { Ground: 0, Air: 1 } }) === 0,
    'a weapon that cannot hurt any threat contributes nothing');
  assert.ok(counterAverage(catalog.USEFUL, threats, catalog, { ObjectType: { Infantry: 3, Vehicle: 7 }, ZoneType: { Ground: 0, Air: 1 } }) > 0,
    'and one that can still contributes');
  // An empty list keeps its old meaning rather than becoming zero.
  assert.ok(counterAverage(catalog.USEFUL, [], catalog, { ObjectType: { Infantry: 3, Vehicle: 7 }, ZoneType: { Ground: 0, Air: 1 } }) > 0);
}

// 2. End to end: the balance that decides `suppressed`.
{
  const api = {
    ObjectType: { Building: 2, Infantry: 3, Vehicle: 7, Aircraft: 1 },
    ZoneType: { Ground: 0, Air: 1 },
    QueueType: { Structures: 0, Armory: 1, Infantry: 2, Vehicles: 3, Aircrafts: 4, Ships: 5 },
    ArmorType: { 0: 'None', 5: 'Heavy', 8: 'Concrete' },
    me: () => ({ credits: 1000 }), units: () => [], unit: (id) => undefined,
    tick: () => 1000, time: () => 20,
    map: { size: () => ({ width: 60, height: 60 }), visible: () => true, tile: (x, y) => ({ rx: x, ry: y, landType: 0 }) },
    production: { queues: () => Array.from({ length: 6 }, (_, type) => ({ type, size: 0, maxSize: 99, items: [] })), available: () => [] },
    canPlace: () => true, order: () => {}, inRange: () => true,
  };
  const own = [unit(1, 'YARD', 20, 20), unit(2, 'USELESS', 21, 21), unit(3, 'USELESS', 22, 21), unit(4, 'USELESS', 21, 22)];
  own[0].type = 2;
  const enemies = [tank(900, 24, 20), tank(901, 25, 21), tank(902, 24, 22)];
  const snapshot = { raw: { units: own, buildings: [own[0]], army: own.slice(1), enemies, base: { name: 'YARD', tile: { rx: 20, ry: 20 } } },
    state: { self: { credits: 1000 }, harvesters: 0, economy: {}, airThreatCount: 0, nearbyEnemyCount: 3, baseUnderAttack: false } };
  const memory = {};
  assessStrategy(api, catalog, snapshot, memory);
  // `assessStrategy` writes onto the snapshot's state rather than returning it.
  const state = snapshot.state.strategy;
  assert.equal(state.localStrengthEstimate, 0, 'four defenders that cannot hurt a heavy tank are worth nothing locally');
  assert.ok(state.enemyStrengthEstimate > 0, 'while the enemy can hurt them');
  assert.equal(state.suppressed, true, 'so the engine reports that it is losing the local fight');
}
console.log('Force balance: only defenders that can engage the threat count toward local strength');
