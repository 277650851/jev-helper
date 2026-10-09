import assert from 'node:assert/strict';
import { canAnswerVisible, counterValue } from '../src/player/werhd-jev-strategy.mjs';

// `canAnswerVisible` decides whether a tower may be offered at all, and it is used by BOTH defence layers
// (the special layer adds strongpoints, the strategy layer adds counter-towers). It was introduced when a
// ground-only pillbox was being offered as the answer to an air raid, and its subtle part -- a rule with no
// weapon must NOT be filtered -- was found only because an existing fixture used a weaponless stub and the
// suite went red. That is a fragile way to have learned it, so the matrix is pinned here.

const api = { ObjectType: { Infantry: 3, Vehicle: 7, Aircraft: 1, Building: 2 }, ZoneType: { Ground: 0, Air: 1 } };
const row = (v) => Object.fromEntries(Array.from({ length: 11 }, (_, i) => [i, v]));
const weapon = (extra = {}) => ({ damage: 50, rof: 26, range: 5.5, ag: true, aa: false, versus: row(100), ...extra });

const groundTower = { cost: 500, armor: 'steel', isBaseDefense: true, weapon: weapon() };
const aaTower = { cost: 1000, armor: 'steel', isBaseDefense: true, weapon: weapon({ ag: false, aa: true }) };
const catalog = { groundTower, aaTower };

const aircraft = [{ id: 1, name: 'ZEP', kind: 'ZEP', type: 1, zone: 1, armor: 'light', tile: { rx: 40, ry: 40 } }];
const tank = [{ id: 2, name: 'HTNK', kind: 'HTNK', type: 7, zone: 0, armor: 'heavy', tile: { rx: 40, ry: 40 } }];

// 1. Nobody visible: the question cannot be answered from the enemy, so the answer is yes and the caller
//    falls back to its own scoring. Saying no here would empty the defence question in peacetime.
assert.equal(canAnswerVisible(groundTower, [], catalog, api), true);
assert.equal(canAnswerVisible(groundTower, undefined, catalog, api), true);

// 2. The case that motivated the helper: a ground-only gun cannot answer aircraft.
{
  const c = { ...catalog, ZEP: { armor: 'light', aircraft: true } };
  assert.equal(counterValue(groundTower, aircraft, c, api), 0, 'the score is zero against air');
  assert.equal(canAnswerVisible(groundTower, aircraft, c, api), false, 'so it is not offered');
  assert.equal(canAnswerVisible(aaTower, aircraft, c, api), true, 'while the anti-air tower is');
}

// 3. And the reverse, so the filter is about engagement rather than about anti-air specifically.
{
  const c = { ...catalog, HTNK: { armor: 'heavy' } };
  assert.equal(canAnswerVisible(groundTower, tank, c, api), true, 'a ground gun answers ground armour');
  assert.equal(canAnswerVisible(aaTower, tank, c, api), false, 'an anti-air-only site does not answer it');
}

// 4. THE STUB GUARD: no weapon information means no judgement. A rule the API did not describe -- or a test
//    fixture standing in for one -- must not be filtered as a decoy, because "I cannot tell" is not "it
//    cannot shoot". This is the rule that was discovered by breaking an existing test.
{
  const c = { ...catalog, STUB: { isBaseDefense: true } };
  assert.equal(canAnswerVisible(c.STUB, aircraft, c, api), true, 'no weapon described: not filtered');
  const zeroDamage = { ...groundTower, weapon: weapon({ damage: 0 }) };
  assert.equal(canAnswerVisible(zeroDamage, aircraft, c, api), true, 'a zero-damage weapon is also no information');
  // A real weapon that simply cannot engage IS filtered, which is the contrast that matters.
  assert.equal(canAnswerVisible(groundTower, aircraft, { ...catalog, ZEP: { aircraft: true } }, api), false);
}
console.log('canAnswerVisible: only a described weapon that cannot engage is filtered; absence of a weapon is not a verdict');
