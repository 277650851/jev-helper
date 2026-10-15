import test from 'node:test';
import assert from 'node:assert/strict';
import { specialGroups, executeSpecial, rememberSpecial, maintainSpecial } from '../src/player/werhd-jev-special.mjs';
import { collectState } from '../src/player/werhd-jev-player.mjs';
import { eventEntry } from '../src/logbook.mjs';

// A spy is the only unit in rules(规则文件).ini with `Infiltrate=yes` (`[SPY]`, Cost=1000,
// Prerequisite=Barracks,TECH), and the console cannot name what it does: `OrderType` has no `Infiltrate`, and
// the only documented verb in the neighbourhood is `Occupy = 8`, 进入建筑. That is what the task issues.
//
// The whole path is UNVERIFIED at the engine boundary. `availableActions` / `canEnter` -- the only place an
// `infiltrate` action is named -- is still a request to the game (`docs/game-api-requests.md` §7.3), so
// whether the engine accepts `Occupy` on an ENEMY building for a spy cannot be answered here. What these
// tests pin is everything on this side of that boundary: which option is offered, which building it picks,
// which order it carries, and what the record says when the spy is gone.
const catalog = {
  YARD: { yard: true, label: 'Construction Yard' },
  BARRACKS: { factory: 'InfantryType', label: 'Barracks', cost: 500 },
  SPY: { label: 'Spy', cost: 1000, armor: 'none', category: 'Soldier', weapon: { damage: 0, range: 0, versus: [] } },
  NAREFN: { refinery: true, label: 'Ore Refinery', power: -50 },
  NAPOWR: { power: 200, label: 'Tesla Reactor' },
  NATECH: { techLevel: 6, label: 'Battle Lab' },
  GAWALL: { wall: true, label: 'Wall' },
  MTNK: { label: 'Grizzly', armor: 'heavy', category: 'AFV', weapon: { damage: 65, rof: 60, range: 5, ag: true, versus: [1, 1, 1, 1, 1, 1] } },
};
const unit = (id, name, type, x, y, extra = {}) => ({ id, name, type, tile: { rx: x, ry: y }, hitPoints: 100, maxHitPoints: 100, isIdle: true, primaryWeapon: catalog[name].weapon, ...extra });
function world({ own, enemies = [], neutral = [], credits = 5000, tick = 3000 }) {
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
    production: { queues: () => Array.from({ length: 6 }, (_, type) => ({ type, size: 0, maxSize: 99, items: [] })), available: (q) => (q === undefined || q === 2 ? [{ name: 'SPY', type: 3 }] : []) },
    weaponVs: () => undefined, inRange: () => false, attack: (...a) => calls.push(['attack', ...a]),
    move: (...a) => calls.push(['move', ...a]), attackMove: (...a) => calls.push(['attackMove', ...a]), deploy: () => true,
    order: (ids, o, target) => { calls.push(['order', ids, o, target]); return true; },
    produce: (...a) => calls.push(['produce', ...a]), gather() {}, repair() {},
    onTick: (h) => { api._tick = h; }, offTick() {},
  };
  const memory = { frontiers: new Map(), enemyBuildings: new Map(), orders: new Map(), postureOrders: new Map(), specialOrders: new Map(), specialTargets: new Map(), plannedSites: new Map(), observedSpecial: new Map(), repairing: new Set(), lastMaintenance: tick, lastMicroReport: -1000 };
  return { api, memory, calls, setTick: (t) => { tick = t; } };
}
const groupsOf = (w) => { const groups = {}; specialGroups(w.api, catalog, collectState(w.api, catalog), w.memory, groups); return groups; };
const base = () => [unit(1, 'YARD', 2, 10, 10), unit(2, 'BARRACKS', 2, 12, 10)];

test('an idle spy and a visible enemy building produce one infiltration option, and the engine does not decide it', () => {
  const spy = unit(20, 'SPY', 3, 14, 12), refinery = unit(300, 'NAREFN', 2, 40, 40);
  const w = world({ own: [...base(), spy], enemies: [refinery] });
  const groups = groupsOf(w);
  const action = groups.infiltration?.actions?.['infiltrate_300'];
  assert.ok(action, 'a spy with somewhere to go is offered');
  assert.deepEqual(action.ids, [20]);
  assert.equal(action.targetId, 300);
  assert.equal(action.order.type, 8, 'Occupy = 8, the console 进入建筑 verb');
  assert.deepEqual(action.order.target, { objectId: 300 });
  // Not engine-owned: this is unverified at the engine boundary, so the choice stays with the model
  // (review §4), and a decline costs nothing but the question.
  assert.equal(action.auto, undefined);
  assert.equal(action.engineOwned, undefined);
  assert.match(groups.infiltration.criteria['infiltrate_300'], /SpyMoneyStealPercent/);
  assert.match(groups.infiltration.criteria['infiltrate_300'], /unverified/);
});

