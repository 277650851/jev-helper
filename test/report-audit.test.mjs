import assert from 'node:assert/strict';
import { auditReport, classifyQuestion, reportMeta, topChoice, takeoversOf } from '../src/report-audit.mjs';

// The audit turns a saved battle report into the one number the rewrite rests on: how often the engine
// asked the model a question whose answer its own preconditions had already fixed. Those questions are
// not judgement calls -- the model can only agree or answer `wait` -- so the share of them, and the rate
// at which the model refuses, is what decides whether consulting it was useful at all.
//
// Measured on three real matches before this test existed: forced-question share 58/67/74%, refusal
// 47/52/61%, and a stable split by group -- vehicles refused 92-97% of its forced questions while
// tactics refused 0-10%. The split is a property of the questions, so it is worth pinning.

// 1. Classification is by how much is left to decide, and a group with no real option is called out
//    rather than folded into `forced`.
assert.equal(classifyQuestion(['wait']), 'empty', 'only wait is not a question');
assert.equal(classifyQuestion(['produce_TANK', 'wait']), 'forced');
assert.equal(classifyQuestion(['produce_TANK', 'produce_FV', 'wait']), 'narrow');
assert.equal(classifyQuestion(['a', 'b', 'c', 'wait']), 'narrow', 'three real options are still narrow');
assert.equal(classifyQuestion(['a', 'b', 'c', 'd', 'wait']), 'open');
assert.equal(classifyQuestion(['a', 'b', 'c', 'd', 'e', 'wait']), 'open');

const decision = (tick, groups) => ({ kind: 'decision', tick, groups, state: {} });
const q = (options, choice, extra = {}) => ({ optionCount: options.length, options: Object.fromEntries(options.map((k) => [k, k])), choice, confidence: 0.5, ...extra });

// 2. A forced question answered with the only option counts as matched; answered with `wait` it counts
//    as refused. Both halves matter: matched says the machinery works, refused says it was wasted.
{
  const entries = [
    decision(100, { vehicles: q(['produce_MTNK', 'wait'], 'produce_MTNK') }),
    decision(160, { vehicles: q(['produce_MTNK', 'wait'], 'wait') }),
    decision(220, { vehicles: q(['produce_MTNK', 'wait'], 'wait') }),
    decision(280, { tactics: q(['assault_9', 'defend_base', 'wait'], 'defend_base') }),
  ];
  const a = auditReport(entries, { build: 'test-build' });
  assert.equal(a.build, 'test-build');
  assert.equal(a.decisions, 4);
  assert.equal(a.questions, 4);
  assert.equal(a.counts.forced, 3, 'three questions had a single real option');
  assert.equal(a.counts.narrow, 1);
  assert.equal(a.counts.open, 0);
  assert.equal(a.forcedMatched, 1);
  assert.equal(a.forcedRefused, 2);
  assert.equal(a.groups.vehicles.asked, 3);
  assert.equal(a.groups.vehicles.forced, 3);
  assert.equal(a.groups.vehicles.refusedForced, 2);
  assert.equal(a.groups.vehicles.wait, 2);
  assert.equal(a.groups.tactics.refusedForced, 0, 'the tactics question was a real choice and was taken');
  assert.equal(a.groups.vehicles.choices.wait, 2);
  assert.equal(topChoice(a.groups.vehicles.choices), 'wait');
}

// 3. Groups are ordered by how many questions left no real choice, so the worst offender reads first.
{
  const entries = [
    decision(100, { scouting: q(['explore_1_1', 'explore_2_2', 'explore_3_3', 'wait'], 'wait') }),
    decision(160, { defenses: q(['produce_GAPILL', 'wait'], 'wait') }),
    decision(220, { defenses: q(['produce_GAPILL', 'wait'], 'wait') }),
  ];
  const a = auditReport(entries);
  assert.deepEqual(Object.keys(a.groups), ['defenses', 'scouting'], 'the group with more forced questions comes first');
}

// 4. A decision where every group answered `wait` is counted separately: that is the case the takeover
//    mechanism exists for, and it is not the same as a single wasted question.
{
  const entries = [
    decision(100, { vehicles: q(['produce_MTNK', 'wait'], 'wait'), defenses: q(['produce_GAPILL', 'wait'], 'wait') }),
    decision(160, { vehicles: q(['produce_MTNK', 'wait'], 'produce_MTNK'), tactics: q(['assault_9', 'wait'], 'assault_9') }),
  ];
  const a = auditReport(entries);
  assert.equal(a.waitEveryGroup, 1, 'only the first decision was all-wait');
}

// 5. A group offering only `wait` is reported as empty rather than counted as a forced question with a
//    free pass: it should never have been sent, and the validator elsewhere rejects more than eight
//    groups but not this.
{
  const entries = [decision(100, { salvage: q(['wait'], 'wait') })];
  const a = auditReport(entries);
  assert.equal(a.counts.empty, 1);
  assert.equal(a.counts.forced, 0);
  assert.equal(a.questions, 1, 'it is still a question that was asked');
}

