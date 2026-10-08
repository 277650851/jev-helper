import assert from 'node:assert/strict';
import { investmentGroups } from '../src/player/werhd-jev-strategy.mjs';

// Prerequisites are the sort key that was supposed to unstick the technology chain. It only works if
// "prerequisite unmet" means something. In the ruleset this project actually plays, a quarter of all
// prerequisite references name something that is not a rule at all: the war factory is written
// `Prerequisite=PROC,GAPILE,GACNST` and every anti-air emplacement `BARRACKS,GACNST`, while the
// runtime calls the barracks GAPILE and has no section called PROC or BARRACKS. Read literally, every
// one of those buildings was permanently "blocked" and got sorted behind whatever chain happened to
// resolve -- the exact stall the ordering was written to remove.
//
// The rule the implementation follows: only a prerequisite this side can actually name can be counted
// against a building. A name nothing in the catalogue answers to is a faction tag the engine resolves
// itself, and we can neither see nor judge it.

const BUILDINGS = {
  YARD: { yard: true, label: 'Construction Yard', cost: 2000, power: 0 },
  REFIN: { refinery: true, label: 'Ore Refinery', cost: 2000, power: 0 },
  // Gated only by tags that name no rule at all -- RADAR and BARRACKS, in this ruleset's spelling --
  // and the highest tier available, so it should lead. Read literally it was permanently "blocked"
  // and lost to the unblocked tier-9 below, which is the stall this guards.
  FACTION_GATED: { label: 'Radar Tower', cost: 800, power: 0, buildCategory: 'Tech', techLevel: 11, prerequisite: ['RADAR', 'BARRACKS', 'YARD'] },
  // Gated by a rule the base can see but does not own and is not building: one turn away, not a wall.
  SIGHTED_GATED: { label: 'Service Depot', cost: 800, power: 0, buildCategory: 'Tech', techLevel: 9, prerequisite: ['GONE', 'YARD'] },
  // Nothing ahead of it at all.
  OPEN: { label: 'Battle Lab', cost: 2000, power: 0, buildCategory: 'Tech', techLevel: 7, prerequisite: ['YARD'] },
  GONE: { label: 'Vanished Tech', cost: 500, power: 0, buildCategory: 'Tech', techLevel: 1 },
  // Same tier as FACTION_GATED and gated the same way, but unaffordable-for-now expensive.
  GATED_TIE: { label: 'Empire State Brain', cost: 2000, power: 0, buildCategory: 'Tech', techLevel: 11, prerequisite: ['RADAR', 'YARD'] },
};
const catalog = { ...BUILDINGS, TANK: { category: 'AFV', cost: 750, weapon: { damage: 100, ag: true, range: 5 } } };

const api = {
  QueueType: { Structures: 0, Armory: 1, Infantry: 2, Vehicles: 3, Aircrafts: 4, Ships: 5 },
  ObjectType: { Aircraft: 1, Building: 2, Infantry: 3, Vehicle: 7 },
  ArmorType: {}, canPlace: () => true,
  production: {
    queues: () => Array.from({ length: 6 }, (_, type) => ({ type, size: 0, maxSize: 10, items: [] })),
    available: (queue) => (queue === undefined || queue === 0) ? Object.keys(BUILDINGS).map(name => ({ name, type: 2 })) : [],
  },
};

function offered(owned) {
  const buildings = owned.map((name, i) => ({ id: i + 1, name, type: 2, tile: { rx: 10, ry: 10 } }));
  const tanks = Array.from({ length: 5 }, (_, i) => ({ id: 100 + i, name: 'TANK', type: 7, tile: { rx: 20 + i, ry: 10 }, isIdle: true, primaryWeapon: { damage: 100 } }));
  const snapshot = {
    raw: { units: [...buildings, ...tanks], buildings, army: tanks, enemies: [], base: buildings[0] },
    state: {
      tick: 1000, credits: 20000, freeCredits: 20000, uncommittedCredits: 20000, self: { credits: 20000 },
      harvesters: 2, harvestersMax: 2, army: 5, tanks: 5, inventory: {},
      economy: { factories: 1, refineries: 1, targetMiners: 2, powerMargin: 150 },
      power: { total: 200, drain: 50 },
      // Every queue idle and unlimited: `free()` is false of a queue that is missing, and a missing
      // queue is a paused one.
      queues: Array.from({ length: 6 }, (_, type) => ({ type, size: 0, maxSize: 10, items: [] })),
      strategy: { underPressure: false, suppressed: false, critical: false, investment: null, reserve: 0 },
    },
  };
  const groups = {};
  investmentGroups(api, catalog, snapshot, {}, groups);
  return Object.keys(groups.construction?.actions ?? {}).filter(k => k.startsWith('produce_')).map(k => k.slice('produce_'.length));
}

{
  // The regression. `RADAR` and `BARRACKS` name nothing in the catalogue; counting them as unmet put
  // every radar, every anti-air tower and the war factory permanently behind whatever resolved. The
  // group only ever carries the top-ranked candidate, so the tier-11 building has to come out first.
  const keys = offered(['YARD']);
  assert.equal(keys[0], 'FACTION_GATED',
    `a building gated only by faction tags must not be treated as blocked; got ${keys.join(',')}`);
}

{
  // Nothing may become permanently unbuildable: a prerequisite the base can see but does not own is
  // one turn of production away, not a wall. Satisfying it changes nothing about the ordering.
  const keys = offered(['YARD', 'GONE']);
  assert.equal(keys[0], 'FACTION_GATED',
    `the faction-gated building keeps leading once the other chain is satisfied; got ${keys.join(',')}`);
}

{
  // The last tie-break that actually runs once nothing is gated out: highest tier, then cheapest --
  // credit is the real constraint, so a 800-credit building is worth more than a 2,000-credit one at
  // the same tier, and a 2,000-credit offer that sits there unread is the stall this ordering exists
  // to avoid.
  const keys = offered(['YARD', 'GONE']);
  assert.equal(keys[0], 'FACTION_GATED',
    `among equals the cheaper building must lead; got ${keys.join(',')} (GATED_TIE is the same tier at 2000)`);
}

console.log('Technology chain: unnameable (faction-tag) prerequisites do not read as unmet — passed');
