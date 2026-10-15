import test from 'node:test';
import assert from 'node:assert/strict';
import { isSuperWeapon, superWeaponChoices } from '../src/player/werhd-jev-strategy.mjs';

// The authoritative rules file (`docs/rules(规则文件).ini`) is the ground truth for this classification: the four
// superweapon sections are `BuildCat=Combat` + `TechLevel=10` (GAWEAT 5000/NAIRON 2500/NAMISL 5000/GACSPH 2500,
// all `Power=-200`), the defence towers are `BuildCat=Defense`, and the Grand Cannon is ALSO `BuildCat=Combat`
// but `TechLevel=7` -- a defence. So TechLevel separates them, not the category.
//
// `BuildCat=Combat` is exactly that pair of kinds, which is why the construction candidates -- filtered to keep
// the defence towers out, they have their own group -- dropped the superweapons with them.
// jev-report-20261015-110417 never offered one of the four in 1198 decisions, while the screenshots of the same
// match show the whole menu unlocked.
const catalog = {
  GACSPH: { cost: 2500, power: -200, buildCategory: 'Combat', techLevel: 10, label: 'Chrono Sphere' },
  GAWEAT: { cost: 5000, power: -200, buildCategory: 'Combat', techLevel: 10, label: 'Weather Controller' },
  GTGCAN: { isBaseDefense: true, cost: 2000, power: -200, buildCategory: 'Combat', techLevel: 7, label: 'Grand Cannon' },
  GAPILL: { isBaseDefense: true, cost: 500, buildCategory: 'Defense', techLevel: 1, label: 'Pillbox' },
  GATECH: { cost: 2000, power: -100, buildCategory: 'Structure', techLevel: 8, label: 'Battle Lab' },
};
const all = ['GACSPH', 'GAWEAT', 'GTGCAN', 'GAPILL', 'GATECH'].map((name) => ({ name }));
const ask = (o = {}) => superWeaponChoices({ available: all, catalog, credits: 99999, powerMargin: 400, ready: true, ...o }).map((i) => i.name);

test('the classification is the TechLevel, not the combat category', () => {
  assert.equal(isSuperWeapon(catalog.GACSPH), true);
  assert.equal(isSuperWeapon(catalog.GAWEAT), true);
  assert.equal(isSuperWeapon(catalog.GTGCAN), false, 'the Grand Cannon shares BuildCat=Combat and is a defence');
  assert.equal(isSuperWeapon(catalog.GAPILL), false, 'a tower is BuildCat=Defense');
  assert.equal(isSuperWeapon(catalog.GATECH), false, 'a structure is not Combat');
});

test('a settled, unpressured base with the price and the power gets both, cheapest first', () => {
  assert.deepEqual(ask(), ['GACSPH', 'GAWEAT'], 'and never the towers or the lab');
});

test('every premise is required', () => {
  assert.deepEqual(ask({ ready: false }), [], 'the core is not settled yet');
  assert.deepEqual(ask({ underPressure: true }), [], 'there is an attack to answer first');
  assert.deepEqual(ask({ queued: true }), [], 'the structure queue is busy');
  assert.deepEqual(ask({ owned: new Set(['GACSPH']) }), ['GAWEAT'], 'never twice');
  assert.deepEqual(ask({ credits: 3000 }), ['GACSPH'], 'the whole price, not a down payment');
  assert.deepEqual(ask({ powerMargin: 100 }), [], 'the 200 power has to be spare already');
});
