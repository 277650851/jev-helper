import assert from 'node:assert/strict';
import { candidateGroups, collectState, HOME_GUARD_UNITS } from '../src/player/werhd-jev-player.mjs';
import { refreshCatalog } from '../src/player/werhd-jev-catalog.mjs';

// The player's own rule: never leave the base undefended. The assault used to be built from every
// free combat unit and then narrowed by weapon range, so a raid during the walk to the enemy base met
// an empty base -- the defenders were the same units the mission was using, twenty tiles away and out
// of position.

const gun = (damage, range, aa = false) => ({ damage, range, aa, ag: true, verses: [1, 1, 1, 1, 1, 1] });
const catalog = {
  YARD: { yard: true, label: 'Yard' },
  BAR: { factory: 'InfantryType', label: 'Barracks' },
  GUN: { weapon: gun(30, 4), label: 'Rifleman' },
  SCOUT: { weapon: gun(30, 5), label: 'Scout Dog', speed: 20 },
  AA: { category: 'AFV', weapon: gun(20, 7, true), secondary: gun(20, 7, true), label: 'Flak Truck' },
  TANK: { category: 'AFV', weapon: gun(90, 5), label: 'Medium Tank' },
  SIEGE: { category: 'AFV', weapon: gun(120, 14), label: 'Long Range Artillery' },
  MINER: { harvester: true, label: 'Miner' },
};
for (const [k, v] of Object.entries(catalog)) { v.cost ??= 500; v.techLevel ??= 1; v.armor ??= 'heavy'; }

const base = { id: 1, name: 'YARD', type: 2, tile: { rx: 20, ry: 20 }, hitPoints: 1000, maxHitPoints: 1000 };

function world({ units, enemies = [], credits = 20000 }) {
  const tick = { value: 1000 };
  const own = [base, ...units];
  const api = {
    tick: () => tick.value,
    time: () => 600,
    me: () => ({ combatant: true, isObserver: false, defeated: false, credits }),
    units: (rel) => rel === 'self' ? own : rel === 'hostile' || rel === 'enemy' ? enemies : [],
    unit: (id) => [...own, ...enemies].find((u) => u.id === id),
    rules: () => undefined,
    crates: () => [],
    order: () => true, canPlace: () => true, sell: () => {}, move: () => {}, gather: () => {},
    ObjectType: { Aircraft: 1, Building: 2, Infantry: 3, Vehicle: 7 },
    ArmorType: {}, FactoryType: {}, BuildCat: {}, QueueType: { Structures: 0, Armory: 1, Infantry: 2, Vehicles: 3, Aircrafts: 4, Ships: 5 },
    ZoneType: { Air: 1 }, LandType: { Water: 7 }, OrderType: {},
    map: { size: () => ({ width: 64, height: 64 }), visible: () => false, tile: () => undefined },
    production: {
      queues: () => Array.from({ length: 6 }, (_, type) => ({ type, size: 0, maxSize: 10, items: [] })),
      available: () => [],
    },
  };
  const cat = refreshCatalog(api, {});
  for (const k of Object.keys(catalog)) cat[k] ??= catalog[k];
  const snap = collectState(api, cat);
  const groups = candidateGroups(api, cat, snap, {});
  return { snap, groups };
}
// Vehicles are type 7; a mobile anti-air escort has to be one, or it is infantry and gets
// picked as the scout. `category` is what tells the two apart here.
const unit = (id, name, x, y) => ({ id, name, type: catalog[name].category === 'AFV' ? 7 : 3, tile: { rx: x, ry: y }, hitPoints: 100, maxHitPoints: 100, isIdle: true, primaryWeapon: catalog[name].weapon });

