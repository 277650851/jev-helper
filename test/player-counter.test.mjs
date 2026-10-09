import assert from 'node:assert/strict';
import { collectState, candidateGroups } from '../src/player/werhd-jev-player.mjs';
import { buildEnemyProfile, enemyArchetype, counterBrief, canEngage, counterScore, versesArePercent } from '../src/player/werhd-jev-counter.mjs';

// The decision layer used to see the enemy only as a count: `visibleEnemyCount`, `nearbyEnemyCount`,
// `airThreatCount`. `collectState` did gather `visibleEnemies` with names and health, but nothing read
// the composition, so "build an effective counter" was the most specific the production questions
// could get, and eight conscripts looked the same as four Rhinos.
//
// These tests pin the profile that closes that loop: archetypes from what is visible, the threat each
// carries, what the visible mix implies, and -- through the rules' own `Verses` table -- which of our
// options actually hurts it.

// `heavy` for tanks, `light` for light vehicles, `none` for infantry, plus an aircraft. The armour
// word is the index into every weapon's `versus` array, so it is what the counter score is built on.
const catalog = {
  YARD: { yard: true, factory: 'BuildingType' },
  POWER: { power: 200, cost: 800 },
  REF: { refinery: true },
  MINER: { harvester: true },
  BARRACKS: { factory: 'InfantryType' },
  FACTORY: { factory: 'UnitType' },
  // Anti-armour: AP warhead, weak against unarmoured infantry.
  MTNK: { category: 'AFV', cost: 750, label: 'Grizzly', armor: 'heavy', weapon: { damage: 65, rof: 60, range: 5, ag: true, verses: [0.25, 0.25, 0.25, 0.75, 1, 1, 0.65, 0.45, 0.6, 0.6, 1] } },
  // Anti-infantry: small arms, useless against armour.
  E1: { cost: 100, label: 'GI', armor: 'none', factory: 'InfantryType', weapon: { damage: 15, rof: 20, range: 4, ag: true, verses: [1, 0.8, 0.7, 0.5, 0.25, 0.25, 0.75, 0.5, 0.25, 1, 1] } },
  // Anti-air only: the answer to aircraft, and nothing else.
  NASAM: { isBaseDefense: true, cost: 1000, label: 'Patriot', armor: 'concrete', weapon: { damage: 40, rof: 30, range: 8, aa: true, ag: false, verses: [0.4, 0.4, 0.4, 0.3, 0.2, 0.2, 0.3, 0.2, 0.2, 0.4, 0.4] } },
  // Enemy side.
  HTNK: { category: 'AFV', cost: 900, label: 'Rhino', armor: 'heavy', weapon: { damage: 90, rof: 65, range: 5.75, ag: true, verses: [0.25, 0.25, 0.25, 0.75, 1, 1, 0.65, 0.45, 0.6, 0.6, 1] } },
  FLAKT: { cost: 300, label: 'Flak Trooper', armor: 'none', weapon: { damage: 20, rof: 20, range: 4, aa: true, ag: true, verses: [1, 0.8, 0.7, 0.5, 0.25, 0.25, 0.75, 0.5, 0.25, 1, 1] } },
  ZEP: { aircraft: true, cost: 2000, label: 'Kirov', armor: 'light', weapon: { damage: 200, rof: 80, range: 3, ag: true, verses: [1, 0.9, 0.8, 0.7, 0.65, 0.45, 0.75, 0.4, 0.2, 0.8, 1] } },
  PILL: { isBaseDefense: true, cost: 500, label: 'Pillbox', armor: 'concrete', weapon: { damage: 15, rof: 26, range: 5, ag: true, verses: [1, 0.8, 0.7, 0.5, 0.25, 0.25, 0.75, 0.5, 0.25, 1, 1] } },
};
const u = (id, name, type, x, y, extra = {}) => ({ id, name, type, tile: { rx: x, ry: y }, hitPoints: 100, maxHitPoints: 100, isIdle: true, primaryWeapon: catalog[name]?.weapon, ...extra });
const own = [u(1, 'YARD', 2, 30, 30), u(2, 'POWER', 2, 26, 30), u(3, 'REF', 2, 30, 35), u(4, 'BARRACKS', 2, 32, 30), u(5, 'FACTORY', 2, 34, 30), u(6, 'MINER', 7, 28, 32)];
let enemies = [];
const api = {
  units: (relation) => (relation === 'self' ? own : relation === 'hostile' ? enemies : relation === 'enemy' ? enemies : []),
  me: () => ({ credits: 5000, power: { total: 300, drain: 100 } }),
  tick: () => 3000, time: () => 200,
  ObjectType: { Building: 2, Infantry: 3, Vehicle: 7, Aircraft: 1 },
  QueueType: { Structures: 0, Armory: 1, Infantry: 2, Vehicles: 3, Aircrafts: 4, Ships: 5 },
  OrderType: { DeploySelected: 10 }, ArmorType: { 0: 'None', 3: 'Light', 5: 'Heavy', 8: 'Concrete' },
  map: { size: () => ({ width: 60, height: 60 }), visible: () => true, tile: (x, y) => (x >= 0 && y >= 0 && x < 60 && y < 60 ? { rx: x, ry: y, landType: 0 } : undefined) },
  canPlace: (n, x, y) => x >= 20 && x <= 39 && y >= 20 && y <= 39 && !own.some((p) => Math.hypot(p.tile.rx - x, p.tile.ry - y) < 2),
  order: () => {}, crates: () => [],
  production: {
    queues: () => Array.from({ length: 6 }, (_, type) => ({ type, size: 0, maxSize: 99, items: [] })),
    available: (q) => (q === 1 ? ['NASAM'] : q === 2 ? ['E1'] : q === 3 ? ['MTNK'] : []).map((name) => ({ name, type: q === 1 ? 2 : q === 2 ? 3 : 7 })),
  },
};

