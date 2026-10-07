import assert from 'node:assert/strict';
import { specialGroups, executeSpecial, rememberSpecial, maintainSpecial } from '../src/player/werhd-jev-special.mjs';
import { refreshCatalog } from '../src/player/werhd-jev-catalog.mjs';

const catalog = {
  YARD: { yard: true }, GI: { occupier: true, size: 1 }, ENG: { engineer: true },
  IFV: { gunner: true, label: 'IFV', sizeLimit: 1 }, APC: { sizeLimit: 2 },
  HUT: { bridgeRepairHut: true }, CIV: {}, TANK: {},
  WALL: { wall: true, cost: 100, label: 'Wall' }, DEF: { isBaseDefense: true, cost: 500, label: 'Defense' },
  AIRFIELD: { factory: 'AircraftType', numberOfDocks: 4, cost: 1000, label: 'Airfield' },
  NAVAL: { naval: true, factory: 'NavalUnitType', cost: 1000, label: 'Yard' },
  JET: { aircraft: true, cost: 1200, weapon: { damage: 100, ag: true }, label: 'Jet' },
  SHIP: { naval: true, cost: 1000, weapon: { damage: 100, ag: true }, label: 'Ship' },
};
const unit = (id, name, type, extra = {}) => ({ id, name, type, tile: { rx: 10, ry: 10 }, hitPoints: 100, maxHitPoints: 100, isIdle: true, ...extra });
const base = unit(1, 'YARD', 2);
const own = [base, ...Array.from({ length: 6 }, (_, i) => unit(10 + i, 'GI', 3)),
  unit(20, 'ENG', 3), unit(30, 'IFV', 7, { transport: { occupied: 0, capacity: 1, unitIds: [] } }),
  unit(31, 'APC', 7, { zone: 0, transport: { occupied: 1, capacity: 5, unitIds: [100] } }),
  unit(32, 'TANK', 7), unit(40, 'JET', 1, { ammo: 1 }), unit(50, 'SHIP', 7, { zone: 2 }),
  unit(60, 'CIV', 2, { hitPoints: 10, garrison: { count: 2, capacity: 5, canOccupy: false, unitIds: [110, 111] } }),
  unit(61, 'DEF', 2, { hitPoints: 10 }),
];
const enemy = unit(70, 'TANK', 7, { tile: { rx: 17, ry: 10 }, onBridge: true });
const building = unit(80, 'CIV', 2, { tile: { rx: 14, ry: 10 }, garrison: { count: 0, capacity: 5, canOccupy: true } });
const hut = unit(81, 'HUT', 2);
const calls = [];
const api = {
  units: (relation) => relation === 'self' ? own : relation === 'allied' ? [] : relation === 'enemy' ? [enemy] : [enemy, building, hut],
  unit: (id) => [...own, enemy, building, hut].find((u) => u.id === id),
  tick: () => 1000, canPlace: () => true, sell: (id) => calls.push(['sell', id]),
  order: (ids, command) => { calls.push([ids, command]); return true; },
  ObjectType: { Aircraft: 1, Building: 2, Infantry: 3, Vehicle: 7 },
  OrderType: { Move: 0, Attack: 2, ForceAttack: 3, Occupy: 8, DeploySelected: 10, Stop: 11, Repair: 15, EnterTransport: 17 },
  QueueType: { Structures: 0, Armory: 1, Infantry: 2, Vehicles: 3, Aircrafts: 4, Ships: 5 },
  production: {
    queues: () => Array.from({ length: 6 }, (_, type) => ({ type, size: 0, maxSize: 10 })),
    available: (queue) => ({ 0: ['AIRFIELD', 'NAVAL'], 1: ['WALL', 'DEF'], 2: ['ENG'], 4: ['JET'], 5: ['SHIP'] }[queue] ?? ['AIRFIELD', 'NAVAL', 'WALL', 'DEF', 'ENG', 'JET', 'SHIP']).map((name) => ({ name })),
  },
  map: { size: () => ({ width: 25, height: 25 }), visible: () => false,
    tile: (x, y) => x === 18 && y === 10 ? { rx: x, ry: y, bridge: { id: 90, hitPoints: 200, maxHitPoints: 500 }, landType: 7 } : undefined },
};
const snapshot = { raw: { units: own, buildings: own.filter((u) => u.type === 2), army: own.filter((u) => u.type === 3 || u.name === 'TANK'), enemies: [enemy], base },
  // The enemy tank on the bridge is 7 tiles from the yard: the base is under threat.
  state: { self: { credits: 10000 }, harvesters: 3, economy: { factories: 1 }, airThreatCount: 0, nearbyEnemyCount: 1, baseUnderAttack: true } };
