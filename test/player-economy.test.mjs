import test from 'node:test';
import assert from 'node:assert/strict';
import { collectState, candidateGroups, economyPlan } from '../src/player/werhd-jev-player.mjs';

// Economy targets must follow income, idle miners and the credit trend, not a fixed "3 miners".
const weapon = (range, damage = 100) => ({ range, damage, rof: 40, ag: true, aa: false, verses: [1,1,1,1,1,1] });
const catalog = {
  YARD:{yard:true,cost:3000}, POWER:{power:300,cost:800}, REFINERY:{refinery:true,cost:2000}, BARRACKS:{factory:'InfantryType',cost:500}, FACTORY:{factory:'UnitType',cost:2000},
  HARV:{harvester:true,cost:1400}, TANK:{category:'AFV',cost:700,weapon:weapon(5,65)}, GI:{category:'Soldier',cost:200,weapon:weapon(4,15)},
};
for (const [name, rule] of Object.entries(catalog)) rule.label = name;
const unit = (id, name, type, x, y, extra = {}) => ({ id, name, type, tile:{rx:x,ry:y}, isIdle:true, hitPoints:100, maxHitPoints:100, primaryWeapon:catalog[name].weapon, isDeployed:false, ...extra });
function world({ own, credits, tick = 5000, ore = true, offers }) {
  const api = {
    ObjectType:{Building:2,Vehicle:7,Infantry:3,Aircraft:1}, QueueType:{Structures:0,Armory:1,Infantry:2,Vehicles:3,Aircrafts:4,Ships:5}, LandType:{Clear:0,Tiberium:9},
    units:r=>r==='self'?own:[], me:()=>({credits,power:{total:500,drain:100}}), tick:()=>tick, time:()=>tick/15,
    map:{size:()=>({width:60,height:60}),visible:()=>true,tile:(x,y)=>({rx:x,ry:y,landType:ore&&x>40?9:0})}, canPlace:()=>true,
    production:{queues:()=>Array.from({length:6},(_,type)=>({type,size:0,maxSize:99,items:[]})),available:q=>q===undefined?Object.values(offers).flat():(offers[q]??[])},
    weaponVs:()=>undefined, inRange:()=>false, attack(){}, move(){}, attackMove(){}, deploy(){return true;}, order(){return true;}, OrderType:{Move:1,Attack:2},
  };
  const memory = { frontiers:new Map(), enemyBuildings:new Map(), orders:new Map(), postureOrders:new Map(), specialOrders:new Map(), specialTargets:new Map(), plannedSites:new Map(), observedSpecial:new Map(), repairing:new Set(), lastMaintenance:tick, lastMicroReport:-1000 };
  return { api, memory };
}
const base = [unit(1,'YARD',2,10,10), unit(2,'POWER',2,12,10), unit(3,'REFINERY',2,14,12), unit(4,'BARRACKS',2,10,14), unit(5,'FACTORY',2,14,16)];
const offers = { 0:[{name:'REFINERY',type:2},{name:'POWER',type:2},{name:'FACTORY',type:2}], 3:[{name:'HARV',type:7},{name:'TANK',type:7}], 2:[{name:'GI',type:3}] };

test('with credits piling up, one miner is enough: no more miners or refineries are requested', () => {
  const own=[...base, {...unit(6,'HARV',7,30,12),isIdle:false}, unit(7,'TANK',7,16,16)];
  const { api, memory } = world({ own, credits:50000, offers });
  memory.economySamples=[{tick:3500,credits:40000,spent:0}];
  const snap=collectState(api,catalog);const groups=candidateGroups(api,catalog,snap,memory);
  const e=snap.state.economy;
  assert.equal(e.surplus,true);assert.equal(e.targetMiners,1);assert.equal(e.targetRefineries,1);assert.match(e.reason,/money is not the bottleneck/);assert.equal(e.incomeRate,Math.round(10000/1500*1000));
  assert.ok(!groups.vehicles?.actions?.produce_HARV,'no ECONOMY miner offer');
  assert.ok(!groups.construction?.actions?.produce_REFINERY,'no second refinery');
  assert.ok(groups.vehicles?.actions?.produce_TANK,'combat production is not blocked by the old two-miner rule');
  assert.match(groups.construction.instructions,/1 refinery and 1 miner/);assert.match(groups.vehicles.instructions,/1 now/);
});

test('with credits draining, mining expands toward what the refineries can feed', () => {
  const own=[...base, {...unit(6,'HARV',7,30,12),isIdle:false}];
  const { api, memory } = world({ own, credits:900, offers });
  memory.economySamples=[{tick:3500,credits:2500,spent:0}];
  const snap=collectState(api,catalog);const groups=candidateGroups(api,catalog,snap,memory);
  const e=snap.state.economy;
  assert.equal(e.starving,true);assert.equal(e.targetMiners,2);assert.match(e.reason,/falling: expand mining/);
  assert.ok(groups.vehicles?.actions?.produce_HARV,'a miner is offered as the economy step');
  assert.match(groups.vehicles.criteria.produce_HARV,/ECONOMY/);
});

test('idle miners without reachable ore stop the miner target where it is', () => {
  const own=[...base, unit(6,'HARV',7,30,12), unit(7,'HARV',7,31,12)];
  const { api, memory } = world({ own, credits:900, ore:false, offers });
  memory.economySamples=[{tick:3500,credits:2500,spent:0}];
  const snap=collectState(api,catalog);candidateGroups(api,catalog,snap,memory);
  const e=snap.state.economy;
  assert.equal(e.idleMiners,2);assert.equal(e.targetMiners,2);assert.match(e.reason,/idle without reachable ore/);
});