// 1. Archetypes: a building, infantry, a tank at the same three-way split the counters rely on.
assert.equal(enemyArchetype(catalog.HTNK, { type: 7 }), 'vehicle');
assert.equal(enemyArchetype(catalog.FLAKT, { type: 3 }), 'infantry');
assert.equal(enemyArchetype(catalog.ZEP, { type: 1, zone: 1 }), 'air');
assert.equal(enemyArchetype(catalog.PILL, { type: 2 }), 'defense');
assert.equal(enemyArchetype(catalog.REF, { type: 2 }), 'building');
assert.equal(enemyArchetype(catalog.MINER, { type: 7 }), 'harvester');

// 2. A visible mixed force produces one line per archetype, with the armour word for each.
enemies = [u(100, 'HTNK', 7, 42, 30), u(101, 'HTNK', 7, 43, 30), u(102, 'FLAKT', 3, 44, 30), u(103, 'ZEP', 1, 45, 30, { zone: 1 })];
let snap = collectState(api, catalog);
let profile = buildEnemyProfile(api, catalog, snap.state, [{ name: 'MTNK' }, { name: 'E1' }, { name: 'NASAM' }]);
const kinds = Object.fromEntries(profile.groups.map((g) => [g.kind, g]));
assert.equal(profile.total, 4);
assert.equal(kinds.vehicle.count, 2, 'both Rhinos are counted as vehicles');
assert.equal(kinds.vehicle.armor, 'heavy', 'the armour word the versus table is indexed by reaches the profile');
assert.equal(kinds.infantry.count, 1);
assert.equal(kinds.air.count, 1, 'an aircraft in the air zone is not folded into ground vehicles');
assert.ok(profile.groups[0].threat > 0, 'threat is measured, not just counted');
const brief = counterBrief(profile);
assert.match(brief, /2 vehicle \(heavy\)/, 'the brief names what is actually visible');
assert.match(brief, /aircraft/i, 'the brief warns that ground weapons cannot answer aircraft');
assert.ok(profile.counters.length > 0, 'the profile names the best-answered options for what is visible');

// 3. The counter list follows the rules' Verses table, not a hard-coded table: against armour the
//    anti-armour gun must outscore the rifleman, and the anti-air tower must not be the answer to tanks.
const vsArmour = buildEnemyProfile(api, catalog, snap.state, [{ name: 'MTNK' }, { name: 'E1' }, { name: 'NASAM' }]);
const score = (name) => vsArmour.counters.find((c) => c.name === name)?.value ?? 0;
assert.ok(score('MTNK') > score('E1'), `anti-armour must outscore small arms against heavy armour (${score('MTNK')} vs ${score('E1')})`);

