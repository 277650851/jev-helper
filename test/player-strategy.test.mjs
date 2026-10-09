import assert from 'node:assert/strict';
import { collectState, candidateGroups } from '../src/player/werhd-jev-player.mjs';
import { chooseBuildingSite, isAirSupport, effectiveness } from '../src/player/werhd-jev-strategy.mjs';

const catalog = {
  YARD: { yard: true, factory: 'BuildingType' }, POWER: { power: 200, cost: 800 },
  REF: { refinery: true }, MINER: { harvester: true }, BARRACKS: { factory: 'InfantryType' },
  FACTORY: { factory: 'UnitType' },
  TANK: { category: 'AFV', cost: 750, techLevel: 2, weapon: { damage: 65, rof: 50, range: 5, ag: true, verses: [0.2, 0.2, 0.2, 1, 1, 1] } },
  ENEMY: { armor: 'heavy', weapon: { damage: 65, rof: 30, range: 6 } },
  PILL: { isBaseDefense: true, cost: 500, weapon: { damage: 15, rof: 26, range: 5, ag: true, verses: [1, 1, 1, 0.4, 0.3, 0.3] } },
  GUN: { isBaseDefense: true, cost: 1500, power: -25, techLevel: 8, weapon: { damage: 100, rof: 40, range: 9, ag: true, verses: [1,1,1,1,1,1] } },
  WALL: { wall: true, cost: 100 },
  AIRFIELD: { buildCategory: 'Tech', factory: 'AircraftType', techLevel: 3, cost: 1000, power: -50 },
  REPAIR: { buildCategory: 'Tech', numberOfDocks: 1, techLevel: 6, cost: 800 },
  LAB: { buildCategory: 'Tech', techLevel: 8, cost: 2000, power: -100 },
};
for (const [name, rule] of Object.entries(catalog)) rule.label = name;
const u = (id, name, type, x = 30, y = 30) => ({ id, name, type, tile: { rx: x, ry: y }, hitPoints: 100, maxHitPoints: 100, isIdle: true, primaryWeapon: catalog[name]?.weapon });
let tick = 2000, credits = 1600;
let own = [u(1,'YARD',2),u(2,'POWER',2,26,30),u(3,'REF',2,30,35),u(4,'MINER',7),u(5,'BARRACKS',2),u(6,'FACTORY',2),u(7,'TANK',7)];
let enemies = [u(100,'ENEMY',7,42,30),u(101,'ENEMY',7,43,30),u(102,'ENEMY',7,43,31)];
let offered = { 0: ['POWER','AIRFIELD','REPAIR'], 1: ['PILL','GUN','WALL'], 2: [], 3: ['TANK'], 4: [], 5: [] };
const calls = [];
const api = {
  units: relation => relation === 'self' ? own : enemies,
  me: () => ({ credits, power: { total: 200, drain: 50 } }), tick: () => tick, time: () => tick/15,
  ObjectType: { Building: 2, Infantry: 3, Vehicle: 7, Aircraft: 1 },
  QueueType: { Structures: 0, Armory: 1, Infantry: 2, Vehicles: 3, Aircrafts: 4, Ships: 5 },
  OrderType: { DeploySelected: 10 }, ArmorType: { 5: 'Heavy' },
  map: { size: () => ({ width: 60, height: 60 }), visible: () => true, tile: (x,y) => x >= 0 && y >= 0 && x < 60 && y < 60 ? { rx:x, ry:y, landType:0 } : undefined },
  canPlace: (name,x,y) => x >= 20 && x <= 39 && y >= 20 && y <= 39 && !own.some(u=>Math.hypot(u.tile.rx-x,u.tile.ry-y)<2),
  order: (...args) => calls.push(args),
  production: { queues: () => Array.from({length:6},(_,type)=>({type,size:0,maxSize:99,items:[]})),
    available: q => (q === undefined ? Object.values(offered).flat() : offered[q] ?? []).map(name=>({name,type:[0,1].some(k=>offered[k].includes(name))?2:7})) },
};
const memory = {};
let snap = collectState(api,catalog), groups = candidateGroups(api,catalog,snap,memory);
assert.ok(snap.state.strategy.suppressed, 'visible armor superiority must produce a suppressed state');
assert.ok(groups.defenses.actions.produce_GUN, 'one miner is enough to offer a defensive counter during pressure');
assert.ok(!groups.defenses.actions.produce_WALL, 'a wall cannot substitute for anti-armor fire');
assert.ok(!groups.vehicles.actions.produce_TANK, 'basic tank must not consume the urgent defensive budget');
assert.ok(groups.defenses.actions.produce_GUN.placement.x > 30, 'defense must face the observed attack, not the rear');
assert.ok(effectiveness(catalog.GUN,enemies,catalog,api)>effectiveness(catalog.PILL,enemies,catalog,api));
assert.equal(isAirSupport(catalog.REPAIR),false,'ground repair docks must not count as aircraft support');
assert.equal(isAirSupport(catalog.AIRFIELD),true);
assert.deepEqual(calls,[],'strategy and placement assessment must be query-only');

