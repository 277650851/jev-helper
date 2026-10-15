import test from 'node:test';
import assert from 'node:assert/strict';
import { world, home, u, T, catalog } from './commander-world.mjs';
import { collectState, candidateGroups } from '../src/player/werhd-jev-player.mjs';

// A dog cannot attack a vehicle or a building at all (`docs/ra2-unit-catalog.md`: 军犬「无法攻击载具、建筑」),
// yet both attack options carried the whole party: `active = [...tanks, ...support]`, where `support` is every
// infantry that is not the scout -- and the dog is the designated scout's rival, not its exception.
// jev-report-20261015-110417 is that shape: 17 ADOG produced, the largest infantry group in the match, listed
// beside the tanks in every attack option, and the screenshots show exactly that column.
//
// Both producers are covered here. `assault_<id>` names one target; `engage_visible` names the best mobile
// enemy, which by construction is a unit WITH a weapon -- a tank.
//
// The rule is compatibility, not "dogs never attack": against something a dog CAN kill the same party keeps
// them, which is what makes this a filter on the target rather than on the unit.
const own = () => [...home(),
  ...Array.from({ length: 8 }, (_, i) => u(200 + i, 'HTNK', T.Vehicle, 55 + i, 62)),
  u(300, 'ADOG', T.Infantry, 58, 60), u(301, 'ADOG', T.Infantry, 59, 60), u(302, 'ADOG', T.Infantry, 60, 60)];
const DOGS = [300, 301, 302];
const actionsFor = (enemy) => {
  const w = world({ own: own(), enemies: [enemy], tick: 12000 });
  return candidateGroups(w.api, catalog, collectState(w.api, catalog), w.memory).tactics?.actions ?? {};
};

test('an assault on a building leaves the dogs at home', () => {
  // An unarmed refinery: `hitsGround` is false, so the range filter never ran and the dogs went along.
  const action = actionsFor(u(900, 'NAREFN', T.Building, 65, 70)).assault_900;
  assert.ok(action, 'the visible refinery is an assault option');
  assert.equal(action.ids.filter((id) => DOGS.includes(id)).length, 0, 'no dog is sent at a building');
  assert.ok(action.ids.some((id) => id >= 200 && id < 208), 'the tanks still go');
});

test('engaging a visible tank leaves them at home too', () => {
  // The reported case: a Rhino is a mobile unit with a weapon, so it is offered as `engage_visible` -- and a
  // dog cannot bite a heavy tank.
  const action = actionsFor(u(905, 'HTNK', T.Vehicle, 65, 70)).engage_visible;
  assert.ok(action, 'the visible tank is an engagement option');
  assert.equal(action.targetId, 905);
  assert.equal(action.ids.filter((id) => DOGS.includes(id)).length, 0, 'no dog is ordered onto a tank');
  assert.ok(action.ids.some((id) => id >= 200 && id < 208), 'the tanks still answer');
});

test('but a target a dog CAN kill still gets them', () => {
  // The same `engage_visible` path against enemy infantry: a dog one-shots those, so dropping it here would be
  // the opposite mistake. This is what tells the two rules apart.
  const action = actionsFor(u(903, 'ADOG', T.Infantry, 65, 70)).engage_visible;
  assert.ok(action, 'the enemy dog is an engagement option');
  assert.ok(action.ids.some((id) => DOGS.includes(id)), 'a dog is sent at infantry it can kill');
});