// 4. The profile reaches the model: it is part of the state, and the production questions carry the brief.
enemies = [u(100, 'HTNK', 7, 42, 30), u(101, 'HTNK', 7, 43, 30), u(102, 'HTNK', 7, 44, 30)];
const memory = {};
snap = collectState(api, catalog);
const groups = candidateGroups(api, catalog, snap, memory);
assert.ok(snap.state.enemyProfile, 'the profile travels with the state');
assert.equal(snap.state.enemyProfile.vehicles, 3);
assert.match(groups.vehicles.instructions, /Opposing force: 3 vehicle \(heavy\)/,
  'the vehicle question states what it is answering');
assert.match(groups.defenses.instructions, /Opposing force:/, 'so does the defence question');
// A visible enemy unit carries the armour word, which is what makes the profile possible at all.
const visible = snap.state.visibleEnemies.find((e) => e.kind === 'HTNK');
assert.equal(visible.armor, 'heavy', 'enemy armour reaches the state');
assert.equal(visible.type, 7, 'and so does the object type, so the list can be split by kind');

// 5. Nothing visible means no claim: the brief stays empty rather than inventing an enemy.
enemies = [];
snap = collectState(api, catalog);
const empty = candidateGroups(api, catalog, snap, {});
assert.equal(counterBrief(empty.enemyProfile ?? buildEnemyProfile(api, catalog, snap.state, [])), '');
assert.doesNotMatch(empty.vehicles.instructions, /Opposing force:/, 'no enemy visible, no opposing-force text');

// 6. The whole point of the profile: changing the enemy CHANGES which of our options is named. A module
//    that produced the same ordering for every enemy would satisfy every test above and still be useless.
//    This is the adaptive-countering claim, and it is the one that has to be pinned.
{
  const options = [{ name: 'MTNK' }, { name: 'E1' }, { name: 'NASAM' }];
  const top = () => buildEnemyProfile(api, catalog, collectState(api, catalog).state, options).counters[0]?.name;

  enemies = [u(200, 'HTNK', 7, 42, 30), u(201, 'HTNK', 7, 43, 30), u(202, 'HTNK', 7, 44, 30)];
  assert.equal(top(), 'MTNK', 'heavy armour is answered by the anti-armour gun');

  enemies = [u(210, 'ZEP', 1, 42, 30, { zone: 1 }), u(211, 'ZEP', 1, 43, 30, { zone: 1 })];
  assert.equal(top(), 'NASAM', 'aircraft are answered by the anti-air tower');

  enemies = Array.from({ length: 6 }, (_, i) => u(220 + i, 'FLAKT', 3, 42 + i, 30));
  assert.equal(top(), 'E1', 'a pure infantry wave is answered by the rifleman, not by the tank');
}

// 7. Engagement is a hard filter, not a low score: a ground-only weapon cannot be the answer to aircraft
//    even though its `Verses` row has a nonzero entry for every armour. Reading the row as a proportion
//    instead of a percentage makes a full-strength entry look like 1%, which is how this went wrong.
{
  enemies = [u(230, 'ZEP', 1, 42, 30, { zone: 1 }), u(231, 'ZEP', 1, 43, 30, { zone: 1 })];
  const profile = buildEnemyProfile(api, catalog, collectState(api, catalog).state, [{ name: 'MTNK' }, { name: 'E1' }, { name: 'NASAM' }]);
  const named = profile.counters.map((c) => c.name);
  assert.ok(named.includes('NASAM'), 'the anti-air tower is named');
  assert.ok(!named.includes('MTNK'), `a tank with no anti-air weapon must not be named against aircraft (${named.join(', ')})`);
  assert.ok(!named.includes('E1'), 'nor the rifleman');

  // And the flag values themselves: in the percentage form 0/1/2 mean cannot-fire / force-fire-only /
  // inert, so a weapon whose row is all flags engages nothing -- at any armour.
  const flagged = { category: 'AFV', cost: 700, armor: 'heavy', weapon: { damage: 100, rof: 30, range: 5, ag: true, verses: [0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1] } };
  enemies = [u(240, 'HTNK', 7, 42, 30)];
  assert.equal(versesArePercent(flagged.weapon), false, 'a row that never exceeds 2 is unambiguous: it cannot be a percentage row');
  assert.equal(canEngage(flagged, catalog.HTNK, 'vehicle'), true, 'and read as proportions its 2 is a multiplier, not the inert flag');
  // The same row as percentages: now every entry really is a flag, so nothing is engageable. Only the
  // row-level reading tells these two apart -- entry for entry they are the same small integers.
  const flaggedPct = { ...flagged, weapon: { ...flagged.weapon, verses: [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 41] } };
  assert.equal(versesArePercent(flaggedPct.weapon), true, 'one entry above 2 makes it a percentage row');
  assert.equal(canEngage(flaggedPct, catalog.HTNK, 'vehicle'), false, 'and a 1 in the heavy slot is force-fire only, not 100%');
  const flaggedPctFull = { ...flagged, weapon: { ...flagged.weapon, verses: [30, 1, 1, 1, 1, 100, 1, 1, 1, 1, 30] } };
  assert.equal(canEngage(flaggedPctFull, catalog.HTNK, 'vehicle'), true, 'while a 100 in the heavy slot is engagement');
  assert.equal(canEngage(catalog.MTNK, catalog.HTNK, 'vehicle'), true, 'a percentage row at full strength engages');
}

