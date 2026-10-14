// The `auto: N` fallback tally of a match, from a saved battle report.
//
//   node tools/fallback-report.mjs <jev-report-*.json> [--json]
//
// Reading the numbers: a fallback is ARMED on every turn its option is eligible, and FIRES once the model
// has declined it `threshold` times running. So
//   armed many times, fired 0            -- the threshold was never reached: the rule did nothing this match
//   armed 0                              -- the precondition never held, which is a different finding
//   byModel > 0                          -- the model chose it and the fallback was not needed
// The first is the one a report could not previously show at all: `optionLifecycle` sees only what FIRED, so
// a threshold that was never reached was indistinguishable from a threshold that does not exist.
//
// The counting and the rendering live in src/fallback-stats.mjs so they can be tested without a file or a
// match; this entry point reads the report and prints, the same split as tools/audit-report.mjs.
//
// Reports written before this record existed carry no `gates` entry at all -- that is a missing field, not a
// match with no fallbacks, and the tool exits non-zero rather than printing an empty tally as a result.
import fs from 'node:fs/promises';
import { summarizeFallbacks, formatFallbackReport } from '../src/fallback-stats.mjs';

const file = process.argv[2];
const asJson = process.argv.includes('--json');
if (!file) { console.error('usage: node tools/fallback-report.mjs <jev-report-*.json> [--json]'); process.exit(1); }

const report = JSON.parse(await fs.readFile(file, 'utf8'));
const entries = Array.isArray(report) ? report : report.entries ?? [];
const gates = entries.filter((e) => e?.kind === 'gates').at(-1);
if (!gates) {
  console.error(`${file}: 这份战报没有 gates 记录。`);
  console.error('  构建早于该记录，或本局一个可触发的 auto:N 兜底都没有——两者含义不同，别当成「没有兜底」。');
  process.exit(2);
}

// Rebuild the counter shape the summarizer takes, so the reader path is exactly the one a live match uses.
const stats = {};
for (const row of [...(gates.neverFired ?? []), ...(gates.fired ?? [])]) {
  if (!row?.group || !row?.key) continue;
  stats[`${row.group}:${row.key}`] = row;
}
const summary = summarizeFallbacks(stats);
const truncated = (gates.declared ?? 0) > Object.keys(stats).length;

if (asJson) {
  console.log(JSON.stringify({ file, declared: gates.declared, armed: gates.armed, byModel: gates.byModel, firedTotal: gates.firedTotal, truncated, ...summary }, null, 2));
} else {
  const lines = formatFallbackReport(summary, file);
  if (truncated) {
    lines.push('');
    lines.push(`⚠ 战报里的清单被截断：声明 ${gates.declared} 个，只留下 ${Object.keys(stats).length} 个（每类上限 24）。`);
    lines.push('  合计数字（可触发 / 模型自选 / 实际触发）是完整的，逐选项清单不是。');
  }
  for (const line of lines) console.log(line);
}
