// Persistent, bounded decision log kept in chrome.storage.local for later analysis.
// Records what the model was asked, what it chose, and what the executor did with it.
// Never stores credentials, session tokens or the raw battlefield state.
export const LOG_KEY = 'log';
export const LOG_MAX_ENTRIES = 20000;
// The 10 MB storage.local ceiling stopped applying when the extension asked for `unlimitedStorage`
// (see README: 100 matches with per-match logs), so this is now a practical bound rather than a
// platform one. It has to be generous because this is the *shared* log every match window is cut
// from: at 2000 entries a long match lost its whole opening. Measured on jev-report-20261014-215900
// (738 decisions), 2000 entries covered the last ~17% of the match -- the build order, the opening
// economy and how the enemy arrived were all gone before any per-match budget was even applied.
export const LOG_MAX_CHARS = 32_000_000;
const short = (value, n) => typeof value === 'string' ? value.slice(0, n) : value == null ? '' : String(value).slice(0, n);
const number = n => typeof n === 'number' && Number.isFinite(n) ? n : null;
// The units a task was ordered on. `targetId` says WHICH building, crate or bridge; it never says WHO was
// sent, so "one capture target was re-sent 89 times" could be one engineer that never arrived or three that
// each tried once -- and only the ids tell those apart, because both shapes were the same `resends` total.
// Bounded like every other list in this file.
const idList = (list) => (Array.isArray(list) ? list.map(number).filter((v) => v !== null).slice(0, 8) : []);

