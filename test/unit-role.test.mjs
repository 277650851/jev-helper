import test from 'node:test';
import assert from 'node:assert/strict';
import { unitPurpose, purposeLine, UNIT_PURPOSE } from '../src/unit-role.mjs';

// The model is offered a list of what it may produce and each option carried its cost, speed, count and its
// armour-adjusted score -- but not the one thing a player knows without reading a manual: this is anti-air,
// this one breaks buildings, this one exists to kill miners. `docs/ra2-unit-catalog.md` has that column; this
// module is the part of it one decision can use.
test('a known unit gets the line the catalog doc gives it', () => {
  assert.match(unitPurpose('GGI'), /anti-tank|anti-air/);
  assert.match(unitPurpose('CMIN'), /income|teleport/);
  assert.match(unitPurpose('GAPILL'), /infantry/);
  assert.equal(unitPurpose('CMIN'), unitPurpose('cmin'), 'the lookup is case-insensitive');
});

test('an unknown name is a gap, never a wrong claim', () => {
  // The game is moddable and `rules()` returns map/MOD overrides, so a name nobody has heard of is normal.
  // An invented line would be worse than none: the option text would assert a role the unit does not have.
  assert.equal(unitPurpose('SOMETHING_NEW'), undefined);
  assert.equal(unitPurpose(undefined), undefined);
  assert.equal(unitPurpose(null), undefined);
  assert.equal(purposeLine('SOMETHING_NEW'), '', 'and it concatenates to nothing');
});

test('the line is short enough to sit in an option without crowding out the alternatives', () => {
  // Every option shares a 512-token head budget (`tools/laya-ctl.ps1 status` prints "option budget: 512
  // tokens (instructions not truncated)"). A note that doubled each option's length would cost the
  // alternatives it is supposed to help rank, which is the opposite of the point.
  for (const [name, text] of Object.entries(UNIT_PURPOSE)) {
    assert.ok(text.length <= 110, `${name} is ${text.length} chars: ${text}`);
    assert.ok(!text.endsWith('.'), `${name} must not carry its own full stop, purposeLine adds one`);
  }
  assert.equal(purposeLine('E1'), ` Role: ${UNIT_PURPOSE.E1}.`);
});