// 8. The two written forms are told apart by the ROW, not by the entry. A full-strength proportion of `1`
//    is the same number as the `1` flag, so reading each entry on its own cannot work: it either discards
//    every full-strength proportion or accepts every force-fire-only flag. The API documents `versus` only
//    as `Record<number, number>` with no scale, and the rules files use percentages while most fixtures
//    use proportions -- so the row has to say which convention it is in.
{
  const percent = { name: 'A', weapon: { damage: 100, rof: 30, range: 5, ag: true, verses: [100, 80, 70, 50, 25, 25, 75, 50, 25, 100, 100] } };
  const proportion = { name: 'B', weapon: { damage: 100, rof: 30, range: 5, ag: true, verses: [1, 0.8, 0.7, 0.5, 0.25, 0.25, 0.75, 0.5, 0.25, 1, 1] } };
  const target = { kind: 'HTNK', name: 'Rhino', type: 7, armor: 'heavy' };
  assert.equal(versesArePercent(percent.weapon), true, 'a row with a value above 2 is percentages');
  assert.equal(versesArePercent(proportion.weapon), false, 'a row that never exceeds 1 is proportions');
  // Both describe the same weapon at the same strength, so both must engage and score the same.
  for (const rule of [percent, proportion]) {
    assert.equal(canEngage(rule, catalog.HTNK, 'vehicle'), true, `${rule.name}: full strength engages`);
    assert.equal(counterScore(rule, [target], catalog), counterScore(percent, [target], catalog), `${rule.name}: the two forms agree`);
  }
  // A row of nothing but 1s is genuinely ambiguous -- "1% everywhere" and "100% everywhere" are the same
  // numbers -- so the row-level test cannot resolve it and reads it as proportions, i.e. full damage. The
  // limitation is worth stating: no real weapon's row is uniformly 1, and the alternative (reading them as
  // flags) would silently discard every proportion-form weapon that damages everything equally.
  const allOnes = { name: 'C', weapon: { damage: 100, rof: 30, range: 5, ag: true, verses: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1] } };
  assert.equal(versesArePercent(allOnes.weapon), false, 'an all-1 row cannot be identified as percentages');
  assert.equal(canEngage(allOnes, catalog.HTNK, 'vehicle'), true, 'so it is read as full damage rather than as force-fire only');
  assert.ok(counterScore(proportion, [target], catalog) > 0, 'the proportional form scores');
  const percentOneHeavy = { name: 'C2', weapon: { damage: 100, rof: 30, range: 5, ag: true, verses: [30, 1, 1, 1, 1, 1, 1, 1, 1, 1, 30] } };
  assert.equal(canEngage(percentOneHeavy, catalog.HTNK, 'vehicle'), false, 'with any entry above 2 the row IS percentages, and then the 1 is force-fire only');
  const zeros = { name: 'E', weapon: { damage: 100, rof: 30, range: 5, ag: true, verses: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } };
  assert.equal(canEngage(zeros, catalog.HTNK, 'vehicle'), false, 'a zero row cannot fire at anything, in either form');
}
console.log('Counter profile: archetypes, armour words, threat, rules-driven counter scores and the question brief');
console.log('Adaptive counters: the named answer follows the enemy mix, and weapons that cannot engage are excluded rather than under-scored');