const afterCapture = (a) => a ? { afterCapture: { tick: number(a.tick), how: short(a.how, 16), lastHp: number(a.lastHp) } } : {};
// Compact snapshot of the state that was sent with a decision: numbers and flags only.
export function stateSummary(state = {}) {
  return {
    tick: number(state.tick), gameSeconds: number(state.gameSeconds),
    credits: number(state.self?.credits), freeCredits: number(state.uncommittedCredits), committedCredits: number(state.committedCredits),
    power: { total: number(state.self?.power?.total), drain: number(state.self?.power?.drain) },
    army: number(state.ownArmyCount), tanks: number(state.mobileTankCount), antiAir: number(state.antiAirCount), harvesters: number(state.harvesters),
    health: number(state.averageArmyHealth), visibleEnemies: number(state.visibleEnemyCount), nearbyEnemies: number(state.nearbyEnemyCount),
    baseUnderAttack: state.baseUnderAttack === true,
    // Composition, not just the count: "visibleEnemies: 6" cannot explain why a decision went the way
    // it did, and the counter profile is scored from this list. Ids and tiles stay out of the log.
    enemyProfile: state.enemyProfile ? {
      label: short(state.enemyProfile.label, 40), total: number(state.enemyProfile.total),
      groups: (state.enemyProfile.groups ?? []).slice(0, 6).map(g => ({ kind: short(g.kind, 12), count: number(g.count), threat: number(g.threat), armor: g.armor ? short(g.armor, 12) : null, maxRange: number(g.maxRange), names: (g.names ?? []).slice(0, 4).map(n => short(n, 24)) })),
      counters: (state.enemyProfile.counters ?? []).slice(0, 4).map(c => ({ name: short(c.name, 24), value: number(c.value) })),
    } : null,
    queues: (state.queues ?? []).slice(0, 8).map(q => ({ type: short(q.type, 12), items: (q.items ?? []).slice(0, 6).map(i => `${short(i.name, 20)}×${number(i.quantity) ?? 1}`) })),
    inventory: Object.fromEntries(Object.entries(state.inventory ?? {}).slice(0, 48).map(([k, u]) => [short(k, 20), number(u?.count) ?? 0])),
    investment: state.strategy?.investment ? { category: short(state.strategy.investment.category, 24), name: short(state.strategy.investment.name, 24) } : null,
    // The mission the engine believes is running. `scouting` re-asked the same two frontiers 17 times in
    // three consecutive matches while the model answered `wait` every time, and the fact that decides whether
    // the model was right -- an explore mission already on its way -- is in the state the MODEL is sent but
    // was not archived here, so the question could not be settled from the report. Mode and age only: this
    // summary carries no coordinates and no unit lists.
    activeMission: state.activeMission ? { mode: short(state.activeMission.mode, 16), ageTicks: number(state.activeMission.ageTicks) } : null,
    // Whether a scout is currently on its way, independent of `activeMission`: a scout sent while the army
    // attacks is tracked in `memory.scoutMissions`, which `activeMission` never shows. Without it archived,
    // the scouting question's own `wait` criterion ("wait only if a scout is already moving") could not be
    // checked against a report at all -- and that criterion is why 1328 of 1342 scouting questions were
    // answered `wait` across ten matches.
    scoutMoving: state.scoutMoving === true,
    // The engineering inputs, so "no engineer was ever offered" can be read: nothing to capture, no
    // barracks, an engineer already standing there, or the affordability gate. Four numbers, no unit lists.
    capture: state.capture ? {
      targets: number(state.capture.targets),
      visibleNeutrals: number(state.capture.visibleNeutrals),
      engineers: number(state.capture.engineers),
      barracks: state.capture.barracks === true,
    } : undefined,
    // The economy plan the engine is acting on. Four matches in a row were lost to the same thing
    // (docs/losses.md, all `economic_stall`) and none of it was visible here: the miner target is
    // derived from the refinery count, so the whole diagnosis had to be rebuilt from `harvesters` and
    // `inventory` after the fact. That is enough to see *that* there was one miner, not enough to see
    // what the engine thought it was doing, when it offered a miner, or why it stopped offering --
    // which is the question the `outran` rule was written to answer.
    economy: state.economy ? {
      targetMiners: number(state.economy.targetMiners), targetRefineries: number(state.economy.targetRefineries),
      incomeRate: number(state.economy.incomeRate), trend: number(state.economy.trend),
      surplus: state.economy.surplus === true, starving: state.economy.starving === true,
      // The replacement bill and whether it outran the income. `lostInWindow` is a count and
      // `replacementCost` a credit figure, both small; neither is a unit list.
      outran: state.economy.outran === true, lostInWindow: number(state.economy.lostInWindow), replacementCost: number(state.economy.replacementCost),
      reason: short(state.economy.reason, 200),
    } : null,
    ready: state.forceReadiness ? state.forceReadiness.ready === true : null, readyReason: short(state.forceReadiness?.reason, 160),
    ...(state.objectiveTarget ? { objective: state.objectiveTarget.found === false
      ? { found: false, seen: (state.objectiveTarget.seen ?? []).slice(0, 30).map((n) => short(n, 60)) }
      : { found: true, id: number(state.objectiveTarget.id), label: short(state.objectiveTarget.label, 60), name: short(state.objectiveTarget.name, 40), done: !!state.objectiveTarget.done,
        ...(state.objectiveTarget.mode ? { mode: short(state.objectiveTarget.mode, 12) } : {}), ...(state.objectiveTarget.captured ? { captured: true } : {}), ...(state.objectiveTarget.lost ? { lost: true } : {}),
        ...(number(state.objectiveTarget.hp) !== null ? { hp: state.objectiveTarget.hp } : {}), ...(afterCapture(state.objectiveTarget.afterCapture)) } } : {}),
    escalation: number(state.combatAssessment?.level), recentLost: number(state.combatAssessment?.recentLost), recentKilled: number(state.combatAssessment?.recentKilled),
    hints: Object.fromEntries(Object.entries(state.recentChoices ?? {}).filter(([, h]) => h.stale || h.removed).map(([id, h]) => [short(id, 24), { streak: number(h.streak), lostSince: number(h.lostSince), killedSince: number(h.killedSince), removed: h.removed === true }])),
  };
}

export function decisionEntry({ at, tick, provider, model, latencyMs, usage, state, questions, answers }) {
  const groups = {};
  for (const [id, q] of Object.entries(questions ?? {})) {
    const a = answers?.[id];
    groups[id] = {
      instructions: short(q.instructions, 400),
      options: Object.fromEntries(Object.entries(q.criteria ?? {}).slice(0, 64).map(([k, v]) => [short(k, 60), short(v, 240)])),
      optionCount: Object.keys(q.criteria ?? {}).length,
      choice: short(a?.choice, 60), confidence: number(a?.confidence),
      probabilities: Object.fromEntries(Object.entries(a?.probabilities ?? {}).sort(([, x], [, y]) => y - x).slice(0, 8).map(([k, v]) => [short(k, 60), Math.round(v * 1000) / 1000])),
      ...(a?.reason ? { reason: short(a.reason, 200) } : {}), ...(a?.fallback ? { fallback: true } : {}),
    };
  }
  return { at, kind: 'decision', tick: number(tick), provider: short(provider, 12), model: short(model, 60), latencyMs: number(latencyMs), inputTokens: number(usage?.input_tokens), outputTokens: number(usage?.output_tokens), state: stateSummary(state), groups };
}

