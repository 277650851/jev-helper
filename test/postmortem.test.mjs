import test from 'node:test';
import assert from 'node:assert/strict';
import { series, collapseAt, wipeAt, diagnose, parseLedger, T, CAUSES } from '../tools/postmortem.mjs';

// A match report already carries the series a post-mortem needs: ownUnits, ownBuildings, enemyUnits,
// credits and the cumulative built/lost/killed counters. Three matches in a row were diagnosed by hand
// and none of it was recorded, so the next session started from zero. This covers the classification
// over that series -- the judgement is the thresholds in T, so a disagreement is about a number.

const sample = (rows) => ({ history: rows.map(([s, u, b, c, built, lost, killed]) => ({ gameSeconds: s, ownUnits: u, ownBuildings: b, credits: c, ownBuilt: built, ownLost: lost, enemyDestroyed: killed })) });
const at = (a, b, n) => a + Math.round((b - a) * (n / 100));

test('a loss is named from the order of the two breaks, not from the last thing that happened', () => {
  // Army falls while the wallet is still healthy: overrun.
  const overrun = sample([
    [0, 5, 8, 4000, 10, 0, 0], [300, 18, 16, 3000, 30, 2, 4], [600, 16, 18, 2500, 40, 6, 9],
    [900, 6, 18, 2200, 45, 16, 12], [1200, 3, 17, 2000, 46, 24, 13], [1500, 1, 12, 1800, 46, 30, 14],
    [1800, 0, 4, 1500, 46, 34, 14], [2000, 0, 1, 900, 46, 38, 14],
  ]);
  assert.equal(diagnose({ match: {}, ...overrun }).cause, 'overrun');
});

test('the wallet going first, with the army still standing, is an economic stall', () => {
  const stall = sample([
    [0, 5, 8, 4000, 10, 0, 0], [300, 18, 16, 3000, 30, 2, 4], [600, 16, 18, 1200, 40, 6, 9],
    [900, 12, 20, 0, 45, 16, 12], [1200, 9, 21, 0, 48, 20, 12], [1500, 6, 20, 0, 49, 24, 12],
    [1800, 3, 18, 0, 50, 28, 12], [2000, 1, 9, 0, 50, 32, 12],
  ]);
  const v = diagnose({ match: {}, ...stall });
  assert.equal(v.cause, 'economic_stall');
  assert.match(v.because, /army peaked at/);
});

test('spending the opening bank is not read as a stall', () => {
  // The first version of this tool did exactly that and called all three real matches an economic
  // stall "from 237 s" -- which is just the opening spend, before there is an army to lose.
  const opening = sample([
    [0, 1, 0, 10000, 0, 0, 0], [100, 4, 5, 200, 8, 0, 0], [200, 8, 8, 150, 16, 0, 0],
    [400, 14, 12, 900, 26, 1, 2], [700, 18, 15, 2200, 34, 3, 6], [1000, 19, 17, 3000, 40, 5, 11],
    [1300, 18, 18, 2600, 44, 9, 18], [1600, 12, 18, 1800, 47, 18, 24], [1900, 6, 16, 1700, 48, 26, 27],
    [2100, 4, 12, 1600, 48, 30, 28], [2300, 3, 8, 1500, 48, 32, 28], [2500, 1, 4, 1500, 48, 34, 28],
  ]);
  const s = series(opening);
  assert.ok(s.brokeAt === null, `the wallet never ran dry after the peak, so there is no stall (got ${s.brokeAt}s)`);
  assert.ok(s.unitPeakAt >= 0);
  assert.equal(diagnose({ match: {}, ...opening }).cause, 'overrun', 'a healthy wallet after the peak is not a stall');
});

