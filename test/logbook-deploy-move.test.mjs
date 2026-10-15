import test from 'node:test';
import assert from 'node:assert/strict';
import { eventEntry } from '../src/logbook.mjs';

// The §0.48 fix drives a construction vehicle to a tile its building fits in when the game refuses to unpack it
// where it stands. That move happens inside the deploy executor, so the destination and the refused tile are the
// only evidence a report can carry. jev-report-20261015-110417 has 46 `deploy_no_space` entries and no way to
// tell a working fix from a loop that keeps moving the same vehicle; both fields were dropped right here.
test('a refused deployment records where it stood and where it was sent', () => {
  const e = eventEntry({ kind: 'action', tick: 100, question: 'construction', choice: 'deploy_base', accepted: false,
    reason: 'deploy_no_space', action: { type: 'deploy', ids: [30] }, movedTo: { x: 31, y: 44 }, refusedAt: [[30, '22,23']] }, 1700000000000);
  assert.deepEqual(e.movedTo, [31, 44], 'the tile the vehicle was driven to');
  assert.deepEqual(e.refusedAt, [[30, '22,23']], 'and the spot the game refused');
  assert.deepEqual(e.ids, [30], 'the ids record stays as it was');
  assert.equal(e.accepted, false);
  // A vehicle the game will not unpack at all has no destination to report.
  const refused = eventEntry({ kind: 'action', tick: 101, question: 'construction', choice: 'deploy_base', accepted: false,
    reason: 'deploy_refused', action: { type: 'deploy', ids: [30] } }, 1700000000000);
  assert.equal(refused.movedTo, undefined);
  assert.equal(refused.refusedAt, undefined);
});
