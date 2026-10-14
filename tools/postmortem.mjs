#!/usr/bin/env node
// Classify why a match was lost, from the numbers the report already carries, and remember it.
//
// Usage:
//   node tools/postmortem.mjs <report.json> [...]      analyse and print
//   node tools/postmortem.mjs --append <report.json>  analyse, then record in docs/losses.md
//   node tools/postmortem.mjs --list                 show what has been recorded
//   node tools/postmortem.mjs --check                compare a report against what was recorded before
//
// Why this exists
// ---------------
// Three matches in a row ended in "defeat" and each one was diagnosed by hand, from a partly
// truncated log, with a different story: the first was overrun at 1 104 s with no money, the second
// ended with 2 580 credits and no refinery, the third had its base ground from 22 buildings to 1.
// Nothing recorded that, so the next session started from zero again, and the review document had to
// carry it as prose in section 0.4x instead of as something checkable.
//
// The verdict is deliberately a *classification over measured series*, not a narrative. Every line it
// prints is a number that can be argued with, and the thresholds are the whole judgement -- they are
// named constants at the top so a disagreement is about a number rather than about a feeling.
//
// What this is not
// ----------------
// It does not decide what to change. One match cannot: a single game cannot tell a real improvement
// from map, matchup or spawn luck, and the review document says so explicitly (0.43, "a single match
// cannot verify any change -- three identical-code runs give a distribution"). What it does is make
// the loss legible and comparable, which is the precondition for the three-run comparison. That is
// the part of "self-improvement" that is actually defensible here; see the note at the end.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEDGER = path.join(HERE, '..', 'docs', 'losses.md');

// ---------------------------------------------------------------- thresholds
// Named so that disagreeing with a verdict means disagreeing with a number.
export const T = {
  // An army counts as collapsed once it is under this fraction of its own peak and stays there.
  collapseRatio: 0.4,
  // ...for at least this many samples, so one bad tick is not a collapse.
  collapseSamples: 3,
  // Credits at (or under) this level for more than this share of the match means the economy stopped.
  brokeCredits: 500,
  brokeShare: 0.2,
  // Losing this share of everything built says production was not outpacing losses.
  bledShare: 0.5,
  // Buildings falling below this share of their peak, this late, is the wipe itself.
  wipeRatio: 0.4,
  wipeTailShare: 0.25,
};

// ---------------------------------------------------------------- reading a report
export function readReport(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const m = j.match ?? {};
  const history = (m.history ?? []).filter((h) => Number.isFinite(h.gameSeconds)).sort((a, b) => a.gameSeconds - b.gameSeconds);
  if (history.length < 4) throw new Error(`${file}: history has ${history.length} usable samples, too few to diagnose`);
  return { file, bundle: j, match: m, history, ledger: m.ledger ?? {} };
}

// The series the verdict is computed from, each reduced to the one number that matters.
export function series({ history }) {
  const units = history.map((h) => h.ownUnits ?? 0);
  const buildings = history.map((h) => h.ownBuildings ?? 0);
  const credits = history.map((h) => h.credits ?? 0);
  const enemy = history.map((h) => h.enemyUnits ?? 0);
  const last = history.at(-1);
  const peak = (a) => a.reduce((m, v) => Math.max(m, v), 0);
  const unitPeak = peak(units), buildingPeak = peak(buildings);
  const unitPeakIdx = units.indexOf(unitPeak);

  // "Broke" only counts from the army's peak onwards. Before it you are spending an opening bank on
  // a base, and reading that as a stall is how the first version of this tool called all three
  // matches an economic stall "from 237 s" -- which is just the opening spend and said nothing.
  // After the peak you are supposed to be replacing what you lost, so a wallet at zero is a stall.
  const after = credits.slice(unitPeakIdx);
  const brokeIdx = after.findIndex((c) => c <= T.brokeCredits);

  return {
    samples: history.length,
    seconds: last.gameSeconds,
    unitPeak,
    unitPeakAt: history[unitPeakIdx]?.gameSeconds ?? 0,
    unitEnd: units.at(-1),
    buildingPeak, buildingEnd: buildings.at(-1),
    enemyEnd: enemy.at(-1), enemyPeak: peak(enemy),
    brokeShare: after.length ? after.filter((c) => c <= T.brokeCredits).length / after.length : 0,
    brokeAt: brokeIdx < 0 ? null : history[unitPeakIdx + brokeIdx]?.gameSeconds ?? null,
    built: last.ownBuilt ?? 0, lost: last.ownLost ?? 0, kills: last.enemyDestroyed ?? 0,
  };
}

