import assert from 'node:assert/strict';
import { candidateGroups } from '../src/player/werhd-jev-player.mjs';
import { collectState } from '../src/player/werhd-jev-player.mjs';
import { refreshCatalog } from '../src/player/werhd-jev-catalog.mjs';

// Laya answers "wait" almost regardless of what it is told. Measured against the running local
// service on one real construction question from jev-report-20261009-055438:
//
//   unchanged                                   -> wait 0.65
//   option order reversed                       -> wait 0.94   (worse)
//   instructions rewritten as a direct command  -> wait 0.89   (worse)
//   instructions AND option text emptied        -> wait 0.98
//   wait text replaced by an explicit "do not"  -> build 0.55
//   five synonyms of wait added as decoys       -> wait 0.71, and it picked the one named `wait`
//
// Greedy decoding makes it deterministic (five identical requests, five identical answers), so this
// is a stable property of the checkpoint, not sampling noise: the model has a near-constant prior
// toward the option named `wait` and does not read the state for this question shape. Across the 86
// real "build the refinery vs wait" questions in that match it answered wait 83 times.
//
// Rewriting prompts therefore cannot fix this. The only lever that does not depend on the model at
// all is to not ask it: both preconditions here are checked by the engine a few lines above the
// `auto`, so the answer is already known. These tests pin that the opening plan is marked for
// automatic execution instead of being left to a choice the model cannot make.

const catalog = {
  CAHAND: { yard: true, label: 'Construction Yard', cost: 2500, power: 0 },
  CAPOWR: { label: 'Power Plant', cost: 200, power: 100, buildCategory: 'Power' },
  CAREFN: { refinery: true, label: 'Ore Refinery', cost: 2000, power: 0 },
  GAPILE: { label: 'Barracks', cost: 500, power: 0, factory: 'InfantryType' },
  CAWEAP: { factory: 'UnitType', label: 'War Factory', cost: 2000, power: -25, buildCategory: 'Tech' },
  PLA: { label: 'Conscript', cost: 100, weapon: { damage: 30, ag: true, range: 2 } },
  CMIN: { harvester: true, label: 'Chrono Miner', cost: 1400, weapon: { damage: 0, range: 0 } },
};

const tick = { value: 1000 };
const b = (id, name, x, y) => ({ id, name, type: 2, tile: { rx: x, ry: y }, hitPoints: 1000, maxHitPoints: 1000 });
const v = (id, name, x, y) => ({ id, name, type: 7, tile: { rx: x, ry: y }, hitPoints: 100, maxHitPoints: 100, primaryWeapon: { damage: 100, ag: true, range: 5 } });

function world(buildings) {
  tick.value = 1000;
  const units = buildings;
  const own = units.map(u => u.name);
  const api = {
    tick: () => tick.value,
    time: () => 60,
    me: () => ({ combatant: true, isObserver: false, defeated: false, credits: 5000 }),
    units: (rel) => rel === 'self' ? units : rel === 'hostile' ? [] : [],
    unit: (id) => units.find(u => u.id === id),
    rules: () => undefined,
    crates: () => [],
    order: () => true, canPlace: () => true, sell: () => {}, move: () => {}, gather: () => {},
    ObjectType: { Aircraft: 1, Building: 2, Infantry: 3, Vehicle: 7 },
    ArmorType: {}, FactoryType: {}, BuildCat: {}, QueueType: { Structures: 0, Armory: 1, Infantry: 2, Vehicles: 3, Aircrafts: 4, Ships: 5 },
    ZoneType: { Air: 1 }, LandType: { Water: 7 }, OrderType: {},
    map: { size: () => ({ width: 64, height: 64 }), visible: () => false, tile: () => undefined },
    production: {
      queues: () => Array.from({ length: 6 }, (_, type) => ({ type, size: 0, maxSize: 10, items: [] })),
      available: (q) => q === 0 ? ['CAPOWR', 'CAREFN', 'GAPILE', 'CAWEAP'].map(n => ({ n, name: n, type: 2 }))
        : q === 3 ? ['CMIN', 'PLA'].map(n => ({ n, name: n, type: 7 })) : [],
    },
  };
  const cat = refreshCatalog(api, {});
  for (const k of Object.keys(catalog)) cat[k] ??= catalog[k];
  const snap = collectState(api, cat);
  return { api, cat, snap, groups: candidateGroups(api, cat, snap, {}) };
}

const opening = (buildings) => {
  const { groups } = world(buildings);

  return Object.entries(groups.construction?.actions ?? {})
    .filter(([k]) => k !== 'wait')
    .map(([k, a]) => [k, a]);
};

// Power first, and it must not wait for a vote.
{
  const offers = opening([b(1, 'CAHAND', 20, 20)]);
  assert.equal(offers.length, 1, `exactly one opening step should be offered; got ${offers.map(o => o[0])}`);
  const [key, action] = offers[0];
  assert.equal(key, 'produce_CAPOWR');
  assert.equal(action.auto, 1,
    'the opening step is already justified by the engine (idle queue, credits checked) and must be '
    + `automatic after one decline; got auto=${action.auto}`);
}

// The opening order itself is the engine's and is covered elsewhere; what these tests pin is that
// whichever link it lands on is automatic. This match stalled at the refinery link for 36 turns.
{
  let offered = 0;
  for (const owned of [
    [b(1, 'CAHAND', 20, 20)],
    [b(1, 'CAHAND', 20, 20), b(2, 'CAPOWR', 22, 20)],
    [b(1, 'CAHAND', 20, 20), b(2, 'CAPOWR', 22, 20), b(3, 'GAPILE', 24, 20)],
    [b(1, 'CAHAND', 20, 20), b(2, 'CAPOWR', 22, 20), b(3, 'GAPILE', 24, 20), b(4, 'CAREFN', 26, 20)],
    [b(1, 'CAHAND', 20, 20), b(2, 'CAPOWR', 22, 20), b(3, 'GAPILE', 24, 20), b(4, 'CAREFN', 26, 20), b(5, 'CAWEAP', 28, 20)],
    [b(1, 'CAHAND', 20, 20), b(2, 'CAPOWR', 22, 20), b(3, 'CAREFN', 24, 20)],
  ]) {
    for (const [key, action] of opening(owned)) {
      offered++;
      assert.equal(action.type, 'produce', `${key} is a build order`);
      assert.equal(action.auto, 1,
        `${key} is the engine's own next build step -- the queue was idle and the credits were checked `
        + `three lines above -- so it must be automatic after one decline; got auto=${action.auto}`);
    }
  }
  assert.ok(offered >= 2, `the opening plan must actually offer steps to check; saw ${offered}`);
}

console.log('Opening plan: the engine-decided build step is automatic, not a question for the model — passed');
