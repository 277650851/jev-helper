import test from 'node:test';
import assert from 'node:assert/strict';
import { defenseRank, firstOfTypeBonus } from '../src/player/werhd-jev-strategy.mjs';

// The tower list is ordered by bang-per-buck, which is the right question when topping up and the wrong one when
// a type is missing entirely: it always answers "one more of the cheapest gun". jev-report-20261015-110417
// placed 11 pillboxes, 2 Patriots and 1 Tesla coil and never once the Grand Cannon, while the screenshots of the
// same match show the whole defence menu unlocked. A type the base owns NONE of now outranks a type it already
// has, and the bonus disappears as soon as one stands -- this reorders the list, it caps and bans nothing.
const catalog = { GAPILL: { cost: 500 }, GTGCAN: { cost: 2000 } };
// Raw bang-per-buck favours the pillbox by a wide margin; the Grand Cannon is the type we have none of.
const pill = { name: 'GAPILL', value: 50 };
const cannon = { name: 'GTGCAN', value: 60 };

test('a type we own none of outranks one we already have', () => {
  assert.equal(firstOfTypeBonus([{ name: 'GAPILL' }], 'GTGCAN'), 2);
  assert.equal(firstOfTypeBonus([{ name: 'GAPILL' }], 'GAPILL'), 1);
  assert.deepEqual([pill, cannon].sort(defenseRank([{ name: 'GAPILL' }], catalog)).map((i) => i.name), ['GTGCAN', 'GAPILL'],
    'the Grand Cannon is offered ahead of a fourth pillbox');
});

test('once one stands, bang-per-buck decides again', () => {
  const both = [{ name: 'GAPILL' }, { name: 'GTGCAN' }];
  assert.deepEqual([pill, cannon].sort(defenseRank(both, catalog)).map((i) => i.name), ['GAPILL', 'GTGCAN'],
    'nothing is capped or banned; the cheap gun is back on top because the diversity is already there');
});