test('the peak is a real peak: a dip that recovers does not count as a collapse', () => {
  const dip = sample([[0, 20, 10, 5000, 10, 0, 0], [100, 4, 10, 4000, 12, 16, 2], [200, 18, 10, 4000, 14, 18, 6], [300, 20, 10, 4000, 16, 20, 8]]);
  assert.equal(collapseAt(dip), null, 'the army came back, so it never collapsed');
  const gone = sample([[0, 20, 10, 5000, 10, 0, 0], [100, 4, 10, 4000, 12, 16, 2], [200, 3, 10, 4000, 14, 18, 6], [300, 2, 10, 4000, 16, 20, 8]]);
  assert.ok(collapseAt(gone), 'an army that stays down has collapsed');
});

test('a building wipe is only called in the last stretch of the match', () => {
  // Buildings lost at the half-way mark and then REBUILT: that is attrition, not the wipe. The wipe
  // is a fall that is still there at the end, which is the only thing a defeat is made of.
  const mid = sample([
    [0, 12, 22, 1200, 5, 0, 0], [100, 12, 6, 1200, 6, 16, 1], [200, 11, 8, 1200, 7, 17, 1],
    [300, 10, 14, 1200, 9, 18, 1], [400, 9, 20, 1200, 11, 19, 1], [500, 8, 21, 1200, 12, 20, 1],
  ]);
  assert.equal(wipeAt(mid), null, 'buildings dropped in the first half, but the match was not lost to it');
  // The same fall, in the closing stretch: that is the wipe.
  const end = sample([
    [0, 12, 22, 1200, 5, 0, 0], [100, 12, 22, 1200, 6, 0, 1], [200, 12, 22, 1200, 7, 0, 2],
    [300, 12, 22, 1200, 8, 0, 3], [400, 3, 4, 1200, 8, 20, 4], [500, 1, 1, 1200, 8, 24, 4],
  ]);
  assert.ok(wipeAt(end), 'a collapse in the closing stretch is the wipe');
});

test('every verdict names a known cause and carries the numbers behind it', () => {
  for (const rows of [
    [[0, 5, 8, 4000, 10, 0, 0], [300, 18, 16, 3000, 30, 2, 4], [900, 6, 18, 2200, 45, 16, 12], [1500, 1, 12, 1800, 46, 30, 14], [2000, 0, 1, 900, 46, 38, 14]],
    [[0, 5, 8, 4000, 10, 0, 0], [600, 16, 18, 1200, 40, 6, 9], [1200, 9, 21, 0, 48, 20, 12], [2000, 1, 9, 0, 50, 32, 12]],
  ]) {
    const v = diagnose({ match: { meta: { build: 'x' } }, ...sample(rows) });
    assert.ok(CAUSES.includes(v.cause), `${v.cause} is a known cause`);
    assert.ok(v.because.length > 40, 'the verdict explains itself in words, not just a label');
    for (const k of ['unitPeak', 'unitEnd', 'built', 'lost', 'kills', 'brokeShare'])
      assert.ok(v.evidence[k] !== undefined, `evidence.${k} is carried so the verdict can be argued with`);
  }
});

test('the thresholds are the judgement, so they are named and reachable', () => {
  // If a verdict is going to be disagreed with, the disagreement has to be about a number.
  for (const k of ['collapseRatio', 'collapseSamples', 'brokeCredits', 'brokeShare', 'bledShare', 'wipeRatio', 'wipeTailShare'])
    assert.equal(typeof T[k], 'number', `T.${k} is a number`);
  assert.ok(T.collapseRatio > 0 && T.collapseRatio < 1);
  assert.ok(T.brokeShare > 0 && T.brokeShare < 1);
});

test('the ledger is readable and every recorded row carries a cause', () => {
  const rows = parseLedger();
  assert.ok(Array.isArray(rows));
  for (const r of rows) {
    assert.ok(CAUSES.includes(r.cause), `recorded cause "${r.cause}" is one the tool can produce`);
    assert.ok(r.file.startsWith('jev-report-'), `a ledger row names the report it came from (got "${r.file}")`);
    assert.ok(r.build && r.build !== '?', 'and the build it was judged on');
  }
});
