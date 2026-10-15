import test from 'node:test';
import assert from 'node:assert/strict';
import { executeCandidate, PRODUCE_BATCH } from '../src/player/werhd-jev-player.mjs';
import { ATTACK_FORCE_SIZE } from '../src/player/werhd-jev-strategy.mjs';

// One unit per accepted option, re-asked every decision round, is the problem `docs/game-api-requests.md`
// §7.5 records: "一次只敢排 1 个; 钱曾堆到 5.7 万到 7 万却不造兵". An accepted option now queues a batch, and
// the size of it is re-checked against the live queue and balance at that moment -- the same way
// `executeProduction` already does for a commander order -- so a balance that fell since the question was
// asked shrinks the batch instead of over-committing.
const world = ({ credits = 9000, size = 0, maxSize = 5, queueType = 3 } = {}) => {
  const calls = [];
  const offers = { 0: [{ name: 'GAPOWR', type: 2 }], 2: [{ name: 'E1', type: 3 }], 3: [{ name: 'MTNK', type: 7 }], 4: [{ name: 'ORCA', type: 1 }], 5: [{ name: 'DEST', type: 4 }] };
  const api = {
    ObjectType: { Building: 2, Vehicle: 7, Infantry: 3, Aircraft: 1 },
    QueueType: { Structures: 0, Armory: 1, Infantry: 2, Vehicles: 3, Aircrafts: 4, Ships: 5 },
    me: () => ({ credits, power: { total: 100, drain: 0 } }),
    production: {
      queues: () => Array.from({ length: 6 }, (_, type) => ({ type, size: type === queueType ? size : 0, maxSize: type === queueType ? maxSize : 5, items: [] })),
      available: (q) => (q === undefined ? Object.values(offers).flat() : (offers[q] ?? [])),
    },
    produce: (name, n) => { calls.push(['produce', name, n]); },
  };
  return { api, calls };
};
const action = (over = {}) => ({ type: 'produce', name: 'MTNK', queue: 3, cost: 750, minCredits: 500, ...over });

test('an accepted production option queues a batch, not one unit', () => {
  const w = world({ credits: 9000 });
  const r = executeCandidate(w.api, action(), {});
  assert.equal(r.accepted, true);
  assert.equal(r.count, PRODUCE_BATCH);
  assert.deepEqual(w.calls, [['produce', 'MTNK', PRODUCE_BATCH]], 'one call, a batch');
});

test('the plan decides the batch: its own shortfall, capped by the step', () => {
  const two = world();
  assert.equal(executeCandidate(two.api, action({ count: 2 }), {}).count, 2, 'a plan two short queues two');
  const one = world();
  assert.equal(executeCandidate(one.api, action({ count: 1 }), {}).count, 1, 'and a plan one short queues one');
  const many = world();
  assert.equal(executeCandidate(many.api, action({ count: ATTACK_FORCE_SIZE }), {}).count, PRODUCE_BATCH,
    'a whole attack force is not queued on one accepted option');
});

test('the batch never exceeds the queue room or the balance', () => {
  const tight = world({ maxSize: 2 });
  assert.equal(executeCandidate(tight.api, action(), {}).count, 2, 'the queue holds only two');
  assert.deepEqual(tight.calls, [['produce', 'MTNK', 2]]);
  const poorer = world({ credits: 1600 });
  assert.equal(executeCandidate(poorer.api, action(), {}).count, 2, '1600 credits cover two Rhinos');
  const bare = world({ credits: 750 });
  assert.equal(executeCandidate(bare.api, action(), {}).count, 1, 'exactly one affordable is queued rather than refused');
});

test('only the infantry and vehicle pages queue in quantity', () => {
  // The two pages the game queues by quantity. Everything else is one item per call: the structure queue
  // holds a single building, and the aircraft and ship queues take one item and do not multiply it.
  const infantry = world({ queueType: 2 });
  assert.equal(executeCandidate(infantry.api, { type: 'produce', name: 'E1', queue: 2, cost: 180, minCredits: 500 }, {}).count, PRODUCE_BATCH);
  const vehicles = world({ queueType: 3 });
  assert.equal(executeCandidate(vehicles.api, action(), {}).count, PRODUCE_BATCH);
  const aircraft = world({ queueType: 4 });
  assert.equal(executeCandidate(aircraft.api, { type: 'produce', name: 'ORCA', queue: 4, cost: 1200, minCredits: 500 }, {}).count, 1);
  assert.deepEqual(aircraft.calls, [['produce', 'ORCA', 1]]);
  const ship = world({ queueType: 5 });
  assert.equal(executeCandidate(ship.api, { type: 'produce', name: 'DEST', queue: 5, cost: 2000, minCredits: 500 }, {}).count, 1);
});

test('a structure is still queued one at a time', () => {
  const w = world({ credits: 9000 });
  const r = executeCandidate(w.api, { type: 'produce', name: 'GAPOWR', queue: 0, cost: 2000, minCredits: 500 }, {});
  assert.equal(r.accepted, true);
  assert.equal(r.count, 1, 'the structure queue holds one, and a second power plant is not a batch');
  assert.deepEqual(w.calls, [['produce', 'GAPOWR', 1]]);
});

test('a queue that is no longer empty is refused rather than added to', () => {
  const w = world({ size: 1 });
  assert.equal(executeCandidate(w.api, action(), {}).reason, 'queue_changed');
  assert.deepEqual(w.calls, [], 'the engine re-checks the queue instead of trusting the question');
});
