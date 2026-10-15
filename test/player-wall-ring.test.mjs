import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseBuildingSite, trafficClearance, DEFENSE_SECTORS, WALL_RING_RADIUS, WALL_RING_SECTORS, WALL_EXIT_SECTORS, WALL_RING_SEGMENTS } from '../src/player/werhd-jev-strategy.mjs';

// Walls and defence towers are two different jobs that shared one code path. `defense` was
// `isBaseDefense || wall`, `turret` is `isBaseDefense && !wall`, and the "place it toward the approach"
// branch only ever ran for `defense && !turret` -- which is exactly `wall`. So that branch, written for the
// weapons page (patriot, pillbox, grand cannon, prism tower), had ended up as wall placement: a few segments
// stacked on the side the enemy was expected from, which screens nothing and is not a ring.
//
// These tests pin the split: towers keep the three-sector layout that covers the base all round, production
// still goes behind the base, and a wall now walks the perimeter with the exit sectors reserved -- because a
// ring that closes traps our own miners and tanks at home, which is worse than no wall at all.
const catalog = {
  GACNST: { yard: true, label: 'Construction Yard' },
  GAREFN: { refinery: true, label: 'Ore Refinery' },
  GAPOWR: { power: 200, label: 'Power Plant' },
  GAWALL: { wall: true, cost: 100, label: 'Allied Wall' },
  NASAM: { isBaseDefense: true, label: 'Patriot Missile', weapon: { damage: 40, range: 8, aa: true, ag: false, versus: [] } },
};
const b = (id, name, x, y) => ({ id, name, type: 2, tile: { rx: x, ry: y } });
// `chooseBuildingSite` answers with `{x, y}`; tiles and approaches are `{rx, ry}`. One helper reads both,
// because a NaN sector would silently pass every "takes its own sector" comparison.
const rxv = (p) => p.rx ?? p.x, ryv = (p) => p.ry ?? p.y;
const sectorOf = (p, base, sectors) => Math.floor(((Math.atan2(ryv(p) - base.ry, rxv(p) - base.rx) + Math.PI) / (Math.PI * 2)) * sectors) % sectors;

function world(own, approach) {
  const api = {
    ObjectType: { Building: 2 },
    map: { size: () => ({ width: 80, height: 80 }), tile: (x, y) => (x >= 0 && y >= 0 && x < 80 && y < 80 ? { rx: x, ry: y, landType: 0 } : undefined) },
    // The real one accounts for what already stands there; a fixture that always said yes would let two
    // segments land on the same tile and hide a ring that never advances.
    canPlace: (name, x, y) => x >= 0 && y >= 0 && x < 80 && y < 80 && !own.some((u) => u.tile.rx === x && u.tile.ry === y),
    LandType: { Clear: 0 },
  };
  return { api, memory: { strategy: approach ? { approach } : {} } };
}

test('a wall walks the ring around the base instead of stacking on the approach side', () => {
  const yard = b(1, 'GACNST', 30, 30), own = [yard];
  const { api, memory } = world(own, { rx: 60, ry: 30 });
  const sites = [];
  for (let i = 0; i < WALL_RING_SEGMENTS; i++) {
    const site = chooseBuildingSite(api, catalog, 'GAWALL', own, memory, 500);
    assert.ok(site, `segment ${i} has a site`);
    sites.push(site);
    own.push(b(100 + i, 'GAWALL', site.x, site.y));
  }
  const sectors = sites.map((s) => sectorOf(s, yard.tile, WALL_RING_SECTORS));
  assert.equal(new Set(sectors).size, sites.length, `every segment takes its own sector (got ${sectors})`);
  for (const s of sites) {
    const d = Math.hypot(s.x - 30, s.y - 30);
    assert.ok(d >= WALL_RING_RADIUS - 2 && d <= WALL_RING_RADIUS + 2, `the segment sits on the ring, not in one pile (${d.toFixed(1)} tiles)`);
  }
});

test('the exit is never walled: the sectors opposite the approach stay open', () => {
  const yard = b(1, 'GACNST', 30, 30), own = [yard];
  const approach = { rx: 60, ry: 30 };
  const { api, memory } = world(own, approach);
  const exitSector = sectorOf({ rx: 2 * 30 - approach.rx, ry: 2 * 30 - approach.ry }, yard.tile, WALL_RING_SECTORS);
  const gap = new Set(Array.from({ length: WALL_EXIT_SECTORS }, (_, k) => (exitSector + k - 1 + WALL_RING_SECTORS) % WALL_RING_SECTORS));
  assert.equal(gap.size, WALL_EXIT_SECTORS, 'the gap is a real arc of the ring');
  for (let i = 0; i < WALL_RING_SEGMENTS; i++) {
    const site = chooseBuildingSite(api, catalog, 'GAWALL', own, memory, 500);
    own.push(b(100 + i, 'GAWALL', site.x, site.y));
    assert.ok(!gap.has(sectorOf(site, yard.tile, WALL_RING_SECTORS)), `segment ${i} does not close the way out`);
  }
  // The cap is the open perimeter: the ring is laid once and then stops, rather than thickening a side.
  assert.equal(WALL_RING_SEGMENTS, WALL_RING_SECTORS - WALL_EXIT_SECTORS);
});

test('a wall never blocks the refinery or the way to the ore', () => {
  const yard = b(1, 'GACNST', 30, 30), refinery = b(2, 'GAREFN', 34, 30), own = [yard, refinery];
  const { api, memory } = world(own, { rx: 60, ry: 30 });
  // `trafficClearance` is what actually leaves the opening at the hub: six tiles around the refinery and the
  // war factory, and three tiles either side of every miner-to-refinery lane.
  for (let i = 0; i < WALL_RING_SEGMENTS; i++) {
    const site = chooseBuildingSite(api, catalog, 'GAWALL', own, memory, 500);
    assert.ok(site, `segment ${i} still finds a site beside the refinery`);
    assert.ok(Math.hypot(site.x - 34, site.y - 30) >= 6, `segment ${i} keeps the refinery clear`);
    assert.ok(trafficClearance({ rx: site.x, ry: site.y }, own.filter((u) => !catalog[u.name]?.wall), own, catalog), `segment ${i} is on a legal tile`);
    own.push(b(100 + i, 'GAWALL', site.x, site.y));
  }
});

test('the weapons page keeps its own layout: a tower spreads, production goes behind the base', () => {
  const yard = b(1, 'GACNST', 30, 30), approach = { rx: 60, ry: 30 };
  const { api, memory } = world([yard], approach);
  const tower = chooseBuildingSite(api, catalog, 'NASAM', [yard], memory, 500);
  const d = Math.hypot(tower.x - 30, tower.y - 30);
  assert.ok(d >= 4 && d <= 8, `the tower stands off by its own range (${d.toFixed(1)} tiles)`);
  assert.equal(sectorOf(tower, yard.tile, DEFENSE_SECTORS), sectorOf(approach, yard.tile, DEFENSE_SECTORS), 'the threatened sector is taken first');
  // Not a wall and not a gun: production still goes to the far side from the approach, which is what the
  // collapsed branch does now that walls have their own.
  const plant = chooseBuildingSite(api, catalog, 'GAPOWR', [yard], memory, 500);
  assert.ok(plant.x < 30, `production goes behind the base, away from the approach (x=${plant.x})`);
});