// After stabilizing, the radar/airfield and then laboratory must become explicit funded choices.
enemies = [];
own.push(u(8,'MINER',7),u(9,'MINER',7),u(10,'GUN',2,36,30),...Array.from({length:7},(_,i)=>u(20+i,'TANK',7)));
credits = 1800;
snap=collectState(api,catalog); groups=candidateGroups(api,catalog,snap,memory);
assert.ok(groups.construction.actions.produce_AIRFIELD);
assert.equal(snap.state.strategy.investment.name,'AIRFIELD');
assert.ok(!groups.vehicles.actions.produce_TANK,'save for technology instead of endlessly rebuilding basic tanks');
own.push(u(11,'AIRFIELD',2)); offered[0]=['POWER','REPAIR','LAB']; credits=2800;
snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,memory);
assert.ok(groups.construction.actions.produce_LAB,'laboratory must be considered after its prerequisite unlocks');
assert.equal(snap.state.strategy.investment.name,'LAB');
const rear=chooseBuildingSite(api,catalog,'LAB',own,memory);
assert.ok(rear.x<30,'vulnerable technology buildings belong behind the firing line');

credits=10000;
snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,memory);
assert.equal(snap.state.forceGoal.groundCombatVehicles.current,8);
assert.equal(snap.state.forceGoal.groundCombatVehicles.target,12);
assert.equal(snap.state.decisionReadiness.vehicles.waitingSupported,false,'rich idle factory below force target must be clearly actionable');
assert.ok(snap.state.decisionReadiness.vehicles.affordableCandidates.includes('TANK'));
assert.match(groups.vehicles.instructions,/12 ground combat vehicles/);
assert.match(snap.state.objective,/destroying the enemy base/);

// Two existing short-range guns are not a hard cap on a later useful defense.
own.push(u(12,'PILL',2,22,22),u(13,'PILL',2,23,22));
enemies=[u(100,'ENEMY',7,42,30),u(101,'ENEMY',7,43,30),u(102,'ENEMY',7,43,31)]; tick+=600;
snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,memory);
assert.ok(groups.defenses.actions.produce_GUN,'obsolete rear pillboxes must not block further counters');

// A destroyed refinery must outrank new tanks/technology, and liquidation can restore cash flow.
catalog.REF.cost=2000; catalog.REF.label='Refinery';
own=own.filter(u=>u.name!=='REF'); offered[0].push('REF'); credits=300;
snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,memory);
assert.equal(snap.state.strategy.investment.name,'REF');
assert.ok(Object.values(groups.salvage.actions).some(a=>a.type==='sell'&&a.objectId===11));
assert.ok(!Object.values(groups.salvage.actions).some(a=>a.type==='sell'&&a.objectId===6),'preserve the vehicle factory during recovery');
assert.ok(!Object.values(groups.vehicles.actions).some(a=>a.type==='produce'),'do not spend recovery money on tanks');
credits=700;snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,memory);
assert.ok(groups.construction.actions.recover_REF);
assert.equal(groups.construction.actions.recover_REF.auto,2,'a survival rebuild runs automatically after two declined turns');

// If construction itself is lost, the existing public rules can identify the MCV and its prerequisites.
catalog.MCV={deploysInto:'YARD',cost:3000,label:'Construction vehicle',prerequisite:['REPAIR']};
own=own.filter(u=>u.name!=='YARD');own.push(u(40,'REPAIR',2));offered[3].push('MCV');
snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,memory);
assert.ok(groups.vehicles.actions.recover_MCV);
assert.ok(!Object.values(groups.salvage.actions).some(a=>a.objectId===40),'preserve the prerequisite needed to produce the MCV');
console.log('Pressure strategy: early counter-fire, directional placement, shared budget, airfield/lab progression and query-only planning passed');

