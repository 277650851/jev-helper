import assert from 'node:assert/strict';
import { splitEngineOwned, requestGroupsFrom, MAX_REQUESTED_GROUPS } from '../src/player/werhd-jev-player.mjs';

// Some options are not questions. When a producer has already established every premise of a decision --
// the money is idle, the army is below its cap, the queue is empty, the unit is affordable -- the model
// cannot improve on the answer, and measured on three real matches the only thing it expressed about
// questions of that shape was `wait`, 47-61% of the time. `splitEngineOwned` lifts those options out of
// the request: the engine executes them and says so in the log.
//
// These tests pin the boundary, because the cost of getting it wrong is asymmetric: lifting a real choice
// silently takes the decision away from the model, while leaving a determined one in costs a wasted turn.

const criteria = (keys) => Object.fromEntries(keys.map((k) => [k, 'c']));
const group = (keys, engineOwned) => ({ instructions: 'i', criteria: criteria(keys), engineOwned });

// 1. A single engine-owned option is lifted, and its group disappears from the request: with only `wait`
//    left there is nothing to ask.
{
  const { asked, owned } = splitEngineOwned({ vehicles: group(['wait', 'produce_MTNK'], { produce_MTNK: true }) });
  assert.deepEqual(owned, [{ id: 'vehicles', choice: 'produce_MTNK' }]);
  assert.equal(asked.vehicles, undefined, 'a group reduced to wait alone is not sent');
}

// 2. With a genuine alternative the question stays with the model, even when one option is engine-owned:
//    the engine must not answer a question that has a real choice in it.
{
  const g = group(['wait', 'produce_MTNK', 'produce_FV'], { produce_MTNK: true });
  const { asked, owned } = splitEngineOwned({ vehicles: g });
  assert.deepEqual(owned, [], 'nothing is lifted while a real choice remains');
  assert.equal(asked.vehicles.criteria.produce_MTNK, 'c', 'and the option is left in place');
  assert.equal(asked.vehicles.criteria.produce_FV, 'c');
}

// 3. A group with no engine-owned option is untouched, including the pinned ones.
{
  const groups = { construction: group(['wait', 'produce_GAPOWR']), tactics: group(['wait', 'assault_9', 'defend_base']) };
  const { asked, owned } = splitEngineOwned(groups);
  assert.deepEqual(owned, []);
  assert.deepEqual(Object.keys(asked), ['construction', 'tactics']);
  assert.deepEqual(Object.keys(asked.tactics.criteria), ['wait', 'assault_9', 'defend_base']);
}

// 4. Engine ownership is per option, and only the marked one is lifted if it is the only real option.
{
  const a = splitEngineOwned({ infantry: group(['wait', 'produce_E1'], { produce_GI: true }) });
  assert.deepEqual(a.owned, [], 'a mark for an option that is not offered does nothing');
  const b = splitEngineOwned({ infantry: group(['wait', 'produce_E1'], { produce_E1: true }) });
  assert.deepEqual(b.owned, [{ id: 'infantry', choice: 'produce_E1' }]);
}

// 5. The request shape carries the marks. `splitEngineOwned` reads them off the request, so a producer that
//    marks an action but a selection step that drops the mark would silently disable the whole mechanism.
{
  const groups = {
    vehicles: { instructions: 'i', criteria: criteria(['wait', 'produce_MTNK']), actions: { wait: { type: 'wait' }, produce_MTNK: { type: 'produce', name: 'MTNK', engineOwned: true } } },
    infantry: { instructions: 'i', criteria: criteria(['wait', 'produce_E1']), actions: { wait: { type: 'wait' }, produce_E1: { type: 'produce', name: 'E1' } } },
  };
  const request = requestGroupsFrom(groups, {}, 0);
  assert.deepEqual(request.vehicles.engineOwned, { produce_MTNK: true }, 'the mark survives selection');
  assert.deepEqual(request.infantry.engineOwned, {}, 'an unmarked group carries an empty map');
  const { asked, owned } = splitEngineOwned(request);
  assert.deepEqual(owned, [{ id: 'vehicles', choice: 'produce_MTNK' }]);
  assert.deepEqual(Object.keys(asked), ['infantry']);
}

// 6. The whole selection still behaves: wait-only groups are dropped and the cap holds, with marks carried
//    for whatever survives. This is the pipeline a match runs, end to end and without a game.
{
  const mk = (keys, marked) => ({ instructions: 'i', criteria: criteria(keys), actions: Object.fromEntries(keys.map((k) => [k, k === 'wait' ? { type: 'wait' } : { type: 'produce', name: k, ...(marked?.includes(k) ? { engineOwned: true } : {}) }])) });
  const groups = {
    construction: mk(['wait', 'produce_GAPOWR'], ['produce_GAPOWR']),
    defenses: mk(['wait', 'produce_GAPILL']),
    tactics: mk(['wait']),                          // wait-only: never sent
    salvage: mk(['wait', 'recover_sell_1']),
    vehicles: mk(['wait', 'produce_MTNK']),
    infantry: mk(['wait', 'produce_E1', 'produce_GGI']),
    scouting: mk(['wait', 'explore_1_1']),
    garrison: mk(['wait', 'occupy_5']),
    transport: mk(['wait', 'load_3']),
    engineering: mk(['wait', 'capture_7']),
  };
  const request = requestGroupsFrom(groups, {}, 0);
  assert.ok(!('tactics' in request), 'a group with only wait is never requested');
  assert.ok(Object.keys(request).length <= MAX_REQUESTED_GROUPS, 'the cap holds');
  const { asked, owned } = splitEngineOwned(request);
  assert.deepEqual(owned, [{ id: 'construction', choice: 'produce_GAPOWR' }]);
  assert.ok(!('construction' in asked), 'the engine-owned group is gone from the model request');
  for (const g of Object.values(asked)) assert.ok(Object.keys(g.criteria).length > 1, 'every sent group still has something to choose');
}
console.log('Engine-owned options: lifted only when they are the group\'s single real choice, carried through selection, and never left as a wait-only question');
