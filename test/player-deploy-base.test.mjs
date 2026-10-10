import assert from 'node:assert/strict';
import { collectState, candidateGroups, requestGroupsFrom, engineOwnedMarks, askableGroups, collectTakeovers, rememberChoice, executeCandidate } from '../src/player/werhd-jev-player.mjs';
import { usableBuilders } from '../src/player/werhd-jev-strategy.mjs';

// `deploy_base` exists only while a construction vehicle is packed, and a packed one can build nothing -- so
// deploying is what makes the game proceed at all. The action is "deploy here"; there is no site to choose,
// so the model has nothing to weigh, and `wait` would mean the base never starts.
//
// Measured on `jev-report-20261010-061242`: the construction group asked twice, both times with
// `deploy_base` as the only real option, and the model answered `deploy_base` both times -- 0 refusals,
// which is what a question with a determined answer looks like.

const catalog = {
  MCV: { label: 'Construction vehicle', cost: 3000, deploysInto: 'YARD', armor: 'heavy' },
  // The crate path can hand over a vehicle the game will not unpack -- jev-report-20261010-115949 was given
  // an SMCV, which is why the refused case below is spelled with that name rather than a second MCV.
  SMCV: { label: 'Soviet construction vehicle', cost: 3000, deploysInto: 'YARD', armor: 'heavy' },
  YARD: { label: 'Construction Yard', yard: true, factory: 'BuildingType', cost: 2500, armor: 'concrete' },
  POWER: { label: 'Power Plant', cost: 800, factory: 'BuildingType', power: 200, armor: 'concrete' },
};
const own = [
  { id: 1, name: 'MCV', kind: 'MCV', type: 7, tile: { rx: 20, ry: 20 }, hitPoints: 1000, maxHitPoints: 1000, isIdle: true },
];
const api = {
  ObjectType: { Building: 2, Infantry: 3, Vehicle: 7, Aircraft: 1 },
  ZoneType: { Ground: 0, Air: 1 },
  QueueType: { Structures: 0, Armory: 1, Infantry: 2, Vehicles: 3, Aircrafts: 4, Ships: 5 },
  ArmorType: { 0: 'None', 5: 'Heavy', 8: 'Concrete' },
  me: () => ({ credits: 10000, power: { total: 0, drain: 0 }, defeated: false, isObserver: false }),
  units: (r) => (r === 'self' ? own : []),
  tick: () => 33, time: () => 2,
  map: { size: () => ({ width: 60, height: 60 }), visible: () => true, tile: (x, y) => (x >= 0 && y >= 0 && x < 60 && y < 60 ? { rx: x, ry: y, landType: 0 } : undefined) },
  canPlace: () => true, order: () => {}, crates: () => [], players: () => [],
  // With no yard standing nothing is producible -- which is exactly why unpacking is the only move. Giving
  // this fixture a buildable item would invent an alternative the real situation does not have.
  production: { queues: () => Array.from({ length: 6 }, (_, type) => ({ type, size: 0, maxSize: 99, items: [] })), available: () => [] },
  deploy: () => true, produce: () => {}, attack: () => {}, move: () => {}, attackMove: () => {},
};

const snap = collectState(api, catalog);
const groups = candidateGroups(api, catalog, snap, {});
const real = Object.keys(groups.construction?.actions ?? {}).filter((k) => k !== 'wait');
assert.ok(real.includes('deploy_base'), `a packed construction vehicle is the only way to start (${real.join(',')})`);
assert.equal(real.length, 1, 'and nothing else can be done until it is unpacked');
assert.equal(groups.construction.actions.deploy_base.engineOwned, true, 'so the engine owns the deployment');

const request = requestGroupsFrom(groups, {}, snap.state.tick);
const asked = askableGroups(request);
const takes = collectTakeovers(groups, null, engineOwnedMarks(groups), {}, snap.state.tick).filter((t) => !(t.id in asked));
const deploy = takes.find((t) => t.id === 'construction');
assert.ok(deploy, 'the engine deploys it itself');
assert.equal(deploy.choice, 'deploy_base');
assert.equal(deploy.reason, 'engine_decided');
assert.ok(!('construction' in asked), 'and the model is not asked about it');
console.log('Opening: the engine unpacks the construction vehicle itself rather than asking whether to start');