// Three turrets go around the base, not onto one side: three even sectors make a triangle. Requested
// as "以基地为中心三角放置".
{
  const savedOwn=own, savedMe=api.me;
  api.me=()=>({credits:10000,power:{total:400,drain:100}});
  const angle=(p)=>Math.atan2(p.y-30,p.x-30);
  const apart=(a,b)=>{let d=Math.abs(a-b);return d>Math.PI?2*Math.PI-d:d;};
  own=[u(1,'YARD',2,30,30)];
  const s1=chooseBuildingSite(api,catalog,'GUN',own,{},200);
  assert.ok(s1,'a turret site is found');
  own.push(u(90,'GUN',2,s1.x,s1.y));
  const s2=chooseBuildingSite(api,catalog,'GUN',own,{},200);
  own.push(u(91,'GUN',2,s2.x,s2.y));
  const s3=chooseBuildingSite(api,catalog,'GUN',own,{},200);
  const a1=angle(s1),a2=angle(s2),a3=angle(s3);
  assert.ok(apart(a1,a2)>Math.PI/3,`the second turret takes another sector, not the first one's (${Math.round(apart(a1,a2)*180/Math.PI)} deg apart)`);
  assert.ok(apart(a1,a3)>Math.PI/3 && apart(a2,a3)>Math.PI/3,'the three turrets end up spread around the base, not clustered');
  for(const s of [s1,s2,s3]) assert.ok(Math.hypot(s.x-30,s.y-30)>=4,'each turret stands off the base, covering an approach');
  own=savedOwn; api.me=savedMe;
  console.log('Defense layout: turrets spread around the base in a triangle');
}

// The opening follows the game's own AI: power, then barracks, then refinery. A barracks early turns
// the first credits into something that can defend; a refinery only widens income.
{
  const savedOwn=own,savedCredits=credits,savedOffered=offered,savedEnemies=enemies,savedMe=api.me;
  // The fixture reports a fixed 200/50 supply, so the "no power plant" branch could never fire.
  // Report what the base actually has: 200 per power plant, 50 drain per building.
  api.me=()=>({credits,power:{total:200*own.filter(x=>catalog[x.name]?.power>0).length,drain:25*own.filter(x=>x.type===2).length}});
  catalog.REF.cost=2000;catalog.BARRACKS.cost=500;catalog.FACTORY.cost=2000;
  offered={ 0:['POWER','REF','FACTORY','BARRACKS','AIRFIELD'], 1:['PILL','GUN'], 2:[], 3:['MINER','TANK'], 4:[], 5:[] };
  enemies=[];credits=20000;
  const pick=()=>{
    const s=collectState(api,catalog),g=candidateGroups(api,catalog,s,{});
    return Object.keys(g.construction.actions).filter(k=>k.startsWith('produce_')).map(k=>k.slice(8)).sort();
  };
  // 1. A fresh base: power first, and the refinery is not forced ahead of it.
  own=[u(1,'YARD',2)];
  assert.deepEqual(pick(),['POWER'],'a base with no power plants builds power first');
  // 2. Power up: the barracks comes before the refinery.
  own=[u(1,'YARD',2),u(2,'POWER',2,26,30)];
  assert.deepEqual(pick(),['BARRACKS'],'a barracks is the second building, ahead of the refinery');
  // 3. Power and barracks up: the refinery follows.
  own=[u(1,'YARD',2),u(2,'POWER',2,26,30),u(5,'BARRACKS',2,32,30)];
  assert.deepEqual(pick(),['REF'],'the refinery is the third building');
  // 4. And the vehicle factory after that. The refinery supplies a miner, so the base is no longer
  //    in an income outage and the ordinary ordering applies.
  own=[u(1,'YARD',2),u(2,'POWER',2,26,30),u(5,'BARRACKS',2,32,30),u(3,'REF',2,30,35),{...u(60,'MINER',7),isIdle:false}];
  assert.deepEqual(pick(),['FACTORY'],'the vehicle factory follows the refinery');
  // 5. Losing the refinery is different: that is an outage, and its rebuild is forced.
  own=own.filter(x=>x.name!=='REF');
  const lost=collectState(api,catalog),lostGroups=candidateGroups(api,catalog,lost,{seenRefinery:true});
  assert.equal(lost.state.strategy.recovery,true,'a refinery that was lost is an outage');
  assert.ok(lostGroups.construction.actions.recover_REF,'and its rebuild is offered as recovery');
  // ...but the very same base at the opening, never having had a refinery, is not an outage.
  const fresh=collectState(api,catalog),freshGroups=candidateGroups(api,catalog,fresh,{});
  assert.notEqual(fresh.state.strategy.recovery,true,'a refinery that was never built is not an outage');
  assert.ok(!freshGroups.construction.actions.recover_REF,'and nothing forces it ahead of the opening');
  own=savedOwn;credits=savedCredits;offered=savedOffered;enemies=savedEnemies;api.me=savedMe;
  console.log('Opening order: power, barracks, refinery, factory — a lost refinery is still recovered');
}

// An intact refinery cannot generate income after the last miner dies.
catalog.MINER.cost=1400;catalog.MINER.label='Miner';
own=own.filter(u=>u.name!=='MINER');own.push(u(50,'YARD',2),u(51,'REF',2));offered[3].push('MINER');credits=0;
snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,memory);
assert.equal(snap.state.strategy.investment.name,'MINER');
assert.equal(snap.state.strategy.reserve,1400);
assert.match(snap.state.strategy.intent,/恢复矿车/);
assert.ok(Object.values(groups.salvage.actions).some(a=>a.type==='sell'&&a.objectId===11));
assert.ok(!Object.values(groups.salvage.actions).some(a=>a.objectId===6||a.objectId===51),'preserve the refinery and miner factory');