// 6. Probabilities are only read for the refusal examples, which is what makes "the model was sure and
//    still refused" checkable after the fact.
{
  const entries = [decision(100, { defenses: q(['produce_GAPILL', 'wait'], 'wait', { confidence: 0.69, probabilities: { produce_GAPILL: 0.055, wait: 0.945 } }) })];
  const a = auditReport(entries);
  assert.equal(a.refusedExamples.length, 1);
  assert.deepEqual(a.refusedExamples[0], { tick: 100, group: 'defenses', only: 'produce_GAPILL', confidence: 0.69, probabilities: { produce_GAPILL: 0.055, wait: 0.945 } });
}

// 7. Empty input is not a division by zero, and a report without a decision entry still reads.
{
  const a = auditReport([]);
  assert.equal(a.questions, 0);
  assert.equal(a.averageOptions, 0);
  assert.equal(a.averageInstructionChars, 0);
  assert.deepEqual(a.groups, {});
  const kinds = auditReport([{ kind: 'action' }, { kind: 'observation' }]);
  assert.equal(kinds.decisions, 0);
}

// 8. Metadata is copied for attribution, and a report with no build stamp is reported as such rather
// than being silently attributed to whatever happens to be checked out.
{
  assert.deepEqual(reportMeta({ providerName: 'Laya', model: 'm', strategyMode: 'choices', outcome: 'defeat', gameSeconds: 1104 }), {
    build: null, provider: 'Laya', model: 'm', strategyMode: 'choices', outcome: 'defeat', gameSeconds: 1104,
  });
  assert.equal(reportMeta({ meta: { build: 'abc-dirty' } }).build, 'abc-dirty');
  assert.equal(reportMeta({ reason: 'victory' }).outcome, 'victory', 'a match with no outcome yet reports its end reason');
}
// Who decided, over a whole match. The takeover work exists so the engine stops asking questions whose
// answer its preconditions already fixed; this tally is how a human checks that it happened and whether the
// orders it took are landing. Both report shapes are read, because a report may predate the attribution fix.
{
  const entries = [
    // The fixed shape: reason names the decider, the refusal travels beside it.
    { kind: 'action', auto: true, reason: 'engine_decided', engineOwned: true, question: 'defenses', choice: 'produce_GAPILL', accepted: true },
    { kind: 'action', auto: true, reason: 'engine_decided', engineOwned: true, question: 'construction', choice: 'produce_GAPOWR', accepted: false, rejectedBecause: 'queue_changed' },
    { kind: 'action', auto: true, reason: 'auto_explore', question: 'scouting', choice: 'explore_1_1', accepted: true },
    { kind: 'action', auto: true, reason: 'auto_explore', question: 'scouting', choice: 'explore_2_2', accepted: false, rejectedBecause: 'unit_gone' },
    // The OLD shape: a refused takeover was logged as its own refusal, so the rule is unrecoverable.
    { kind: 'action', auto: true, reason: 'queue_changed', question: 'vehicles', choice: 'produce_TANK', accepted: false },
    // A model choice, and a decision record that must not be counted as an action.
    { kind: 'action', auto: false, reason: undefined, question: 'tactics', choice: 'assault_9', accepted: true },
    { kind: 'decision', tick: 10, groups: {} },
  ];
  const t = takeoversOf(entries);
  assert.equal(t.actions, 6, 'decision records are not actions');
  assert.equal(t.taken, 5, 'every uto: true action is a takeover');
  assert.equal(t.accepted, 2, 'the two that landed');
  assert.equal(t.refused, 3, 'the three that did not');
  assert.equal(t.modelChosen, 1, 'and one order the model chose');
  assert.equal(t.unattributed, 1, 'the old-shape entry is counted as unattributable rather than silently folded in');
  assert.equal(t.byReason.engine_decided, 2);
  assert.equal(t.byReason.auto_explore, 2);
  assert.equal(t.byReason.unattributed, 1);
  // The refusal tally is what says whether the engine is offering things that are executable right now.
  assert.deepEqual(t.refusals, { queue_changed: 2, unit_gone: 1 });
  assert.deepEqual(t.byGroup.scouting, { taken: 2, accepted: 1, refused: 1 });
  assert.deepEqual(t.byGroup.defenses, { taken: 1, accepted: 1, refused: 0 });

  // Transport trouble is reported beside the tally: a degraded match must not read as one with nothing to do.
  const trouble = takeoversOf([
    { kind: 'error', message: 'Laya 请求超时' },
    { kind: 'error', message: 'Laya 请求超时' },
    { kind: 'degraded', untilTick: 1800 },
    { kind: 'action', auto: true, reason: 'engine_decided', question: 'defenses', choice: 'x', accepted: true },
  ]);
  assert.equal(trouble.errors, 2, 'errors are counted');
  assert.deepEqual(trouble.errorMessages, ['Laya 请求超时'], 'distinct messages, not repeats');
  assert.equal(trouble.degraded, 1, 'and the degradation is visible');
  assert.equal(trouble.taken, 1, 'while the takeovers are unaffected');
}
console.log('Report audit: forced-question share, refusal rate, per-group split, all-wait decisions and attribution');
