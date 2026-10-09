import assert from 'node:assert/strict';
import { effectiveness, counterValue } from '../src/player/werhd-jev-strategy.mjs';

// `effectiveness(rule, targets, catalog, api)` is easy to call with the arguments swapped, and a swap does
// not throw: it produces a plausible number for the wrong question. That happened twice in this codebase --
// once where both "our power" and "enemy power" were computed from the ENEMY's weapon (so the comparison
// deciding `suppressed` was between two numbers describing the same side), and once where an average over
// targets was used to answer "how much of the visible enemy can this touch". These tests pin the semantics
// the callers depend on, so a future swap is caught here rather than in a match.

const api = { ObjectType: { Infantry: 3, Vehicle: 7, Aircraft: 1, Building: 2 }, ZoneType: { Ground: 0, Air: 1 }, ArmorType: { 0: 'None', 5: 'Heavy' } };
const w = (damage, extra = {}) => ({ damage, rof: 30, range: 5, ag: true, aa: false, versus: Array.from({ length: 11 }, () => 100), ...extra });
// A strong ground attacker and a weak one.
const strong = { cost: 900, armor: 'heavy', weapon: w(100) };
const weak = { cost: 300, armor: 'none', weapon: w(10) };
const catalog = { strong, weak, armour: { armor: 'heavy' }, flesh: { armor: 'none' } };

// 1. The rule is argument 1 and the target list is argument 2, and the target list MATTERS: a warhead that
//    is strong against armour and weak against flesh scores accordingly. This is the invariant the power
//    comparison depends on -- and a swap is silent, because both forms return plausible numbers.
{
  // Index 0 is `none` (flesh), index 5 is `heavy`. The armour is given as the NUMERIC index the `Verses`
  // table is addressed by, so this test is about the scoring semantics and not about how a unit's armour
  // word gets resolved from the catalog -- that resolution is covered elsewhere and has its own fallbacks
  // that would otherwise leak into these assertions.
  const antiArmour = { cost: 900, armor: 'heavy', weapon: w(100, { versus: [10, 10, 10, 10, 10, 100, 10, 10, 10, 10, 10] }) };
  const antiFlesh = { cost: 400, armor: 'none', weapon: w(100, { versus: [100, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10] }) };
  const armour = { name: 'armour', zone: 0, armor: 5 };
  const flesh = { name: 'flesh', zone: 0, armor: 0 };
  const vsArmour = effectiveness(antiFlesh, [armour], catalog, api);
  const vsFlesh = effectiveness(antiFlesh, [flesh], catalog, api);
  assert.ok(vsFlesh > vsArmour * 5, `the same weapon scores far higher on the armour it is meant for (${vsFlesh} vs ${vsArmour})`);
  assert.ok(effectiveness(antiArmour, [armour], catalog, api) > effectiveness(antiArmour, [flesh], catalog, api), 'and the reverse holds for the other warhead');
  // The swapped shape -- scoring an ENEMY's rule against the enemy list, the old power-comparison bug --
  // returns a self-consistent number, which is precisely why it survived: nothing about it looks wrong.
  assert.ok(effectiveness(antiFlesh, [flesh], catalog, api) > 0, 'the swapped form is positive and plausible');
}

// 2. `effectiveness` AVERAGES over the target list, so it shrinks as the list grows; `counterValue` sums, so
//    it grows. A caller that wants "how much of this force can I hurt" and uses the average gets an ordering
//    that ignores how much enemy there is.
{
  const one = [{ name: 'strong', zone: 0, armor: 'heavy' }];
  const four = [...one, ...one, ...one, ...one];
  assert.equal(effectiveness(weak, one, catalog, api), effectiveness(weak, four, catalog, api), 'the average is scale-invariant');
  assert.equal(counterValue(weak, four, catalog, api), counterValue(weak, one, catalog, api) * 4, 'the sum scales with the force');
}

// 3. A target that cannot be engaged scores zero for `counterValue` and only dilutes the average for
//    `effectiveness`. An all-air force is the case: a ground-only weapon is useless against it, and the
//    average cannot say so as long as anything else is in the list.
{
  const ground = { name: 'strong', zone: 0, armor: 'heavy' };
  const air = { name: 'air', zone: 1, armor: 'light' };
  const airCatalog = { ...catalog, air: { cost: 2000, armor: 'light', weapon: w(200), aircraft: true } };
  assert.equal(counterValue(strong, [air], airCatalog, api), 0, 'a ground weapon cannot touch air');
  const mixed = counterValue(strong, [ground, air], airCatalog, api);
  assert.equal(mixed, counterValue(strong, [ground], airCatalog, api), 'and the air unit adds nothing to the sum');
  const avgMixed = effectiveness(strong, [ground, air], airCatalog, api);
  assert.ok(avgMixed < effectiveness(strong, [ground], airCatalog, api), 'whereas it halves the average -- a penalty, not a refusal');
  assert.ok(avgMixed > 0, 'so the average still reports a healthy number for a weapon that can hit nothing in the air');
}
console.log('Effectiveness semantics: rule-vs-targets order, average against sum, and refusal against dilution');