// Battle 12: a peaceful two-miner base repeatedly bought tanks, never reaching the naval economy gate.
// Economy targets now follow the situation: two refineries with steady credits justify a third miner.
own.push(u(52,'REF',2,34,35),{...u(60,'MINER',7),isIdle:false},{...u(61,'MINER',7),isIdle:false}); credits=2000; enemies=[];
snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,{});
assert.equal(snap.state.strategy.investment.name,'MINER','miner expansion must outrank discretionary technology');
assert.ok(groups.vehicles.actions.produce_MINER);
assert.ok(!groups.vehicles.actions.produce_TANK,'do not spend the reserved miner budget on armor');
assert.equal(snap.state.decisionReadiness.vehicles.priority,'economy');
assert.match(groups.vehicles.instructions,/ECONOMY FIRST/);
assert.doesNotMatch(groups.vehicles.criteria.produce_MINER,/Build-up deficit/,'miners are not combat reinforcements');
const idleQueues=api.production.queues;
api.production.queues=()=>idleQueues().map(q=>q.type===0?{...q,size:1,items:[{name:'REF',quantity:1,creditsEach:2000,creditsSpent:1500}]}:q);
snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,{});
assert.notEqual(snap.state.strategy.investment?.name,'MINER','a queued refinery already supplies the missing miner');
assert.ok(!groups.vehicles.actions.produce_MINER);
api.production.queues=idleQueues;

// jev-report 20261008-021015: credits reached 0 with the vehicle queue holding HOWI/BGGY/CHAR and the
// last miner still alive, so the miner was never queued; it died shortly after and the match could
// not earn another credit. The old gate was `credits >= Math.min(500, cost)` — one credit short of
// a 1400-credit miner and it would never be offered — and `!underPressure` let the miner rank below
// the army exactly when the economy was collapsing.
{
  own=own.filter(u=>u.name!=='MINER');own.push(u(50,'YARD',2),u(51,'REF',2));offered[3].push('MINER');
  enemies=[u(100,'ENEMY',7,42,30),u(101,'ENEMY',7,43,30),u(102,'ENEMY',7,43,31)];
  credits=1399;   // one short of the miner, and nothing left over for anything else
  let s=collectState(api,catalog);let g=candidateGroups(api,catalog,s,{});
  assert.equal(s.state.harvesters,0,'the fixture really has lost every miner');
  assert.equal(s.state.strategy.recovery,true,'losing every miner is an income outage, not a build choice');
  assert.equal(s.state.strategy.reserve,1400,'the price of a replacement is held back from the army');
  assert.ok(g.vehicles.actions.produce_MINER,'the replacement is offered, since it is the only income left');
  assert.equal(g.vehicles.actions.produce_MINER.cost,1400,'and it is offered at its real price');
  assert.ok(!g.vehicles.actions.produce_TANK,'no armor while the price of a miner is being held back');
  credits=1400;
  s=collectState(api,catalog);g=candidateGroups(api,catalog,s,{});
  assert.ok(g.vehicles.actions.produce_MINER,
    'with no miner at all, enough to buy one must buy one, even while the base is attacked');
  assert.match(g.vehicles.instructions,/ECONOMY FIRST/);
  assert.doesNotMatch(g.vehicles.criteria.produce_MINER,/Build-up deficit/,'a miner is not a combat unit');
  // One miner present again: the outage is over and the reserve is released.
  own.push({...u(61,'MINER',7),isIdle:false});credits=3000;
  s=collectState(api,catalog);g=candidateGroups(api,catalog,s,{});
  assert.notEqual(s.state.strategy.recovery,true,'a surviving miner ends the recovery state');
  console.log('Broken income: the last miner outranks the army and is queued as soon as it is affordable');
}
enemies=[u(100,'ENEMY',7,42,30),u(101,'ENEMY',7,43,30),u(102,'ENEMY',7,43,31)];
snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,{});
assert.notEqual(snap.state.strategy.investment?.name,'MINER','immediate pressure must retain defensive priority');
enemies=[];
own.push(u(62,'MINER',7)); credits=10000;
snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,{});
assert.notEqual(snap.state.strategy.investment?.name,'MINER','stop expanding once the miner target is met');
assert.equal(snap.state.decisionReadiness.vehicles.waitingSupported,false,'completed economy must release the army budget');
console.log('Economic priority: two-miner expansion protected, combat prompt preserved, third miner releases army budget');

