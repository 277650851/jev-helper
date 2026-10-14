// What happened AFTER each choice: the reward label every later learning step needs.
//
// Why this exists: a battle report records what the model was shown and what it picked, but nothing about
// what followed. That makes every offline learning route impossible for the same reason: there is no signal
// to learn from. `optionLifecycle` can say an option was never CHOSEN; it cannot say whether choosing it
// would have helped. This module attaches the missing half -- for each decision, the change in credits,
// army, enemy presence and the loss/kill ledger over the following window.
//
// The window is deliberately short (REWARD_WINDOW_TICKS) and the label is deliberately blunt. A match's
// outcome is a single number at the end of 3000 ticks and carries almost no information about which of 500
// decisions was wrong; a 450-tick delta is a much closer guess at attribution. It is still only a guess:
// the opponent acts inside the same window, so the label is noisy by construction. It is a LABEL, not
// proof, and no conclusion should be drawn from one row -- see docs/jev-autopilot-redesign-review.md §0.43
// on why a single match cannot settle anything statistical.
//
// State lives in `memory.rewards` ({open, done}), because `memory` is already threaded through the decision
// loop and the observation sampler; nothing else has to be plumbed.
export const REWARD_WINDOW_TICKS = 450;
// Bounds. `open` is bounded so a stalled observation sampler cannot grow it without limit; `done` is bounded
// because a long match has ~500 decisions and the report is written to disk.
export const MAX_OPEN_REWARDS = 120;
export const MAX_DONE_REWARDS = 600;

/**
 * The reward-relevant numbers of one observation sample. Every field comes from what the observation
 * sampler already computed (`collectState` + `updateLedger`), so taking a baseline costs no extra API work.
 * Returns null when there is nothing to measure against.
 */
export function rewardSample(sample) {
  if (!sample) return null;
  const credits = typeof sample.credits === 'number' ? sample.credits : sample.state?.self?.credits;
  if (typeof credits !== 'number') return null;
  const l = sample.ledger ?? {};
  return {
    tick: typeof sample.tick === 'number' ? sample.tick : null,
    credits,
    own: typeof l.ownUnits === 'number' ? l.ownUnits : 0,
    enemy: typeof l.enemyUnits === 'number' ? l.enemyUnits : 0,
    // Cumulative by design: `updateLedger` only ever increases these, so a difference over a window is the
    // number of losses in that window. A counter that could go down would make every delta meaningless.
    lost: (l.ownUnitsLost ?? 0) + (l.ownBuildingsLost ?? 0),
    killed: (l.enemyUnitsDestroyed ?? 0) + (l.enemyBuildingsDestroyed ?? 0),
  };
}

/** Open a window on one decision. Without a baseline sample there is nothing to measure, so it is skipped. */
export function openReward(memory, { tick, group, choice, accepted, auto = false, sample } = {}) {
  const base = rewardSample(sample);
  if (base === null || typeof tick !== 'number' || !group || !choice) return null;
  const rewards = (memory.rewards ??= { open: [], done: [], dropped: 0 });
  rewards.open.push({ tick, group, choice, auto: auto === true, accepted: accepted === true, base });
  while (rewards.open.length > MAX_OPEN_REWARDS) {
    rewards.open.shift();
    rewards.dropped++;
  }
  return base;
}

/** Close every window whose horizon has passed, against the newest observation sample. */
export function closeRewards(memory, tick, sample, window = REWARD_WINDOW_TICKS) {
  const rewards = memory.rewards;
  const now = rewardSample(sample);
  if (!rewards?.open.length || now === null || typeof tick !== 'number') return [];
  const closed = [];
  rewards.open = rewards.open.filter((r) => {
    if (tick - r.tick < window) return true;
    const lost = now.lost - r.base.lost;
    const killed = now.killed - r.base.killed;
    closed.push({
      tick: r.tick, group: r.group, choice: r.choice, auto: r.auto, accepted: r.accepted,
      windowTicks: tick - r.tick,
      dCredits: now.credits - r.base.credits,
      dOwn: now.own - r.base.own,
      dEnemy: now.enemy - r.base.enemy,
      lost, killed, exchange: killed - lost,
    });
    return false;
  });
  rewards.done.push(...closed);
  while (rewards.done.length > MAX_DONE_REWARDS) {
    rewards.done.shift();
    rewards.dropped++;
  }
  return closed;
}

