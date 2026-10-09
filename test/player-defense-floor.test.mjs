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

// 4. The tower CHOICE follows the visible enemy even when nothing is at the walls yet. Ranking used to be
//    gated on `underPressure`, so with no attacker in range it fell back to a generic infantry/vehicle
//    average and the visible enemy was ignored -- a base watching Kirovs approach picked a pillbox, and one
//    watching tanks could pick the anti-air tower. The floor path is exactly that situation: it builds
//    before the raid arrives, which is what a floor is for.
//
//    Coverage and placement still use only the attackers at the base: counting a tower as "covering" an
//    enemy across the map would make a base look defended, and placing against a distant enemy would try to
//    build outside the base. This test pins the ranking, not the count.
{
  const distant = (name, kind, type, n, extra) => Array.from({ length: n }, (_, i) => ({ id: 900 + i, name, kind, type, tile: { rx: 44, ry: 44 }, ...extra }));
  const shownValue = (visibleEnemies) => {
    const state = { side: 'allied', ...SCENARIOS.defense_floor(), visibleEnemies };
    const api = replayApi(state, { ...CATALOG });
    const catalog = { ...CATALOG };
    const snap = collectState(api, catalog);
    const groups = candidateGroups(api, catalog, snap, {});
    assert.equal(snap.state.strategy.underPressure, false, 'no attacker is in range: this is the peacetime path');
    const key = Object.keys(groups.defenses.actions).find((k) => k !== 'wait');
    assert.ok(key, 'a tower is still offered below the floor');
    return Number((/estimated effectiveness (\d+)/.exec(groups.defenses.criteria[key]) ?? [])[1] ?? NaN);
  };
  const nothing = shownValue([]);
  const armour = shownValue(distant('HTNK', 'HTNK', 7, 3, { armor: 'heavy' }));
  assert.ok(Number.isFinite(nothing), 'the peacetime value is printed');
  assert.ok(armour > nothing, `the visible armour raises the tower's score (${nothing} -> ${armour})`);
}
console.log('Defence floor: engine-owned only when it is the group\'s single real option, and only while a barracks stands');
console.log('Defence ranking: the tower choice follows the visible enemy even before it reaches the base');

// 6. The coverage COUNT is measured against the visible enemy, not against a generic score. The peacetime
//    branch asked `counterValue(tower, []) > 0`, the GENERIC score, which is positive for any armed tower --
//    so three pillboxes counted as covered while three Kirovs flew overhead, and the logic that tops up the
//    defences concluded there was nothing to top up.
//
//    SCOPE NOTE, stated rather than papered over: this pins the observable half only -- what the ENGINE
//    offers. The count itself is not directly observable from a candidate group (`coverage` is local), and
//    the option lists alone cannot separate the two implementations, because the special layer supplies its
//    own anti-air option from the same visible enemy. The count was therefore verified by instrumenting it:
//    with three pillboxes standing it reads 0 against aircraft and 3 against armour, where the old code read
//    3 in both. Reproducing that assertion inside the suite would require exporting a local; the honest place
//    for it is here.
{
  const nm = (x) => x?.kind ?? x?.name;
  const withTowers = (visibleEnemies) => {
    const base = SCENARIOS.defense_floor();
    const state = { ...base, visibleEnemies, credits: 4000, inventory: { ...base.inventory, GAPILL: { name: 'Pillbox', count: 3, role: '' } } };
    const api = replayApi({ side: 'allied', ...state }, { ...CATALOG });
    const catalog = { ...CATALOG };
    const snap = collectState(api, catalog);
    const groups = candidateGroups(api, catalog, snap, {});
    const built = snap.raw.buildings.filter((b) => catalog[nm(b)]?.isBaseDefense && !catalog[nm(b)]?.wall).map(nm);
    const offered = Object.keys(groups.defenses?.actions ?? {}).filter((k) => k !== 'wait').map((k) => k.replace(/^produce_/, ''));
    return { built, offered };
  };
  const kirovs = Array.from({ length: 3 }, (_, i) => ({ id: 900 + i, name: 'ZEP', kind: 'ZEP', type: 1, zone: 1, armor: 'light', tile: { rx: 44, ry: 44 } }));
  const tanks = Array.from({ length: 3 }, (_, i) => ({ id: 900 + i, name: 'HTNK', kind: 'HTNK', type: 7, armor: 'heavy', tile: { rx: 44, ry: 44 } }));

  const air = withTowers(kirovs);
  assert.equal(air.built.length, 3, 'three ground towers are standing');
  assert.ok(air.offered.some((n) => /NASAM|Patriot/i.test(n)), `an anti-air tower is offered against aircraft (${air.offered.join(',')})`);
  // The same three towers against ground armour: no anti-air tower is proposed, because nothing about the
  // threat asks for one. The two states must not be told the same story.
  const ground = withTowers(tanks);
  assert.ok(!ground.offered.some((n) => /NASAM|Patriot/i.test(n)), `and none against ground armour (${ground.offered.join(',')})`);
}
console.log('Defence coverage: measured against the visible enemy, not against a generic score');