// Report jev-report-20261008-021015: the money-piling fallback only tagged produce options that the
// strategy layer had already put on offer. With the last miner gone, forcePlan is gated on a miner
// count and nothing is proposed at all, so the fallback had nothing to tag and the base held 21,065
// credits with 24 idle units for 1,574 s. The fallback has to put a unit on offer itself.
{
  const savedOwn = own, savedEnemies = enemies, savedCredits = credits, savedOffered = offered;
  // One memory for the whole block, as the player keeps across decisions: it is what lets the
  // strategy tell a refinery that was lost from a base that never had one yet.
  const recMemory = {};
  // Intact refinery and factory, no miner left, army well past the force target: no economy plan
  // (the refinery cannot be fed) and no reinforcement plan (that needs miners), so vehicles is empty.
  own = [u(1,'YARD',2),u(2,'POWER',2,26,30),u(3,'REF',2,30,35),u(5,'BARRACKS',2),u(6,'FACTORY',2),
    ...Array.from({length:24},(_,i)=>u(70+i,'TANK',7))];
  enemies = []; credits = 21065;
  offered = { 0: ['POWER'], 1: ['PILL'], 2: [], 3: ['TANK'], 4: [], 5: [] };
  snap = collectState(api, catalog); groups = candidateGroups(api, catalog, snap, recMemory);
  assert.equal(snap.state.strategy.recovery, undefined, 'a refinery with no miner is not a recovery case');
  const auto = Object.entries(groups.vehicles?.actions ?? {}).find(([k, a]) => k.startsWith('auto_produce_'));
  assert.ok(auto, 'rich, idle and offered nothing: the fallback puts a combat vehicle on offer');
  assert.equal(auto[1].name, 'TANK'); assert.equal(auto[1].type, 'produce');
  assert.equal(auto[1].auto, 2, 'and it runs automatically after two declined turns');
  assert.ok(auto[1].minCredits <= 500, 'same affordability floor as every other production option');
  // A busy factory queue must not be doubled up on.
  api.production.queues = () => idleQueues().map(q => q.type === 3 ? { ...q, size: 1, items: [{ name: 'TANK', quantity: 1, creditsEach: 750, creditsSpent: 0 }] } : q);
  snap = collectState(api, catalog); groups = candidateGroups(api, catalog, snap, recMemory);
  assert.ok(!Object.keys(groups.vehicles?.actions ?? {}).some(k => k.startsWith('auto_produce_')), 'a busy factory queue is left alone');
  api.production.queues = idleQueues;
  // Recovery keeps its own budget: while income is broken the fallback must not spend it on tanks.
  own = own.filter(x => x.name !== 'REF');
  offered = { 0: ['POWER','REF'], 1: ['PILL'], 2: [], 3: ['TANK','MINER'], 4: [], 5: [] };
  catalog.REF.cost = 2000;
  snap = collectState(api, catalog); groups = candidateGroups(api, catalog, snap, recMemory);
  assert.equal(snap.state.strategy.recovery, true, 'a refinery that was lost is a recovery case');
  assert.ok(!Object.values(groups.vehicles?.actions ?? {}).some(a => a?.type === 'produce'), 'recovery money is not spent on armor');
  assert.equal(groups.construction.actions.recover_REF?.auto, 2, 'an affordable rebuild is still automatic');
  // With no money at all the rebuild cannot be offered, so the only way back is selling something.
  credits = 0;
  snap = collectState(api, catalog); groups = candidateGroups(api, catalog, snap, recMemory);
  assert.ok(!groups.construction.actions.recover_REF, 'an unaffordable rebuild is not offered');
  const sell = Object.entries(groups.salvage?.actions ?? {}).find(([k, a]) => k.startsWith('recover_sell_'));
  assert.ok(sell, 'the only way back is selling a building');
  assert.equal(sell[1].auto, 2, 'selling to fund recovery runs automatically after two declined turns');
  own = savedOwn; enemies = savedEnemies; credits = savedCredits; offered = savedOffered;
  console.log('Idle money and broken income: a combat unit is offered when nothing is, a busy queue is left alone, and the sell that funds recovery is automatic');
}

// Battle 28: repeated static spending left no mobile response to enemies flanking the base.
own=[u(1,'YARD',2),u(2,'POWER',2,26,30),u(3,'REF',2,30,35),u(5,'BARRACKS',2),u(6,'FACTORY',2),
  u(60,'MINER',7),u(61,'MINER',7),u(62,'MINER',7),u(70,'PILL',2,22,22),u(71,'PILL',2,23,22)];
enemies=[u(100,'ENEMY',7,42,30),u(101,'ENEMY',7,43,30),u(102,'ENEMY',7,43,31)]
  .map(e=>({...e,primaryWeapon:{...e.primaryWeapon,range:4}}));
