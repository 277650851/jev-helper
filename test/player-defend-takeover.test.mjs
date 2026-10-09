import assert from 'node:assert/strict';
import { CATALOG, SCENARIOS } from '../src/synthetic-state.mjs';
import { replayApi } from '../src/replay-state.mjs';
import { collectState, candidateGroups, requestGroupsFrom, engineOwnedMarks, askableGroups, collectTakeovers } from '../src/player/werhd-jev-player.mjs';

// `defend_base` only exists once the engine has established that the base is under attack. When it is also
// the ONLY real option there is nothing left to judge -- the force is not ready to attack, so the choice is
// between intercepting the attackers and watching them.
//
// `jev-report-20261010-061242` is the measurement: tactics asked 8 questions, all of them single-option.
// Four were `defend_base` alone and two of those were refused, and every refusal was `wait` at ~55%
// probability -- declining to defend a base the engine had just reported as attacked. The other four were
// `assemble_force` alone, which stays a question because it is not a defensive emergency.

const nm = (x) => x?.kind ?? x?.name;
const base = SCENARIOS.defense_floor();
const units = (n, name, type, x, y) => Array.from({ length: n }, (_, i) => ({ id: 500 + i, name, kind: name, type, tile: { rx: x + (i % 3), ry: y + Math.floor(i / 3) }, armor: CATALOG[name]?.armor, primaryWeapon: CATALOG[name]?.weapon }));

// The base is attacked, and the army is too small to be sent out.
const state = {
  ...base,
  visibleEnemies: [...(base.visibleEnemies ?? []), ...units(2, 'HTNK', 7, 22, 22)],
  army: [...(base.army ?? []).slice(0, 0), ...units(3, 'MTNK', 7, 20, 24), ...units(2, 'CMIN', 7, 18, 18)],
};
const api = replayApi({ side: 'allied', ...state }, { ...CATALOG });
const catalog = { ...CATALOG };
const snap = collectState(api, catalog);
const groups = candidateGroups(api, catalog, snap, {});

const tacticsActions = Object.keys(groups.tactics?.actions ?? {}).filter((k) => k !== 'wait');
assert.ok(tacticsActions.includes('defend_base'), `the base is under attack, so defending is offered (${tacticsActions.join(',')})`);
assert.deepEqual(tacticsActions, ['defend_base'], 'and nothing else is: the force is not ready to attack');

// With it as the only real option, the engine takes it and the model is not asked.
assert.equal(groups.tactics.actions.defend_base.engineOwned, true, 'the engine owns the defensive emergency');
const request = requestGroupsFrom(groups, {}, snap.state.tick);
const asked = askableGroups(request);
assert.ok(!('tactics' in asked), 'so the tactics question is not sent');

const takes = collectTakeovers(groups, null, engineOwnedMarks(groups), {}, snap.state.tick).filter((t) => !(t.id in asked));
const defended = takes.find((t) => t.id === 'tactics');
assert.ok(defended, 'the engine takes the defence itself');
assert.equal(defended.choice, 'defend_base');
assert.equal(defended.reason, 'engine_decided');

// The other shape from the same report: when an attack or an assembly is also on offer the option stays a
// question, because abandoning an offensive to fall back is a real trade. Build that by giving the force
// enough mobile units to be ready.
// The option is TAGGED engine-owned unconditionally, and the mechanism is what keeps it a question when a
// real alternative exists: `splitEngineOwned` only lifts an option that is the group's single real choice.
// So when the same state also offers an attack, the tactics question is still sent to the model.
//
// That second shape is not reproducible from these fixtures alone -- it needs a visible enemy base and a
// ready force, which the synthetic scenarios do not compose to here. What IS asserted is the rule that
// decides it, on the same player pipeline the match uses.
{
  const actions = { wait: { type: 'wait' }, defend_base: { type: 'mission', mode: 'defend', engineOwned: true }, attack_9: { type: 'mission', mode: 'attack' } };
  const withAttack = { tactics: { instructions: 'i', criteria: { wait: 'c', defend_base: 'c', attack_9: 'c' }, actions } };
  const askedWith = askableGroups(requestGroupsFrom(withAttack, {}, 100));
  assert.ok('tactics' in askedWith, 'with an attack also on offer the tactics question still goes to the model');
  assert.equal(Object.keys(askedWith.tactics.criteria).length, 3, 'and keeps both real options');
  assert.deepEqual(collectTakeovers(withAttack, null, engineOwnedMarks(withAttack), {}, 100), [], 'so the engine does not take it');
}
console.log('Defensive emergency: the engine owns `defend_base` when it is the only option, and asks when there is a real alternative');