// The bridge piece is damaged: since 0.6.0 repair is offered only with a reason (damage or a stuck attack).
const memory = {};
const groups = {};
specialGroups(api, catalog, snapshot, memory, groups);
const actions = Object.values(groups).flatMap((g) => Object.values(g.actions));
for (const kind of ['garrison', 'evacuate_garrison', 'load', 'unload', 'repair_bridge', 'demolish_bridge', 'air_strike', 'naval_attack'])
  assert.ok(actions.some((a) => a.kind === kind), `${kind} must be considered in its applicable state`);
for (const name of ['WALL', 'DEF', 'AIRFIELD', 'NAVAL', 'JET', 'SHIP'])
  assert.ok(actions.some((a) => a.type === 'produce' && a.name === name), `${name} must be a production option`);
assert.ok(actions.some((a) => a.type === 'sell' && a.objectId === 61));
assert.ok(!actions.some((a) => a.type === 'sell' && a.objectId === 1), 'never salvage the only construction yard');
assert.deepEqual(calls, [], 'candidate generation cannot submit any game commands');
// Opt-in real-model contract probe. Synthetic fixture; it never controls an online match.
if (process.env.WERHD_JEV_MODEL_PROBE) {
  const bridge = new URL(process.env.WERHD_JEV_MODEL_PROBE);
  assert.equal(bridge.hostname,'127.0.0.1','use a separate local adapter for the bounded probe');
  // Construction/infantry inherit their instructions from the main player in real use.
  const offered = Object.fromEntries(Object.entries(groups).filter(([,g])=>g.instructions&&Object.keys(g.actions).length>1));
  const results=[];
  for(let offset=0;offset<Object.keys(offered).length;offset+=8) {
    const batch=Object.fromEntries(Object.entries(offered).slice(offset,offset+8));
    const state={...snapshot.state,tick:api.tick(),validation:'Synthetic special-action candidate contract; not an online match',
      ownUnits:own,visibleEnemies:[enemy],visibleInfrastructure:[building,hut]};
    const response=await fetch(new URL('/decide',bridge),{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({state,groups:batch}),signal:AbortSignal.timeout(15000)});
    assert.equal(response.ok,true,`model probe returned HTTP ${response.status}`);
    const result=await response.json();
    for(const [id,g] of Object.entries(batch)) {
      assert.ok(g.actions[result.answers[id].choice],`model selected an unoffered ${id} action`);
      for(const key of Object.keys(g.criteria)) assert.ok(Object.hasOwn(result.answers[id].probabilities,key),`${id}/${key} was absent from model probabilities`);
    }
    results.push({state,groups:batch,result});
  }
  const report={scope:'Real Jev probabilities over synthetic public-player candidate fixtures. Selection is not proof of online execution or engine effects.',
    groups:Object.keys(offered),actions:actions.filter(a=>a.type!=='wait'),results};
  if(process.env.WERHD_JEV_MODEL_REPORT) {
    const {writeFile}=await import('node:fs/promises');
    await writeFile(process.env.WERHD_JEV_MODEL_REPORT,JSON.stringify(report,null,2)+'\n');
  }
  console.log(JSON.stringify({modelProbe:'passed',groups:report.groups,selected:results.flatMap(r=>Object.entries(r.result.answers).map(([id,a])=>({id,choice:a.choice})))}));
}
const garrison = actions.find((a) => a.kind === 'garrison');
assert.equal(executeSpecial(api, garrison).accepted, true);
building.garrison.count = 5;
assert.equal(executeSpecial(api, garrison).reason, 'garrison_changed');
const load = actions.find((a) => a.kind === 'load');
own.find((u) => u.id === load.targetId).transport.occupied = 1;
assert.equal(executeSpecial(api, load).reason, 'transport_changed');
assert.equal(executeSpecial({ ...api, unit: () => undefined }, garrison).reason, 'target_no_longer_visible');
own.find((u) => u.id === 32).onBridge = true;
own.find((u) => u.id === 32).tile = { rx: 18, ry: 10 };
snapshot.state.airThreatCount = 1;
const guarded = {};
specialGroups(api, catalog, snapshot, memory, guarded);
assert.ok(!Object.values(guarded.engineering.actions).some((a) => a.kind === 'demolish_bridge'), 'never demolish beneath friendlies');
assert.ok(!Object.values(guarded.transport.actions).some((a) => a.kind === 'load' && a.targetId === 30), 'do not remove AA from escort IFVs during air attack');

