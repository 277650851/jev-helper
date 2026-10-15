import test from 'node:test';
import assert from 'node:assert/strict';
import { world, home, infantry, u, T, catalog } from './commander-world.mjs';
import { collectState, candidateGroups, requestGroupsFrom, engineOwnedMarks, askableGroups, collectTakeovers } from '../src/player/werhd-jev-player.mjs';

// The opening, measured on jev-report-20261015-122829 (build 823d01c): the scouting group was asked 128 times
// with 115 `wait` answers, the first scout did not leave until t9584 with the base still unfound -- and by then
// 10 dogs and 11 riflemen had been produced, most of them by the ENGINE over six consecutive `wait` answers.
//
// Only the scouting half is a defect, and one condition caused it. The infantry auto is deliberate and has its own
// named regression test (`player-siege.test.mjs`: the 0.5.8 deadlock, a barracks with 57,000 credits and no war
// factory that trained nothing for 65 minutes), so gating it on "the economy is up" would put that deadlock back.
// The army was a SYMPTOM: with no enemy base found there is nothing to march on, and the engine spends on the only
// army it can build. Finding the base in the first minutes gives that army somewhere to go -- and the dog stops
// being offered at all once `needsScout` turns false, which is where 10 dogs came from.
const options = (groups, id) => Object.entries(groups[id]?.actions ?? {}).filter(([k]) => k !== 'wait');

test('the engine owns the single scout route while the enemy base is unknown, enemy unit in sight or not', () => {
  // `scoutUnowned` used to also require `enemies.length === 0`, so the moment the enemy UNIT list was non-empty
  // the engine handed its own decision back to the model -- and 90% of those answers were `wait`. It is the list,
  // not the screen: an enemy unit somewhere says nothing about where the base is. The map has to be dark for any
  // frontier to exist, which is the fixture the scout-party tests use.
  const w = world({ own: [...home(), ...infantry(10, 6, 60, 52)], enemies: [u(900, 'HTNK', T.Vehicle, 40, 40)], tick: 12000,
    visible: (x, y) => Math.hypot(x - 100, y - 120) < 25 });
  const groups = candidateGroups(w.api, catalog, collectState(w.api, catalog), w.memory);
  assert.ok((w.api.units('enemy') ?? []).length > 0, 'the enemy unit really is in the fixture');
  assert.equal(collectState(w.api, catalog).state.baseUnderAttack, false, 'and the base is not under attack');
  const routes = options(groups, 'scouting');
  assert.equal(routes.length, 1, `one frontier, not two (${routes.map(([k]) => k).join(',')})`);
  assert.equal(routes[0][1].engineOwned, true, 'and the engine owns it');
  const asked = askableGroups(requestGroupsFrom(groups, {}, 12000));
  const taken = collectTakeovers(groups, null, engineOwnedMarks(groups), {}, 12000).filter((t) => !(t.id in asked));
  assert.ok(taken.some((t) => t.id === 'scouting'), 'so it is dispatched without asking the model');
});

test('and the route is a party, so one unit dying on the way does not end the search', () => {
  const w = world({ own: [...home(), ...infantry(10, 6, 60, 52)], enemies: [], tick: 12000,
    visible: (x, y) => Math.hypot(x - 100, y - 120) < 25 });
  const routes = options(candidateGroups(w.api, catalog, collectState(w.api, catalog), w.memory), 'scouting');
  assert.equal(routes.length, 1);
  assert.ok(routes[0][1].ids.length >= 2, `the reveal is the point, so it is not a lone unit (${routes[0][1].ids.length})`);
});
