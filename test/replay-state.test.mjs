import assert from 'node:assert/strict';
import { CATALOG, SCENARIOS, SCENARIO_NAMES } from '../src/synthetic-state.mjs';
import { replayApi, optionsOf } from '../src/replay-state.mjs';
import { collectState, candidateGroups, requestGroupsFrom, MAX_REQUESTED_GROUPS } from '../src/player/werhd-jev-player.mjs';
import { classifyQuestion } from '../src/report-audit.mjs';

// The offline benchmark is only worth having if it is trustworthy, and there are three ways it could lie:
// by replaying a state into something the engine cannot use (empty result reading as "no problems"), by
// measuring groups the match never sends, or by drifting away from the selection the match actually runs.
// These tests pin all three.

// 1. Every scenario replays into a state the engine accepts, and the rebuilt state agrees with the
//    scenario about the things the group logic reads.
for (const name of SCENARIO_NAMES) {
  const state = SCENARIOS[name]();
  const api = replayApi(state, { ...CATALOG });
  const snap = collectState(api, { ...CATALOG });
  assert.equal(snap.state.self.credits, state.credits, `${name}: credits survive the rebuild`);
  assert.deepEqual(snap.state.self.power, state.power, `${name}: power survives the rebuild`);
  assert.equal(snap.state.harvesters, state.harvesters, `${name}: the harvester count survives`);
  // `state.army` is the COMBAT army: collectState filters harvesters and engineers out of it, so the
  // expectation is that same subset, not every unit in the scenario.
  const combat = (state.army ?? []).filter((x) => {
    const r = CATALOG[x.kind] ?? {};
    return x.type !== 2 && !r.harvester && !r.engineer && !CATALOG[r.deploysInto]?.yard;
  });
  assert.equal(snap.state.army.length, combat.length, `${name}: every combat unit is rebuilt`);
  assert.equal(snap.state.visibleEnemies.length, (state.visibleEnemies ?? []).length, `${name}: every visible enemy is rebuilt`);
  assert.ok(snap.state.base, `${name}: a base resolves, or every distance based rule silently degrades`);
  // Buildings are only known as counts, so each one is checked against the rebuilt inventory. The
  // inventory also counts non-buildings, hence checking per kind rather than comparing a total.
  for (const [kind, entry] of Object.entries(state.inventory ?? {})) {
    assert.equal(snap.state.inventory[kind]?.count, entry.count, `${name}: ${kind} x${entry.count} is rebuilt`);
  }
  // The enemy list must keep its composition: a count alone is what this whole exercise exists to fix.
  for (const e of snap.state.visibleEnemies) {
    assert.ok(e.kind, `${name}: an enemy keeps its internal id`);
    assert.ok(e.type, `${name}: and its object type, so the list splits by kind`);
  }
}

// 2. The benchmark measures the questions a match would send, not every group the engine can build.
//    Wait-only groups are the difference, and on the scenarios they are the majority of raw groups.
{
  const state = SCENARIOS.midgame_armour();
  const api = replayApi(state, { ...CATALOG });
  const catalog = { ...CATALOG };
  const groups = candidateGroups(api, catalog, collectState(api, catalog), {});
  const raw = Object.keys(groups);
  const sent = Object.keys(requestGroupsFrom(groups, {}, api.tick()));
  const waitOnly = raw.filter((id) => Object.keys(groups[id].criteria).length <= 1);
  assert.ok(waitOnly.length > 0, 'the scenarios must contain wait-only groups, or this test proves nothing');
  assert.ok(sent.length < raw.length, 'the filter must remove them');
  for (const id of sent) assert.ok(Object.keys(groups[id].criteria).length > 1, `${id} was sent with nothing to choose`);
  for (const id of waitOnly) assert.ok(!sent.includes(id), `${id} has only wait and must not be sent`);
  assert.ok(sent.length <= MAX_REQUESTED_GROUPS, 'the request is capped');
}

// 3. Selection is ordered so the groups whose answers matter most go out first, and the cap is a cap:
//    with more groups available than slots, the four pinned ones must survive.
{
  const mk = (criteria) => ({ instructions: 'i', criteria: Object.fromEntries(criteria.map((k) => [k, 'c'])), actions: {} });
  const groups = {
    construction: mk(['wait', 'a']), defenses: mk(['wait', 'a']), tactics: mk(['wait', 'a']), salvage: mk(['wait', 'a']),
    vehicles: mk(['wait', 'a']), infantry: mk(['wait', 'a']), scouting: mk(['wait', 'a']),
    garrison: mk(['wait', 'a']), transport: mk(['wait', 'a']), engineering: mk(['wait', 'a']),
  };
  const sent = Object.keys(requestGroupsFrom(groups, {}, 0));
  assert.equal(sent.length, MAX_REQUESTED_GROUPS);
  for (const id of ['construction', 'defenses', 'tactics', 'salvage'])
    assert.ok(sent.includes(id), `${id} is pinned and must be sent even when the list is over the cap`);
}

// 4. The benchmark's own scoring is the shared one, so a group with one real option is classed the same
//    way the report audit classes it: that is what makes the two tables comparable.
{
  const state = SCENARIOS.late_fortified();
  const api = replayApi(state, { ...CATALOG });
  const sent = optionsOf(requestGroupsFrom(candidateGroups(api, { ...CATALOG }, collectState(api, { ...CATALOG }), {}), {}, api.tick()));
  for (const opts of Object.values(sent)) assert.equal(classifyQuestion(opts), opts.filter((k) => k !== 'wait').length === 1 ? 'forced' : (opts.filter((k) => k !== 'wait').length <= 3 ? 'narrow' : 'open'));
  assert.ok(Object.keys(sent).length > 0, 'the late scenario must produce questions');
}

// 5. A scenario that cannot be replayed must raise rather than return nothing: an empty question set is
//    the most flattering possible result and therefore the most dangerous one to report silently.
{
  assert.throws(() => replayApi(null, { ...CATALOG }), 'a null state must not be replayed as an empty base');
}
console.log('Replay harness: scenarios round-trip, the sent set is filtered and capped, and scoring is shared with the report audit');