// A multi-purpose IFV takes its weapon from its passenger, so it is crewed with the unit that suits
// the visible enemy and can be crewed out with the army rather than only beside the base.
// jev-report-20261008-054847 built IFVs (produce_FV) and never put anyone in one.
{
  const air = snapshot.state.airThreatCount; snapshot.state.airThreatCount = 0;
  const ifv = own.find((u) => u.id === 30), gi = own.find((u) => u.id === 10);
  const savedIfv = { ...ifv.tile }, savedGi = { ...gi.tile }, savedEnemy = { ...enemy.tile };
  const savedOccupied = ifv.transport.occupied; ifv.transport.occupied = 0;
  ifv.tile = { rx: 22, ry: 22 }; gi.tile = { rx: 22, ry: 23 }; enemy.tile = { rx: 24, ry: 22 };
  const field = {};
  specialGroups(api, catalog, snapshot, { mission: { ids: [30], x: 24, y: 22 } }, field);
  const load = Object.values(field.transport?.actions ?? {}).find((a) => a.kind === 'load' && a.targetId === 30);
  assert.ok(load, 'an emptied IFV is crewed in the field, not only beside the base');
  ifv.tile = savedIfv; gi.tile = savedGi; enemy.tile = savedEnemy;
  ifv.transport.occupied = savedOccupied; snapshot.state.airThreatCount = air;
}

// Effective runtime rules win over a stale static catalog, including map-specific costs.
const runtimeRule = { name: 'JET', type: 1, factory: 0, buildCat: 0, armor: 0, cost: 777,
  primary: { damage: 55, versus: { 0: 1, 5: 0.2 } }, prerequisite: [] };
const refreshed = refreshCatalog({ ...api, FactoryType: { 0: 'None' }, BuildCat: { 0: 'Combat' }, ArmorType: { 0: 'None' },
  rules: (name) => name === 'JET' ? runtimeRule : undefined }, { JET: { cost: 99999 } });
assert.equal(refreshed.JET.cost, 777);
assert.equal(refreshed.JET.weapon.verses[5], 0.2);
assert.equal(refreshed.JET.aircraft, true);
console.log('Jev special action coverage, stale-state guards, friendly bridge safety, and live rules passed');

