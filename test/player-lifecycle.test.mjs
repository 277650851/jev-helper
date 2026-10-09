import assert from "node:assert/strict";
import {
  findVisibleOre,
  executeCandidate,
  collectState,
  candidateGroups,
  attachJevPlayer,
  MAX_STALE_TICKS,
  spreadInfantry,
  splashOf,
} from "../src/player/werhd-jev-player.mjs";

const calls = [];
let self = { credits: 1000, defeated: false, isObserver: false };
let own = [
  {
    id: 1,
    name: "TANK",
    type: 7,
    tile: { rx: 10, ry: 10 },
    primaryWeapon: {},
    isIdle: true,
  },
];
let enemy = [{ id: 9, name: "ENEMY", type: 7, tile: { rx: 15, ry: 15 } }];
// Vehicle-typed on purpose, and load-bearing: the engine reads the structures queue to decide whether the
// opening plan may act, so a queue typed as structures here would leave this fixture with no question it
// can ask at all (no buildings, no units, a one-item build menu) and the three blocks below that drive
// late, stale and ended-battle replies would never see a request. Whoever makes the opening step
// engine-owned has to rebuild this fixture first -- see the note on that tag in src/player.
let queue = { type: 3, size: 0, items: [] };
const api = {
  me: () => self,
  units: (relation) => (relation === "enemy" ? enemy : own),
  inRange: () => false,
  tick: () => 100,
  time: () => 10,
  ObjectType: { Building: 2, Infantry: 3, Vehicle: 7 },
  production: {
    available: () => [{ name: "TANK", type: 7 }],
    queues: () => [queue],
  },
  produce: (name) => calls.push(["produce", name]),
  attack: (ids, id) => calls.push(["attack", ids, id]),
  move: (...args) => calls.push(["move", ...args]),
  map: {
    tile: () => undefined,
    visible: () => false,
    size: () => ({ width: 30, height: 30 }),
  },
};
const action = { type: "attack", ids: [1], targetId: 9 };
enemy = [];
assert.equal(
  executeCandidate(api, action, {}).reason,
  "enemy_no_longer_visible",
);
enemy = [{ id: 9 }];
own = [];
assert.equal(executeCandidate(api, action, {}).reason, "unit_gone");
const produce = { type: "produce", name: "TANK", queue: 3, cost: 750 };
queue.size = 1;
assert.equal(executeCandidate(api, produce, {}).reason, "queue_changed");
queue.size = 0;
self.credits = 200;
assert.equal(executeCandidate(api, produce, {}).reason, "production_changed");
self.credits = 1000;
self.defeated = true;
assert.equal(executeCandidate(api, produce, {}).reason, "not_commandable");
self.defeated = false;
assert.equal(
  executeCandidate(api, { type: "invented" }, {}).reason,
  "unknown_action",
);
assert.deepEqual(calls, []);
assert.equal(executeCandidate(api, produce, {}).accepted, true);
queue.size = 1;
assert.equal(executeCandidate(api, produce, {}).accepted, false);
assert.deepEqual(calls, [["produce", "TANK"]]);
enemy = [];
const snapshot = collectState(api, {});
assert.deepEqual(snapshot.state.visibleEnemies, []);
const groups = candidateGroups(api, {}, snapshot, {
  visited: new Set(),
  lastCombatTick: 0,
  lastScoutTick: 0,
});
assert.ok(Object.values(groups).every((g) => g.actions.wait.type === "wait"));
assert.ok(
  Object.values(groups).every(
    (g) => !Object.keys(g.actions).some((id) => id.startsWith("attack_")),
  ),
);
const frontierApi = {
  ...api,
  map: {
    size: () => ({ width: 30, height: 30 }),
    tile: (x, y) =>
      x === 2 && y === 2 ? { rx: x, ry: y, landType: 0 } : undefined,
    visible: (x, y) => x === 2 && y === 2,
  },
};
const strandedScout = {
  id: 1,
  name: "TANK",
  type: 7,
  tile: { rx: 15, ry: 15 },
  isIdle: true,
  primaryWeapon: {},
};
const frontierSnapshot = {
  ...snapshot,
  raw: { ...snapshot.raw, army: [strandedScout], units: [strandedScout] },
};
const frontierGroups = candidateGroups(frontierApi, {}, frontierSnapshot, {
  visited: new Set(),
  scoutId: 1,
  lastCombatTick: 0,
  lastScoutTick: 0,
});
assert.ok(
  Object.values(frontierGroups.scouting.actions).some(
    (a) =>
      a.type === "mission" && a.mode === "explore" && a.x === 2 && a.y === 2,
  ),
  "a scout with no local destinations must get another visible frontier",
);
// A casualty between snapshot and response must not discard surviving troops' orders.
own = [{ id: 1 }];
enemy = [{ id: 9 }];
assert.equal(
  executeCandidate(api, { ...action, ids: [1, 2] }, {}).accepted,
  true,
);
assert.deepEqual(calls.pop(), ["attack", [1], 9]);
assert.ok(
  !groups.tactics.actions.regroup,
  "healthy troops must not receive a retreat candidate",
);
// Deploy is a toggle: recheck posture and never toggle an already-deployed unit.
api.deploy = (ids) => {
  calls.push(["deploy", ids]);
  return true;
};
own = [
  { id: 1, canDeploy: true, isDeployed: true },
  { id: 2, canDeploy: true, isDeployed: false },
  { id: 3 },
];
assert.equal(
  executeCandidate(
    api,
    { type: "set_deployed", deployed: true, ids: [1, 2, 3] },
    {},
  ).accepted,
  true,
);
assert.deepEqual(calls.pop(), ["deploy", [2]]);
assert.equal(
  executeCandidate(
    api,
    { type: "set_deployed", deployed: true, ids: [1, 3] },
    {},
  ).reason,
  "deployment_state_changed",
);
assert.equal(
  executeCandidate(
    api,
    { type: "set_deployed", deployed: false, ids: [1, 2] },
    {},
  ).accepted,
  true,
);
assert.deepEqual(calls.pop(), ["deploy", [1]]);
const gi = {
  id: 1,
  name: "GI",
  type: 3,
  canDeploy: true,
  isDeployed: false,
  hitPoints: 125,
  maxHitPoints: 125,
  tile: { rx: 10, ry: 10 },
  primaryWeapon: {},
  isIdle: true,
};
const giCatalog = {
  GI: {
    deployer: true,
    weapon: { damage: 15, rof: 20, range: 4 },
    secondary: { damage: 15, rof: 15, range: 5 },
  },
};
own = [gi];
enemy = [{ id: 9, type: 7, tile: { rx: 14, ry: 10 }, primaryWeapon: {} }];
let postureGroups = candidateGroups(
  api,
  giCatalog,
  collectState(api, giCatalog),
  {},
);
assert.deepEqual(postureGroups.deployment.actions.deploy_combat.ids, [1]);
gi.isDeployed = true;
postureGroups = candidateGroups(
  api,
  giCatalog,
  collectState(api, giCatalog),
  {},
);
assert.equal(postureGroups.deployment.actions.deploy_combat, undefined);
enemy = [];
postureGroups = candidateGroups(api, giCatalog, collectState(api, giCatalog), {
  mission: { ids: [1], x: 25, y: 25, since: 100 },
});
assert.deepEqual(postureGroups.deployment.actions.undeploy_mobile.ids, [1]);
// Do not buy a fourth miner while the second refinery already supplies the third.
const economyCatalog = {
  YARD: { yard: true },
  REF: { refinery: true },
  WF: { factory: "UnitType" },
  BARRACKS: { factory: "InfantryType" },
  MINER: { harvester: true, cost: 1400 },
  TANK: { category: "AFV", cost: 750, weapon: { damage: 65, range: 5 } },
  IFV: {
    category: "Transport",
    cost: 600,
    weapon: { damage: 25, range: 6, aa: true },
  },
  GI: { cost: 180, weapon: { damage: 15, range: 4 } },
  ENGINEER: { cost: 500, engineer: true, weapon: { damage: 0, range: 1 } },
};
const economyUnits = [
  "YARD",
  "REF",
  "WF",
  "BARRACKS",
  "MINER",
  "MINER",
  "TANK",
  "TANK",
  "TANK",
  "TANK",
  "GI",
].map((name, i) => ({
  id: i + 1,
  name,
  type: i < 4 ? 2 : name === "GI" ? 3 : 7,
  tile: { rx: 10, ry: 10 },
  hitPoints: 100,
  maxHitPoints: 100,
  primaryWeapon: i >= 6 ? {} : undefined,
}));
const economyApi = {
  ...api,
  me: () => ({ credits: 5000, power: { total: 200, drain: 100 } }),
  units: (r) => (r === "self" ? economyUnits : []),
  production: {
    queues: () => [
      {
        type: 0,
        size: 1,
        items: [
          { name: "REF", quantity: 1, creditsEach: 2000, creditsSpent: 1000 },
        ],
      },
      { type: 3, size: 0, items: [] },
      { type: 2, size: 0, items: [] },
    ],
    available: (q) =>
      (q === 3
        ? ["MINER", "TANK", "IFV"]
        : q === 2
          ? ["GI", "ENGINEER"]
          : []
      ).map((name) => ({ name })),
  },
};
const economyGroups = candidateGroups(
  economyApi,
  economyCatalog,
  collectState(economyApi, economyCatalog),
  {},
);
assert.equal(economyGroups.vehicles.actions.produce_MINER, undefined);
assert.ok(
  economyGroups.vehicles.actions.produce_IFV,
  "armor needs anti-air escorts",
);
assert.ok(
  economyGroups.vehicles.actions.produce_TANK,
  "keep tank production available before an air threat is observed",
);
assert.ok(economyGroups.infantry.actions.produce_GI);
assert.equal(economyGroups.infantry.actions.produce_ENGINEER, undefined);
// Transport is injected by the extension; exercise lifecycle without HTTP or credentials.
queue.size = 0;
own = [];
enemy = [];
api.QueueType = { Structures: 0, Armory: 1 };
const catalog = { TANK: { label: "Tank", cost: 750, speed: 5, primary: "Cannon", power: 100 } };
// `calls` is shared by the blocks below, and a late timer from one block can land inside the next
// one. Each assertion therefore counts what its own block added, instead of the whole array: read as
// a total, the entry left behind by an earlier block satisfied every later assertion, so none of them
// was actually checking anything and the suite went red about one full-suite run in ten whenever a
// previous block's trailing timer had not landed yet.
const callsSince = since => calls.slice(since);
let callsMark = calls.length;
// The opening build is engine-owned: the plan has already established that this step's precondition
// holds, the structures queue is idle and the down payment is covered, so the engine takes it without
// asking. That means this block cannot wait for the model to be consulted -- it never is -- and waits for
// the engine's own decision instead.
let finish, entered = false;
const player = await attachJevPlayer(api, {
  catalog, intervalMs: 10, disableMicro: true,
  requestDecision: async (_body, {signal}) => {
    entered = true;
    return new Promise(resolve => { finish = () => {
      assert.equal(signal.aborted, true);
      resolve({ answers: { construction: { choice: "produce_TANK" } } });
    }; });
  },
});
// A turn happened when the engine took its own action, or when it did ask.
const tookATurn = new Promise(resolve => { const check = () => (entered || player.status.decisions > 0) ? resolve() : setTimeout(check, 10); check(); });
await tookATurn;
// From here on nothing may be ordered: the engine's own opening decision already happened, and the model
// was never asked. Marking the tally now is what makes the assertion below about the stop, not about the
// opening.
callsMark = calls.length;
const acceptedAtStop = player.status.accepted;
player.stop();
if (finish) finish();
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(player.status.running, false);
assert.equal(player.status.accepted, acceptedAtStop, 'nothing is accepted after stop');
// Stop cleared the controller, so no order may follow. The assertion here used to expect one, which is the
// opposite of what its message says: that entry came from the block below and made the check a tautology.
assert.deepEqual(callsSince(callsMark), [], "nothing may be ordered after stop");