// Commander mode. One order as the log keeps it; both the model's orders (background) and the
// page's execution results (event) use this shape, bounded so a long plan cannot flood storage.
const orderLine = (o) => {
  const out = { kind: short(o?.kind, 12) };
  for (const k of ['squad', 'action', 'item']) if (o?.[k] != null && o[k] !== '') out[k] = short(o[k], 40);
  for (const k of ['target', 'x', 'y', 'count', 'units', 'ordered']) if (number(o?.[k]) !== null) out[k] = o[k];
  if (typeof o?.accepted === 'boolean') out.accepted = o.accepted;
  if (o?.auto) out.auto = true;
  if (o?.reason) out.reason = short(o.reason, 200);
  if (o?.result) out.result = short(o.result, 200);
  if (o?.why) out.why = short(o.why, 200);
  return out;
};
const orderLines = (list) => (Array.isArray(list) ? list : []).slice(0, 20).map(orderLine);
export function commandEntry({ at, tick, provider, model, latencyMs, usage, briefChars, orders, rejected }) {
  return { at, kind: 'command', tick: number(tick), provider: short(provider, 12), model: short(model, 60), latencyMs: number(latencyMs), inputTokens: number(usage?.input_tokens), outputTokens: number(usage?.output_tokens),
    briefChars: number(briefChars), note: short(orders?.note, 400),
    orders: orderLines([...(orders?.squads ?? []).map((o) => ({ kind: 'squad', ...o })), ...(orders?.production ?? []).map((o) => ({ kind: 'production', ...o })), ...(orders?.engineers ?? []).map((o) => ({ kind: 'engineer', ...o }))]),
    rejected: orderLines(rejected) };
}

// The `auto: N` fallback tally rows. Bounded like every other list in this file, because a match can arm
// dozens of options and the report is written to disk.
const gateLines = (rows) => (Array.isArray(rows) ? rows.slice(0, 24).map((r) => ({
  group: short(r?.group, 24), key: short(r?.key, 48), threshold: number(r?.threshold),
  armed: number(r?.armed), declined: number(r?.declined), byModel: number(r?.byModel), fired: number(r?.fired),
})) : []);

// The decision-reward rows and their per-group aggregates. Bounded like everything else here: a long match
// has ~500 decisions and this record is written to the Downloads report.
const rewardRows = (rows) => (Array.isArray(rows) ? rows.slice(0, 120).map((r) => ({
  tick: number(r?.tick), group: short(r?.group, 24), choice: short(r?.choice, 48),
  auto: r?.auto === true, accepted: r?.accepted === true, windowTicks: number(r?.windowTicks),
  dCredits: number(r?.dCredits), dOwn: number(r?.dOwn), dEnemy: number(r?.dEnemy),
  lost: number(r?.lost), killed: number(r?.killed), exchange: number(r?.exchange),
})) : []);
const rewardGroups = (rows) => (Array.isArray(rows) ? rows.slice(0, 24).map((g) => ({
  group: short(g?.group, 24), rows: number(g?.rows), chosen: number(g?.chosen), auto: number(g?.auto),
  meanCredits: number(g?.meanCredits), meanExchange: number(g?.meanExchange),
  killed: number(g?.killed), lost: number(g?.lost),
})) : []);

