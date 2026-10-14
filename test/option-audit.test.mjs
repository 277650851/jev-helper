import test from 'node:test';
import assert from 'node:assert/strict';
import { optionLifecycle, formatOptionAudit, classifyQuestion } from '../src/report-audit.mjs';

// A candidate option can fail in three different ways, and the difference decides what to do about it:
//   dead       -- built and offered every turn, never picked, never executed by anyone: the rule does nothing
//   engineOnly -- the model never picks it; only the engine acts on it, so an `auto:` fallback does the work
//   unseen     -- the engine executed it while the model was never shown it (marked engine-owned outright)
// These are mechanism facts, readable from ONE match, which is why they are safe to act on where a win-rate
// claim is not (docs/jev-autopilot-redesign-review.md §0.43: four matches of identical code spread 44 points
// on the refusal rate, so nothing smaller than that is identifiable from a single match).
const decision = (tick, groups) => ({ kind: 'decision', tick, groups });
const action = (tick, question, choice, { auto = false, accepted = true, reason = '' } = {}) =>
  ({ kind: 'action', tick, question, choice, auto, accepted, reason });
const menu = (option) => ({ [option]: 'offered', wait: 'No useful action is needed in this category.' });

const entries = [
  // `vehicles` offers one tank every turn, the model abstains every time, and nobody ever executes it: dead.
  decision(100, { vehicles: { choice: 'wait', options: menu('produce_MTNK') } }),
  decision(200, { vehicles: { choice: 'wait', options: menu('produce_MTNK') } }),
  decision(300, { vehicles: { choice: 'wait', options: menu('produce_MTNK') } }),
  // `construction`: the model abstains and the engine takes the plant anyway -- twice accepted, once refused.
  decision(100, { construction: { choice: 'wait', options: menu('produce_GAPOWR') } }),
  decision(200, { construction: { choice: 'wait', options: menu('produce_GAPOWR') } }),
  action(100, 'construction', 'produce_GAPOWR', { auto: true, reason: 'auto_construction' }),
  action(200, 'construction', 'produce_GAPOWR', { auto: true, reason: 'auto_construction' }),
  action(310, 'construction', 'produce_GAPOWR', { auto: true, accepted: false, reason: 'auto_construction' }),
  // `tactics`: the model really does pick it -- twice it lands, once the executor refuses it.
  decision(100, { tactics: { choice: 'assemble_force', options: menu('assemble_force') } }),
  decision(200, { tactics: { choice: 'assemble_force', options: menu('assemble_force') } }),
  action(100, 'tactics', 'assemble_force'),
  action(200, 'tactics', 'assemble_force'),
  action(320, 'tactics', 'assemble_force', { accepted: false, reason: 'queue_changed' }),
  // `scouting`: engine-owned outright, so it never appears in a decision entry at all.
  action(150, 'scouting', 'explore_frontier', { auto: true, reason: 'auto_explore' }),
];

test('per-option lifecycle separates dead, engine-only and unseen candidates', () => {
  const l = optionLifecycle(entries);
  const keys = (list) => list.map((o) => o.option);

  assert.deepEqual(keys(l.deadOptions), ['vehicles:produce_MTNK']);
  assert.deepEqual(keys(l.unseenOptions), ['scouting:explore_frontier']);
  assert.deepEqual(keys(l.engineOnlyOptions), ['construction:produce_GAPOWR']);
  // Only `tactics:assemble_force` was ever picked by the model; `wait` is abstention and is not counted.
  assert.equal(l.chosenOptions, 1);
  assert.equal(l.questions, 7);
  assert.equal(l.actions, 7);
  assert.equal(l.actionsWithoutQuestion, 1, 'the engine-owned scout was executed without ever being offered');

  const tank = l.all.find((o) => o.option === 'vehicles:produce_MTNK');
  assert.equal(tank.offered, 3, 'offered on every turn');
  assert.equal(tank.chosen, 0);
  assert.equal(tank.engineTaken, 0);
  assert.equal(tank.dead, true);
  assert.equal(tank.engineOnly, false, 'a dead option is not also engine-only');

  const power = l.all.find((o) => o.option === 'construction:produce_GAPOWR');
  assert.equal(power.offered, 2);
  assert.equal(power.chosen, 0);
  assert.equal(power.engineTaken, 3);
  assert.equal(power.engineAccepted, 2);
  assert.equal(power.engineRefused, 1, 'a refused takeover is still a takeover: the engine decided');
  assert.equal(power.dead, false, 'the engine executes it, so it is engine-only rather than dead');
  assert.equal(power.firstTick, 100);
  assert.equal(power.lastTick, 310, 'the window spans both what the model saw and what ran');

  const force = l.all.find((o) => o.option === 'tactics:assemble_force');
  assert.equal(force.chosen, 2);
  assert.equal(force.modelTaken, 3);
  assert.equal(force.modelAccepted, 2);
  assert.equal(force.engineTaken, 0);
  assert.equal(force.modelOnly, true);
});