let tick = 100, staleResolve;
callsMark = calls.length;
api.tick = () => tick;
// The opening step is engine-owned, and in this fixture it is the only thing the construction group can
// offer, so the model would never be asked and this block -- which is about what happens to a reply that
// arrives too late -- would never see one. A barracks and an infantry menu item give the fixture a second,
// genuine question; the reply below may then be about any group, because a stale reply is discarded
// whatever it says. That is the point: the assertion is about the discard, not about the choice.
const realAvailable = api.production.available;
const realCatalog = { ...catalog };
own = [{ id: 90, name: "BARRACKS", type: 2, tile: { rx: 20, ry: 20 }, hitPoints: 500, maxHitPoints: 500, isIdle: false }];
catalog.BARRACKS = { label: "Barracks", cost: 500, factory: "InfantryType" };
catalog.E1 = { label: "GI", cost: 200, speed: 4, primary: "Rifle", factory: "InfantryType", weapon: { damage: 15, rof: 20, range: 4, ag: true } };
// `available` already answers with `{name, type}` objects in this fixture; only the extra infantry entry
// is added, and it keeps the same shape. Wrapping it again would hand the engine `{name:{name}}` and the
// build menu would silently empty out -- which is exactly what happened the first time this was written.
api.production.available = (q) => (q === 2 ? [...realAvailable(q), { name: "E1", type: 3 }] : realAvailable(q));
let askedThisBlock = false;
const staleDone = new Promise(resolve => { staleResolve = resolve; });
const stalePlayer = await attachJevPlayer(api, {
  catalog, intervalMs: 10, disableMicro: true,
  requestDecision: async () => { askedThisBlock = true; tick = 1000; return { answers: { infantry: { choice: "produce_E1" } } }; },
  onEvent: event => { if (event.kind === "stale") staleResolve(); },
});
await staleDone;
stalePlayer.stop();
assert.ok(askedThisBlock, "the model really was asked, or the discard below proves nothing");
assert.equal(stalePlayer.status.rejected, 1, "the out-of-date reply is counted as rejected");
assert.equal(stalePlayer.status.accepted, 1, "only the engine's own step was accepted");
assert.deepEqual(callsSince(callsMark), [["produce", "TANK"]], "the engine's own step is the only order; the stale reply issues none");
api.production.available = realAvailable;
for (const k of Object.keys(catalog)) if (!(k in realCatalog)) delete catalog[k];
own = [];