export function eventEntry(e, at) {
  const kind = short(e?.kind, 24);
  const base = { at, kind, tick: number(e?.tick) };
  // `auto` marks an action the extension executed without a usable answer (the page emits it when
  // the model declines repeatedly). Kept so the fallback is visible in the panel and to analyze-log.
  //
  // `engineOwned` and `rejectedBecause` are carried too, and they were missing here: this serializer kept
  // only `reason`, so the two fields the attribution work added never reached a saved report at all --
  // measured on `jev-report-20261010-061242`, 0 of 63 action entries had either. A record that drops the
  // reason for a refusal cannot show whether the engine's own choice was refused by the game or the model
  // declined a real question, which is the distinction the whole takeover mechanism exists to create.
  if (kind === 'action') return { ...base, question: short(e.question, 40), choice: short(e.choice, 60), accepted: e.accepted === true, reason: short(e.reason, 40), ...(e.rejectedBecause ? { rejectedBecause: short(e.rejectedBecause, 40) } : {}), ...(e.engineOwned ? { engineOwned: true } : {}), actionType: short(e.action?.type, 24), actionName: short(e.action?.name ?? e.action?.mode, 40),
    // Which units carried the order, and how many items one accepted production option actually queued. Both
    // are already on the event -- `takeoverEvent` and the answer path both spread the executor's result, and
    // `action.ids` is the order itself -- and both were being dropped right here: a mission that dispatched a
    // party looked like one that dispatched a single unit, and a `produce` that queued three looked like one
    // that queued one. Measured on jev-report-20261015-092542: 116 `produce` entries, none carrying a count,
    // and 14 accepted `explore_` missions whose crew could not be read back at all.
    ...(Array.isArray(e.action?.ids) && e.action.ids.length ? { ids: idList(e.action.ids) } : {}), ...(Number.isFinite(e.count) ? { count: e.count } : {}),
    // Where a `special` action was sent. Without it a saved report cannot tell a chrono miner recalled to
    // its refinery from the same miner stepped ten tiles into the open -- both are one `flee_miner_<id>`
    // action with no destination, which is exactly the difference the recall change turns on. Promised as
    // a next-match check and found unmeasurable on jev-report-20261015-065646.
    ...(typeof e.action?.tile?.x === 'number' && typeof e.action?.tile?.y === 'number' ? { tile: [e.action.tile.x, e.action.tile.y] } : {}),
    cost: number(e.action?.cost), confidence: number(e.confidence), latencyMs: number(e.latencyMs), ageTicks: number(e.ageTicks), ...(e.auto ? { auto: true } : {}) };
  // The page's side of a commander turn: what was executed and why not. `executed` tells it apart
  // from the background's entry for the same turn.
  if (kind === 'command') return { ...base, executed: true, sourceTick: number(e.sourceTick), note: short(e.note, 400), orders: orderLines(e.results), rejected: orderLines(e.rejected), auto: orderLines(e.auto) };
  if (kind === 'stale') return { ...base, currentTick: number(e.currentTick), latencyMs: number(e.latencyMs), budgetTicks: number(e.budgetTicks) };
  if (kind === 'start') return { ...base, maxDecisions: number(e.maxDecisions), policy: short(e.policy, 40) };
  if (kind === 'stop') return { ...base, reason: short(e.reason, 40) };
  // A special task's own ending: `collect_crate` / house entry / capture / bridge repair, and whether it
  // completed or was given up on. These events were ALWAYS emitted -- `special.mjs` calls
  // `emit({ kind: 'task', result, ... })` at the end of every task -- and this serializer had no branch for
  // them, so the entire class was discarded by the `return null` at the bottom. That is why the review's
  // evidence had to be dug out by hand ("a civilian house that could not be entered was re-entered 497
  // times", "one capture target was re-sent 89 times"): the game API has no command receipts
  // (docs/game-api-requests.md §7.1), so an order it silently ignores looks exactly like one that worked,
  // and `resends` on this record is the only place that difference becomes visible in a saved report.
  if (kind === 'task') return { ...base, task: short(e.task, 32), result: short(e.result, 32), targetId: number(e.targetId), ids: idList(e.ids), resends: number(e.resends), text: short(e.description, 160) };
  // The `auto: N` fallback tally, written once when a match ends. A kind of its own rather than extra fields
  // on `stop`, because `stop`'s shape is read by the panel and by analyze-log: widening a record that other
  // readers already parse changes its meaning for all of them at once.
  if (kind === 'gates') return { ...base, declared: number(e.declared), armed: number(e.armed), byModel: number(e.byModel), firedTotal: number(e.firedTotal),
    neverFired: gateLines(e.neverFired), fired: gateLines(e.fired) };
  // The decision-reward labels, written once when a match ends. This is the signal every later learning step
  // reads: without it a report says what was chosen but never what followed, which is why no offline learning
  // route was possible before. `rows` is the full count and `list` is capped, so a reader cannot mistake a
  // truncated list for the whole match.
  if (kind === 'rewards') return { ...base, rows: number(e.rows), open: number(e.open), dropped: number(e.dropped),
    totalCredits: number(e.totalCredits), totalExchange: number(e.totalExchange),
    groups: rewardGroups(e.groups), list: rewardRows(e.list) };
  if (kind === 'outcome') return { ...base, result: short(e.result, 24),
    ...(Array.isArray(e.players) ? { players: e.players.slice(0, 16).map((p) => ({ name: short(p?.name, 30), allied: !!p?.allied, defeated: !!p?.defeated })) } : {}),
    ...(e.objective ? { objective: { id: number(e.objective.id), label: short(e.objective.label, 60), done: !!e.objective.done, captured: !!e.objective.captured, lost: !!e.objective.lost, hp: number(e.objective.hp), ...afterCapture(e.objective.afterCapture) } } : {}),
    ...(number(e.ownBuildings) !== null ? { ownBuildings: e.ownBuildings } : {}) };
  if (kind === 'error') return { ...base, message: short(e.message, 240) };
  if (kind === 'meta') return { ...base, pageTitle: short(e.pageTitle, 120), playerCount: number(e.playerCount), opponents: number(e.opponents), map: e.map && number(e.map.width) !== null ? { width: e.map.width, height: e.map.height } : null, startTick: number(e.startTick) };
  // Where a building was actually placed. The record kept the name and one line of text, so a saved report
  // could not tell a power plant put beside the refinery from one put in the far corner -- which is the whole
  // content of the choice, and the field the placement code itself re-reads (`memory.lastPlaced`). The game
  // does not confirm placement (`docs/game-api-requests.md`: 放置是否成功「不确认，20 拍后重新选址」), so the
  // coordinate is also the only way to see one building placed twice.
  if (kind === 'place') return { ...base, name: short(e.name, 40), text: short(e.description ?? e.purpose ?? e.message, 160), x: number(e.x), y: number(e.y) };
  // The camera record is the only one that can name the base tile: `werhd-jev-camera.mjs` falls back to
  // `base.tile` when nothing more interesting is happening. Dropping x/y here -- the same loss `place` had --
  // left the construction yard's position unreadable from a report, which is why the wall geometry of
  // jev-report-20261015-092542 had to be recovered by fitting a circle to the segments instead of measuring
  // them against the base.
  if (kind === 'camera') return { ...base, name: short(e.name, 40), text: short(e.description ?? e.purpose ?? e.message, 160), x: number(e.x), y: number(e.y) };
  if (['micro', 'observed'].includes(kind)) return { ...base, name: short(e.name, 40), text: short(e.description ?? e.purpose ?? e.message, 160) };
  return null; // observations are sampled by telemetry already; everything else is noise
}