test('without a spy, or without anything worth entering, there is no question at all', () => {
  const refinery = unit(300, 'NAREFN', 2, 40, 40);
  const noSpy = world({ own: [...base(), unit(21, 'MTNK', 7, 14, 12)], enemies: [refinery] });
  assert.equal(groupsOf(noSpy).infiltration, undefined, 'no spy, no infiltration group');
  const onlyWall = world({ own: [...base(), unit(20, 'SPY', 3, 14, 12)], enemies: [unit(301, 'GAWALL', 2, 40, 40)] });
  assert.equal(groupsOf(onlyWall).infiltration, undefined, 'a wall has nothing to steal');
});

test('an undefended building is chosen over a closer defended one, because the spy must arrive', () => {
  const spy = unit(20, 'SPY', 3, 14, 12);
  const near = unit(310, 'NAPOWR', 2, 16, 12), far = unit(300, 'NAREFN', 2, 40, 40), guard = unit(900, 'MTNK', 7, 17, 13);
  const w = world({ own: [...base(), spy], enemies: [near, far, guard] });
  const actions = groupsOf(w).infiltration?.actions ?? {};
  // The refinery is 38 tiles away and the reactor 2, but the reactor has a tank on top of it.
  assert.ok(actions['infiltrate_300'], 'the undefended refinery is the target');
  assert.equal(actions['infiltrate_310'], undefined, 'not the power plant under a tank');
});

test('executing the option issues Occupy on that building and nothing else', () => {
  const spy = unit(20, 'SPY', 3, 14, 12), refinery = unit(300, 'NAREFN', 2, 40, 40);
  const w = world({ own: [...base(), spy], enemies: [refinery] });
  const action = groupsOf(w).infiltration.actions['infiltrate_300'];
  assert.equal(executeSpecial(w.api, action).accepted, true);
  assert.deepEqual(w.calls.at(-1), ['order', [20], { type: 8, target: { objectId: 300 } }, undefined]);
});

test('the task re-sends while the spy is idle, stops when the spy is gone, and says it cannot tell why', () => {
  const own = [...base(), unit(20, 'SPY', 3, 14, 12)], refinery = unit(300, 'NAREFN', 2, 40, 40);
  const w = world({ own, enemies: [refinery] });
  const action = groupsOf(w).infiltration.actions['infiltrate_300'];
  rememberSpecial(w.memory, action, executeSpecial(w.api, action), 3000);
  assert.equal(w.memory.specialTasks.length, 1);
  assert.equal(w.memory.specialOrders.get(20).kind, 'infiltrate');
  // While the task is live the spy is not idle, so the option is not offered a second time for the same trip.
  assert.equal(groupsOf(w).infiltration, undefined, 'one spy, one trip');

  const events = [];
  w.setTick(3200); maintainSpecial(w.api, w.memory, (e) => events.push(e));
  assert.equal(w.memory.specialTasks[0].resends, 1, 'the order is re-sent on the same 150-tick rhythm as a capture');
  assert.equal(events.at(-1).kind, 'micro');

  own.splice(own.findIndex((u) => u.id === 20), 1); // consumed by the infiltration, or shot on the way
  w.setTick(3300); maintainSpecial(w.api, w.memory, (e) => events.push(e));
  const last = events.at(-1);
  assert.equal(last.kind, 'task');
  assert.equal(last.task, 'infiltrate');
  assert.equal(last.result, 'spy_gone');
  assert.equal(last.resends, 1);
  assert.deepEqual(last.ids, [20], 'the record names the spy, not only the building');
  assert.match(last.description, /says nothing about whether it got in/);
  assert.deepEqual(eventEntry(last, 0).ids, [20], 'and the serializer keeps it');
  assert.equal(w.memory.specialTasks.length, 0, 'the task ends with the spy');
  assert.equal(w.memory.specialOrders.has(20), false);
});

test('a building that disappears before the spy arrives ends the task as target_lost', () => {
  const own = [...base(), unit(20, 'SPY', 3, 14, 12)], enemies = [unit(300, 'NAREFN', 2, 40, 40)];
  const w = world({ own, enemies });
  const action = groupsOf(w).infiltration.actions['infiltrate_300'];
  rememberSpecial(w.memory, action, executeSpecial(w.api, action), 3000);
  const events = [];
  enemies.length = 0;
  w.setTick(3100); maintainSpecial(w.api, w.memory, (e) => events.push(e));
  assert.equal(events.at(-1).result, 'target_lost');
  assert.equal(w.memory.specialTasks.length, 0);
});
