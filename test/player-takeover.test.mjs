import assert from 'node:assert/strict';
import { collectTakeovers, engineOwnedMarks, requestGroupsFrom, splitEngineOwned } from '../src/player/werhd-jev-player.mjs';

// The engine has two ways to take an option out of the model's hands, and they are one mechanism with two
// triggers: `engineOwned` (the producer established every premise, so there is no question) and `auto: N`
// (objective-critical but genuinely choosable, falling back to the engine after N declines). These used to
// be two separate scans with two counters and two places for the threshold to be read from; §3.2 recorded
// the resulting ambiguity -- the declared N and the N actually used lived in different code paths.
//
// These tests pin the unified decision, because its failure modes are quiet: a counter that never arms
// makes the fallback dead code, and a fallback that fires early takes a real choice away from the model.

const action = (extra = {}) => ({ type: 'produce', name: 'X', ...extra });
const groupOf = (actions, criteria) => ({
  instructions: 'i',
  criteria: Object.fromEntries((criteria ?? Object.keys(actions)).map((k) => [k, 'c'])),
  actions,
});
const at = (actions, ...keys) => Object.fromEntries(keys.map((k) => [k, { id: 'q', choice: k, action: actions[k] }]));

// 1. A group that was never sent, whose only real option the engine owns, is taken outright.
{
  const actions = { wait: { type: 'wait' }, produce_TANK: action({ engineOwned: true }) };
  const groups = { vehicles: groupOf(actions) };
  const marks = engineOwnedMarks(groups);
  assert.deepEqual(marks, { vehicles: { produce_TANK: true } }, 'marks are read from the batch');
  const t = collectTakeovers(groups, null, marks, {}, 0);
  assert.deepEqual(t.map((x) => [x.id, x.choice, x.reason, x.owned]), [['vehicles', 'produce_TANK', 'engine_decided', true]]);
}

// 2. The same group, sent to the model, is taken when the model answers `wait` and left alone when it
//    answers something else: handed to the model, the answer is what decides. The memory is shared, as the
//    decide loop shares it, because it also carries the once-per-turn record tested below.
{
  const actions = { wait: { type: 'wait' }, produce_TANK: action({ engineOwned: true }) };
  const groups = { vehicles: groupOf(actions) };
  const marks = engineOwnedMarks(groups);
  assert.deepEqual(collectTakeovers(groups, { vehicles: { choice: 'wait' } }, marks, {}, 0).length, 1);
  const memory = {};
  assert.deepEqual(collectTakeovers(groups, { vehicles: { choice: 'produce_TANK' } }, marks, memory, 0), [], 'the caller runs the model\'s own pick');
  assert.deepEqual(collectTakeovers(groups, { vehicles: { choice: 'produce_TANK' } }, marks, memory, 1), [], 'and again on a later tick');
}

// 3. A real alternative keeps the question: the owned option does not fire on the turn the model chooses
//    that alternative, and `collectTakeovers` never returns two things for one group.
{
  const actions = { wait: { type: 'wait' }, produce_GAPILL: action({ engineOwned: true }), produce_NASAM: action() };
  const groups = { defenses: groupOf(actions) };
  const marks = engineOwnedMarks(groups);
  const t = collectTakeovers(groups, { defenses: { choice: 'produce_NASAM' } }, marks, {}, 0);
  assert.deepEqual(t, [], 'the model picked the real alternative; the engine does not override it');
}

// 4. `auto: N` counts per option and fires on the Nth decline, not before.
{
  const actions = { wait: { type: 'wait' }, capture_7: action({ type: 'mission', mode: 'capture', auto: 2 }) };
  const groups = { engineering: groupOf(actions) };
  const memory = {};
  const answers = { engineering: { choice: 'wait' } };
  assert.deepEqual(collectTakeovers(groups, answers, {}, memory, 0), [], 'one decline is not enough');
  const second = collectTakeovers(groups, answers, {}, memory, 0);
  assert.deepEqual(second.map((x) => [x.id, x.choice, x.reason]), [['engineering', 'capture_7', 'auto_engineering']]);
  assert.equal(memory.takeoverDeclines['engineering:capture_7'], 2, 'the count is per option and survives between turns');
}

// 5. Choosing the option resets the counter, so the fallback does not fire straight after the model used it.
{
  const actions = { wait: { type: 'wait' }, capture_7: action({ type: 'mission', mode: 'capture', auto: 2 }) };
  const groups = { engineering: groupOf(actions) };
  const memory = {};
  collectTakeovers(groups, { engineering: { choice: 'wait' } }, {}, memory, 0);
  collectTakeovers(groups, { engineering: { choice: 'capture_7' } }, {}, memory, 0);
  assert.equal(memory.takeoverDeclines['engineering:capture_7'], undefined, 'a real choice clears the count');
}

// 6. Two tagged options in one group no longer let the smaller threshold speak for both: each is counted
//    under its own key, and the option with the lowest threshold is the one that fires.
{
  const actions = {
    wait: { type: 'wait' },
    objective_9: action({ type: 'mission', mode: 'attack', auto: 3 }),
    assault_9: action({ type: 'mission', mode: 'attack', auto: 2 }),
  };
  const groups = { tactics: groupOf(actions) };
  const memory = {};
  const answers = { tactics: { choice: 'wait' } };
  collectTakeovers(groups, answers, {}, memory, 0);
  const t = collectTakeovers(groups, answers, {}, memory, 0);
  assert.deepEqual(t.map((x) => x.choice), ['assault_9'], 'the smaller threshold fires');
  assert.equal(memory.takeoverDeclines['tactics:assault_9'], 2);
  assert.equal(memory.takeoverDeclines['tactics:objective_9'], 2, 'and the other keeps its own count');
}

