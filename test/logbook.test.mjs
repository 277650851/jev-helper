import test from 'node:test';
import assert from 'node:assert/strict';
import {decisionEntry,eventEntry,appendEntries,trimMatchEntries,logStats,stateSummary,refusalReason,LOG_MAX_ENTRIES,LOG_MAX_CHARS,MATCH_LOG_MAX_CHARS} from '../src/logbook.mjs';

const state={tick:5400,gameSeconds:360,self:{credits:8450,power:{total:500,drain:375}},uncommittedCredits:6650,committedCredits:1800,ownArmyCount:18,mobileTankCount:8,antiAirCount:4,harvesters:3,averageArmyHealth:.86,visibleEnemyCount:9,nearbyEnemyCount:3,baseUnderAttack:true,queues:[{type:0,items:[{name:'GATECH',quantity:1}]}],inventory:{MTNK:{count:8,name:'灰熊坦克'}},army:Array.from({length:24},(_,i)=>({id:i,tile:{rx:i,ry:i}})),visibleEnemies:[{id:1,tile:{rx:1,ry:1}}],strategy:{investment:{category:'construction',name:'GATECH'}}};
const questions={construction:{type:'choice',instructions:'x'.repeat(1000),criteria:{wait:'Wait only if unnecessary.',produce_GAPOWR:'y'.repeat(500)}},tactics:{type:'choice',instructions:'Keep a mission',criteria:{wait:'Wait',attack_enemy_base:'Attack'}}};
const answers={construction:{type:'choice',choice:'wait',confidence:.39,probabilities:{wait:.72,produce_GAPOWR:.28}},tactics:{type:'choice',choice:'attack_enemy_base',confidence:.99,probabilities:{attack_enemy_base:1,wait:0}}};

test('decision entries keep the question, the answer and a numeric state summary, never unit lists or secrets',()=>{
  const e=decisionEntry({at:1,tick:5400,provider:'local',model:'laya-multilingual-mlx',latencyMs:181,usage:{input_tokens:900},state:{...state,apiKey:'leak'},questions,answers});
  assert.equal(e.kind,'decision');assert.equal(e.state.credits,8450);assert.equal(e.state.army,18);assert.equal(e.state.baseUnderAttack,true);assert.deepEqual(e.state.inventory,{MTNK:8});
  assert.equal(e.groups.construction.choice,'wait');assert.equal(e.groups.construction.optionCount,2);assert.equal(e.groups.construction.instructions.length,400);assert.equal(e.groups.construction.options.produce_GAPOWR.length,240);
  assert.equal(e.groups.tactics.probabilities.attack_enemy_base,1);
  const json=JSON.stringify(e);assert.doesNotMatch(json,/leak|"tile"|rx/);assert.ok(json.length<3000);
  assert.equal(stateSummary({}).credits,null);assert.deepEqual(stateSummary({}).queues,[]);
});
test('player events are reduced to typed records and observations are dropped',()=>{
  const a=eventEntry({kind:'action',tick:10,question:'vehicles',choice:'produce_MTNK',accepted:true,action:{type:'produce',name:'MTNK',cost:700},confidence:.8,latencyMs:150,ageTicks:2},5);
  assert.deepEqual(a,{at:5,kind:'action',tick:10,question:'vehicles',choice:'produce_MTNK',accepted:true,reason:'',actionType:'produce',actionName:'MTNK',cost:700,confidence:.8,latencyMs:150,ageTicks:2});
  // The page marks a fallback the extension executed on its own; it has to survive into the log,
  // because tools/analyze-log.mjs counts those and the data panel lists them.
  const auto=eventEntry({kind:'action',tick:12,question:'scouting',choice:'explore',accepted:true,auto:true,reason:'auto_explore',action:{type:'move'}},6);
  assert.equal(auto.auto,true);assert.equal(auto.reason,'auto_explore');
  assert.equal('auto' in eventEntry({kind:'action',choice:'wait',accepted:true,reason:'wait',action:{type:'wait'}},1),false,'no flag on a normal action');
  assert.equal(eventEntry({kind:'action',choice:'wait',accepted:false,reason:'wait',action:{type:'wait'}},1).reason,'wait');
  assert.equal(eventEntry({kind:'observation',state:{}},1),null);assert.equal(eventEntry({kind:'stop',reason:'battle_ended'},1).reason,'battle_ended');
  assert.equal(eventEntry({kind:'error',message:'m'.repeat(500)},1).message.length,240);assert.equal(eventEntry({kind:'place',name:'GAPOWR',purpose:'base_development'},1).text,'base_development');
});
test('the log is bounded by entry count and by serialized size',()=>{
  const many=appendEntries([],Array.from({length:LOG_MAX_ENTRIES+50},(_,i)=>({at:i,kind:'action'})));
  assert.equal(many.length,LOG_MAX_ENTRIES);assert.equal(many[0].at,50);
  const big=appendEntries([],Array.from({length:400},(_,i)=>({at:i,kind:'decision',pad:'x'.repeat(20000)})));
  assert.ok(JSON.stringify(big).length<=LOG_MAX_CHARS);assert.ok(big.length<400);assert.equal(big.at(-1).at,399);
});
test("one match's own log gets a far smaller budget, because 100 of them are stored side by side",()=>{
  assert.ok(MATCH_LOG_MAX_CHARS<LOG_MAX_CHARS);
  const entries=Array.from({length:400},(_,i)=>({at:i,kind:'decision',pad:'x'.repeat(20000)}));
  // The shared log keeps far more of this than the per-match copy does.
  assert.ok(trimMatchEntries(entries).length<appendEntries([],entries).length);
  const kept=trimMatchEntries(entries);
  assert.ok(JSON.stringify(kept).length<=MATCH_LOG_MAX_CHARS,`${JSON.stringify(kept).length} <= ${MATCH_LOG_MAX_CHARS}`);
  assert.equal(kept.at(-1).at,399,'the newest entries are the ones kept');
  assert.ok(trimMatchEntries([]).length===0);
  // 100 matches at the per-match bound stay within what unlimitedStorage is meant to cover.
  assert.ok(100*MATCH_LOG_MAX_CHARS<100_000_000);
});
test('statistics count decisions, wait rates per group, accepted and skipped actions and failures',()=>{
  const entries=[
    {at:1,kind:'session',event:'start'},{at:1,kind:'start',tick:1},
    decisionEntry({at:2,tick:1,provider:'local',model:'laya',latencyMs:100,usage:{},state,questions,answers}),
    decisionEntry({at:3,tick:2,provider:'local',model:'laya',latencyMs:300,usage:{},state,questions,answers:{...answers,construction:{...answers.construction,choice:'produce_GAPOWR'}}}),
    {at:4,kind:'action',question:'construction',choice:'produce_GAPOWR',accepted:true,actionType:'produce',actionName:'GAPOWR'},
    {at:5,kind:'action',question:'tactics',choice:'attack_enemy_base',accepted:false,reason:'enemy_no_longer_visible',actionType:'attack'},
    {at:6,kind:'action',question:'vehicles',choice:'wait',accepted:false,reason:'wait',actionType:'wait'},
    {at:7,kind:'failure',error:'timeout'},{at:8,kind:'stale'},{at:9,kind:'outcome',result:'victory'},
  ];
  const s=logStats(entries);
  assert.equal(s.entries,entries.length);assert.equal(s.sessions,1);assert.equal(s.decisions,2);assert.equal(s.failures,1);assert.equal(s.stale,1);assert.equal(s.latency.avg,200);assert.equal(s.latency.max,300);
  assert.equal(s.groups.construction.asked,2);assert.equal(s.groups.construction.waits,1);assert.equal(s.groups.construction.waitRate,50);assert.equal(s.groups.construction.avgOptions,2);assert.equal(s.groups.tactics.waitRate,0);
  assert.deepEqual(s.actions,{total:3,accepted:1,skipped:1,waits:1,byType:{produce:1},skippedReasons:{enemy_no_longer_visible:1},acceptedProduce:{GAPOWR:1}});
  assert.deepEqual(s.outcomes,{victory:1});assert.deepEqual(s.providers,{local:2});
  assert.equal(logStats([]).decisions,0);assert.equal(logStats([null,{}]).entries,2);
});

