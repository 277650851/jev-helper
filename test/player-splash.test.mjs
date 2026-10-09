import assert from 'node:assert/strict';
import { splashOf, splashReach, weaponEffectiveness, counterValue, canEngageTarget, versesArePercent } from '../src/player/werhd-jev-strategy.mjs';

// The damage model was flat: every weapon did its damage to exactly one unit. That understates every blast
// weapon, and it is why an anti-infantry specialist used to look worse than a tank whose single shot simply
// does more damage -- a rocket landing among six conscripts is worth more than one conscript's worth of
// damage, and nothing in the model said so. `weaponEffectiveness` now scales a shot by how many of the
// visible infantry the blast would also catch.

const api = { ObjectType: { Infantry: 3, Vehicle: 7, Aircraft: 1, Building: 2 }, ZoneType: { Ground: 0, Air: 1 }, ArmorType: { 0: 'None', 5: 'Heavy' } };
const V = (row) => row;
const blast = { name: 'BLAST', weapon: { damage: 40, rof: 40, range: 6, ag: true, aa: false, cellSpread: 1.5, versus: V([100, 80, 70, 50, 25, 25, 75, 50, 25, 100, 100]) } };
const plain = { name: 'PLAIN', weapon: { damage: 40, rof: 40, range: 6, ag: true, aa: false, versus: V([100, 80, 70, 50, 25, 25, 75, 50, 25, 100, 100]) } };
const catalog = { BLAST: blast, PLAIN: plain };
const foot = (n, spacing) => Array.from({ length: n }, (_, i) => ({ name: 'PLAIN', type: 3, armor: 0, tile: { rx: 40 + i * spacing, ry: 40 } }));

// 1. The radius is read from the runtime weapon object under any of the names the rules use, and zero means
//    "no blast" -- which is what every non-blast weapon returns rather than a guess.
assert.equal(splashOf(blast.weapon), 1.5, 'cellSpread is found');
assert.equal(splashOf(plain.weapon), 0, 'a weapon without a radius has none');
assert.equal(splashOf({ area: 2 }), 2, 'the other rule spellings are probed too');
assert.equal(splashOf({}), 0);

// 2. The multiplier counts the infantry a blast would catch, and only infantry.
{
  assert.equal(splashReach(blast.weapon, foot(6, 1)[0], foot(6, 1)), 2, 'a tight line is caught');
  assert.equal(splashReach(blast.weapon, foot(6, 3)[0], foot(6, 3)), 1, 'a spread line is not');
  assert.equal(splashReach(plain.weapon, foot(6, 1)[0], foot(6, 1)), 1, 'no radius, no bonus');
  const vehicles = [{ type: 7, tile: { rx: 40, ry: 40 } }, { type: 7, tile: { rx: 41, ry: 40 } }];
  assert.equal(splashReach(blast.weapon, vehicles[0], vehicles), 1, 'vehicles are not counted as splash targets');
  const mixed = [foot(1, 1)[0], { type: 7, tile: { rx: 41, ry: 40 } }, { type: 3, tile: { rx: 40.5, ry: 40 } }];
  assert.equal(splashReach(blast.weapon, mixed[0], mixed), 2, 'only the infantry beside it count');
}

// 3. The aimed-at unit is never counted twice, including when the caller passes a rebuilt copy of it. The
//    counter profile maps each summary to a new object before scoring, and counting that copy again would
//    credit the blast with hitting the very unit it was aimed at a second time.
{
  const one = foot(1, 1);
  assert.equal(splashReach(blast.weapon, { ...one[0] }, one), 1, 'an equal-but-distinct copy of the target is not a second target');
  assert.equal(splashReach(blast.weapon, one[0], one), 1, 'and neither is the target itself');
  const two = foot(2, 1);
  assert.equal(splashReach(blast.weapon, { ...two[0] }, two), 2, 'but the other unit beside it still counts');
}

// 4. The effect reaches the score: the same weapon with a blast out-scores itself without one against a
//    clustered wave, and the two are identical against a spread wave. That is the whole claim. It is
//    applied in `counterValue`, which holds the whole target list -- the bonus counts neighbours, so a
//    path that steps one target at a time can never see it.
{
  const tight = foot(6, 1);
  const spread = foot(6, 3);
  assert.ok(counterValue(blast, tight, catalog, api) > counterValue(plain, tight, catalog, api), 'clustered infantry: the blast wins');
  assert.equal(counterValue(blast, spread, catalog, api), counterValue(plain, spread, catalog, api), 'spread infantry: the blast is worth nothing extra');
  // The per-weapon score stays per-target: adding a list-dependent factor there would make it depend on
  // which slice of the enemy the caller happened to pass.
  assert.equal(weaponEffectiveness(blast.weapon, tight, catalog, api), weaponEffectiveness(plain.weapon, tight, catalog, api), 'the per-target score is unchanged by the blast');
}

// 5. The multiplier is bounded: one very tight cluster cannot dominate every score in a question.
{
  const clump = Array.from({ length: 30 }, (_, i) => ({ name: 'PLAIN', type: 3, armor: 0, tile: { rx: 40, ry: 40 } }));
  assert.ok(splashReach(blast.weapon, clump[0], clump) <= 6, 'the bonus is capped');
}
// 6. The rule shape the LIVE game actually carries. The API declares `versus` as an object keyed by armour
//    index, and the catalog adds `verses` as an array copy while keeping `versus` from the spread. Reading
//    `versus` first and requiring an array finds the object, fails, and reports "no table" -- which turns
//    every refusal below into an acceptance, silently. This is the shape a real match hands over, so it is
//    the shape the tests have to use.
{
  const live = (versus) => ({ damage: 100, rof: 30, range: 5, ag: true, aa: false, versus, verses: Object.assign([], versus) });
  const percentRow = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [i, i === 0 ? 100 : 30]));
  // A row whose entries are all 0/1 is genuinely ambiguous -- it reads as proportions ("0x and 1x"), which
  // is a legal weapon. The flag semantics only exist in the percentage form, where the row shows its scale
  // in the entries that are not flags.
  const flagRow = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [i, i === 0 ? 0 : i === 5 ? 1 : 80]));
  const flagCatalog = { T: { armor: 5, weapon: live(flagRow) }, F: { armor: 0, weapon: live(percentRow) } };
  const armoured = { name: 'T', type: 7, armor: 5 };
  assert.ok(versesArePercent(live(percentRow)), 'a row of 100s is recognised as percentages even as an object');
  assert.equal(canEngageTarget(flagCatalog.T, armoured, flagCatalog, api), false, 'and a 1% entry is a refusal, not a tiny multiplier');
  assert.equal(canEngageTarget(flagCatalog.F, { name: 'F', type: 3, armor: 0 }, flagCatalog, api), true, 'while 100% engages');
  // The same numbers as an array-only weapon (what the fixtures used) must behave identically, so the fix
  // is in reading the row rather than in changing the semantics.
  const arrayOnly = { ...flagCatalog.T, weapon: { ...live(flagRow), versus: undefined } };
  assert.equal(canEngageTarget(arrayOnly, armoured, flagCatalog, api), false, 'the array shape agrees');
}
console.log('Splash: blast weapons are scored by how many visible infantry they catch, bounded and never double-counting the target');
console.log('Armour rows: read from whichever of the two shapes the rule carries (object `versus` or array `verses`)');
