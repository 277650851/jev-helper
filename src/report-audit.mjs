// Audit the QUESTION SET an autopilot match actually asked. Pure function over report entries, so it
// can be exercised from a test without a running game, a model, or a recorded file.
//
// Why this exists: the decision layer cannot be judged by reading it. Several separate investigations// on this codebase reached a confident wrong conclusion from the source alone -- a "flaky engine bug"
// that was really a shared test array, two "high severity" defects that were structurally unreachable,
// and a rules file assumed to be the live one -- and every one was settled by measuring. A battle report
// already records, per decision, the option keys the model was shown, what it chose, its probabilities,
// and the instruction text, so the measurement needs no new capture.
//
// The premise the rewrite rests on is that the engine asks the model questions whose answer its own
// preconditions already fixed, and the model can therefore only refuse. This module counts exactly that.

import { refusalReason } from './logbook.mjs';
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
// Refusal confidence is a CONTINUUM, not two kinds. Across two archived matches the 95 and 54 refusals of
// forced questions span 0 to 0.78 with a median near 0.20, so this cut picks out only the extreme tail --
// the refusals where the model expressed nothing at all. Everything above it carries *some* preference,
// from barely-there to strong, and calling that "confident disagreement" would overstate it. The median
// travels with the report so a reader can see where the cut actually falls in that match.
export const LOW_CONFIDENCE = 0.05;
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 1000) / 1000; };
export function auditReport(entries = [], meta = {}) {
  const decisions = entries.filter((e) => e?.kind === 'decision');
  const groups = {};
  const totals = { asked: 0, forced: 0, narrow: 0, open: 0, empty: 0, refusedForced: 0, refusedForcedUnsure: 0, matchedForced: 0, waitEveryGroup: 0, options: 0, instructionChars: 0, withoutWait: 0, refusedByOption: {}, refusedConfidence: [] };
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
      const rec = groups[id] ??= { asked: 0, forced: 0, narrow: 0, open: 0, empty: 0, refusedForced: 0, refusedForcedUnsure: 0, matchedForced: 0, wait: 0, options: 0, chars: 0, choices: {} };
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
          // A forced question the model refused while reporting almost no confidence is a different thing
          // from one it refused with a clear preference. `jev-report-20261010-061242` splits sharply --
          // `defend_base` forced 6 times at 0.002-0.011 and refused 4, `assemble_force` forced twice at 0.57
          // and 0.82 and answered both -- so confidence does separate "no opinion" from "has a preference",
          // where reasoning from the option's name (as an earlier pass of this review did) reached a
          // conclusion by luck. It does NOT separate "barely prefers" from "confidently disagrees": see the
          // note on LOW_CONFIDENCE, which is a cut on a continuum.
          //
          // Counted PER OPTION, because the distribution is concentrated: across three archived matches
          // `vehicles:produce_MTNK` was refused 41 times above the cut and 0 below it, while
          // `deployment:undeploy_mobile` was refused 0 above and 25 below. One aggregate hides that, and the
          // two point in opposite directions -- a preference expressed against a forced option is evidence
          // the engine's determination may be wrong, while silence is not.
          if (Number(g.confidence) < LOW_CONFIDENCE) { totals.refusedForcedUnsure++; rec.refusedForcedUnsure++; }
          const tally = totals.refusedByOption[`${id}:${real[0]}`] ??= { above: 0, below: 0 };
          if (Number(g.confidence) < LOW_CONFIDENCE) tally.below++; else tally.above++;
          totals.refusedConfidence.push(Number(g.confidence) || 0);
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
    // The refused ones the model had no opinion about, and the same split per option.
    forcedRefusedUnsure: totals.refusedForcedUnsure,
    refusedForcedOptions: Object.entries(totals.refusedByOption).map(([option, v]) => ({ option, ...v })).sort((x, y) => y.above - x.above),
    // Where the cut actually falls in this match, so the split above can be read against it.
    refusedConfidenceMedian: median(totals.refusedConfidence),
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
      // The same classification the live log uses, so the audit tool and the panel never disagree about the
      // same report. They did: this produced `unnamed: 4` where the panel produced `engine_decided: 4` for
      // the very same entries, which makes both numbers untrustworthy.
      const why = refusalReason(t);
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