test('a refused takeover is tallied by its refusal, not by the name of whoever decided it', () => {
  // `reason` names the decider (`engine_decided` / `auto_*`); the cause travels in `rejectedBecause`. Reading
  // only `reason` made the dashboard report `engine_decided` as a skip reason, which is the decider's name
  // standing in for a cause it does not describe.
  assert.equal(refusalReason({ reason: 'engine_decided', rejectedBecause: 'queue_changed' }), 'queue_changed');
  assert.equal(refusalReason({ reason: 'auto_explore', rejectedBecause: 'unit_gone' }), 'unit_gone');
  // A record written before that split overloaded `reason` with the refusal, so its cause is unknown.
  assert.equal(refusalReason({ reason: 'engine_decided' }), 'unattributed');
  assert.equal(refusalReason({ reason: 'auto_defenses' }), 'unattributed');
  // An ordinary refusal keeps its own name, and an unnamed one is still counted.
  assert.equal(refusalReason({ reason: 'enemy_no_longer_visible' }), 'enemy_no_longer_visible');
  assert.equal(refusalReason({}), '?');
  assert.equal(refusalReason(), '?', 'a missing entry does not throw');

  // And the statistic that consumes it.
  const entries = [
    { kind: 'action', accepted: false, reason: 'engine_decided', rejectedBecause: 'queue_changed' },
    { kind: 'action', accepted: false, reason: 'engine_decided' },
    { kind: 'action', accepted: false, reason: 'unit_gone' },
    { kind: 'action', accepted: true, actionType: 'produce', actionName: 'MTNK', reason: 'engine_decided' },
    { kind: 'action', accepted: false, reason: 'wait' },
  ];
  const s = logStats(entries);
  assert.deepEqual(s.actions.skippedReasons, { queue_changed: 1, unattributed: 1, unit_gone: 1 });
  assert.equal(s.actions.skipped, 3, 'the wait is not a skip');
  assert.equal(s.actions.accepted, 1);
  assert.ok(!('engine_decided' in s.actions.skippedReasons), 'the decider is never a skip reason');
});