// Report jev-report-20261008-023829: 102 decisions, 103 discarded. The game ran at ~60 ticks/s and a
// local CPU model answered in 1.4-3.9 s, i.e. 244 ticks, while the budget was the 180-tick default
// — so the smallest age ever observed was still past it and the model had no say in the match. A
// budget fixed in ticks cannot work: the same number is 3 s on a fast game and 12 s on a slow one.
// So the page widens it from what it actually measures, whatever the provider is called.
{
  let tick = 0;
  api.tick = () => tick;
  const events = [];
  const ages = [244, 250, 240, 245];
  let n = 0;
  calls.length = 0;
  own = [ { id: 1, name: 'TANK', type: 7, tile: { rx: 10, ry: 10 }, hitPoints: 100, maxHitPoints: 100, primaryWeapon: { damage: 50, range: 5 } },
    { id: 90, name: 'BARRACKS', type: 2, tile: { rx: 20, ry: 20 }, hitPoints: 500, maxHitPoints: 500, isIdle: false } ];
  // This block needs a question the engine cannot answer itself, or the opening step answers every turn
  // and the model is never asked -- and what is being tested here is the age of a model reply.
  const agesAvailable = api.production.available;
  const agesCatalog = { ...catalog };
  catalog.BARRACKS = { label: 'Barracks', cost: 500, factory: 'InfantryType' };
  catalog.E1 = { label: 'GI', cost: 200, speed: 4, primary: 'Rifle', factory: 'InfantryType', weapon: { damage: 15, rof: 20, range: 4, ag: true } };
  api.production.available = q => (q === 2 ? [...agesAvailable(q), { name: 'E1', type: 3 }] : agesAvailable(q));
  // Wait for the outcome this block is about: a reply rejected as out of date, then one that is finally
  // accepted. "accepted > 0" alone is not usable -- the engine-owned opening step is accepted on the first
  // turn, so it would be true before the model was ever asked and the block would end having tested
  // nothing.
  let reached = null;
  const outcome = new Promise(resolve => { reached = resolve; });
  const player = await attachJevPlayer(api, {
    catalog, intervalMs: 10, disableMicro: true,
    // Every reply is ~244 ticks old, exactly as in the report: the first is discarded, and the budget
    // the rejection reports must then be wide enough for the next one to be accepted.
    requestDecision: async () => { const age = ages[Math.min(n++, ages.length - 1)]; tick += age; return { answers: { infantry: { choice: 'produce_E1' } } }; },
    onEvent: e => {
      events.push(e);
      if (e.kind === 'stale') { tick += 1; reached?.(); return; }
      if (e.kind === 'action' && e.auto !== true && e.accepted === true) reached?.();
    },
  });
  // A backstop so a regression reports a failed assertion instead of hanging the suite.
  await Promise.race([outcome, new Promise(resolve => setTimeout(resolve, 4000))]);
  player.stop('manual');
  api.production.available = agesAvailable;
  for (const k of Object.keys(catalog)) if (!(k in agesCatalog)) delete catalog[k];
  const stale = events.filter(e => e.kind === 'stale');
  assert.ok(stale.length >= 1, 'the first reply is still discarded');
  assert.equal(stale[0].budgetTicks, 488, 'the rejection states the measured age doubled, not a guess');
  assert.ok(player.status.accepted > 0, 'the next reply is accepted: the loop is not starving the model');
  // And it stays bounded: a source that answers inside the budget must not keep the widened one.
  const grown = events.filter(e => e.kind === 'stale').at(-1)?.budgetTicks ?? 0;
  assert.ok(grown <= MAX_STALE_TICKS, `the budget never exceeds the ceiling: ${grown}`);
  console.log(`Staleness: a 244-tick reply on a 180 budget is discarded once, then accepted (rejections ${stale.length}, accepted ${player.status.accepted})`);
}

