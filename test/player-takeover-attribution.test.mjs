import assert from 'node:assert/strict';
import { collectTakeovers, engineOwnedMarks, askableGroups, requestGroupsFrom, takeoverEvent } from '../src/player/werhd-jev-player.mjs';

// A match report has to answer one question about every order: did the ENGINE decide this, or did the MODEL?
// That is the whole point of the takeover work, and a report that cannot answer it cannot be used to check
// whether the work helped.
//
// `reason` names the decider. It used to be overwritten with `execution.reason` when the order was refused,
// so an engine takeover that then failed on a busy queue was logged as `queue_changed` and the attribution
// -- the most important fact about the entry -- was gone. The executor's own reason now travels separately.

// 1. The takeover collector labels each decision with who made it, and the label is stable regardless of
//    whether the order will later succeed.
{
  const actions = { wait: { type: 'wait' }, produce_TANK: { type: 'produce', name: 'TANK', engineOwned: true } };
  const groups = { vehicles: { instructions: 'i', criteria: { wait: 'c', produce_TANK: 'c' }, actions } };
  const marks = engineOwnedMarks(groups);
  const owned = collectTakeovers(groups, null, marks, {}, 0);
  assert.deepEqual(owned.map((t) => [t.id, t.reason, t.owned]), [['vehicles', 'engine_decided', true]],
    'an owned option is taken by the engine and says so');

  const autoActions = { wait: { type: 'wait' }, capture_7: { type: 'mission', mode: 'capture', auto: 1 } };
  const autoGroups = { engineering: { instructions: 'i', criteria: { wait: 'c', capture_7: 'c' }, actions: autoActions } };
  const t = collectTakeovers(autoGroups, { engineering: { choice: 'wait' } }, {}, {}, 0);
  assert.deepEqual(t.map((x) => [x.id, x.reason]), [['engineering', 'auto_engineering']],
    'a decline-based fallback says which it was');

  // The scouting fallback keeps its own name, which the reports already rely on.
  const scoutActions = { wait: { type: 'wait' }, explore_1_1: { type: 'mission', mode: 'explore', auto: 1 } };
  const scoutGroups = { scouting: { instructions: 'i', criteria: { wait: 'c', explore_1_1: 'c' }, actions: scoutActions } };
  assert.deepEqual(collectTakeovers(scoutGroups, { scouting: { choice: 'wait' } }, {}, {}, 0).map((x) => x.reason), ['auto_explore']);
}

// 2. The two labels a report needs are disjoint and complete: every takeover is either `engine_decided` or
//    an `auto_*` name, so counting them never double-counts and never misses.
{
  const groups = {
    vehicles: { instructions: 'i', criteria: { wait: 'c', produce_TANK: 'c' }, actions: { wait: { type: 'wait' }, produce_TANK: { type: 'produce', name: 'TANK', engineOwned: true } } },
    engineering: { instructions: 'i', criteria: { wait: 'c', capture_7: 'c' }, actions: { wait: { type: 'wait' }, capture_7: { type: 'mission', mode: 'capture', auto: 1 } } },
  };
  const marks = engineOwnedMarks(groups);
  const all = collectTakeovers(groups, { engineering: { choice: 'wait' } }, marks, {}, 0);
  assert.equal(all.length, 2);
  for (const t of all) assert.match(t.reason, /^engine_decided$|^auto_/, `${t.id}: ${t.reason} is one of the two labels`);
  assert.equal(new Set(all.map((t) => t.id)).size, 2, 'one takeover per group');
}

// 3. The request the model is sent excludes exactly the groups the engine takes outright, so the log and the
//    request agree about who was asked. (A group reduced to `wait` alone is not a question.)
{
  const groups = {
    vehicles: { instructions: 'i', criteria: { wait: 'c', produce_TANK: 'c' }, actions: { wait: { type: 'wait' }, produce_TANK: { type: 'produce', name: 'TANK', engineOwned: true } } },
    tactics: { instructions: 'i', criteria: { wait: 'c', assault_9: 'c', defend_base: 'c' }, actions: { wait: { type: 'wait' }, assault_9: { type: 'mission', mode: 'attack' }, defend_base: { type: 'mission', mode: 'defend' } } },
  };
  const request = requestGroupsFrom(groups, {}, 0);
  const asked = askableGroups(request);
  assert.ok(!('vehicles' in asked), 'the engine-owned group is not asked');
  assert.ok('tactics' in asked, 'a group with a real choice is');
}
console.log('Takeover attribution: `reason` names the decider (engine_decided or auto_*), never the refusal that followed');

// 4. The event shape itself. The end-to-end path cannot be made to refuse a takeover reliably -- every
//    engine-owned option in the harness is either accepted or not offered at all -- so the shape is pinned
//    here, where the whole point can be stated exactly: an accepted order carries its attribution, and a
//    refused one carries BOTH the attribution and the refusal.
{
  const action = { type: 'produce', name: 'TANK' };
  const accepted = takeoverEvent({ id: 'vehicles', choice: 'produce_TANK', action, execution: { accepted: true }, reason: 'engine_decided', owned: true, tick: 5, sourceTick: 5 });
  assert.equal(accepted.reason, 'engine_decided', 'an accepted takeover names the engine');
  assert.equal(accepted.rejectedBecause, undefined, 'and has nothing to explain');
  assert.equal(accepted.engineOwned, true, 'the engine-owned marker survives');
  assert.equal(accepted.auto, true, 'and it is marked automatic');

  const refused = takeoverEvent({ id: 'vehicles', choice: 'produce_TANK', action, execution: { accepted: false, reason: 'queue_changed' }, reason: 'engine_decided', owned: true, tick: 5, sourceTick: 5 });
  assert.equal(refused.reason, 'engine_decided', 'a REFUSED takeover still names the engine');
  assert.equal(refused.rejectedBecause, 'queue_changed', 'and the refusal reason travels beside it');
  assert.notEqual(refused.reason, 'queue_changed', 'the attribution is not overwritten by the refusal');

  // The same for the decline-based fallbacks, which are attributed by name.
  const auto = takeoverEvent({ id: 'scouting', choice: 'explore_1_1', action: { type: 'mission' }, execution: { accepted: false, reason: 'unit_gone' }, reason: 'auto_explore', tick: 5, sourceTick: 5 });
  assert.equal(auto.reason, 'auto_explore');
  assert.equal(auto.rejectedBecause, 'unit_gone');
  assert.equal(auto.engineOwned, undefined, 'a decline-based fallback is not marked engine-owned');
}
console.log('Takeover events: accepted and refused takeovers both keep the decider, with the refusal in its own field');
