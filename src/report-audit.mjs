// Audit the QUESTION SET an autopilot match actually asked. Pure function over report entries, so it
// can be exercised from a test without a running game, a model, or a recorded file.
//
// Why this exists: the decision layer cannot be judged by reading it. Several separate investigations
// on this codebase reached a confident wrong conclusion from the source alone -- a "flaky engine bug"
// that was really a shared test array, two "high severity" defects that were structurally unreachable,
// and a rules file assumed to be the live one -- and every one was settled by measuring. A battle report
// already records, per decision, the option keys the model was shown, what it chose, its probabilities,
// and the instruction text, so the measurement needs no new capture.
//
// The premise the rewrite rests on is that the engine asks the model questions whose answer its own
// preconditions already fixed, and the model can therefore only refuse. This module counts exactly that.

/**
 * Classify one question by how much is left for the model to decide.
 *   forced — one real option besides `wait`: the answer was determined before the question was asked
 *   narrow — two or three real options
 *   open   — four or more
 *   empty  — no real option at all (only `wait`); such a group should never have been sent
 */
export const classifyQuestion = (optionKeys) => {
  const real = optionKeys.filter((k) => k !== 'wait');
  if (!real.length) return 'empty';
  if (real.length === 1) return 'forced';
  return real.length <= 3 ? 'narrow' : 'open';
};

/** The top entry of a `key -> count` tally. */
const topOf = (m) => Object.entries(m).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';

/**
 * Audit the `decision` entries of a battle report.
 * @param entries report `entries` array (any other kinds are ignored)
 * @param meta    optional match metadata, copied into the summary for attribution
 */
export function auditReport(entries = [], meta = {}) {
  const decisions = entries.filter((e) => e?.kind === 'decision');
  const groups = {};
  const totals = { asked: 0, forced: 0, narrow: 0, open: 0, empty: 0, refusedForced: 0, matchedForced: 0, waitEveryGroup: 0, options: 0, instructionChars: 0, withoutWait: 0 };
  const refusedExamples = [];

  for (const d of decisions) {
    const gs = Object.entries(d.groups ?? {});
    // A decision whose every group chose `wait` asked and got nothing; it is the case the takeover
    // mechanism exists for, so it is counted on its own.
    if (gs.length && gs.every(([, g]) => g.choice === 'wait')) totals.waitEveryGroup++;
    for (const [id, g] of gs) {
      const keys = Object.keys(g?.options ?? {});
      if (!keys.length) continue;
      const kind = classifyQuestion(keys);
      const real = keys.filter((k) => k !== 'wait');
      const rec = groups[id] ??= { asked: 0, forced: 0, narrow: 0, open: 0, empty: 0, refusedForced: 0, matchedForced: 0, wait: 0, options: 0, chars: 0, choices: {} };
      rec.asked++;
      rec[kind]++;
      rec.options += keys.length;
      rec.chars += (g.instructions ?? '').length;
      rec.choices[g.choice] = (rec.choices[g.choice] ?? 0) + 1;
      if (g.choice === 'wait') rec.wait++;

      totals.asked++;
      totals[kind]++;
      totals.options += keys.length;
      totals.instructionChars += (g.instructions ?? '').length;
      if (!keys.includes('wait')) totals.withoutWait++;

      if (kind === 'forced') {
        if (g.choice === 'wait') {
          totals.refusedForced++;
          rec.refusedForced++;
          if (refusedExamples.length < 8) refusedExamples.push({ tick: d.tick, group: id, only: real[0], confidence: g.confidence, probabilities: g.probabilities ?? {} });
        } else if (g.choice === real[0]) { totals.matchedForced++; rec.matchedForced++; }
      }
    }
  }

  return {
    ...meta,
    decisions: decisions.length,
    questions: totals.asked,
    counts: { forced: totals.forced, narrow: totals.narrow, open: totals.open, empty: totals.empty },
    forcedRefused: totals.refusedForced,
    forcedMatched: totals.matchedForced,
    waitEveryGroup: totals.waitEveryGroup,
    withoutWait: totals.withoutWait,
    averageOptions: totals.asked ? Math.round((totals.options / totals.asked) * 100) / 100 : 0,
    averageInstructionChars: totals.asked ? Math.round(totals.instructionChars / totals.asked) : 0,
    // Per group, sorted by the number of questions that left the model no real choice.
    groups: Object.fromEntries(Object.entries(groups).sort((a, b) => b[1].forced - a[1].forced)),
    refusedExamples,
  };
}