// The block above clears `calls` and then stops on a wall-clock poll, so a decision already in
// flight can still land its accepted order here: this block again counts only what it adds itself.
callsMark = calls.length;
let ended = false, endedResolve;
const endEvents = [];
// Same shape as the stale block above: the engine-owned opening step is the only order this fixture can
// produce on its own, so a barracks and an infantry item give the model something to be asked about. The
// reply arrives after the battle has ended, and what it says is irrelevant -- the answer is discarded
// before it can be executed, which is what this block pins.
const endAvailable = api.production.available;
const endCatalog = { ...catalog };
own = [{ id: 90, name: "BARRACKS", type: 2, tile: { rx: 20, ry: 20 }, hitPoints: 500, maxHitPoints: 500, isIdle: false }];
catalog.BARRACKS = { label: "Barracks", cost: 500, factory: "InfantryType" };
catalog.E1 = { label: "GI", cost: 200, speed: 4, primary: "Rifle", factory: "InfantryType", weapon: { damage: 15, rof: 20, range: 4, ag: true } };
api.production.available = (q) => (q === 2 ? [...endAvailable(q), { name: "E1", type: 3 }] : endAvailable(q));
let askedBeforeEnd = false;
api.tick = () => { if (ended) throw new Error("werhd is not available outside a running battle"); return 100; };
const endDone = new Promise(resolve => { endedResolve = resolve; });
const endedPlayer = await attachJevPlayer(api, {
  catalog, intervalMs: 10, disableMicro: true,
  requestDecision: async () => { askedBeforeEnd = true; ended = true; return { answers: { infantry: { choice: "produce_E1" } } }; },
  onEvent: event => { endEvents.push(event); if (event.kind === "stop") endedResolve(); },
});
await endDone;
assert.ok(askedBeforeEnd, "the model was asked before the battle ended, or the discard below proves nothing");
assert.equal(endedPlayer.status.running, false);
assert.equal(endedPlayer.status.failures, 0);
assert.ok(endEvents.some(e => e.kind === "stop" && e.reason === "battle_ended"));
assert.ok(!endEvents.some(e => e.kind === "error"));
// The engine's own opening step was taken before the battle ended; the reply that came back afterwards
// ordered nothing. This assertion used to expect no orders at all and matched an entry from the block
// above, which is how it stayed green while checking nothing.
assert.deepEqual(callsSince(callsMark), [["produce", "TANK"]], "an answer whose battle has ended must issue no orders");
api.production.available = endAvailable;
for (const k of Object.keys(catalog)) if (!(k in endCatalog)) delete catalog[k];
own = [];
console.log(
  "Jev deployment/economy and guards passed: stale targets/snapshots, cancellation, missing units, changed queues/funds, defeat, unknown actions and fog.",
);