// 1. A guard exists and stays out of the assault.
{
  const units = Array.from({ length: 12 }, (_, i) => unit(100 + i, 'TANK', 30 + (i % 4), 30 + Math.floor(i / 4)));
  const enemy = { id: 900, name: 'TOWER', type: 2, tile: { rx: 55, ry: 55 }, hitPoints: 1000, maxHitPoints: 1000, primaryWeapon: { damage: 40, ag: true, aa: false, range: 4 } };
  const { snap, groups } = world({ units, enemies: [enemy] });
  const assault = Object.values(groups.tactics.actions).find((a) => a.mode === 'attack');
  assert.ok(assault, 'the assault is offered');
  assert.ok(snap.state.forces.homeGuard > 0, 'a raid must never meet an empty base');
  assert.equal(snap.state.forces.striking + snap.state.forces.homeGuard, snap.state.forces.active);
  for (const g of snap.state.homeGuard) {
    assert.ok(!assault.ids.includes(g.id), `unit #${g.id} is on home guard and must not be in assault_${assault.targetId ?? '?'}`);
  }
  assert.ok(assault.ids.length > 0, 'the rest of the army still attacks');
}

// 2. A small force keeps everything: nothing can be spared when there is barely an attack group.
{
  const units = [unit(100, 'TANK', 30, 30), unit(101, 'TANK', 31, 30)];
  const { snap } = world({ units });
  assert.equal(snap.state.forces.homeGuard, 0, 'two tanks cannot both stay home and still have an attack group');
}

// 3. Mobile anti-air goes with the column when aircraft are about.
{
  const air = { id: 500, name: 'HELI', type: 1, zone: 1, tile: { rx: 40, ry: 40 }, hitPoints: 100, maxHitPoints: 100, primaryWeapon: { damage: 30, aa: true, ag: false, range: 5 }, ammo: 1 };
  const units = [
    ...Array.from({ length: 10 }, (_, i) => unit(100 + i, 'TANK', 30 + (i % 4), 30 + Math.floor(i / 4))),
    unit(200, 'AA', 31, 31),
  ];
  const shed = { id: 901, name: 'TOWER', type: 2, tile: { rx: 55, ry: 55 }, hitPoints: 1000, maxHitPoints: 1000, primaryWeapon: { damage: 40, ag: true, aa: false, range: 4 } };
  const { snap, groups } = world({ units, enemies: [air, shed] });
  assert.ok(snap.state.airThreatCount > 0, 'the aircraft is seen');
  const assault = Object.values(groups.tactics.actions).find((a) => a.mode === 'attack');
  assert.ok(assault.ids.includes(200), 'the mobile anti-air escort must travel with the column');
}

// 4. ...and is a candidate for the guard when there is no air threat, because then it is what a raid
// meets first. Sitting by the refinery, it is the nearest unit and is picked.
{
  const units = [
    ...Array.from({ length: 10 }, (_, i) => unit(100 + i, 'TANK', 30 + (i % 4), 30 + Math.floor(i / 4))),
    unit(200, 'AA', 22, 22),
  ];
  const { snap } = world({ units });
  assert.equal(snap.state.airThreatCount, 0);
  assert.ok(snap.state.homeGuard.some((g) => g.id === 200), 'with nothing in the air the flak truck is the best thing to park at home');
}

// 5. The one unit that can out-range a tower is never the one left behind.
{
  const tower = { id: 600, name: 'TOWER', type: 2, tile: { rx: 55, ry: 55 }, hitPoints: 1000, maxHitPoints: 1000, primaryWeapon: { damage: 80, ag: true, aa: false, range: 12 } };
  const units = [
    ...Array.from({ length: 10 }, (_, i) => unit(100 + i, 'TANK', 30 + (i % 4), 30 + Math.floor(i / 4))),
    unit(300, 'SIEGE', 30, 30),
  ];
  const { snap, groups } = world({ units, enemies: [tower] });
  assert.ok(!snap.state.homeGuard.some((g) => g.id === 300), 'reach belongs to the column: the guard answers raiders, it does not out-range anything');
}

// 6. The guard is bounded, so a large army does not hoard half its strength.
{
  const units = Array.from({ length: 60 }, (_, i) => unit(100 + i, 'TANK', 30 + (i % 10), 30 + Math.floor(i / 10)));
  const { snap } = world({ units });
  assert.ok(snap.state.forces.homeGuard <= HOME_GUARD_UNITS, `the guard is capped; got ${snap.state.forces.homeGuard}`);
  assert.ok(snap.state.forces.striking > snap.state.forces.homeGuard, 'the army still attacks with the majority');
}

console.log(`Home guard: a reserve is always kept at the base — passed`);
