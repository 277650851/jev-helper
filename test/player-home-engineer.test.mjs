import test from 'node:test';
import assert from 'node:assert/strict';
import { specialGroups, executeSpecial, HOME_ENGINEER_RADIUS } from '../src/player/werhd-jev-special.mjs';
import { collectState } from '../src/player/werhd-jev-player.mjs';

// One engineer belongs to the base itself. The capture loop trains engineers for the neutral buildings and
// they walk off and stay there, so a base with a barracks could end a match with nobody to defuse an Ivan's
// bomb, repair a damaged structure or hold a doorway -- and nothing ever asked for a replacement, because the
// demand was sized by the capture targets alone (measured: `produce_ENGINEER` is the largest single source of
// forced questions, docs/jev-autopilot-handoff.md §0.49). The demand now carries that slot whenever the
// barracks stands and nothing is standing within `HOME_ENGINEER_RADIUS` of the base.
//
// What is deliberately absent is an `auto:` of its own: the takeover rules keep the choice with the model
// unless the option is the group's only real choice (review §4), and §0.49 judged this exact option one the
// model keeps. The engine decides it only when a capture target is what asked for it -- the existing
// `auto: 3`, asserted below to be undefined for the defensive slot.
const catalog = {
  YARD: { yard: true, label: 'Construction Yard' },
  BARRACKS: { factory: 'InfantryType', label: 'Barracks', cost: 500 },
  ENG: { engineer: true, cost: 500, label: 'Engineer', armor: 'none' },
  GI: { occupier: true, cost: 200, weapon: { damage: 15, range: 4 }, label: 'GI', armor: 'none' },
  TECH: { techLevel: 2, label: 'Tech Outpost' },
  IVAN: { label: 'Crazy Ivan', armor: 'none', category: 'Soldier', weapon: { damage: 5, rof: 40, range: 3, ag: true, versus: [1, 1, 1, 1, 1, 1] } },
};
const unit = (id, name, type, x, y, extra = {}) => ({ id, name, type, tile: { rx: x, ry: y }, hitPoints: 100, maxHitPoints: 100, isIdle: true, primaryWeapon: catalog[name].weapon, ...extra });
function world({ own, enemies = [], neutral = [], credits = 1000, tick = 3000 }) {
  const calls = [];
  const all = () => [...own, ...enemies, ...neutral];
  const api = {
    ObjectType: { Building: 2, Vehicle: 7, Infantry: 3, Aircraft: 1 },
    QueueType: { Structures: 0, Armory: 1, Infantry: 2, Vehicles: 3, Aircrafts: 4, Ships: 5 },
    OrderType: { Move: 1, Attack: 2, Guard: 5, Capture: 7, Occupy: 8, Repair: 9, DeploySelected: 10, Stop: 11 },
    LandType: { Clear: 0 }, ZoneType: { Air: 1, Water: 2 },
    units: (r) => (r === 'self' ? own : r === 'enemy' ? enemies : r === 'allied' ? [] : [...enemies, ...neutral]),
    unit: (id) => all().find((u) => u.id === id),
    me: () => ({ credits, power: { total: 500, drain: 100 }, combatant: true, defeated: false, isObserver: false }),
    tick: () => tick, time: () => tick / 15, players: () => [],
    map: { size: () => ({ width: 80, height: 80 }), visible: () => true, tile: (x, y) => ({ rx: x, ry: y, landType: 0 }) },
    canPlace: () => true,
    production: { queues: () => Array.from({ length: 6 }, (_, type) => ({ type, size: 0, maxSize: 99, items: [] })), available: (q) => (q === undefined || q === 2 ? [{ name: 'ENG', type: 3 }] : []) },
    weaponVs: () => undefined, inRange: () => false, attack: (...a) => calls.push(['attack', ...a]),
    move: (...a) => calls.push(['move', ...a]), attackMove: (...a) => calls.push(['attackMove', ...a]), deploy: () => true,
    order: (ids, o, target) => { calls.push(['order', ids, o, target]); return true; },
    produce: (...a) => calls.push(['produce', ...a]), gather() {}, repair() {},
    onTick: (h) => { api._tick = h; }, offTick() {},
  };
  const memory = { frontiers: new Map(), enemyBuildings: new Map(), orders: new Map(), postureOrders: new Map(), specialOrders: new Map(), specialTargets: new Map(), plannedSites: new Map(), observedSpecial: new Map(), repairing: new Set(), lastMaintenance: tick, lastMicroReport: -1000 };
  return { api, memory, calls };
}
const groupsOf = (w) => { const groups = {}; specialGroups(w.api, catalog, collectState(w.api, catalog), w.memory, groups); return groups; };
// The base is the construction yard at (10,10); the barracks is what makes training an engineer possible.
const home = () => [unit(1, 'YARD', 2, 10, 10), unit(2, 'BARRACKS', 2, 12, 10)];
const tech = () => unit(100, 'TECH', 2, 70, 70);

