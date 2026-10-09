import assert from 'node:assert/strict';
import { CATALOG, SCENARIOS } from '../src/synthetic-state.mjs';
import { replayApi } from '../src/replay-state.mjs';
import { collectState, candidateGroups, requestGroupsFrom, splitEngineOwned } from '../src/player/werhd-jev-player.mjs';

// The defensive floor is a safety minimum, not a judgement call: a barracks stands, the base is short of
// MIN_BASE_DEFENSES, the queue is idle and the tower is affordable. Every premise is established by the
// code that offers it, so the model cannot improve on the answer -- and two real matches recorded it
// refusing the only offered defence 11 times out of 11 and 16 out of 16.
//
// The floor option is offered alongside others whenever the base can afford more, and in that case it is
// correctly NOT taken away: `splitEngineOwned` only lifts an option that is the group's single real choice.

const groupsFor = (scenario) => {
  const api = replayApi({ side: 'allied', ...scenario }, { ...CATALOG });
  const catalog = { ...CATALOG };
  const snap = collectState(api, catalog);
  return { snap, groups: candidateGroups(api, catalog, snap, {}), api, catalog };
};

// 1. Below the floor with only the cheapest tower affordable: the question disappears into the engine.
{
  const { snap, groups, api, catalog } = groupsFor(SCENARIOS.defense_floor());
  assert.equal(snap.state.strategy.underPressure, false, 'this scenario is a peacetime one, or the floor is not what is being tested');
  const options = Object.keys(groups.defenses.actions).filter((k) => k !== 'wait');
  assert.deepEqual(options, ['produce_GAPILL'], `one affordable tower, got ${options.join(', ') || 'none'}`);
  assert.equal(groups.defenses.actions.produce_GAPILL.engineOwned, true, 'the floor tower is the engine\'s decision');
  const request = requestGroupsFrom(groups, {}, snap.state.tick);
  const { asked, owned } = splitEngineOwned(request);
  // Checked by membership rather than by exact list: scouting is engine-owned in the same state (no enemy
  // seen means the frontier pick is not a judgement call either), and this test is about the floor.
  assert.deepEqual(owned.filter((o) => o.id === 'defenses'), [{ id: 'defenses', choice: 'produce_GAPILL' }]);
  assert.ok(!('defenses' in asked), 'and it is not asked: the model has nothing to add');
}

// 2. With money for more than one tower the floor stays a question: taking it away would silently remove a
//    real choice about which defence to build first.
{
  const rich = { ...SCENARIOS.defense_floor(), credits: 9000 };
  const { groups, api, catalog, snap } = groupsFor(rich);
  const options = Object.keys(groups.defenses.actions).filter((k) => k !== 'wait');
  assert.ok(options.length > 1, `a rich base must have something to choose between, got ${options.join(', ')}`);
  assert.equal(groups.defenses.actions[options[0]].engineOwned, true, 'the first tower is still engine-owned');
  const request = requestGroupsFrom(groups, {}, snap.state.tick);
  const { asked, owned } = splitEngineOwned(request);
  assert.deepEqual(owned.filter((o) => o.id === 'defenses'), [], 'the floor is not lifted while a real choice remains');
  assert.ok('defenses' in asked, 'so the defences question is still asked');
}

// 3. The floor only applies while a barracks stands, so a base without one keeps the decision with the
//    model -- power and the opening come first, and this must not shortcut them.
{
  const noBarracks = {
    ...SCENARIOS.defense_floor(),
    inventory: Object.fromEntries(Object.entries(SCENARIOS.defense_floor().inventory).filter(([k]) => k !== 'GAPILE')),
  };
  const { groups, snap } = groupsFor(noBarracks);
  const options = Object.keys(groups.defenses?.actions ?? {}).filter((k) => k !== 'wait');
  for (const k of options) assert.notEqual(groups.defenses.actions[k].engineOwned, true, `${k}: no barracks, so no floor`);
  assert.equal(snap.state.strategy.underPressure, false);
}
console.log('Defence floor: engine-owned only when it is the group\'s single real option, and only while a barracks stands');