// Report jev-report-20261008-023829 (naval map, defeat): with the enemy base never found, the transport
// group offered load_* and nothing else. ferry_* needed a known enemy building and unload_* needed
// enemies within 14 tiles, so infantry were loaded 14 times and the transport never crossed the water.
// The whole amphibious loop — load, sail to the far shore, land to look — has to exist while the base
// is unknown, and the sea scout needs the same automatic fallback the ground explore already has.
{
  const W = 7, size = 60;
  // Two islands: ours in one corner, the far shore beyond a wide channel. Fog everywhere except home.
  const seaApi = {
    ...api,
    tick: () => 5000,
    map: {
      size: () => ({ width: size, height: size }),
      visible: (x, y) => x < 20 && y < 20,
      tile: (x, y) => (x >= 0 && y >= 0 && x < size && y < size) ? { rx: x, ry: y, landType: (x < 20 && y < 20) || (x > 40 && y > 40) ? 0 : W } : undefined,
    },
  };
  const home = unit(1, 'YARD', 2, { tile: { rx: 6, ry: 6 } });
  const ferryBoat = unit(70, 'APC', 7, { tile: { rx: 8, ry: 8 }, zone: 2, transport: { occupied: 2, capacity: 5, unitIds: [11, 12] } });
  const boatOwn = [home, ...Array.from({ length: 4 }, (_, i) => unit(10 + i, 'GI', 3, { tile: { rx: 8 + i, ry: 8 } })), ferryBoat];
  const seaSnapshot = {
    raw: { units: boatOwn, buildings: [home], army: boatOwn.filter((u) => u.type === 3), enemies: [], base: home },
    state: { self: { credits: 5000 }, harvesters: 2, economy: { factories: 1 }, airThreatCount: 0, nearbyEnemyCount: 0, baseUnderAttack: false },
  };
  const seaMemory = { enemyBuildings: new Map() };
  const seaGroups = {};
  specialGroups(seaApi, catalog, seaSnapshot, seaMemory, seaGroups);
  const t = seaGroups.transport;
  assert.ok(t, 'the transport group exists');
  const keys = Object.keys(t.actions);
  assert.ok(keys.some((k) => k.startsWith('ferry_')), `an unknown enemy base must still give the ferry a destination: ${keys}`);
  const shore = seaMemory.farShore;
  assert.ok(shore && shore.x > 40 && shore.y > 40, `the far shore is across the water, not next door: ${JSON.stringify(shore)}`);
  // Landing is only for a boat that has actually crossed; at home the offer is the crossing itself.
  assert.ok(!keys.some((k) => k.startsWith('unload_')), `no landing while the boat is still at home: ${keys}`);
  ferryBoat.tile = { rx: shore.x, ry: shore.y };
  const arrived = {};
  specialGroups(seaApi, catalog, seaSnapshot, seaMemory, arrived);
  assert.ok(Object.values(arrived.transport.actions).some((a) => a.kind === 'unload'), 'landing is offered once it has crossed');
  // And the ferry aims at the far shore while the base is unknown, then at the base once it is known.
  const ferry = Object.values(arrived.transport.actions).find((a) => a.kind === 'transport_move');
  assert.equal(ferry.order.target.x, shore.x, 'the crossing targets the far shore');
  seaMemory.enemyBuildings.set(9, { x: 50, y: 50, name: 'NAYARD' });
  const known = {};
  specialGroups(seaApi, catalog, seaSnapshot, seaMemory, known);
  assert.ok(!Object.values(known.transport.actions).some((a) => a.kind === 'unload'), 'a known enemy base restores the fight-first landing rule');
  console.log('Amphibious reconnaissance: an unknown enemy base gives the ferry a far-shore destination, landing is offered on arrival, and a known base restores the old rule');
}

// Entering a building is a composed task: wait for actual undeployment before ordering entry.
building.garrison.count = 0;
let tick = 2000;
const soldier = own.find(u => u.id === garrison.ids[0]);
soldier.isDeployed = true;
const sequenceApi = { ...api, tick: () => tick, deploy: ids => { calls.push(['deploy', ids]); return true; } };
const task = { ...garrison, ids: [soldier.id] };
const preparation = executeSpecial(sequenceApi, task);
assert.equal(preparation.phase, 'preparing');
const taskMemory = { specialOrders: new Map() };
rememberSpecial(taskMemory, task, preparation, tick);
const before = calls.length;
tick += 30;
maintainSpecial(sequenceApi, taskMemory, () => {});
assert.equal(calls.length, before, 'do not enter until deployment state actually changes');
soldier.isDeployed = false;
maintainSpecial(sequenceApi, taskMemory, () => {});
assert.equal(calls.length, before + 1);
const events = [];
building.garrison.unitIds = [soldier.id];
maintainSpecial(sequenceApi, taskMemory, e => events.push(e));
assert.equal(events[0].result, 'completed');
assert.equal(taskMemory.specialTasks.length, 0);
console.log('composed special task waits for real stance and container state');

// The carrier must remain reserved too, otherwise rally/traffic/defense moves cancel boarding.
const carrier = own.find(u => u.id === load.targetId);
carrier.transport.occupied = 0;
carrier.transport.unitIds = [];
calls.length = 0;
tick += 200;
const boarding = executeSpecial(sequenceApi, load);
assert.deepEqual(calls[0], [[carrier.id], { type: api.OrderType.Stop }]);
assert.equal(boarding.accepted, true);
rememberSpecial(taskMemory, load, boarding, tick);
assert.ok(taskMemory.specialOrders.has(carrier.id), 'reserve carrier before later decisions execute');
tick += 500;
maintainSpecial(sequenceApi, taskMemory, () => {});
assert.equal(taskMemory.specialOrders.get(carrier.id).tick, tick, 'keep the carrier reserved for the whole task');
assert.ok(calls.filter(c => c[1]?.type === api.OrderType.EnterTransport).length === 2, 'retry idle passengers after a cancelled entry');
const reservedGroups = {};
specialGroups(sequenceApi, catalog, snapshot, taskMemory, reservedGroups);
assert.ok(!reservedGroups.transport.actions[`load_${carrier.id}`], 'do not offer another load for the reserved carrier');
carrier.transport.unitIds = [...load.ids];
carrier.transport.occupied = 1;
maintainSpecial(sequenceApi, taskMemory, e => events.push(e));
assert.equal(events.at(-1).result, 'completed');
assert.ok(!taskMemory.specialOrders.has(carrier.id));
assert.ok(load.ids.every(id => !taskMemory.specialOrders.has(id)));