test('a barracks whose only engineer is away trains a second one, and the engine does not decide it', () => {
  // (60,60) is 70 tiles from the base: the engineer is out at the far end of the map, so the slot at home is
  // empty even though an engineer exists.
  const w = world({ own: [...home(), unit(20, 'ENG', 3, 60, 60), unit(30, 'GI', 3, 13, 12)], neutral: [tech()], credits: 1000 });
  const groups = groupsOf(w);
  const train = groups.infantry?.actions?.produce_ENG;
  assert.ok(train, 'training a second engineer is offered');
  assert.equal(train.name, 'ENG');
  assert.equal(train.auto, undefined, 'the defensive slot never gets an auto of its own: the model decides');
  // The capture target is what the next engineer is described as being for, and it is why `engineersWanted`
  // (one for the outpost + the slot at home) exceeds the single engineer on the field.
  assert.match(groups.infantry.criteria.produce_ENG, /train an engineer to capture Tech Outpost #100/);
});

test('an engineer standing at the base fills the slot: no second one for the same target', () => {
  // (14,12) is 4.5 tiles from the base: the one engineer the base has is already where it is needed, so the
  // single capture target is staffed and nothing is asked for twice.
  const w = world({ own: [...home(), unit(20, 'ENG', 3, 14, 12), unit(30, 'GI', 3, 13, 12)], neutral: [tech()], credits: 5000 });
  const groups = groupsOf(w);
  assert.equal(groups.infantry?.actions?.produce_ENG, undefined, 'the base already has its engineer');
  assert.deepEqual(groups.engineering?.actions?.capture_100?.ids, [20], 'and that engineer is the one sent');
});

test('no barracks, no slot: a remote engineer alone is not a reason to train', () => {
  const w = world({ own: [unit(1, 'YARD', 2, 10, 10), unit(20, 'ENG', 3, 60, 60)], neutral: [tech()], credits: 5000 });
  assert.equal(groupsOf(w).infantry?.actions?.produce_ENG, undefined, 'nothing can be trained without a barracks');
});

test('a remote engineer with nothing left to capture still leaves the base uncovered', () => {
  // The arithmetic alone does not catch this one: with no capture target `engineersWanted` is 1 and one
  // engineer exists, so `engineersWanted > engineers.length` is false while the base has nobody at all.
  const w = world({ own: [...home(), unit(20, 'ENG', 3, 60, 60)], neutral: [], credits: 1000 });
  const groups = groupsOf(w);
  const train = groups.infantry?.actions?.produce_ENG;
  assert.ok(train, 'the empty slot is a reason of its own');
  assert.match(groups.infantry.criteria.produce_ENG, /DEFENSIVE SLOT/, 'and the option says why it exists');
  assert.match(groups.infantry.criteria.produce_ENG, new RegExp(`${HOME_ENGINEER_RADIUS} tiles of the base`));
  assert.equal(train.auto, undefined, 'still the model\'s choice');
});

test('the defensive slot waits for the engineer\'s own 500, not for an invented cushion', () => {
  const own = [...home(), unit(20, 'ENG', 3, 60, 60)];
  // `[ENGINEER] Cost=500` in rules.ini, cheaper than a Grizzly (MTNK 750): the offer appears as soon as the
  // engineer itself is affordable. The capture case still needed a cushion because a captured building has to
  // be held afterwards; the slot at home does not.
  assert.ok(groupsOf(world({ own, neutral: [], credits: 500 })).infantry?.actions?.produce_ENG, 'affordable at its own price');
  assert.equal(groupsOf(world({ own, neutral: [], credits: 400 })).infantry?.actions?.produce_ENG, undefined, 'and not before');
});

test('defuse guard takes the engineer that belongs to the base, not the one nearest the Ivan', () => {
  // #60 is 15 tiles from the Ivan; #50 is at the base, 45 tiles away, but it is the base's own engineer -- and
  // the bombs being cleared are on OUR units and buildings.
  const w = world({ own: [...home(), unit(50, 'ENG', 3, 12, 12), unit(60, 'ENG', 3, 40, 40)], enemies: [unit(900, 'IVAN', 3, 55, 41)] });
  const guard = groupsOf(w).salvage?.actions;
  assert.ok(guard?.defuse_guard_50, 'the home engineer is the one sent');
  assert.equal(guard.defuse_guard_60, undefined, 'not the engineer that happens to be nearest the threat');
  assert.equal(executeSpecial(w.api, guard.defuse_guard_50).accepted, true);
  assert.deepEqual(w.calls.at(-1), ['move', [50], 55, 41], 'walk to the Ivan first: Guard stops a unit where it stands');
});

test('with no engineer at home the nearest one still goes, so an Ivan in the field is not ignored', () => {
  const own = [unit(1, 'YARD', 2, 10, 10), unit(60, 'ENG', 3, 40, 40), unit(61, 'ENG', 3, 42, 44)];
  const w = world({ own, enemies: [unit(900, 'IVAN', 3, 55, 41)] });
  // Neither engineer is within the home radius (42 and 47 tiles out), so the order falls back to proximity:
  // #61 is 13.3 tiles from the Ivan, #60 is 15.0, and the closer one goes.
  const guard = groupsOf(w).salvage?.actions;
  assert.ok(guard?.defuse_guard_61, 'an engineer with no home duty still answers');
  assert.equal(guard.defuse_guard_60, undefined);
});
