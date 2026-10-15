import test from 'node:test';
import assert from 'node:assert/strict';
import { maybeFireSuperweapons, superWeaponTarget, SUPERWEAPONS, ENEMY_AIMED, TICKS_PER_MINUTE, SUPERWEAPON_FRIENDLY_CLEARANCE } from '../src/player/werhd-jev-special.mjs';

// Superweapons, aimed the way the doctrine says: hit the enemy position with the most targets, or the main base.
// Every number below comes out of `docs/rules(规则文件).ini` -- the nine `SuperWeapon=` declarations and their
// `RechargeTime`/`IsPowered`, with 60 s at the measured 14.83 ticks/s being 890 ticks.
//
// The API fires but cannot report readiness (`superweapon(...)` returns void and nothing on `PlayerConsoleUnit`
// carries a charge), so each weapon is attempted on its own rules recharge and every attempt records its tick and
// tile -- which is what the next report compares the battlefield against.
const catalog = {
  GACNST: { yard: true }, NAMISL: { power: -200 }, GAWEAT: { power: -200 }, CAWEAT: { power: -200 },
  NAIRON: { power: -200 }, GACSPH: { power: -200 }, NAPOWR: { power: 200 },
  CAAIRP: {}, CARADR: {}, AMRADR: {}, GADUMY: {},
};
const HOME = { rx: 100, ry: 100 };
const run = ({ own = ['NAMISL', 'NAPOWR'], enemies = [], memory = {}, tick = 100000 } = {}) => {
  const calls = [], events = [];
  const api = {
    tick: () => tick,
    units: (r) => (r === 'self' ? own.map((name, i) => ({ id: i + 1, name, tile: HOME })) : r === 'enemy' ? enemies : []),
    superweapon: (type, x, y) => calls.push([type, x, y]),
    SuperWeaponType: { MultiMissile: 0, IronCurtain: 1, LightningStorm: 2, ChronoSphere: 3, ChronoWarp: 4, ParaDrop: 5, AmerParaDrop: 6 },
  };
  maybeFireSuperweapons(api, (memory = { ...memory }), (e) => events.push(e), catalog);
  return { calls, events, memory };
};
const yard = (x = 50, y = 50) => new Map([[1, { name: 'GACNST', x, y }]]);

test('the table is every building the rules give a superweapon to', () => {
  assert.deepEqual(SUPERWEAPONS, [
    ['NAMISL', 'MultiMissile', 10, true], ['GAWEAT', 'LightningStorm', 10, true], ['CAWEAT', 'LightningStorm', 10, true],
    ['NAIRON', 'IronCurtain', 5, true], ['GACSPH', 'ChronoSphere', 7, true], ['GADUMY', 'ChronoWarp', 1, false],
    ['CAAIRP', 'ParaDrop', 4, false], ['CARADR', 'ParaDrop', 4, false], ['AMRADR', 'AmerParaDrop', 4, false],
  ]);
  assert.deepEqual([...ENEMY_AIMED].sort(), ['AmerParaDrop', 'LightningStorm', 'MultiMissile', 'ParaDrop']);
  assert.equal(TICKS_PER_MINUTE, 890, '60 s at the measured 14.83 ticks/s');
});

test('the aim is the main base first, then the densest cluster of targets', () => {
  const api = { units: (r) => (r === 'enemy' ? [{ tile: { rx: 10, ry: 10 } }, { tile: { rx: 11, ry: 10 } }, { tile: { rx: 60, ry: 60 } }] : []) };
  assert.deepEqual(superWeaponTarget(api, catalog, { enemyBuildings: yard(50, 50) }), { x: 50, y: 50, why: 'enemy main base' },
    'the construction yard outranks every cluster');
  const cluster = superWeaponTarget(api, catalog, { enemyBuildings: new Map([[1, { name: 'GAPOWR', x: 40, y: 40 }]]) });
  assert.deepEqual([cluster.x, cluster.y, cluster.why], [10, 10, 'enemy cluster (2 targets)'], 'the pair beats the lone unit');
  assert.deepEqual(superWeaponTarget({ units: () => [] }, catalog, { mission: { x: 7, y: 8 } }), { x: 7, y: 8, why: 'current mission' });
  assert.equal(superWeaponTarget({ units: () => [] }, catalog, {}), undefined, 'nothing known, nothing fired');
});

