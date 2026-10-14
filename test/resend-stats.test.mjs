import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyResendStats, recordResend, summarizeResends, formatResendReport, MAX_RESEND_ROWS } from '../src/resend-stats.mjs';

// The game API has no command receipts, so "this order was sent 89 times and nothing happened" is the only
// evidence that the game refused it. These tests pin the two things that make the number trustworthy: the
// match totals are maintained on write (not derived from the bounded display list), and an absent record is
// reported as absent rather than as a zero.
const row = (n, over = {}) => ({ key: `capture_${n}`, kind: 'capture', resends: n, ticks: 100, outcome: 'uncapturable', tick: 5000, ...over });

test('one finished task records both the running totals and a row', () => {
  const s = emptyResendStats();
  recordResend(s, row(3));
  const sum = summarizeResends(s);
  assert.equal(s.tasks, 1);
  assert.equal(s.resends, 3);
  assert.equal(sum.worst.length, 1);
  assert.equal(sum.worst[0].key, 'capture_3');
  assert.equal(sum.empty, false);
});

test('the totals cover the whole match even after the display list is capped', () => {
  // The same trap as the reward window: a bound that quietly feeds the summary makes it describe only the
  // tail. Here the list is bounded but `tasks`/`resends`/`byKind` are not, so the aggregates stay exact.
  const s = emptyResendStats();
  const n = MAX_RESEND_ROWS + 50;
  for (let i = 0; i < n; i++) recordResend(s, row(2, { key: `capture_${i}` }));
  const sum = summarizeResends(s);
  assert.equal(sum.tasks, n, 'every task is counted');
  assert.equal(sum.resends, 2 * n, 'every resend is counted');
  assert.equal(sum.kept, MAX_RESEND_ROWS, 'the list is bounded');
  assert.equal(sum.dropped, 50);
  assert.equal(sum.byKind[0].tasks, n, 'the per-kind bucket is not derived from the bounded list');
  assert.equal(sum.byKind[0].resends, 2 * n);
});

test('the worst offenders are the ones worth looking at, and only 24 are listed', () => {
  const s = emptyResendStats();
  for (let i = 0; i < 40; i++) recordResend(s, row(i, { key: `target_${i}` }));
  const sum = summarizeResends(s);
  assert.equal(sum.worst.length, 24);
  assert.equal(sum.worst[0].resends, 39, 'the most repeated order comes first');
  assert.equal(sum.worst.at(-1).resends, 16);
});

test('kind and outcome are bounded, so one bad field cannot fill the report', () => {
  const s = emptyResendStats();
  recordResend(s, row(1, { kind: 'x'.repeat(80), outcome: 'y'.repeat(80), key: 'k'.repeat(200) }));
  const w = summarizeResends(s).worst[0];
  assert.equal(w.kind.length, 24);
  assert.equal(w.outcome.length, 24);
  assert.equal(w.key.length, 64);
});

test('a negative or missing resend count cannot inflate or corrupt the total', () => {
  const s = emptyResendStats();
  recordResend(s, row(-5, { key: 'a' }));
  recordResend(s, { key: 'b', kind: 'capture', outcome: 'done' });
  assert.equal(s.resends, 0);
  assert.equal(s.tasks, 2);
});

test('an absent record is reported as absent, not as "nothing was repeated"', () => {
  // A report written before this record existed has no `kind:"resends"` entry at all. Printing "0 次" for
  // that is the same mistake as reading a truncated log as "it did not happen" (§0.47).
  const text = formatResendReport(summarizeResends(undefined));
  assert.match(text, /没有记录|没有重复/);
  assert.match(text, /先确认/);

  const s = emptyResendStats();
  recordResend(s, row(89, { key: 'capture_1489' }));
  const text2 = formatResendReport(summarizeResends(s), 'jev-report-x.json');
  assert.match(text2, /89 次/);
  assert.match(text2, /capture_1489/);
  assert.match(text2, /uncapturable/);
  assert.match(text2, /没有回执/);
});
