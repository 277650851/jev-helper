import test from 'node:test';
import assert from 'node:assert/strict';
import { world, home, infantry, u, T, catalog } from './commander-world.mjs';
import { collectState, candidateGroups, SCOUT_PARTY, SCOUT_ROUTES, SCOUT_TRAVEL_TICKS } from '../src/player/werhd-jev-player.mjs';

// Scouting was one unit walking to one frontier, offered as two options that carried the same unit id.
// Two things are pinned here: the frontier is walked by a party (one dog is killed before it reports
// anything, and the reveal is the whole point), and two frontiers can be walked at once -- which needs the
// gate to count live routes instead of silencing the group the moment one unit leaves. The frontier a route
// is already walking is still never offered again: that is the §0.50 fix (1342 of 4696 questions were this
// group re-asking one frontier), and it is what keeps the second route a different direction.
const scene = ({ own, enemies = [], scoutMissions, tick = 12000 } = {}) => {
  // The map has to be dark for `frontierPoints` to have anything to offer: the shared world reveals
  // everything by default, and a test that asserts on explore options would then pass on an empty set.
  const w = world({ own, enemies, tick, visible: (x, y) => Math.hypot(x - 100, y - 120) < 25 });
  if (scoutMissions) w.memory.scoutMissions = scoutMissions;
  return w;
};
const groupsFor = (w) => candidateGroups(w.api, catalog, collectState(w.api, catalog), w.memory);
const explore = (w) => groupsFor(w)?.scouting?.actions ?? {};
const exploreKeys = (w) => Object.keys(explore(w)).filter((k) => k.startsWith('explore_'));
const pointOf = (key) => key.slice('explore_'.length).split('_').map(Number);
const crew = () => [...home(), ...infantry(10, 6, 60, 52)];

test('a frontier is walked by a party, not by one unit', () => {
  const own = crew();
  const w = scene({ own, enemies: [u(900, 'HTNK', T.Vehicle, 40, 40)] });
  const actions = explore(w);
  const keys = Object.keys(actions).filter((k) => k.startsWith('explore_'));
  assert.ok(keys.length, 'with the enemy known the map still has frontiers');
  const party = actions[keys[0]].ids;
  assert.equal(party.length, SCOUT_PARTY, `a party, not a lone unit (got ${party.length})`);
  assert.equal(new Set(party).size, party.length, 'and no unit listed twice');
  for (const id of party) assert.ok(own.some((x) => x.id === id && x.isIdle && x.type === T.Infantry), `#${id} is a spare idle infantry`);
  assert.match(groupsFor(w).scouting.criteria[keys[0]], new RegExp(`Scout with ${SCOUT_PARTY} units`));
});

test('two frontier options carry different units, so both directions can be walked at once', () => {
  const w = scene({ own: crew(), enemies: [u(900, 'HTNK', T.Vehicle, 40, 40)] });
  const actions = explore(w);
  const keys = Object.keys(actions).filter((k) => k.startsWith('explore_'));
  assert.equal(keys.length, SCOUT_ROUTES, `both routes are offered (${keys})`);
  const [a, b] = keys.map((k) => actions[k].ids);
  assert.equal(a.length, SCOUT_PARTY);
  assert.equal(b.length, SCOUT_PARTY);
  assert.equal(a.filter((id) => b.includes(id)).length, 0, 'no unit is offered to two frontiers');
});

test('a frontier a route is already walking is not offered again, but the second route opens', () => {
  const target = { x: 40, y: 40 };
  const w = scene({ own: crew(), enemies: [u(900, 'HTNK', T.Vehicle, 40, 40)], scoutMissions: [{ mode: 'explore', ids: [10], x: target.x, y: target.y, since: 12000 - 100 }] });
  const actions = explore(w);
  const keys = Object.keys(actions).filter((k) => k.startsWith('explore_'));
  assert.ok(keys.length, 'one route out of two still leaves the other direction to walk');
  for (const k of keys) {
    const [x, y] = pointOf(k);
    assert.ok(Math.hypot(x - target.x, y - target.y) >= 7, `${k} does not re-offer the frontier being walked`);
    assert.ok(!actions[k].ids.includes(10), 'and the unit already walking is not offered again');
  }
});

test('once both routes are out, nothing is asked until one of them ends', () => {
  const live = (since) => [
    { mode: 'explore', ids: [10], x: 40, y: 40, since },
    { mode: 'explore', ids: [11], x: 60, y: 60, since: 12000 - 100 },
  ];
  const walking = scene({ own: crew(), enemies: [u(900, 'HTNK', T.Vehicle, 40, 40)], scoutMissions: live(12000 - 100) });
  assert.deepEqual(exploreKeys(walking), [], 'both routes are walking, so there is nothing to ask');
  // Past the horizon a route is stuck rather than travelling, and its slot opens again -- the case the old
  // 450-tick window existed for.
  const stuck = scene({ own: crew(), enemies: [u(900, 'HTNK', T.Vehicle, 40, 40)], scoutMissions: live(12000 - SCOUT_TRAVEL_TICKS - 1) });
  assert.ok(exploreKeys(stuck).length > 0, 'an expired route frees its slot');
});

test('while the enemy base is unknown the engine keeps one route and owns it, and that route is still a party', () => {
  const w = scene({ own: crew(), enemies: [] });
  const actions = explore(w);
  const keys = Object.keys(actions).filter((k) => k.startsWith('explore_'));
  // One option, no question: asking a multiple-choice model to rank two frontiers that differ only in
  // coordinates is the thing that made scouting 29% of the decision budget, and it is what `engineOwned`
  // here closed. The party is what compensates for having a single direction to walk.
  assert.equal(keys.length, 1, 'one frontier, no question about which');
  assert.equal(actions[keys[0]].engineOwned, true);
  assert.equal(actions[keys[0]].ids.length, SCOUT_PARTY);
});

test('a unit already on a special task is not spare', () => {
  const own = crew();
  const w = scene({ own, enemies: [u(900, 'HTNK', T.Vehicle, 40, 40)] });
  w.memory.specialTasks = [{ action: { ids: [10] } }];
  const actions = explore(w);
  const keys = Object.keys(actions).filter((k) => k.startsWith('explore_'));
  assert.ok(keys.length, 'the rest of the pool still scouts');
  for (const k of keys) assert.ok(!actions[k].ids.includes(10), 'a unit on a special task is not offered');
});
