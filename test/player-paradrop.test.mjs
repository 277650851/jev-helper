import test from 'node:test';
import assert from 'node:assert/strict';
import { maybeParadrop, PARADROP_TICKS } from '../src/player/werhd-jev-special.mjs';

// Free infantry, granted by owning the building that carries the special. The authoritative rules file is the
// source of every number here: `[CAAIRP]` Tech Airport is neutral, Capturable/NeedsEngineer, and declares
// `SuperWeapon=ParaDropSpecial`; `[AMRADR]` declares `SuperWeapon=AmericanParaDropSpecial`; both charge for
// `RechargeTime=4` minutes and the payload is fixed by the rules (Ally 6 E1 / Sov 9 E2 / Amer 8 E1). The API
// fires but cannot report readiness, so the cadence is derived from that recharge time and every attempt records
// its tick and tile for the next report to check.
const catalog = {};
const fixture = ({ own = ['CAAIRP'], tick = 10000, memory = {} } = {}) => {
  const calls = [], events = [];
  const api = {
    tick: () => tick,
    units: (r) => (r === 'self' ? own.map((name, i) => ({ id: i + 1, name })) : []),
    superweapon: (type, x, y) => calls.push([type, x, y]),
    SuperWeaponType: { ParaDrop: 5, AmerParaDrop: 6 },
  };
  const mem = { mission: { x: 60, y: 44 }, ...memory };
  maybeParadrop(api, mem, (e) => events.push(e), catalog);
  return { calls, events, mem };
};

test('owning the tech airport drops the paratroopers on the current mission', () => {
  const { calls, events, mem } = fixture();
  assert.deepEqual(calls, [[5, 60, 44]], 'the ParaDrop special, at the mission tile');
  assert.equal(events.length, 1, 'and it says so, with the tick and the tile');
  assert.match(events[0].description, /ParaDrop/);
  assert.match(events[0].description, /\(60,44\)/);
  assert.equal(mem.paradrop.ParaDrop, 10000, 'the attempt is recorded so the next report can check it');
});

test('the American command HQ uses its own special', () => {
  assert.deepEqual(fixture({ own: ['AMRADR'] }).calls, [[6, 60, 44]], 'AmerParaDrop, not ParaDrop');
  // Both carriers is two independent charges, so both fire.
  assert.deepEqual(fixture({ own: ['CAAIRP', 'AMRADR'] }).calls, [[5, 60, 44], [6, 60, 44]]);
});

test('the cadence is the rules recharge time, not every turn', () => {
  assert.deepEqual(fixture({ memory: { paradrop: { ParaDrop: 10000 - PARADROP_TICKS + 1 } } }).calls, [],
    'one tick short of a full charge is too early');
  assert.deepEqual(fixture({ memory: { paradrop: { ParaDrop: 10000 - PARADROP_TICKS } } }).calls, [[5, 60, 44]],
    'a full charge fires again');
  // The two charges are independent: an American drop does not spend the airport's charge.
  assert.deepEqual(fixture({ own: ['CAAIRP', 'AMRADR'], memory: { paradrop: { ParaDrop: 9000 } } }).calls,
    [[6, 60, 44]], 'only the uncharged one fires');
});

test('the last known enemy structure is the target when no mission is running', () => {
  const { calls } = fixture({ memory: { mission: undefined, forwardPoint: { rx: 12, ry: 30 } } });
  assert.deepEqual(calls, [[5, 12, 30]]);
});

test('nothing is fired without a carrier or without somewhere to drop', () => {
  assert.deepEqual(fixture({ own: ['GAPILE'] }).calls, [], 'no airport, no paratroopers');
  assert.deepEqual(fixture({ memory: { mission: undefined, forwardPoint: undefined } }).calls, [],
    'holding is the answer when there is nowhere useful to land');
  // The fire call alone is not enough: without the enum the weapon cannot be named, and a wrong index would
  // fire something else entirely (MultiMissile is 0).
  const api = { tick: () => 1, units: () => [{ id: 1, name: 'CAAIRP' }], superweapon: () => assert.fail('fired without the enum') };
  maybeParadrop(api, { mission: { x: 1, y: 2 } }, () => {}, catalog);
});