test('income counts what was spent, and the first refinery still comes before any miner', () => {
  const { api, memory } = world({ own:[...base], credits:2000, tick:6000, offers });
  memory.economySamples=[{tick:4500,credits:3000,spent:0}];memory.spentCredits=4000;
  const snap=collectState(api,catalog);
  const p=economyPlan(api,catalog,snap.state,memory,snap.raw.units);
  assert.equal(p.incomeRate,2000,'3000 spent plus -1000 credit change over 1500 ticks is 2000 per 1000 ticks');
  const bare=world({ own:[unit(1,'YARD',2,10,10),unit(2,'POWER',2,12,10)], credits:3000, offers });
  const s2=collectState(bare.api,catalog);const g2=candidateGroups(bare.api,catalog,s2,bare.memory);
  assert.equal(s2.state.economy.targetMiners,0);assert.equal(s2.state.economy.targetRefineries,1);assert.ok(g2.construction.actions.produce_REFINERY);
});

// Four matches in a row ended in economic_stall, and this is the shape they shared. The miner target is
// derived from the refinery count, the refinery count is pinned at 1, so the miner target is pinned at
// 2 -- and a base on two ore miners that fields twenty tanks cannot replace what it loses. In
// jev-report-20261014-233357 the army went from 18 units to 4 between the 1 000th and 1 100th second
// with 69 credits in hand: the losses arrived, and there was no income to meet them with.
//
// A credit trigger cannot fix this. By the time credits are low the army is already gone, so the signal
// has to be the one that leads: losing units faster than the base can earn the cost of replacing them.
test('losing units faster than the base can earn their cost expands the economy, while credits are still there', () => {
  const own=[...base, {...unit(6,'HARV',7,30,12),isIdle:false}, {...unit(7,'HARV',7,31,12),isIdle:false}];
  const { api, memory } = world({ own, credits:3000, tick:5000, offers });
  // 18 tanks lost over the window, 700 each = 12 600 of replacements, against 3 000 earned. The
  // samples carry `lost` because that is the shape economyPlan writes them in -- the replacement bill
  // and the income have to be measured over the same span or the comparison is meaningless.
  memory.economySamples=[{tick:3500,credits:1000,spent:0,lost:22}];
  memory.spentCredits=5000;
  memory.ledger={ownUnitsLost:40};
  const snap=collectState(api,catalog);
  const g=candidateGroups(api,catalog,snap,memory);
  const e=snap.state.economy;
  assert.equal(e.lostInWindow,18);
  assert.ok(e.outran,`the base is losing more than it earns (lost ${e.lostInWindow} units, replacement cost ${e.replacementCost}, income ${e.incomeRate})`);
  assert.ok(e.targetMiners>2,`the miner target rises past the two a single refinery can justify (got ${e.targetMiners})`);
  assert.ok(e.targetRefineries>1,`and a second refinery is asked for once the miners are not the binding constraint (got ${e.targetRefineries})`);
  assert.match(e.reason,/cannot keep up with losses/);
});

test('a base whose income keeps up with its losses is not asked to expand', () => {
  const own=[...base, {...unit(6,'HARV',7,30,12),isIdle:false}, {...unit(7,'HARV',7,31,12),isIdle:false}];
  const { api, memory } = world({ own, credits:3000, tick:5000, offers });
  // Two units lost over the window, 1 400 of replacements, against 25 000 earned: comfortably covered.
  memory.economySamples=[{tick:3500,credits:1000,spent:0,lost:10}];
  memory.spentCredits=26000;
  memory.ledger={ownUnitsLost:12};
  const snap=collectState(api,catalog);candidateGroups(api,catalog,snap,memory);
  const e=snap.state.economy;
  assert.equal(e.outran,false);
  assert.equal(e.targetRefineries,1,'a healthy base still keeps to one refinery');
});

test('a base taking no losses at all is never told to expand', () => {
  const own=[...base, {...unit(6,'HARV',7,30,12),isIdle:false}];
  const { api, memory } = world({ own, credits:800, tick:5000, offers });
  memory.economySamples=[{tick:3500,credits:2500,spent:0,lost:3}];
  memory.ledger={ownUnitsLost:3};
  const snap=collectState(api,catalog);candidateGroups(api,catalog,snap,memory);
  assert.equal(snap.state.economy.outran,false,'losing nothing is not a reason to spend on ore');
});

test('a sample written before the loss counter existed does not trigger an expansion', () => {
  // memory.economySamples lives in the session, so a build that adds `lost` meets samples without it.
  // Defaulting the window start to "no losses yet" makes the bill zero, which does nothing -- the safe
  // direction: a missing field must never be read as an emergency.
  const own=[...base, {...unit(6,'HARV',7,30,12),isIdle:false}];
  const { api, memory } = world({ own, credits:800, tick:5000, offers });
  memory.economySamples=[{tick:3500,credits:2500,spent:0}];
  memory.ledger={ownUnitsLost:30};
  const snap=collectState(api,catalog);candidateGroups(api,catalog,snap,memory);
  assert.equal(snap.state.economy.lostInWindow,0);
  assert.equal(snap.state.economy.outran,false);
});