// When the army fell off its peak for good.
export function collapseAt({ history }) {
  const units = history.map((h) => h.ownUnits ?? 0);
  const peak = units.reduce((m, v) => Math.max(m, v), 0);
  if (!peak) return null;
  const floor = peak * T.collapseRatio;
  for (let i = 0; i + T.collapseSamples <= units.length; i += 1) {
    const window = units.slice(i, i + T.collapseSamples);
    if (window.every((v) => v <= floor)) {
      // It has to stay down: a later sample recovering past half the peak means this was a dip.
      const recovered = units.slice(i).some((v) => v > peak * 0.5);
      if (!recovered) return { at: history[i].gameSeconds, peak, floor };
    }
  }
  return null;
}

// When the base itself came apart.
export function wipeAt({ history }) {
  const buildings = history.map((h) => h.ownBuildings ?? 0);
  const peak = buildings.reduce((m, v) => Math.max(m, v), 0);
  if (!peak) return null;
  const start = Math.floor(history.length * (1 - T.wipeTailShare));
  for (let i = start; i < buildings.length; i += 1)
    if (buildings[i] <= peak * T.wipeRatio) return { at: history[i].gameSeconds, peak, from: buildings[i] };
  return null;
}

// ---------------------------------------------------------------- the verdict
export function diagnose(report) {
  const s = series(report);
  const collapse = collapseAt(report);
  const wipe = wipeAt(report);
  const bled = s.built > 0 && s.lost / s.built >= T.bledShare;
  const broke = s.brokeShare >= T.brokeShare;

  // The order matters: it is the *sequence* that separates the two diseases. Both matches end with an
  // empty base, but one loses the army while it still has money and the other starves first.
  let cause, because;
  if (!collapse && !broke) {
    cause = 'attrition';
    because = `the army never fell below ${Math.round(s.unitPeak * T.collapseRatio)} units, and money was available in only ${Math.round(s.brokeShare * 100)}% of the samples after the army peaked; this is a grind, not a break`;
  } else if (collapse && (!broke || collapse.at < (s.brokeAt ?? Infinity))) {
    cause = 'overrun';
    because = `the army fell from ${s.unitPeak} to under ${Math.round(collapse.floor)} at ${Math.round(collapse.at)}s, and money was still there for ${Math.round((1 - s.brokeShare) * 100)}% of the samples after the peak -- the base was overrun before the economy failed`;
  } else if (broke && bled) {
    cause = 'economic_stall';
    because = `the army peaked at ${s.unitPeak} around ${Math.round(s.unitPeakAt)}s; money was gone from ${Math.round(s.brokeAt ?? 0)}s onwards and absent for ${Math.round(s.brokeShare * 100)}% of the rest, after losing ${s.lost} of the ${s.built} things built (${Math.round((s.lost / s.built) * 100)}%) -- the army could not be replaced, and the base fell ${collapse ? `at ${Math.round(collapse.at)}s` : 'later'}`;
  } else {
    cause = 'attrition';
    because = `no single break: the army held ${s.unitPeak} and money was gone in ${Math.round(s.brokeShare * 100)}% of samples`;
  }

  return {
    build: report.match.meta?.build ?? '?',
    provider: `${report.match.providerName ?? '?'} / ${report.match.model ?? '?'}`,
    outcome: report.match.outcome ?? '?',
    seconds: Math.round(s.seconds),
    logKept: report.match.logKept, logEntries: report.match.logEntries,
    cause,
    because,
    evidence: {
      unitPeak: s.unitPeak, unitPeakAt: Math.round(s.unitPeakAt), unitEnd: s.unitEnd,
      buildingPeak: s.buildingPeak, buildingEnd: s.buildingEnd,
      enemyEnd: s.enemyEnd, enemyPeak: s.enemyPeak,
      built: s.built, lost: s.lost, kills: s.kills,
      brokeAt: s.brokeAt === null ? null : Math.round(s.brokeAt),
      brokeShare: +(s.brokeShare.toFixed(2)),
      collapseAt: collapse ? Math.round(collapse.at) : null,
      wipeAt: wipe ? Math.round(wipe.at) : null,
    },
    killRatio: s.built || s.lost ? +(s.kills / Math.max(1, s.lost)).toFixed(2) : 0,
  };
}

export const CAUSES = ['overrun', 'economic_stall', 'attrition'];

