import test from 'node:test';
import assert from 'node:assert/strict';
import { dropAim, DROP_THREAT_LIMIT } from '../src/player/werhd-jev-special.mjs';

// A drop zone is only useful if the troops live long enough to be commanded, and the enemy main base is the most
// defended tile on the map: eight riflemen dropped onto it are a gift unless it is already broken. `dropAim`
// scores the aim first and falls back to a position they can hold and be commanded from.
// (The nuke and the storm are deliberately NOT treated this way: they want the densest enemy.)
const catalog = { GACNST: { yard: true }, E2: { weapon: { damage: 15 } }, MTNK: { weapon: { damage: 65 } } };
const api = (enemies) => ({ ObjectType: { Building: 2, Vehicle: 7 }, units: (r) => (r === 'enemy' ? enemies : []) });
const defenders = (n) => Array.from({ length: n }, (_, i) => ({ id: 800 + i, name: 'E2', type: 3, tile: { rx: 52 + i, ry: 50 }, primaryWeapon: { damage: 15 } }));
const memory = { enemyBuildings: new Map([[1, { name: 'GACNST', x: 50, y: 50 }]]), forwardPoint: { rx: 20, ry: 20 } };

test('a target the defences can cover moves the drop somewhere the troops can hold', () => {
  const calm = dropAim(api(defenders(DROP_THREAT_LIMIT)), catalog, memory);
  assert.deepEqual([calm.x, calm.y, calm.why], [50, 50, 'enemy main base'], 'at the limit it still drops on the target');
  const hot = dropAim(api(defenders(DROP_THREAT_LIMIT + 1)), catalog, memory);
  assert.deepEqual([hot.x, hot.y], [20, 20], 'one armed enemy more and it falls back to the forward point');
  assert.match(hot.why, /safe position \(\d+ armed enemies/);
});

test('unarmed enemies do not count, and with nowhere safe to wait it takes the target anyway', () => {
  const unarmed = defenders(DROP_THREAT_LIMIT + 3).map((e) => ({ ...e, primaryWeapon: undefined, name: 'CIV' }));
  assert.deepEqual([dropAim(api(unarmed), catalog, memory).x], [50], 'a civilian cannot shoot at a paratrooper');
  const noHold = dropAim(api(defenders(9)), catalog, { enemyBuildings: memory.enemyBuildings });
  assert.deepEqual([noHold.x, noHold.y], [50, 50], 'without a hold position the enemy aim is still the answer');
  assert.equal(dropAim({ units: () => [] }, catalog, {}), undefined, 'nothing known, nothing to aim at');
});
