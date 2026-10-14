import test from 'node:test';
import assert from 'node:assert/strict';
import { rewardSample, openReward, closeRewards, summarizeRewards, formatRewardReport, REWARD_WINDOW_TICKS, MAX_OPEN_REWARDS } from '../src/reward-window.mjs';
import { eventEntry } from '../src/logbook.mjs';

// The signal every later learning step reads. Before this, a report said what was chosen and never what
// followed, which is why no offline learning route was possible at all. The tests below pin the two things
// that make the label trustworthy rather than merely present: the window only matures after its horizon,
// and the loss/kill numbers are DIFFERENCES of cumulative counters (which only ever grow).
const sample = (tick, credits, own, enemy, lost, killed) => ({
  tick, credits,
  ledger: { ownUnits: own, enemyUnits: enemy, ownUnitsLost: lost, ownBuildingsLost: 0, enemyUnitsDestroyed: killed, enemyBuildingsDestroyed: 0 },
});

test('a sample is read from the fields the observation already carries', () => {
  assert.deepEqual(rewardSample(sample(100, 5000, 7, 3, 2, 5)), { tick: 100, credits: 5000, own: 7, enemy: 3, lost: 2, killed: 5 });
  // Without credits there is nothing to measure against, so the baseline is refused rather than defaulted:
  // a zero baseline would silently turn every delta into an absolute value.
  assert.equal(rewardSample({ tick: 1, ledger: {} }), null);
  assert.equal(rewardSample(undefined), null);
});

test('a window matures only after its horizon, and the label is a difference', () => {
  const memory = {};
  openReward(memory, { tick: 1000, group: 'vehicles', choice: 'produce_MTNK', accepted: true, sample: sample(1000, 5000, 7, 3, 2, 5) });
  assert.equal(memory.rewards.open.length, 1);

  // Still inside the window: nothing may be settled yet.
  assert.deepEqual(closeRewards(memory, 1000 + REWARD_WINDOW_TICKS - 1, sample(1449, 6000, 9, 1, 3, 11)), []);
  assert.equal(memory.rewards.open.length, 1);

  // The horizon has passed: credits +1000, army +2, enemy -2, one more loss, six more kills.
  const closed = closeRewards(memory, 1000 + REWARD_WINDOW_TICKS, sample(1450, 6000, 9, 1, 3, 11));
  assert.equal(closed.length, 1);
  assert.deepEqual(closed[0], {
    tick: 1000, group: 'vehicles', choice: 'produce_MTNK', auto: false, accepted: true,
    windowTicks: REWARD_WINDOW_TICKS, dCredits: 1000, dOwn: 2, dEnemy: -2,
    lost: 1, killed: 6, exchange: 5,
  });
  assert.equal(memory.rewards.open.length, 0);
  assert.equal(memory.rewards.done.length, 1);
});

test('an action taken without a baseline is skipped, not defaulted to zero', () => {
  const memory = {};
  assert.equal(openReward(memory, { tick: 10, group: 'tactics', choice: 'assemble_force' }), null);
  assert.equal(memory.rewards, undefined, 'no baseline means no window at all, not an empty one');
});

test('the open list is bounded, so a stalled sampler cannot grow it without limit', () => {
  const memory = {};
  for (let i = 0; i < MAX_OPEN_REWARDS + 5; i++) {
    openReward(memory, { tick: i * 10, group: 'vehicles', choice: `produce_${i}`, sample: sample(i * 10, 100, 1, 1, 0, 0) });
  }
  assert.equal(memory.rewards.open.length, MAX_OPEN_REWARDS);
  assert.equal(memory.rewards.dropped, 5, 'the drop is counted, so a capped list is never read as the whole');
});

test('per-group aggregates report means and keep the chosen/engine split', () => {
  const memory = {};
  const base = sample(0, 1000, 5, 5, 0, 0);
  // Two model picks and one engine takeover. The close tick has to be past the LAST window's horizon as
  // well: an earlier version closed at 550, which matured only the tick-100 row (550-200 = 350 < 450) --
  // the horizon logic was right and the fixture was wrong.
  openReward(memory, { tick: 100, group: 'vehicles', choice: 'produce_MTNK', accepted: true, sample: base });
  openReward(memory, { tick: 200, group: 'vehicles', choice: 'produce_MTNK', accepted: true, sample: base });
  openReward(memory, { tick: 300, group: 'vehicles', choice: 'produce_GI', accepted: false, auto: true, sample: base });
  closeRewards(memory, 300 + REWARD_WINDOW_TICKS, sample(750, 1600, 6, 3, 1, 4));

  const s = summarizeRewards(memory);
  assert.equal(s.rows, 3);
  const v = s.groups.find((g) => g.group === 'vehicles');
  assert.equal(v.rows, 3);
  assert.equal(v.chosen, 2);
  assert.equal(v.auto, 1);
  // Each row sees +600 credits and an exchange of +3 (4 killed, 1 lost); the mean is that row's value.
  assert.equal(v.meanCredits, 600);
  assert.equal(v.meanExchange, 3);
  assert.equal(s.totalExchange, 9);
  assert.ok(s.kept <= 120 && s.list.length === s.kept);
});

test('the rendered table shows group means and refuses to state a verdict', () => {
  const memory = {};
  const base = sample(0, 1000, 5, 5, 0, 0);
  openReward(memory, { tick: 100, group: 'vehicles', choice: 'produce_MTNK', accepted: true, sample: base });
  closeRewards(memory, 600, sample(550, 1600, 6, 3, 1, 4));
  const text = formatRewardReport(summarizeRewards(memory), 'x.json').join('\n');
  assert.match(text, /决策收益窗口 x\.json/);
  assert.match(text, /vehicles/);
  assert.match(text, /这是\*\*标签\*\*，不是证据/);
});

test('the rewards entry survives the log serializer with rows, aggregates and the cap', () => {
  const entry = eventEntry({
    kind: 'rewards', tick: 9000, rows: 500, open: 3, dropped: 7, totalCredits: -1200, totalExchange: 15,
    groups: [{ group: 'vehicles', rows: 120, chosen: 90, auto: 30, meanCredits: -10, meanExchange: 0.5, killed: 60, lost: 30 }],
    list: [{ tick: 100, group: 'vehicles', choice: 'produce_MTNK', accepted: true, windowTicks: 450, dCredits: -300, dOwn: 0, dEnemy: 1, lost: 2, killed: 3, exchange: 1 }],
  }, 12345);
  assert.ok(entry, 'an unlisted kind comes back null and would never reach a report');
  assert.equal(entry.kind, 'rewards');
  assert.equal(entry.rows, 500);
  assert.equal(entry.groups[0].meanExchange, 0.5);
  assert.equal(entry.list[0].dCredits, -300);
  assert.equal(entry.list[0].exchange, 1);
  // A malformed list must not throw inside the serializer: it runs in the background, per event.
  assert.deepEqual(eventEntry({ kind: 'rewards', list: 'nope', groups: null }, 1).list, []);
});
