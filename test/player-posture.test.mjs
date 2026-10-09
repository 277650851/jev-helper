import assert from 'node:assert/strict';
import { canUnitHurt, activeWeapons, effectiveness } from '../src/player/werhd-jev-strategy.mjs';

// "Can this unit hurt that target?" was asked with `effectiveness(catalog[unit.name], [target], ...) > 0`,
// which scans BOTH of a rule's weapons and ignores posture. `activeWeapons` gives a deployable unit only the
// slot its posture allows, and the live rules supply a counterexample:
//
//   [GGI]  Deployer=yes  Primary=GuardianPara (no AA)   Secondary=GuardianMissile (AA=yes, AG=yes)
//
// so a MOBILE Guardian GI was judged able to shoot down aircraft it cannot fire at. Six call sites used that
// predicate to decide which units to send at which targets.

const api = {
  ObjectType: { Infantry: 3, Vehicle: 7, Aircraft: 1, Building: 2 },
  ZoneType: { Ground: 0, Air: 1 },
  ArmorType: { 0: 'None', 3: 'Light', 5: 'Heavy' },
};
const row = (fn) => Object.fromEntries(Array.from({ length: 11 }, (_, i) => [i, fn(i)]));
const full = row(() => 100);
const vsAir = (w) => ({ ...w, aa: true, ag: false });

// The Guardian GI as the rules carry it: ground-only while mobile, anti-air once deployed.
const ggi = {
  name: 'GGI',
  deployer: true,
  armor: 'none',
  weapon: { damage: 20, rof: 20, range: 4, ag: true, aa: false, versus: full },
  secondary: { damage: 40, rof: 30, range: 6, ag: true, aa: true, versus: full },
};
const rifle = { name: 'E1', armor: 'none', weapon: { damage: 15, rof: 20, range: 4, ag: true, aa: false, versus: full } };
const catalog = { GGI: ggi, E1: rifle, ZEP: { armor: 'light', aircraft: true } };
const aircraft = { name: 'ZEP', type: 1, zone: 1, armor: 'light' };
const tank = { name: 'T', type: 7, zone: 0, armor: 'heavy' };
const unit = (name, extra = {}) => ({ id: 1, name, isDeployed: false, primaryWeapon: catalog[name].weapon, secondaryWeapon: catalog[name].secondary, ...extra });

// 1. The bug, demonstrated: the old predicate says a mobile Guardian GI can hit aircraft, because it reads
//    the anti-air secondary as well. The posture-aware one says no.
{
  const mobile = unit('GGI');
  assert.ok(effectiveness(catalog.GGI, [aircraft], catalog, api) > 0, 'the averaged score over both weapons is positive against air');
  assert.equal(canUnitHurt(mobile, aircraft, catalog, api), false, 'but a MOBILE Guardian GI cannot fire at air at all');
  assert.equal(canUnitHurt(mobile, tank, catalog, api), true, 'it can still shoot ground, which is what it is for');
}

// 2. Deployed, the same unit gains the anti-air weapon and the answer flips.
{
  const deployed = unit('GGI', { isDeployed: true });
  assert.equal(canUnitHurt(deployed, aircraft, catalog, api), true, 'deployed, the missile is the active weapon');
  assert.equal(activeWeapons(deployed, catalog).length, 1, 'and a deployable unit has exactly one active slot');
  assert.equal(activeWeapons(unit('GGI'), catalog).length, 1, 'whether it is deployed or not');
}

// 3. A unit with no posture question keeps BOTH slots, so the change does not narrow it. The fixture needs
//    a secondary for that to be observable at all -- `activeWeapons` drops empty slots.
{
  assert.equal(canUnitHurt(unit('E1'), tank, catalog, api), true);
  assert.equal(canUnitHurt(unit('E1'), aircraft, catalog, api), false, 'a rifleman has no anti-air weapon');
  const twoSlots = { ...catalog, BOTH: { name: 'BOTH', armor: 'none', weapon: ggi.weapon, secondary: ggi.secondary } };
  const both = { name: 'BOTH', primaryWeapon: twoSlots.BOTH.weapon, secondaryWeapon: twoSlots.BOTH.secondary };
  assert.equal(activeWeapons(both, twoSlots).length, 2, 'a non-deployable unit keeps its secondary slot');
  assert.equal(canUnitHurt(both, aircraft, twoSlots, api), true, 'and can therefore use it');
  assert.equal(activeWeapons(unit('E1'), catalog).length, 1, 'while a unit with only a primary has one slot');
}

// 4. A unit whose weapons cannot engage anything is not able.
{
  const unarmed = { name: 'NONE', armor: 'none', weapon: { damage: 0, rof: 30, range: 1, ag: true, aa: false, versus: full } };
  const c2 = { ...catalog, NONE: unarmed };
  assert.equal(canUnitHurt({ name: 'NONE', primaryWeapon: unarmed.weapon }, tank, c2, api), false, 'zero damage hurts nothing');
}
console.log('Posture-aware ability: a mobile deployable unit is judged on the weapon it can actually fire');
