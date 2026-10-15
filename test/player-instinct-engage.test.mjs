import test from 'node:test';
import assert from 'node:assert/strict';
import { world, home, u, T, catalog } from './commander-world.mjs';
import { maintainBattle } from '../src/player/werhd-jev-player.mjs';

// The instinct layer picks a target for every unit on its own, and its filter used to answer only two questions:
// air-vs-ground (`canHit`) and range/line of sight (`canFireAt`). Neither says whether the unit can HURT what it
// is shooting at, so a dog next to a tank was ordered onto it -- while the naval branch, the mission branch and
// the base-defence loop in the same file all ask `canUnitHurt`. A dog cannot attack a vehicle or a building at
// all (`docs/ra2-unit-catalog.md`: 军犬「无法攻击载具、建筑」).
const run = (own, enemies) => {
  const calls = [];
  const w = world({ own, enemies, tick: 12000 });
  w.api.attack = (ids, targetId) => calls.push([ids, targetId]);
  w.api.attackMove = () => {};
  w.api.move = () => {};
  maintainBattle(w.api, catalog, w.memory, () => {});
  return calls;
};

test('the instinct layer does not order a dog onto a tank', () => {
  assert.deepEqual(run([...home(), u(300, 'ADOG', T.Infantry, 60, 60)], [u(900, 'HTNK', T.Vehicle, 61, 60)]), [],
    'ADOG cannot hurt heavy armour, so it is given no attack order');
});

test('...and it does order a tank in the same spot, which is what makes the line above mean something', () => {
  // Without this the assertion above would pass on a loop that never ran at all.
  const calls = run([...home(), u(200, 'HTNK', T.Vehicle, 60, 60)], [u(900, 'HTNK', T.Vehicle, 61, 60)]);
  assert.ok(calls.length > 0, 'a tank beside the same enemy is ordered to attack');
  assert.deepEqual(calls[0][1], 900);
});