offered={0:['POWER','AIRFIELD','LAB'],1:['PILL','GUN'],2:[],3:['TANK'],4:[],5:[]};
credits=1600;
snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,{});
assert.equal(snap.state.strategy.investment.name,'TANK','two rear guns must not monopolize the missing mobile-defense budget');
assert.equal(snap.state.strategy.investment.purpose,'counter_pressure');
assert.ok(groups.vehicles.actions.produce_TANK);
assert.ok(!groups.defenses.actions.produce_GUN,'the third expensive gun must leave money for the first mobile counter');
assert.ok(!groups.construction.actions.produce_AIRFIELD,'do not start optional technology before the missing mobile response');
assert.equal(snap.state.decisionReadiness.vehicles.waitingSupported,false);

api.production.queues=()=>idleQueues().map(q=>q.type===3?{...q,size:1,items:[{name:'TANK',quantity:1,creditsEach:750,creditsSpent:100}]}:q);
credits=1200;
snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,{});
assert.equal(snap.state.strategy.investment.name,'TANK');
assert.equal(snap.state.strategy.investment.pending,true);
assert.equal(snap.state.strategy.investment.cost,650,'reserve the unfinished cost of the combat vehicle');
assert.equal(snap.state.decisionReadiness.vehicles.waitingSupported,true,'a busy counter queue may wait while it completes');
assert.ok(!Object.values(groups.defenses.actions).some(a=>a.type==='produce'),'small discretionary towers must not starve an existing mobile queue either');
assert.ok(!groups.construction.actions.produce_AIRFIELD);
api.production.queues=idleQueues;

own=own.filter(unit=>unit.name!=='PILL');credits=1600;
snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,{});
assert.equal(snap.state.strategy.investment.name,'GUN','the first useful emergency gun remains available before two static defenses exist');
assert.ok(groups.defenses.actions.produce_GUN);

// No usable mobile counter is different from a counter waiting for funds: allow technology to unlock one.
enemies=enemies.map(e=>({...e,tile:{rx:40,ry:30},primaryWeapon:{...e.primaryWeapon,range:10}}));
offered[3]=[];offered[1]=[];credits=2000;
snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,{});
assert.equal(snap.state.strategy.investment.name,'AIRFIELD');
assert.ok(groups.construction.actions.produce_AIRFIELD,'absent mobile counters must not make the technology gate impossible');
console.log('Mobile defense budget: two guns release funds to mobile counters, queued counters retain funds, first gun and necessary technology remain possible');

// Battle 30: six vehicles stayed below the attack gate while optional towers/tech kept spending.
enemies=[];offered[1]=['PILL','GUN'];offered[3]=['TANK'];
own.push(u(70,'PILL',2,22,22),u(71,'PILL',2,23,22),...Array.from({length:6},(_,i)=>u(80+i,'TANK',7)));
credits=1600;snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,{});
assert.equal(snap.state.strategy.investment.name,'TANK');
assert.equal(snap.state.strategy.investment.purpose,'mobilize');
assert.equal(snap.state.forceGoal.attackThreshold,8);
assert.ok(groups.vehicles.actions.produce_TANK);
assert.ok(!groups.construction.actions.produce_AIRFIELD,'six vehicles cannot be trapped indefinitely below the eight-vehicle attack gate by optional investments');

credits=200;snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,{});
assert.equal(snap.state.strategy.investment.name,'TANK','the plan exists before enough starting cash arrives');
assert.equal(snap.state.decisionReadiness.vehicles.waitingSupported,true);
// No enemy is in sight. The defense question is still asked while the base sits below its defensive
// floor with a barracks standing (one turret exists, three are wanted), but the protected army
// investment is not disturbed: it is asserted just above and the turret is filtered by its reserve.
assert.ok(groups.defenses,'a barracks below the defensive floor keeps asking for a turret');
assert.ok(!groups.defenses.actions.produce_GUN,'the reserved tank budget is not spent on another turret');
credits=250;snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,{});
assert.ok(groups.vehicles.actions.produce_TANK,'the same reserved unit becomes executable when starting cash arrives');
assert.equal(snap.state.decisionReadiness.vehicles.waitingSupported,false);

api.production.queues=()=>idleQueues().map(q=>q.type===3?{...q,size:1,items:[{name:'TANK',quantity:1,creditsEach:750,creditsSpent:100}]}:q);
credits=1200;snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,{});
assert.equal(snap.state.strategy.investment.pending,true,'protect the assembling force even between attacks');
assert.equal(snap.state.strategy.investment.cost,650);
assert.equal(snap.state.strategy.investment.purpose,'mobilize');
api.production.queues=idleQueues;
own.push(u(86,'TANK',7),u(87,'TANK',7));credits=1800;
snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,{});
assert.equal(snap.state.strategy.investment.name,'AIRFIELD','finishing the attack force releases the technology budget');
console.log('Force budget: six-to-eight assembly, low-cash reservation, peaceful queued production and subsequent technology release passed');

