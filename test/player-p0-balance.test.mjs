// P0 coverage, ported alongside globalPowerBalance and deployRecommendation.
//
// The two functions exist because the choice rules were the wrong layer to judge a deployment or a
// whole-army comparison: P0-1 (deployRecommendation) compares the two forms of one unit, P0-2
// (globalPowerBalance) compares the two armies. Neither has a prior assertion here, so the cases
// below are the ones that actually broke during the port -- see the zone-aware reach note in
// deployRecommendation, which is a bug this file's last two tests pin down.
import test from 'node:test';
import assert from 'node:assert/strict';
import { globalPowerBalance } from '../src/player/werhd-jev-commander.mjs';
import { deployRecommendation } from '../src/player/werhd-jev-strategy.mjs';

const api = {
  ObjectType: { Infantry: 1, Vehicle: 2, Building: 3, Aircraft: 4 },
  ArmorType: { None: 0, Light: 3, Heavy: 5, Concrete: 8 },
  ZoneType: { Air: 1, Land: 0 },
};
// `verses` is the per-armour multiplier weaponEffectiveness reads; without it every weapon scores the
// same against everything and the comparisons below would be meaningless.
const weapon = (damage, rof = 30, range = 5, aa = false) =>
  ({ damage, rof, range, aa, ag: true, verses: [1, 1, 1, 1, 1, 1, 1, 1, 1] });

const catalog = {
  E1: { weapon: weapon(15), armor: 'none' },
  MTNK: { weapon: weapon(90, 20, 5), armor: 'heavy' },
  GAPOWR: { weapon: { ...weapon(50, 40, 7), aa: true }, armor: 'concrete' },
  HTNK: { weapon: weapon(110, 25, 6), armor: 'heavy' },
  ESPA: { weapon: { ...weapon(30, 45, 8), aa: true }, armor: 'light' },
  AMCV: { deploysInto: 'MCV', deployer: true, weapon: weapon(40, 60, 4) },
  MCV: { weapon: weapon(40, 60, 4) },
};
const unit = (name, [rx, ry], extra = {}) =>
  ({ name, tile: { rx, ry }, primaryWeapon: catalog[name].weapon, ...extra });
const plane = (rx, ry) => ({ ...unit('ESPA', [rx, ry]), zone: api.ZoneType.Air });

test('P0-2: our damage against theirs reads as a ratio, and out-shooting shows above 1', () => {
  const strong = globalPowerBalance(api, catalog,
    [unit('MTNK', [0, 0]), unit('MTNK', [1, 0]), unit('MTNK', [2, 0])],
    [unit('MTNK', [9, 0]), unit('MTNK', [9, 1])]);
  assert.ok(strong.ratio > 1, 'three tanks against two should read as an advantage');
  assert.ok(strong.theirGround < strong.ourGround);
});

test('P0-2: infantry facing tanks reads as the losing side', () => {
  const weak = globalPowerBalance(api, catalog,
    [unit('E1', [0, 0]), unit('E1', [1, 0])],
    [unit('MTNK', [9, 0]), unit('MTNK', [9, 1])]);
  assert.ok(weak.ratio < 1, 'infantry cannot out-shoot tanks at equal numbers');
});

test('P0-2: an unanswered air threat shows as a positive gap, and fielding AA closes it', () => {
  const exposed = globalPowerBalance(api, catalog,
    [unit('MTNK', [0, 0]), unit('MTNK', [1, 0])], [unit('MTNK', [9, 0]), plane(8, 0)]);
  assert.equal(exposed.ourAntiAir, 0, 'no anti-air weapon means no anti-air');
  assert.ok(exposed.airGap > 0, 'their aircraft against our zero AA is a gap');

  const covered = globalPowerBalance(api, catalog,
    [unit('MTNK', [0, 0]), unit('GAPOWR', [1, 0])], [unit('MTNK', [9, 0]), plane(8, 0)]);
  assert.ok(covered.ourAntiAir > 0, 'a site that can shoot at aircraft counts');
  assert.ok(covered.airGap < exposed.airGap, 'adding AA must shrink the gap');
});

test('P0-2: an empty enemy yields a finite ratio, not NaN or Infinity', () => {
  const alone = globalPowerBalance(api, catalog, [unit('MTNK', [0, 0])], []);
  assert.ok(Number.isFinite(alone.ratio), 'ratio must stay finite with nothing in sight');
  assert.equal(alone.theirGround, 0);
});

test('P0-2: an uncatalogued unit is skipped instead of taking the whole brief down', () => {
  const mixed = globalPowerBalance(api, catalog,
    [unit('MTNK', [0, 0]), { name: 'NOT_IN_CATALOG', tile: { rx: 2, ry: 0 } }],
    [unit('MTNK', [9, 0])]);
  assert.ok(Number.isFinite(mixed.ratio));
  assert.ok(mixed.ratio > 0, 'the known unit still contributes');
});

test('P0-1: a unit that cannot deploy, or has no target, offers no recommendation', () => {
  assert.equal(deployRecommendation(api, catalog, unit('MTNK', [0, 0]), [unit('MTNK', [5, 5])]), null,
    'a tank cannot morph');
  assert.equal(deployRecommendation(api, catalog, unit('AMCV', [0, 0]), []), null,
    'nothing in sight means nothing to decide');
});

test('P0-1: a mobile form that out-damages the deployed one is not told to unfold', () => {
  const local = { MOBILE: { weapon: weapon(100, 15, 6) }, STATIC: { weapon: weapon(5, 60, 4) },
    BOTH: { deploysInto: 'STATIC', deployer: true, weapon: weapon(100, 15, 6) } };
  const u = { name: 'BOTH', tile: { rx: 10, ry: 10 }, isDeployed: false, primaryWeapon: weapon(100, 15, 6) };
  const rec = deployRecommendation(api, local, u, [unit('E1', [12, 10])]);
  assert.ok(rec, 'a recommendation is still returned');
  assert.equal(rec.deploy, false);
  assert.ok(rec.mobilePower > rec.deployedPower);
});

test('P0-1: an anti-air-only deployed form still recommends unfolding against aircraft', () => {
  // Regression: reach used to be read from one range number for both zones, so a form that could
  // only shoot at aircraft looked unable to answer anything and the option was dropped -- exactly
  // the case the rule exists for.
  const local = { AMCV2: { deploysInto: 'AAEMPL', deployer: true },
    AAEMPL: { weapon: { ...weapon(120, 30, 9), aa: true, ag: false } } };
  const u = { name: 'AMCV2', tile: { rx: 0, ry: 0 }, isDeployed: false };
  const rec = deployRecommendation(api, local, u, [plane(8, 0)]);
  assert.ok(rec, 'must not return null for the one case it exists to handle');
  assert.equal(rec.deploy, true);
  assert.equal(rec.mobilePower, 0, 'the mobile form has no weapon at all');
  assert.ok(rec.deployedPower > 0);
});