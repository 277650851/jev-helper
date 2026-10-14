// How often a single order had to be repeated before the game took it, from a saved battle report.
//
//   node tools/resend-report.mjs <jev-report-*.json> [--json]
//
// Reading the numbers: a task that succeeded on the first try never re-sends and is not listed, so the
// totals are the COST of the missing receipts, not the amount of work done. The shape to look for is
// `resends` high with the task ending in `refused` / `uncapturable` / `no_progress`: the game never accepted
// the order. `docs/game-api-requests.md` §7.1 asks for real receipts precisely because this loop cannot be
// told apart from one that worked; the review's "a civilian house that could not be entered was re-entered
// 497 times" and "one capture target was re-sent 89 times" had to be dug out by hand before this record.
//
// The counting and the rendering live in src/resend-stats.mjs so they can be tested without a file or a
// match; this entry point reads the report and prints, the same split as tools/fallback-report.mjs.
//
// These `task` entries were always emitted by the page and were being thrown away by the log serializer
// (`eventEntry` had no branch for the kind), so a report written before that fix carries none of them. That
// is a missing record, not a match with no repeats -- the tool exits non-zero rather than printing an empty
// tally as a result.
import fs from 'node:fs/promises';
import { emptyResendStats, recordResend, summarizeResends, formatResendReport } from '../src/resend-stats.mjs';

const file = process.argv[2];
const asJson = process.argv.includes('--json');
if (!file) {
  console.error('用法: node tools/resend-report.mjs <jev-report-*.json> [--json]');
  process.exit(2);
}

const report = JSON.parse(await fs.readFile(file, 'utf8'));
const tasks = (report.entries ?? []).filter((e) => e?.kind === 'task');
if (!tasks.length) {
  console.error(`这份战报里没有 kind:"task" 条目：${file}`);
  console.error('构建早于该记录时属正常；否则是序列化白名单又把它丢了（src/logbook.mjs 的 eventEntry）。');
  console.error('「没有记录」不等于「没有重复下令」——先核对战报里的 match.meta.build。');
  process.exit(2);
}

const stats = emptyResendStats();
for (const e of tasks) {
  recordResend(stats, {
    key: `${e.task ?? 'task'}#${e.targetId ?? '-'}`,
    kind: e.task,
    resends: e.resends,
    outcome: e.result,
    tick: e.tick,
  });
}
const summary = summarizeResends(stats);
const name = file.split(/[\\/]/).pop();
if (asJson) console.log(JSON.stringify({ file: name, ...summary }, null, 2));
else {
  console.log(formatResendReport(summary, name));
  console.log('');
  console.log(`条目来自战报的 kind:"task"，共 ${tasks.length} 条（含无需重发的任务）。`);
}
