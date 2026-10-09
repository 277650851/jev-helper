import assert from 'node:assert/strict';
import { historyHints, rememberChoice, STALE_REPEATS, STALE_REMOVE } from '../src/player/werhd-jev-player.mjs';

// Two ways an option ends up in `memory.recent`:
//   - the model chose it (free choice; a losing streak here is a real pattern), and
//   - the engine took it over after N waits (`auto: N`), which is the mechanism that exists to make
//     sure something happens at all.
//
// `historyHints` demotes an option after STALE_REPEATS consecutive losing picks and deletes it from
// the menu at STALE_REMOVE. It counted every entry, so an option the engine had taken over repeatedly
// accumulated a streak the model never produced and was then deleted -- removing the very thing the
// takeover guaranteed. These tests separate the two.

const group = () => ({
  instructions: 'Choose what to build.',
  criteria: { wait: 'Nothing is needed.', produce_TANK: 'Build a tank.', produce_PILL: 'Build a pillbox.' },
  actions: { wait: { type: 'wait' }, produce_TANK: { type: 'produce', name: 'TANK', queue: 3, cost: 750 }, produce_PILL: { type: 'produce', name: 'PILL', queue: 1, cost: 500 } },
});
const idleLedger = () => ({ ownUnitsLost: 0, ownBuildingsLost: 0, enemyUnitsDestroyed: 0, enemyBuildingsDestroyed: 0 });

/** Feed `n` entries for `choice` into memory.recent, `auto` deciding which kind they are. */
function feed(memory, choice, n, auto) {
  for (let i = 0; i < n; i++) rememberChoice(memory, 'vehicles', choice, { accepted: true }, 100 + i, auto);
}

// 1. Engine takeovers alone must never remove an option. This is the regression: seven auto-fired
//    "produce_TANK" entries used to read as a seven-long losing streak and delete the tank option.
{
  const memory = { ledger: idleLedger(), recent: {} };
  feed(memory, 'produce_TANK', STALE_REMOVE + 1, true);
  const groups = { vehicles: group() };
  const state = {};
  const out = historyHints(groups, memory, state, { level: 0 });
  assert.ok(groups.vehicles.actions.produce_TANK, 'an engine takeover must not delete its own option');
  assert.equal(out.vehicles.streak, 0, 'the model never chose it, so there is no model streak');
  assert.equal(out.vehicles.stale, false, 'takeovers are not a stale model answer');
  assert.equal(out.vehicles.autoRuns, STALE_REMOVE + 1, 'the takeovers are still reported');
}

// 2. The model's own repeated losing choice is still demoted and then removed: this half of the
//    mechanism must keep working.
{
  const memory = { ledger: idleLedger(), recent: {} };
  feed(memory, 'produce_TANK', STALE_REPEATS, false);
  const groups = { vehicles: group() };
  const out = historyHints(groups, memory, {}, { level: 0 });
  assert.equal(out.vehicles.streak, STALE_REPEATS);
  assert.equal(out.vehicles.stale, true, 'a repeated model choice with no progress is stale');
  assert.match(groups.vehicles.criteria.produce_TANK, /^STALE ×4/, 'and the option is marked, not yet removed');

  feed(memory, 'produce_TANK', STALE_REMOVE - STALE_REPEATS, false);
  const groups2 = { vehicles: group() };
  const out2 = historyHints(groups2, memory, {}, { level: 0 });
  assert.equal(out2.vehicles.streak, STALE_REMOVE);
  assert.equal(groups2.vehicles.actions.produce_TANK, undefined, 'at the removal threshold the model loses the option');
  assert.ok(groups2.vehicles.actions.produce_PILL, 'the other options stay');
}

// 3. A takeover does not protect an option the model also keeps choosing: mixed history still counts
//    the model's picks, and only those.
{
  const memory = { ledger: idleLedger(), recent: {} };
  feed(memory, 'produce_TANK', STALE_REMOVE, false);
  feed(memory, 'produce_PILL', 2, true);   // the engine switched to something else meanwhile
  const groups = { vehicles: group() };
  const out = historyHints(groups, memory, {}, { level: 0 });
  // The last entry is the auto one, so the "current" choice is the pillbox, which the model never
  // picked: nothing is stale on the strength of takeovers alone.
  assert.equal(out.vehicles.stale, false);
  assert.ok(groups.vehicles.actions.produce_PILL, 'a taken-over option stays available');
}

// 4. No progress is still required: a model pick that keeps killing things is not stale even when
//    repeated, which is the whole point of measuring the exchange rather than the repeat count.
{
  const memory = { ledger: idleLedger(), recent: {} };
  feed(memory, 'produce_TANK', STALE_REMOVE, false);
  memory.ledger.enemyUnitsDestroyed = 20;   // every pick since the first destroyed something
  const groups = { vehicles: group() };
  const out = historyHints(groups, memory, {}, { level: 0 });
  assert.equal(out.vehicles.stale, false, 'progress resets the staleness, however often it was chosen');
  assert.ok(groups.vehicles.actions.produce_TANK);
}
console.log('History hints: engine takeovers do not delete their own option; the model\'s losing streaks still do');