// Battle 36: generic armor scoring locked the wallet to short-range anti-unit tanks
// even after the enemy's steel-armored, longer-range towers became visible.
own=own.filter(u=>u.id!==86&&u.id!==87);
catalog.TANK={...catalog.TANK,cost:1000,weapon:{damage:100,rof:70,range:7,ag:true,verses:[1,1,.8,1,1,1,.3,.2,.2]}};
catalog.SIEGE={label:'Siege',category:'AFV',cost:1200,weapon:{damage:100,rof:100,range:10,ag:true,verses:[1,1,1,.75,.5,.5,2,2,2]}};
catalog.FORT={label:'Fort',armor:'steel',isBaseDefense:true,weapon:{damage:120,range:8,rof:60,ag:true}};
api.ArmorType={...api.ArmorType,7:'Steel',Steel:7};
offered[3]=['TANK','SIEGE'];credits=500;enemies=[];
snap=collectState(api,catalog);candidateGroups(api,catalog,snap,{});
assert.equal(snap.state.strategy.investment.name,'TANK','retain general-purpose armor when no fortification is observed');
enemies=[u(300,'FORT',2,55,55)];
snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,{});
assert.equal(snap.state.baseUnderAttack,false,'distant fortifications must not become base pressure');
assert.equal(snap.state.strategy.investment.name,'SIEGE','visible tower armor and range must inform the funded attack force');
assert.equal(snap.state.strategy.investment.targetRole,'fortifications');
assert.ok(groups.vehicles.actions.produce_SIEGE,'siege counter can start using the shared minimum budget');
assert.ok(!groups.vehicles.actions.produce_TANK,'the generic tank cannot consume the siege investment');
assert.match(groups.vehicles.criteria.produce_SIEGE,/fortifications/);
enemies=[];
snap=collectState(api,catalog);candidateGroups(api,catalog,snap,{});
assert.equal(snap.state.strategy.investment.name,'TANK','a catalog entry alone is not evidence that a fortification is visible');
console.log('Siege budget: visible fortified targets use building armor and range without extending base pressure or reading hidden targets');

// Battle 37: eight vehicles with only one mobile AA escort could not leave the base,
// while the budget planner released their missing escort funds to discretionary tech.
catalog.AA={label:'Escort',category:'Transport',cost:850,weapon:{damage:25,range:6,rof:30,aa:true,ag:true}};
catalog.AIR={label:'Air enemy',armor:'none',weapon:{damage:20,range:5,rof:30,ag:true}};
own.push(u(86,'TANK',7),u(88,'AA',7));
offered[3]=['TANK','SIEGE','AA'];enemies=[{...u(301,'AIR',3,55,55),zone:1}];credits=500;
snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,{});
assert.equal(snap.state.forceGoal.groundCombatVehicles.current,8);
assert.deepEqual(snap.state.forceGoal.mobileAntiAir,{current:1,attackMinimum:2});
assert.equal(snap.state.baseUnderAttack,false);
assert.equal(snap.state.strategy.investment.name,'AA');
assert.equal(snap.state.strategy.escortDeficit,1);
assert.ok(groups.vehicles.actions.produce_AA,'fund the missing attack prerequisite below its full purchase cost');
assert.ok(!groups.construction.actions.produce_AIRFIELD,'optional technology must not indefinitely block the missing escort');
api.production.queues=()=>idleQueues().map(q=>q.type===3?{...q,size:1,items:[{name:'AA',quantity:1,creditsEach:850,creditsSpent:100}]}:q);
snap=collectState(api,catalog);candidateGroups(api,catalog,snap,{});
assert.equal(snap.state.strategy.investment.pending,true);
assert.equal(snap.state.strategy.investment.cost,750,'protect the escort already in production even with eight vehicles');
api.production.queues=idleQueues;
own.push(u(89,'AA',7));credits=1800;
snap=collectState(api,catalog);candidateGroups(api,catalog,snap,{});
assert.equal(snap.state.strategy.escortDeficit,0);
assert.equal(snap.state.strategy.investment.name,'AIRFIELD','meeting the actual attack requirements releases discretionary technology');
console.log('Escort readiness: complete vehicle count still protects missing and queued mobile AA; technology releases after the escort gate');

