// Rebuild a queryable player API over a state summary, so the decision layer can be re-run offline.
//
// WHERE THE STATES COME FROM, AND WHY NOT FROM A BATTLE REPORT.
// The obvious source would be an archived report, but it does not work: the `state` a report stores on
// each decision entry is `stateSummary` from src/logbook.mjs, which is deliberately numeric-only --
// `army` there is a COUNT, not the unit list, and `visibleEnemies` has no composition at all (that is
// the same gap `werhd-jev-counter.mjs` closes in the live state). Replaying a report would therefore
// reconstruct a base with no units and no enemy, which is worse than useless: it would silently produce
// confident wrong answers, the exact failure this repository keeps repeating. Real states would have to
// be captured live with the local server's `--dump-states`, which this checkout does not have.
//
// So the states are generated instead: `src/synthetic-state.mjs` builds them from scenario templates,
// deterministically, and this module turns one into an API the engine can query.
//
// WHAT THIS IS FAITHFUL ABOUT, and what it is not.
//   Faithful: credits, power, the harvesters count, our army (id, kind, type, health, tile, idle) and the
//   visible enemy list (id, kind, type, armour, health, tile, zone). Those come straight out of the
//   state, and they are what group construction reads: affordability, force counts, archetypes, threat
//   and counter scoring.
//   Approximated: everything a summary does not carry. Building POSITIONS are manufactured on a ring
//   around the base, because a summary keeps only counts per kind; unit weapons, deployment flags, ammo
//   and veteran level are absent; build menus are inferred from which production buildings exist. So
//   this replays WHAT QUESTIONS WOULD BE ASKED, not how units behave. Never use it to judge movement,
//   combat or placement quality -- only question shape, option sets and the determinacy they imply.
import { refreshCatalog } from './player/werhd-jev-catalog.mjs';

// Building positions are lost by the summary. They are laid out on a ring around the base so that
// placement checks have somewhere legal to put a new structure and so that `baseThreats` (which measures
// against building tiles) is not measuring a pile of coincident objects. The ring is generated rather
// than listed so that a base with more buildings than the list has slots still keeps every one of them:
// dropping the extras would under-count the inventory, which several rules read.
const buildingOffset = (i) => {
  if (i === 0) return [0, 0];
  const ring = Math.floor((i - 1) / 8) + 1;
  const slot = (i - 1) % 8;
  const angle = (slot / 8) * 2 * Math.PI;
  return [Math.round(Math.cos(angle) * 3 * ring), Math.round(Math.sin(angle) * 3 * ring)];
};
const BUILDING_TYPE = 2;

// Names the catalog knows as production or support buildings, used to infer a build menu. The queue ids
// follow the game's own QueueType order, which the rest of the code reads from `api.QueueType`.
const menuFor = (catalog, kind, suffix) => Object.keys(catalog).filter((name) => {
  const r = catalog[name];
  if (!r || r.buildCategory !== kind) return false;
  return suffix(r);
});

/**
 * Build a player API over a recorded state summary.
 * @param state        the `state` object recorded on a decision entry
 * @param catalog      a catalog object; filled from `rules` if a `rules` function is supplied
 * @param options.rules optional `(name, type) => rule` to enrich the catalog (the live API's shape)
 */
