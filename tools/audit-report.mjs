// Audit the QUESTION SET an autopilot match actually asked, offline, from a saved battle report.
// The counting lives in src/report-audit.mjs so it can be tested without a file or a model.
//
//   node tools/audit-report.mjs <jev-report-*.json> [--json]
//
// Reading the numbers: `forced` is a question whose only non-wait option is a single key. Those are not
// judgement calls by construction -- whatever made the option legal had already been established by the
// engine -- so a high `forced` share with a high refusal rate means the model is being consulted where
// its opinion cannot help, and refusing is the only thing it can express. Compare groups: on three real
// matches the vehicles group refused 92-97% of its forced questions while tactics refused 0-10%, which
// is a property of the questions, not of the model.
import fs from 'node:fs/promises';
import { auditReport, reportMeta, topChoice, takeoversOf } from '../src/report-audit.mjs';

const file = process.argv[2];
const asJson = process.argv.includes('--json');
if (!file) { console.error('usage: node tools/audit-report.mjs <jev-report-*.json> [--json]'); process.exit(1); }

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const report = JSON.parse(await fs.readFile(file, 'utf8'));
const entries = Array.isArray(report) ? report : report.entries ?? [];
const a = auditReport(entries, reportMeta(Array.isArray(report) ? {} : report.match ?? {}));
const t = takeoversOf(entries);

if (asJson) { console.log(JSON.stringify({ file, ...a, takeovers: t }, null, 2)); process.exit(0); }

console.log(`战报 ${file}`);
console.log(`构建 ${a.build ?? '（无指纹：早于构建指纹提交）'} · 来源 ${a.provider ?? '?'} / ${a.model ?? '?'} · 模式 ${a.strategyMode ?? '?'}`);
console.log(`结果 ${a.outcome ?? '?'} · 时长 ${a.gameSeconds ? `${Math.round(a.gameSeconds)}s` : '?'} · 决策 ${a.decisions} 次 · 组-问题 ${a.questions} 个`);
console.log('');
console.log(`候选数分布：只有一个真实选项 ${a.counts.forced}（${pct(a.counts.forced, a.questions)}）· 2-3 个 ${a.counts.narrow}（${pct(a.counts.narrow, a.questions)}）· 4 个以上 ${a.counts.open}（${pct(a.counts.open, a.questions)}）`);
if (a.counts.empty) console.log(`  ⚠ 只提供 wait 的组 ${a.counts.empty} 个（本不该发出）`);
console.log(`平均候选 ${a.averageOptions} 个 · 平均题面 ${a.averageInstructionChars} 字符`);
console.log(`全部组都选 wait 的决策：${a.waitEveryGroup} / ${a.decisions}`);
console.log('');
console.log(`★ 唯一选项题的结局：模型拒绝（选 wait）${a.forcedRefused} / ${a.counts.forced} = ${pct(a.forcedRefused, a.counts.forced)}；选中那唯一选项 ${a.forcedMatched}`);
console.log('  （这类题在提问之前答案就已由引擎的前置条件确定，模型的意见无法改变它，只能拒绝）');
console.log('');
console.log('各组明细（按唯一选项题数量排序）：');
console.log('  组            提问   唯一选项  拒绝唯一   等待率  平均候选  常选');
for (const [id, r] of Object.entries(a.groups)) {
  console.log(`  ${id.padEnd(13)} ${String(r.asked).padStart(4)} ${String(r.forced).padStart(8)} ${String(r.refusedForced).padStart(8)} ${pct(r.wait, r.asked).padStart(7)} ${(Math.round((r.options / r.asked) * 100) / 100).toString().padStart(8)}  ${topChoice(r.choices)}`);
}
if (a.refusedExamples.length) {
  console.log('\n被拒绝的唯一选项题样例：');
  for (const e of a.refusedExamples) console.log(`  tick ${e.tick} ${e.group}: 只能选 ${e.only} 或 wait → 选了 wait（置信 ${e.confidence}，概率 ${JSON.stringify(e.probabilities)}）`);
}
if (a.withoutWait) console.log(`\n注意：${a.withoutWait} 个问题没有 wait 选项（模型无法弃权）。`);

// Who decided, over the whole match. The takeover work exists so the engine stops asking questions whose
// answer its own preconditions already fixed; this is the tally that says whether it is happening and
// whether the orders it takes are landing.
console.log('');
console.log('★ 接管归因（引擎自己决定的指令 vs 模型选的）：');
console.log(`  动作 ${t.actions} 条 · 引擎接管 ${t.taken}（${pct(t.taken, t.taken + t.modelChosen)} 占已受理指令）· 受理 ${t.accepted} · 被拒 ${t.refused}`);
console.log(`  模型选且受理 ${t.modelChosen} 条`);
if (t.unattributed) {
  console.log(`  ⚠ 其中 ${t.unattributed} 条 reason 被拒绝原因覆盖（旧战报形态）：无法从日志分辨它是哪条接管规则`);
}
if (t.taken) {
  console.log('\n  按接管规则：');
  for (const [k, v] of Object.entries(t.byReason).sort((x, y) => y[1] - x[1])) console.log(`    ${k.padEnd(20)} ${v}`);
  const why = Object.entries(t.refusals).sort((x, y) => y[1] - x[1]);
  if (why.length) {
    console.log('\n  被拒原因（选项供给质量：拒绝多说明引擎给的选项当下不可执行）：');
    for (const [k, v] of why) console.log(`    ${k.padEnd(20)} ${v}`);
  }
  console.log('\n  按组：');
  for (const [id, g] of Object.entries(t.byGroup).sort((x, y) => y[1].taken - x[1].taken)) {
    console.log(`    ${id.padEnd(13)} 接管 ${String(g.taken).padStart(3)} · 受理 ${String(g.accepted).padStart(3)} · 被拒 ${String(g.refused).padStart(3)}`);
  }
}
