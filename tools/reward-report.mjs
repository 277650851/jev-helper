// The decision-reward labels of a match, from a saved battle report.
//
//   node tools/reward-report.mjs <jev-report-*.json> [--json]
//
// This is the signal every later learning step reads: for each decision, what changed over the following
// REWARD_WINDOW_TICKS -- credits, army, enemy presence, and the loss/kill deltas of the ledger. A report
// written before this record existed says what was chosen and nothing about what followed, which is why no
// offline learning route was possible at all; such a report exits non-zero here rather than printing an
// empty table as if the match had produced no decisions.
//
// Read the numbers as LABELS, not as evidence. The opponent acts inside the same window, so one row is
// noisy by construction; the per-group means are what a later step can use, and even those need several
// matches (docs/jev-autopilot-redesign-review.md §0.43: four matches of identical code spread 44 points).
//
// The counting and the rendering live in src/reward-window.mjs so they can be tested without a file or a
// match; this entry point reads the report and prints, the same split as tools/audit-report.mjs.
import fs from 'node:fs/promises';
import { formatRewardReport } from '../src/reward-window.mjs';

const file = process.argv[2];
const asJson = process.argv.includes('--json');
if (!file) { console.error('usage: node tools/reward-report.mjs <jev-report-*.json> [--json]'); process.exit(1); }

const report = JSON.parse(await fs.readFile(file, 'utf8'));
const entries = Array.isArray(report) ? report : report.entries ?? [];
const entry = entries.filter((e) => e?.kind === 'rewards').at(-1);
if (!entry) {
  console.error(`${file}: 这份战报没有 rewards 记录。`);
  console.error('  构建早于该记录，或本局一条决策都没结算——两者含义不同，别当成「没有决策」。');
  process.exit(2);
}

// Rebuild the summary shape the renderer takes, so the reader path is the one a live match produces.
const summary = {
  rows: entry.rows ?? 0,
  open: entry.open ?? 0,
  dropped: entry.dropped ?? 0,
  kept: (entry.list ?? []).length,
  totalCredits: entry.totalCredits ?? 0,
  totalExchange: entry.totalExchange ?? 0,
  groups: entry.groups ?? [],
  list: entry.list ?? [],
};

if (asJson) {
  console.log(JSON.stringify({ file, ...summary }, null, 2));
} else {
  for (const line of formatRewardReport(summary, file)) console.log(line);
  if (summary.rows > summary.kept) {
    console.log('');
    console.log(`⚠ 明细被截断：已结算 ${summary.rows} 条，战报里只留下 ${summary.kept} 条（上限 120）。`);
    console.log('  按组的汇总和合计是完整的，逐条明细不是。');
  }
}