carrier.transport.unitIds = [];
carrier.transport.occupied = 0;
rememberSpecial(taskMemory, load, boarding, tick);
maintainSpecial(sequenceApi, taskMemory, () => {});
carrier.hitPoints -= 1;
tick += 20;
maintainSpecial(sequenceApi, taskMemory, e => events.push(e));
assert.equal(events.at(-1).result, 'interrupted');
assert.ok(!taskMemory.specialOrders.has(carrier.id), 'a carrier under fire must return to normal combat control');
assert.equal(taskMemory.specialTasks.length, 0);
console.log('transport boarding reserves both participants, retries idle entry and releases on completion or damage');

// Accepted force-fire must not be confused with effective bridge damage.
let bridgeTile = { rx: 18, ry: 10, bridge: { id: 90, hitPoints: 100, maxHitPoints: 100 } };
const bridgeApi = { ...sequenceApi, map: { ...api.map, tile: () => bridgeTile } };
own.find(u => u.id === 32).onBridge = false;
const demolition = { type: 'special', kind: 'demolish_bridge', ids: [32],
  order: { type: api.OrderType.ForceAttack, target: { x: 18, y: 10, onBridge: true } } };
const bridgeMemory = {};
const attempt = executeSpecial(bridgeApi, demolition);
assert.equal(attempt.accepted, true);
rememberSpecial(bridgeMemory, demolition, attempt, tick);
tick += 150;
maintainSpecial(bridgeApi, bridgeMemory, e => events.push(e));
assert.equal(bridgeMemory.specialOrders.get(32).tick, tick);
tick += 150;
maintainSpecial(bridgeApi, bridgeMemory, e => events.push(e));
assert.equal(events.at(-1).result, 'no_damage_progress');
assert.ok(bridgeMemory.bridgeRetryAfter.get('90:TANK') > tick);
assert.ok(!bridgeMemory.specialOrders.has(32));
assert.deepEqual(calls.at(-1), [[32], { type: api.OrderType.Stop }]);

rememberSpecial(bridgeMemory, demolition, attempt, tick);
tick += 250;
bridgeTile.bridge.hitPoints = 50;
maintainSpecial(bridgeApi, bridgeMemory, e => events.push(e));
tick += 250;
maintainSpecial(bridgeApi, bridgeMemory, e => events.push(e));
assert.equal(bridgeMemory.specialTasks.length, 1, 'actual damage renews the progress window');
bridgeTile = { rx: 18, ry: 10 };
maintainSpecial(bridgeApi, bridgeMemory, e => events.push(e));
assert.equal(events.at(-1).result, 'completed');

bridgeTile = { rx: 18, ry: 10, bridge: { id: 90, hitPoints: 100 } };
rememberSpecial(bridgeMemory, demolition, executeSpecial(bridgeApi, demolition), tick);
bridgeTile = undefined;
maintainSpecial(bridgeApi, bridgeMemory, e => events.push(e));
assert.equal(events.at(-1).result, 'lost_visibility', 'unseen terrain is not proof of destruction');
bridgeTile = { rx: 18, ry: 10, bridge: { id: 90, hitPoints: 100 } };
rememberSpecial(bridgeMemory, demolition, executeSpecial(bridgeApi, demolition), tick);
own.find(u => u.id === 32).onBridge = true;
assert.equal(executeSpecial(bridgeApi, demolition).reason, 'friendly_on_bridge', 'recheck friendly positions at execution time');
maintainSpecial(bridgeApi, bridgeMemory, e => events.push(e));
assert.equal(events.at(-1).result, 'friendly_on_bridge');
const alliedGuard = { ...bridgeApi, units: relation => relation === 'allied' ? [own.find(u => u.id === 32)] : relation === 'self' ? own.filter(u => u.id !== 32) : api.units(relation) };
assert.equal(executeSpecial(alliedGuard, demolition).reason, 'friendly_on_bridge', 'allied troops receive the same protection');
console.log('bridge tasks verify damage, stop ineffective attempts, protect friendlies and distinguish fog from destruction');
