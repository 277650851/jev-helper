import test from 'node:test';
import assert from 'node:assert/strict';
import { frontierPoints } from '../src/player/werhd-jev-player.mjs';

// A scouting point is chosen for how much fog is around it, how far forward it is toward the middle
// of the map, and how far it is from home. Both the last two pull the same way, so the three highest
// scores are nearly always three points inside one far corner. The offered list used to separate them
// by a flat 10 tiles, which is "a different point" but not "a different part of the map" -- the result
// was one corner offered three times, the dog walking to that corner repeatedly, and most of the map
// never revealed. This is the shape of "the dog always runs to the bottom-left corner".

const W = 135, H = 135;
const world = (bx, by) => {
  const visible = new Set();
  for (let x = 0; x < W; x += 1) for (let y = 0; y < H; y += 1)
    if (Math.hypot(x - bx, y - by) < 22) visible.add(`${x},${y}`);
  return {
    tick: () => 100000,
    map: { size: () => ({ width: W, height: H }), tile: () => ({ landType: 1 }), visible: (x, y) => visible.has(`${x},${y}`) },
  };
};
const gap = (pts) => {
  let min = Infinity;
  for (let i = 0; i < pts.length; i += 1) for (let j = i + 1; j < pts.length; j += 1)
    min = Math.min(min, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
  return min;
};

test('the offered frontiers are separate places, not three points in one corner', () => {
  // A base in one corner, everything else fogged: exactly the opening the report describes.
  const points = frontierPoints(world(95, 95), { tile: { rx: 95, ry: 95 } }, { frontiers: new Map() });
  assert.ok(points.length > 1, 'more than one frontier is offered');
  // A third of the short side. Ten tiles passed this test too -- it is the point being far from the
  // OTHER frontiers, not the number, that matters.
  assert.ok(gap(points) >= Math.min(W, H) / 3 - 1,
    `frontiers are ${Math.round(gap(points))} tiles apart, expected at least ${Math.round(Math.min(W, H) / 3)}`);
});

test('the spread holds from every corner, not only the one the report showed', () => {
  for (const [bx, by, where] of [[95, 95, 'top-right'], [40, 40, 'top-left'], [95, 40, 'bottom-right'], [40, 95, 'bottom-left']]) {
    const points = frontierPoints(world(bx, by), { tile: { rx: bx, ry: by } }, { frontiers: new Map() });
    assert.ok(points.length > 1, `${where}: more than one frontier`);
    assert.ok(gap(points) >= Math.min(W, H) / 3 - 1,
      `${where}: frontiers are only ${Math.round(gap(points))} tiles apart`);
  }
});

test('frontiers still avoid water and recently visited ground', () => {
  const api = world(95, 95);
  api.map.tile = (x, y) => ({ landType: y < 20 ? 2 : 1 });   // a strip of water along the top
  const points = frontierPoints(api, { tile: { rx: 95, ry: 95 } }, { frontiers: new Map() });
  assert.ok(points.every((p) => p.y >= 20), 'no frontier is offered on water');
  // A frontier used moments ago is skipped, so the next question offers somewhere else.
  const fresh = frontierPoints(api, { tile: { rx: 95, ry: 95 } }, { frontiers: new Map([[`${points[0].x},${points[0].y}`, 100000]]) });
  assert.ok(!fresh.some((p) => p.x === points[0].x && p.y === points[0].y), 'the just-used frontier is not repeated');
});

test('a fully revealed map offers nothing to scout', () => {
  const api = {
    tick: () => 1,
    map: { size: () => ({ width: W, height: H }), tile: () => ({ landType: 1 }), visible: () => true },
  };
  assert.deepEqual(frontierPoints(api, { tile: { rx: 95, ry: 95 } }, { frontiers: new Map() }), []);
});
