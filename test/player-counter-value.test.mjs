import assert from 'node:assert/strict';
import { counterValue, canEngageTarget, effectiveness, versesArePercent } from '../src/player/werhd-jev-strategy.mjs';

// The engine chooses which unit to OFFER from a score. That score used to be `effectiveness`, which averages
// a damage figure over the target set -- so it answers "how good is this on average", not "how much of the
// enemy in front of me can this actually touch". Against a mixed force every ground unit lost score to the
// air target it could not shoot, and the ordering came out the same for a tank wave and a conscript wave,
// which is the opposite of what choosing a counter is for.
//
// `counterValue` sums over the visible enemy and counts nothing for a target the option cannot engage. It
// also treats a `Verses` value of 0/1/2 (percentage form) as a refusal rather than as a tiny multiplier.

const api = { ObjectType: { Infantry: 3, Vehicle: 7, Aircraft: 1, Building: 2 }, ZoneType: { Ground: 0, Air: 1 } };
const armor = (w, row) => ({ damage: w.damage, rof: w.rof, range: w.range, ag: w.ag, aa: w.aa, versus: row });
// Full damage to everything, expressed in the rules' percentage form.
const pct = (n) => Array.from({ length: 11 }, () => n);
const tank = { category: 'AFV', cost: 750, armor: 'heavy', weapon: armor({ damage: 65, rof: 60, range: 5, ag: true, aa: false }, pct(100)) };
const aa = { category: 'AFV', cost: 900, armor: 'heavy', weapon: armor({ damage: 60, rof: 30, range: 6, ag: false, aa: true }, pct(100)) };
const rifle = { cost: 100, armor: 'none', weapon: armor({ damage: 15, rof: 20, range: 4, ag: true, aa: false }, pct(100)) };
const catalog = { tank, aa, rifle };

const groundTargets = [{ name: 'tank', zone: 0, armor: 'heavy' }, { name: 'tank', zone: 0, armor: 'heavy' }];
const airTargets = [{ name: 'aa', zone: 1, armor: 'light' }, { name: 'aa', zone: 1, armor: 'light' }];

// 1. A ground-only weapon cannot engage air -- and is not merely penalised for it.
assert.equal(canEngageTarget(tank, airTargets[0], catalog, api), false, 'no aa, no engagement');
assert.equal(counterValue(tank, airTargets, catalog, api), 0, 'and it scores nothing');
assert.ok(canEngageTarget(aa, airTargets[0], catalog, api), 'the anti-air weapon engages');
assert.ok(counterValue(aa, airTargets, catalog, api) > 0);

// 1b. With nobody visible there is nothing to counter, and the score must NOT be zero: the engine still
//     has to choose what to build, and zeroing every option freezes the plan. That is the "six vehicles
//     stayed below the attack gate" case, which is why the mobilize plan exists.
assert.ok(counterValue(tank, [], catalog, api) > 0, 'no visible enemy falls back to the generic score');
assert.equal(counterValue(tank, [], catalog, api), effectiveness(tank, [], catalog, api), 'and that fallback is the old averaged score');

// 2. Summing, not averaging: the SAME enemy, twice as many of it, scores twice as high. Averaging made the
//    score independent of how much enemy there was, so a two-unit wave and an eight-unit wave ranked the
//    options identically.
{
  const two = counterValue(tank, groundTargets, catalog, api);
  const four = counterValue(tank, [...groundTargets, ...groundTargets], catalog, api);
  assert.equal(Math.round(four / two), 2, `summing scales with the force (${two} -> ${four})`);
  const avg2 = effectiveness(tank, groundTargets, catalog, api);
  const avg4 = effectiveness(tank, [...groundTargets, ...groundTargets], catalog, api);
  assert.equal(avg2, avg4, 'whereas the average is unchanged, which is the defect being replaced');
}

// 3. The ordering follows the enemy: against air the anti-air unit wins, against ground the tank does.
{
  const score = (rule, targets) => counterValue(rule, targets, catalog, api);
  assert.ok(score(aa, airTargets) > score(tank, airTargets), 'air is answered by the anti-air unit');
  assert.ok(score(tank, groundTargets) > score(rifle, groundTargets), 'heavy ground is answered by the tank');
}

// 4. The percentage-form flags are refusals, not small damage ratios: a row of 0/1/2 engages nothing, where
//    the same numbers in a proportional row are ordinary multipliers. `versesArePercent` is what tells the
//    two apart -- per entry it is impossible, because a proportional full-strength 1 and a 1% flag are the
//    same number.
{
  const flagged = { cost: 700, armor: 'heavy', weapon: armor({ damage: 100, rof: 30, range: 5, ag: true }, [0, 1, 2, 0, 1, 2, 0, 2, 2, 0, 1]) };
  const target = { name: 'tank', zone: 0, armor: 'heavy' };
  assert.equal(versesArePercent(flagged.weapon), false, 'a row that never exceeds 2 is read as proportions');
  assert.equal(canEngageTarget(flagged, target, catalog, api), true, 'and there its 2 is a multiplier');
  const flaggedPct = { ...flagged, weapon: armor({ damage: 100, rof: 30, range: 5, ag: true }, [30, 1, 1, 1, 1, 2, 1, 1, 1, 1, 30]) };
  assert.equal(versesArePercent(flaggedPct.weapon), true, 'one entry above 2 makes it a percentage row');
  assert.equal(canEngageTarget(flaggedPct, target, catalog, api), false, 'and then the 2 in the heavy slot is the inert flag');
}
console.log('Counter value: summed over the visible enemy, zero for options that cannot engage it, and flags read per row');
