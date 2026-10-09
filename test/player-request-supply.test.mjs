import assert from 'node:assert/strict';
import { requestGroupsFrom } from '../src/player/werhd-jev-player.mjs';

// A question must not contradict itself. Some options are offered before their full price is paid -- a
// survival rebuild is gated on `minCredits = Math.min(500, cost)` -- while the criteria text quotes the
// catalogue price ("cost 750") and the group's `wait` text says "Affordability has already been checked".
// A model holding 715 credits reads those two statements, cannot reconcile them, and declines.
//
// Measured on three reports: 10-13% of priced options were offered with the balance below the quoted cost,
// and they were almost always the group's ONLY option, so a refusal was the only answer available.

const group = (actions, criteria) => ({ vehicles: { instructions: 'i', criteria, actions } });

// 1. When the gate is below the price, the criteria state the gate, in the same place the model reads.
{
  const g = group(
    { produce_MTNK: { type: 'produce', name: 'MTNK', cost: 750, minCredits: 500 }, wait: { type: 'wait' } },
    { produce_MTNK: 'ARMY: produce Rhino; cost 750; we hold 715.', wait: 'Wait only if it is already in production.' },
  );
  const sent = requestGroupsFrom(g, {}, 100).vehicles.criteria.produce_MTNK;
  assert.match(sent, /cost 750/, 'the catalogue price is still quoted');
  assert.match(sent, /from 500 credits/, 'and the gate the engine actually enforces is stated beside it');
  assert.match(sent, /do not decline it for being just out of reach/, 'with the contradiction spelled out');
  assert.equal(requestGroupsFrom(g, {}, 100).vehicles.criteria.wait, 'Wait only if it is already in production.', 'other options are untouched');
}

// 2. Nothing is added when the two agree -- the text must not grow for the ordinary case.
{
  const g = group(
    { produce_MTNK: { type: 'produce', name: 'MTNK', cost: 750, minCredits: 750 }, wait: { type: 'wait' } },
    { produce_MTNK: 'ARMY: produce Rhino; cost 750.', wait: 'w' },
  );
  assert.equal(requestGroupsFrom(g, {}, 100).vehicles.criteria.produce_MTNK, 'ARMY: produce Rhino; cost 750.');
}

// 3. Options that are not production carry no price gate at all.
{
  const g = { tactics: { instructions: 'i', criteria: { defend_base: 'defend', wait: 'w' }, actions: { defend_base: { type: 'mission', mode: 'defend' }, wait: { type: 'wait' } } } };
  assert.equal(requestGroupsFrom(g, {}, 100).tactics.criteria.defend_base, 'defend');
  // A produce option with no gate recorded is left alone rather than given a made-up one.
  const partial = group(
    { produce_MTNK: { type: 'produce', name: 'MTNK', cost: 750 }, wait: { type: 'wait' } },
    { produce_MTNK: 'cost 750', wait: 'w' },
  );
  assert.equal(requestGroupsFrom(partial, {}, 100).vehicles.criteria.produce_MTNK, 'cost 750');
}
console.log('Request supply: an option offered before it is fully affordable states the gate the engine enforces');