// One match's own log is stored under its own key and kept for all 100 matches, so it gets a much
// smaller budget than the shared log. Without this, 100 matches each holding a near-maximum window
// would mean hundreds of megabytes in storage.local, which is what unlimitedStorage was masking.
// One match's own log is stored under its own key and kept for all 100 matches, so it gets a much
// smaller budget than the shared log. This is the *storage* budget: 100 of these sit side by side.
export const MATCH_LOG_MAX_CHARS = 500_000;
// The battle report is a different destination with a different cost: it is written to the Downloads
// folder and is the artifact that actually gets read afterwards (shared for diagnosis, attached to a
// bug report, analysed by tools/audit-report.mjs). Nothing about it is multiplied by 100 and none of
// it is synced, so it does not need to share the stored copy's budget. Measured on the same report,
// the 500 KB bound kept 695 of 2000 entries -- the audit could see the endgame and not the game.
export const REPORT_LOG_MAX_CHARS = 8_000_000;
// Trims oldest-first until both the entry count and the size bound hold; the newest entry is kept.
const trim = (entries, maxChars) => {
  let next = entries.slice(-LOG_MAX_ENTRIES);
  let size = JSON.stringify(next).length;
  while (next.length > 1 && size > maxChars) { const dropped = next.splice(0, Math.max(1, Math.ceil(next.length * 0.1))); size -= JSON.stringify(dropped).length - 2; }
  return next;
};
export function appendEntries(entries, additions) {
  return trim([...(entries ?? []), ...additions], LOG_MAX_CHARS);
}
// The storage copy: one per match, kept for all of them.
export function trimMatchEntries(entries) {
  return trim(entries, MATCH_LOG_MAX_CHARS);
}
// The report copy: same trim, a budget that is not shared with 99 other matches.
export function trimReportEntries(entries) {
  return trim(entries, REPORT_LOG_MAX_CHARS);
}

const inc = (map, key, by = 1) => { map[key] = (map[key] ?? 0) + by; };
const top = (map, n = 8) => Object.fromEntries(Object.entries(map).sort(([, a], [, b]) => b - a).slice(0, n));
// Why an order was refused. The current record keeps the decider in `reason` and the cause in
// `rejectedBecause`; a record written before that change overloaded `reason` with the refusal, so an
// unattributed one is reported as such rather than as the decider's name.
export function refusalReason(e = {}) {
  if (e.rejectedBecause) return e.rejectedBecause;
  const r = String(e.reason ?? '');
  return /^engine_decided$|^auto_/.test(r) ? 'unattributed' : (r || '?');
}