test('wait is abstention, never a dead or engine-only candidate', () => {
  // `vehicles:wait` is offered three times and never picked, which by the raw predicate looks dead. It is not:
  // it is the abstention every group carries, and flagging it would put one entry in every group of every
  // report and hide the real ones. It stays in `all` so the refusal rate is still reachable.
  const l = optionLifecycle(entries);
  const wait = l.all.find((o) => o.option === 'vehicles:wait');
  assert.ok(wait, 'wait is still counted');
  assert.equal(wait.offered, 3);
  assert.equal(wait.abstain, true);
  assert.equal(l.deadOptions.some((o) => o.abstain), false);
  assert.equal(l.engineOnlyOptions.some((o) => o.abstain), false);
});

test('a pick that was not among the offered keys is never credited to the model', () => {
  // A truncated report can pair a decision entry with a choice whose label list was cut. Crediting it would
  // invent a lifecycle for a key nobody could have seen, so it is dropped from `chosen` instead.
  const l = optionLifecycle([
    decision(10, { vehicles: { choice: 'produce_MTNK', options: menu('produce_GAPOWR') } }),
  ]);
  assert.equal(l.chosenOptions, 0);
  assert.equal(l.all.find((o) => o.option === 'vehicles:produce_MTNK'), undefined);
});

test('actions with no matching decision entry are reported, so a lower bound is not read as zero', () => {
  // The battle report is a ring buffer: the opening of a long match is dropped (review §0.44). Then every
  // `offered` count is a lower bound, and a caller that ignores that reads "never offered" as "never built".
  const l = optionLifecycle([action(50, 'infantry', 'produce_E1'), action(60, 'infantry', 'produce_E1')]);
  assert.equal(l.questions, 0);
  assert.equal(l.actionsWithoutQuestion, 2);
  assert.deepEqual(l.unseenOptions.map((o) => o.option), ['infantry:produce_E1']);

  const lines = formatOptionAudit(l, { file: 'x.json', truncated: true });
  assert.ok(lines.some((s) => s.includes('日志被截断')), 'the truncation warning must be printed');

  // Without the flag the warning is still printed when there are no questions at all to attribute against.
  assert.ok(formatOptionAudit(l, { file: 'x.json' }).some((s) => s.includes('日志被截断')));
});

test('the rendered report names the dead option and keeps the three classes apart', () => {
  const lines = formatOptionAudit(optionLifecycle(entries), { file: 'jev-report-x.json' }).join('\n');
  assert.match(lines, /从未生效的候选族.*→ 1 个/);
  assert.match(lines, /死选项（逐键.*→ 1 个/);
  assert.match(lines, /vehicles:produce_MTNK/);
  assert.match(lines, /模型从未见过的候选：.*→ 1 个/);
  assert.match(lines, /引擎独占：.*→ 1 个/);
  assert.match(lines, /construction:produce_GAPOWR/);
  assert.doesNotMatch(lines, /tactics:assemble_force/, 'a candidate the model really uses is not a finding');
});

test('per-id options are aggregated into a family, so one-per-unit producers do not hide the signal', () => {
  // A producer that mints one option per unit or per tile (`assault_1470`, `capture_912`, `explore_98_95`) has
  // a lifecycle that can only ever be chosen once per key, so every such key looks dead on its own. Measured
  // on the seven archived reports, this one detail moved the dead list from "53 entries of noise" to a
  // handful of families worth reading.
  const e = [
    decision(1, { assault: { choice: 'wait', options: { assault_1470: 'x', assault_2000: 'y', wait: 'w' } } }),
    decision(2, { assault: { choice: 'wait', options: { assault_2000: 'y', wait: 'w' } } }),
  ];
  const l = optionLifecycle(e);
  assert.equal(l.deadFamilies.length, 1);
  assert.equal(l.deadFamilies[0].family, 'assault:assault');
  assert.equal(l.deadFamilies[0].options, 2, 'both per-id keys fold into one family');
  assert.equal(l.deadFamilies[0].offered, 3);
  assert.equal(l.deadFamilies[0].deadFamily, true);
  // The non-numeric suffix is NOT folded: `produce_E1` stays its own family.
  assert.equal(optionLifecycle([decision(1, { infantry: { choice: 'wait', options: menu('produce_E1') } })])
    .deadFamilies[0].family, 'infantry:produce_E1');
});

test('a family that produced a real order is not reported dead even if most of its keys never were', () => {
  const e = [
    decision(1, { assault: { choice: 'assault_1470', options: { assault_1470: 'x', assault_2000: 'y', wait: 'w' } } }),
    action(1, 'assault', 'assault_1470'),
  ];
  const l = optionLifecycle(e);
  assert.deepEqual(l.deadOptions.map((o) => o.option), ['assault:assault_2000']);
  assert.equal(l.deadFamilies.length, 0, 'the family as a whole worked, so it is not a finding');
});

test('classifyQuestion still agrees with the option counts the lifecycle is built on', () => {
  // The lifecycle and the question audit read the same `options` map, so a forced question is exactly a
  // question whose offered keys are `wait` plus one. Pinning that keeps the two from drifting apart.
  assert.equal(classifyQuestion(Object.keys(entries[0].groups.vehicles.options)), 'forced');
  assert.equal(classifyQuestion(Object.keys(menu('a'))), 'forced');
});