export function replayApi(state = {}, catalog = {}, options = {}) {
  // Fail loudly on a missing state. A silent empty replay would report "no questions and no problems",
  // which is the most flattering answer a benchmark can give and therefore the most dangerous one.
  if (!state || typeof state !== 'object') throw new Error('replayApi needs a state summary; a report archives only numbers, not units (see src/replay-state.mjs)');
  const baseTile = { rx: state.base?.x ?? 20, ry: state.base?.y ?? 20 };
  const width = Math.max(64, (state.base?.x ?? 20) + 32), height = Math.max(64, (state.base?.y ?? 20) + 32);

  // --- our units -------------------------------------------------------------------------------
  const own = [];
  let nextId = 1;
  // The army list survives with kind/type/health/tile, which is everything the group logic counts.
  for (const u of state.army ?? []) {
    own.push({
      id: u.id ?? nextId++, name: u.kind ?? u.name, type: u.type ?? 7,
      tile: { rx: u.tile?.x ?? baseTile.rx, ry: u.tile?.y ?? baseTile.ry },
      hitPoints: u.hp, maxHitPoints: Math.round((u.hp ?? 100) / (u.hpFraction || 1)) || 100,
      isIdle: u.idle !== false,
      primaryWeapon: catalog[u.kind ?? u.name]?.weapon,
      ...(u.armor ? { armor: u.armor } : {}),
    });
  }
  // Buildings survive as counts per kind in `inventory`; their positions do not. Lay them out on the
  // rings, base first, so a construction-yard lookup and placement checks both have something to use.
  const buildingKinds = [];
  for (const [kind, entry] of Object.entries(state.inventory ?? {})) {
    const count = Number(entry?.count ?? 0);
    for (let i = 0; i < count; i++) buildingKinds.push(kind);
  }
  // The construction yard is the base: put it at the recorded base tile.
  const yardKind = buildingKinds.find((k) => catalog[k]?.yard);
  if (!yardKind && buildingKinds.length) buildingKinds.unshift('CONSTRUCTION_YARD_UNKNOWN');
  buildingKinds.forEach((kind, i) => {
    const isYard = kind === yardKind;
    const [dx, dy] = isYard ? [0, 0] : buildingOffset(i);
    own.push({
      id: 1000 + i, name: kind, type: BUILDING_TYPE,
      tile: { rx: baseTile.rx + dx, ry: baseTile.ry + dy },
      hitPoints: 1000, maxHitPoints: 1000, isIdle: false,
    });
  });

  // --- the enemy -------------------------------------------------------------------------------
  const enemies = (state.visibleEnemies ?? []).map((e, i) => ({
    id: e.id ?? 2000 + i, name: e.kind ?? e.name, type: e.type ?? 7,
    tile: { rx: e.tile?.x ?? baseTile.rx + 10, ry: e.tile?.y ?? baseTile.ry },
    hitPoints: e.hp, maxHitPoints: Math.round((e.hp ?? 100) / (e.hpFraction || 1)) || 100,
    isIdle: e.idle !== false, zone: e.zone,
    ...(e.armor ? { armor: e.armor } : {}),
    ...(e.garrisoned ? { garrison: { count: e.garrisoned, capacity: e.garrisoned, canOccupy: false } } : {}),
  }));

  // --- build menus -----------------------------------------------------------------------------
  // Inferred from which production buildings stand. A menu cannot be recovered from the summary, so this
  // is the single largest approximation: it decides which options exist at all.
  const has = (pred) => buildingKinds.some((k) => pred(catalog[k] ?? {}));
  const queues = (state.queues ?? []).map((q) => ({ type: q.type, size: 0, maxSize: 10, items: [] }));
  const queueList = queues.length ? queues : [0, 1, 2, 3, 4, 5].map((type) => ({ type, size: 0, maxSize: 10, items: [] }));
  for (const q of state.queues ?? []) {
    const slot = queueList.find((x) => x.type === q.type);
    if (!slot) continue;
    slot.size = q.items?.length ?? 0;
    slot.items = (q.items ?? []).map((s) => ({ name: String(s).split('×')[0], quantity: Number(String(s).split('×')[1]) || 1 }));
  }
  const menu = {
    0: has((r) => r.yard) ? menuFor(catalog, 'Structure', () => true) : [],
    1: menuFor(catalog, 'Defense', (r) => r.isBaseDefense || r.wall),
    2: has((r) => r.factory === 'InfantryType') ? menuFor(catalog, 'Infantry', () => true) : [],
    3: has((r) => r.factory === 'UnitType') ? menuFor(catalog, 'Vehicle', () => true) : [],
    4: has((r) => r.factory === 'AircraftType') ? menuFor(catalog, 'Aircraft', () => true) : [],
    5: has((r) => r.factory === 'NavalUnitType') ? menuFor(catalog, 'Naval', () => true) : [],
  };

  const api = {
    tick: () => state.tick ?? 0,
    time: () => state.gameSeconds ?? 0,
    me: () => ({
      credits: state.credits ?? 0,
      power: { total: state.power?.total ?? 0, drain: state.power?.drain ?? 0 },
      defeated: false, isObserver: false, combatant: true,
    }),
    units: (relation) => {
      if (relation === 'self' || relation === 'allied') return own;
      if (relation === 'enemy') return enemies;
      // `hostile` is the superset in the real API; the summary only carries the enemy-house subset.
      if (relation === 'hostile') return enemies;
      return [];
    },
    unit: (id) => [...own, ...enemies].find((u) => u.id === id),
    players: () => [{ name: 'me', allied: true, combatant: true, isObserver: false, defeated: false }],
    ObjectType: { Aircraft: 1, Building: BUILDING_TYPE, Infantry: 3, Vehicle: 7 },
    ZoneType: { Air: 1, Ground: 0 },
    LandType: { Clear: 0, Water: 7, Tiberium: 9 },
    ArmorType: { 0: 'None', 1: 'Flak', 2: 'Plate', 3: 'Light', 4: 'Medium', 5: 'Heavy', 6: 'Wood', 7: 'Steel', 8: 'Concrete', 9: 'Special_1', 10: 'Special_2' },
    FactoryType: { 0: 'None', 2: 'InfantryType', 3: 'UnitType', 4: 'AircraftType', 5: 'NavalUnitType' },
    BuildCat: { 0: 'Structure', 1: 'Defense', 2: 'Infantry', 3: 'Vehicle', 4: 'Aircraft', 5: 'Naval' },
    QueueType: { Structures: 0, Armory: 1, Infantry: 2, Vehicles: 3, Aircrafts: 4, Ships: 5 },
    OrderType: { Move: 0, Attack: 2, ForceAttack: 3, Guard: 4, Occupy: 8, DeploySelected: 10, Stop: 11, Repair: 15, EnterTransport: 17, Capture: 18 },
    production: {
      queues: () => queueList,
      available: (type) => (menu[type] ?? []).map((name) => ({ name })),
    },
    map: {
      size: () => ({ width, height }),
      visible: (x, y) => {
        if (x < 0 || y < 0 || x >= width || y >= height) return false;
        // Everything the summary described is by definition in sight.
        return enemies.some((e) => Math.abs(e.tile.rx - x) <= 12 && Math.abs(e.tile.ry - y) <= 12);
      },
      tile: (x, y) => (x >= 0 && y >= 0 && x < width && y < height ? { rx: x, ry: y, landType: 0 } : undefined),
    },
    // Commands are not executed in a replay; recording them would only invite misreading a question audit
    // as a behaviour one. `canPlace` answers yes inside a margin so site selection has somewhere to go.
    order: () => true,
    canPlace: (name, x, y) => x > 2 && y > 2 && x < width - 2 && y < height - 2,
    move: () => true, attack: () => true, deploy: () => true, sell: () => true, gather: () => true,
    cancel: () => true, produce: () => true, repair: () => true,
    crates: () => [],
    rules: options.rules,
  };
  refreshCatalog(api, catalog);
  return api;
}

/**
 * The option set of each question in a request built by `requestGroupsFrom`. Takes the request shape
 * (`{id: {instructions, criteria}}`) rather than the raw groups, so a caller records exactly what would
 * be sent, after the wait-only filter and the group cap.
 */
export const optionsOf = (requestGroups) => Object.fromEntries(
  Object.entries(requestGroups).map(([id, g]) => [id, Object.keys(g.criteria ?? {})]),
);