// Battle 42: armed AirPower vehicles share the factory queue, but do not
// count toward the eight-ground-vehicle attack gate. Repeated helicopters
// must not be funded as the missing eighth ground vehicle.
own=own.filter(unit=>unit.name!=='AA'&&unit.id!==86);
own.push(u(86,'TANK',7));
catalog.HELI={label:'Armed carrier',category:'AirPower',cost:900,weapon:{damage:500,range:6,rof:10,ag:true,verses:[1,1,1,1,1,1,1,1,1]}};
offered[3]=['TANK','HELI'];enemies=[];credits=10000;api.production.queues=idleQueues;
snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,{});
assert.equal(snap.state.forceGoal.groundCombatVehicles.current,7);
assert.equal(snap.state.strategy.investment.name,'TANK','an excellent airborne weapon still cannot fill a ground-force slot');
assert.ok(groups.vehicles.actions.produce_TANK);
assert.ok(!groups.vehicles.actions.produce_HELI,'spare money cannot let a competing shared-queue action postpone the reserved reinforcement');
api.production.queues=()=>idleQueues().map(q=>q.type===3?{...q,size:1,items:[{name:'HELI',quantity:1,creditsEach:900,creditsSpent:100}]}:q);
snap=collectState(api,catalog);candidateGroups(api,catalog,snap,{});
assert.notEqual(snap.state.strategy.investment?.purpose,'mobilize','an already queued helicopter is not falsely reported as a ground reinforcement');
api.production.queues=idleQueues;own.push(u(87,'TANK',7));
snap=collectState(api,catalog);groups=candidateGroups(api,catalog,snap,{});
assert.ok(groups.vehicles.actions.produce_HELI,'airborne options remain available when the ground-force prerequisite is satisfied');
console.log('Ground queue: airborne vehicles cannot fill or indefinitely delay the required ground force');

// The defence question is assembled by two layers: special.mjs offers walls and strongpoints, then
// strategy.mjs adds counter-weapons. strategy.mjs used to do that with a wholesale
// `groups.defenses = {...}` reassignment, which silently deleted everything the first layer had put
// there -- the walls were unreachable and no test noticed, because each module's own test calls only
// that module. This drives the real pipeline and requires both layers' options to survive.
{
  const dcatalog = {
    YARD: { yard: true, factory: 'BuildingType' }, POWER: { power: 200, cost: 800 },
    REF: { refinery: true }, MINER: { harvester: true }, BARRACKS: { factory: 'InfantryType' },
    FACTORY: { factory: 'UnitType' }, TANK: { category: 'AFV', cost: 750, weapon: { damage: 65, range: 5, ag: true } },
    PILL: { isBaseDefense: true, cost: 500, label: 'Pillbox', weapon: { damage: 15, range: 5, ag: true } },
    WALL: { wall: true, cost: 100, label: 'Wall' },
  };
  const du = (id, name, type, x = 30, y = 30) => ({ id, name, type, tile: { rx: x, ry: y }, hitPoints: 100, maxHitPoints: 100, isIdle: true, primaryWeapon: dcatalog[name]?.weapon });
  const down = [du(1,'YARD',2),du(2,'POWER',2,26,30),du(3,'REF',2,30,35),du(4,'MINER',7),du(5,'MINER',7),du(6,'BARRACKS',2),du(7,'FACTORY',2)];
  const dapi = {
    units: relation => relation === 'self' ? down : [],
    me: () => ({ credits: 10000, power: { total: 200, drain: 50 } }), tick: () => 4000, time: () => 100,
    ObjectType: { Building: 2, Infantry: 3, Vehicle: 7, Aircraft: 1 },
    QueueType: { Structures: 0, Armory: 1, Infantry: 2, Vehicles: 3, Aircrafts: 4, Ships: 5 },
    OrderType: { DeploySelected: 10 }, ArmorType: { 5: 'Heavy' },
    map: { size: () => ({ width: 60, height: 60 }), visible: () => true, tile: (x,y) => x >= 0 && y >= 0 && x < 60 && y < 60 ? { rx:x, ry:y, landType:0 } : undefined },
    canPlace: (name,x,y) => x >= 20 && x <= 39 && y >= 20 && y <= 39 && !down.some(u=>Math.hypot(u.tile.rx-x,u.tile.ry-y)<2),
    order: () => {}, crates: () => [],
    production: { queues: () => Array.from({length:6},(_,type)=>({type,size:0,maxSize:99,items:[]})),
      available: q => (q === 1 ? ['PILL','WALL'] : q === 3 ? ['TANK'] : []).map(name => ({name, type: q === 1 ? 2 : 7})) },
  };
  const dsnap = collectState(dapi, dcatalog);
  const dgroups = candidateGroups(dapi, dcatalog, dsnap, {});
  assert.ok(dgroups.defenses.actions.produce_WALL,
    'the special layer offers walls and the strategy layer must not delete them');
  assert.ok(dgroups.defenses.actions.produce_PILL, 'the strategy layer still adds its counter-weapon');
  const dchoices = Object.keys(dgroups.defenses.actions).filter(k => k !== 'wait');
  assert.ok(dchoices.length <= 5, `one multiple-choice question must stay small; got ${dchoices.join(', ')}`);
}

