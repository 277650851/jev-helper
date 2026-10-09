import assert from 'node:assert/strict';
import { collectState, candidateGroups, requestGroupsFrom, engineOwnedMarks, askableGroups, collectTakeovers } from '../src/player/werhd-jev-player.mjs';

// `jev-report-20261010-061242` measured the deployment group: 8 questions, 7 of them single-option
// (5 `deploy_combat`, 2 `undeploy_mobile`), and the model agreed with every one -- 0 refusals. A question
// whose answer is never disputed is a round trip spent to hear "yes".
//
// Both options exist only once the engine has computed that the posture change is the better one:
// `toDeploy` requires `stanceScores(u).deployed >= stanceScores(u).normal`, and `toUndeploy` the reverse by
// a margin. So when one of them is also the group's only real option, there is nothing left to judge.

const row = (v) => Object.fromEntries(Array.from({ length: 11 }, (_, i) => [i, v]));
// A deployable GI: the deployed weapon hits harder and farther than the mobile one.
const catalog = {
  YARD: { yard: true, factory: 'BuildingType', label: 'Yard' },
  GGI: {
    label: 'Guardian GI', cost: 300, armor: 'none', deployer: true, factory: 'InfantryType', speed: 4,
    weapon: { damage: 20, rof: 20, range: 4, ag: true, aa: false, versus: row(100) },
    secondary: { damage: 100, rof: 15, range: 6, ag: true, aa: true, versus: row(100) },
  },
  HTNK: { label: 'Rhino', armor: 'heavy', category: 'AFV', weapon: { damage: 90, rof: 65, range: 5.75, ag: true, versus: row(100) } },
};
const own = [
  { id: 1, name: 'YARD', kind: 'YARD', type: 2, tile: { rx: 20, ry: 20 }, hitPoints: 1000, maxHitPoints: 1000 },
  { id: 2, name: 'GGI', kind: 'GGI', type: 3, tile: { rx: 21, ry: 21 }, hitPoints: 100, maxHitPoints: 100, isIdle: true, canDeploy: true, isDeployed: false, primaryWeapon: catalog.GGI.weapon, secondaryWeapon: catalog.GGI.secondary },
];
const enemies = [{ id: 900, name: 'HTNK', kind: 'HTNK', type: 7, tile: { rx: 23, ry: 21 }, hitPoints: 100, maxHitPoints: 100, zone: 0, armor: 'heavy', primaryWeapon: catalog.HTNK.weapon }];
const api = {
  ObjectType: { Building: 2, Infantry: 3, Vehicle: 7, Aircraft: 1 },
  ZoneType: { Ground: 0, Air: 1 },
  QueueType: { Structures: 0, Armory: 1, Infantry: 2, Vehicles: 3, Aircrafts: 4, Ships: 5 },
  ArmorType: { 0: 'None', 5: 'Heavy' },
  me: () => ({ credits: 3000, power: { total: 300, drain: 50 }, defeated: false, isObserver: false }),
  units: (r) => (r === 'self' ? own : r === 'enemy' || r === 'hostile' ? enemies : []),
  tick: () => 3000, time: () => 200,
  map: { size: () => ({ width: 60, height: 60 }), visible: () => true, tile: (x, y) => (x >= 0 && y >= 0 && x < 60 && y < 60 ? { rx: x, ry: y, landType: 0 } : undefined) },
  canPlace: () => true, order: () => {}, crates: () => [], players: () => [],
  inRange: (a, b, mode) => mode === 'current' ? true : true,
  weaponVs: () => undefined,
  production: { queues: () => Array.from({ length: 6 }, (_, type) => ({ type, size: 0, maxSize: 99, items: [] })), available: () => [] },
  setDeployed: () => {}, deploy: () => true, produce: () => {}, attack: () => {}, move: () => {}, attackMove: () => {},
};

const snap = collectState(api, catalog);
const groups = candidateGroups(api, catalog, snap, {});
const real = Object.keys(groups.deployment?.actions ?? {}).filter((k) => k !== 'wait');
assert.ok(real.length, `a beneficial posture change is offered (${real.join(',')})`);
assert.equal(real.length, 1, `and it is the only real option (${real.join(',')})`);
assert.equal(groups.deployment.actions[real[0]].engineOwned, true, 'the engine owns the posture it already computed as better');

const request = requestGroupsFrom(groups, {}, snap.state.tick);
const asked = askableGroups(request);
assert.ok(!('deployment' in asked), 'so the deployment question is not sent to the model');
const takes = collectTakeovers(groups, null, engineOwnedMarks(groups), {}, snap.state.tick).filter((t) => !(t.id in asked));
assert.ok(takes.some((t) => t.id === 'deployment' && t.reason === 'engine_decided'), 'and the engine executes it itself');

// The rule that keeps it a question when the posture really is a trade: with the mobile weapon the better
// one AND an alternative on offer, the group is not lifted.
{
  const actions = { wait: { type: 'wait' }, deploy_combat: { type: 'set_deployed', deployed: true, ids: [2], engineOwned: true }, undeploy_mobile: { type: 'set_deployed', deployed: false, ids: [3], engineOwned: true } };
  const twoOptions = { deployment: { instructions: 'i', criteria: { wait: 'c', deploy_combat: 'c', undeploy_mobile: 'c' }, actions } };
  const askedWith = askableGroups(requestGroupsFrom(twoOptions, {}, 100));
  assert.ok('deployment' in askedWith, 'with both posture changes on offer the question still goes to the model');
  assert.deepEqual(collectTakeovers(twoOptions, null, engineOwnedMarks(twoOptions), {}, 100), [], 'and the engine takes neither');
}
console.log('Deployment: the engine owns the posture change it computed as better, so the question is not asked');