// Aggregate view for the popup and the export file.
export function logStats(entries = []) {
  const s = { entries: entries.length, from: null, to: null, sessions: 0, decisions: 0, failures: 0, stale: 0, latency: { avg: null, max: null }, usage: { inputTokens: 0, outputTokens: 0 }, fallbacks: 0, providers: {}, models: {},
    groups: {}, actions: { total: 0, accepted: 0, skipped: 0, waits: 0, byType: {}, skippedReasons: {}, acceptedProduce: {} }, outcomes: {}, errors: 0,
    commands: { count: 0, latencyAvg: null, rejected: 0, executed: 0, notExecuted: 0, autoDefense: 0 } };
  let latencySum = 0, latencyCount = 0, commandLatency = 0, commandTimed = 0;
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    s.from ??= e.at; s.to = e.at;
    if (e.kind === 'session' && e.event === 'start') s.sessions++;
    else if (e.kind === 'failure') s.failures++;
    else if (e.kind === 'stale') s.stale++;
    else if (e.kind === 'error') s.errors++;
    else if (e.kind === 'outcome') inc(s.outcomes, e.result || 'unknown');
    else if (e.kind === 'decision') {
      s.decisions++; if (e.provider) inc(s.providers, e.provider); if (e.model) inc(s.models, e.model);
      s.usage.inputTokens += e.inputTokens ?? 0; s.usage.outputTokens += e.outputTokens ?? 0;
      if (e.latencyMs !== null) { latencySum += e.latencyMs; latencyCount++; s.latency.max = Math.max(s.latency.max ?? 0, e.latencyMs); }
      for (const [id, g] of Object.entries(e.groups ?? {})) {
        const stat = s.groups[id] ??= { asked: 0, waits: 0, avgOptions: 0, avgConfidence: 0, choices: {} };
        stat.asked++; stat.avgOptions += g.optionCount ?? 0; stat.avgConfidence += g.confidence ?? 0;
        if (g.choice === 'wait') stat.waits++; inc(stat.choices, g.choice || '?'); if (g.fallback) s.fallbacks++;
      }
    } else if (e.kind === 'command' && e.executed) {
      for (const o of e.orders ?? []) o.accepted ? s.commands.executed++ : s.commands.notExecuted++;
      s.commands.autoDefense += (e.auto ?? []).length;
    } else if (e.kind === 'command') {
      // A commander turn is one model request: it counts toward latency and tokens like a decision.
      s.commands.count++; s.commands.rejected += (e.rejected ?? []).length;
      if (e.provider) inc(s.providers, e.provider); if (e.model) inc(s.models, e.model);
      s.usage.inputTokens += e.inputTokens ?? 0; s.usage.outputTokens += e.outputTokens ?? 0;
      if (e.latencyMs !== null && e.latencyMs !== undefined) { latencySum += e.latencyMs; latencyCount++; commandLatency += e.latencyMs; commandTimed++; s.latency.max = Math.max(s.latency.max ?? 0, e.latencyMs); }
    } else if (e.kind === 'action') {
      s.actions.total++;
      if (e.accepted) { s.actions.accepted++; inc(s.actions.byType, e.actionType || '?'); if (e.actionType === 'produce') inc(s.actions.acceptedProduce, e.actionName || '?'); }
      else if (e.reason === 'wait') s.actions.waits++;
      // WHY the order was refused, not WHO decided it. `reason` names the decider (`engine_decided` or
      // `auto_*`) and a refused takeover carries its refusal in `rejectedBecause`; an older record put the
      // refusal in `reason` itself. Reading only `reason` therefore reported `engine_decided` as a skip
      // reason -- the decider's name standing in for a cause it does not describe.
      else { s.actions.skipped++; inc(s.actions.skippedReasons, refusalReason(e)); }
    }
  }
  if (latencyCount) s.latency.avg = Math.round(latencySum / latencyCount);
  if (commandTimed) s.commands.latencyAvg = Math.round(commandLatency / commandTimed);
  for (const stat of Object.values(s.groups)) { stat.avgOptions = Math.round(stat.avgOptions / stat.asked * 10) / 10; stat.avgConfidence = Math.round(stat.avgConfidence / stat.asked * 100) / 100; stat.waitRate = Math.round(stat.waits / stat.asked * 100); stat.choices = top(stat.choices); }
  s.actions.skippedReasons = top(s.actions.skippedReasons); s.actions.acceptedProduce = top(s.actions.acceptedProduce, 12);
  return s;
}
