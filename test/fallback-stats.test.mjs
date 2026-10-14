import test from 'node:test';
import assert from 'node:assert/strict';
import { fallbackCounter, summarizeFallbacks, formatFallbackReport } from '../src/fallback-stats.mjs';
import { collectTakeovers } from '../src/player/werhd-jev-player.mjs';
import { eventEntry } from '../src/logbook.mjs';

// The `auto: N` fallback is what makes a decision happen when the model will not make it. Two failures look
// the same in a saved report and need opposite fixes:
//   armed many times, fired 0 -- the threshold was never reached, so the rule did nothing this match
//   armed 0                   -- the precondition never held, so the option was never on the table
// These counters exist to separate them. They used to be unreachable: `optionLifecycle` sees only what fired.

test('counters separate armed-never-fired, fired, and never-armed', () => {
  const stats = {};
  fallbackCounter(stats, 'vehicles', 'produce_MTNK', 2).armed = 14;
  fallbackCounter(stats, 'vehicles', 'produce_MTNK', 2).declined = 3;
  fallbackCounter(stats, 'vehicles', 'produce_MTNK', 2).fired = 2;
  fallbackCounter(stats, 'infantry', 'produce_GI', 3).armed = 9;
  fallbackCounter(stats, 'infantry', 'produce_GI', 3).declined = 1;
  fallbackCounter(stats, 'salvage', 'sell_945', 2);   // seen, never eligible

  const s = summarizeFallbacks(stats);
  assert.equal(s.declared, 3);
  assert.equal(s.armed, 23);
  assert.equal(s.firedTotal, 2);
  assert.deepEqual(s.fired.map((x) => x.key), ['produce_MTNK']);
  assert.deepEqual(s.neverFired.map((x) => x.key), ['produce_GI']);
  assert.deepEqual(s.notArmed.map((x) => x.key), ['sell_945']);
  // The three lists partition the declared options: no option is in two of them.
  assert.equal(s.fired.length + s.neverFired.length + s.notArmed.length, s.declared);
});

test('fallbackCounter returns the same record on every sight, so counts accumulate', () => {
  const stats = {};
  const a = fallbackCounter(stats, 'vehicles', 'produce_MTNK', 2);
  a.armed++;
  const b = fallbackCounter(stats, 'vehicles', 'produce_MTNK', 2);
  b.armed++;
  assert.equal(a, b);
  assert.equal(summarizeFallbacks(stats).armed, 2);
  assert.equal(Object.keys(stats).length, 1, 'keyed by group:key, not by a fresh object each time');
});

test('collectTakeovers counts an armed threshold, then a fire, then a model pick', () => {
  const groups = {
    vehicles: {
      criteria: { produce_MTNK: 'Build MTNK', wait: 'No useful action' },
      actions: { produce_MTNK: { type: 'produce', name: 'MTNK', cost: 700, auto: 2 }, wait: { type: 'wait' } },
    },
  };
  const memory = {};
  const wait = { vehicles: { choice: 'wait' } };

  // Turn 1: armed once, declined once, threshold (2) not reached -- nothing may be taken.
  assert.deepEqual(collectTakeovers(groups, wait, {}, memory, 100), []);
  let stat = memory.fallbackStats['vehicles:produce_MTNK'];
  assert.equal(stat.armed, 1);
  assert.equal(stat.declined, 1);
  assert.equal(stat.fired, 0);

  // Turn 2: the threshold is reached, so the engine takes it on its own.
  const taken = collectTakeovers(groups, wait, {}, memory, 200);
  assert.equal(taken.length, 1);
  assert.equal(taken[0].choice, 'produce_MTNK');
  assert.equal(taken[0].reason, 'auto_vehicles', 'the reason still names the rule, unchanged');
  stat = memory.fallbackStats['vehicles:produce_MTNK'];
  assert.equal(stat.armed, 2);
  assert.equal(stat.fired, 1);

  // Turn 3: the model picks it, so the fallback is not needed and the running decline count is cleared.
  assert.deepEqual(collectTakeovers(groups, { vehicles: { choice: 'produce_MTNK' } }, {}, memory, 300), []);
  stat = memory.fallbackStats['vehicles:produce_MTNK'];
  assert.equal(stat.byModel, 1);
  assert.equal(stat.fired, 1, 'a model pick must not be counted as a fallback firing');
  assert.equal(memory.takeoverDeclines['vehicles:produce_MTNK'], undefined);
});

test('a group the engine owns outright is not counted as an armed fallback', () => {
  // The single-owned-option path takes the group out of the request entirely, so no threshold is ever
  // reached there: counting it as "armed" would report every engine-owned opening build as a dead rule.
  const groups = {
    construction: {
      criteria: { deploy_base: 'Deploy the MCV', wait: 'No useful action' },
      actions: { deploy_base: { type: 'deploy', ids: [1], engineOwned: true }, wait: { type: 'wait' } },
    },
  };
  const memory = {};
  const taken = collectTakeovers(groups, undefined, { construction: { deploy_base: true } }, memory, 10);
  assert.equal(taken.length, 1);
  assert.equal(taken[0].reason, 'engine_decided');
  assert.deepEqual(memory.fallbackStats ?? {}, {}, 'no fallback counter should be created');
});

test('the gates entry survives the log serializer with all four counters', () => {
  // The serializer is a whitelist and returns null for an unknown kind, so a new record that is not listed
  // there is silently dropped from every saved report -- which is how `engineOwned` and `rejectedBecause`
  // went missing once already. This asserts the branch exists AND that both lists carry the full row.
  const entry = eventEntry({
    kind: 'gates', tick: 4200, declared: 2, armed: 15, byModel: 4, firedTotal: 1,
    neverFired: [{ group: 'infantry', key: 'produce_GI', threshold: 3, armed: 9, declined: 1, byModel: 0, fired: 0 }],
    fired: [{ group: 'vehicles', key: 'produce_MTNK', threshold: 2, armed: 6, declined: 2, byModel: 4, fired: 1 }],
  }, 12345);
  assert.ok(entry, 'an unlisted kind would come back null and never reach a report');
  assert.equal(entry.kind, 'gates');
  assert.equal(entry.armed, 15);
  assert.equal(entry.neverFired.length, 1);
  assert.equal(entry.neverFired[0].armed, 9, 'the never-fired row must say how often it was armed');
  assert.equal(entry.fired[0].fired, 1);
  assert.equal(eventEntry({ kind: 'gates', tick: 1, neverFired: 'nope', fired: null }, 1).neverFired.length, 0);
});

test('the rendered tally names the never-fired fallback and the two other classes', () => {
  const text = formatFallbackReport(summarizeFallbacks({
    'infantry:produce_GI': { group: 'infantry', key: 'produce_GI', threshold: 3, armed: 9, declined: 1, byModel: 0, fired: 0 },
    'vehicles:produce_MTNK': { group: 'vehicles', key: 'produce_MTNK', threshold: 2, armed: 6, declined: 2, byModel: 4, fired: 1 },
    'salvage:sell': { group: 'salvage', key: 'sell', threshold: 2, armed: 0, declined: 0, byModel: 0, fired: 0 },
  }), 'x.json').join('\n');
  assert.match(text, /从没触发过的兜底：.*→ 1 个/);
  assert.match(text, /infantry:produce_GI/);
  assert.match(text, /触发过的兜底：1 个/);
  assert.match(text, /vehicles:produce_MTNK/);
  assert.match(text, /另有 1 个选项从未变成可触发状态/);
});