/** Per-group aggregates plus the totals. A group's rows are what a later step would learn from. */
export function summarizeRewards(memory, { maxRows = 120 } = {}) {
  const rewards = memory?.rewards ?? { open: [], done: [], dropped: 0 };
  const done = rewards.done ?? [];
  const groups = {};
  for (const r of done) {
    const g = (groups[r.group] ??= { group: r.group, rows: 0, chosen: 0, auto: 0, dCredits: 0, exchange: 0, killed: 0, lost: 0 });
    g.rows++;
    if (!r.auto) g.chosen++;
    else g.auto++;
    g.dCredits += r.dCredits;
    g.exchange += r.exchange;
    g.killed += r.killed;
    g.lost += r.lost;
  }
  const mean = (x, n) => (n ? Math.round((x / n) * 100) / 100 : 0);
  return {
    rows: done.length,
    open: rewards.open?.length ?? 0,
    dropped: rewards.dropped ?? 0,
    // `rows` is how many were closed and aggregated; `kept` is how many travel in the report (the rest were
    // dropped by the bound above). Both are reported so a reader cannot mistake a capped list for the whole.
    kept: Math.min(done.length, maxRows),
    totalCredits: done.reduce((n, r) => n + r.dCredits, 0),
    totalExchange: done.reduce((n, r) => n + r.exchange, 0),
    groups: Object.values(groups)
      .map((g) => ({ ...g, meanCredits: mean(g.dCredits, g.rows), meanExchange: mean(g.exchange, g.rows) }))
      .sort((a, b) => b.rows - a.rows),
    list: done.slice(-maxRows),
  };
}

/**
 * Render the reward table. Only the rows are listed, never a verdict: the label is noisy by construction
 * (the opponent moves inside the same window), so the point of the page is to make the signal auditable
 * before anything is learned from it.
 */
export function formatRewardReport(s = {}, file = '') {
  const out = [];
  const log = (line = '') => out.push(line);
  const sign = (n) => (n > 0 ? `+${n}` : String(n));

  log(`决策收益窗口 ${file}`);
  log(`已结算 ${s.rows} 条决策 · 未结算 ${s.open} 条 · 因上限丢弃 ${s.dropped} 条 · 本页列出最近 ${s.kept} 条`);
  log(`合计：资金 ${sign(s.totalCredits)} · 交换（击毁 − 损失）${sign(s.totalExchange)}`);
  log('');
  log('按组（窗口内的均值）：');
  log('  组            条目   模型选   引擎兜底   平均资金   平均交换   击毁   损失');
  for (const g of s.groups.slice(0, 20)) {
    log(`  ${g.group.padEnd(13)} ${String(g.rows).padStart(4)} ${String(g.chosen).padStart(7)} ${String(g.auto).padStart(10)} ${String(sign(g.meanCredits)).padStart(10)} ${String(sign(g.meanExchange)).padStart(10)} ${String(g.killed).padStart(6)} ${String(g.lost).padStart(6)}`);
  }
  log('');
  log('最近几条明细：');
  log('    tick   组           选择                          资金    兵力   敌军   击毁   损失   交换');
  for (const r of s.list.slice(-20)) {
    log(`  ${String(r.tick).padStart(6)}  ${String(r.group).padEnd(12)} ${String(r.choice).slice(0, 28).padEnd(28)} ${String(sign(r.dCredits)).padStart(7)} ${String(sign(r.dOwn)).padStart(6)} ${String(sign(r.dEnemy)).padStart(6)} ${String(r.killed).padStart(6)} ${String(r.lost).padStart(6)} ${String(sign(r.exchange)).padStart(6)}`);
  }
  log('');
  log('怎么读：这是**标签**，不是证据。对手在同一个窗口里也在行动，所以单条数字噪声极大；');
  log('  你评审 §0.43 已记录：四局同码的拒绝率极差 44 个百分点。要判断某个选择好不好，');
  log('  必须按组、跨多局、看分布——这也是这张表按组给均值而不是给单条结论的原因。');
  return out;
}