// 7. A mission already running is not re-sent, and the count is cleared so it does not fire the moment the
//    mission ends. This is the §S8 failure mode: re-issuing a mission every turn pulled the army off the
//    enemies shooting at it.
{
  const mission = { type: 'mission', mode: 'attack', targetId: 9, x: 5, y: 5, auto: 1 };
  const actions = { wait: { type: 'wait' }, assault_9: mission };
  const groups = { tactics: groupOf(actions) };
  const memory = { mission: { mode: 'attack', targetId: 9, x: 5, y: 5 } };
  const t = collectTakeovers(groups, { tactics: { choice: 'wait' } }, {}, memory, 0);
  assert.deepEqual(t, [], 'the same mission is already running');
  assert.equal(memory.takeoverDeclines['tactics:assault_9'], undefined, 'and the count is cleared');
}

// 8. An option the model actually picked is never returned as a takeover: the caller executes it, and
//    returning it here would run it twice.
{
  const actions = { wait: { type: 'wait' }, objective_9: action({ type: 'mission', mode: 'attack', auto: 1 }) };
  const groups = { tactics: groupOf(actions) };
  assert.deepEqual(collectTakeovers(groups, { tactics: { choice: 'objective_9' } }, {}, {}, 0), []);
}

// 9. An owned option with a real alternative is not dead: with no declared threshold it falls back on the
//    first decline. This is the defensive-floor shape (the tag is on the first tower, and with money for
//    more towers the group is a genuine question).
{
  const actions = { wait: { type: 'wait' }, produce_GAPILL: action({ engineOwned: true }), produce_NASAM: action() };
  const groups = { defenses: groupOf(actions) };
  const marks = engineOwnedMarks(groups);
  const t = collectTakeovers(groups, { defenses: { choice: 'wait' } }, marks, {}, 0);
  assert.deepEqual(t.map((x) => [x.id, x.choice, x.owned]), [['defenses', 'produce_GAPILL', true]], 'the owned option still falls back');
}
// 10. A group is taken ONCE per turn. The decide loop calls this twice: once with no answers (the options
//     the engine owns outright) and once after the model replies (the `auto:` fallbacks). The second pass
//     re-evaluates the same groups, and by then another group's action may have rewritten `memory.mission`,
//     which defeats the running-mission guard. `jev-report-20261010-061242` shows the consequence: the same
//     `explore_104_65` mission issued twice at tick 1611, and pairs again at 3022 and 4037.
{
  const actions = { wait: { type: 'wait' }, explore_4_4: action({ type: 'mission', mode: 'explore', engineOwned: true }) };
  const groups = { scouting: groupOf(actions) };
  const marks = engineOwnedMarks(groups);
  const memory = {};
  const first = collectTakeovers(groups, null, marks, memory, 700);
  assert.deepEqual(first.map((t) => t.choice), ['explore_4_4'], 'the engine takes it on the first pass');
  const second = collectTakeovers(groups, { scouting: { choice: 'wait' } }, marks, memory, 700);
  assert.deepEqual(second, [], 'and does not take it again in the same turn');
  // A new tick starts clean: the same option is available again next turn.
  const next = collectTakeovers(groups, null, marks, memory, 701);
  assert.deepEqual(next.map((t) => t.choice), ['explore_4_4'], 'a new turn is not blocked by the previous one');
}
// 11. The construction plan step declares its own fallback, and the declaration is load-bearing. The
//     option is owned, so it is dropped entirely when it is the group's only real choice; when another
//     builder puts a real alternative beside it the group is still asked, and `auto: 3` is what keeps the
//     model's three turns. An owned option with no declared threshold falls back on the first decline
//     (case 9), so dropping the `auto` would quietly hand the engine's own plan the answer one turn in.
{
  const actions = { wait: { type: 'wait' }, produce_LAB: action({ engineOwned: true, auto: 3 }), produce_GAAIRC: action() };
  const groups = { construction: groupOf(actions) };
  const marks = engineOwnedMarks(groups);
  assert.deepEqual(marks, { construction: { produce_LAB: true } }, 'the plan step carries the mark');
  const memory = {}, answers = { construction: { choice: 'wait' } };
  assert.deepEqual(collectTakeovers(groups, answers, marks, memory, 0), [], 'one declined turn is not enough');
  assert.deepEqual(collectTakeovers(groups, answers, marks, memory, 0), [], 'nor two');
  const third = collectTakeovers(groups, answers, marks, memory, 0);
  assert.deepEqual(third.map((x) => [x.id, x.choice, x.reason, x.owned]), [['construction', 'produce_LAB', 'auto_construction', true]], 'the third sends the engine');
  // And the question really was asked in the meantime: one real option beside the owned one is a choice.
  const { asked, owned } = splitEngineOwned(requestGroupsFrom(groups, {}, 0));
  assert.deepEqual(owned, [], 'a real alternative keeps the question');
  assert.deepEqual(Object.keys(asked.construction.criteria).sort(), ['produce_GAAIRC', 'produce_LAB', 'wait'], 'and both options stay in it');
  // With nothing beside it the same option is not a question at all.
  const alone = { construction: { instructions: 'i', criteria: { wait: 'c', produce_LAB: 'c' }, actions: { wait: { type: 'wait' }, produce_LAB: action({ engineOwned: true, auto: 3 }) } } };
  assert.deepEqual(splitEngineOwned(requestGroupsFrom(alone, {}, 0)).owned, [{ id: 'construction', choice: 'produce_LAB' }], 'alone, the plan step is taken outright');
}
console.log('Takeovers: one decision point for ownership and the auto fallback, counted per option, with a real alternative left to the model');