// ---------------------------------------------------------------- output
export function render(v) {
  const e = v.evidence;
  return [
    `build ${v.build} · ${v.provider} · ${v.outcome} · ${v.seconds}s`,
    `log ${v.logKept}/${v.logEntries}`,
    ``,
    `  LOST TO: ${v.cause}`,
    `  ${v.because}`,
    ``,
    `  army      peak ${e.unitPeak} at ${e.unitPeakAt}s -> ${e.unitEnd} at the end` +
      (e.collapseAt === null ? '  (never collapsed)' : `  (collapsed at ${e.collapseAt}s)`),
    `  buildings peak ${e.buildingPeak} -> ${e.buildingEnd}` +
      (e.wipeAt === null ? '' : `  (wiped at ${e.wipeAt}s)`),
    `  built ${e.built}, lost ${e.lost}, killed ${e.kills}  (kill ratio ${v.killRatio})`,
    `  money    ${e.brokeAt === null ? 'never dry' : `dry from ${e.brokeAt}s`} (counted only after the army peaked), for ${Math.round(e.brokeShare * 100)}% of the rest`,
    `  enemy    ${e.enemyPeak} peak -> ${e.enemyEnd} at the end`,
  ].join('\n');
}

// ---------------------------------------------------------------- the ledger
const row = (v, file) =>
  `| ${path.basename(file).replace(/\.json$/, '')} | ${v.build} | ${v.outcome} | **${v.cause}** | ${v.seconds}s | ` +
  `${v.evidence.unitPeak}→${v.evidence.unitEnd} | ${v.evidence.built}/${v.evidence.lost}/${v.evidence.kills} | ${v.killRatio} |`;

const HEADER = `# 败因记录

每一行是一局，由 \`node tools/postmortem.mjs --append <战报>\` 写入，判定只依据
\`match.history\` 里已经有的数字（我方单位 / 建筑、敌军单位、资金、新建 / 损失 / 击毁），
不靠读题面或猜。阈值是 \`tools/postmortem.mjs\` 顶部的具名常量，
所以对一条判定有异议，是对一个数字有异议。

**单局不能验证任何改动**（评审 §0.43）。这张表的作用是让三局同码的对比成立，
以及让"同一个死法又发生了"变成一件看得见的事。

| 战报 | 构建 | 结果 | 判定 | 时长 | 我方部队 峰→末 | 新建/损失/击毁 | 击杀比 |
| --- | --- | --- | --- | --- | --- | --- | --- |
`;

export function ledgerText() {
  return fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, 'utf8') : HEADER;
}
export function appendLedger(verdict, file) {
  const before = ledgerText();
  if (before.includes(`| ${path.basename(file).replace(/\.json$/, '')} |`))
    return { appended: false, note: 'already in the ledger' };
  fs.writeFileSync(LEDGER, (before.endsWith('\n') ? before : before + '\n') + row(verdict, file) + '\n');
  return { appended: true };
}
export function parseLedger() {
  return ledgerText()
    .split('\n')
    .filter((l) => l.startsWith('| ') && !l.includes('---') && !l.includes('战报 |'))
    .map((l) => l.split('|').map((c) => c.trim()))
    .map(([, file, build, outcome, cause, seconds]) => ({ file, build, outcome, cause: cause.replace(/\*/g, ''), seconds }));
}

// A report whose cause matches something already recorded is the interesting case, not a new row:
// the same failure twice is what a single match can actually establish.
export function repeats(report) {
  const v = diagnose(report);
  const seen = parseLedger().filter((r) => r.file !== path.basename(report.file));
  return { verdict: v, sameAs: seen.filter((r) => r.cause === v.cause) };
}

// ---------------------------------------------------------------- cli
// Only when run as a program. The tests import this file for `diagnose` and friends, and argv belongs
// to the test runner there -- running the cli block on import made it print usage and exit.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(n);
  const files = argv.filter((a) => !a.startsWith('--'));
  const mode = flag('--list') ? 'list' : flag('--check') ? 'check' : flag('--append') ? 'append' : 'show';

  if (mode === 'list') {
    const rows = parseLedger();
    if (!rows.length) console.log('nothing recorded yet');
    else for (const r of rows) console.log(`${r.file.padEnd(38)} ${r.build.padEnd(10)} ${r.outcome.padEnd(8)} ${r.cause}`);
  } else if (!files.length) {
    console.error('usage: postmortem.mjs [--append|--check|--list] <report.json> [...]');
    process.exit(2);
  } else {
    for (const f of files) {
      const report = readReport(f);
      const v = diagnose(report);
      console.log(render(v));
      if (mode === 'check') {
        const { sameAs } = repeats(report);
        if (sameAs.length) {
          console.log(`\n  !! the same loss (${v.cause}) is already in the ledger:`);
          for (const s of sameAs) console.log(`     ${s.file} (${s.build})`);
          console.log('     A repeat is the one thing a single match CAN show. Do not start a new fix on top of it.');
        } else console.log('\n  new failure mode, or not comparable with what is recorded yet');
      }
      if (mode === 'append') {
        const r = appendLedger(v, f);
        console.log(r.appended ? `\n  recorded in ${path.relative(process.cwd(), LEDGER)}` : `\n  not recorded: ${r.note}`);
      }
      console.log('');
    }
  }
}