/**
 * Who decided what, over a whole match. The takeover work exists so the engine can stop asking questions
 * whose answer its own preconditions already fixed; that only means anything if a report can say how often
 * it happened and how often the outcome was refused. This is the tally the human verification needs.
 *
 * Entries are the `kind: "action"` records. Both shapes are read, because a report may predate the
 * attribution fix: `reason` names the decider (`engine_decided` or `auto_*`), and `rejectedBecause` carries
 * the refusal -- but an older report put the refusal in `reason` itself, where it overwrote the attribution.
 * So an entry counts as a takeover when it is `auto: true` and its reason is one of the takeover names.
 */
const TAKEOVER_REASON = /^engine_decided$|^auto_/;
export function takeoversOf(entries = []) {
  const actions = entries.filter((e) => e?.kind === 'action');
  // `auto: true` is the durable marker: the engine issued it without the model choosing. The reason is what
  // names the rule, and in the OLD reports a refusal overwrote it -- `jev-report-20261010-012710` carries
  // three `queue_changed` entries that were takeovers refused on a busy queue, and filtering by reason name
  // here would drop exactly the entries this tally exists to surface.
  const takeovers = actions.filter((e) => e.auto === true);
  const byReason = {};
  const byGroup = {};
  const refusals = {};
  let refused = 0;
  let unattributed = 0;
  for (const t of takeovers) {
    const named = TAKEOVER_REASON.test(String(t.reason ?? ''));
    const key = named ? t.reason : 'unattributed';
    byReason[key] = (byReason[key] ?? 0) + 1;
    if (!named) unattributed++;
    const g = byGroup[t.question] ??= { taken: 0, accepted: 0, refused: 0 };
    g.taken++;
    if (t.accepted === false) {
      g.refused++;
      refused++;
      const why = t.rejectedBecause ?? (named ? 'unnamed' : String(t.reason ?? 'unknown'));
      refusals[why] = (refusals[why] ?? 0) + 1;
    } else g.accepted++;
  }
  const modelChosen = actions.filter((e) => e.auto !== true && e.accepted === true);
  // Transport trouble is the other half of "who decided": when the model is unreachable the engine runs
  // alone, and that shows up as a question count that stops rising rather than as actions. Reporting it
  // beside the tally keeps a degraded match from being read as a match with nothing to do.
  const errors = entries.filter((e) => e?.kind === 'error');
  const degraded = entries.filter((e) => e?.kind === 'degraded');
  return {
    actions: actions.length,
    taken: takeovers.length,
    accepted: takeovers.length - refused,
    refused,
    unattributed,
    byReason,
    byGroup,
    refusals,
    // Orders the model chose that were accepted, for the engine-vs-model ratio.
    modelChosen: modelChosen.length,
    errors: errors.length,
    errorMessages: [...new Set(errors.map((e) => String(e.message ?? '')))].slice(0, 4),
    degraded: degraded.length,
  };
}

/** The `match` block of a report, reduced to the fields worth attributing an audit to. */
export const reportMeta = (match = {}) => ({
  build: match.meta?.build ?? null,
  provider: match.providerName ?? null,
  model: match.model ?? null,
  strategyMode: match.strategyMode ?? null,
  outcome: match.outcome || match.reason || null,
  gameSeconds: match.gameSeconds ?? null,
});

/** `key -> count` tally rendered for a one-line console row. */
export const topChoice = (choices) => topOf(choices);