// A vehicle the game has already refused to unpack is not a builder, and the option must stop being offered
// while that is the only thing wrong. `jev-report-20261010-115949` is the measurement: a crate handed over
// an SMCV at tick 22825, `api.deploy` returned false that turn and on the next 45, and the engine re-issued
// the same order every turn -- 46 of the match's 89 decisions -- with a construction yard standing the whole
// time. The refusal is recorded where the order is executed (`rememberChoice`), so the model's own pick and
// the engine's takeover feed the same set.
{
  const memory = {};
  own[0] = { ...own[0], id: 9, name: 'SMCV', kind: 'SMCV', tile: { rx: 22, ry: 22 } };
  own.push({ id: 2, name: 'YARD', kind: 'YARD', type: 2, tile: { rx: 20, ry: 20 }, hitPoints: 1000, maxHitPoints: 1000, isIdle: false });
  // With the yard up and nothing said about that vehicle, it is still a builder like any other.
  const before = candidateGroups(api, catalog, collectState(api, catalog), memory);
  assert.ok(before.construction.actions.deploy_base, 'an unrefused vehicle is offered even while a yard stands');
  // The record a refused `api.deploy` leaves behind, through the same call the match makes.
  const refusing = { ...api, deploy: () => false };
  const refusal = executeCandidate(refusing, { type: 'deploy', ids: [9] }, catalog);
  assert.equal(refusal.reason, 'deploy_refused', 'the fixture can place a yard where the vehicle stands, so the vehicle is what was refused');
  assert.deepEqual(refusal.refusedAt, [[9, '22,22']], 'and the refusal remembers the spot, not just the vehicle');
  rememberChoice(memory, 'construction', 'deploy_base', refusal, 33, true, { type: 'deploy', ids: [9] });
  assert.equal(memory.deployRefused.get(9), '22,22', 'the refused vehicle is written off at that tile');
  const after = candidateGroups(api, catalog, collectState(api, catalog), memory);
  assert.ok(!after.construction.actions.deploy_base, 'and the order the game already rejected is not re-issued');
  assert.deepEqual(usableBuilders(own, catalog, memory).map((u) => u.id), [], 'it is not a builder for either producer');
  // The other refusal is a different fact: `canPlace` says the building does not fit where the vehicle
  // stands, so the spot is at fault. The order is still not re-issued from that spot, but a vehicle that
  // moves is worth one more try -- which is how a placement problem can ever be fixed.
  const stuck = executeCandidate({ ...refusing, canPlace: () => false }, { type: 'deploy', ids: [9] }, catalog);
  assert.equal(stuck.reason, 'deploy_no_space', 'a site that cannot host the building is named apart from a vehicle that cannot unpack');
  const moved = { ...own[0], tile: { rx: 24, ry: 24 } };
  own[0] = moved;
  const afterMoving = candidateGroups(api, catalog, collectState(api, catalog), memory);
  assert.ok(afterMoving.construction.actions.deploy_base, 'the same vehicle offered again once it has moved');
  assert.deepEqual(usableBuilders(own, catalog, memory).map((u) => u.id), [9], 'and it is a builder again');
  own[0] = { ...moved, tile: { rx: 22, ry: 22 } };
  // A refusal that clears by itself must NOT write the vehicle off: suppressing a retryable order would
  // trade one wasted turn for a missed base.
  const retryable = {};
  rememberChoice(retryable, 'construction', 'deploy_base', { accepted: false, reason: 'queue_changed' }, 33, true, { type: 'deploy', ids: [9] });
  assert.equal(retryable.deployRefused, undefined, 'only a deploy refusal is evidence about deployability');
  // Losing the yard is the emergency the option exists for: the engine keeps trying to come back.
  own.splice(own.findIndex((u) => u.id === 2), 1);
  const emergency = candidateGroups(api, catalog, collectState(api, catalog), memory);
  assert.ok(emergency.construction.actions.deploy_base, 'with no yard a refused vehicle is still worth one more try');
  assert.equal(emergency.construction.actions.deploy_base.engineOwned, true, 'and the engine still owns the attempt');
  // Restore the opening fixture for anything that follows.
  own.length = 0;
  own.push({ id: 1, name: 'MCV', kind: 'MCV', type: 7, tile: { rx: 20, ry: 20 }, hitPoints: 1000, maxHitPoints: 1000, isIdle: true });
}
console.log('A construction vehicle the game refused to unpack is not offered again while a yard stands, and is still offered when the base is gone');
