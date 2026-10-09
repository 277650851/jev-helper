import assert from 'node:assert/strict';
import { collectState, candidateGroups, requestGroupsFrom, engineOwnedMarks, askableGroups, collectTakeovers } from '../src/player/werhd-jev-player.mjs';

// `deploy_base` exists only while a construction vehicle is packed, and a packed one can build nothing -- so
// deploying is what makes the game proceed at all. The action is "deploy here"; there is no site to choose,
// so the model has nothing to weigh, and `wait` would mean the base never starts.
//
// Measured on `jev-report-20261010-061242`: the construction group asked twice, both times with
// `deploy_base` as the only real option, and the model answered `deploy_base` both times -- 0 refusals,
// which is what a question with a determined answer looks like.

const catalog = {
  MCV: { label: 'Construction vehicle', cost: 3000, deploysInto: 'YARD', armor: 'heavy' },
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
