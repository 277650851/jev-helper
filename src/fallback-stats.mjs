// Counters for the declared `auto: N` fallbacks: how often each one was armed, how often the model
// declined it, and how often it actually fired.
//
// Why this exists: the offline option audit can only see what FIRED. A declared threshold that was never
// reached looks exactly like a threshold that does not exist, and the two need opposite fixes -- one is a
// rule that does nothing, the other is a rule whose precondition never held in this match. `auto: N` is the
// mechanism where that ambiguity matters most, because the fallback is what makes a decision happen when the
// model will not make it: if a threshold is never reached, the option may as well not be on the menu.
//
// The counters live in `memory`, which `collectTakeovers` already receives, so wiring them in costs no
// signature change and no new plumbing. This module is the pure half, so it can be tested without a match.
export const emptyFallbackStats = () => ({});

/** The counter for one option, created on first sight. `threshold` is the declared `auto: N` (1 when owned). */
export function fallbackCounter(stats, group, key, threshold) {
  return (stats[`${group}:${key}`] ??= { group, key, threshold, armed: 0, declined: 0, byModel: 0, fired: 0 });
}

/**
 * Reduce the counters to the lists a reader needs.
 *   neverFired -- armed at least once and never fired: the model never declined it enough times in a row
 *   fired      -- fired at least once
 *   notArmed   -- the option was seen but never eligible; its precondition changed, which is a different
 *                 finding from a threshold that is never reached
 */
export function summarizeFallbacks(stats = {}) {
  const all = Object.values(stats).filter((s) => s && typeof s.armed === 'number');
  const neverFired = all.filter((s) => s.armed > 0 && s.fired === 0).sort((a, b) => b.armed - a.armed || a.key.localeCompare(b.key));
  const fired = all.filter((s) => s.fired > 0).sort((a, b) => b.fired - a.fired || a.key.localeCompare(b.key));
  const notArmed = all.filter((s) => s.armed === 0).sort((a, b) => a.key.localeCompare(b.key));
  return {
    declared: all.length,
    armed: all.reduce((n, s) => n + s.armed, 0),
    byModel: all.reduce((n, s) => n + s.byModel, 0),
    firedTotal: all.reduce((n, s) => n + s.fired, 0),
    neverFired,
    fired,
    notArmed,
  };
}

/**
 * Render the fallback tally. The rendering lives here for the same reason `formatAuditReport` does: a tool
 * is only ever run by hand, so anything that can only be reached from a tool is effectively untested.
 */
export function formatFallbackReport(s = {}, file = '') {
  const out = [];
  const log = (line = '') => out.push(line);
  const row = (x) => `    ${`${x.group}:${x.key}`.padEnd(34)} ${String(x.threshold).padStart(4)} ${String(x.armed).padStart(8)} ${String(x.declined).padStart(8)} ${String(x.byModel).padStart(10)} ${String(x.fired).padStart(10)}`;
  const head = '    选项                                 门槛   可触发   模型拒   模型自选   实际触发';

  log(`auto:N 兜底统计 ${file}`);
  log(`声明过门槛的选项 ${s.declared} 个 · 合计可触发 ${s.armed} 次 · 模型自己选了 ${s.byModel} 次 · 实际触发 ${s.firedTotal} 次`);

  log('');
  log(`★ 从没触发过的兜底：可触发过、但一次都没轮到 → ${s.neverFired.length} 个`);
  if (s.neverFired.length) {
    log(head);
    for (const x of s.neverFired.slice(0, 20)) log(row(x));
    if (s.neverFired.length > 20) log(`    …另有 ${s.neverFired.length - 20} 个`);
  } else {
    log('    （无：每个可触发的兜底都至少触发过一次）');
  }

  log('');
  log(`★ 触发过的兜底：${s.fired.length} 个`);
  if (s.fired.length) {
    log(head);
    for (const x of s.fired.slice(0, 20)) log(row(x));
    if (s.fired.length > 20) log(`    …另有 ${s.fired.length - 20} 个`);
  }

  if (s.notArmed.length) {
    log('');
    log(`（另有 ${s.notArmed.length} 个选项从未变成可触发状态：它们的前提在本局没满足过，`)
    log('  这与「门槛从没被达到」是两回事，别混在一起读。）');
  }

  log('');
  log('怎么读：一个兜底「可触发很多次、模型拒了很多次、却一次没触发」= 它的门槛没有被达到，');
  log('  也就是模型一直没被逼到那一步；「可触发 0 次」= 产生它的前提本局没成立过。');
  log('  两种都说明这条规则在本局没有起作用，但修法相反：前者调门槛/条件，后者查前提。');
  return out;
}
