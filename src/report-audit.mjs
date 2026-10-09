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

/**
 * Render the audit as an array of lines.
 *
 * This lives here rather than in `tools/audit-report.mjs` because the tool is not covered by the test
 * suite: a string replacement once broke the CLI's syntax and `npm test` stayed green, because a tool is
 * only ever run by hand. Returning lines instead of printing them makes the whole report reachable from a
 * test, and leaves the tool with nothing but reading a file and printing what it gets.
 */
export function formatAuditReport(a, t, file = '') {
  const out = [];
  const pct = (x, y) => (y ? `${Math.round((x / y) * 100)}%` : '—');
  const log = (line = '') => out.push(line);

  log(`战报 ${file}`);
  log(`构建 ${a.build ?? '（无指纹：早于构建指纹提交）'} · 来源 ${a.provider ?? '?'} / ${a.model ?? '?'} · 模式 ${a.strategyMode ?? '?'}`);
  log(`结果 ${a.outcome ?? '?'} · 时长 ${a.gameSeconds ? `${Math.round(a.gameSeconds)}s` : '?'} · 决策 ${a.decisions} 次 · 组-问题 ${a.questions} 个`);
  log('');
  log(`候选数分布：只有一个真实选项 ${a.counts.forced}（${pct(a.counts.forced, a.questions)}）· 2-3 个 ${a.counts.narrow}（${pct(a.counts.narrow, a.questions)}）· 4 个以上 ${a.counts.open}（${pct(a.counts.open, a.questions)}）`);
  if (a.counts.empty) log(`  ⚠ 只提供 wait 的组 ${a.counts.empty} 个（本不该发出）`);
  log(`平均候选 ${a.averageOptions} 个 · 平均题面 ${a.averageInstructionChars} 字符`);
  log(`全部组都选 wait 的决策：${a.waitEveryGroup} / ${a.decisions}`);
  log('');
  log(`★ 唯一选项题的结局：模型拒绝（选 wait）${a.forcedRefused} / ${a.counts.forced} = ${pct(a.forcedRefused, a.counts.forced)}；选中那唯一选项 ${a.forcedMatched}`);
  log(`  其中拒绝时几乎没有置信度的 ${a.forcedRefusedUnsure} 个（< ${LOW_CONFIDENCE}）。这是个**连续量的切点，不是两类**：`);
  log(`  本局拒绝置信度中位 ${a.refusedConfidenceMedian}，切点只挑出「几乎什么都没说」的那一端；`);
  log('  高于切点代表模型表达了一定偏好（从微弱到强），不等于「有把握地反对」。');
  log('  分布集中在少数选项上，所以按选项分开列；混在一起会得出相反结论：');
  log('  模型对某个强制选项表达了偏好，是「引擎判定可能有错」的证据；沉默则不是。');
  if (a.refusedForcedOptions?.length) {
    log('\n  被拒绝的唯一选项（按高于切点的次数排序）：');
    log('    选项                                    高于切点   低到无声');
    for (const o of a.refusedForcedOptions.slice(0, 10)) {
      log(`    ${o.option.padEnd(36)} ${String(o.above).padStart(6)} ${String(o.below).padStart(8)}`);
    }
  }
  log('');
  log('各组明细（按唯一选项题数量排序）：');
  log('  组            提问   唯一选项  拒绝唯一   等待率  平均候选  常选');
  for (const [id, r] of Object.entries(a.groups)) {
    log(`  ${id.padEnd(13)} ${String(r.asked).padStart(4)} ${String(r.forced).padStart(8)} ${String(r.refusedForced).padStart(8)} ${pct(r.wait, r.asked).padStart(7)} ${(Math.round((r.options / r.asked) * 100) / 100).toString().padStart(8)}  ${topChoice(r.choices)}`);
  }
  if (a.refusedExamples?.length) {
    log('\n被拒绝的唯一选项题样例：');
    for (const e of a.refusedExamples) log(`  tick ${e.tick} ${e.group}: 只能选 ${e.only} 或 wait → 选了 wait（置信 ${e.confidence}，概率 ${JSON.stringify(e.probabilities)}）`);
  }
  if (a.withoutWait) log(`\n注意：${a.withoutWait} 个问题没有 wait 选项（模型无法弃权）。`);

  // Who decided, over the whole match. The takeover work exists so the engine stops asking questions whose
  // answer its own preconditions already fixed; this is the tally that says whether it is happening and
  // whether the orders it takes are landing.
  log('');
  log('★ 接管归因（引擎自己决定的指令 vs 模型选的）：');
  log(`  动作 ${t.actions} 条 · 引擎接管 ${t.taken}（${pct(t.taken, t.taken + t.modelChosen)} 占已受理指令）· 受理 ${t.accepted} · 被拒 ${t.refused}`);
  log(`  模型选且受理 ${t.modelChosen} 条`);
  if (t.errors || t.degraded) {
    log(`  传输故障 ${t.errors} 次 · 降级 ${t.degraded} 次${t.degraded ? '（降级期间引擎单独行动，不再提问）' : ''}`);
    for (const m of t.errorMessages) log(`    ⚠ ${m}`);
  }
  if (t.unattributed) log(`  ⚠ 其中 ${t.unattributed} 条没有记下拒绝原因（旧战报形态，或字段在转存时被丢弃）`);
  if (t.taken) {
    log('\n  按接管规则：');
    for (const [k, v] of Object.entries(t.byReason).sort((x, y) => y[1] - x[1])) log(`    ${k.padEnd(20)} ${v}`);
    const why = Object.entries(t.refusals).sort((x, y) => y[1] - x[1]);
    if (why.length) {
      log('\n  被拒原因（选项供给质量：拒绝多说明引擎给的选项当下不可执行）：');
      for (const [k, v] of why) log(`    ${k.padEnd(20)} ${v}`);
    }
    log('\n  按组：');
    for (const [id, g] of Object.entries(t.byGroup).sort((x, y) => y[1].taken - x[1].taken)) {
      log(`    ${id.padEnd(13)} 接管 ${String(g.taken).padStart(3)} · 受理 ${String(g.accepted).padStart(3)} · 被拒 ${String(g.refused).padStart(3)}`);
    }
  }
  return out;
}
