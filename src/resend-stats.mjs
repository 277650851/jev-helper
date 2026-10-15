// How often one order had to be repeated before it took effect.
//
// The game API has no command receipts (`docs/game-api-requests.md` §7.1): an order the game silently
// ignores is indistinguishable from one that worked, so the extension re-sends on a timer and records
// nothing about it. The evidence in the review was dug out of reports by hand -- "a civilian house that
// could not be entered was re-entered 497 times", "one capture target was re-sent 89 times" -- and that is
// exactly the shape this module turns into a number the report carries.
//
// Discipline borrowed from `reward-window.mjs`: the running totals are maintained on write, NOT derived
// from the row list. The list is bounded so a long match cannot grow it without limit, and deriving a
// summary from a bounded list would silently describe only the tail -- the mistake that made every group
// mean in jev-report-20261015-024314 cover just the last 85% of the match.
export const MAX_RESEND_ROWS = 400;

// Who the order was sent to. The key says which task and which target, never which unit, so two engineers
// that each failed once and one engineer that failed twice looked identical -- and the fix is different in
// each case (a bad order versus a unit that keeps being replaced). Four is enough to recognise the cast of a
// task without letting a squad-sized order widen the row.
const unitList = (list) => (Array.isArray(list) ? list.map(Number).filter((v) => Number.isFinite(v)).slice(0, 4) : []);

export const emptyResendStats = () => ({ tasks: 0, resends: 0, rows: [], byKind: {} });

/** One finished or abandoned task: how many times its order had to be sent, and how it ended. */
export function recordResend(stats, { key, kind, resends, ticks, outcome, tick, unitIds }) {
  if (!stats) return;
  const n = Math.max(0, Math.round(Number(resends) || 0));
  const k = String(kind ?? 'other').slice(0, 24);
  stats.tasks = (stats.tasks ?? 0) + 1;
  stats.resends = (stats.resends ?? 0) + n;
  const bucket = (stats.byKind ??= {})[k] ??= { kind: k, tasks: 0, resends: 0 };
  bucket.tasks++;
  bucket.resends += n;
  stats.rows ??= [];
  stats.rows.push({
    key: String(key ?? '').slice(0, 64),
    kind: k,
    resends: n,
    ticks: Math.max(0, Math.round(Number(ticks) || 0)),
    outcome: String(outcome ?? 'unknown').slice(0, 24),
    tick: Math.round(Number(tick) || 0),
    units: unitList(unitIds),
  });
  // Only the display list is bounded; the counters above are already updated.
  if (stats.rows.length > MAX_RESEND_ROWS) {
    stats.dropped = (stats.dropped ?? 0) + (stats.rows.length - MAX_RESEND_ROWS);
    stats.rows.splice(0, stats.rows.length - MAX_RESEND_ROWS);
  }
}

/**
 * `tasks` and `resends` are the match totals and do not depend on how many rows were kept.
 * `worst` is the part that legitimately comes from the bounded list.
 */
export function summarizeResends(stats, { maxRows = 24 } = {}) {
  const s = stats ?? emptyResendStats();
  const rows = s.rows ?? [];
  return {
    tasks: s.tasks ?? 0,
    resends: s.resends ?? 0,
    kept: rows.length,
    dropped: s.dropped ?? 0,
    empty: (s.tasks ?? 0) === 0,
    worst: [...rows].sort((a, b) => b.resends - a.resends).slice(0, maxRows),
    byKind: Object.values(s.byKind ?? {}).sort((a, b) => b.resends - a.resends),
  };
}

export function formatResendReport(s, file) {
  const head = `重复下令统计 ${file ?? ''}`.trim();
  if (!s || s.empty) {
    return [head, '', '本局没有任何任务需要重复下令，或者这份战报的构建早于该记录。',
      '「没有记录」和「没有重复」是两件事：先确认 report 里有 kind:"resends" 这一条。'].join('\n');
  }
  const lines = [head, '',
    `已完成/放弃的任务 ${s.tasks} 个 · 合计重复下令 ${s.resends} 次 · 明细保留 ${s.kept} 条（丢弃 ${s.dropped}）`,
    ''];
  if (s.byKind.length) {
    lines.push('按类型：');
    for (const b of s.byKind) lines.push(`  ${b.kind.padEnd(14)} 任务 ${String(b.tasks).padStart(4)}  重复 ${String(b.resends).padStart(5)}`);
    lines.push('');
  }
  lines.push('重复最多：');
  for (const r of s.worst)
    lines.push(`  ${String(r.resends).padStart(4)} 次  ${r.kind.padEnd(12)} ${r.key.padEnd(28)} ${r.outcome}  ${r.ticks} 拍${r.units?.length ? `  单位 ${r.units.map((u) => `#${u}`).join(' ')}` : ''}`);
  lines.push('', '怎么读：一次都没重发的任务不在这里，所以总数是「代价」不是「工作量」。');
  lines.push('  重复很多次且结果是 refused/uncapturable/no_progress = 那条命令游戏根本没接受，');
  lines.push('  而 API 没有回执（§7.1），扩展只能靠超时判断——这就是它存在的理由。');
  lines.push('  行尾的「单位 #id」是被派去执行的那个单位：同一目标被两个工程师各试一次，和一个工程师试两次，');
  lines.push('  是两种不同的毛病（订单本身错 vs 单位被反复替换）。');
  return lines.join('\n');
}
