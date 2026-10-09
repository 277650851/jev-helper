// Ask the decision layer what it would ask, across a fixed set of scenarios, and score how much is left
// for the model to decide. The measurement half of the rewrite: it answers "did this change reduce the
// determined questions, and did it break any group" without a running game.
//
//   node tools/bench-questions.mjs [--json] [--verbose]
//
// The scenarios and the catalogue live in src/synthetic-state.mjs; the API that lets the engine run over
// one lives in src/replay-state.mjs. Both explain what they can and cannot represent -- read those before
// drawing conclusions from a number here. In short: this scores QUESTION SHAPE, not play quality.
import { CATALOG, SCENARIOS, SCENARIO_NAMES } from '../src/synthetic-state.mjs';
import { replayApi, optionsOf } from '../src/replay-state.mjs';
import { collectState, candidateGroups, requestGroupsFrom } from '../src/player/werhd-jev-player.mjs';
import { classifyQuestion } from '../src/report-audit.mjs';

const asJson = process.argv.includes('--json');
const verbose = process.argv.includes('--verbose');
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');

// The build under test. It runs the same selection the match runs -- `requestGroupsFrom` -- so the table
// describes the questions that would actually be sent, not every group the engine can construct. A
// benchmark that counted wait-only groups would report 70% of them and be measuring nothing.
const build = (api, catalog) => optionsOf(requestGroupsFrom(candidateGroups(api, catalog, collectState(api, catalog), {}), {}, api.tick()));

const rows = [];
const totals = { asked: 0, forced: 0, narrow: 0, open: 0, empty: 0 };
const groupTotals = {};

for (const name of SCENARIO_NAMES) {
  // Every scenario is one player's view, and which units that player can build changes the menu, so the
  // side is stated rather than left to default.
  const state = { side: 'allied', ...SCENARIOS[name]() };
  let questions = {};
  let failure = null;
  try {
    const api = replayApi(state, { ...CATALOG });
    questions = build(api, { ...CATALOG });
  } catch (e) {
    // A scenario that cannot be replayed must be loud: a silent empty result would read as "no questions",
    // which is the most flattering possible answer and therefore the most dangerous one.
    failure = e.message;
  }
  const per = { name, groups: 0, forced: 0, narrow: 0, open: 0, empty: 0, failure, detail: {} };
  for (const [id, options] of Object.entries(questions)) {
    const kind = classifyQuestion(options);
    per.groups++;
    per[kind]++;
    totals.asked++;
    totals[kind]++;
    groupTotals[id] ??= { asked: 0, forced: 0, narrow: 0, open: 0, empty: 0 };
    groupTotals[id].asked++;
    groupTotals[id][kind]++;
    per.detail[id] = options;
  }
  rows.push(per);
}

if (asJson) {
  console.log(JSON.stringify({ totals, groups: groupTotals, scenarios: rows }, null, 2));
  process.exit(0);
}

console.log('决策问题基准（合成局面，仅衡量「题目形状」，不衡量打法）');
console.log('');
console.log(`场景 ${rows.length} 个 · 组-问题 ${totals.asked} 个`);
console.log(`  只有一个真实选项（引擎已可判定） ${String(totals.forced).padStart(4)}  ${pct(totals.forced, totals.asked)}`);
console.log(`  2-3 个真实选项                  ${String(totals.narrow).padStart(4)}  ${pct(totals.narrow, totals.asked)}`);
console.log(`  4 个以上                        ${String(totals.open).padStart(4)}  ${pct(totals.open, totals.asked)}`);
if (totals.empty) console.log(`  ⚠ 只有 wait 的组                ${String(totals.empty).padStart(4)}  ${pct(totals.empty, totals.asked)}`);
console.log('');
console.log('各组：');
console.log('  组            提问   唯一选项   2-3个   4+个');
for (const [id, g] of Object.entries(groupTotals).sort((a, b) => b[1].forced - a[1].forced)) {
  console.log(`  ${id.padEnd(13)} ${String(g.asked).padStart(4)} ${String(g.forced).padStart(8)} ${String(g.narrow).padStart(7)} ${String(g.open).padStart(6)}`);
}
console.log('');
console.log('各场景：');
for (const r of rows) {
  if (r.failure) { console.log(`  ${r.name.padEnd(16)} 重放失败: ${r.failure}`); continue; }
  console.log(`  ${r.name.padEnd(16)} 组 ${String(r.groups).padStart(2)} · 唯一选项 ${String(r.forced).padStart(2)} · 2-3 个 ${String(r.narrow).padStart(2)} · 4+ ${String(r.open).padStart(2)}`);
}

if (verbose) {
  console.log('\n逐场景选项：');
  for (const r of rows) {
    console.log(`\n[${r.name}]${r.failure ? ` 重放失败: ${r.failure}` : ''}`);
    for (const [id, opts] of Object.entries(r.detail)) console.log(`  ${id.padEnd(13)} ${opts.join(', ')}`);
  }
}

// A non-zero exit on failure keeps this usable as a gate: an engine that cannot build questions on a
// scenario has regressed, and a green table must not be able to hide it.
if (rows.some((r) => r.failure)) process.exit(1);