test('the nuke hits the base, then waits its own ten minutes', () => {
  assert.deepEqual(run({ memory: { enemyBuildings: yard() } }).calls, [[0, 50, 50]], 'MultiMissile on the enemy yard');
  assert.deepEqual(run({ memory: { enemyBuildings: yard(), superweapon: { MultiMissile: 100000 - 10 * 890 + 1 } } }).calls, [],
    'one tick short of a full charge is too early');
  assert.deepEqual(run({ memory: { enemyBuildings: yard(), superweapon: { MultiMissile: 100000 - 10 * 890 } } }).calls, [[0, 50, 50]]);
  // Two nuclear silos are one charge, and the weather controller has its own. Both drain 200, so the fixture
  // has to pay for them: the brown-out gate below is what skipped this case before the power was added.
  assert.deepEqual(run({ own: ['NAMISL', 'NAMISL', 'NAPOWR', 'NAPOWR', 'NAPOWR'], memory: { enemyBuildings: yard() } }).calls, [[0, 50, 50]]);
  assert.deepEqual(run({ own: ['NAMISL', 'GAWEAT', 'NAPOWR', 'NAPOWR', 'NAPOWR'], memory: { enemyBuildings: yard() } }).calls, [[0, 50, 50], [2, 50, 50]]);
});

test('a nuke is never fired onto our own army, a drop has no such limit', () => {
  const near = yard(HOME.rx + SUPERWEAPON_FRIENDLY_CLEARANCE - 1, HOME.ry);
  assert.deepEqual(run({ memory: { enemyBuildings: near } }).calls, [], 'the army is inside the blast');
  const far = yard(HOME.rx + SUPERWEAPON_FRIENDLY_CLEARANCE + 1, HOME.ry);
  assert.deepEqual(run({ memory: { enemyBuildings: far } }).calls, [[0, HOME.rx + SUPERWEAPON_FRIENDLY_CLEARANCE + 1, HOME.ry]], 'clear of it, fire');
  assert.deepEqual(run({ own: ['CAAIRP'], memory: { enemyBuildings: near } }).calls, [[5, HOME.rx + SUPERWEAPON_FRIENDLY_CLEARANCE - 1, HOME.ry]],
    'the dropped units are ours, so nothing is at risk');
});

test('a powered charge waits out a brown-out, an unpowered one does not', () => {
  // No power plant in `own`: the silo drains 200 and the margin is negative.
  assert.deepEqual(run({ own: ['NAMISL'], memory: { enemyBuildings: yard() } }).calls, [], 'IsPowered=true');
  assert.deepEqual(run({ own: ['CAAIRP'], memory: { enemyBuildings: yard() } }).calls, [[5, 50, 50]], 'IsPowered=false');
});

test('the specials aimed at our own units are never fired by an enemy-aim rule', () => {
  assert.deepEqual(run({ own: ['NAIRON', 'GACSPH', 'GADUMY', 'NAPOWR'], memory: { enemyBuildings: yard() } }).calls, [],
    'Iron Curtain and Chrono Sphere take our units, and Chrono Warp needs a second click');
});

test('with no enemy position to aim at, nothing is fired and nothing is spent', () => {
  const { calls, memory } = run({ memory: {} });
  assert.deepEqual(calls, []);
  assert.equal(memory.superweapon?.MultiMissile, undefined, 'an aimless turn does not burn the charge');
});

test('without the enum nothing is fired, whatever the table says', () => {
  const api = { tick: () => 1, units: () => [{ id: 1, name: 'NAMISL' }], superweapon: () => assert.fail('fired without the enum') };
  maybeFireSuperweapons(api, { enemyBuildings: yard() }, () => {}, catalog);
});