// 5. When the defence question ends up with nothing to offer, it has to SAY WHY. Left as a bare `wait` --
//    and, before this, silently deleted -- the model reads it as "there is nothing to defend against",
//    which is the opposite of the truth when the only tower that answers the visible enemy is one the base
//    cannot pay for. The note has to survive the shared-wallet filter, which is what empties the group.
{
  const kirovs = Array.from({ length: 3 }, (_, i) => ({ id: 900 + i, name: 'ZEP', kind: 'ZEP', type: 1, zone: 1, armor: 'light', tile: { rx: 44, ry: 44 } }));
  const groupsFor = (visibleEnemies, credits) => {
    const state = { side: 'allied', ...SCENARIOS.defense_floor(), visibleEnemies, credits };
    const api = replayApi(state, { ...CATALOG });
    const catalog = { ...CATALOG };
    const snap = collectState(api, catalog);
    return { groups: candidateGroups(api, catalog, snap, {}), snap };
  };

  // 850 credits cannot buy the Patriot (1000) that answers aircraft, and the pillbox cannot reach them.
  const poor = groupsFor(kirovs, 850);
  const offered = Object.keys(poor.groups.defenses?.actions ?? {}).filter((k) => k !== 'wait');
  assert.deepEqual(offered, [], 'the only answer is unaffordable, so nothing is offered');
  assert.match(poor.groups.defenses.instructions, /not affordable yet/, 'and the question says so instead of staying silent');
  assert.match(poor.groups.defenses.instructions, /Patriot/i, 'naming the tower that would answer');
  assert.match(poor.groups.defenses.criteria.wait, /WAIT FOR NOW/, 'the wait option carries the reason too');

  // The same state with the funds available offers the Patriot rather than an admission.
  const rich = groupsFor(kirovs, 4000);
  assert.ok(Object.keys(rich.groups.defenses.actions).some((k) => /NASAM|Patriot/i.test(k)), 'with the funds, the anti-air tower is offered');

  // With no enemy visible there is nothing to admit.
  const quiet = groupsFor([], 850);
  assert.doesNotMatch(quiet.groups.defenses?.instructions ?? '', /not affordable yet|No available defence/, 'no enemy, no admission');

  // When only ground towers exist and the enemy is in the air, the truth is the other one: more static guns
  // will never answer it, so the note must say that instead of suggesting the base save up.
  const groundOnly = { ...CATALOG };
  const g2 = (() => {
    const api = replayApi({ side: 'allied', ...SCENARIOS.defense_floor(), visibleEnemies: kirovs, credits: 4000 }, { ...CATALOG });
    api.production.available = (q) => (q === api.QueueType.Armory ? [{ name: 'GAPILL', type: 2 }] : []);
    const snap = collectState(api, groundOnly);
    return candidateGroups(api, groundOnly, snap, {});
  })();
  assert.deepEqual(Object.keys(g2.defenses?.actions ?? {}).filter((k) => k !== 'wait'), [], 'no ground tower can reach aircraft');
  assert.match(g2.defenses.instructions, /cannot reach it|cannot engage/i, 'and it says the towers cannot reach, rather than to save up');
}
