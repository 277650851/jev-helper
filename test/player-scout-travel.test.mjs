import test from 'node:test';
import assert from 'node:assert/strict';
import { world, home, infantry, catalog } from './commander-world.mjs';
import { collectState, candidateGroups, SCOUT_TRAVEL_TICKS } from '../src/player/werhd-jev-player.mjs';

// A scout already on its way must not be asked about again. Measured over ten real reports, the `scouting`
// group with `explore_` candidates was 1342 of 4696 group-questions (29% of the whole decision budget), the
// model took 14 of them, and the mission's age at the moment of asking had a median of 1031 ticks -- while
// the window that suppressed re-asking was 450. So the engine re-asked every turn for the rest of the trip,
// and the model answered `wait`, which is what the question's own criterion tells it to do.
const worldWithMission = ({ since, ids, target = { x: 20, y: 140 } }) => {
  // `visible` must actually hide something: the shared world defaults it to `() => true`, which leaves the
  // whole map revealed, and then `frontierPoints` returns no frontier at all -- so a test that only asserts
  // "no explore option" passes whether the suppression works or the fog does not exist. Home is clear, the
  // rest of the map is fog, which is the state the question is asked in.
  const w = world({ own: [...home(), ...infantry(10, 4, 60, 52)], tick: 12000, visible: (x, y) => Math.hypot(x - 100, y - 120) < 25 });
  w.memory.mission = { mode: 'explore', label: '前沿侦察', ids, x: target.x, y: target.y, since };
  return w;
};
const groupsFor = (w) => candidateGroups(w.api, catalog, collectState(w.api, catalog), w.memory);
const exploreKeys = (g) => Object.keys(g?.scouting?.actions ?? {}).filter((k) => k.startsWith('explore_'));

test('a scout still travelling is not asked about again, even far past the old 450-tick window', () => {
  const w = worldWithMission({ since: 12000 - 1000, ids: [10] });
  const groups = groupsFor(w);
  assert.deepEqual(exploreKeys(groups), [], 'no frontier may be offered while the scout is en route');
  assert.equal(w.memory.mission.since, 11000, 'the mission is untouched');
});

test('the unanswered condition is published, so the criterion can be evaluated', () => {
  // The question's `wait` criterion is "a scout is already moving", and that fact is NOT in `activeMission`:
  // a scout sent while the army attacks lives in `memory.scoutMission`. `state.scoutMoving` is the field the
  // criterion names, and it has to be true exactly when the engine is suppressing the question.
  const travelling = worldWithMission({ since: 12000 - 1000, ids: [10] });
  const snap = collectState(travelling.api, catalog);
  candidateGroups(travelling.api, catalog, snap, travelling.memory);
  assert.equal(snap.state.scoutMoving, true);

  const arrived = worldWithMission({ since: 12000 - SCOUT_TRAVEL_TICKS - 1, ids: [10] });
  const snap2 = collectState(arrived.api, catalog);
  candidateGroups(arrived.api, catalog, snap2, arrived.memory);
  assert.equal(snap2.state.scoutMoving, false, 'past the horizon the scout counts as stuck, not travelling');
});

test('once the window has passed, or the scout is gone, the frontiers are offered again', () => {
  // Stuck past the horizon: the old 450-tick behaviour was guarding this case, so it must keep working.
  const stuck = worldWithMission({ since: 12000 - SCOUT_TRAVEL_TICKS - 1, ids: [10] });
  assert.ok(exploreKeys(groupsFor(stuck)).length > 0, 'a scout that never arrives must not silence scouting');

  // Dead scout: `explorers` is empty, so the group is offered on the same turn rather than waiting out a
  // horizon that only exists for a live unit.
  const dead = worldWithMission({ since: 12000 - 10, ids: [9999] });
  assert.ok(exploreKeys(groupsFor(dead)).length > 0, 'a dead scout must not suppress the question');
});

test('the wait criterion names the field the model can actually read', () => {
  const w = worldWithMission({ since: 12000 - SCOUT_TRAVEL_TICKS - 1, ids: [10] });
  const groups = groupsFor(w);
  const wait = groups.scouting.criteria.wait;
  assert.match(wait, /scoutMoving/);
  // The clause that used to be there was vacuously false in the branch it appeared in: the text only said
  // "or the enemy base has already been discovered" when the engine had already established it had not.
  assert.doesNotMatch(wait, /already been discovered/);
});