const oreApi = { map: { size: () => ({ width: 5, height: 5 }),
  tile: (x, y) => x === 3 && y === 2 ? { rx: x, ry: y, landType: 9 } : undefined } };
assert.deepEqual(findVisibleOre(oreApi, { rx: 2, ry: 2 }), { rx: 3, ry: 2, landType: 9 });
assert.equal(findVisibleOre({ map: { ...oreApi.map, tile: () => undefined } }, { rx: 2, ry: 2 }), undefined,
  'unrevealed ore cannot become a gather target');

// V3 rockets and prism tanks hit everything around the target, so a clump of idle infantry is one
// shot away from being wiped together. Idle infantry inside an enemy's blast reach step apart; the
// one nearest the threat holds its ground.
{
  const moves = [];
  const self = [10, 11, 12].map((id) => ({ id, name: 'GI', type: 3, isIdle: true, isDeployed: false, tile: { rx: 30, ry: 30 } }));
  const enemies = [{ id: 70, name: 'V3', type: 7, tile: { rx: 34, ry: 30 } }];
  const catalog = { GI: {}, V3: { weapon: { damage: 200, range: 8, ag: true, cellSpread: 2 } } };
  const api = {
    tick: () => 1000, ObjectType: { Infantry: 3, Vehicle: 7, Building: 2 },
    units: (r) => r === 'enemy' ? enemies : self,
    map: { tile: (x, y) => (x >= 0 && y >= 0 && x < 80 && y < 80 ? { rx: x, ry: y } : undefined) },
    move: (ids, x, y) => moves.push([ids[0], x, y]),
  };
  assert.equal(splashOf(catalog.V3.weapon), 2, 'the blast radius is read from the rule');
  assert.equal(splashOf({ range: 5 }), 0, 'a plain weapon has no blast');
  const memory = {}, events = [];
  const moved = spreadInfantry(api, catalog, memory, (e) => events.push(e));
  assert.equal(moved.length, 2, 'the two that do not hold step apart from the clump');
  assert.equal(events[0]?.kind, 'micro');
  assert.equal(events[0]?.reply, 'spread');
  const targets = moves.map(([, x, y]) => `${x},${y}`);
  assert.equal(new Set(targets).size, targets.length, 'and they step to different tiles, not the same one');
  assert.ok(moves.every(([, x, y]) => Math.hypot(x - 30, y - 30) >= 2), 'far enough that one blast cannot take both');
  assert.deepEqual(spreadInfantry(api, catalog, memory, () => {}), [], 'the spread is not repeated every micro pass');
  // Idle infantry out of reach, or already fighting, are left where they are.
  enemies[0].tile = { rx: 90, ry: 90 };
  assert.deepEqual(spreadInfantry(api, catalog, { lastSpread: -Infinity }, () => {}), [], 'no threat in reach, no move');
  console.log('Splash spread: clustered idle infantry step apart inside an enemy blast radius');
}
